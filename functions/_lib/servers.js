// Servers: create/join/leave, channels (text, voice, categories), roles, per-channel overwrites,
// invites (sent to friends), kick/ban, audit log, purge.
import { HttpError, json, requireUser, validAvatar } from "./core.js";
import { P, ALL, CHANNEL_MASK, EVERYONE_DEFAULT, has, loadAccess, channelCtx, channelUnread, MAX_SERVERS_JOINED } from "./access.js";
import { userView, PRES_COLS } from "./social.js";
import { emitServer, emitUsers } from "./events.js";

const MAX_MEMBERS = 100, MAX_CHANNELS = 50, MAX_ROLES = 50, PURGE_MAX = 100;
const q = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const note = async (db, sid, actor, action, detail = null) => {
  await run(db, "INSERT INTO server_audit (server_id, at, actor, action, detail) VALUES (?,?,?,?,?)", sid, Date.now(), actor, action, detail ? JSON.stringify(detail) : null);
  await emitServer(db, sid, { t: "server", server: sid }); // every open copy of this server refreshes
};
const needPerm = (acc, bit) => { if (!has(acc.base, bit)) throw new HttpError(403, "You don't have permission for that."); };
const iconUrl = (s) => (s.icon ? `/api/si/${s.id}?v=${s.icon_v}` : null);

async function getAcc(db, u, id) {
  const sid = Number(id), acc = Number.isInteger(sid) ? (await loadAccess(db, u, sid)).get(sid) : null;
  if (!acc) throw new HttpError(404, "That server doesn't exist.");
  return acc;
}
async function memberByName(db, sid, name) {
  const t = await one(db, "SELECT u.*, sm.nick FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ? AND u.name_lc = ?", sid, str(name, 16).toLowerCase());
  if (!t) throw new HttpError(404, "That person isn't in this server.");
  return t;
}
async function topOf(db, server, userId) {
  if (server.owner === userId) return 1_000_000;
  return (await one(db, "SELECT MAX(r.position) AS t FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?", server.id, userId))?.t || 0;
}
async function mustOutrank(db, acc, target) {
  if (target.id === acc.server.owner) throw new HttpError(403, "Nobody can do that to the server owner.");
  if (target.id !== acc.userId && !(acc.top > (await topOf(db, acc.server, target.id)))) throw new HttpError(403, "They have a role as high as yours or higher.");
}
function channelName(kind, raw) {
  let n = str(raw, 60);
  if (kind === "text") n = n.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/-{2,}/g, "-");
  n = n.slice(0, 32);
  if (!n) throw new HttpError(400, "Give the channel a name.");
  return n;
}
async function wipeChannelData(db, ids) {
  for (const id of ids) {
    await run(db, "DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat = ?)", `c:${id}`);
    await run(db, "DELETE FROM messages WHERE chat = ?", `c:${id}`);
    await run(db, "DELETE FROM reads WHERE chat = ?", `c:${id}`);
  }
}
async function addMember(db, serverId, userId) {
  await run(db, "INSERT OR IGNORE INTO server_members (server_id, user_id, joined) VALUES (?,?,?)", serverId, userId, Date.now());
}
async function removeMember(db, serverId, userId) {
  await run(db, "DELETE FROM member_roles WHERE server_id = ? AND user_id = ?", serverId, userId);
  await run(db, "DELETE FROM server_members WHERE server_id = ? AND user_id = ?", serverId, userId);
  await run(db, "DELETE FROM overwrites WHERE kind = 'member' AND target = ? AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)", userId, serverId);
}
const joinedCount = async (db, uid) => (await one(db, "SELECT COUNT(*) AS n FROM server_members WHERE user_id = ?", uid)).n;

// ---------- what server_get returns ----------
async function serverView(db, u, acc) {
  const s = acc.server, now = Date.now();
  const [memberRows, roleRows, unread] = await Promise.all([
    q(db, `SELECT o.*, ${PRES_COLS}, sm.nick AS s_nick, sm.joined AS s_joined FROM server_members sm JOIN users o ON o.id = sm.user_id LEFT JOIN presence p ON p.user_id = o.id WHERE sm.server_id = ? ORDER BY o.name_lc`, s.id),
    q(db, "SELECT user_id, role_id FROM member_roles WHERE server_id = ?", s.id),
    channelUnread(db, u, [...acc.myRoleIds]),
  ]);
  const members = memberRows.map((r) => ({ ...userView(r, now), nick: r.s_nick || null, roles: roleRows.filter((x) => x.user_id === r.id).map((x) => x.role_id), owner: r.id === s.owner, joined: r.s_joined }));
  const nameOf = new Map(memberRows.map((r) => [r.id, r.name]));
  const seen = acc.channels.filter((c) => c.kind !== "category" && has(c.perms, P.VIEW_CHANNEL));
  const canManage = has(acc.base, P.MANAGE_CHANNELS) || has(acc.base, P.MANAGE_ROLES);
  const channels = acc.channels.filter((c) => (c.kind === "category" ? acc.base === ALL || has(acc.base, P.MANAGE_CHANNELS) || seen.some((v) => v.parent === c.id) : seen.includes(c))).map((c) => {
    const x = unread.get(`c:${c.id}`);
    return {
      id: c.id, kind: c.kind, name: c.name, topic: c.topic || "", parent: c.parent, position: c.position, perms: c.perms,
      private: c.overwrites.some((o) => o.kind === "role" && o.target === acc.everyone?.id && has(o.deny, P.VIEW_CHANNEL)),
      unread: x ? x.n : 0, mentions: x ? x.mentions : 0,
      overwrites: canManage ? c.overwrites.map((o) => (o.kind === "member" ? { kind: "member", target: nameOf.get(o.target) || "?", name: nameOf.get(o.target) || "?", allow: o.allow, deny: o.deny } : { kind: "role", target: o.target, allow: o.allow, deny: o.deny })) : [],
    };
  });
  const showBans = has(acc.base, P.BAN_MEMBERS) || has(acc.base, P.KICK_MEMBERS) || has(acc.base, P.MANAGE_SERVER);
  const bans = showBans ? (await q(db, "SELECT u.name, b.reason, b.created FROM server_bans b JOIN users u ON u.id = b.user_id WHERE b.server_id = ? ORDER BY b.created DESC", s.id)).map((b) => ({ name: b.name, reason: b.reason || "", created: b.created })) : [];
  return {
    server: { id: s.id, name: s.name, icon: iconUrl(s), general: !!s.general, mine: acc.owner, owner: nameOf.get(s.owner) || null },
    channels, members, bans, perms: acc.base, top: acc.top,
    roles: acc.roles.map((r) => ({ id: r.id, name: r.name, color: r.color || null, perms: r.perms, hoist: !!r.hoist, mentionable: !!r.mentionable, everyone: !!r.everyone, position: r.position })),
  };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

export const serverRoutes = {
  async server_create({ db, req, body }) {
    const u = await requireUser(db, req);
    if (await one(db, "SELECT 1 AS x FROM servers WHERE owner = ?", u.id)) throw new HttpError(400, "You already own a server. Everyone can own one.");
    if ((await joinedCount(db, u.id)) >= MAX_SERVERS_JOINED) throw new HttpError(400, `You can be in up to ${MAX_SERVERS_JOINED} servers.`);
    const name = str(body.name, 32) || `${u.name}'s server`;
    if (name.length < 2) throw new HttpError(400, "Server names need at least 2 characters.");
    const now = Date.now();
    const sid = (await run(db, "INSERT INTO servers (name, owner, created) VALUES (?,?,?)", name, u.id, now)).meta.last_row_id;
    await run(db, "INSERT INTO roles (server_id, name, perms, everyone, position) VALUES (?, '@everyone', ?, 1, 0)", sid, EVERYONE_DEFAULT);
    await addMember(db, sid, u.id);
    const mk = async (kind, nm, parent, pos) => (await run(db, "INSERT INTO channels (server_id, kind, name, parent, position, created) VALUES (?,?,?,?,?,?)", sid, kind, nm, parent, pos, now)).meta.last_row_id;
    const text = await mk("category", "Text Channels", null, 0), voice = await mk("category", "Voice Channels", null, 1);
    await mk("text", "general", text, 0); await mk("voice", "General", voice, 0);
    await note(db, sid, u.name, "server.create", { name });
    return json({ server: sid });
  },

  async server_get({ db, req, body }) { const u = await requireUser(db, req); return json(await serverView(db, u, await getAcc(db, u, body.id))); },

  async server_update({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.MANAGE_SERVER);
    const name = str(body.name, 32);
    if (name.length < 2) throw new HttpError(400, "Server names need at least 2 characters.");
    await run(db, "UPDATE servers SET name = ? WHERE id = ?", name, acc.server.id);
    if ("icon" in body) await run(db, "UPDATE servers SET icon = ?, icon_v = icon_v + 1 WHERE id = ?", validAvatar(body.icon ?? null), acc.server.id);
    await note(db, acc.server.id, u.name, "server.update", { name, icon: "icon" in body ? (body.icon ? "changed" : "removed") : undefined });
    return json({ ok: true });
  },

  async server_nick({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id);
    const t = body.name && str(body.name, 16).toLowerCase() !== u.name_lc ? await memberByName(db, acc.server.id, body.name) : u;
    if (t.id === u.id) needPerm(acc, P.CHANGE_NICKNAME); else { needPerm(acc, P.MANAGE_NICKNAMES); await mustOutrank(db, acc, t); }
    const nick = str(body.nick, 32) || null;
    await run(db, "UPDATE server_members SET nick = ? WHERE server_id = ? AND user_id = ?", nick, acc.server.id, t.id);
    if (t.id !== u.id) await note(db, acc.server.id, u.name, "member.nick", { member: t.name, nick });
    return json({ ok: true });
  },

  async server_leave({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id);
    if (acc.owner) throw new HttpError(400, "Transfer ownership or delete the server before leaving.");
    await removeMember(db, acc.server.id, u.id);
    await note(db, acc.server.id, u.name, "member.leave");
    return json({ ok: true });
  },

  async server_delete({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id);
    if (!acc.owner) throw new HttpError(403, "Only the owner can delete the server.");
    await wipeChannelData(db, acc.channels.map((c) => c.id));
    await run(db, "DELETE FROM servers WHERE id = ?", acc.server.id); // everything else cascades
    return json({ ok: true });
  },

  async server_transfer({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id);
    if (!acc.owner) throw new HttpError(403, "Only the owner can hand the server over.");
    const t = await memberByName(db, acc.server.id, body.name);
    if (t.id === u.id) throw new HttpError(400, "Pick someone else.");
    if (await one(db, "SELECT 1 AS x FROM servers WHERE owner = ?", t.id)) throw new HttpError(400, `${t.name} already owns a server.`);
    await run(db, "UPDATE servers SET owner = ? WHERE id = ?", t.id, acc.server.id);
    await note(db, acc.server.id, u.name, "server.transfer", { to: t.name });
    return json({ ok: true });
  },

  // ----- invites (to friends) -----
  async server_invite({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.CREATE_INVITE);
    const t = await one(db, "SELECT * FROM users WHERE name_lc = ?", str(body.name, 16).toLowerCase());
    const [lo, hi] = t ? [Math.min(u.id, t.id), Math.max(u.id, t.id)] : [0, 0];
    if (!t || !(await one(db, "SELECT 1 AS x FROM friendships WHERE lo = ? AND hi = ? AND accepted = 1", lo, hi))) throw new HttpError(400, "You can only invite your friends.");
    if (await one(db, "SELECT 1 AS x FROM server_members WHERE server_id = ? AND user_id = ?", acc.server.id, t.id)) throw new HttpError(400, `${t.name} is already in this server.`);
    if (await one(db, "SELECT 1 AS x FROM server_bans WHERE server_id = ? AND user_id = ?", acc.server.id, t.id)) throw new HttpError(400, `${t.name} is banned from this server.`);
    if (await one(db, "SELECT 1 AS x FROM server_invites WHERE server_id = ? AND user_id = ?", acc.server.id, t.id)) throw new HttpError(400, `${t.name} already has an invite.`);
    if (await one(db, "SELECT 1 AS x FROM blocks WHERE blocker = ? AND blocked = ?", t.id, u.id)) throw new HttpError(400, "You can only invite your friends.");
    await run(db, "INSERT INTO server_invites (server_id, user_id, by, created) VALUES (?,?,?,?)", acc.server.id, t.id, u.id, Date.now());
    await emitUsers(db, [t.id], { t: "sync", invite: acc.server.name, from: u.name });
    return json({ ok: true });
  },
  async server_invite_respond({ db, req, body }) {
    const u = await requireUser(db, req);
    const inv = await one(db, "SELECT * FROM server_invites WHERE id = ? AND user_id = ?", Number(body.id), u.id);
    if (!inv) throw new HttpError(404, "That invite isn't there anymore.");
    await run(db, "DELETE FROM server_invites WHERE id = ?", inv.id);
    if (!body.accept) return json({ ok: true });
    if (await one(db, "SELECT 1 AS x FROM server_bans WHERE server_id = ? AND user_id = ?", inv.server_id, u.id)) throw new HttpError(403, "You can't join that server.");
    if ((await joinedCount(db, u.id)) >= MAX_SERVERS_JOINED) throw new HttpError(400, `You can be in up to ${MAX_SERVERS_JOINED} servers.`);
    if ((await one(db, "SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?", inv.server_id)).n >= MAX_MEMBERS) throw new HttpError(400, "That server is full.");
    await addMember(db, inv.server_id, u.id);
    await note(db, inv.server_id, u.name, "member.join");
    return json({ server: inv.server_id });
  },

  // ----- moderation -----
  async server_kick({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.KICK_MEMBERS);
    const t = await memberByName(db, acc.server.id, body.name);
    if (t.id === u.id) throw new HttpError(400, "You can't kick yourself.");
    await mustOutrank(db, acc, t);
    await removeMember(db, acc.server.id, t.id);
    await emitUsers(db, [t.id], { t: "sync" });
    await note(db, acc.server.id, u.name, "member.kick", { member: t.name, reason: str(body.reason, 200) || undefined });
    return json({ ok: true });
  },
  async server_ban({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.BAN_MEMBERS);
    if (body.ban === false) {
      const t = await one(db, "SELECT id, name FROM users WHERE name_lc = ?", str(body.name, 16).toLowerCase());
      if (t) { await run(db, "DELETE FROM server_bans WHERE server_id = ? AND user_id = ?", acc.server.id, t.id); await note(db, acc.server.id, u.name, "member.unban", { member: t.name }); }
      return json({ ok: true });
    }
    const t = await memberByName(db, acc.server.id, body.name);
    if (t.id === u.id) throw new HttpError(400, "You can't ban yourself.");
    await mustOutrank(db, acc, t);
    const reason = str(body.reason, 200);
    await removeMember(db, acc.server.id, t.id);
    await run(db, "INSERT OR REPLACE INTO server_bans (server_id, user_id, reason, by, created) VALUES (?,?,?,?,?)", acc.server.id, t.id, reason || null, u.id, Date.now());
    await run(db, "DELETE FROM server_invites WHERE server_id = ? AND user_id = ?", acc.server.id, t.id);
    await emitUsers(db, [t.id], { t: "sync" });
    await note(db, acc.server.id, u.name, "member.ban", { member: t.name, reason: reason || undefined });
    return json({ ok: true });
  },
  async server_audit_log({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.MANAGE_SERVER);
    const rows = await q(db, "SELECT * FROM server_audit WHERE server_id = ? ORDER BY id DESC LIMIT 100", acc.server.id);
    return json({ entries: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, detail: r.detail ? JSON.parse(r.detail) : null })) });
  },

  // ----- channels -----
  async channel_create({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.MANAGE_CHANNELS);
    const kind = ["text", "voice", "category"].includes(body.kind) ? body.kind : "text";
    if (acc.channels.length >= MAX_CHANNELS) throw new HttpError(400, `A server can have up to ${MAX_CHANNELS} channels.`);
    const name = channelName(kind, body.name);
    const parent = kind !== "category" && body.parent != null ? Number(body.parent) : null;
    if (parent !== null && acc.channels.find((c) => c.id === parent)?.kind !== "category") throw new HttpError(400, "Pick a category.");
    const pos = (await one(db, "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ? AND kind = ? AND parent IS ?", acc.server.id, kind === "category" ? "category" : kind, parent)).p;
    const cid = (await run(db, "INSERT INTO channels (server_id, kind, name, parent, position, created) VALUES (?,?,?,?,?,?)", acc.server.id, kind, name, parent, pos, Date.now())).meta.last_row_id;
    if (body.private && kind !== "category") {
      await run(db, "INSERT INTO overwrites (channel_id, kind, target, allow, deny) VALUES (?, 'role', ?, 0, ?)", cid, acc.everyone.id, P.VIEW_CHANNEL);
      if (acc.base !== ALL) await run(db, "INSERT INTO overwrites (channel_id, kind, target, allow, deny) VALUES (?, 'member', ?, ?, 0)", cid, u.id, P.VIEW_CHANNEL); // don't lock the creator out
    }
    await note(db, acc.server.id, u.name, "channel.create", { name, kind, private: body.private ? true : undefined });
    return json({ channel: cid });
  },
  async channel_update({ db, req, body }) {
    const u = await requireUser(db, req), ch = await one(db, "SELECT * FROM channels WHERE id = ?", Number(body.channel));
    if (!ch) throw new HttpError(404, "That channel doesn't exist.");
    const acc = await getAcc(db, u, ch.server_id), c = acc.channels.find((x) => x.id === ch.id);
    if (!has(c.perms, P.MANAGE_CHANNELS)) throw new HttpError(403, "You don't have permission for that.");
    const name = channelName(ch.kind, body.name ?? ch.name);
    let parent = ch.parent;
    if (ch.kind !== "category" && "parent" in body) {
      parent = body.parent == null ? null : Number(body.parent);
      if (parent !== null && acc.channels.find((x) => x.id === parent)?.kind !== "category") throw new HttpError(400, "Pick a category.");
    }
    await run(db, "UPDATE channels SET name = ?, topic = ?, parent = ? WHERE id = ?", name, ch.kind === "text" ? str(body.topic ?? ch.topic, 200) || null : null, parent, ch.id);
    await note(db, acc.server.id, u.name, "channel.update", { name });
    return json({ ok: true });
  },
  async channel_delete({ db, req, body }) {
    const u = await requireUser(db, req), ch = await one(db, "SELECT * FROM channels WHERE id = ?", Number(body.channel));
    if (!ch) throw new HttpError(404, "That channel doesn't exist.");
    const acc = await getAcc(db, u, ch.server_id); needPerm(acc, P.MANAGE_CHANNELS);
    if (ch.kind === "category") await run(db, "UPDATE channels SET parent = NULL WHERE parent = ?", ch.id);
    await wipeChannelData(db, [ch.id]);
    await run(db, "DELETE FROM channels WHERE id = ?", ch.id);
    await note(db, acc.server.id, u.name, "channel.delete", { name: ch.name });
    return json({ ok: true });
  },
  async channel_order({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.MANAGE_CHANNELS);
    if (!Array.isArray(body.order) || body.order.length > 200) throw new HttpError(400, "Bad order.");
    const byId = new Map(acc.channels.map((c) => [c.id, c])), cats = [], groups = new Map();
    for (const e of body.order) {
      const c = byId.get(Number(e?.id));
      if (!c) continue;
      if (c.kind === "category") { cats.push(c.id); continue; }
      const parent = e.parent == null ? null : Number(e.parent);
      if (parent !== null && byId.get(parent)?.kind !== "category") throw new HttpError(400, "Pick a category.");
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(c.id);
    }
    for (const [i, id] of cats.entries()) await run(db, "UPDATE channels SET position = ? WHERE id = ?", i, id);
    for (const [parent, ids] of groups) for (const [i, id] of ids.entries()) await run(db, "UPDATE channels SET position = ?, parent = ? WHERE id = ?", i, parent, id);
    return json({ ok: true });
  },
  async overwrite_set({ db, req, body }) {
    const u = await requireUser(db, req), ch = await one(db, "SELECT * FROM channels WHERE id = ?", Number(body.channel));
    if (!ch || ch.kind === "category") throw new HttpError(404, "That channel doesn't exist.");
    const acc = await getAcc(db, u, ch.server_id), c = acc.channels.find((x) => x.id === ch.id);
    if (!has(acc.base, P.MANAGE_ROLES) || !has(c.perms, P.VIEW_CHANNEL)) throw new HttpError(403, "You don't have permission for that.");
    let target;
    if (body.kind === "role") {
      const r = acc.roles.find((x) => x.id === Number(body.target));
      if (!r) throw new HttpError(404, "That role doesn't exist.");
      if (!r.everyone && r.position >= acc.top) throw new HttpError(403, "That role is as high as yours or higher.");
      target = r.id;
    } else if (body.kind === "member") {
      const t = await memberByName(db, acc.server.id, body.target);
      await mustOutrank(db, acc, t); target = t.id;
    } else throw new HttpError(400, "Bad request.");
    if (body.remove) { await run(db, "DELETE FROM overwrites WHERE channel_id = ? AND kind = ? AND target = ?", ch.id, body.kind, target); return json({ ok: true }); }
    const allow = (Number(body.allow) | 0) & CHANNEL_MASK, deny = (Number(body.deny) | 0) & CHANNEL_MASK & ~allow;
    if (acc.base !== ALL && ((allow | deny) & ~c.perms)) throw new HttpError(403, "You can only change permissions you have yourself.");
    await run(db, "INSERT INTO overwrites (channel_id, kind, target, allow, deny) VALUES (?,?,?,?,?) ON CONFLICT(channel_id, kind, target) DO UPDATE SET allow = excluded.allow, deny = excluded.deny", ch.id, body.kind, target, allow, deny);
    await note(db, acc.server.id, u.name, "channel.permissions", { channel: ch.name });
    return json({ ok: true });
  },

  // ----- roles -----
  async role_create({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.MANAGE_ROLES);
    if (acc.roles.length >= MAX_ROLES) throw new HttpError(400, `A server can have up to ${MAX_ROLES} roles.`);
    const name = str(body.name, 32) || "new role";
    await run(db, "UPDATE roles SET position = position + 1 WHERE server_id = ? AND everyone = 0", acc.server.id);
    const rid = (await run(db, "INSERT INTO roles (server_id, name, perms, position) VALUES (?,?,0,1)", acc.server.id, name)).meta.last_row_id;
    await note(db, acc.server.id, u.name, "role.create", { name });
    return json({ role: rid });
  },
  async role_update({ db, req, body }) {
    const u = await requireUser(db, req), r = await one(db, "SELECT * FROM roles WHERE id = ?", Number(body.role));
    if (!r) throw new HttpError(404, "That role doesn't exist.");
    const acc = await getAcc(db, u, r.server_id); needPerm(acc, P.MANAGE_ROLES);
    if (!r.everyone && r.position >= acc.top) throw new HttpError(403, "That role is as high as yours or higher.");
    let perms = "perms" in body ? (Number(body.perms) | 0) & ALL : r.perms;
    if (acc.base !== ALL && (perms & ~r.perms & ~acc.base)) throw new HttpError(403, "You can only give permissions you have yourself.");
    if (r.everyone) {
      await run(db, "UPDATE roles SET perms = ? WHERE id = ?", perms, r.id);
    } else {
      const name = str(body.name ?? r.name, 32) || r.name, color = body.color == null ? null : COLOR.test(body.color) ? body.color : r.color;
      await run(db, "UPDATE roles SET name = ?, color = ?, perms = ?, hoist = ?, mentionable = ? WHERE id = ?", name, color, perms, body.hoist ? 1 : 0, body.mentionable ? 1 : 0, r.id);
    }
    await note(db, acc.server.id, u.name, "role.update", { role: r.name });
    return json({ ok: true });
  },
  async role_delete({ db, req, body }) {
    const u = await requireUser(db, req), r = await one(db, "SELECT * FROM roles WHERE id = ?", Number(body.role));
    if (!r || r.everyone) throw new HttpError(404, "That role doesn't exist.");
    const acc = await getAcc(db, u, r.server_id); needPerm(acc, P.MANAGE_ROLES);
    if (r.position >= acc.top) throw new HttpError(403, "That role is as high as yours or higher.");
    await run(db, "DELETE FROM overwrites WHERE kind = 'role' AND target = ?", r.id);
    await run(db, "DELETE FROM roles WHERE id = ?", r.id); // member_roles cascade
    await note(db, acc.server.id, u.name, "role.delete", { role: r.name });
    return json({ ok: true });
  },
  async role_order({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.MANAGE_ROLES);
    const movable = acc.roles.filter((r) => !r.everyone && r.position < acc.top).map((r) => r.id);
    const order = Array.isArray(body.order) ? body.order.map(Number) : [];
    if (order.length !== movable.length || !movable.every((id) => order.includes(id))) throw new HttpError(400, "Bad order.");
    // first in the list = highest. Roles you can't move keep their place above them.
    for (const [i, id] of order.entries()) await run(db, "UPDATE roles SET position = ? WHERE id = ?", order.length - i, id);
    await note(db, acc.server.id, u.name, "role.order");
    return json({ ok: true });
  },
  async member_roles({ db, req, body }) {
    const u = await requireUser(db, req), acc = await getAcc(db, u, body.id); needPerm(acc, P.MANAGE_ROLES);
    const t = await memberByName(db, acc.server.id, body.name);
    await mustOutrank(db, acc, t);
    const assignable = new Set(acc.roles.filter((r) => !r.everyone && r.position < acc.top).map((r) => r.id));
    const have = (await q(db, "SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?", acc.server.id, t.id)).map((r) => r.role_id);
    const want = new Set([...have.filter((id) => !assignable.has(id)), ...(Array.isArray(body.roles) ? body.roles.map(Number) : []).filter((id) => assignable.has(id))]);
    for (const id of have) if (!want.has(id)) await run(db, "DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?", acc.server.id, t.id, id);
    for (const id of want) if (!have.includes(id)) await run(db, "INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?,?,?)", acc.server.id, t.id, id);
    await note(db, acc.server.id, u.name, "member.roles", { member: t.name, roles: acc.roles.filter((r) => want.has(r.id)).map((r) => r.name) });
    return json({ ok: true });
  },

  // ----- /purge -----
  async purge({ db, req, body }) {
    const u = await requireUser(db, req), cc = await channelCtx(db, u, Number(body.channel));
    if (!has(cc.perms, P.MANAGE_MESSAGES)) throw new HttpError(403, "You need the Manage Messages permission.");
    const n = Number(body.count);
    if (!Number.isInteger(n) || n < 1 || n > PURGE_MAX) throw new HttpError(400, `Give an amount from 1 to ${PURGE_MAX}.`);
    const chat = `c:${cc.channel.id}`, ids = (await q(db, "SELECT id FROM messages WHERE chat = ? AND deleted = 0 ORDER BY id DESC LIMIT ?", chat, n)).map((r) => r.id);
    for (const id of ids) {
      await run(db, "DELETE FROM reactions WHERE message_id = ?", id);
      await run(db, "UPDATE messages SET deleted = 1, body = '', pinned = 0, updated = ? WHERE id = ?", Date.now(), id);
    }
    await note(db, cc.acc.server.id, u.name, "messages.purge", { channel: cc.channel.name, count: ids.length });
    return json({ n: ids.length });
  },
};
