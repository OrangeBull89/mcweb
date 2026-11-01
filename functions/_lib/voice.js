// Live transport + voice/video. No sockets: tabs poll /api/rt_poll (cheap reads), and send WebRTC signalling
// through /api/rt. Rooms live in D1; every change is pushed to the room's members as a "vroom" event.
import { HttpError, json, requireUser, publicMe } from "./core.js";
import { P, has, channelCtx, loadAccess } from "./access.js";
import { shownStatus } from "./social.js";
import { emitRows, emitUsers, emitServer, friendIds, RT_KEEP_MS } from "./events.js";

const q = async (db, sql, ...a) => (await db.prepare(sql).bind(...a).all()).results;
const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const run = (db, sql, ...a) => db.prepare(sql).bind(...a).run();
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const CONN = /^[0-9a-f]{16,32}$/;
const ROOM_MAX = 8;          // a mesh call: everyone connects to everyone
const STALE_MS = 45_000;     // a call member whose tab stopped polling this long ago is gone

async function ownConn(db, u, raw, { touch = false } = {}) {
  if (typeof raw !== "string" || !CONN.test(raw)) throw new HttpError(400, "Bad connection id.");
  const row = await one(db, "SELECT user_id, last_seen FROM rt_conns WHERE conn = ?", raw), now = Date.now();
  if (row && row.user_id !== u.id) throw new HttpError(403, "That connection belongs to someone else.");
  if (!row) await run(db, "INSERT INTO rt_conns (conn, user_id, last_seen) VALUES (?,?,?)", raw, u.id, now);
  else if (touch && now - row.last_seen > 5_000) await run(db, "UPDATE rt_conns SET last_seen = ? WHERE conn = ?", now, raw); // any request from the tab proves it's alive
  return raw;
}

// ---------- rooms ----------
async function roomMembers(db, room) {
  return q(db, `SELECT vm.*, u.name, u.avatar, u.avatar_v, u.status, u.last_seen, p.idle_since, sm.nick
    FROM voice_members vm JOIN users u ON u.id = vm.user_id LEFT JOIN presence p ON p.user_id = u.id
    LEFT JOIN channels ch ON vm.room = 'c' || ch.id LEFT JOIN server_members sm ON sm.server_id = ch.server_id AND sm.user_id = u.id
    WHERE vm.room = ? ORDER BY vm.since, vm.conn`, room);
}
const memberView = (r, now = Date.now()) => ({
  conn: r.conn, name: r.name, uid: r.user_id, since: r.since, muted: !!r.muted, deaf: !!r.deaf, video: !!r.video, screen: !!r.screen,
  smute: !!r.smute, speak: !!r.speak, status: shownStatus(r, now), nick: r.nick || null, avatar: publicMe({ id: r.user_id, avatar: r.avatar, avatar_v: r.avatar_v }).avatar,
});
// Who hears that a room is busy/empty (the server rail, a DM, a group): so rings stop and lists refresh.
async function observerRows(db, room, count) {
  const payload = { t: "voice", room, count };
  if (room[0] === "c") { const ch = await one(db, "SELECT server_id FROM channels WHERE id = ?", Number(room.slice(1))); return ch ? [[`s:${ch.server_id}`, null, payload]] : []; }
  if (room[0] === "d") return room.slice(1).split("-").map((id) => [`u:${Number(id)}`, null, payload]);
  const ids = await q(db, "SELECT user_id FROM party_members WHERE party_id = ?", Number(room.slice(1)));
  return ids.map((r) => [`u:${r.user_id}`, null, payload]);
}
async function broadcastRoom(db, room) {
  const members = await roomMembers(db, room), now = Date.now(), view = members.map((m) => memberView(m, now));
  const rows = members.map((m) => [`u:${m.user_id}`, m.conn, { t: "vroom", room, members: view }]);
  rows.push(...(await observerRows(db, room, members.length)));
  if (rows.length) await emitRows(db, rows);
}
async function leaveConn(db, conn, room = null) {
  const rooms = (await q(db, `SELECT room FROM voice_members WHERE conn = ?${room ? " AND room = ?" : ""}`, ...(room ? [conn, room] : [conn]))).map((r) => r.room);
  if (!rooms.length) return;
  await run(db, `DELETE FROM voice_members WHERE conn = ?${room ? " AND room = ?" : ""}`, ...(room ? [conn, room] : [conn]));
  for (const r of rooms) await broadcastRoom(db, r);
}
async function reapRoom(db, room) {
  const stale = await q(db, "SELECT vm.conn FROM voice_members vm LEFT JOIN rt_conns c ON c.conn = vm.conn WHERE vm.room = ? AND (c.conn IS NULL OR c.last_seen < ?)", room, Date.now() - STALE_MS);
  if (!stale.length) return;
  for (const s of stale) await run(db, "DELETE FROM voice_members WHERE room = ? AND conn = ?", room, s.conn);
  await broadcastRoom(db, room);
}

// A voice target from the client: {channel} | {party} | {with: name}
async function resolveTarget(db, u, body) {
  if (body.channel != null) {
    const cc = await channelCtx(db, u, Number(body.channel));
    if (cc.channel.kind !== "voice") throw new HttpError(400, "That isn't a voice channel.");
    if (!has(cc.perms, P.CONNECT)) throw new HttpError(403, "You can't join this voice channel.");
    return { room: `c${cc.channel.id}`, kind: "channel", speak: has(cc.perms, P.SPEAK), cc };
  }
  if (body.party != null) {
    const id = Number(body.party);
    if (!Number.isInteger(id) || !(await one(db, "SELECT 1 AS x FROM party_members WHERE party_id = ? AND user_id = ?", id, u.id))) throw new HttpError(404, "That group chat doesn't exist.");
    return { room: `p${id}`, kind: "party", party: id, speak: true };
  }
  const other = await one(db, "SELECT * FROM users WHERE name_lc = ?", str(body.with, 16).toLowerCase());
  if (!other || other.id === u.id) throw new HttpError(404, "That person doesn't exist.");
  if (await one(db, "SELECT 1 AS x FROM blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1)", u.id, other.id)) throw new HttpError(403, "You can't call this person.");
  return { room: `d${Math.min(u.id, other.id)}-${Math.max(u.id, other.id)}`, kind: "dm", other, speak: true };
}
async function ringTargets(db, u, t) {
  if (t.kind === "dm") return [t.other.id];
  return (await q(db, "SELECT user_id FROM party_members WHERE party_id = ? AND user_id != ?", t.party, u.id)).map((r) => r.user_id);
}
const callEvent = (u, t) => ({ t: "call", room: t.room, from: u.name, ...(t.kind === "party" ? { party: t.party } : {}) });

const rtcHits = new Map(); // per-isolate flood guard for signalling
function rtcAllowed(conn) {
  const now = Date.now(), hits = (rtcHits.get(conn) || []).filter((t) => now - t < 10_000);
  if (hits.length >= 400) return false;
  hits.push(now); rtcHits.set(conn, hits);
  if (rtcHits.size > 2000) rtcHits.clear();
  return true;
}
const typingAt = new Map();
let turnCache = { until: 0, out: null };

export const voiceRoutes = {
  // The tab's heartbeat + inbox. First call (after: null) just returns a cursor so old events aren't replayed.
  async rt_poll({ db, req, body }) {
    const u = await requireUser(db, req), conn = await ownConn(db, u, body.conn), now = Date.now();
    const row = await one(db, "SELECT last_seen FROM rt_conns WHERE conn = ?", conn);
    if (now - row.last_seen > (body.voice ? 5_000 : 30_000)) await run(db, "UPDATE rt_conns SET last_seen = ? WHERE conn = ?", now, conn);
    if (!Number.isInteger(body.after)) return json({ events: [], cursor: (await one(db, "SELECT COALESCE(MAX(id), 0) AS m FROM rt_events")).m, now });
    const rows = await q(db, `SELECT id, payload FROM rt_events WHERE id > ?1 AND (scope = ?2 OR scope IN (SELECT 's:' || server_id FROM server_members WHERE user_id = ?3)) AND (conn IS NULL OR conn = ?4) ORDER BY id LIMIT 200`, body.after, `u:${u.id}`, u.id, conn);
    if (body.voice) { const mine = await one(db, "SELECT room FROM voice_members WHERE conn = ?", conn); if (mine) await reapRoom(db, mine.room); }
    if (Math.random() < 0.02) { await run(db, "DELETE FROM rt_events WHERE created < ?", now - RT_KEEP_MS); await run(db, "DELETE FROM rt_conns WHERE last_seen < ?", now - 3_600_000); }
    const events = rows.map((r) => JSON.parse(r.payload)).filter((e) => e.from !== u.name || e.t === "rtc" || e.t === "call");
    return json({ events, cursor: rows.length ? rows[rows.length - 1].id : body.after, now });
  },

  // Messages a tab used to send over the socket: WebRTC signalling, mute/camera state, leaving.
  async rt({ db, req, body }) {
    const u = await requireUser(db, req), conn = await ownConn(db, u, body.conn, { touch: true }), m = body.msg || {};
    const mine = await one(db, "SELECT room FROM voice_members WHERE conn = ?", conn);
    if (m.t === "rtc") {
      if (!mine || typeof m.to !== "string" || !rtcAllowed(conn)) return json({ ok: true });
      const to = await one(db, "SELECT user_id, conn FROM voice_members WHERE room = ? AND conn = ?", mine.room, m.to);
      const data = JSON.stringify(m.data ?? null);
      if (to && data.length <= 20_000) await emitUsers(db, [to.user_id], { t: "rtc", from: conn, data: m.data }, to.conn);
    } else if (m.t === "vset" && mine) {
      await run(db, "UPDATE voice_members SET muted = ?, deaf = ?, video = ?, screen = ? WHERE conn = ?", m.muted ? 1 : 0, m.deaf ? 1 : 0, m.video ? 1 : 0, m.screen ? 1 : 0, conn);
      await broadcastRoom(db, mine.room);
    } else if (m.t === "vleave") await leaveConn(db, conn, typeof m.room === "string" ? m.room : null);
    return json({ ok: true });
  },

  async voice_join({ db, req, body }) {
    const u = await requireUser(db, req), conn = await ownConn(db, u, body.conn, { touch: true }), t = await resolveTarget(db, u, body);
    await reapRoom(db, t.room);
    // one voice seat per person: a second tab takes it over
    for (const old of await q(db, "SELECT room, conn FROM voice_members WHERE user_id = ? AND conn != ?", u.id, conn)) {
      await run(db, "DELETE FROM voice_members WHERE room = ? AND conn = ?", old.room, old.conn);
      await emitUsers(db, [u.id], { t: "vroom", room: null }, old.conn);
      await broadcastRoom(db, old.room);
    }
    await leaveConn(db, conn);
    const n = (await one(db, "SELECT COUNT(*) AS n FROM voice_members WHERE room = ?", t.room)).n;
    if (n >= ROOM_MAX) throw new HttpError(400, `That call is full (${ROOM_MAX} people).`);
    await run(db, "INSERT INTO voice_members (room, conn, user_id, since, speak) VALUES (?,?,?,?,?)", t.room, conn, u.id, Date.now(), t.speak ? 1 : 0);
    await broadcastRoom(db, t.room);
    let rang = false;
    if (body.ring !== false && t.kind !== "channel" && n === 0) { await emitUsers(db, await ringTargets(db, u, t), callEvent(u, t)); rang = true; }
    return json({ room: t.room, rang });
  },
  async voice_leave({ db, req, body }) {
    const u = await requireUser(db, req), conn = await ownConn(db, u, body.conn);
    await leaveConn(db, conn, typeof body.room === "string" ? body.room : null);
    return json({ ok: true });
  },
  async voice_ring({ db, req, body }) {
    const u = await requireUser(db, req), t = await resolveTarget(db, u, body);
    if (t.kind === "channel") throw new HttpError(400, "You can't ring a channel.");
    const members = await q(db, "SELECT user_id FROM voice_members WHERE room = ?", t.room);
    if (members.length !== 1 || members[0].user_id !== u.id) return json({ ok: true });
    await emitUsers(db, await ringTargets(db, u, t), callEvent(u, t));
    return json({ ok: true });
  },
  async voice_decline({ db, req, body }) {
    const u = await requireUser(db, req);
    const caller = await one(db, "SELECT * FROM users WHERE name_lc = ?", str(body.with, 16).toLowerCase());
    if (caller && (await one(db, "SELECT 1 AS x FROM voice_members WHERE room = ? AND user_id = ?", `d${Math.min(u.id, caller.id)}-${Math.max(u.id, caller.id)}`, caller.id)))
      await emitUsers(db, [caller.id], { t: "calldecline", from: u.name });
    return json({ ok: true });
  },
  // Server-mute someone in a voice channel (needs Mute Members, and you must outrank them).
  async voice_mute({ db, req, body }) {
    const u = await requireUser(db, req), cc = await channelCtx(db, u, Number(body.channel));
    if (!has(cc.perms, P.MUTE_MEMBERS)) throw new HttpError(403, "You don't have permission for that.");
    const t = await one(db, "SELECT x.id FROM voice_members vm JOIN users x ON x.id = vm.user_id WHERE vm.room = ? AND x.name_lc = ?", `c${cc.channel.id}`, str(body.name, 16).toLowerCase());
    if (!t) throw new HttpError(404, "They aren't in this channel.");
    if (t.id === cc.acc.server.owner) throw new HttpError(403, "Nobody can do that to the server owner.");
    const theirTop = (await one(db, "SELECT MAX(r.position) AS t FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.user_id = ?", cc.acc.server.id, t.id))?.t || 0;
    if (t.id !== u.id && !(cc.acc.top > theirTop)) throw new HttpError(403, "They have a role as high as yours or higher.");
    await run(db, "UPDATE voice_members SET smute = ? WHERE room = ? AND user_id = ?", body.muted ? 1 : 0, `c${cc.channel.id}`, t.id);
    await broadcastRoom(db, `c${cc.channel.id}`);
    return json({ ok: true });
  },
  async voice_rooms({ db, req, body }) {
    const u = await requireUser(db, req);
    let keys;
    if (body.server != null) {
      const sid = Number(body.server), acc = (await loadAccess(db, u, sid)).get(sid);
      if (!acc) throw new HttpError(404, "That server doesn't exist.");
      keys = acc.channels.filter((c) => c.kind === "voice" && has(c.perms, P.VIEW_CHANNEL)).map((c) => `c${c.id}`);
    } else keys = [(await resolveTarget(db, u, body)).room];
    const rooms = {};
    if (keys.length) {
      const busy = (await q(db, `SELECT DISTINCT room FROM voice_members WHERE room IN (${keys.map(() => "?").join(",")})`, ...keys)).map((r) => r.room);
      for (const room of busy) { await reapRoom(db, room); const m = await roomMembers(db, room); if (m.length) rooms[room] = m.map((x) => memberView(x)); }
    }
    return json({ rooms });
  },

  // Optional relay for people behind strict networks (Cloudflare Realtime TURN, free tier). Without keys: STUN only.
  async turn({ db, env, req }) {
    await requireUser(db, req);
    if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return json({ iceServers: [], ttl: 3600 });
    if (turnCache.until > Date.now() && turnCache.out) return json(turnCache.out);
    let data;
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: "POST", headers: { authorization: `Bearer ${env.TURN_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ ttl: 86_400 }),
      });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch { throw new HttpError(502, "The relay server didn't answer."); }
    // port 53 is blocked in browsers; keep only entries with credentials (the client already has STUN)
    const iceServers = (data.iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((x) => !/:53(\?|$)/.test(x)) })).filter((s) => s.urls.length && s.credential);
    turnCache = { until: Date.now() + 12 * 3_600_000, out: { iceServers, ttl: 86_400 } };
    return json(turnCache.out);
  },

  // Ask a friend's game to leave your world (the game page listens for this event).
  async kick({ db, req, body }) {
    const u = await requireUser(db, req);
    const t = await one(db, "SELECT * FROM users WHERE name_lc = ?", str(body.name, 16).toLowerCase());
    const [lo, hi] = t ? [Math.min(u.id, t.id), Math.max(u.id, t.id)] : [0, 0];
    if (!t || !(await one(db, "SELECT 1 AS x FROM friendships WHERE lo = ? AND hi = ? AND accepted = 1", lo, hi))) throw new HttpError(404, "They aren't one of your friends.");
    await emitUsers(db, [t.id], { t: "kick", from: u.name });
    return json({ ok: true });
  },
};
export { friendIds, emitServer };
