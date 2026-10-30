// Admin dashboard routes + the game registry and patch notes (which feed boot.games).
import { HttpError, json, requireUser, publicMe, adminPerms, requirePerm, audit, isHead, PERM_INFO, NAME_RE, sha256, randomHex, driveUrl, siteInfo, setSetting } from "./core.js";

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const ONLINE_MS = 100_000;

// ---------- games (boot.games) ----------
export async function gamesFor(db, env, u) {
  const perms = await adminPerms(db, env, u), isAdmin = perms === "all" || perms.length > 0;
  const now = Date.now();
  const rows = (await db.prepare("SELECT * FROM games ORDER BY sort, name").all()).results;
  const access = new Map((await db.prepare("SELECT game, allowed FROM game_access WHERE user_id = ?").bind(u.id).all()).results.map((r) => [r.game, !!r.allowed]));
  const notes = (await db.prepare("SELECT game, build, title, reinstall FROM patch_notes ORDER BY build DESC").all()).results;
  const out = [];
  for (const g of rows) {
    const state = g.state === "soon" && g.unlocks && g.unlocks <= now ? "live" : g.state;
    if (state === "hidden" && !isAdmin) continue;
    const gn = notes.filter((n) => n.game === g.id);
    const gameFileBuild = gn.find((n) => n.reinstall === 1)?.build || 0;
    const opt = gn.find((n) => n.reinstall === 2 && n.build > gameFileBuild);
    const allowed = access.has(g.id) ? access.get(g.id) : !!g.open_to_all;
    const playable = g.path && allowed && (state === "live" || isAdmin);
    out.push({ id: g.id, name: g.name, tagline: g.tagline, art: g.art, path: playable ? g.path : null, state, tag: g.tag || null, rebuild: !!g.rebuild, unlocks: g.unlocks || null,
      gameFileBuild, optionalUpdate: opt ? { build: opt.build, title: opt.title } : null });
  }
  return out;
}

// ---------- helpers ----------
async function needAdmin(db, env, req) {
  const u = await requireUser(db, req);
  const perms = await adminPerms(db, env, u);
  if (perms !== "all" && !perms.length) throw new HttpError(403, "You're not an admin.");
  return { u, perms, head: perms === "all" };
}
const can = (perms, p) => perms === "all" || perms.includes(p);
const need = (perms, p) => { if (!can(perms, p)) throw new HttpError(403, "You don't have permission for that."); };

async function targetUser(db, env, actor, id, { allowSelf = false } = {}) {
  const t = await db.prepare("SELECT * FROM users WHERE id = ?").bind(Number(id)).first();
  if (!t) throw new HttpError(404, "No such account.");
  if (isHead(env, t)) throw new HttpError(403, "Nobody can act on the head admin.");
  if (t.id === actor.u.id && !allowSelf) throw new HttpError(403, "You can't do that to your own account.");
  const theirs = await adminPerms(db, env, t);
  if (theirs.length && !actor.head) throw new HttpError(403, "Only the head admin can act on another admin.");
  return t;
}
const adminFlag = async (db, env, row) => (isHead(env, row) ? "head" : (await adminPerms(db, env, row)).length ? "admin" : null);

const gameRow = (g) => ({ id: g.id, name: g.name, tagline: g.tagline, path: g.path, state: g.state, open_to_all: g.open_to_all, art: g.art, sort: g.sort, tag: g.tag, rebuild: g.rebuild, unlocks: g.unlocks });
const allGames = async (db) => (await db.prepare("SELECT * FROM games ORDER BY sort, name").all()).results.map(gameRow);

const notesFor = async (db, env, u, game) => {
  const perms = await adminPerms(db, env, u);
  const notes = (await db.prepare("SELECT id, build, title, body, reinstall, released FROM patch_notes WHERE game = ? ORDER BY build DESC").bind(game).all()).results;
  return { notes, canEdit: can(perms, "game_registry") };
};

async function adminsInfo(db, env) {
  const rows = (await db.prepare("SELECT u.id, u.name, GROUP_CONCAT(g.perm) AS perms FROM admin_grants g JOIN users u ON u.id = g.user_id GROUP BY u.id ORDER BY u.name_lc").all()).results;
  return { admins: rows.map((r) => ({ id: r.id, name: r.name, perms: String(r.perms).split(",").filter((p) => p in PERM_INFO) })), permInfo: PERM_INFO };
}

// ---------- routes ----------
export const adminRoutes = {
  async admin_overview({ db, env, req }) {
    const { perms, head } = await needAdmin(db, env, req);
    const c = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()).n;
    return json({
      head, perms: head ? Object.keys(PERM_INFO) : perms, permInfo: PERM_INFO,
      counts: { users: await c("SELECT COUNT(*) AS n FROM users"), online: await c("SELECT COUNT(*) AS n FROM users WHERE last_seen > ? AND status != 'invisible'", Date.now() - ONLINE_MS), servers: 0, sessions: await c("SELECT COUNT(*) AS n FROM sessions") },
    });
  },

  async admin_users({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "view_accounts");
    const q = str(body.q, 16).toLowerCase().replace(/[%_\\]/g, "");
    const rows = (await db.prepare("SELECT * FROM users WHERE name_lc LIKE ? ORDER BY id DESC LIMIT 100").bind(`%${q}%`).all()).results;
    const users = [];
    for (const r of rows) users.push({ id: r.id, name: r.name, avatar: publicMe(r).avatar, created: r.created, lastSeen: r.last_seen || null, online: r.last_seen > Date.now() - ONLINE_MS && r.status !== "invisible",
      admin: await adminFlag(db, env, r), banned: !!r.banned, disabled: !!r.disabled, suspendedUntil: r.suspended_until > Date.now() ? r.suspended_until : null, reason: r.reason || null });
    return json({ users });
  },

  async admin_user({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "view_accounts");
    const r = await db.prepare("SELECT * FROM users WHERE id = ?").bind(Number(body.id)).first();
    if (!r) throw new HttpError(404, "No such account.");
    const n = async (sql, ...x) => (await db.prepare(sql).bind(...x).first()).n;
    const grants = isHead(env, r) ? [] : (await adminPerms(db, env, r));
    return json({
      user: { id: r.id, name: r.name, avatar: publicMe(r).avatar, created: r.created, lastSeen: r.last_seen || null, online: r.last_seen > Date.now() - ONLINE_MS && r.status !== "invisible",
        admin: await adminFlag(db, env, r), banned: !!r.banned, disabled: !!r.disabled, suspendedUntil: r.suspended_until > Date.now() ? r.suspended_until : null, reason: r.reason || null },
      friends: await n("SELECT COUNT(*) AS n FROM friendships WHERE accepted = 1 AND (lo = ?1 OR hi = ?1)", r.id),
      servers: { owned: [], joined: 0 }, grants,
      sessions: (await db.prepare("SELECT agent, last_used FROM sessions WHERE user_id = ? ORDER BY last_used DESC").bind(r.id).all()).results.map((s) => ({ agent: s.agent, lastUsed: s.last_used })),
      access: Object.fromEntries((await db.prepare("SELECT game, allowed FROM game_access WHERE user_id = ?").bind(r.id).all()).results.map((x) => [x.game, !!x.allowed])),
    });
  },

  async admin_suspend({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "suspend");
    const t = await targetUser(db, env, a, body.id);
    if (body.lift) { await db.prepare("UPDATE users SET suspended_until = NULL WHERE id = ?").bind(t.id).run(); await audit(db, a.u.name, "unsuspend", t.name); return json({ ok: true }); }
    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, "Choose 1 to 365 days.");
    const reason = str(body.reason, 200);
    await db.prepare("UPDATE users SET suspended_until = ?, reason = ? WHERE id = ?").bind(Date.now() + days * 86_400_000, reason || null, t.id).run();
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(t.id).run();
    await audit(db, a.u.name, "suspend", t.name, { days, reason });
    return json({ ok: true });
  },

  async admin_ban({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "ban");
    const t = await targetUser(db, env, a, body.id);
    if (body.ban === false) { await db.prepare("UPDATE users SET banned = 0, reason = NULL WHERE id = ?").bind(t.id).run(); await audit(db, a.u.name, "unban", t.name); return json({ ok: true }); }
    const reason = str(body.reason, 200);
    await db.prepare("UPDATE users SET banned = 1, reason = ? WHERE id = ?").bind(reason || null, t.id).run();
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(t.id).run();
    await audit(db, a.u.name, "ban", t.name, { reason });
    return json({ ok: true });
  },

  async admin_disable({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "disable");
    const t = await targetUser(db, env, a, body.id);
    const off = body.disabled !== false;
    await db.prepare("UPDATE users SET disabled = ? WHERE id = ?").bind(off ? 1 : 0, t.id).run();
    if (off) await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(t.id).run();
    await audit(db, a.u.name, off ? "disable" : "restore", t.name);
    return json({ ok: true });
  },

  async admin_revoke({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "revoke_sessions");
    const t = await targetUser(db, env, a, body.id);
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(t.id).run();
    await audit(db, a.u.name, "revoke_sessions", t.name);
    return json({ ok: true });
  },

  async admin_recovery({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "recovery");
    const t = await targetUser(db, env, a, body.id);
    const raw = crypto.getRandomValues(new Uint8Array(20));
    const code = [0, 1, 2, 3, 4].map((g) => [...raw.slice(g * 4, g * 4 + 4)].map((b) => ALPHA[b % ALPHA.length]).join("")).join("-");
    const expires = Date.now() + 30 * 60_000;
    await db.prepare("INSERT INTO recovery (user_id, token_hash, expires) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, expires = excluded.expires").bind(t.id, await sha256(code), expires).run();
    await audit(db, a.u.name, "recovery_code", t.name);
    return json({ code, expires });
  },

  async admin_rename({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "rename");
    const t = await targetUser(db, env, a, body.id);
    const name = str(body.name, 16);
    if (!NAME_RE.test(name)) throw new HttpError(400, "Usernames are 3-16 letters, numbers or underscores.");
    try { await db.prepare("UPDATE users SET name = ?, name_lc = ? WHERE id = ?").bind(name, name.toLowerCase(), t.id).run(); }
    catch (e) { if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, "That username is taken."); throw e; }
    await audit(db, a.u.name, "rename", t.name, { to: name });
    return json({ ok: true });
  },

  async admin_game_access({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "game_access");
    const t = await targetUser(db, env, a, body.id, { allowSelf: true });
    const g = await db.prepare("SELECT id FROM games WHERE id = ?").bind(str(body.game, 32)).first();
    if (!g) throw new HttpError(404, "No such game.");
    if (body.allowed === null) await db.prepare("DELETE FROM game_access WHERE user_id = ? AND game = ?").bind(t.id, g.id).run();
    else await db.prepare("INSERT INTO game_access (user_id, game, allowed) VALUES (?,?,?) ON CONFLICT(user_id, game) DO UPDATE SET allowed = excluded.allowed").bind(t.id, g.id, body.allowed ? 1 : 0).run();
    await audit(db, a.u.name, "game_access", t.name, { game: g.id, allowed: body.allowed });
    return json({ ok: true });
  },

  // ----- games registry -----
  async admin_games({ db, env, req }) { const a = await needAdmin(db, env, req); need(a.perms, "game_registry"); return json({ games: await allGames(db) }); },
  async admin_game_save({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "game_registry");
    const id = str(body.id, 32), name = str(body.name, 40);
    if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new HttpError(400, "The id is lowercase letters, numbers and dashes.");
    if (!name) throw new HttpError(400, "Give the game a name.");
    const path = body.path ? str(body.path, 60) : null;
    if (path && !/^\/[A-Za-z0-9_\-./]{0,59}$/.test(path)) throw new HttpError(400, "The path must start with / (like /games/my-game/).");
    const state = ["live", "soon", "hidden"].includes(body.state) ? body.state : "soon";
    const art = body.art ? str(body.art, 20) : null;
    if (art && !/^(#[0-9a-fA-F]{6}|[a-z0-9-]{1,20})$/.test(art)) throw new HttpError(400, "Art is a colour like #3366aa or a known game id.");
    const tag = body.tag ? str(body.tag, 20) : null, unlocks = Number.isFinite(body.unlocks) && body.unlocks > 0 ? Math.floor(body.unlocks) : null;
    await db.prepare(`INSERT INTO games (id, name, tagline, path, state, open_to_all, art, sort, tag, rebuild, unlocks) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, tagline=excluded.tagline, path=excluded.path, state=excluded.state, open_to_all=excluded.open_to_all, art=excluded.art, sort=excluded.sort, tag=excluded.tag, rebuild=excluded.rebuild, unlocks=excluded.unlocks`)
      .bind(id, name, str(body.tagline, 120), path, state, body.openToAll === false ? 0 : 1, art, Number.isInteger(body.sort) ? body.sort : 0, tag, body.rebuild ? 1 : 0, unlocks).run();
    await audit(db, a.u.name, "game_save", id);
    return json({ games: await allGames(db) });
  },
  async admin_game_delete({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "game_registry");
    const id = str(body.id, 32);
    await db.prepare("DELETE FROM game_access WHERE game = ?").bind(id).run();
    await db.prepare("DELETE FROM patch_notes WHERE game = ?").bind(id).run();
    await db.prepare("DELETE FROM games WHERE id = ?").bind(id).run();
    await audit(db, a.u.name, "game_delete", id);
    return json({ games: await allGames(db) });
  },

  // ----- patch notes (anyone reads; game_registry edits) -----
  async patch_notes({ db, env, req, body }) { const u = await requireUser(db, req); return json(await notesFor(db, env, u, str(body.game, 32))); },
  async patch_note_save({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "game_registry");
    const game = str(body.game, 32), build = Number(body.build), title = str(body.title, 80), text = typeof body.body === "string" ? body.body.slice(0, 4000) : "";
    if (!(await db.prepare("SELECT 1 AS x FROM games WHERE id = ?").bind(game).first())) throw new HttpError(404, "No such game.");
    if (!Number.isInteger(build) || build < 1 || !title) throw new HttpError(400, "A build number and a title are needed.");
    const reinstall = [0, 1, 2].includes(Number(body.reinstall)) ? Number(body.reinstall) : 0, released = Number.isFinite(body.released) ? Math.floor(body.released) : Date.now();
    try {
      if (Number(body.id) > 0) await db.prepare("UPDATE patch_notes SET build = ?, title = ?, body = ?, reinstall = ?, released = ? WHERE id = ? AND game = ?").bind(build, title, text, reinstall, released, Number(body.id), game).run();
      else await db.prepare("INSERT INTO patch_notes (game, build, title, body, reinstall, released) VALUES (?,?,?,?,?,?)").bind(game, build, title, text, reinstall, released).run();
    } catch (e) { if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, `Build ${build} already has notes.`); throw e; }
    await audit(db, a.u.name, "patch_note_save", game, { build });
    return json(await notesFor(db, env, a.u, game));
  },
  async patch_note_delete({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "game_registry");
    const n = await db.prepare("SELECT game FROM patch_notes WHERE id = ?").bind(Number(body.id)).first();
    if (!n) throw new HttpError(404, "No such note.");
    await db.prepare("DELETE FROM patch_notes WHERE id = ?").bind(Number(body.id)).run();
    await audit(db, a.u.name, "patch_note_delete", n.game);
    return json(await notesFor(db, env, a.u, n.game));
  },

  // ----- servers (listing arrives with the servers slice) -----
  async admin_servers({ db, env, req }) { const a = await needAdmin(db, env, req); need(a.perms, "servers"); return json({ servers: [] }); },
  async admin_server_delete() { throw new HttpError(404, "Servers aren't built yet."); },

  // ----- site settings -----
  async admin_settings({ db, env, req }) {
    const a = await needAdmin(db, env, req);
    if (!can(a.perms, "site_settings") && !can(a.perms, "banner") && !a.head) throw new HttpError(403, "You don't have permission for that.");
    const s = await siteInfo(db, env);
    return json({ banner: s.banner || "", downloads: s.downloads || "", update: s.update || "", phraseSet: s.signupOpen });
  },
  async admin_settings_save({ db, env, req, body }) {
    const a = await needAdmin(db, env, req);
    if ("banner" in body) { need(a.perms, "banner"); const b = str(body.banner, 300); await setSetting(db, "banner", b); await audit(db, a.u.name, "banner", null, { set: !!b }); }
    for (const k of ["downloads", "update"]) if (k in body) {
      need(a.perms, "site_settings");
      const v = str(body[k], 500);
      if (v && !driveUrl(v)) throw new HttpError(400, "It must be a Google Drive address (https://drive.google.com/...).");
      await setSetting(db, k, v); await audit(db, a.u.name, `${k}_link`, null, { set: !!v });
    }
    if ("phrase" in body) {
      if (!a.head) throw new HttpError(403, "Only the head admin can change the sign-up phrase.");
      const p = typeof body.phrase === "string" ? body.phrase.trim() : "";
      if (p && p.length < 6) throw new HttpError(400, "Use at least 6 characters.");
      await setSetting(db, "phrase_hash", p ? await sha256(p.toLowerCase()) : "");
      await audit(db, a.u.name, p ? "signup_phrase_set" : "signup_closed");
    }
    return json({ ok: true });
  },

  // ----- admins (head only) -----
  async admin_admins({ db, env, req }) { const a = await needAdmin(db, env, req); if (!a.head) throw new HttpError(403, "Only the head admin can manage admins."); return json(await adminsInfo(db, env)); },
  async admin_grants({ db, env, req, body }) {
    const a = await needAdmin(db, env, req);
    if (!a.head) throw new HttpError(403, "Only the head admin can manage admins.");
    const t = await db.prepare("SELECT * FROM users WHERE id = ?").bind(Number(body.id)).first();
    if (!t || isHead(env, t)) throw new HttpError(400, "You can't change that account.");
    const perms = [...new Set((Array.isArray(body.perms) ? body.perms : []).filter((p) => typeof p === "string" && p in PERM_INFO))];
    await db.prepare("DELETE FROM admin_grants WHERE user_id = ?").bind(t.id).run();
    for (const p of perms) await db.prepare("INSERT INTO admin_grants (user_id, perm) VALUES (?,?)").bind(t.id, p).run();
    await audit(db, a.u.name, "grants", t.name, { perms });
    return json(await adminsInfo(db, env));
  },

  async admin_audit({ db, env, req, body }) {
    const a = await needAdmin(db, env, req); need(a.perms, "view_audit");
    const before = Number(body.before) > 0 ? Number(body.before) : Number.MAX_SAFE_INTEGER;
    const rows = (await db.prepare("SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT 100").bind(before).all()).results;
    return json({ entries: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, target: r.target, detail: r.detail ? JSON.parse(r.detail) : null })) });
  },
};
