// Achievements: each game's own saves on this device say what the player has
// unlocked; the pages report that to the site (ach_report), which keeps the
// list and works out how rare each one is. New ones pop up, except in games
// that show their own (Minecraft's advancement toasts, Terraria's pop-ups).
// Used by the launcher and the game pages; needs core.js and ui.js first.
(() => {
  const S = globalThis.LauncherSocial;
  if (!S?.core || !S.ui) return;
  const { core } = S;
  const { h } = S.ui.helpers;
  const OWN_POPUPS = new Set(["minecraft", "terraria"]);
  const SHOW_MS = 5500;

  // ---- how an achievement looks ----
  /** Rarity tier from the share of players who have it (Steam-like wording). */
  const tier = (pct) => (pct <= 5 ? "ultra" : pct <= 15 ? "rare" : pct <= 40 ? "uncommon" : "common");
  const TIER_LABEL = { ultra: "Ultra rare", rare: "Rare", uncommon: "Uncommon", common: "Common" };
  const pctText = (pct) => `${pct < 1 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
  const TROPHY = '<svg viewBox="0 0 24 24" width="55%" height="55%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>';
  const LOCK = '<svg viewBox="0 0 24 24" width="38%" height="38%" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  /** The achievement's picture: Steam's icon where the game has one, else a badge in the game's frame style. */
  function icon(a, size, locked) {
    const box = h("div.ach-ic" + (locked ? ".locked" : "") + (a.pct != null ? ".t-" + tier(a.pct) : ""), { style: { width: size + "px", height: size + "px" } });
    const badge = () => {
      const b = h("div.ach-badge.f-" + (/^mc:(task|goal|challenge)$/.exec(a.icon || "")?.[1] || "task"));
      b.innerHTML = TROPHY;
      return b;
    };
    if (/^https:\/\//.test(a.icon || "")) {
      // A Steam icon that won't load (offline, moved) falls back to the badge.
      const img = h("img", { src: a.icon, alt: "", loading: "lazy", decoding: "async", draggable: false, referrerPolicy: "no-referrer" });
      img.addEventListener("error", () => img.replaceWith(badge()), { once: true });
      box.append(img);
    } else box.append(badge());
    if (locked) { const l = h("div.ach-lock"); l.innerHTML = LOCK; box.append(l); }
    return box;
  }

  // ---- pop-ups (bottom right, one at a time) ----
  const queue = [];
  let showing = false;
  function popup(card) {
    queue.push(card);
    if (!showing) next();
  }
  function next() {
    const card = queue.shift();
    if (!card) { showing = false; return; }
    showing = true;
    const box = document.querySelector(".ach-pops") || document.body.appendChild(h("div.ach-pops.ls-theme", { "aria-live": "polite" }));
    box.append(card);
    requestAnimationFrame(() => card.classList.add("in"));
    setTimeout(() => {
      card.classList.remove("in");
      card.classList.add("out");
      setTimeout(() => { card.remove(); next(); }, 380);
    }, SHOW_MS);
  }
  function unlockedCard(game, a) {
    return h("div.ach-pop.t-" + tier(a.pct), { role: "status" }, icon(a, 56),
      h("div.ach-pop-text", null,
        h("div.ach-pop-kicker", { text: "Achievement unlocked" }),
        h("div.ach-pop-name", { text: a.name }),
        h("div.ach-pop-sub", { text: `${TIER_LABEL[tier(a.pct)]} · ${pctText(a.pct)} of players · ${core.gameName(game)}` })));
  }
  function summaryCard(game, out) {
    const row = h("div.ach-pop-row");
    for (const a of out.fresh.slice(0, 5)) row.append(icon(a, 26));
    return h("div.ach-pop", { role: "status" }, icon({ icon: null }, 56),
      h("div.ach-pop-text", null,
        h("div.ach-pop-kicker", { text: core.gameName(game) }),
        h("div.ach-pop-name", { text: `${out.fresh.length} achievements found in your saves` }),
        h("div.ach-pop-sub", { text: `${out.mine} of ${out.total} unlocked` }), row));
  }
  /** Shows what a report unlocked: a pop-up each, or one summary for a first sync. */
  function show(game, out, { force = false } = {}) {
    if (!out?.fresh?.length || core.myStatus?.() === "dnd") return;
    if (!force && OWN_POPUPS.has(game) && !out.first) return;
    if (out.first || out.fresh.length > 3) popup(summaryCard(game, out));
    else for (const a of out.fresh) popup(unlockedCard(game, a));
  }

  // ---- reporting ----
  // What this browser already told the site, per account and game, so a save
  // read every minute only sends what's new.
  const sentKey = (game) => `ach-sent:${core.boot?.me?.id}:${game}`;
  const sentOf = (game) => { try { return new Set(JSON.parse(localStorage.getItem(sentKey(game))) || []); } catch { return new Set(); } };
  const busy = new Map();
  /** Reports unlocked ids; quiet: no pop-ups (the launcher's catch-up). */
  async function report(game, ids, { quiet = false } = {}) {
    if (!core.boot?.me || !ids?.length) return null;
    while (busy.get(game)) await busy.get(game);
    const sent = sentOf(game);
    const todo = [...new Set(ids)].filter((id) => !sent.has(id));
    if (!todo.length) return null;
    const run = core.api("ach_report", { game, ids: todo }).then((out) => {
      for (const id of todo) sent.add(id);
      try { localStorage.setItem(sentKey(game), JSON.stringify([...sent])); } catch {}
      if (!quiet) show(game, out);
      if (out.fresh.length) core.emit?.("achievements", { game, out });
      return out;
    }, () => null).finally(() => busy.delete(game));
    busy.set(game, run);
    return run;
  }

  // Unity games (Plague Inc) call this from their frame.
  const pending = new Map();
  globalThis.mcwebAchievement = (game, id) => {
    if (typeof game !== "string" || typeof id !== "string") return;
    if (!pending.has(game)) {
      pending.set(game, new Set());
      setTimeout(() => { const ids = [...pending.get(game)]; pending.delete(game); report(game, ids); }, 1500);
    }
    pending.get(game).add(id);
  };

  // ---- reading the games' saves in this browser ----
  const idb = (name) => new Promise((ok, bad) => {
    const r = indexedDB.open(name); // no version: never upgrades (or creates) the game's database
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
    r.onupgradeneeded = () => { r.transaction.abort(); };
  });
  const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  async function hasDb(name) {
    try { return !indexedDB.databases || (await indexedDB.databases()).some((d) => d.name === name); } catch { return true; }
  }
  const inflate = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());

  // Minecraft's offline UUID ("OfflinePlayer:<name>", MD5 version 3), as dev/offline-profile.js makes it.
  function md5(bytes) {
    const s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
    const padded = new Uint8Array(((bytes.length + 8) >> 6) * 64 + 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(bytes.length / 0x20000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < padded.length; off += 64) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; } else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const sum = (a + f + k[i] + view.getUint32(off + g * 4, true)) >>> 0;
        const shift = s[(i >> 4) * 4 + (i % 4)];
        a = d; d = c; c = b;
        b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((w, i) => ov.setUint32(i * 4, w, true));
    return out;
  }
  function offlineUuid(name) {
    const x = md5(new TextEncoder().encode(`OfflinePlayer:${name}`));
    x[6] = (x[6] & 0x0f) | 0x30;
    x[8] = (x[8] & 0x3f) | 0x80;
    const hex = Array.from(x, (v) => v.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * Minecraft: finished advancements of this account's player in every world
   * saved in this browser ("mcweb-worlds", one row per file; the game stores
   * them every few minutes and on Save and Quit). Recipe unlocks don't count.
   */
  async function readMinecraft() {
    const name = core.boot?.me?.name;
    if (!name || !(await hasDb("mcweb-worlds"))) return [];
    const db = await idb("mcweb-worlds");
    try {
      if (!db.objectStoreNames.contains("files")) return [];
      const file = `advancements/${offlineUuid(name)}.json`;
      const keys = await req(db.transaction("files", "readonly").objectStore("files").getAllKeys());
      const mine = keys.filter((k) => Array.isArray(k) && (k[1] === file || k[1] === "players/" + file));
      const store = db.transaction("files", "readonly").objectStore("files");
      const rows = await Promise.all(mine.map((k) => req(store.get(k))));
      const done = new Set();
      for (const row of rows) {
        let bytes = row?.data instanceof Uint8Array ? row.data : new Uint8Array(row?.data || []);
        if (row?.enc === "deflate-raw") bytes = await inflate(bytes);
        let json;
        try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { continue; }
        for (const [id, p] of Object.entries(json)) if (p?.done && !id.startsWith("minecraft:recipes/")) done.add(id);
      }
      return [...done];
    } finally { db.close(); }
  }

  // Terraria keeps achievements.dat in its save folder (OPFS saves/<account>/):
  // AES-CBC with key and IV "RELOGIC-TERRARIA", then BSON.
  function bson(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const td = new TextDecoder();
    const cstr = (at) => { let e = at; while (buf[e] !== 0) e++; return [td.decode(buf.subarray(at, e)), e + 1]; };
    const doc = (at, isArray) => {
      const end = at + dv.getInt32(at, true) - 1;
      at += 4;
      const out = isArray ? [] : {};
      while (at < end) {
        const type = buf[at++];
        let name, v;
        [name, at] = cstr(at);
        if (type === 0x01) { v = dv.getFloat64(at, true); at += 8; }
        else if (type === 0x02) { const n = dv.getInt32(at, true); v = td.decode(buf.subarray(at + 4, at + 3 + n)); at += 4 + n; }
        else if (type === 0x03 || type === 0x04) { const n = dv.getInt32(at, true); v = doc(at, type === 0x04); at += n; }
        else if (type === 0x08) v = buf[at++] !== 0;
        else if (type === 0x09 || type === 0x12) { v = Number(dv.getBigInt64(at, true)); at += 8; }
        else if (type === 0x0a) v = null;
        else if (type === 0x10) { v = dv.getInt32(at, true); at += 4; }
        else throw new Error(`BSON type ${type}`);
        if (isArray) out.push(v); else out[name] = v;
      }
      return out;
    };
    return doc(0, false);
  }
  async function readTerraria() {
    const id = core.boot?.me?.id;
    if (id == null || !navigator.storage?.getDirectory) return [];
    let bytes;
    try {
      let dir = await navigator.storage.getDirectory();
      for (const part of ["saves", String(id).replace(/[^\w-]/g, "")]) dir = await dir.getDirectoryHandle(part);
      bytes = new Uint8Array(await (await (await dir.getFileHandle("achievements.dat")).getFile()).arrayBuffer());
    } catch { return []; }
    const key = new TextEncoder().encode("RELOGIC-TERRARIA");
    const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
    const data = bson(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: key }, k, bytes)));
    return Object.entries(data).filter(([, a]) => {
      const c = Object.values(a?.Conditions || {});
      return c.length > 0 && c.every((x) => x?.Completed === true);
    }).map(([name]) => name);
  }

  const READERS = { minecraft: readMinecraft, terraria: readTerraria };
  /** Reads one game's saves and reports what's new. */
  async function sync(game, opts) {
    try { return await report(game, await READERS[game](), opts); } catch (e) { console.warn(`achievements: ${game}:`, e); return null; }
  }
  /** The launcher: catches up on every game's saves in this browser, quietly. */
  async function syncDevice() {
    const games = (core.boot?.games || []).filter((g) => g.path && READERS[g.id]).map((g) => g.id);
    return (await Promise.all(games.map((g) => sync(g, { quiet: true })))).filter(Boolean);
  }
  /** A game page: reads its saves now, every minute and when the tab is hidden. */
  function watch(game, every = 60_000) {
    const run = () => sync(game);
    setTimeout(run, 5000);
    setInterval(run, every);
    addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") run(); });
  }

  S.ach = { icon, tier, TIER_LABEL, pctText, popup, show, report, sync, syncDevice, watch, offlineUuid };
})();
