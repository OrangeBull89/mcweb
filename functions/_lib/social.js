// Social routes: presence, friends, blocking, DMs, group chats, reactions, pins, pictures, profiles.
import { HttpError, json, requireUser, publicMe, randomHex, tooMany, recordFail, blockReason } from "./core.js";
import { P, has, channelCtx, serverSummary, pendingInvites } from "./access.js";
import { emitUsers, notifyChat, notifyMentions, friendIds } from "./events.js";

const PRESENCE_TTL = 100_000; // clients sync at least every 45 s, so silence for 100 s means gone
const MSG_MAX = 2000, PAGE = 50, PURGE_MAX = 100, PARTY_MAX = 10, IMG_MAX = 700_000;
const SPECIAL = /^::(img|invite|ask)::/;
const typingAt = new Map(); // per-isolate: at most one typing event per chat every 2 s

export const dmChat = (a, b) => `dm:${Math.min(a, b)}:${Math.max(a, b)}`;
const pair = (a, b) => [Math.min(a, b), Math.max(a, b)];
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function userByName(db, name) {
  const n = str(name, 16).toLowerCase();
  return n ? db.prepare("SELECT * FROM users WHERE name_lc = ?").bind(n).first() : null;
}
const isBlocked = async (db, a, b) =>
  !!(await db.prepare("SELECT 1 AS x FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)").bind(a, b, b, a).first());

// ---------- presence ----------
export function shownStatus(row, now = Date.now()) {
  if (row.status === "invisible") return "offline";
  if (!row.last_seen || now - row.last_seen > PRESENCE_TTL) return "offline";
  if (row.status === "dnd") return "dnd";
  if (row.status === "away" || row.idle_since) return "away";
  return "online";
}
export const userView = (row, now) => {
  const status = shownStatus(row, now), off = status === "offline";
  return {
    id: row.id, name: row.name, avatar: publicMe(row).avatar, status, lastSeen: row.last_seen || null,
    idleSince: !off && row.idle_since ? row.idle_since : null,
    game: off ? null : row.game || null, activity: off ? null : row.activity || null, worldCode: off ? null : row.world_code || null,
    playingWith: off ? null : row.playing_with || null, worldName: off ? null : row.world_name || null, since: off ? null : row.game_since || null,
  };
};
export const PRES_COLS = "p.idle_since, p.game, p.activity, p.world_code, p.playing_with, p.world_name, p.game_since";

export async function savePresence(db, u, body) {
  const now = Date.now();
  if (body.leaving) {
    await db.prepare("UPDATE users SET last_seen = 0 WHERE id = ?").bind(u.id).run();
    await db.prepare("DELETE FROM presence WHERE user_id = ?").bind(u.id).run();
    await emitUsers(db, await friendIds(db, u.id), { t: "presence", name: u.name });
    return;
  }
  const wasStatus = u.status, wasSeen = u.last_seen;
  const sets = ["last_seen = ?"], args = [now];
  if (typeof body.status === "string" && ["online", "away", "dnd", "invisible"].includes(body.status)) { sets.push("status = ?"); args.push(body.status); u.status = body.status; }
  await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...args, u.id).run();
  const cur = await db.prepare("SELECT * FROM presence WHERE user_id = ?").bind(u.id).first();
  const next = { idle_since: cur?.idle_since ?? null, game: cur?.game ?? null, activity: cur?.activity ?? null, world_code: cur?.world_code ?? null, playing_with: cur?.playing_with ?? null, world_name: cur?.world_name ?? null, game_since: cur?.game_since ?? null };
  if ("idleSince" in body) next.idle_since = Number.isFinite(body.idleSince) && body.idleSince > 0 ? Math.min(body.idleSince, now) : null;
  if ("game" in body) { // a game page reports its game (null: it closed)
    const game = typeof body.game === "string" && /^[a-z0-9-]{1,32}$/.test(body.game) ? body.game : null;
    if (game !== next.game) next.game_since = game ? now : null;
    next.game = game;
    next.activity = game ? str(body.activity, 60) || null : null;
    next.world_code = game ? str(body.worldCode, 40) || null : null;
    next.playing_with = game ? str(body.playingWith, 16) || null : null;
    next.world_name = game ? str(body.worldName, 40) || null : null;
  }
  await db.prepare(`INSERT INTO presence (user_id, idle_since, game, activity, world_code, playing_with, world_name, game_since) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET idle_since=excluded.idle_since, game=excluded.game, activity=excluded.activity, world_code=excluded.world_code, playing_with=excluded.playing_with, world_name=excluded.world_name, game_since=excluded.game_since`)
    .bind(u.id, next.idle_since, next.game, next.activity, next.world_code, next.playing_with, next.world_name, next.game_since).run();
  const cameOnline = !wasSeen || now - wasSeen > PRESENCE_TTL;
  if (cameOnline || u.status !== wasStatus || next.game !== (cur?.game ?? null) || (next.idle_since ? 1 : 0) !== (cur?.idle_since ? 1 : 0))
    await emitUsers(db, await friendIds(db, u.id), { t: "presence", name: u.name });
}

// ---------- the big "sync" payload ----------
export async function buildSync(db, u) {
  const now = Date.now();
  const q = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
  const [friendRows, pending, blockedRows, chatRows, unreadRows, partyRows] = await Promise.all([
    q(`SELECT o.*, ${PRES_COLS} FROM friendships f JOIN users o ON o.id = CASE WHEN f.lo = ?1 THEN f.hi ELSE f.lo END LEFT JOIN presence p ON p.user_id = o.id
       WHERE (f.lo = ?1 OR f.hi = ?1) AND f.accepted = 1 AND o.id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?1)`, u.id),
    q(`SELECT o.id, o.name, o.avatar, o.avatar_v, f.requester, f.created FROM friendships f JOIN users o ON o.id = CASE WHEN f.lo = ?1 THEN f.hi ELSE f.lo END
       WHERE (f.lo = ?1 OR f.hi = ?1) AND f.accepted = 0`, u.id),
    q("SELECT o.name FROM blocks b JOIN users o ON o.id = b.blocked WHERE b.blocker = ? ORDER BY o.name_lc", u.id),
    q(`SELECT m.chat, MAX(m.id) AS last_id, MAX(m.created) AS last_at FROM messages m WHERE m.deleted = 0 AND (m.chat LIKE ?1 OR m.chat LIKE ?2) GROUP BY m.chat`, `dm:${u.id}:%`, `dm:%:${u.id}`),
    q(`SELECT m.chat, COUNT(*) AS n FROM messages m LEFT JOIN reads r ON r.user_id = ?1 AND r.chat = m.chat
       WHERE m.deleted = 0 AND m.author != ?1 AND m.id > COALESCE(r.last_id, 0) AND (m.chat LIKE ?2 OR m.chat LIKE ?3 OR m.chat IN (SELECT 'p:' || party_id FROM party_members WHERE user_id = ?1)) GROUP BY m.chat`,
      u.id, `dm:${u.id}:%`, `dm:%:${u.id}`),
    q(`SELECT p.id, p.name, p.owner FROM parties p JOIN party_members pm ON pm.party_id = p.id WHERE pm.user_id = ? ORDER BY p.id`, u.id),
  ]);
  const friends = friendRows.map((r) => userView(r, now));
  const incoming = pending.filter((r) => r.requester !== u.id).map((r) => ({ name: r.name, avatar: publicMe({ ...r }).avatar, created: r.created }));
  const outgoing = pending.filter((r) => r.requester === u.id).map((r) => ({ name: r.name, avatar: publicMe({ ...r }).avatar, created: r.created }));

  // DMs: everyone I've talked to (not blocked), newest first
  const unread = {};
  const dms = [];
  const otherIds = chatRows.map((c) => c.chat.split(":").slice(1).map(Number).find((x) => x !== u.id) ?? u.id);
  if (otherIds.length) {
    const ph = otherIds.map(() => "?").join(",");
    const rows = await q(`SELECT o.*, ${PRES_COLS} FROM users o LEFT JOIN presence p ON p.user_id = o.id WHERE o.id IN (${ph}) AND o.id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)`, ...otherIds, u.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    chatRows.forEach((c, i) => { const r = byId.get(otherIds[i]); if (r) dms.push({ ...userView(r, now), lastAt: c.last_at }); });
    dms.sort((a, b) => b.lastAt - a.lastAt);
  }
  const nameById = new Map(dms.map((d) => [d.id, d.name]));
  for (const f of friends) nameById.set(f.id, f.name);
  const partyUnread = new Map();
  for (const r of unreadRows) {
    if (r.chat.startsWith("p:")) { partyUnread.set(Number(r.chat.slice(2)), r.n); continue; }
    const other = r.chat.split(":").slice(1).map(Number).find((x) => x !== u.id);
    const name = nameById.get(other);
    if (name) unread[name] = r.n;
  }

  // group chats
  const parties = [];
  for (const p of partyRows) {
    const members = (await q(`SELECT o.*, ${PRES_COLS} FROM party_members pm JOIN users o ON o.id = pm.user_id LEFT JOIN presence p ON p.user_id = o.id WHERE pm.party_id = ? AND o.id != ?`, p.id, u.id)).map((r) => userView(r, now));
    const last = await db.prepare("SELECT MAX(created) AS t FROM messages WHERE chat = ? AND deleted = 0").bind(`p:${p.id}`).first();
    const owner = p.owner === u.id ? u.name : (await db.prepare("SELECT name FROM users WHERE id = ?").bind(p.owner).first())?.name;
    parties.push({ id: p.id, name: p.name, owner, mine: p.owner === u.id, members, unread: partyUnread.get(p.id) || 0, lastAt: last?.t || 0 });
  }

  const sv = await serverSummary(db, u);
  return { me: { ...publicMe(u), status: u.status }, friends, dms, parties, servers: sv.servers, incoming, outgoing, blocked: blockedRows.map((b) => b.name), serverInvites: await pendingInvites(db, u), unread, deviceId: u.sid };
}

const isPrivate = (c) => !!c.channel && c.channel.overwrites.some((o) => o.kind === "role" && o.target === c.acc.everyone?.id && has(o.deny, P.VIEW_CHANNEL));

// ---------- chats ----------
async function resolveChat(db, u, body, { forSend = false } = {}) {
  if (body.channel != null) {
    const cc = await channelCtx(db, u, Number(body.channel));
    if (cc.channel.kind !== "text") throw new HttpError(400, "That's a voice channel.");
    return { chat: `c:${cc.channel.id}`, channel: cc.channel, perms: cc.perms, acc: cc.acc };
  }
  if (body.party != null) {
    const id = Number(body.party);
    const m = Number.isInteger(id) && await db.prepare("SELECT 1 AS x FROM party_members WHERE party_id = ? AND user_id = ?").bind(id, u.id).first();
    if (!m) throw new HttpError(404, "That group chat doesn't exist.");
    return { chat: `p:${id}`, party: id };
  }
  const name = body.with ?? body.dm ?? body.to; // the launcher sends { with } to load/type, { to } to send
  const other = await userByName(db, name);
  if (!other || other.id === u.id) throw new HttpError(404, "That person doesn't exist.");
  if (forSend && (await isBlocked(db, u.id, other.id))) throw new HttpError(403, "You can't message this person.");
  return { chat: dmChat(u.id, other.id), other };
}
async function chatOfMessage(db, u, id) {
  const m = Number.isInteger(id) && await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
  if (!m) throw new HttpError(404, "That message doesn't exist.");
  if (m.chat.startsWith("dm:")) { const [a, b] = m.chat.split(":").slice(1).map(Number); if (u.id !== a && u.id !== b) throw new HttpError(404, "That message doesn't exist."); }
  else if (m.chat.startsWith("p:")) { if (!(await db.prepare("SELECT 1 AS x FROM party_members WHERE party_id = ? AND user_id = ?").bind(Number(m.chat.slice(2)), u.id).first())) throw new HttpError(404, "That message doesn't exist."); }
  else if (m.chat.startsWith("c:")) { const cc = await channelCtx(db, u, Number(m.chat.slice(2))); m.perms = cc.perms; m.inChannel = true; }
  else throw new HttpError(404, "That message doesn't exist.");
  return m;
}

async function shapeMessages(db, u, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id), ph = ids.map(() => "?").join(",");
  const { results: reacts } = await db.prepare(`SELECT r.message_id, r.emoji, r.user_id, o.name FROM reactions r JOIN users o ON o.id = r.user_id WHERE r.message_id IN (${ph}) ORDER BY r.created`).bind(...ids).all();
  const replyIds = [...new Set(rows.map((r) => r.reply).filter(Boolean))];
  const replies = new Map();
  if (replyIds.length) {
    const { results } = await db.prepare(`SELECT m.id, m.body, m.deleted, o.name AS from_name FROM messages m JOIN users o ON o.id = m.author WHERE m.id IN (${replyIds.map(() => "?").join(",")})`).bind(...replyIds).all();
    for (const r of results) replies.set(r.id, { id: r.id, from: r.from_name, body: r.deleted ? "" : r.body, deleted: !!r.deleted });
  }
  return rows.map((m) => {
    if (m.deleted) return { id: m.id, deleted: true };
    const mine = reacts.filter((r) => r.message_id === m.id), byEmoji = new Map();
    for (const r of mine) { const e = byEmoji.get(r.emoji) || { emoji: r.emoji, n: 0, names: [], mine: false }; e.n++; e.names.push(r.name); if (r.user_id === u.id) e.mine = true; byEmoji.set(r.emoji, e); }
    return {
      id: m.id, from: m.name, body: m.body, created: m.created, mine: m.author === u.id, avatar: publicMe({ id: m.author, avatar: m.avatar, avatar_v: m.avatar_v }).avatar,
      reply: m.reply ? replies.get(m.reply) || { id: m.reply, from: "", body: "", deleted: true } : null,
      pinned: !!m.pinned, edited: m.edited || null, reactions: [...byEmoji.values()],
    };
  });
}
const MSG_SELECT = "SELECT m.*, o.name, o.avatar, o.avatar_v FROM messages m JOIN users o ON o.id = m.author";

async function markRead(db, u, chat, { quiet = false } = {}) {
  const last = await db.prepare("SELECT MAX(id) AS id FROM messages WHERE chat = ?").bind(chat).first();
  const before = !quiet && chat.startsWith("dm:") && last?.id ? (await db.prepare("SELECT last_id FROM reads WHERE user_id = ? AND chat = ?").bind(u.id, chat).first())?.last_id || 0 : null;
  if (before !== null && last.id > before) await notifyChat(db, u, chat, "seen"); // the other person's "Seen" updates at once
  if (last?.id) await db.prepare("INSERT INTO reads (user_id, chat, last_id) VALUES (?,?,?) ON CONFLICT(user_id, chat) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)").bind(u.id, chat, last.id).run();
}

// ---------- routes ----------
const syncOut = async ({ db, req }) => json(await buildSync(db, await requireUser(db, req)));
const withSync = (fn) => async (ctx) => {
  const u = await requireUser(ctx.db, ctx.req);
  const extra = await fn(ctx, u);
  return json({ ...(await buildSync(ctx.db, u)), ...(extra || {}) });
};

export const socialRoutes = {
  sync: async (ctx) => { const u = await requireUser(ctx.db, ctx.req); await savePresence(ctx.db, u, ctx.body); return json(await buildSync(ctx.db, u)); },

  // ----- friends -----
  request: withSync(async ({ db, body }, u) => {
    if (await tooMany(db, `freq:${u.id}`, 20, 3600_000)) throw new HttpError(429, "You've sent a lot of requests. Try again later.");
    const t = await userByName(db, body.name);
    if (!t) throw new HttpError(404, "No account has that username.");
    if (t.id === u.id) throw new HttpError(400, "You can't add yourself.");
    if (await db.prepare("SELECT 1 AS x FROM blocks WHERE blocker = ? AND blocked = ?").bind(t.id, u.id).first()) throw new HttpError(404, "No account has that username.");
    if (await db.prepare("SELECT 1 AS x FROM blocks WHERE blocker = ? AND blocked = ?").bind(u.id, t.id).first()) throw new HttpError(400, `Unblock ${t.name} first.`);
    const [lo, hi] = pair(u.id, t.id);
    const f = await db.prepare("SELECT * FROM friendships WHERE lo = ? AND hi = ?").bind(lo, hi).first();
    if (f?.accepted) throw new HttpError(400, `You and ${t.name} are already friends.`);
    if (f && f.requester === u.id) throw new HttpError(400, `You already sent ${t.name} a request.`);
    if (f) await db.prepare("UPDATE friendships SET accepted = 1, accepted_at = ? WHERE lo = ? AND hi = ?").bind(Date.now(), lo, hi).run(); // they'd asked us first
    else { await db.prepare("INSERT INTO friendships (lo, hi, requester, accepted, created) VALUES (?,?,?,0,?)").bind(lo, hi, u.id, Date.now()).run(); await recordFail(db, `freq:${u.id}`); }
    await emitUsers(db, [t.id], { t: "sync" });
  }),
  respond: withSync(async ({ db, body }, u) => {
    const t = await userByName(db, body.name), [lo, hi] = t ? pair(u.id, t.id) : [0, 0];
    const f = t && await db.prepare("SELECT * FROM friendships WHERE lo = ? AND hi = ? AND accepted = 0 AND requester = ?").bind(lo, hi, t.id).first();
    if (!f) throw new HttpError(404, "That request isn't there anymore.");
    if (body.accept) await db.prepare("UPDATE friendships SET accepted = 1, accepted_at = ? WHERE lo = ? AND hi = ?").bind(Date.now(), lo, hi).run();
    else await db.prepare("DELETE FROM friendships WHERE lo = ? AND hi = ?").bind(lo, hi).run();
    await emitUsers(db, [t.id], { t: "sync" });
  }),
  cancel: withSync(async ({ db, body }, u) => {
    const t = await userByName(db, body.name);
    if (t) { const [lo, hi] = pair(u.id, t.id); await db.prepare("DELETE FROM friendships WHERE lo = ? AND hi = ? AND accepted = 0 AND requester = ?").bind(lo, hi, u.id).run(); await emitUsers(db, [t.id], { t: "sync" }); }
  }),
  remove: withSync(async ({ db, body }, u) => {
    const t = await userByName(db, body.name);
    if (t) { const [lo, hi] = pair(u.id, t.id); await db.prepare("DELETE FROM friendships WHERE lo = ? AND hi = ?").bind(lo, hi).run(); await emitUsers(db, [t.id], { t: "sync" }); }
  }),
  block: withSync(async ({ db, body }, u) => {
    const t = await userByName(db, body.name);
    if (!t || t.id === u.id) throw new HttpError(400, "You can't block that account.");
    const [lo, hi] = pair(u.id, t.id);
    await db.prepare("DELETE FROM friendships WHERE lo = ? AND hi = ?").bind(lo, hi).run();
    await db.prepare("INSERT OR IGNORE INTO blocks (blocker, blocked, created) VALUES (?,?,?)").bind(u.id, t.id, Date.now()).run();
  }),
  unblock: withSync(async ({ db, body }, u) => {
    const t = await userByName(db, body.name);
    if (t) await db.prepare("DELETE FROM blocks WHERE blocker = ? AND blocked = ?").bind(u.id, t.id).run();
  }),

  // ----- messages -----
  async send({ db, req, body }) {
    const u = await requireUser(db, req);
    if (await tooMany(db, `send:${u.id}`, 30, 30_000)) throw new HttpError(429, "Slow down a little.");
    const c = await resolveChat(db, u, body, { forSend: true });
    if (c.channel && !has(c.perms, P.SEND_MESSAGES)) throw new HttpError(403, "You can't send messages in this channel.");
    let text = typeof body.body === "string" ? body.body.replace(/\r\n/g, "\n").trim() : "";
    if (!text) throw new HttpError(400, "Write something first.");
    if (text.length > MSG_MAX) throw new HttpError(400, `Messages can be up to ${MSG_MAX} characters.`);
    if (text.startsWith("::")) {
      const m = SPECIAL.exec(text);
      if (!m || (m[1] === "img" && !/^::img::[0-9a-f]{32}$/.test(text)) || text.length > 300) throw new HttpError(400, "That message isn't allowed.");
      if (m[1] === "img" && !(await db.prepare("SELECT 1 AS x FROM images WHERE id = ? AND owner = ?").bind(text.slice(7), u.id).first())) throw new HttpError(400, "That picture isn't yours.");
    }
    if (c.channel) {
      if (text.startsWith("::img::") && !has(c.perms, P.ATTACH_FILES)) throw new HttpError(403, "You can't attach pictures here.");
      if (/(^|\s)@(everyone|here)\b/.test(text) && !has(c.perms, P.MENTION_EVERYONE)) throw new HttpError(403, "You can't mention everyone here.");
      for (const m of text.matchAll(/<@&(\d+)>/g)) { const r = c.acc.roles.find((x) => x.id === Number(m[1])); if (r && !r.mentionable && !has(c.perms, P.MENTION_EVERYONE)) throw new HttpError(403, "You can't mention that role."); }
    }
    let reply = null;
    if (body.reply != null) { const r = await db.prepare("SELECT id FROM messages WHERE id = ? AND chat = ? AND deleted = 0").bind(Number(body.reply), c.chat).first(); reply = r?.id ?? null; }
    const now = Date.now();
    const r = await db.prepare("INSERT INTO messages (chat, author, body, created, updated, reply) VALUES (?,?,?,?,?,?)").bind(c.chat, u.id, text, now, now, reply).run();
    await recordFail(db, `send:${u.id}`);
    await markRead(db, u, c.chat, { quiet: true }); // your own message isn't "reading"
    await notifyChat(db, u, c.chat, "msg", { priv: isPrivate(c) });
    if (c.channel) await notifyMentions(db, u, c.acc.server.id, c.channel.id, text);
    return json({ ok: true, id: r.meta.last_row_id });
  },

  async messages({ db, req, body }) {
    const u = await requireUser(db, req);
    const c = await resolveChat(db, u, body);
    const now = Date.now();
    if (c.channel && !has(c.perms, P.READ_HISTORY)) return json({ messages: [], more: false, now, seenUpTo: 0, perms: c.perms });
    let rows, more = false;
    if (Number(body.before) > 0) {
      rows = (await db.prepare(`${MSG_SELECT} WHERE m.chat = ? AND m.deleted = 0 AND m.id < ? ORDER BY m.id DESC LIMIT ?`).bind(c.chat, Number(body.before), PAGE + 1).all()).results;
      more = rows.length > PAGE; rows = rows.slice(0, PAGE).reverse();
    } else if (Number(body.after) > 0) {
      const since = Number(body.since) || now;
      rows = (await db.prepare(`${MSG_SELECT} WHERE m.chat = ? AND (m.id > ? OR m.updated > ?) ORDER BY m.id LIMIT 300`).bind(c.chat, Number(body.after), since).all()).results;
    } else {
      rows = (await db.prepare(`${MSG_SELECT} WHERE m.chat = ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT ?`).bind(c.chat, PAGE + 1).all()).results;
      more = rows.length > PAGE; rows = rows.slice(0, PAGE).reverse();
    }
    const messages = await shapeMessages(db, u, rows);
    await markRead(db, u, c.chat);
    let seenUpTo = 0;
    if (c.other) seenUpTo = (await db.prepare("SELECT last_id FROM reads WHERE user_id = ? AND chat = ?").bind(c.other.id, c.chat).first())?.last_id || 0;
    return json({ messages, more, now, seenUpTo, perms: c.channel ? c.perms : 0 });
  },

  async edit({ db, req, body }) {
    const u = await requireUser(db, req);
    const m = await chatOfMessage(db, u, Number(body.id));
    const text = str(body.body, MSG_MAX + 1);
    if (m.author !== u.id || m.deleted || m.body.startsWith("::")) throw new HttpError(403, "You can only edit your own messages.");
    if (!text || text.length > MSG_MAX || text.startsWith("::")) throw new HttpError(400, "That message isn't allowed.");
    const now = Date.now();
    await db.prepare("UPDATE messages SET body = ?, edited = ?, updated = ? WHERE id = ?").bind(text, now, now, m.id).run();
    await notifyChat(db, u, m.chat, "edit", { priv: true });
    return json({ ok: true });
  },

  async delete({ db, req, body }) {
    const u = await requireUser(db, req);
    const m = await chatOfMessage(db, u, Number(body.id));
    const owner = m.chat.startsWith("p:") && (await db.prepare("SELECT owner FROM parties WHERE id = ?").bind(Number(m.chat.slice(2))).first())?.owner === u.id;
    if (m.author !== u.id && !owner && !(m.inChannel && has(m.perms, P.MANAGE_MESSAGES))) throw new HttpError(403, "You can't delete that message.");
    await db.prepare("DELETE FROM reactions WHERE message_id = ?").bind(m.id).run();
    await db.prepare("UPDATE messages SET deleted = 1, body = '', pinned = 0, updated = ? WHERE id = ?").bind(Date.now(), m.id).run();
    await notifyChat(db, u, m.chat, "edit", { priv: true });
    return json({ ok: true });
  },

  async react({ db, req, body }) {
    const u = await requireUser(db, req);
    const m = await chatOfMessage(db, u, Number(body.id));
    if (m.inChannel && !has(m.perms, P.ADD_REACTIONS)) throw new HttpError(403, "You can't react here.");
    const emoji = str(body.emoji, 64);
    if (m.deleted || !emoji || /\s/.test(emoji) || /[<>"]/.test(emoji)) throw new HttpError(400, "That reaction isn't allowed.");
    const had = await db.prepare("SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").bind(m.id, u.id, emoji).first();
    if (had) await db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").bind(m.id, u.id, emoji).run();
    else {
      const n = await db.prepare("SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?").bind(m.id).first();
      if (n.n >= 20) throw new HttpError(400, "That message has too many different reactions.");
      await db.prepare("INSERT INTO reactions (message_id, user_id, emoji, created) VALUES (?,?,?,?)").bind(m.id, u.id, emoji, Date.now()).run();
    }
    await db.prepare("UPDATE messages SET updated = ? WHERE id = ?").bind(Date.now(), m.id).run();
    await notifyChat(db, u, m.chat, "edit", { priv: true });
    return json({ ok: true });
  },

  async pin({ db, req, body }) {
    const u = await requireUser(db, req);
    const m = await chatOfMessage(db, u, Number(body.id));
    if (m.deleted) throw new HttpError(404, "That message doesn't exist.");
    if (m.inChannel && !has(m.perms, P.MANAGE_MESSAGES)) throw new HttpError(403, "You need the Manage Messages permission to pin.");
    await db.prepare("UPDATE messages SET pinned = ?, updated = ? WHERE id = ?").bind(body.pinned ? 1 : 0, Date.now(), m.id).run();
    await notifyChat(db, u, m.chat, "edit", { priv: true });
    return json({ ok: true });
  },
  async pins({ db, req, body }) {
    const u = await requireUser(db, req);
    const c = await resolveChat(db, u, body);
    const rows = (await db.prepare(`${MSG_SELECT} WHERE m.chat = ? AND m.pinned = 1 AND m.deleted = 0 ORDER BY m.id DESC LIMIT 100`).bind(c.chat).all()).results;
    return json({ pins: await shapeMessages(db, u, rows) });
  },
  async typing({ db, req, body }) {
    const u = await requireUser(db, req);
    const c = await resolveChat(db, u, body, { forSend: true }).catch(() => null);
    if (!c || (c.channel && !has(c.perms, P.SEND_MESSAGES))) return json({ ok: true });
    const key = `${u.id}:${c.chat}`, now = Date.now();
    if (now - (typingAt.get(key) || 0) < 2_000) return json({ ok: true });
    typingAt.set(key, now); if (typingAt.size > 5000) typingAt.clear();
    await notifyChat(db, u, c.chat, "typing", { priv: isPrivate(c) });
    return json({ ok: true });
  },

  async image({ db, req, body }) {
    const u = await requireUser(db, req);
    if (await tooMany(db, `img:${u.id}`, 20, 600_000)) throw new HttpError(429, "Too many pictures. Wait a bit.");
    const m = typeof body.data === "string" && body.data.length <= IMG_MAX && /^data:image\/(jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.data);
    if (!m) throw new HttpError(400, "That picture isn't a supported image (or it's too big).");
    const head = atob(m[2].slice(0, 24));
    if (!(m[1] === "jpeg" ? head.startsWith("\xff\xd8\xff") : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP")) throw new HttpError(400, "That picture isn't a supported image.");
    const id = randomHex(16);
    await db.prepare("INSERT INTO images (id, owner, mime, data, created) VALUES (?,?,?,?,?)").bind(id, u.id, `image/${m[1]}`, m[2], Date.now()).run();
    await recordFail(db, `img:${u.id}`);
    return json({ id });
  },

  // ----- group chats -----
  party_create: withSync(async ({ db, body }, u) => {
    const names = [...new Set((Array.isArray(body.members) ? body.members : []).map((n) => str(n, 16).toLowerCase()).filter(Boolean))];
    if (!names.length) throw new HttpError(400, "Pick at least one friend.");
    if (names.length > PARTY_MAX - 1) throw new HttpError(400, `Groups can have up to ${PARTY_MAX - 1} friends.`);
    const people = [];
    for (const n of names) {
      const t = await userByName(db, n);
      const [lo, hi] = t ? pair(u.id, t.id) : [0, 0];
      if (!t || !(await db.prepare("SELECT 1 AS x FROM friendships WHERE lo = ? AND hi = ? AND accepted = 1").bind(lo, hi).first()) || (await isBlocked(db, u.id, t.id))) throw new HttpError(400, `${n} isn't one of your friends.`);
      people.push(t);
    }
    const name = str(body.name, 40) || [u.name, ...people.map((p) => p.name)].join(", ").slice(0, 40);
    const r = await db.prepare("INSERT INTO parties (name, owner, created) VALUES (?,?,?)").bind(name, u.id, Date.now()).run();
    const id = r.meta.last_row_id;
    for (const p of [u, ...people]) await db.prepare("INSERT INTO party_members (party_id, user_id) VALUES (?,?)").bind(id, p.id).run();
    await emitUsers(db, people.map((p) => p.id), { t: "sync" });
    return { party: id };
  }),
  party_add: withSync(async ({ db, body }, u) => {
    const id = Number(body.id);
    if (!(await db.prepare("SELECT 1 AS x FROM party_members WHERE party_id = ? AND user_id = ?").bind(id, u.id).first())) throw new HttpError(404, "That group chat doesn't exist.");
    const t = await userByName(db, body.name), [lo, hi] = t ? pair(u.id, t.id) : [0, 0];
    if (!t || !(await db.prepare("SELECT 1 AS x FROM friendships WHERE lo = ? AND hi = ? AND accepted = 1").bind(lo, hi).first()) || (await isBlocked(db, u.id, t.id))) throw new HttpError(400, "You can only add your friends.");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM party_members WHERE party_id = ?").bind(id).first();
    if (n.n >= PARTY_MAX) throw new HttpError(400, `Groups can have up to ${PARTY_MAX} people.`);
    await db.prepare("INSERT OR IGNORE INTO party_members (party_id, user_id) VALUES (?,?)").bind(id, t.id).run();
    await emitUsers(db, (await db.prepare("SELECT user_id FROM party_members WHERE party_id = ? AND user_id != ?").bind(id, u.id).all()).results.map((r) => r.user_id), { t: "sync" });
  }),
  party_rename: withSync(async ({ db, body }, u) => {
    const id = Number(body.id), name = str(body.name, 40);
    if (!name) throw new HttpError(400, "Give the group a name.");
    if (!(await db.prepare("SELECT 1 AS x FROM party_members WHERE party_id = ? AND user_id = ?").bind(id, u.id).first())) throw new HttpError(404, "That group chat doesn't exist.");
    await db.prepare("UPDATE parties SET name = ? WHERE id = ?").bind(name, id).run();
    await emitUsers(db, (await db.prepare("SELECT user_id FROM party_members WHERE party_id = ? AND user_id != ?").bind(id, u.id).all()).results.map((r) => r.user_id), { t: "sync" });
  }),
  party_leave: withSync(async ({ db, body }, u) => {
    const id = Number(body.id);
    await db.prepare("DELETE FROM party_members WHERE party_id = ? AND user_id = ?").bind(id, u.id).run();
    const rest = await db.prepare("SELECT user_id FROM party_members WHERE party_id = ? ORDER BY user_id LIMIT 1").bind(id).first();
    if (!rest) {
      await db.prepare("DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat = ?)").bind(`p:${id}`).run();
      await db.prepare("DELETE FROM messages WHERE chat = ?").bind(`p:${id}`).run();
      await db.prepare("DELETE FROM parties WHERE id = ?").bind(id).run();
    } else {
      await db.prepare("UPDATE parties SET owner = ? WHERE id = ? AND owner = ?").bind(rest.user_id, id, u.id).run();
      await emitUsers(db, (await db.prepare("SELECT user_id FROM party_members WHERE party_id = ?").bind(id).all()).results.map((r) => r.user_id), { t: "sync" });
    }
  }),

  // ----- placeholders: valid empty answers until the achievements slice exists -----
  async feed({ db, req }) { await requireUser(db, req); return json({ items: [] }); },
  async play_stats({ db, req }) { await requireUser(db, req); return json({ games: [] }); },
  async game_stats({ db, req }) { await requireUser(db, req); return json({ me: null, players: 0, achievements: [], friends: [] }); },

  async ach_report({ db, req }) { await requireUser(db, req); return json({ fresh: [] }); }, // achievements are switched off: accept and ignore

  // ----- profiles -----
  async profile({ db, req, body }) {
    const u = await requireUser(db, req);
    const t = await userByName(db, body.name);
    if (!t || (t.id !== u.id && (await db.prepare("SELECT 1 AS x FROM blocks WHERE blocker = ? AND blocked = ?").bind(t?.id ?? 0, u.id).first()))) throw new HttpError(404, "That profile doesn't exist.");
    const [lo, hi] = pair(u.id, t.id);
    const f = await db.prepare("SELECT accepted_at FROM friendships WHERE lo = ? AND hi = ? AND accepted = 1").bind(lo, hi).first();
    const mutual = t.id === u.id ? [] : (await db.prepare(
      `SELECT o.name FROM users o WHERE o.id != ?1 AND o.id != ?2
         AND EXISTS (SELECT 1 FROM friendships a WHERE a.accepted = 1 AND a.lo = MIN(?1, o.id) AND a.hi = MAX(?1, o.id))
         AND EXISTS (SELECT 1 FROM friendships b WHERE b.accepted = 1 AND b.lo = MIN(?2, o.id) AND b.hi = MAX(?2, o.id)) ORDER BY o.name_lc LIMIT 50`).bind(u.id, t.id).all()).results.map((r) => r.name);
    return json({ id: t.id, name: t.name, avatar: publicMe(t).avatar, joined: t.created, since: f?.accepted_at || null, games: [], achCount: 0, rarest: [], recentAch: [], together: [], mutual, mutualServers: [] });
  },
};


