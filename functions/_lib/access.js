// Server permissions: the bit values match public/js/ui.js (the client mirrors them).
import { HttpError } from "./core.js";

export const P = {
  VIEW_CHANNEL: 1, SEND_MESSAGES: 2, READ_HISTORY: 4, ATTACH_FILES: 8, ADD_REACTIONS: 16, MENTION_EVERYONE: 32,
  MANAGE_MESSAGES: 64, CREATE_INVITE: 128, CHANGE_NICKNAME: 256, MANAGE_NICKNAMES: 512, KICK_MEMBERS: 1024,
  BAN_MEMBERS: 2048, MANAGE_CHANNELS: 4096, MANAGE_ROLES: 8192, MANAGE_SERVER: 16384, ADMINISTRATOR: 32768,
  CONNECT: 65536, SPEAK: 131072, MUTE_MEMBERS: 262144,
};
export const ALL = 524287;
// Bits a channel overwrite can touch.
export const CHANNEL_MASK = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY | P.ATTACH_FILES | P.ADD_REACTIONS | P.MENTION_EVERYONE | P.MANAGE_MESSAGES | P.MANAGE_CHANNELS | P.CONNECT | P.SPEAK | P.MUTE_MEMBERS;
export const EVERYONE_DEFAULT = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY | P.ATTACH_FILES | P.ADD_REACTIONS | P.CREATE_INVITE | P.CHANGE_NICKNAME | P.CONNECT | P.SPEAK;
export const has = (perms, bit) => (perms & bit) === bit;
export const MAX_SERVERS_JOINED = 25;

const q = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
const marks = (n) => Array(n).fill("?").join(",");
export const likeEsc = (s) => String(s).replace(/[\\%_]/g, "\\$&");

// What a member can do in one channel: server permissions, then @everyone's overwrite, then role overwrites, then their own.
export function channelPerms(acc, channel, overwrites) {
  if (acc.base === ALL) return ALL;
  if (channel.kind === "category") return acc.base & CHANNEL_MASK;
  let p = acc.base;
  const ev = overwrites.find((o) => o.kind === "role" && o.target === acc.everyone?.id);
  if (ev) p = (p & ~ev.deny) | ev.allow;
  let deny = 0, allow = 0;
  for (const o of overwrites) if (o.kind === "role" && acc.myRoleIds.has(o.target)) { deny |= o.deny; allow |= o.allow; }
  p = (p & ~deny) | allow;
  const mine = overwrites.find((o) => o.kind === "member" && o.target === acc.userId);
  if (mine) p = (p & ~mine.deny) | mine.allow;
  p &= CHANNEL_MASK;
  return has(p, P.VIEW_CHANNEL) ? p : 0;
}

// Everything about the signed-in user's place in their servers (or just one). Five queries, no matter how many servers.
export async function loadAccess(db, u, onlyServer = null) {
  const servers = await q(db, `SELECT s.*, sm.nick, sm.joined FROM server_members sm JOIN servers s ON s.id = sm.server_id WHERE sm.user_id = ?${onlyServer ? " AND s.id = ?" : ""} ORDER BY sm.joined, s.id`, ...(onlyServer ? [u.id, onlyServer] : [u.id]));
  const out = new Map();
  if (!servers.length) return out;
  const ids = servers.map((s) => s.id), ph = marks(ids.length);
  const [roles, mineRows, channels, ows] = await Promise.all([
    q(db, `SELECT * FROM roles WHERE server_id IN (${ph}) ORDER BY position DESC, id`, ...ids),
    q(db, `SELECT server_id, role_id FROM member_roles WHERE user_id = ? AND server_id IN (${ph})`, u.id, ...ids),
    q(db, `SELECT * FROM channels WHERE server_id IN (${ph}) ORDER BY position, id`, ...ids),
    q(db, `SELECT o.* FROM overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.server_id IN (${ph})`, ...ids),
  ]);
  for (const s of servers) {
    const sRoles = roles.filter((r) => r.server_id === s.id), everyone = sRoles.find((r) => r.everyone);
    const myRoleIds = new Set(mineRows.filter((m) => m.server_id === s.id).map((m) => m.role_id));
    const myRoles = sRoles.filter((r) => myRoleIds.has(r.id)), owner = s.owner === u.id;
    let base = everyone?.perms || 0;
    for (const r of myRoles) base |= r.perms;
    if (owner || has(base, P.ADMINISTRATOR)) base = ALL;
    const acc = { server: s, userId: u.id, owner, base, everyone, roles: sRoles, myRoleIds, top: owner ? 1_000_000 : Math.max(0, ...myRoles.map((r) => r.position)), nick: s.nick, joined: s.joined };
    acc.channels = channels.filter((c) => c.server_id === s.id).map((c) => {
      const overwrites = ows.filter((o) => o.channel_id === c.id);
      return { ...c, overwrites, perms: channelPerms(acc, c, overwrites) };
    });
    out.set(s.id, acc);
  }
  return out;
}

// A text/voice channel the user can see, or a 404 (so hidden channels look like they don't exist).
export async function channelCtx(db, u, channelId) {
  const ch = Number.isInteger(channelId) && await db.prepare("SELECT server_id FROM channels WHERE id = ?").bind(channelId).first();
  const acc = ch && (await loadAccess(db, u, ch.server_id)).get(ch.server_id);
  const channel = acc?.channels.find((c) => c.id === channelId);
  if (!channel || channel.kind === "category" || !has(channel.perms, P.VIEW_CHANNEL)) throw new HttpError(404, "That channel doesn't exist.");
  return { channel, perms: channel.perms, acc };
}

// Unread + mention counts per channel chat ("c:<id>"), only for servers the user is in.
export async function channelUnread(db, u, myRoleIds) {
  const roleLikes = myRoleIds.map(() => " OR m.body LIKE ? ESCAPE '\\'").join("");
  const rows = await q(db, `SELECT m.chat, COUNT(*) AS n,
      SUM(CASE WHEN m.body LIKE ? ESCAPE '\\' OR m.body LIKE '%@everyone%' OR m.body LIKE '%@here%'${roleLikes} THEN 1 ELSE 0 END) AS mentions
    FROM messages m JOIN channels c ON m.chat = 'c:' || c.id JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = ?
    LEFT JOIN reads r ON r.user_id = ? AND r.chat = m.chat
    WHERE m.deleted = 0 AND m.author != ? AND m.id > COALESCE(r.last_id, 0) GROUP BY m.chat`,
    `%@${likeEsc(u.name)}%`, ...myRoleIds.map((id) => `%<@&${id}>%`), u.id, u.id, u.id);
  return new Map(rows.map((r) => [r.chat, { n: r.n, mentions: r.mentions || 0 }]));
}

// The little list on the server rail + pending invites, for the sync payload.
export async function serverSummary(db, u) {
  const access = await loadAccess(db, u);
  if (!access.size) return { servers: [], access };
  const unread = await channelUnread(db, u, [...access.values()].flatMap((a) => [...a.myRoleIds]));
  const servers = [...access.values()].map((a) => {
    let n = 0, mentions = 0;
    for (const c of a.channels) if (c.kind === "text" && has(c.perms, P.VIEW_CHANNEL)) { const x = unread.get(`c:${c.id}`); if (x) { n += x.n; mentions += x.mentions; } }
    return { id: a.server.id, name: a.server.name, icon: a.server.icon ? `/api/si/${a.server.id}?v=${a.server.icon_v}` : null, unread: n, mentions, mine: a.owner, general: !!a.server.general };
  });
  return { servers, access, unread };
}
export async function pendingInvites(db, u) {
  return (await q(db, `SELECT i.id, s.id AS server_id, s.name, s.icon, s.icon_v, o.name AS by_name, i.created FROM server_invites i JOIN servers s ON s.id = i.server_id JOIN users o ON o.id = i.by WHERE i.user_id = ? ORDER BY i.created DESC`, u.id))
    .map((r) => ({ id: r.id, server: r.server_id, name: r.name, icon: r.icon ? `/api/si/${r.server_id}?v=${r.icon_v}` : null, by: r.by_name, created: r.created }));
}
