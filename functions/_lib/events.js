// Live events. A tab polls /api/rt_poll and gets everything addressed to its user ("u:<id>"), to its own
// connection (rtc signalling, room updates), or to a server it's in ("s:<id>"). One row serves a whole server.
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const q = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;

export const RT_KEEP_MS = 120_000;

export async function emitRows(db, rows) { // rows: [scope, conn|null, payload]
  const now = Date.now();
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    await db.prepare(`INSERT INTO rt_events (scope, conn, payload, created) VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}`)
      .bind(...chunk.flatMap(([scope, conn, payload]) => [scope, conn, JSON.stringify(payload), now])).run();
  }
}
export const emitUsers = (db, ids, payload, conn = null) => { const u = [...new Set(ids)]; return u.length ? emitRows(db, u.map((id) => [`u:${id}`, conn, payload])) : null; };
export const emitServer = (db, serverId, payload) => emitRows(db, [[`s:${serverId}`, null, payload]]);

// Tell the other people in a chat that something happened ("msg", "edit", "typing", "seen").
// DMs/groups name the sender; server channels send a bare ping (the tab then refetches and the server checks permissions).
export async function notifyChat(db, u, chat, type, { priv = false } = {}) {
  if (chat.startsWith("dm:")) {
    const [a, b] = chat.split(":").slice(1).map(Number);
    return emitUsers(db, [a === u.id ? b : a], { t: type, from: u.name, dm: u.name });
  }
  if (chat.startsWith("p:")) {
    const id = Number(chat.slice(2)), ids = (await q(db, "SELECT user_id FROM party_members WHERE party_id = ? AND user_id != ?", id, u.id)).map((r) => r.user_id);
    return emitUsers(db, ids, { t: type, from: u.name, party: id });
  }
  if (chat.startsWith("c:")) {
    const ch = await db.prepare("SELECT id, server_id FROM channels WHERE id = ?").bind(Number(chat.slice(2))).first();
    if (!ch || (priv && type === "typing")) return null;
    return emitServer(db, ch.server_id, { t: type, server: ch.server_id, channel: ch.id, ...(priv ? {} : { from: u.name }) });
  }
  return null;
}

// @name pings inside a server channel (and @everyone/@here, which the caller has already checked is allowed).
export async function notifyMentions(db, u, serverId, channelId, text) {
  const names = new Set([...text.matchAll(/@([A-Za-z0-9_]{3,16})\b/g)].map((m) => m[1].toLowerCase()).filter((n) => n !== "everyone" && n !== "here"));
  let ids = [];
  if (/(^|\s)@(everyone|here)\b/.test(text)) ids = (await q(db, "SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ?", serverId, u.id)).map((r) => r.user_id);
  else if (names.size) ids = (await q(db, `SELECT sm.user_id FROM server_members sm JOIN users x ON x.id = sm.user_id WHERE sm.server_id = ? AND x.id != ? AND x.name_lc IN (${[...names].slice(0, 10).map(() => "?").join(",")})`, serverId, u.id, ...[...names].slice(0, 10))).map((r) => r.user_id);
  return emitUsers(db, ids, { t: "mention", from: u.name, server: serverId, channel: channelId });
}

export const friendIds = async (db, userId) => (await q(db, "SELECT CASE WHEN lo = ?1 THEN hi ELSE lo END AS id FROM friendships WHERE accepted = 1 AND (lo = ?1 OR hi = ?1)", userId)).map((r) => r.id);
