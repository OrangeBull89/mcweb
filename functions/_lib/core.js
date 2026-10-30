// MC-Web launcher API, slice 1: accounts, sessions, boot, sync, prefs, avatar.
// Every route is POST /api/<route> with JSON. Social routes (messages, servers,
// friends, voice...) are not built yet and answer 404 "not built yet".

export const enc = new TextEncoder();
export const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const SESSION_MS = 30 * 24 * 3600 * 1000;
// Hashing rounds. Workers' free plan allows ~10 ms CPU per request, so the default is 50k (about 7 ms); the platform maximum is 100k.
// Each account remembers the count it was hashed with, so this can be raised later without breaking anyone's password.
export const itersFor = (env) => Math.min(100_000, Math.max(10_000, Number(env?.PBKDF2_ITERS) || 50_000));
export const MAX_BODY = 300_000;
export const MAX_AVATAR = 200_000;
export const STATUSES = new Set(["online", "dnd", "invisible", "idle"]);

export const PREF_TYPES = {
  theme: ["dark", "light", "system"], hotkey: "string", afk: "number", sounds: "boolean", desktop: "boolean",
  dmToasts: "boolean", mentionsOnly: "boolean", compact: "boolean", ptt: "boolean", pttKey: "string",
  voiceGate: "boolean", serverOrder: "string",
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function hashPassword(password, saltHex, iters) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: iters }, key, 256));
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
export const cookie = (value, maxAge) => `sid=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
export const readCookie = (req, name) => (req.headers.get("cookie") || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1] || null;

export function agentLabel(ua = "") {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux|CrOS/.test(ua) ? "Linux" : "Unknown device";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}

// ---- settings: stored in D1 (admin screen); env values are the first-run defaults ----
export async function siteInfo(db, env) {
  const { results } = await db.prepare("SELECT k, v FROM settings").all();
  const m = Object.fromEntries(results.map((r) => [r.k, r.v]));
  const pick = (k, envVal) => (k in m ? m[k] : envVal || "");
  const phraseHash = "phrase_hash" in m ? m.phrase_hash : env.SIGNUP_PHRASE ? null : "";
  return {
    downloads: driveUrl(pick("downloads", env.DOWNLOADS_URL)), update: driveUrl(pick("update", env.UPDATE_URL)),
    banner: pick("banner", env.BANNER) || null,
    signupOpen: phraseHash === null ? true : phraseHash !== "", phraseHash, // null: use env SIGNUP_PHRASE
  };
}
export const setSetting = (db, k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();
export const clientSite = (s) => ({ downloads: s.downloads, update: s.update, banner: s.banner, signupOpen: s.signupOpen });
export const driveUrl = (u) => (typeof u === "string" && /^https:\/\/(drive|docs)\.google\.com\//.test(u) && u.length <= 500 ? u : null);

// ---- rate limiting (failures only) ----
export async function tooMany(db, key, max, windowMs) {
  const since = Date.now() - windowMs;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE k = ? AND ts > ?").bind(key, since).first();
  return (row?.n || 0) >= max;
}
export const recordFail = (db, key) => db.prepare("INSERT INTO attempts (k, ts) VALUES (?, ?)").bind(key, Date.now()).run();
export const clearFails = (db, key) => db.prepare("DELETE FROM attempts WHERE k = ?").bind(key).run();
export async function guard(db, keys, max = 8, windowMs = 10 * 60_000) {
  for (const k of keys) if (await tooMany(db, k, max, windowMs)) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
}

// ---- sessions ----
export async function createSession(db, userId, req) {
  const token = randomHex(32), id = randomHex(8), now = Date.now();
  await db.prepare("INSERT INTO sessions (id, token_hash, user_id, agent, created, last_used) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256(token), userId, agentLabel(req.headers.get("user-agent") || ""), now, now).run();
  return token;
}
export async function authenticate(db, req) {
  const token = readCookie(req, "sid");
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db.prepare(
    "SELECT s.id AS sid, s.created AS s_created, s.last_used, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(await sha256(token)).first();
  if (!row) return null;
  const now = Date.now();
  if (now - row.s_created > SESSION_MS) { await db.prepare("DELETE FROM sessions WHERE id = ?").bind(row.sid).run(); return null; }
  if (now - row.last_used > 10 * 60_000) await db.prepare("UPDATE sessions SET last_used = ? WHERE id = ?").bind(now, row.sid).run();
  return row;
}
export const blockReason = (u) =>
  u.banned ? { suspended: true, banned: true, reason: u.reason || "" }
  : u.disabled ? { suspended: true, disabled: true, reason: "This account is disabled." }
  : u.suspended_until && u.suspended_until > Date.now() ? { suspended: true, until: u.suspended_until, reason: u.reason || "" } : null;
export async function requireUser(db, req) {
  const u = await authenticate(db, req);
  if (!u) throw new HttpError(401, "You're signed out. Sign in again.", { signedOut: true });
  const b = blockReason(u);
  if (b) throw new HttpError(403, b.banned ? "This account is banned." : b.disabled ? "This account is disabled." : "This account is suspended.", b);
  return u;
}

// ---- shapes sent to the client ----
export const publicMe = (u) => ({ id: u.id, name: u.name, created: u.created, avatar: u.avatar ? `/api/av/${u.id}?v=${u.avatar_v || 0}` : null });
export const isHead = (env, u) => !!env.HEAD_ADMIN && u.name_lc === String(env.HEAD_ADMIN).toLowerCase();
export function prefsOf(u) { try { return JSON.parse(u.prefs) || {}; } catch { return {}; } }

export function validAvatar(v) {
  if (v === null) return null;
  const m = typeof v === "string" && v.length <= MAX_AVATAR && /^data:image\/(webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) throw new HttpError(400, "That picture isn't a supported image.");
  let head;
  try { head = atob(m[2].slice(0, 24)); } catch { throw new HttpError(400, "That picture isn't a supported image."); }
  const ok = m[1] === "jpeg" ? head.startsWith("\xff\xd8\xff") : head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
  if (!ok) throw new HttpError(400, "That picture isn't a supported image.");
  return v;
}

export function cleanPrefs(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "Bad preferences.");
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    const t = PREF_TYPES[k];
    if (!t) continue;
    if (Array.isArray(t) ? !t.includes(v) : typeof v !== t) throw new HttpError(400, `Bad value for ${k}.`);
    if (t === "string" && v.length > 200) throw new HttpError(400, `Bad value for ${k}.`);
    if (t === "number" && !(v >= 0 && v <= 1440)) throw new HttpError(400, `Bad value for ${k}.`);
    out[k] = v;
  }
  return out;
}


// ---- admin ----
export const PERM_INFO = {
  view_accounts: "See the accounts list", suspend: "Suspend accounts", ban: "Ban and unban accounts", disable: "Disable and restore accounts",
  revoke_sessions: "Sign people out everywhere", recovery: "Make password recovery codes", rename: "Rename accounts",
  game_access: "Allow or block a game per account", game_registry: "Add, edit and remove games", servers: "See and delete servers",
  site_settings: "Edit the downloads and update links", banner: "Edit the announcement banner", view_audit: "Read the audit log",
};
export async function adminPerms(db, env, u) {
  if (isHead(env, u)) return "all";
  const { results } = await db.prepare("SELECT perm FROM admin_grants WHERE user_id = ?").bind(u.id).all();
  return results.map((r) => r.perm).filter((p) => p in PERM_INFO);
}
export async function requirePerm(db, env, u, perm) {
  const perms = await adminPerms(db, env, u);
  if (perms !== "all" && !perms.includes(perm)) throw new HttpError(403, "You don't have permission for that.");
  return perms;
}
export const audit = (db, actor, action, target = null, detail = null) =>
  db.prepare("INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), actor, action, target, detail ? JSON.stringify(detail) : null).run();
