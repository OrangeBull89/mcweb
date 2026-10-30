// The launcher page: sign-in / sign-up / recovery, then a Steam-style shell
// with the game library, the social page, settings and (for admins) the
// admin dashboard. Social itself lives in /social/*.js.
(() => {
  const S = globalThis.LauncherSocial;
  const core = S.core;
  const { h, btn, avatar, STATUS_LABEL } = S.ui.helpers;
  const app = document.getElementById("app");
  const toast = (t, bad) => S.ui.toast(t, bad);
  const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

  // Old links: "/?join=..." used to open Minecraft directly.
  const qs = new URLSearchParams(location.search);
  if (qs.has("join")) { location.replace(`/games/minecraft/#join=${encodeURIComponent(qs.get("join"))}`); return; }

  let site = { downloads: null, signupOpen: false };
  let screen = "signin"; // signin | signup | recover | suspended | app
  let suspended = null;
  const socialEl = h("div.lx-social-host");
  let socialMounted = false;

  // ---- helpers ----
  const field = (label, input, hint) => h("label.ls-field", null, h("span.ls-field-label", { text: label }), input, hint ? h("span.ls-sub", { text: hint }) : null);
  async function attempt(errEl, fn) {
    errEl.textContent = "";
    try { return await fn(); } catch (e) { errEl.textContent = e.message; return undefined; }
  }
  const route = () => {
    const raw = location.hash.replace(/^#\/?/, "");
    const [page = "library", ...rest] = raw.split("/");
    return { page, rest };
  };
  const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };
  S.openSettings = () => go("#/settings/account");
  S.openProfile = (name) => go(`#/profile/${encodeURIComponent(name)}`);

  // ---- game art: the game's banner or cover picture with its official logo (or a plain colour tile); the small icon is its app icon ----
  const ART_COLOUR = { minecraft: "#3f6b34", gardendless: "#2d6496", terraria: "#4f86c9", gettingoverit: "#4f7898", plague: "#6e1420", amongus: "#c61111", btd6: "#2f7fd1", stickfight: "#14122e" };
  // Stick Fight has no separate logo (its cover carries the name).
  // Achievements are switched off in this build: set to true (and build the ach_* server routes) to bring their screens back.
  const SHOW_ACH = false;
  const ART_LOGO = Object.fromEntries(Object.keys(ART_COLOUR).filter((id) => id !== "stickfight").map((id) => [id, `/launcher/logos/${id}.png`]));
  const ART_ICON = Object.fromEntries(Object.keys(ART_COLOUR).map((id) => [id, `/launcher/logos/${id}-icon.png`]));
  // Banner (hero) and cover (capsule) pictures in /launcher/art: Steam's library
  // art for the Steam games, a view of Minecraft's title panorama. Steam's covers
  // carry the game's name already; the others get the logo on top.
  const ART_PICS = new Set(["minecraft", "terraria", "gardendless", "gettingoverit", "plague", "amongus", "btd6", "stickfight"]);
  const NAMED_COVERS = new Set(["terraria", "gardendless", "gettingoverit", "plague", "amongus", "btd6", "stickfight"]);
  // Pictures that have loaded once show at once on later renders (no fade each time the library repaints).
  const loadedPics = new Set();
  function pic(src, cls = "") {
    const img = h("img.lx-art-pic" + cls + (loadedPics.has(src) ? ".in" : ""), { src, alt: "", decoding: "async", draggable: false });
    if (!loadedPics.has(src)) img.addEventListener("load", () => { loadedPics.add(src); img.classList.add("in"); }, { once: true });
    return img;
  }
  function artFor(game, kind) {
    const box = h("div.lx-art.lx-art-" + kind);
    const art = game.art || "";
    if (kind === "icon" && ART_ICON[art]) {
      box.classList.add("lx-art-has-icon");
      box.append(h("img", { src: ART_ICON[art], alt: "", draggable: false }));
      return box;
    }
    box.style.background = ART_COLOUR[art] || (/^#[0-9a-f]{6}$/i.test(art) ? art : `hsl(${[...game.name].reduce((x, c) => (x * 31 + c.charCodeAt(0)) % 360, 7)} 35% 32%)`);
    const src = !ART_PICS.has(art) ? null : kind === "hero" || kind === "banner" ? `/launcher/art/${art}-hero.webp` : kind === "capsule" ? `/launcher/art/${art}-capsule.webp` : null;
    if (src) { box.classList.add("lx-art-has-pic"); box.append(pic(src)); }
    if (kind === "icon") box.append(h("span.lx-art-letter", { text: game.name[0] }));
    else if (kind === "banner" || (kind === "capsule" && src && NAMED_COVERS.has(art))) { /* no logo: a backdrop, or the cover has the name */ }
    else if (ART_LOGO[art]) box.append(h("img.lx-art-logo", { src: ART_LOGO[art], alt: game.name, draggable: false }));
    else box.append(h("div.lx-art-title", { text: game.name }));
    return box;
  }

  // ---- installed games: each game page keeps its install in this browser's Cache Storage ----
  // game id -> false (not installed) or the installed build (builds.js); games
  // without a check always show Play. The last answer is remembered so the
  // button doesn't flip while a slow check runs.
  const INSTALLED_KEY = "lx-installed";
  const BUILDS = globalThis.McWebBuilds;
  // Each game's file type (the tutorial lists them); these are also the games
  // whose install is checked, so a new game goes here.
  const GAME_FILE = { minecraft: ".mcweb", terraria: ".tgame", gardendless: ".exe", gettingoverit: ".goigame", plague: ".plaguegame", amongus: ".augame", stickfight: ".sfgame", btd6: ".btd6game" };
  const installed = new Map((() => { try { return Object.entries(JSON.parse(localStorage.getItem(INSTALLED_KEY)) || {}); } catch { return []; } })());
  const updateNeeded = (game) => !!game.path && !!BUILDS?.needsUpdate(game, installed.get(game.id));
  // An optional new game file (patch note "optional"): offered in blue, PLAY stays.
  const updateOffered = (game) => !!game.path && !!BUILDS?.updateAvailable?.(game, installed.get(game.id));
  /** True when every game here that needs a game file is known not to be loaded in this browser. */
  function noGamesLoaded() {
    const games = (core.boot?.games || []).filter((g) => g.path && GAME_FILE[g.id]);
    return games.length > 0 && games.every((g) => installed.get(g.id) === false);
  }
  async function checkInstalls() {
    if (!globalThis.caches || !BUILDS) return;
    const none = screen === "app" && noGamesLoaded();
    let changed = false;
    await Promise.all(Object.keys(GAME_FILE).map(async (id) => {
      const have = await BUILDS.installed(id);
      if (have !== undefined && installed.get(id) !== have) { installed.set(id, have); changed = true; }
    }));
    if (!changed) return;
    try { localStorage.setItem(INSTALLED_KEY, JSON.stringify(Object.fromEntries(installed))); } catch {}
    if (screen === "app" && noGamesLoaded() !== none && !document.activeElement?.matches?.("input, textarea, [contenteditable]")) return void render(); // the tabs move
    const lib = screen === "app" && route().page === "library" && document.querySelector(".lx-library");
    if (lib && !lib.contains(document.activeElement)) render();
  }
  const installsChecked = checkInstalls();
  addEventListener("pageshow", (e) => { if (e.persisted) checkInstalls(); });

  const bannerEl = (text) => h("div.lx-banner", { role: "status" }, h("span.lx-banner-ic", null, S.icon("megaphone", 16)), h("span.lx-banner-text", { text }));

  // ---- signed-out screens (no banner here: it's for signed-in players) ----
  function authShell(title, sub, form, foot) {
    return h("div.lx-auth", null,
      h("div.lx-auth-card", null,
        h("div.lx-brand.big", null, h("span.lx-logo", null, S.logo(32)), h("span", { text: "LAUNCHER" })),
        h("h1", { text: title }), sub ? h("p.ls-sub", { text: sub }) : null, form, foot));
  }
  function signinView() {
    const name = h("input.ls-input", { autocomplete: "username", maxLength: 16, spellcheck: false, autocapitalize: "off" });
    const pw = h("input.ls-input", { type: "password", autocomplete: "current-password", maxLength: 200 });
    const err = h("div.ls-form-err", { role: "alert" });
    const submit = btn("ls-btn.lx-big", "Sign in", () => attempt(err, async () => {
      if (!name.value.trim() || !pw.value) throw new Error("Enter your username and password.");
      submit.disabled = true;
      try {
        await core.api("login", { name: name.value.trim(), password: pw.value });
        await start();
      } finally { submit.disabled = false; }
    }));
    const form = h("form.ls-form.lx-auth-form", { onsubmit: (e) => e.preventDefault(), onkeydown: (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); submit.click(); } } },
      field("Username", name), field("Password", pw), err, submit);
    setTimeout(() => name.focus(), 0);
    return authShell("Sign in", null, form, h("div.lx-auth-foot", null,
      btn("ls-link", "Forgot your password?", () => { screen = "recover"; render(); }),
      btn("ls-link", "Create an account", () => { screen = "signup"; render(); })));
  }
  function signupView() {
    const name = h("input.ls-input", { autocomplete: "username", maxLength: 16, spellcheck: false, autocapitalize: "off" });
    const pw = h("input.ls-input", { type: "password", autocomplete: "new-password", maxLength: 200 });
    const pw2 = h("input.ls-input", { type: "password", autocomplete: "new-password", maxLength: 200 });
    const phrase = h("input.ls-input", { type: "password", autocomplete: "off", maxLength: 100 });
    const err = h("div.ls-form-err", { role: "alert" });
    const submit = btn("ls-btn.lx-big", "Create account", () => attempt(err, async () => {
      const n = name.value.trim();
      if (!NAME_RE.test(n)) throw new Error("Usernames are 3-16 letters, numbers or underscores.");
      if (pw.value.length < 6) throw new Error("Passwords need at least 6 characters.");
      if (pw.value !== pw2.value) throw new Error("The passwords don't match.");
      if (!phrase.value.trim()) throw new Error("Enter the secret phrase.");
      if (!confirm(`Create the account "${n}"?\n\nThis username is permanent and can never be changed. Make sure it isn't offensive.`)) return;
      submit.disabled = true;
      try {
        await core.api("register", { name: n, password: pw.value, phrase: phrase.value });
        await start();
        toast(`Welcome, ${n}!`);
      } finally { submit.disabled = false; }
    }));
    const form = h("form.ls-form.lx-auth-form", { onsubmit: (e) => e.preventDefault(), onkeydown: (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); submit.click(); } } },
      field("Username", name, "Permanent. It's also your in-game name. 3-16 letters, numbers or _."),
      field("Password", pw), field("Password again", pw2),
      field("Secret phrase", phrase, "Ask the person who runs this launcher for it."), err, submit);
    setTimeout(() => name.focus(), 0);
    return authShell("Create an account", site.signupOpen ? null : "Sign-up is closed right now.", form,
      h("div.lx-auth-foot", null, btn("ls-link", "Back to sign in", () => { screen = "signin"; render(); })));
  }
  function recoverView() {
    const name = h("input.ls-input", { autocomplete: "username", maxLength: 16, spellcheck: false, autocapitalize: "off" });
    const code = h("input.ls-input", { autocomplete: "one-time-code", maxLength: 40, spellcheck: false, placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX" });
    const pw = h("input.ls-input", { type: "password", autocomplete: "new-password", maxLength: 200 });
    const pw2 = h("input.ls-input", { type: "password", autocomplete: "new-password", maxLength: 200 });
    const err = h("div.ls-form-err", { role: "alert" });
    const submit = btn("ls-btn.lx-big", "Set new password", () => attempt(err, async () => {
      if (pw.value !== pw2.value) throw new Error("The passwords don't match.");
      submit.disabled = true;
      try {
        await core.api("recover", { name: name.value.trim(), token: code.value, password: pw.value });
        await start();
        toast("Password changed. You're signed in, and every other device was signed out.");
      } finally { submit.disabled = false; }
    }));
    const form = h("form.ls-form.lx-auth-form", { onsubmit: (e) => e.preventDefault(), onkeydown: (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); submit.click(); } } },
      field("Username", name), field("Recovery code", code, "An admin gives you this code. It works once and expires after 30 minutes."),
      field("New password", pw), field("New password again", pw2), err, submit);
    setTimeout(() => name.focus(), 0);
    return authShell("Reset your password", "Lost your password? Ask an admin for a recovery code, then enter it here.", form,
      h("div.lx-auth-foot", null, btn("ls-link", "Back to sign in", () => { screen = "signin"; render(); })));
  }
  function suspendedView() {
    return authShell("Account suspended", suspended?.error || "This account is suspended.", h("div.ls-form", null,
      btn("ls-btn.grey", "Sign out", async () => { await core.logout(); })), null);
  }

  // ---- signed-in shell ----
  function topbar() {
    const r = route();
    const bar = h("header.lx-top");
    const nav = h("nav.lx-nav");
    const tab = (id, label, badge) => nav.append(h("a.lx-nav-item" + (r.page === id ? ".on" : ""), { href: `#/${id}` }, label, badge ? h("span.ls-pill.inline", { text: String(badge) }) : null));
    // With no game loaded yet the tutorial comes first (and opens on its own, see start()).
    const firstTime = noGamesLoaded();
    if (firstTime) tab("tutorial", "TUTORIAL");
    tab("library", "LIBRARY");
    tab("social", "SOCIAL", core.unreadTotal());
    if (!firstTime) tab("tutorial", "TUTORIAL");
    tab("settings", "SETTINGS");
    const admin = core.boot.admin;
    if (admin === "all" || admin?.length) tab("admin", "ADMIN");
    if (core.boot.site.downloads) nav.append(h("a.lx-nav-item", { href: core.boot.site.downloads, target: "_blank", rel: "noopener noreferrer" }, "DOWNLOADS", S.icon("external", 14)));
    const me = core.data?.me || core.boot.me;
    const user = h("div.lx-user", { onclick: (e) => { e.stopPropagation(); userMenu(e.currentTarget); }, tabIndex: 0, role: "button", "aria-label": "Account menu" },
      avatar(me, 32, core.shownStatus()), h("div.lx-user-text", null, h("div.ls-name", { text: me.name }), h("div.ls-sub", { text: STATUS_LABEL[core.myStatus()] || "" })), h("span.ls-sub.lx-caret", null, S.icon("chevronDown", 16)));
    bar.append(h("a.lx-brand", { href: "#/library" }, h("span.lx-logo", null, S.logo(26)), h("span", { text: "LAUNCHER" })), nav, h("span.ls-grow"), user);
    // On a phone the tabs scroll sideways: keep the open one in view.
    setTimeout(() => {
      const on = nav.querySelector(".on");
      if (on && on.offsetLeft + on.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = on.offsetLeft + on.offsetWidth - nav.clientWidth + 8;
    }, 0);
    return bar;
  }
  function userMenu(anchor) {
    const menu = h("div.ls-menu.static");
    for (const s of ["online", "away", "dnd", "invisible"]) {
      menu.append(h("button.ls-menu-item", { type: "button", onclick: () => { pop.remove(); core.setStatus(s); } }, h("span.ls-dot.static.ls-" + s), h("span", { text: STATUS_LABEL[s] })));
    }
    menu.append(h("hr.lx-hr"),
      h("button.ls-menu-item", { type: "button", onclick: () => { pop.remove(); go(`#/profile/${encodeURIComponent(core.boot.me.name)}`); } }, S.icon("user", 18), h("span", { text: "My profile" })),
      h("button.ls-menu-item", { type: "button", onclick: () => { pop.remove(); go("#/settings/account"); } }, S.icon("settings", 18), h("span", { text: "Settings" })),
      h("button.ls-menu-item.danger", { type: "button", onclick: async () => { pop.remove(); await core.logout(); } }, S.icon("logout", 18), h("span", { text: "Sign out" })));
    document.querySelector(".ls-pop")?.remove();
    const pop = h("div.ls-pop.ls-theme", { onclick: (e) => e.stopPropagation() }, menu);
    document.body.append(pop);
    const rect = anchor.getBoundingClientRect();
    Object.assign(pop.style, { top: rect.bottom + 6 + "px", right: Math.max(8, innerWidth - rect.right) + "px" });
    const away = (e) => { if (!pop.contains(e.target)) { pop.remove(); removeEventListener("mousedown", away, true); } };
    setTimeout(() => addEventListener("mousedown", away, true), 0);
  }

  // ---- library data: play time, friends and achievements (stats.js) ----
  // Kept for a minute, so the library's repaints (it repaints on presence
  // changes) show what they have at once instead of placeholders.
  const STATS_TTL_MS = 60_000;
  const cache = new Map(); // key -> { at, data, busy }
  function cached(key, load) {
    const c = cache.get(key);
    if (c && (c.busy || Date.now() - c.at < STATS_TTL_MS)) return c.data ?? null;
    const entry = { at: c?.at || 0, data: c?.data ?? null, busy: true };
    cache.set(key, entry);
    load().then((data) => { entry.data = data; }, () => {}).finally(() => {
      entry.busy = false;
      entry.at = Date.now();
      repaintSoon();
    });
    return entry.data;
  }
  const dropCache = (prefix) => { for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k); };
  let repaintTimer = null;
  function repaintSoon() {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      const page = route().page;
      if (screen !== "app" || (page !== "library" && page !== "profile")) return;
      if (document.querySelector(".lx-content")?.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
      render();
    }, 30);
  }
  core.on("achievements", () => { dropCache("game:"); dropCache("feed"); dropCache("profile:"); });
  const playStats = () => cached("play", () => core.api("play_stats"));
  const gameStats = (id) => cached("game:" + id, () => core.api("game_stats", { game: id }));
  const feedData = () => cached("feed", () => core.api("feed"));
  const profileData = (name) => cached("profile:" + name.toLowerCase(), () => core.api("profile", { name }).catch((e) => ({ error: e.message })));

  const hours = (ms) => {
    const hrs = ms / 3_600_000;
    if (hrs >= 10) return `${Math.round(hrs).toLocaleString()} hrs`;
    if (hrs >= 0.1) return `${hrs.toFixed(1)} hrs`;
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : "under a minute";
  };

  // ---- unlock countdowns: a coming-soon game with an unlock time goes live by itself then ----
  // Counted on the server's clock (boot.now), so a wrong device clock doesn't unlock early.
  let skewBoot = null, skew = 0, unlockCheck = 0;
  const serverNow = () => {
    if (core.boot && core.boot !== skewBoot) { skewBoot = core.boot; skew = core.boot.now ? core.boot.now - Date.now() : 0; }
    return Date.now() + skew;
  };
  const pad2 = (n) => String(n).padStart(2, "0");
  // "8:38:12" (or "2d 03:10:00"); short: "8h 38m" (or "2d 3h", "4m 12s").
  const untilText = (ms, short) => {
    const s = Math.max(0, Math.ceil(ms / 1000)), d = Math.floor(s / 86400), hr = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60;
    if (short) return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m ${sec}s`;
    return d ? `${d}d ${pad2(hr)}:${pad2(m)}:${pad2(sec)}` : `${hr}:${pad2(m)}:${pad2(sec)}`;
  };
  const countdown = (sel, game, short, prefix = "") => h(`${sel}.lx-countdown`, { "data-unlocks": game.unlocks, "data-short": short ? "1" : "", "data-prefix": prefix,
    text: prefix + untilText(game.unlocks - serverNow(), short), title: `Unlocks ${new Date(game.unlocks).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` });
  setInterval(() => {
    let due = false;
    for (const el of document.querySelectorAll(".lx-countdown")) {
      const left = Number(el.dataset.unlocks) - serverNow();
      if (left <= 0) due = true;
      el.textContent = el.dataset.prefix + untilText(left, !!el.dataset.short);
    }
    // Time's up: ask the server again (every few seconds until it agrees), then say which games opened.
    if (!due || Date.now() < unlockCheck) return;
    unlockCheck = Date.now() + 5000;
    const waiting = core.boot.games.filter((g) => g.unlocks && g.unlocks <= serverNow()).map((g) => g.id);
    core.reboot().then(() => {
      for (const id of waiting) { const g = gameById(id); if (g?.path) toast(`${g.name} is unlocked. Press PLAY!`); }
    });
  }, 1000);

  const skel = (cls = "") => h("div.lx-skel" + cls);
  const gameById = (id) => core.boot.games.find((g) => g.id === id);
  const rise = (el, i = 0) => { el.classList.add("lx-rise"); el.style.setProperty("--i", i); return el; };
  const profileLink = (name, kids) => h("a.lx-plink", { href: `#/profile/${encodeURIComponent(name)}`, title: `${name}'s profile` }, kids ?? name);

  // ---- library ----
  let libQuery = "";
  function libraryView(rest) {
    const games = core.boot.games;
    const home = !rest[0] || !games.some((g) => g.id === rest[0]);
    const selectedId = home ? null : rest[0];
    const stats = playStats();
    const wrap = h("div.lx-library");
    const side = h("aside.lx-lib-side");
    const search = h("input.ls-input.lx-search", { placeholder: "Search games", value: libQuery, oninput: (e) => { libQuery = e.target.value; paintList(); } });
    const list = h("div.lx-lib-list");
    // A game's tags go on a line under its name, so the name keeps the row's width.
    const row = (g) => {
      const tags = [g.state === "soon" ? null
        : updateNeeded(g) ? h("span.lx-update-tag", { text: "UPDATE", title: "Update needed: a newer build needs a new game file" })
        : updateOffered(g) ? h("span.lx-update-tag.opt", { text: "UPDATE", title: `Optional update: ${g.optionalUpdate.title}` })
        : g.tag ? h("span.lx-test-tag", { text: g.tag.toUpperCase(), title: g.tag }) : null,
      g.rebuild ? rebuildTag("lx-test-tag") : null].filter(Boolean);
      return h("a.lx-lib-row" + (g.id === selectedId ? ".on" : "") + (!g.path ? ".dim" : installed.get(g.id) === false ? ".off" : ""), { href: `#/library/${g.id}` },
        artFor(g, "icon"),
        h("span.ls-grow.lx-lib-row-text", null, h("span.ls-ell", { text: g.name }), tags.length ? h("span.lx-lib-row-tags", null, ...tags) : null),
        g.state === "soon" ? (g.unlocks ? countdown("span.ls-sub", g, true) : h("span.ls-sub", { text: "Soon" })) : null);
    };
    const paintList = () => {
      const q = libQuery.toLowerCase();
      list.replaceChildren(h("a.lx-lib-row.lx-lib-home" + (home ? ".on" : ""), { href: "#/library" }, h("span.lx-lib-home-ic", null, S.icon("home", 18)), h("span.ls-grow", { text: "Home" })));
      const recent = q ? [] : (stats?.games || []).map((s) => gameById(s.game)).filter((g) => g?.path).slice(0, 3);
      if (recent.length) list.append(h("div.ls-sect", { text: "Recent" }), ...recent.map(row));
      const shown = games.filter((x) => x.name.toLowerCase().includes(q));
      list.append(h("div.ls-sect", { text: `Games (${shown.length})` }), ...shown.map(row));
    };
    paintList();
    side.append(search, list);
    const game = selectedId && games.find((g) => g.id === selectedId);
    const main = !game ? homeView(games, stats) : rest[1] === "achievements" ? achievementsView(game) : gameView(game, stats);
    wrap.append(side, main);
    return wrap;
  }

  // ---- library home: continue playing, every game's cover, friends playing now, friend activity ----
  function homeView(games, stats) {
    const main = h("section.lx-lib-main.lx-home");
    const played = (stats?.games || []).map((s) => ({ s, g: gameById(s.game) })).filter((x) => x.g);
    const last = played.find((x) => x.g.path);
    if (!stats) main.append(rise(skel(".lx-skel-hero")));
    else if (last) {
      const g = last.g;
      main.append(rise(h("a.lx-continue", { href: `#/library/${g.id}` }, artFor(g, "hero"),
        h("div.lx-continue-info", null,
          h("div.lx-kicker", { text: "Continue playing" }),
          h("div.lx-continue-line", { text: [last.s.ms > 0 ? `${hours(last.s.ms)} on record` : null, `last played ${core.ago(last.s.last)}`].filter(Boolean).join(" · ") })),
        // The same word as the game page's button: a game removed from this browser says INSTALL.
        installed.get(g.id) === false ? h("span.ls-btn.lx-continue-play.lx-install", null, S.icon("download", 18), "INSTALL")
          : updateNeeded(g) ? h("span.ls-btn.lx-continue-play.lx-update", null, S.icon("download", 18), "UPDATE")
          : h("span.ls-btn.green.lx-continue-play", null, S.icon("play", 18), "PLAY"))));
    }
    // Every game's cover: the ones played most recently first.
    const order = [...played.map((x) => x.g), ...games.filter((g) => !played.some((x) => x.g.id === g.id))];
    const shelf = h("div.lx-shelf");
    order.forEach((g, i) => {
      const s = played.find((x) => x.g.id === g.id)?.s;
      // The tags sit on the cover's bottom corner (clear of the title art), so the name under it has the whole width.
      const tags = [updateNeeded(g) ? h("span.lx-cap-tag.up", { text: "UPDATE" }) : updateOffered(g) ? h("span.lx-cap-tag.opt", { text: "UPDATE", title: "Optional update available" }) : null,
        g.tag ? h("span.lx-cap-tag.test", { text: g.tag.toUpperCase(), title: g.tag }) : null,
        g.rebuild ? rebuildTag("lx-cap-tag") : null].filter(Boolean);
      shelf.append(rise(h("a.lx-cap" + (!g.path ? ".dim" : ""), { href: `#/library/${g.id}` },
        h("div.lx-cap-art", null, artFor(g, "capsule"), tags.length ? h("div.lx-cap-tags", null, ...tags) : null),
        h("div.lx-cap-name", null, h("span.ls-ell", { text: g.name })),
        g.state === "soon" && g.unlocks ? countdown("div.lx-cap-sub.ls-ell", g, true, "Unlocks in ")
          : h("div.lx-cap-sub.ls-ell", { text: [g.path && installed.get(g.id) === false ? "Not installed" : null,
            s ? (s.ms > 0 ? `${hours(s.ms)} · ${core.ago(s.last)}` : `Played ${core.ago(s.last)}`) : g.state === "soon" ? "Coming soon" : !g.path ? "No access" : "Not played yet"].filter(Boolean).join(" · ") })), i + 1));
    });
    main.append(h("div.lx-shelf-head", null, h("h3", { text: played.length ? "Your games" : "Games" })), shelf);
    const cols = h("div.lx-home-cols");
    cols.append(h("div.lx-home-left", null, friendsNowCard(), progressCard(stats)), activityCard());
    main.append(cols);
    return main;
  }

  // Your own numbers across every game, and the latest things you unlocked.
  function progressCard(stats) {
    const me = core.boot.me.name;
    const p = profileData(me);
    const card = rise(h("div.lx-card.lx-progress", null, h("div.lx-card-head", null, h("h3", null, S.icon(SHOW_ACH ? "trophy" : "clock", 18), SHOW_ACH ? "Your progress" : "Your play time"), h("span.ls-grow"),
      h("a.ls-btn.small.grey", { href: `#/profile/${encodeURIComponent(me)}` }, "Profile"))), 3);
    if (!p || !stats) { card.append(skel(".lx-skel-row"), skel(".lx-skel-row")); return card; }
    if (p.error) { card.append(h("p.ls-sub.lx-empty-line", { text: p.error })); return card; }
    const total = stats.games.reduce((n, g) => n + g.ms, 0);
    const mini = (n, label) => h("div.lx-mini", null, h("b", { text: n }), h("span.ls-sub", { text: label }));
    card.append(h("div.lx-minis", null, mini(total > 0 ? hours(total) : "—", "played"), mini(String(p.games.length), p.games.length === 1 ? "game" : "games"),
      ...(SHOW_ACH ? [mini(String(p.achCount), p.achCount === 1 ? "achievement" : "achievements")] : [])));
    if (!SHOW_ACH) return card;
    if (p.recentAch.length) {
      card.append(h("div.ls-sect", { text: "Latest unlocks" }), h("div.lx-ach-row", null, ...p.recentAch.slice(0, 7).map((a) =>
        h("span.lx-ach-cell", { title: `${a.name} (${core.gameName(a.game)}) · ${S.ach.pctText(a.pct)} of players · ${core.ago(a.at)}` }, S.ach.icon(a, 38)))));
    } else card.append(h("p.ls-sub.lx-empty-line", { text: "Unlock achievements in any game and they show up here." }));
    return card;
  }

  function friendsNowCard() {
    const now = (core.data?.friends || []).filter((f) => f.game && f.status !== "offline");
    const card = rise(h("div.lx-card.lx-friends-now", null, h("h3", null, S.icon("gamepad", 18), "Friends playing now")), 2);
    if (!core.data) card.append(skel(".lx-skel-row"), skel(".lx-skel-row"));
    else if (!now.length) card.append(h("p.ls-sub.lx-empty-line", { text: "None of your friends are playing right now." }));
    for (const f of now) {
      const g = gameById(f.game);
      card.append(h("div.lx-now-row", null, profileLink(f.name, avatar(f, 36, f.status)),
        h("div.ls-grow.ls-ell", null, profileLink(f.name, h("b", { text: f.name })), h("div.ls-sub.ls-ell", { text: [S.ui.helpers.statusText(f), f.since ? S.ui.helpers.playTime(f.since) : null].filter(Boolean).join(" · ") })),
        g ? h("a.lx-now-game", { href: `#/library/${g.id}`, title: g.name }, artFor(g, "icon")) : null,
        f.worldCode && f.playingWith !== core.data.me.name && g?.path ? btn("ls-btn.small.green", "Join", () => S.ui.joinWorld(f.name, f.worldCode, f.game)) : null));
    }
    return card;
  }

  // Friend activity: achievements (a burst from old saves shows as one item) and first plays.
  function feedItem(it) {
    const g = gameById(it.game);
    const who = { name: it.who, avatar: it.avatar };
    const gameLink = g ? h("a.lx-feed-game", { href: `#/library/${g.id}` }, g.name) : h("b", { text: it.game });
    const head = [profileLink(it.who, h("b", { text: it.who })), " "];
    let body;
    if (it.kind === "play") {
      body = h("div.lx-feed-text", null, ...head, "played ", gameLink, " for the first time");
    } else if (it.list.length === 1) {
      const a = it.list[0];
      body = h("div.lx-feed-text", null, ...head, "unlocked ", h("b.lx-feed-ach", { text: a.name }), " in ", gameLink,
        h("div.ls-sub", null, a.descr ? `${a.descr} · ` : "", h("span.lx-rarity.t-" + S.ach.tier(a.pct), { text: `${S.ach.pctText(a.pct)} of players` })));
    } else {
      const strip = h("div.lx-feed-strip");
      for (const a of it.list.slice(0, 10)) strip.append(h("span", { title: `${a.name} · ${S.ach.pctText(a.pct)} of players` }, S.ach.icon(a, 30)));
      if (it.list.length > 10) strip.append(h("span.lx-feed-more", { text: `+${it.list.length - 10}` }));
      body = h("div.lx-feed-text", null, ...head, `unlocked ${it.list.length} achievements in `, gameLink, strip);
    }
    return h("div.lx-feed-item", null, profileLink(it.who, avatar(who, 36)), body,
      it.kind === "ach" && it.list.length === 1 ? S.ach.icon(it.list[0], 44) : g ? artFor(g, "icon") : null,
      h("span.lx-feed-when.ls-sub", { text: core.ago(it.at) }));
  }
  // Back-to-back unlocks by one player in one game (one play session) read as one item.
  function groupFeed(items) {
    const out = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (it.kind === "ach" && last?.kind === "ach" && last.who === it.who && last.game === it.game && last.at - it.at < 3 * 3_600_000) last.list.push(...it.list);
      else out.push(it.kind === "ach" ? { ...it, list: [...it.list] } : it);
    }
    return out;
  }
  let feedShown = 10;
  function activityCard() {
    const data = feedData();
    const card = rise(h("div.lx-card.lx-activity", null, h("h3", null, S.icon("activity", 18), "Activity")), 3);
    if (!data) for (let i = 0; i < 4; i++) card.append(skel(".lx-skel-feed"));
    else if (!data.items.length) card.append(h("p.ls-sub.lx-empty-line", { text: SHOW_ACH ? "Nothing yet. Achievements and new games from you and your friends show up here." : "Nothing yet. When you or your friends start playing a game, it shows up here." }));
    else {
      const items = groupFeed(data.items);
      for (const it of items.slice(0, feedShown)) card.append(feedItem(it));
      if (items.length > feedShown) card.append(btn("ls-btn.grey.lx-show-more", `Show more (${items.length - feedShown})`, () => { feedShown += 10; render(); }));
    }
    return card;
  }

  // ---- one game: banner, play bar with stats, achievements, friends who play ----
  function gameView(game, stats) {
    const main = h("section.lx-lib-main");
    const gs = gameStats(game.id);
    const mine = stats?.games.find((s) => s.game === game.id) || gs?.me || null;
    const locked = game.state === "soon" && !!game.unlocks;
    const hero = h("div.lx-hero", null, artFor(game, "hero"),
      locked ? h("div.lx-unlock", null, h("span.lx-unlock-label", null, S.icon("clock", 18), "This game will unlock in:"), countdown("span.lx-unlock-time", game, false)) : null);
    const needsInstall = !!game.path && installed.get(game.id) === false;
    const needsUpdate = updateNeeded(game);
    const offered = !needsUpdate && updateOffered(game);
    // UPDATE opens the game page (where the new file is loaded); UPDATE NOW opens the admins' Update link in a new tab.
    const updateUrl = needsUpdate || offered ? BUILDS.updateLink() : null;
    const play = needsInstall ? h("a.ls-btn.lx-play.lx-install", { href: game.path }, S.icon("download", 20), "INSTALL")
      : needsUpdate ? h("a.ls-btn.lx-play.lx-update", { href: game.path }, S.icon("download", 20), "UPDATE")
      : game.path ? h("a.ls-btn.green.lx-play", { href: game.path, title: game.state === "soon" ? "Admins can play before it unlocks for everyone" : null }, S.icon("play", 20), game.state === "soon" ? "PLAY EARLY" : "PLAY")
      : locked ? h("span.ls-btn.grey.lx-play", { "aria-disabled": "true" }, S.icon("lock", 20), "LOCKED")
      : h("span.ls-btn.grey.lx-play", { "aria-disabled": "true" }, game.state === "soon" ? "COMING SOON" : "NO ACCESS");
    const friendsHere = (core.data?.friends || []).filter((f) => f.game === game.id && f.status !== "offline");
    const ach = gs?.achievements || null;
    const got = ach ? ach.filter((a) => a.at).length : 0;
    const stat = (label, value, extra) => h("div.lx-pstat", null, h("div.lx-pstat-label", { text: label }), h("div.lx-pstat-value", null, value), extra);
    const statsRow = h("div.lx-pstats", null,
      stat("Last played", mine?.last ? core.ago(mine.last) : stats ? "Never" : skel(".lx-skel-text")),
      stat("Play time", mine?.ms > 0 ? hours(mine.ms) : stats ? "—" : skel(".lx-skel-text")),
      ach?.length ? stat("Achievements", `${got}/${ach.length}`, h("div.lx-bar", null, h("span", { style: { width: `${(got / ach.length) * 100}%` } }))) : !gs ? stat("Achievements", skel(".lx-skel-text")) : null);
    const bar = h("div.lx-playbar", null, play, h("div.lx-playbar-info", null,
      h("div.ls-name", null, game.name, game.tag ? h("span.lx-tag", { text: game.tag }) : null, game.rebuild ? rebuildTag("lx-tag") : null),
      needsUpdate ? (updateUrl
        ? h("div.lx-update-line", null, h("a.lx-update-now", { href: updateUrl, target: "_blank", rel: "noopener noreferrer" }, "UPDATE NOW ↗"), ` build ${game.gameFileBuild} needs a new game file`)
        : h("a.lx-update-line", { href: game.path }, h("b", { text: "Update needed" }), ` · build ${game.gameFileBuild} needs a new game file`))
      : offered ? (updateUrl
        ? h("div.lx-update-line.opt", null, h("a.lx-update-now", { href: updateUrl, target: "_blank", rel: "noopener noreferrer" }, "GET UPDATE ↗"), ` optional · build ${game.optionalUpdate.build}: ${game.optionalUpdate.title}`)
        : h("a.lx-update-line.opt", { href: game.path }, h("b", { text: "Update available" }), ` · optional · build ${game.optionalUpdate.build}: ${game.optionalUpdate.title}`)) : null,
      locked ? h("div.ls-sub", null, game.path ? "Unlocks for everyone in " : "Unlocks in ", countdown("b", game, false), ` · ${new Date(game.unlocks).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, game.path ? " · you can play early as an admin" : null)
      : h("div.ls-sub", { text: needsInstall ? "Not installed on this device yet"
        : needsUpdate ? (updateUrl ? "Get the new file with UPDATE NOW, then press UPDATE and load it on the game page; your saves stay" : "Load it on the game page; your saves stay")
        : game.path ? (game.state === "soon" ? "Not released yet · you can play early as an admin" : "Opens in this tab") : game.state === "soon" ? "Not released yet" : "Ask an admin for access" },
        (needsInstall || needsUpdate) && GAME_FILE[game.id] ? [" · ", h("a.lx-tut-link", { href: "#/tutorial", text: "How do I load the game file?" })] : null)),
      statsRow,
      h("span.ls-grow"),
      friendsHere.length ? h("div.lx-playbar-friends", null, h("div.ls-sub", { text: `${friendsHere.length} friend${friendsHere.length > 1 ? "s" : ""} playing` }),
        h("div.lx-face-row", null, ...friendsHere.slice(0, 6).map((f) => profileLink(f.name, avatar(f, 28, f.status))))) : null);
    const about = h("div.lx-about", null);
    if (ach?.length || !gs) about.append(rise(achievementsCard(game, ach), 1));
    about.append(rise(h("div.lx-card", null, h("h3", { text: `About ${game.name}` }), h("p", { text: game.tagline || "" }), game.rebuild ? rebuildNote() : null, ...aboutText(game)), 2));
    about.append(rise(patchNotes(game), 3));
    const right = h("div.lx-lib-right", null, rise(friendsWhoPlay(game, gs), 2));
    main.append(...[hero, game.id === "minecraft" ? endBanner() : null, bar, h("div.lx-lib-cols", null, about, right)].filter(Boolean));
    return main;
  }
  // The MC-Web Server's End stays locked until the owner opens it for the
  // dragon fight (server/mcserver.js); the open notice shows for 3 days.
  // Same text as the Minecraft game page (dev/mc-social.js paintEnd).
  function endBanner() {
    const end = core.boot?.site?.mcEnd;
    if (!end || (end.open && !(end.since && (core.boot.now || Date.now()) - end.since < 3 * 86_400_000))) return null;
    return h("div.lx-banner.lx-end-banner" + (end.open ? ".open" : ""), { role: "status" }, h("span.lx-banner-ic", null, S.icon(end.open ? "unlock" : "lock", 16)),
      h("span.lx-banner-text", { text: end.open ? "The End is open on the MC-Web Server. Go fight the Ender Dragon!"
        : "The End is locked on the MC-Web Server. The Ender Dragon fight is a server event: the End opens when as many people as possible are online." }));
  }
  // A rebuild (Admin > Game library): the original can't be converted for the
  // browser, so its code was written again; the art and sounds are still the
  // player's own copy.
  function rebuildTag(cls) {
    return h(`span.${cls}.rebuild`, { text: cls === "lx-tag" ? "Rebuild" : "REBUILD",
      title: "Rebuild: the original game's code can't run in a browser, so it was written again from scratch to play the same way. The art, maps and sounds come from your own copy." });
  }
  function rebuildNote() {
    return h("div.lx-rebuild-note", null, h("span.lx-rebuild-ic", null, S.icon("tool", 18)), h("div", null,
      h("b", { text: "This game is a rebuild" }),
      h("p", { text: "The original game's code can't be converted to run in a browser, so it was written again from scratch to play the same way. The art, maps and sounds still come from your own copy of the game, and a few small details may feel slightly different from the original." })));
  }
  function aboutText(game) {
    const p = (text) => h("p.ls-sub", { text });
    const dis = (text) => h("p.lx-disclaimer", { text });
    switch (game.id) {
      case "minecraft": return [p("Minecraft runs from your own game file, which stays on this device. Load it once on the game page; your worlds are saved in this browser. Press your social hotkey in game to chat, call and invite friends. Your advancements count as achievements here."),
        dis("NOT AN OFFICIAL MINECRAFT PRODUCT OR SERVICE. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.")];
      case "gardendless": return [p("Gardendless runs from your own copy: load the Windows download (pvzge-<version>.exe) once on the game page and it is unpacked into this browser. It works on Chromebooks too, since the file is only read, never run. Each account on this device keeps its own save."),
        dis("PVZ2 GARDENDLESS IS A FAN GAME BY ITS OWN DEVELOPERS. NOT AFFILIATED WITH OR APPROVED BY ELECTRONIC ARTS OR POPCAP GAMES.")];
      case "terraria": return [p("Terraria runs from your own game file: build it on a Windows PC from your Steam copy (tools\\terraria\\build.ps1 in MC-Web), then load it once on the game page. Characters and worlds are saved in this browser, separately for each account. Host & Play gives a world code friends can join with."),
        dis("NOT AN OFFICIAL TERRARIA PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH RE-LOGIC.")];
      case "gettingoverit": return [p("Getting Over It runs from your own game file: build it on a Windows PC from your Steam copy (tools\\gettingoverit\\build.ps1 in MC-Web), then load it once on the game page. Your climb is saved in this browser, separately for each account. Reach the top and your time goes on the fastest-climbs board under your username."),
        dis("NOT AN OFFICIAL GETTING OVER IT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH BENNETT FODDY.")];
      case "plague": return [p("Plague Inc: Evolved runs from your own game file: build it on a Windows PC from your Steam copy (tools\\plague\\build.ps1 in MC-Web), then load it once on the game page. Your games are saved in this browser, separately for each account. Single player only for now; expansions you don't own on Steam stay locked."),
        dis("NOT AN OFFICIAL PLAGUE INC PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH NDEMIC CREATIONS.")];
      case "amongus": return [p("Among Us is rebuilt for the browser and uses the art, maps and sounds from your own game file: build it on a Windows PC from your Steam copy (tools\\amongus\\build.ps1 in MC-Web), then load it once on the game page. Play The Skeld with 4 to 15 friends: one hosts and the others join with the invite code. Only the free hats, visors and skins are there."),
        dis("NOT AN OFFICIAL AMONG US PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH INNERSLOTH.")];
      default: return [];
    }
  }

  // Achievements on a game's page: progress, the latest unlocks, the next few to get.
  function achievementsCard(game, ach) {
    const card = h("div.lx-card.lx-ach-card");
    const head = h("div.lx-card-head", null, h("h3", null, S.icon("trophy", 18), "Achievements"), h("span.ls-grow"));
    card.append(head);
    if (!ach) { card.append(skel(".lx-skel-bar"), h("div.lx-ach-row", null, ...Array.from({ length: 8 }, () => skel(".lx-skel-ic")))); return card; }
    const got = ach.filter((a) => a.at).sort((a, b) => b.at - a.at);
    head.append(h("a.ls-btn.small.grey", { href: `#/library/${game.id}/achievements` }, "View all"));
    card.append(h("div.lx-ach-progress", null, h("span", null, h("b", { text: `${got.length} of ${ach.length}` }), ` unlocked (${Math.round((got.length / ach.length) * 100)}%)`),
      h("div.lx-bar.big", null, h("span", { style: { width: `${(got.length / ach.length) * 100}%` } }))));
    const tip = (a, locked) => (locked && a.hidden ? "Hidden achievement" : `${a.name}: ${a.descr}`) + ` · ${S.ach.pctText(a.pct)} of players`;
    if (got.length) {
      card.append(h("div.ls-sect", { text: "Latest" }), h("div.lx-ach-row", null, ...got.slice(0, 10).map((a) => h("span.lx-ach-cell", { title: tip(a) }, S.ach.icon(a, 46)))));
    }
    const next = ach.filter((a) => !a.at).sort((a, b) => b.pct - a.pct).slice(0, 10);
    if (next.length) card.append(h("div.ls-sect", { text: "Locked · most players have these" }), h("div.lx-ach-row", null, ...next.map((a) => h("span.lx-ach-cell", { title: tip(a, true) }, S.ach.icon(a, 46, true)))));
    return card;
  }

  // Every achievement of a game, Steam-style: unlocked first, then by rarity.
  let achFilter = "all";
  let achQuery = "";
  function achievementsView(game) {
    const main = h("section.lx-lib-main");
    const gs = gameStats(game.id);
    main.append(h("div.lx-hero.lx-hero-slim", null, artFor(game, "banner")));
    const pane = h("div.lx-ach-page");
    main.append(pane);
    pane.append(h("a.lx-back", { href: `#/library/${game.id}` }, S.icon("chevronLeft", 16), game.name));
    if (!gs) { pane.append(skel(".lx-skel-bar"), ...Array.from({ length: 6 }, () => skel(".lx-skel-feed"))); return main; }
    const ach = gs.achievements;
    const got = ach.filter((a) => a.at);
    pane.append(h("div.lx-ach-top", null, artFor(game, "icon"), h("div.ls-grow", null,
      h("h2", { text: "Achievements" }),
      h("div.ls-sub", { text: `${got.length} of ${ach.length} unlocked · rarity is the share of the ${gs.players} player${gs.players === 1 ? "" : "s"} here who have each one` }),
      h("div.lx-bar.big", null, h("span", { style: { width: `${ach.length ? (got.length / ach.length) * 100 : 0}%` } })))));
    const counts = { all: ach.length, got: got.length, locked: ach.length - got.length };
    const seg = h("div.ls-seg", null, ...[["all", "All"], ["got", "Unlocked"], ["locked", "Locked"]].map(([k, l]) =>
      btn("ls-seg-btn" + (achFilter === k ? ".on" : ""), [l, h("span.lx-seg-n", { text: String(counts[k]) })], () => { achFilter = k; render(); })));
    // Typing filters the list in place (a full repaint would take the focus away).
    const search = h("input.ls-input.lx-ach-search", { type: "search", placeholder: "Search achievements", value: achQuery, oninput: (e) => { achQuery = e.target.value; paint(false); } });
    pane.append(h("div.lx-ach-tools", null, seg, h("span.ls-grow"), search));
    const list = h("div.lx-ach-list");
    pane.append(list);
    const item = (a, i, animate) => {
      const hide = !a.at && a.hidden;
      const t = S.ach.tier(a.pct);
      const el = h("div.lx-ach-item" + (a.at ? ".got" : ""), null, S.ach.icon(a, 56, !a.at),
        h("div.ls-grow", null, h("div.lx-ach-name", { text: hide ? "Hidden achievement" : a.name }), h("div.ls-sub", { text: hide ? "Keep playing to find out." : a.descr }),
          a.at ? h("div.lx-ach-when", { text: `Unlocked ${new Date(a.at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` }) : null),
        h("div.lx-ach-rarity.t-" + t, null, h("div.lx-rarity.t-" + t, { text: `${S.ach.pctText(a.pct)}` }), h("div.lx-bar.thin", null, h("span", { style: { width: `${Math.max(2, a.pct)}%` } })),
          h("div.ls-sub", { text: S.ach.TIER_LABEL[t] })));
      return animate ? rise(el, Math.min(i, 12)) : el;
    };
    // Unlocked (newest first), then locked (the ones most players have first).
    const paint = (animate) => {
      const q = achQuery.trim().toLowerCase();
      const match = (a) => !q || (!(a.hidden && !a.at) && `${a.name} ${a.descr || ""}`.toLowerCase().includes(q));
      list.replaceChildren();
      let i = 0;
      const section = (title, items) => {
        if (!items.length) return;
        list.append(h("div.lx-ach-sect", null, h("span", { text: title }), h("span.lx-seg-n", { text: String(items.length) })));
        for (const a of items) list.append(item(a, i++, animate));
      };
      if (achFilter !== "locked") section("Unlocked", got.filter(match).sort((a, b) => b.at - a.at));
      if (achFilter !== "got") section("Locked", ach.filter((a) => !a.at && match(a)).sort((a, b) => b.pct - a.pct));
      if (!list.children.length) list.append(h("p.ls-sub.lx-empty-line", { text: q ? `No achievements match "${achQuery.trim()}".` : achFilter === "got" ? "None unlocked yet." : "You've unlocked every one." }));
    };
    paint(true);
    return main;
  }

  // Friends who've launched this game before; the ones playing now first.
  function friendsWhoPlay(game, gs) {
    const card = h("div.lx-card.lx-friend-activity", null, h("h3", null, S.icon("users", 18), "Friends who play"));
    if (!gs) { card.append(skel(".lx-skel-row"), skel(".lx-skel-row"), skel(".lx-skel-row")); return card; }
    const live = new Map((core.data?.friends || []).map((f) => [f.name, f]));
    const rows = gs.friends.map((f) => ({ ...f, ...(live.get(f.name) || {}) }))
      .sort((a, b) => ((b.game === game.id && b.status !== "offline") - (a.game === game.id && a.status !== "offline")) || b.played - a.played);
    if (!rows.length) card.append(h("p.ls-sub.lx-empty-line", { text: `None of your friends have played ${game.name} yet.` }));
    const nowCount = rows.filter((f) => f.game === game.id && f.status !== "offline").length;
    if (rows.length) card.append(h("div.ls-sub.lx-fwp-sum", { text: `${rows.length} friend${rows.length === 1 ? "" : "s"} ${rows.length === 1 ? "has" : "have"} played${nowCount ? ` · ${nowCount} playing now` : ""}` }));
    for (const f of rows) {
      const now = f.game === game.id && f.status !== "offline";
      card.append(h("div.ls-friend-row.lx-fwp" + (now ? ".now" : ""), null, profileLink(f.name, avatar(f, 34, f.status)),
        h("div.ls-grow.ls-ell", null, profileLink(f.name, h("b", { text: f.name })),
          h("div.ls-sub.ls-ell", { text: now ? S.ui.helpers.statusText(f) : `Last played ${core.ago(f.played)}` })),
        now && f.worldCode && game.path ? btn("ls-btn.small.green", "Join", () => S.ui.joinWorld(f.name, f.worldCode, game.id))
          : f.ms > 0 ? h("div.lx-fwp-hrs", null, h("b", { text: hours(f.ms) }), h("span.ls-sub", { text: "on record" })) : null));
    }
    return card;
  }

  // ---- profiles: Steam-style, for anyone you share a server with (everyone's in the General Server) ----
  function profileView(rest) {
    const name = decodeURIComponent(rest[0] || core.boot.me.name);
    const isMe = name.toLowerCase() === core.boot.me.name.toLowerCase();
    const p = profileData(name);
    const page = h("div.lx-profile-page");
    if (p?.error) { page.append(h("div.lx-profile-wrap", null, h("div.lx-card", null, h("h2", { text: name }), h("p.ls-sub", { text: p.error })))); return page; }
    const friend = (core.data?.friends || []).find((f) => f.name.toLowerCase() === name.toLowerCase());
    const who = isMe ? { ...(core.data?.me || core.boot.me), status: core.shownStatus() } : { ...(p || { name }), ...(friend || {}) };
    const top = p?.games?.find((g) => gameById(g.game)) || null;
    const topGame = top && gameById(top.game);
    const banner = h("div.lx-profile-banner", null, topGame ? artFor(topGame, "banner") : h("div.lx-profile-banner-plain", { style: { background: `linear-gradient(135deg, hsl(${[...name].reduce((x, c) => (x * 31 + c.charCodeAt(0)) % 360, 7)} 40% 26%), var(--ls-bg))` } }));
    page.append(banner);
    const wrap = h("div.lx-profile-wrap");
    page.append(wrap);
    const actions = h("div.lx-profile-actions");
    if (!isMe && p) {
      actions.append(btn("ls-btn", [S.icon("chat", 16), "Message"], () => { go(`#/social/dm/${encodeURIComponent(name)}`); }));
      if (who.worldCode && who.playingWith !== core.boot.me.name) actions.append(btn("ls-btn.green", "Join game", () => S.ui.joinWorld(name, who.worldCode, who.game || "minecraft")));
      if (!friend && !core.data?.outgoing?.some((r) => r.name === name)) actions.append(btn("ls-btn.grey", [S.icon("userPlus", 16), "Add friend"], () => core.run("request", { name }).then(() => toast(`Friend request sent to ${name}.`)).catch((e) => toast(e.message, true))));
    } else if (isMe) actions.append(h("a.ls-btn.grey", { href: "#/settings/account" }, S.icon("edit", 16), "Edit profile"));
    const playingGame = who.game && who.status !== "offline" ? gameById(who.game) : null;
    wrap.append(rise(h("div.lx-profile-head", null, h("div.lx-profile-av", null, avatar(who, 132, who.status)),
      h("div.ls-grow.lx-profile-id", null,
        h("h1", { text: who.name || name }),
        h("div.lx-profile-status" + (playingGame ? ".playing" : ""), null, playingGame ? artFor(playingGame, "icon") : null, h("span", { text: who.status ? S.ui.helpers.statusText(who) : "" })),
        p ? h("div.ls-sub", { text: [`Member since ${new Date(p.joined).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`, p.since ? `friends since ${new Date(p.since).toLocaleDateString()}` : null].filter(Boolean).join(" · ") }) : skel(".lx-skel-text")),
      actions)));
    if (!p) { wrap.append(h("div.lx-profile-cols", null, h("div", null, skel(".lx-skel-hero"), skel(".lx-skel-feed"), skel(".lx-skel-feed")), h("div", null, skel(".lx-skel-row"), skel(".lx-skel-row")))); return page; }
    const total = p.games.reduce((n, g) => n + g.ms, 0);
    const tile = (n, label, icon, cls = "") => h("div.lx-ptile" + cls, null, h("div.lx-ptile-ic", null, S.icon(icon, 16)), h("div.lx-ptile-n", { text: n }), h("div.ls-sub", { text: label }));
    const left = h("div.lx-profile-main");
    const right = h("div.lx-profile-side");
    wrap.append(h("div.lx-profile-cols", null, left, right));
    left.append(rise(h("div.lx-ptiles", null, tile(String(p.games.length), p.games.length === 1 ? "game played" : "games played", "gamepad"), tile(total > 0 ? hours(total) : "—", "played here", "clock"),
      ...(SHOW_ACH ? [tile(String(p.achCount), p.achCount === 1 ? "achievement" : "achievements", "trophy"),
        tile(p.rarest[0] ? S.ach.pctText(p.rarest[0].pct) : "—", "rarest unlock", "activity", p.rarest[0] ? ".t-" + S.ach.tier(p.rarest[0].pct) : "")] : [])), 1));
    // Their most played game, big, at the top of the side column.
    const fav = p.games.filter((g) => gameById(g.game) && g.ms > 0).sort((a, b) => b.ms - a.ms)[0];
    if (fav) {
      const fg = gameById(fav.game);
      right.append(rise(h("a.lx-card.lx-fav", { href: `#/library/${fg.id}` }, h("h3", null, S.icon("gamepad", 18), "Most played"),
        h("div.lx-fav-art", null, artFor(fg, "banner"), h("img.lx-pgame-logo", { src: ART_LOGO[fg.art] || ART_ICON[fg.art] || "", alt: fg.name })),
        h("div.lx-fav-line", null, h("b", { text: fg.name }), h("span.ls-sub", { text: hours(fav.ms) })),
        fav.achTotal ? h("div.lx-pgame-ach", null, h("span.ls-sub", { text: `Achievements ${fav.ach}/${fav.achTotal}` }), h("div.lx-bar", null, h("span", { style: { width: `${(fav.ach / fav.achTotal) * 100}%` } }))) : null), 1));
    }
    if (p.rarest.length) {
      left.append(rise(h("div.lx-card.lx-showcase", null, h("h3", null, S.icon("trophy", 18), "Rarest achievements"),
        h("div.lx-showcase-row", null, ...p.rarest.map((a) => h("div.lx-showcase-item", { title: `${a.name}: ${a.descr}` }, S.ach.icon(a, 72),
          h("div.lx-showcase-name.ls-ell", { text: a.name }), h("div.lx-rarity.t-" + S.ach.tier(a.pct), { text: `${S.ach.pctText(a.pct)} · ${core.gameName(a.game)}` }))))), 2));
    }
    const games = h("div.lx-card", null, h("h3", null, S.icon("gamepad", 18), "Recent activity"));
    if (!p.games.length) games.append(h("p.ls-sub.lx-empty-line", { text: isMe ? "Play a game and it shows up here." : `${name} hasn't played anything here yet.` }));
    for (const g of p.games) {
      const game = gameById(g.game);
      if (!game) continue;
      games.append(h("a.lx-pgame", { href: `#/library/${game.id}` }, h("div.lx-pgame-art", null, artFor(game, "banner"), h("img.lx-pgame-logo", { src: ART_LOGO[game.art] || ART_ICON[game.art] || "", alt: game.name })),
        h("div.ls-grow", null, h("div.lx-pgame-name", { text: game.name }),
          h("div.ls-sub", { text: [g.ms > 0 ? `${hours(g.ms)} on record` : null, `last played ${core.ago(g.last)}`].filter(Boolean).join(" · ") }),
          g.achTotal ? h("div.lx-pgame-ach", null, h("span.ls-sub", { text: `Achievements ${g.ach}/${g.achTotal}` }), h("div.lx-bar", null, h("span", { style: { width: `${(g.ach / g.achTotal) * 100}%` } }))) : null)));
    }
    left.append(rise(games, 3));
    if (p.recentAch.length) {
      const recent = h("div.lx-card", null, h("h3", null, S.icon("clock", 18), "Recent achievements"));
      for (const a of p.recentAch) recent.append(h("div.lx-ach-item.got.small", null, S.ach.icon(a, 44), h("div.ls-grow", null, h("div.lx-ach-name", { text: a.name }), h("div.ls-sub", { text: `${core.gameName(a.game)} · ${a.descr}` })),
        h("div.lx-ach-rarity", null, h("div.lx-rarity.t-" + S.ach.tier(a.pct), { text: S.ach.pctText(a.pct) }), h("div.ls-sub", { text: core.ago(a.at) }))));
      left.append(rise(recent, 4));
    }
    if (!isMe && p.together?.length) {
      const t = h("div.lx-card", null, h("h3", null, S.icon("globe", 18), "Played together"));
      for (const w of p.together.slice(0, 6)) t.append(h("div.lx-side-line", null, h("b", { text: w.world || core.gameName(w.game) }), h("div.ls-sub", { text: `${core.gameName(w.game)} · ${w.host === core.boot.me.name ? "your world" : `${w.host}'s world`} · ${core.ago(w.last)}` })));
      right.append(rise(t, 2));
    }
    const people = isMe ? (core.data?.friends || []).map((f) => f.name) : p.mutual;
    const pc = h("div.lx-card", null, h("h3", null, S.icon("users", 18), isMe ? `Friends · ${people.length}` : `Mutual friends · ${people.length}`));
    if (!people.length) pc.append(h("p.ls-sub.lx-empty-line", { text: isMe ? "Add friends from the Social tab." : "No mutual friends." }));
    const faces = h("div.lx-face-grid");
    for (const n of people.slice(0, 24)) {
      const f = (core.data?.friends || []).find((x) => x.name === n) || { name: n };
      faces.append(profileLink(n, h("div.lx-face", null, avatar(f, 40, f.status), h("span.ls-ell", { text: n }))));
    }
    pc.append(faces);
    right.append(rise(pc, 3));
    if (!isMe && p.mutualServers?.length) right.append(rise(h("div.lx-card", null, h("h3", null, S.icon("chat", 18), "Servers in common"), ...p.mutualServers.map((s) => h("div.lx-side-line", { text: s }))), 4));
    return page;
  }

  // ---- patch notes: one entry per game build, newest first; admins write them here ----
  // The library re-renders on every presence change, so notes are cached for
  // a few minutes and which entries are open survives a re-render.
  const NOTES_TTL_MS = 5 * 60_000;
  const notesCache = new Map(); // game id -> { notes, canEdit, at }
  const notesOpen = new Set();
  const notesShowAll = new Set();
  const isoDate = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function patchNotes(game) {
    const box = h("div.lx-notes");
    const paint = (data) => {
      box.replaceChildren(h("div.lx-notes-head", null, h("h3", { text: "Patch notes" }), h("span.ls-grow"),
        data?.canEdit ? btn("ls-btn.small", [S.icon("plus", 16), "Add"], () => editNote(game, null, data, paint)) : null));
      if (!data) return void box.append(h("p.ls-sub", { text: "Loading…" }));
      if (!data.notes.length) return void box.append(h("p.ls-sub", { text: "No patch notes yet." }));
      if (!data.notes.some((n) => notesOpen.has(n.id))) notesOpen.add(data.notes[0].id);
      const shown = notesShowAll.has(game.id) ? data.notes : data.notes.slice(0, 5);
      for (const n of shown) box.append(noteRow(game, n, data, paint));
      if (data.notes.length > shown.length) {
        box.append(btn("ls-btn.small.grey.lx-notes-more", `Show all ${data.notes.length}`, () => { notesShowAll.add(game.id); paint(data); }));
      }
    };
    const cached = notesCache.get(game.id);
    paint(cached || null);
    if (!cached || Date.now() - cached.at > NOTES_TTL_MS) {
      core.api("patch_notes", { game: game.id }).then((data) => {
        notesCache.set(game.id, { ...data, at: Date.now() });
        paint(notesCache.get(game.id));
      }, (e) => box.append(h("p.ls-sub", { text: e.message })));
    }
    return box;
  }
  function noteRow(game, n, data, paint) {
    const body = h("div.lx-note-body");
    let bullets = null;
    for (const raw of n.body.split("\n")) {
      const line = raw.trim();
      if (!line) { bullets = null; continue; }
      if (/^[-*•]\s+/.test(line)) {
        if (!bullets) body.append(bullets = h("ul"));
        bullets.append(h("li", { text: line.replace(/^[-*•]\s+/, "") }));
      } else {
        bullets = null;
        body.append(h("p", { text: line }));
      }
    }
    if (data.canEdit) body.append(h("div.lx-note-actions", null, btn("ls-btn.small.grey", "Edit", () => editNote(game, n, data, paint))));
    const when = new Date(n.released).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    return h("details.lx-note", { open: notesOpen.has(n.id), ontoggle: (e) => { if (e.target.open) notesOpen.add(n.id); else notesOpen.delete(n.id); } },
      h("summary", null, h("span.lx-note-build", { text: `Build ${n.build}` }), h("span.ls-grow.ls-ell.lx-note-title", { text: n.title }),
        n.reinstall === 2 ? h("span.lx-note-tag.opt", { text: "Optional update", title: "A new game file you can load if you want this build; the old one keeps working" })
          : n.reinstall ? h("span.lx-note-tag", { text: "New game file", title: "Players load a new game file for this build" }) : null, h("span.ls-sub", { text: when })),
      body);
  }
  function editNote(game, n, data, paint) {
    const build = h("input.ls-input", { type: "number", min: 1, value: n ? n.build : (data.notes[0]?.build || 0) + 1 });
    const title = h("input.ls-input", { value: n?.title || "", maxLength: 80, placeholder: "What's new" });
    const released = h("input.ls-input", { type: "date", value: isoDate(n?.released || Date.now()) });
    const body = h("textarea.ls-input.lx-note-edit", { value: n?.body || "", maxLength: 4000, rows: 10, placeholder: "- One change per line" });
    // patch_notes.reinstall: 0 none, 1 required (Update Needed), 2 optional (Update available).
    const reinstall = h("select.ls-input", null, ...[[0, "No new game file"], [1, "New game file, required: older ones see Update Needed"], [2, "New game file, optional: older ones see Update available"]]
      .map(([v, l]) => h("option", { value: String(v), text: l, selected: (n?.reinstall || 0) === v })));
    const err = h("div.ls-form-err");
    // Re-render rather than repaint: the box this opened from may have been
    // replaced by a presence re-render since.
    const done = (out, close) => {
      notesCache.set(game.id, { ...out, at: Date.now() });
      close();
      if (route().page === "library") render();
      else paint(notesCache.get(game.id));
    };
    S.manage.modal(n ? `${game.name}: build ${n.build}` : `${game.name}: new patch notes`, h("div.ls-form", null,
      field("Build", build, "The game's build number. One entry per build."), field("Title", title), field("Released", released),
      field("What changed", body, "Plain text. Start a line with - to make it a bullet."),
      field("Game file", reinstall), err), {
      actions: (close) => [
        n ? btn("ls-btn.red", "Delete", () => {
          if (confirm(`Delete the patch notes for build ${n.build}?`)) attempt(err, async () => done(await core.api("patch_note_delete", { id: n.id }), close));
        }) : null,
        btn("ls-btn.grey", "Cancel", close),
        btn("ls-btn", "Save", () => attempt(err, async () => done(await core.api("patch_note_save", {
          game: game.id, id: n?.id || 0, build: Number(build.value), title: title.value, body: body.value, reinstall: Number(reinstall.value),
          released: released.value ? new Date(`${released.value}T12:00:00`).getTime() : Date.now(),
        }), close))),
      ].filter(Boolean),
    });
  }

  // ---- tutorial: what to do with a game file (one guide for every game) ----
  // Players kept double-clicking their game files. Nothing on a computer opens
  // them: each one is picked with LOAD GAME FILE on its game page. The
  // screenshots are of this site's own pages (web/launcher/tutorial/, published
  // by tools/stage-site.mjs); [width, height] keeps the page from jumping as they load.
  const SHOTS = { downloads: [834, 58], library: [1000, 333], load: [848, 221], loading: [848, 372], play: [848, 173], update: [1000, 407] };
  function tutorialView() {
    const key = (label) => h("span.lx-tut-key" + (label.startsWith("PLAY") ? ".go" : label.startsWith("UPDATE") ? ".up" : label === "INSTALL" ? ".in" : ""), { text: label });
    const shot = (name, alt) => {
      if (!SHOTS[name]) return null;
      const [width, height] = SHOTS[name];
      return h("figure.lx-tut-shot", null, h("img", { src: `/launcher/tutorial/${name}.webp`, alt, width, height, loading: "lazy", decoding: "async", draggable: false }));
    };
    const games = core.boot.games.filter((g) => GAME_FILE[g.id]);
    const downloads = !!core.boot.site.downloads;
    const steps = [
      ["Get the game file", downloads
        ? ["Download it from ", key("DOWNLOADS"), " at the top of the launcher, or from wherever the game's page says. Leave it in your Downloads folder."]
        : ["The game's page says where to get it. Leave it in your Downloads folder."], downloads ? "downloads" : null],
      ["Open the game in your library", ["Go to ", key("LIBRARY"), ", pick the game and click ", key("INSTALL"), "."], "library"],
      ["Load the file", ["On the game's page, click ", key("LOAD GAME FILE"), ". A file window opens: go to ", h("b", { text: "Downloads" }), ", pick the file and click ", h("b", { text: "Open" }), "."], "load"],
      ["Wait for it to finish", ["The bar fills while the game is copied into this browser. It can take a few minutes. Keep the tab open until it's done."], "loading"],
      ["Play", ["Click the big green ", key("PLAY"), " button. Next time you only need this step."], "play"],
    ];
    const pane = h("section.lx-pane.lx-tut",
      null,
      h("h2", { text: "How to load a game" }),
      h("p.ls-sub.lx-tut-lead", { text: "Every game here runs in your browser from a game file. You load the file on this site once, then play." }),
      h("div.lx-tut-warn", { role: "note" }, h("span.lx-tut-warn-ic", null, S.icon("ban", 28)), h("div", null,
        h("div.lx-tut-warn-title", { text: "Don't open the game file on your computer" }),
        h("p", { text: "Double-clicking it won't start the game, and on a Chromebook it won't open at all. That goes for an .exe too: don't run it. Load it on this site instead, like this:" }))),
      games.length ? h("div.lx-tut-files", null, ...games.map((g) => h("div.lx-tut-file", null, artFor(g, "icon"),
        h("div", null, h("div.lx-tut-file-ext", { text: GAME_FILE[g.id] }), h("div.ls-sub", { text: g.name }))))) : null,
      h("ol.lx-tut-steps", null, ...steps.map(([title, text, name], i) => h("li.lx-tut-step", null,
        h("span.lx-tut-n" + (i === steps.length - 1 ? ".go" : ""), { text: String(i + 1) }),
        h("div.lx-tut-body", null, h("h3", { text: title }), h("p", null, text), shot(name, title))))),
      h("div.lx-tut-more", null,
        h("h3", { text: "Good to know" }),
        h("ul", null,
          h("li", { text: "You do this once on each device, and in each browser you play in." }),
          h("li", { text: "Your saves stay in this browser, under your account." }),
          h("li", { text: "Use Chrome or Edge, and not a private (incognito) window." })),
        h("h3", { text: "When the library says UPDATE" }),
        h("p", null, "A yellow ", key("UPDATE"), " button means the game needs a newer game file. Get the new file with ", key("UPDATE NOW"), " beside it, then click ", key("UPDATE"), " to open the game's page and load it the same way. Your saves stay."),
        shot("update", "The UPDATE button")));
    return h("div.lx-tut-page", null, pane);
  }


  // ---- social ----
  function socialView(rest) {
    if (!socialMounted) { S.ui.mount(socialEl, { mode: "page" }); socialMounted = true; }
    if (rest[0] === "dm" && rest[1]) S.ui.openDm(decodeURIComponent(rest[1]));
    setTimeout(() => S.ui.render(), 0);
    return socialEl;
  }

  // ---- settings ----
  const SETTINGS = [["account", "My Account"], ["devices", "Devices"], ["appearance", "Appearance"], ["notifications", "Notifications"], ["voice", "Voice"], ["games", "In-game"], ["privacy", "Privacy"]];
  function settingsView(rest) {
    const sec = SETTINGS.some(([id]) => id === rest[0]) ? rest[0] : "account";
    const nav = h("nav.lx-sub-nav", null, h("div.ls-sect", { text: "User settings" }),
      ...SETTINGS.map(([id, label]) => h("a.ls-side-row" + (sec === id ? ".on" : ""), { href: `#/settings/${id}` }, label)),
      h("div.lx-hr"), h("button.ls-side-row.danger", { type: "button", onclick: () => core.logout() }, "Sign out"));
    const pane = h("section.lx-pane");
    ({ account: accountSettings, devices: deviceSettings, appearance: appearanceSettings, notifications: notifySettings, voice: voiceSettings, games: gameSettings, privacy: privacySettings })[sec](pane);
    return h("div.lx-split", null, nav, pane);
  }
  const toggle = (key, label, hint, onBefore) => h("label.ls-perm", null, h("div.ls-grow", null, h("div", { text: label }), hint ? h("div.ls-sub", { text: hint }) : null),
    h("input.ls-switch", { type: "checkbox", checked: !!core.pref(key), onchange: async (e) => {
      const want = e.target.checked;
      if (onBefore && !(await onBefore(want))) { e.target.checked = !want; return; }
      core.setPrefs({ [key]: want }).catch((x) => toast(x.message, true));
    } }));

  function accountSettings(pane) {
    const me = core.data?.me || core.boot.me;
    const err = h("div.ls-form-err");
    pane.append(h("h2", { text: "My Account" }),
      h("div.lx-account-card", null, avatar(me, 88, core.shownStatus()), h("div.ls-grow", null,
        h("div.lx-account-name", { text: me.name }), h("div.ls-sub", { text: `Member since ${new Date(me.created).toLocaleDateString()} · usernames can't be changed` }),
        h("div.ls-row-gap", { style: { marginTop: "10px" } },
          btn("ls-btn.small", "Change picture", () => S.ui.pickFile("image/*", async (file) => {
            try {
              const bmp = await createImageBitmap(file);
              const side = Math.min(bmp.width, bmp.height);
              const canvas = h("canvas", { width: 256, height: 256 });
              canvas.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
              let url = canvas.toDataURL("image/webp", 0.85);
              if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", 0.85);
              await core.run("avatar", { avatar: url });
              await core.reboot();
              render();
            } catch (e) { toast(e.message || "That picture couldn't be read.", true); }
          })),
          me.avatar ? btn("ls-btn.small.grey", "Remove picture", async () => { await core.run("avatar", { avatar: null }); await core.reboot(); render(); }) : null))));
    const old = h("input.ls-input", { type: "password", autocomplete: "current-password" });
    const pw = h("input.ls-input", { type: "password", autocomplete: "new-password" });
    const pw2 = h("input.ls-input", { type: "password", autocomplete: "new-password" });
    pane.append(h("h3", { text: "Change password" }), h("div.lx-narrow.ls-form.lx-flush", null, field("Current password", old), field("New password", pw), field("New password again", pw2), err,
      btn("ls-btn", "Change password", () => attempt(err, async () => {
        if (pw.value !== pw2.value) throw new Error("The new passwords don't match.");
        await core.api("password", { old: old.value, password: pw.value });
        old.value = pw.value = pw2.value = "";
        toast("Password changed. Your other devices were signed out.");
      }))));
  }
  async function deviceSettings(pane) {
    pane.append(h("h2", { text: "Devices" }), h("p.ls-sub", { text: "Browsers signed in to your account. Sign out any you don't recognise, then change your password." }));
    const list = h("div", null, h("div.ls-sub", { text: "Loading…" }));
    pane.append(list);
    const paint = (out) => {
      list.replaceChildren();
      for (const s of out.sessions) {
        list.append(h("div.ls-friend-row", null, h("div.lx-device-ic", null, S.icon(/Android|iOS/.test(s.agent) ? "phoneDevice" : "monitor", 20)),
          h("div.ls-grow", null, h("b", { text: s.agent }), s.current ? h("span.lx-tag", { text: "This device" }) : null,
            h("div.ls-sub", { text: `Signed in ${new Date(s.created).toLocaleDateString()} · last active ${core.ago(s.lastUsed)}` })),
          s.current ? null : btn("ls-btn.small.grey", "Sign out", async () => paint(await core.api("session_revoke", { id: s.id })))));
      }
      if (out.sessions.length > 1) list.append(btn("ls-btn.red.small", "Sign out all other devices", async () => { if (confirm("Sign out every other device?")) paint(await core.api("session_revoke", { all: true })); }));
    };
    try { paint(await core.api("sessions")); } catch (e) { list.replaceChildren(h("div.ls-form-err", { text: e.message })); }
  }
  function appearanceSettings(pane) {
    pane.append(h("h2", { text: "Appearance" }), h("div.ls-sect", { text: "Theme" }),
      h("div.ls-seg", null, ...[["dark", "Dark"], ["light", "Light"], ["system", "Match device"]].map(([k, l]) =>
        btn("ls-seg-btn" + (core.pref("theme") === k ? ".on" : ""), l, () => core.setPrefs({ theme: k }).then(render)))));
  }
  function notifySettings(pane) {
    const desktopOk = async (want) => {
      if (!want) return true;
      if (!("Notification" in globalThis)) { toast("This browser can't show desktop notifications.", true); return false; }
      if (Notification.permission === "granted") return true;
      const p = await Notification.requestPermission();
      if (p !== "granted") toast("Notifications are blocked for this site in the browser.", true);
      return p === "granted";
    };
    pane.append(h("h2", { text: "Notifications" }),
      toggle("sounds", "Sounds", "Short sounds for messages, mentions and voice."),
      toggle("dmToasts", "Pop-ups for direct and group messages"),
      toggle("mentionsOnly", "Only pop up for @mentions"),
      toggle("desktop", "Desktop notifications", "When this tab is in the background.", desktopOk),
      h("p.ls-sub", { text: "Do Not Disturb (from your status) hides all pop-ups." }));
  }
  function voiceSettings(pane) {
    pane.append(h("h2", { text: "Voice" }),
      h("p.ls-sub", { text: "Voice chat connects you straight to the other people in the call (peer-to-peer). Nothing is recorded or stored. Some networks block this, and then calls can't connect." }),
      toggle("ptt", "Push to talk", "Only send your voice while you hold a key."));
    if (core.pref("ptt")) pane.append(btn("ls-btn.grey", S.binding === "pttKey" ? "Press a key… (Esc cancels)" : `Talk key: ${core.keyLabel(core.pref("pttKey"))} · change`, () => S.manage.bindKey("pttKey", render)));
    const meter = h("div.lx-meter", null, h("span"));
    let stream = null;
    let timer = null;
    const test = btn("ls-btn.grey", "Test microphone", async () => {
      if (stream) { stop(); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const ctx = new AudioContext();
        const a = ctx.createAnalyser();
        ctx.createMediaStreamSource(stream).connect(a);
        const buf = new Uint8Array(512);
        test.textContent = "Stop test";
        timer = setInterval(() => {
          if (!meter.isConnected) { stop(); return; }
          a.getByteTimeDomainData(buf);
          let sum = 0;
          for (const b of buf) sum += ((b - 128) / 128) ** 2;
          meter.firstChild.style.width = Math.min(100, Math.sqrt(sum / buf.length) * 400) + "%";
        }, 80);
      } catch { toast("Couldn't open the microphone. Check the browser's site settings.", true); }
    });
    const stop = () => { clearInterval(timer); for (const t of stream?.getTracks() || []) t.stop(); stream = null; test.textContent = "Test microphone"; meter.firstChild.style.width = "0"; };
    pane.append(h("h3", { text: "Microphone" }), h("div.ls-row-gap", null, test, meter));
  }
  function gameSettings(pane) {
    pane.append(h("h2", { text: "In-game" }),
      h("p.ls-sub", { text: "In a game, the social hotkey opens chat, friends and voice on top of the game." }),
      btn("ls-btn.grey", S.binding === "hotkey" ? "Press a key… (Esc cancels)" : `Social hotkey: ${core.keyLabel(core.pref("hotkey"))} · change`, () => S.manage.bindKey("hotkey", render)),
      h("h3", { text: "Auto-away" }), h("p.ls-sub", { text: "After this long without touching anything, you show as Away. Friends can still join your game." }),
      h("div.ls-seg", null, ...[5, 10, 15, 30, 0].map((m) => btn("ls-seg-btn" + (core.pref("afk") === m ? ".on" : ""), m ? `${m} min` : "Off", () => core.setPrefs({ afk: m }).then(render)))));
  }
  function privacySettings(pane) {
    const d = core.data;
    pane.append(h("h2", { text: "Privacy" }),
      h("p.ls-sub", { text: "Blocked people can't find you, send you requests or message you, and their messages in servers are hidden for you." }),
      h("div.ls-sect", { text: `Blocked — ${d?.blocked.length || 0}` }));
    for (const n of d?.blocked || []) pane.append(h("div.ls-friend-row", null, avatar({ name: n }, 32), h("b.ls-grow", { text: n }), btn("ls-btn.small.grey", "Unblock", async () => { await core.run("unblock", { name: n }); render(); })));
    pane.append(h("p.ls-sub", { text: "Direct messages: friends and people who share a server with you can message you." }));
  }

  // ---- admin ----
  const ADMIN = [["overview", "Overview"], ["accounts", "Accounts"], ["games", "Game library"], ["servers", "Servers"], ["site", "Site"], ["admins", "Admins"], ["audit", "Audit log"]];
  let adminInfo = null;
  function adminView(rest) {
    const sec = ADMIN.some(([id]) => id === rest[0]) ? rest[0] : "overview";
    const pane = h("section.lx-pane");
    const nav = h("nav.lx-sub-nav", null, h("div.ls-sect", { text: "Admin" }));
    const paintNav = () => {
      nav.replaceChildren(h("div.ls-sect", { text: core.boot.head ? "Admin · head admin" : "Admin" }));
      const can = (p) => adminInfo?.head || adminInfo?.perms.includes(p);
      const shown = { overview: true, accounts: can("view_accounts"), games: can("game_registry"), servers: can("servers"), site: adminInfo?.head || can("site_settings") || can("banner"), admins: adminInfo?.head, audit: can("view_audit") };
      for (const [id, label] of ADMIN) if (shown[id]) nav.append(h("a.ls-side-row" + (sec === id ? ".on" : ""), { href: `#/admin/${id}` }, label));
    };
    const load = async () => {
      try {
        adminInfo = await core.api("admin_overview");
        paintNav();
        pane.replaceChildren();
        ({ overview: adminOverview, accounts: adminAccounts, games: adminGames, servers: adminServers, site: adminSite, admins: adminAdmins, audit: adminAudit })[sec](pane, rest.slice(1));
      } catch (e) { pane.replaceChildren(h("div.ls-form-err", { text: e.message })); }
    };
    pane.append(h("div.ls-sub", { text: "Loading…" }));
    load();
    return h("div.lx-split", null, nav, pane);
  }
  const can = (p) => adminInfo?.head || adminInfo?.perms.includes(p);
  function adminOverview(pane) {
    const c = adminInfo.counts;
    const stat = (n, label) => h("div.lx-stat", null, h("div.lx-stat-n", { text: String(n) }), h("div.ls-sub", { text: label }));
    pane.append(h("h2", { text: "Overview" }), h("div.lx-stats", null, stat(c.users, "accounts"), stat(c.online, "online now"), stat(c.servers, "servers"), stat(c.sessions, "signed-in devices")),
      h("h3", { text: adminInfo.head ? "You are the head admin" : "Your admin permissions" }),
      adminInfo.head ? h("p.ls-sub", { text: "You have every permission, and only you can manage admins, the banner and the sign-up phrase. Nobody can act on your account from here." }) : null,
      h("ul.lx-perm-list", null, ...adminInfo.perms.map((p) => h("li", { text: adminInfo.permInfo[p] || p }))),
      h("p.ls-sub", { text: "Admins never see anyone's messages." }));
  }
  async function adminAccounts(pane, rest) {
    const q = h("input.ls-input.lx-search", { placeholder: "Search usernames" });
    const list = h("div.lx-table");
    const detail = h("div.lx-detail");
    pane.append(h("h2", { text: "Accounts" }), h("div.lx-admin-cols", null, h("div.ls-grow", null, q, list), detail));
    let selected = Number(rest[0]) || null;
    const fill = async () => {
      try {
        const out = await core.api("admin_users", { q: q.value.trim() });
        list.replaceChildren();
        for (const u of out.users) {
          const flags = [u.admin === "head" ? "Head admin" : u.admin ? "Admin" : null, u.banned ? "Banned" : null, u.disabled ? "Disabled" : null, u.suspendedUntil ? "Suspended" : null].filter(Boolean);
          const row = h("div.lx-trow.ls-click" + (selected === u.id ? ".on" : ""), { onclick: () => {
            selected = u.id;
            history.replaceState(null, "", `#/admin/accounts/${u.id}`);
            for (const r of list.children) r.classList.toggle("on", r === row);
            showUser(u.id, true);
          } },
            avatar(u, 28, u.online ? "online" : "offline"), h("div.ls-grow", null, h("b", { text: u.name }), h("div.ls-sub", { text: `#${u.id} · joined ${new Date(u.created).toLocaleDateString()} · last seen ${core.ago(u.lastSeen)}` })),
            ...flags.map((f) => h("span.lx-tag" + (/Ban|Disab|Susp/.test(f) ? ".bad" : ""), { text: f })));
          list.append(row);
        }
        if (!out.users.length) list.append(h("div.ls-sub", { text: "No accounts match." }));
      } catch (e) { list.replaceChildren(h("div.ls-form-err", { text: e.message })); }
    };
    let t;
    q.oninput = () => { clearTimeout(t); t = setTimeout(fill, 250); };
    const showUser = async (id, reveal) => {
      detail.replaceChildren(h("div.ls-sub", { text: "Loading…" }));
      let out;
      try { out = await core.api("admin_user", { id }); } catch (e) { detail.replaceChildren(h("div.ls-form-err", { text: e.message })); return; }
      const u = out.user;
      const err = h("div.ls-form-err");
      const act = (label, cls, fn) => btn("ls-btn.small" + cls, label, () => attempt(err, async () => { await fn(); await fill(); await showUser(id); }));
      const protectedAcct = u.admin === "head" || u.id === core.boot.me.id || (u.admin && !adminInfo.head);
      detail.replaceChildren(h("div.lx-detail-head", null, avatar(u, 56, u.online ? "online" : "offline"), h("div", null, h("h3", { text: u.name }),
        h("div.ls-sub", { text: `Account #${u.id} · joined ${new Date(u.created).toLocaleString()}` }))));
      const facts = [
        ["Status", u.banned ? `Banned${u.reason ? ` (${u.reason})` : ""}` : u.disabled ? "Disabled" : u.suspendedUntil ? `Suspended until ${new Date(u.suspendedUntil).toLocaleString()}${u.reason ? ` (${u.reason})` : ""}` : "Active"],
        ["Last seen", u.online ? "Online now" : core.ago(u.lastSeen)],
        ["Friends", String(out.friends)],
        ["Servers", `owns ${out.servers.owned.map((s) => s.name).join(", ") || "none"} · in ${out.servers.joined}`],
        ["Admin", u.admin === "head" ? "Head admin" : out.grants.length ? out.grants.join(", ") : "No"],
      ];
      detail.append(h("dl.lx-facts", null, ...facts.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])));
      detail.append(h("div.ls-sect", { text: `Signed-in devices — ${out.sessions.length}` }));
      for (const s of out.sessions) detail.append(h("div.ls-sub", { text: `${s.agent} · last active ${core.ago(s.lastUsed)}` }));
      if (protectedAcct) {
        detail.append(h("p.ls-sub", { text: u.admin === "head" ? "Nobody can change the head admin's account here." : u.id === core.boot.me.id ? "This is you. Use your own settings." : "Only the head admin can act on another admin." }));
      } else {
        const tools = h("div.lx-tools");
        if (can("suspend")) {
          if (u.suspendedUntil) tools.append(act("Lift suspension", ".grey", () => core.api("admin_suspend", { id, lift: true })));
          else tools.append(btn("ls-btn.small.grey", "Suspend…", () => {
            const days = prompt(`Suspend ${u.name} for how many days? (1-365)`, "1");
            if (!days) return;
            const reason = prompt("Reason (optional, shown to them):", "") ?? "";
            attempt(err, async () => { await core.api("admin_suspend", { id, days: Number(days), reason }); await fill(); await showUser(id); });
          }));
        }
        if (can("ban")) {
          tools.append(u.banned ? act("Unban", ".grey", () => core.api("admin_ban", { id, ban: false }))
            : btn("ls-btn.small.red", "Ban…", () => {
              const reason = prompt(`Ban ${u.name}? They're signed out everywhere. Reason (optional, shown to them):`, "");
              if (reason === null) return;
              attempt(err, async () => { await core.api("admin_ban", { id, reason }); await fill(); await showUser(id); });
            }));
        }
        if (can("revoke_sessions") && out.sessions.length) tools.append(act("Sign out everywhere", ".grey", () => core.api("admin_revoke", { id })));
        if (can("recovery")) {
          tools.append(btn("ls-btn.small.grey", "Make recovery code", () => attempt(err, async () => {
            if (!confirm(`Make a password recovery code for ${u.name}? Give it to them privately; it works once for 30 minutes.`)) return;
            const r = await core.api("admin_recovery", { id });
            S.manage.modal("Recovery code", h("div.ls-form", null,
              h("p", { text: `Give this code to ${u.name} privately. They enter it at "Forgot your password?" on the sign-in page with a new password.` }),
              h("div.lx-code", { text: r.code }),
              h("p.ls-sub", { text: `Works once. Expires at ${new Date(r.expires).toLocaleTimeString()}. It won't be shown again.` })));
          })));
        }
        if (can("rename")) {
          tools.append(btn("ls-btn.small.grey", "Rename…", () => {
            const name = prompt(`New username for ${u.name}. Their worlds saved in a browser stay under the old name until they import them.`, u.name);
            if (!name || name === u.name) return;
            attempt(err, async () => { await core.api("admin_rename", { id, name }); await fill(); await showUser(id); });
          }));
        }
        if (can("disable")) {
          tools.append(u.disabled ? act("Restore account", ".grey", () => core.api("admin_disable", { id, disabled: false }))
            : btn("ls-btn.small.red", "Disable", () => { if (confirm(`Disable ${u.name}? They can't sign in until restored. Nothing is deleted.`)) attempt(err, async () => { await core.api("admin_disable", { id }); await fill(); await showUser(id); }); }));
        }
        detail.append(h("div.ls-sect", { text: "Actions" }), tools);
      }
      if (can("game_access") && u.admin !== "head") {
        detail.append(h("div.ls-sect", { text: "Game access" }));
        for (const g of core.boot.games) {
          const state = out.access[g.id];
          const sel = h("select.ls-input.lx-inline-select", { onchange: () => attempt(err, async () => {
            await core.api("admin_game_access", { id, game: g.id, allowed: sel.value === "default" ? null : sel.value === "yes" });
            toast("Game access saved.");
          }) }, h("option", { value: "default", text: "Default", selected: state === undefined }), h("option", { value: "yes", text: "Allowed", selected: state === true }), h("option", { value: "no", text: "Blocked", selected: state === false }));
          detail.append(h("div.ls-row-gap", null, h("span.ls-grow", { text: g.name }), sel));
        }
      }
      detail.append(err);
      if (reveal && matchMedia("(max-width: 900px)").matches) detail.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    await fill();
    if (rest[0]) showUser(Number(rest[0]));
    else detail.append(h("div.ls-sub", { text: "Pick an account to see details." }));
  }
  async function adminGames(pane) {
    pane.append(h("h2", { text: "Game library" }), h("p.ls-sub", { text: "Games appear in everyone's library. 'Coming soon' shows a card without a Play button (with an unlock time, a countdown, and it goes live by itself then); 'Hidden' takes it out of libraries. A launch path must be a page on this site under /games/." }));
    const list = h("div");
    const err = h("div.ls-form-err");
    pane.append(list, err);
    const paint = (games) => {
      list.replaceChildren(btn("ls-btn.small", [S.icon("plus", 16), "Add a game"], () => editGame({ id: "", name: "", tagline: "", path: "", state: "soon", open_to_all: 1, sort: games.length }, true)));
      for (const g of games) {
        list.append(h("div.lx-trow", null, artFor({ ...g, art: g.art }, "icon"), h("div.ls-grow", null, h("b", null, g.name, g.tag ? h("span.lx-tag", { text: g.tag }) : null, g.rebuild ? rebuildTag("lx-tag") : null), h("div.ls-sub", { text: `${g.id} · ${g.state}${g.state === "soon" && g.unlocks ? ` · unlocks ${new Date(g.unlocks).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}${g.path ? " · " + g.path : ""} · ${g.open_to_all ? "everyone" : "only allowed accounts"}` })),
          btn("ls-btn.small.grey", "Edit", () => editGame(g, false))));
      }
    };
    const editGame = (g, isNew) => {
      const id = h("input.ls-input", { value: g.id, disabled: !isNew, maxLength: 32, placeholder: "my-game" });
      const name = h("input.ls-input", { value: g.name, maxLength: 40 });
      const tagline = h("input.ls-input", { value: g.tagline || "", maxLength: 120 });
      const path = h("input.ls-input", { value: g.path || "", maxLength: 60, placeholder: "/games/my-game/" });
      const state = h("select.ls-input", null, ...[["live", "Live"], ["soon", "Coming soon"], ["hidden", "Hidden"]].map(([v, l]) => h("option", { value: v, text: l, selected: g.state === v })));
      const open = h("input", { type: "checkbox", checked: !!g.open_to_all });
      const art = h("input.ls-input", { value: g.art || "", maxLength: 20, placeholder: "#3366aa (or minecraft)" });
      const sort = h("input.ls-input", { type: "number", value: g.sort || 0 });
      // A few common tags to pick from; any short text works.
      const tag = h("input.ls-input", { value: g.tag || "", maxLength: 20, placeholder: "No tag", list: "lx-tag-ideas" });
      const ideas = h("datalist", { id: "lx-tag-ideas" }, ...["Testing", "New", "Beta", "Updated", "Broken"].map((t) => h("option", { value: t })));
      const tagRow = h("div.ls-row-gap", null, h("div.ls-grow", null, tag), btn("ls-btn.small.grey", "Remove tag", () => { tag.value = ""; tag.focus(); }));
      const rebuild = h("input", { type: "checkbox", checked: !!g.rebuild });
      // In this browser's time zone; empty = an admin sets it live by hand.
      const local = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
      const unlocks = h("input.ls-input", { type: "datetime-local", value: g.unlocks ? local(g.unlocks) : "" });
      const unlockRow = h("div.ls-row-gap", null, h("div.ls-grow", null, unlocks), btn("ls-btn.small.grey", "Clear", () => { unlocks.value = ""; }));
      const e2 = h("div.ls-form-err");
      S.manage.modal(isNew ? "Add a game" : `Edit ${g.name}`, h("div.ls-form", null, field("Id", id, "Lowercase letters, numbers and dashes. Can't change later."), field("Name", name), field("Tagline", tagline),
        field("Tag", tagRow, "Shown beside the game's name in everyone's library, like TESTING. Leave it empty for no tag."), ideas,
        h("label.ls-check", null, rebuild, h("span", { text: "Rebuild: the game's code was written again from scratch (shows a REBUILD tag and a short note on its page)" })),
        field("State", state), field("Unlocks at", unlockRow, "Coming soon only: the library counts down to this time, then the game goes live by itself. Needs a launch path."), field("Launch path", path), h("label.ls-check", null, open, h("span", { text: "Everyone can play (otherwise only accounts allowed under Accounts)" })),
        field("Art colour", art), field("Order", sort), e2), {
        actions: (close) => [
          isNew ? null : btn("ls-btn.red", "Delete", () => { if (confirm(`Remove ${g.name} from the library?`)) attempt(e2, async () => { paint((await core.api("admin_game_delete", { id: g.id })).games); close(); core.reboot(); }); }),
          btn("ls-btn.grey", "Cancel", close),
          btn("ls-btn", "Save", () => attempt(e2, async () => {
            const out = await core.api("admin_game_save", { id: id.value.trim(), name: name.value, tagline: tagline.value, path: path.value.trim() || null, state: state.value, openToAll: open.checked, art: art.value.trim() || null, sort: Number(sort.value) || 0, tag: tag.value.trim() || null, rebuild: rebuild.checked, unlocks: unlocks.value ? new Date(unlocks.value).getTime() : null });
            paint(out.games);
            close();
            core.reboot();
          })),
        ].filter(Boolean),
      });
    };
    try { paint((await core.api("admin_games")).games); } catch (e) { err.textContent = e.message; }
  }
  async function adminServers(pane) {
    pane.append(h("h2", { text: "Servers" }), h("p.ls-sub", { text: "Admins see server names and member counts only, never messages." }));
    const list = h("div");
    pane.append(list);
    const paint = (servers) => {
      list.replaceChildren();
      if (!servers.length) list.append(h("div.ls-sub", { text: "No servers yet." }));
      for (const s of servers) {
        list.append(h("div.lx-trow", null, h("div.ls-grow", null, h("b", { text: s.name }), h("div.ls-sub", { text: `Owner ${s.owner || "?"} · ${s.members} members · made ${new Date(s.created).toLocaleDateString()}` })),
          btn("ls-btn.small.red", "Delete", async () => {
            if (prompt(`Delete ${s.name} for everyone? Type DELETE to confirm.`) !== "DELETE") return;
            try { await core.api("admin_server_delete", { id: s.id }); paint((await core.api("admin_servers")).servers); } catch (e) { toast(e.message, true); }
          })));
      }
    };
    try { paint((await core.api("admin_servers")).servers); } catch (e) { list.append(h("div.ls-form-err", { text: e.message })); }
  }
  async function adminSite(pane) {
    let s;
    try { s = await core.api("admin_settings"); } catch (e) { pane.append(h("div.ls-form-err", { text: e.message })); return; }
    pane.append(h("h2", { text: "Site" }));
    const err = h("div.ls-form-err");
    if (can("banner")) {
      const previewText = h("span.lx-banner-text");
      const preview = h("div.lx-banner.lx-banner-preview", { role: "status" }, h("span.lx-banner-ic", null, S.icon("megaphone", 16)), previewText);
      const paintPreview = () => { previewText.textContent = banner.value.trim() || "No banner is showing."; preview.classList.toggle("off", !banner.value.trim()); };
      const banner = h("textarea.ls-input", { value: s.banner, maxLength: 300, rows: 2, placeholder: "e.g. New update: voice channels are here!", oninput: () => paintPreview() });
      paintPreview();
      pane.append(h("h3", { text: "Announcement banner" }), h("p.ls-sub", { text: "Shown across the top of the launcher and game pages for everyone signed in (not on the sign-in page). Nobody can close it. Leave it empty to hide it." }),
        h("div.ls-sect", { text: "Preview" }), preview, banner, h("div.ls-row-gap", null, btn("ls-btn", "Save banner", () => attempt(err, async () => { await core.api("admin_settings_save", { banner: banner.value }); toast("Banner saved."); core.reboot(); })),
          btn("ls-btn.grey", "Clear", () => attempt(err, async () => { banner.value = ""; await core.api("admin_settings_save", { banner: "" }); toast("Banner removed."); paintPreview(); core.reboot(); }))));
    }
    if (adminInfo.head) {
      const phrase = h("input.ls-input", { type: "password", maxLength: 100, autocomplete: "off", placeholder: s.phraseSet ? "A phrase is set (hidden). Type a new one to replace it." : "No phrase: sign-up is closed" });
      pane.append(h("h3", { text: "Sign-up secret phrase" }),
        h("p.ls-sub", { text: `${s.phraseSet ? "Sign-up is open to anyone who knows the phrase." : "Sign-up is closed."} The phrase is stored hashed, so it can't be shown again; letters' case doesn't matter. New accounts never get admin rights.` }),
        phrase, h("div.ls-row-gap", null, btn("ls-btn", "Set phrase", () => attempt(err, async () => {
          if (phrase.value.trim().length < 6) throw new Error("Use at least 6 characters.");
          await core.api("admin_settings_save", { phrase: phrase.value }); phrase.value = ""; toast("Sign-up phrase set."); pane.replaceChildren(); adminSite(pane);
        })), s.phraseSet ? btn("ls-btn.red", "Close sign-up", () => attempt(err, async () => { await core.api("admin_settings_save", { phrase: "" }); toast("Sign-up closed."); pane.replaceChildren(); adminSite(pane); })) : null));
    }
    if (can("site_settings")) {
      const dl = h("input.ls-input", { value: s.downloads, maxLength: 500, placeholder: "https://drive.google.com/..." });
      pane.append(h("h3", { text: "Downloads link" }), h("p.ls-sub", { text: "Shows a DOWNLOADS link in the top bar. It must be a Google Drive address. Leave it empty to hide the link." }),
        dl, btn("ls-btn", "Save link", () => attempt(err, async () => { await core.api("admin_settings_save", { downloads: dl.value.trim() }); toast("Downloads link saved."); core.reboot(); })));
      const up = h("input.ls-input", { value: s.update, maxLength: 500, placeholder: "https://drive.google.com/..." });
      pane.append(h("h3", { text: "Update link" }), h("p.ls-sub", { text: "Where UPDATE NOW takes players (in the library and in each game page's Update needed box) when a new build needs a new game file. UPDATE itself opens the game page. It must be a Google Drive address. Leave it empty to use the Downloads link." }),
        up, btn("ls-btn", "Save link", () => attempt(err, async () => { await core.api("admin_settings_save", { update: up.value.trim() }); toast("Update link saved."); core.reboot(); })));
    }
    pane.append(err);
  }
  async function adminAdmins(pane) {
    pane.append(h("h2", { text: "Admins" }), h("p.ls-sub", { text: "Give people exactly the admin permissions they need. Only you (the head admin) can change this. Admins can't act on each other." }));
    const list = h("div");
    const err = h("div.ls-form-err");
    const name = h("input.ls-input", { placeholder: "Username to make an admin", maxLength: 16 });
    pane.append(list, h("h3", { text: "Add an admin" }), h("div.ls-row-gap", null, name, btn("ls-btn", "Choose permissions", async () => {
      try {
        const users = (await core.api("admin_users", { q: name.value.trim() })).users;
        const u = users.find((x) => x.name.toLowerCase() === name.value.trim().toLowerCase());
        if (!u) throw new Error("No account has that username.");
        if (u.admin === "head") throw new Error("That's the head admin.");
        editGrants(u, []);
      } catch (e) { err.textContent = e.message; }
    })), err);
    let info;
    const editGrants = (u, perms) => {
      const picked = new Set(perms);
      const boxes = Object.entries(info.permInfo).map(([p, label]) => h("label.ls-check", null, h("input", { type: "checkbox", checked: picked.has(p), onchange: (e) => (e.target.checked ? picked.add(p) : picked.delete(p)) }), h("span", { text: label })));
      const e2 = h("div.ls-form-err");
      S.manage.modal(`Admin permissions: ${u.name}`, h("div.ls-form", null, h("div.ls-check-list", null, ...boxes), h("p.ls-sub", { text: "Untick everything to remove them as an admin." }), e2), {
        actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn", "Save", () => attempt(e2, async () => { info = await core.api("admin_grants", { id: u.id, perms: [...picked] }); paint(); close(); }))],
      });
    };
    const paint = () => {
      list.replaceChildren();
      if (!info.admins.length) list.append(h("div.ls-sub", { text: "No other admins yet." }));
      for (const a of info.admins) {
        list.append(h("div.lx-trow", null, h("div.ls-grow", null, h("b", { text: a.name }), h("div.ls-sub", { text: a.perms.map((p) => info.permInfo[p] || p).join(" · ") })),
          btn("ls-btn.small.grey", "Edit", () => editGrants(a, a.perms)),
          btn("ls-btn.small.red", "Remove", () => { if (confirm(`Remove all of ${a.name}'s admin permissions?`)) attempt(err, async () => { info = await core.api("admin_grants", { id: a.id, perms: [] }); paint(); }); })));
      }
    };
    try { info = await core.api("admin_admins"); paint(); } catch (e) { err.textContent = e.message; }
  }
  async function adminAudit(pane) {
    pane.append(h("h2", { text: "Audit log" }), h("p.ls-sub", { text: "Admin actions and account security events. Passwords, codes and messages are never logged." }));
    const list = h("div.lx-table");
    const more = btn("ls-btn.small.grey", "Load older", () => load());
    pane.append(list, more);
    let before = 0;
    const load = async () => {
      try {
        const out = await core.api("admin_audit", { before });
        for (const e of out.entries) {
          const detail = e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ") : "";
          list.append(h("div.lx-trow", null, h("div.lx-audit-time.ls-sub", { text: new Date(e.at).toLocaleString() }), h("div.ls-grow", null,
            h("b", { text: e.actor }), " ", h("code", { text: e.action }), e.target ? h("span", { text: " → " + e.target }) : null, detail ? h("div.ls-sub", { text: detail }) : null)));
          before = e.id;
        }
        more.hidden = out.entries.length < 100;
        if (!list.children.length) list.append(h("div.ls-sub", { text: "Nothing logged yet." }));
      } catch (e) { list.append(h("div.ls-form-err", { text: e.message })); }
    };
    load();
  }

  // ---- render ----
  let shownRoute = null;
  function render() {
    document.querySelector(".ls-pop")?.remove();
    if (screen !== "app") {
      app.replaceChildren(screen === "signup" ? signupView() : screen === "recover" ? recoverView() : screen === "suspended" ? suspendedView() : signinView());
      return;
    }
    const r = route();
    let content;
    if (r.page === "social") content = socialView(r.rest);
    else if (r.page === "settings") content = settingsView(r.rest);
    else if (r.page === "admin") content = adminView(r.rest);
    else if (r.page === "tutorial") content = tutorialView();
    else if (r.page === "profile") content = profileView(r.rest);
    else content = libraryView(r.rest);
    const banner = core.boot.site.banner ? bannerEl(core.boot.site.banner) : null;
    // Cards rise in when a page opens, not on the repaints that follow (presence, loaded stats).
    const where = location.hash;
    const main = h("main.lx-content" + (where === shownRoute ? ".lx-still" : ""), null, content);
    if (where !== shownRoute) { shownRoute = where; scrollTo(0, 0); }
    app.replaceChildren(h("div.lx-shell" + (r.page === "social" ? ".full" : ""), null, topbar(), banner, main));
    const title = { social: "Social", settings: "Settings", admin: "Admin", tutorial: "Tutorial", profile: decodeURIComponent(r.rest[0] || "Profile") }[r.page];
    document.title = title ? `${title} · Launcher` : "Launcher";
  }

  async function start() {
    const ok = await core.start();
    if (ok) {
      screen = "app";
      const denied = location.hash.match(/^#denied=([a-z0-9-]+)/);
      if (denied) {
        const g = core.boot.games.find((x) => x.id === denied[1]);
        history.replaceState(null, "", "#/library");
        setTimeout(() => toast(g ? (g.state === "soon" ? `${g.name} isn't out yet.` : `You don't have access to ${g.name}.`) : "That game isn't available.", true), 0);
      } else if (/^(#\/?|#\/library\/?)?$/.test(location.hash)) {
        // Opening the launcher with no game loaded shows how to load one.
        await Promise.race([installsChecked, new Promise((r) => setTimeout(r, 1500))]);
        if (noGamesLoaded()) history.replaceState(null, "", "#/tutorial");
      }
      // Achievements already in this browser's saves (Minecraft worlds, Terraria) are sent quietly.
      setTimeout(() => S.ach?.syncDevice(), 4000);
    }
    render();
    return ok;
  }

  window.addEventListener("hashchange", () => { if (screen === "app") render(); });
  core.on("state", () => { if (screen === "app") updateBadges(); });
  core.on("boot", () => { if (screen === "app") render(); });
  core.on("suspended", (info) => { suspended = info; screen = "suspended"; render(); });
  core.on("signedout", (reason) => {
    screen = "signin";
    socialMounted = false;
    loadSite().then(render);
    if (reason) setTimeout(() => toast(reason, true), 0);
  });
  function updateBadges() {
    const n = core.unreadTotal();
    const tab = document.querySelector('.lx-nav-item[href="#/social"]');
    if (!tab) return;
    tab.querySelector(".ls-pill")?.remove();
    if (n) tab.append(h("span.ls-pill.inline", { text: String(n) }));
    const r = route();
    if (r.page === "library" || r.page === "profile") {
      // Friends playing and statuses on the library and profiles refresh with presence.
      const page = document.querySelector(".lx-library, .lx-profile-page");
      if (page && !page.contains(document.activeElement)) render();
    }
  }
  async function loadSite() {
    try { site = await core.api("site", {}, { quiet: true }); } catch {}
  }

  (async () => {
    core.applyTheme();
    app.replaceChildren(h("div.lx-loading", null, h("span.lx-logo", null, S.logo(48))));
    try {
      if (!(await start())) { await loadSite(); render(); }
    } catch (e) {
      app.replaceChildren(h("div.lx-auth", null, h("div.lx-auth-card", null, h("h1", { text: "Can't reach the launcher" }), h("p.ls-sub", { text: e.message }),
        btn("ls-btn", "Try again", () => location.reload()))));
    }
  })();
})();
