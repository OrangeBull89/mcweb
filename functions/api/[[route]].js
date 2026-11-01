// MC-Web launcher API router. Every route is POST /api/<route> with JSON.
// Routes live in: this file (accounts), _lib/social.js (friends, chat), _lib/admin.js (dashboard, games).
import { HttpError, json, MAX_BODY, SESSION_MS, NAME_RE, randomHex, sha256, safeEqual, hashPassword, itersFor, cookie, readCookie, guard, recordFail, clearFails,
  createSession, requireUser, blockReason, publicMe, prefsOf, cleanPrefs, validAvatar, siteInfo, clientSite, adminPerms } from "../_lib/core.js";
import { socialRoutes, buildSync } from "../_lib/social.js";
import { adminRoutes, gamesFor } from "../_lib/admin.js";
import { serverRoutes } from "../_lib/servers.js";
import { voiceRoutes } from "../_lib/voice.js";

const routes = {
  async site({ db, env }) { return json(clientSite(await siteInfo(db, env))); },

  async register({ db, env, req, body, ip }) {
    const name = String(body.name ?? "").trim(), password = String(body.password ?? ""), phrase = String(body.phrase ?? "").trim();
    const keys = [`reg:ip:${ip}`];
    await guard(db, keys, 6);
    const s = await siteInfo(db, env);
    if (!s.signupOpen) throw new HttpError(403, "Sign-up is closed right now.");
    if (!NAME_RE.test(name)) throw new HttpError(400, "Usernames are 3-16 letters, numbers or underscores.");
    if (password.length < 6 || password.length > 200) throw new HttpError(400, "Passwords need 6 to 200 characters.");
    const want = s.phraseHash === null ? await sha256(String(env.SIGNUP_PHRASE).trim().toLowerCase()) : s.phraseHash;
    if (!safeEqual(await sha256(phrase.toLowerCase()), want)) { await recordFail(db, keys[0]); throw new HttpError(403, "That secret phrase isn't right."); }
    const salt = randomHex(16), iters = itersFor(env), hash = await hashPassword(password, salt, iters);
    let id;
    try {
      const r = await db.prepare("INSERT INTO users (name, name_lc, salt, hash, iters, created) VALUES (?, ?, ?, ?, ?, ?)").bind(name, name.toLowerCase(), salt, hash, iters, Date.now()).run();
      id = r.meta.last_row_id;
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, "That username is taken.");
      throw e;
    }
    const token = await createSession(db, id, req);
    return json({ ok: true }, 200, { "set-cookie": cookie(token, SESSION_MS / 1000) });
  },

  async login({ db, env, req, body, ip }) {
    const name = String(body.name ?? "").trim().toLowerCase(), password = String(body.password ?? "");
    const keys = [`login:ip:${ip}`, `login:name:${name}`];
    await guard(db, keys, 8);
    const u = await db.prepare("SELECT * FROM users WHERE name_lc = ?").bind(name).first();
    // Hash either way so a missing account takes as long as a wrong password.
    const hash = await hashPassword(password, u ? u.salt : "00".repeat(16), u ? u.iters : itersFor(env));
    if (!u || !safeEqual(hash, u.hash)) {
      for (const k of keys) await recordFail(db, k);
      throw new HttpError(401, "Wrong username or password.");
    }
    await clearFails(db, keys[1]);
    const b = blockReason(u);
    if (b) throw new HttpError(403, b.banned ? "This account is banned." : b.disabled ? "This account is disabled." : "This account is suspended.", b);
    const token = await createSession(db, u.id, req);
    return json({ ok: true }, 200, { "set-cookie": cookie(token, SESSION_MS / 1000) });
  },

  async boot({ db, env, req }) {
    const u = await requireUser(db, req);
    const perms = await adminPerms(db, env, u);
    return json({
      me: publicMe(u), head: perms === "all", admin: perms === "all" ? "all" : perms.length ? perms : null, prefs: prefsOf(u),
      games: await gamesFor(db, env, u), site: clientSite(await siteInfo(db, env)), now: Date.now(), rt: env.RT_MODE === "ws" ? "ws" : "poll",
    });
  },

  async avatar({ db, req, body }) {
    const u = await requireUser(db, req);
    const avatar = validAvatar(body.avatar ?? null);
    await db.prepare("UPDATE users SET avatar = ?, avatar_v = avatar_v + 1 WHERE id = ?").bind(avatar, u.id).run();
    u.avatar = avatar; u.avatar_v = (u.avatar_v || 0) + 1;
    return json(await buildSync(db, u));
  },


  async logout({ db, req }) {
    const token = readCookie(req, "sid");
    if (token && /^[0-9a-f]{64}$/.test(token)) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  },

  async prefs({ db, req, body }) {
    const u = await requireUser(db, req);
    const merged = { ...prefsOf(u), ...cleanPrefs(body.prefs) };
    await db.prepare("UPDATE users SET prefs = ? WHERE id = ?").bind(JSON.stringify(merged), u.id).run();
    return json({ prefs: merged });
  },

  async sessions({ db, req }) {
    const u = await requireUser(db, req);
    const { results } = await db.prepare("SELECT id, agent, created, last_used FROM sessions WHERE user_id = ? ORDER BY last_used DESC").bind(u.id).all();
    return json({ sessions: results.map((s) => ({ id: s.id, agent: s.agent, created: s.created, lastUsed: s.last_used, current: s.id === u.sid })) });
  },

  async session_revoke({ db, req, body }) {
    const u = await requireUser(db, req);
    if (body.all) await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(u.id, u.sid).run();
    else if (typeof body.id === "string" && body.id !== u.sid) await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id = ?").bind(u.id, body.id).run();
    return routes.sessions({ db, req });
  },

  async password({ db, env, req, body }) {
    const u = await requireUser(db, req);
    const old = String(body.old ?? ""), next = String(body.password ?? "");
    await guard(db, [`pw:${u.id}`], 6);
    if (next.length < 6 || next.length > 200) throw new HttpError(400, "Passwords need 6 to 200 characters.");
    if (!safeEqual(await hashPassword(old, u.salt, u.iters), u.hash)) { await recordFail(db, `pw:${u.id}`); throw new HttpError(403, "Your current password isn't right."); }
    const salt = randomHex(16);
    await db.prepare("UPDATE users SET salt = ?, hash = ?, iters = ? WHERE id = ?").bind(salt, await hashPassword(next, salt, itersFor(env)), itersFor(env), u.id).run();
    await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(u.id, u.sid).run();
    return json({ ok: true });
  },

  // Redeems a one-time code an admin created (admin tools come in a later slice).
  async recover({ db, env, req, body, ip }) {
    const name = String(body.name ?? "").trim().toLowerCase(), token = String(body.token ?? "").trim().toUpperCase(), password = String(body.password ?? "");
    const keys = [`rec:ip:${ip}`, `rec:name:${name}`];
    await guard(db, keys, 6);
    if (password.length < 6 || password.length > 200) throw new HttpError(400, "Passwords need 6 to 200 characters.");
    const u = await db.prepare("SELECT u.*, r.token_hash, r.expires FROM users u JOIN recovery r ON r.user_id = u.id WHERE u.name_lc = ?").bind(name).first();
    if (!u || u.expires < Date.now() || !safeEqual(await sha256(token), u.token_hash)) {
      for (const k of keys) await recordFail(db, k);
      throw new HttpError(403, "That recovery code isn't valid or has expired.");
    }
    const salt = randomHex(16);
    await db.prepare("UPDATE users SET salt = ?, hash = ?, iters = ? WHERE id = ?").bind(salt, await hashPassword(password, salt, itersFor(env)), itersFor(env), u.id).run();
    await db.prepare("DELETE FROM recovery WHERE user_id = ?").bind(u.id).run();
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id).run();
    const session = await createSession(db, u.id, req);
    return json({ ok: true }, 200, { "set-cookie": cookie(session, SESSION_MS / 1000) });
  },

  ...socialRoutes,
  ...serverRoutes,
  ...voiceRoutes,
  ...adminRoutes,
};

export async function onRequest({ request, env, params }) {
  const route = [].concat(params?.route || []).join("/");
  try {
    if (request.method !== "POST") throw new HttpError(405, "Use POST.");
    // A custom header makes cross-site form posts impossible without a CORS preflight.
    if (request.headers.get("x-launcher") !== "1") throw new HttpError(400, "Bad request.");
    const text = await request.text();
    if (text.length > MAX_BODY) throw new HttpError(413, "That's too big.");
    let body = {};
    if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, "Bad request."); } }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Bad request.");
    const fn = Object.hasOwn(routes, route) ? routes[route] : null;
    if (!fn) throw new HttpError(404, `"${route}" isn't built yet.`);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    return await fn({ db: env.DB, env, req: request, body, ip });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error("[api]", route, e);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}
