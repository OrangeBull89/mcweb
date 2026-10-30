// Launcher social core: API calls, the live socket, presence, preferences,
// notifications and shared state. Used by the launcher page and by in-game
// overlays (see ui.js and the game adapters). No UI here.
(() => {
  const S = (globalThis.LauncherSocial ||= {});
  if (S.core) return;

  const LEGACY_KEY = "mcweb_friends_key";
  const listeners = new Map();
  const on = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); };
  const emit = (type, detail) => { for (const fn of [...(listeners.get(type) || [])]) { try { fn(detail); } catch (e) { console.error("[social]", type, e); } } };

  const core = {
    boot: null, // {me, head, admin, prefs, games, site}
    data: null, // social state: friends, dms, parties, servers, ...
    conn: null, // this tab's socket id (voice uses it)
    wsUp: false,
    game: null, // adapter from a game page, or null on the launcher
    on, emit,
  };
  S.core = core;

  // ---- API ----
  let legacy = null;
  try { legacy = localStorage.getItem(LEGACY_KEY); } catch {}
  async function api(route, body = {}, opts = {}) {
    const headers = { "content-type": "application/json", "x-launcher": "1" };
    if (legacy) headers.authorization = "Bearer " + legacy;
    let res;
    try {
      res = await fetch("/api/" + route, { method: "POST", credentials: "same-origin", headers, body: JSON.stringify(body), keepalive: !!opts.keepalive });
    } catch {
      const err = new Error("Can't reach the server. Check your connection.");
      err.status = 0;
      throw err;
    }
    let out = {};
    try { out = await res.json(); } catch {}
    if (res.ok && legacy) {
      // The server has now set the HttpOnly cookie for this same session.
      legacy = null;
      try { localStorage.removeItem(LEGACY_KEY); } catch {}
    }
    if (!res.ok) {
      const err = new Error(out.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = out;
      if (res.status === 401 && out.signedOut && !opts.quiet) signedOut(out.error);
      throw err;
    }
    return out;
  }
  core.api = api;

  function signedOut(reason) {
    if (!core.boot && !core.data) return;
    core.boot = core.data = null;
    closeWs();
    emit("signedout", reason || "");
  }
  core.logout = async () => {
    try { await api("voice_leave", { conn: core.conn }); } catch {}
    try { await api("logout", {}, { quiet: true }); } catch {}
    try { localStorage.removeItem(LEGACY_KEY); } catch {}
    core.boot = core.data = null;
    closeWs();
    emit("signedout", "");
  };

  // ---- boot / state ----
  core.start = async () => {
    // The first sync goes out alongside boot, not after it: one round trip
    // instead of two. It leaves out the status, so the saved one (invisible,
    // do not disturb) stays: this page doesn't know it yet.
    const { status, ...firstBody } = syncBody();
    const first = api("sync", firstBody, { quiet: true }).catch(() => null);
    try {
      core.boot = await api("boot", {}, { quiet: true });
    } catch (e) {
      if (e.status === 403 && e.body?.suspended) { emit("suspended", e.body); return false; }
      if (e.status === 401 || e.status === 403) { core.boot = null; return false; }
      throw e;
    }
    applyTheme();
    emit("boot", core.boot);
    connectWs();
    const data = await first;
    if (data?.me) { core.setData(data); emit("error", ""); } else await sync();
    return true;
  };
  core.reboot = async () => {
    try { core.boot = await api("boot"); applyTheme(); emit("boot", core.boot); } catch {}
  };
  core.setData = (d) => { if (d?.me) { const before = core.data; core.data = d; notifyChanges(before, d); emit("state", d); } };
  core.run = async (route, body) => {
    const out = await api(route, body);
    core.setData(out);
    return out;
  };

  // ---- preferences ----
  const PREF_DEFAULTS = { theme: "dark", hotkey: "KeyP", afk: 5, sounds: true, desktop: false, dmToasts: true, mentionsOnly: false, compact: false, ptt: false, pttKey: "KeyV", voiceGate: false, serverOrder: "" };
  core.pref = (k) => core.boot?.prefs?.[k] ?? PREF_DEFAULTS[k];
  core.setPrefs = async (patch) => {
    if (core.boot) core.boot.prefs = { ...core.boot.prefs, ...patch };
    applyTheme();
    emit("prefs", core.boot?.prefs);
    const out = await api("prefs", { prefs: patch });
    if (core.boot) core.boot.prefs = out.prefs;
  };
  function applyTheme() {
    const t = core.pref("theme");
    const light = t === "light" || (t === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.classList.toggle("ls-light", light);
  }
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", applyTheme);
  core.applyTheme = applyTheme;

  // ---- presence ----
  let wantedStatus = null;
  let syncing = false;
  let lastInput = Date.now();
  let wasIdle = false;
  core.myStatus = () => wantedStatus || core.data?.me?.status || "online";
  const isIdle = () => core.pref("afk") > 0 && core.myStatus() === "online" && Date.now() - lastInput >= core.pref("afk") * 60_000;
  core.isIdle = isIdle;
  core.shownStatus = () => (core.myStatus() === "invisible" ? "offline" : isIdle() ? "away" : core.myStatus());
  for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
    addEventListener(type, () => {
      lastInput = Date.now();
      if (wasIdle) { wasIdle = false; sync(); }
    }, { capture: true, passive: true });
  }
  core.setStatus = (s) => { wantedStatus = s; sync(); };

  // A game page reports its game only while the game runs (presence().playing
  // false: just the page is open), with what the player is doing in it.
  let sentGame = null;
  let sentAt = 0;
  function gameFields() {
    const { playing, activity, ...p } = core.game.presence?.() || {};
    const on = playing !== false;
    return { worldCode: null, playingWith: null, worldName: null, ...p, game: on ? core.game.id : null, activity: on && activity ? String(activity) : null };
  }
  function syncBody() {
    wasIdle = isIdle();
    const body = { status: core.myStatus(), idleSince: wasIdle ? lastInput : null };
    if (core.game) Object.assign(body, (sentGame = gameFields()));
    sentAt = Date.now();
    return body;
  }
  // Starting or leaving a game or a world syncs on the next check; a new
  // activity (a BTD6 round) waits for 20 s since the last sync.
  function gameMoved() {
    if (!core.game || !sentGame) return false;
    const g = gameFields();
    if (g.game !== sentGame.game || g.worldCode !== sentGame.worldCode || g.playingWith !== sentGame.playingWith || g.worldName !== sentGame.worldName) return true;
    return g.activity !== sentGame.activity && Date.now() - sentAt > 20_000;
  }
  async function sync() {
    if (!core.boot || syncing) return;
    syncing = true;
    try {
      core.setData(await api("sync", syncBody()));
      wantedStatus = null;
      emit("error", "");
    } catch (e) {
      if (e.status !== 401) emit("error", e.message);
    } finally {
      syncing = false;
    }
  }
  core.sync = sync;
  let syncTimer = null;
  core.syncSoon = (ms = 300) => { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); };

  // Other tabs of this site: when a game tab closes while the launcher is
  // still open, it clears its game instead of marking the account offline.
  const tabId = Math.random().toString(36).slice(2);
  const peers = new Map();
  let channel = null;
  try {
    channel = new BroadcastChannel("launcher-tabs");
    channel.onmessage = (e) => {
      if (e.data?.bye) peers.delete(e.data.id); else if (e.data?.id) peers.set(e.data.id, Date.now());
      if (e.data?.hello) channel.postMessage({ id: tabId });
    };
    channel.postMessage({ id: tabId, hello: true });
    setInterval(() => channel.postMessage({ id: tabId }), 20_000);
  } catch {}
  const otherTabs = () => [...peers.values()].some((t) => Date.now() - t < 45_000);
  addEventListener("pagehide", () => {
    try { channel?.postMessage({ id: tabId, bye: true }); } catch {}
    if (!core.boot) return;
    if (core.conn) api("voice_leave", { conn: core.conn }, { keepalive: true }).catch(() => {});
    const body = otherTabs() ? (core.game ? { status: core.myStatus(), game: null } : null) : { status: core.myStatus(), leaving: true };
    if (body) api("sync", body, { keepalive: true }).catch(() => {});
  });
  addEventListener("pageshow", (e) => { if (e.persisted) sync(); });

  // ---- live socket ----
  let ws = null;
  let wsDelay = 2000;
  function closeWs() {
    const s = ws;
    ws = null;
    core.wsUp = false;
    core.conn = null;
    if (s) { try { s.close(); } catch {} }
  }
  function connectWs() {
    if (!core.boot || ws) return;
    let sock;
    try { sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`); } catch { return; }
    ws = sock;
    sock.onopen = () => { core.wsUp = true; wsDelay = 2000; sync(); emit("socket", true); };
    sock.onmessage = (e) => {
      if (e.data === "pong") return;
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.t === "hello") { core.conn = ev.conn; emit("conn", ev.conn); return; }
      onEvent(ev);
    };
    sock.onclose = () => {
      const wasOurs = ws === sock;
      if (wasOurs) { ws = null; core.wsUp = false; core.conn = null; emit("socket", false); }
      if (core.boot && wasOurs) setTimeout(connectWs, wsDelay);
      wsDelay = Math.min(wsDelay * 2, 60_000);
    };
  }
  core.send = (msg) => { if (ws && core.wsUp) { try { ws.send(JSON.stringify(msg)); return true; } catch {} } return false; };
  setInterval(() => { if (core.wsUp) try { ws.send("ping"); } catch {} }, 30_000);

  function onEvent(ev) {
    switch (ev.t) {
      case "sync": core.syncSoon(); if (ev.invite) notify(`${ev.from} invited you to the server ${ev.invite}`, { kind: "invite" }); break;
      case "presence": core.syncSoon(600); emit("presence", ev); break;
      case "signedout": signedOut("You were signed out."); break;
      case "boot": core.reboot(); break;
      case "site": core.reboot(); break;
      default: break;
    }
    emit("event", ev);
    emit("ev:" + ev.t, ev);
  }

  // ---- notifications ----
  let audioCtx = null;
  core.beep = (kind = "msg") => {
    if (!core.pref("sounds")) return;
    try {
      audioCtx ||= new AudioContext();
      const t = audioCtx.currentTime;
      // ringback: the soft double tone you hear while your call rings.
      const notes = kind === "mention" ? [880, 1175] : kind === "call" ? [660, 880, 660] : kind === "ringback" ? [440, 440] : kind === "join" ? [523, 784] : kind === "leave" ? [784, 523] : [740];
      const step = kind === "ringback" ? 0.42 : 0.09;
      const len = kind === "ringback" ? 0.34 : 0.16;
      const vol = kind === "ringback" ? 0.035 : 0.08;
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * step);
        g.gain.exponentialRampToValueAtTime(vol, t + i * step + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * step + len);
        o.connect(g).connect(audioCtx.destination);
        o.start(t + i * step);
        o.stop(t + i * step + len + 0.02);
      });
    } catch {}
  };
  /** In-page toast, plus a desktop notification when the tab is hidden. */
  function notify(text, opts = {}) {
    emit("toast", { text, ...opts });
    if (opts.sound !== false) core.beep(opts.kind === "mention" ? "mention" : opts.kind === "call" ? "call" : "msg");
    if (document.hidden && core.pref("desktop") && "Notification" in globalThis && Notification.permission === "granted") {
      try { new Notification("Launcher", { body: text, tag: opts.tag || undefined, silent: true }); } catch {}
    }
  }
  core.notify = notify;

  function notifyChanges(before, after) {
    if (!before) return;
    const had = new Set((before.incoming || []).map((r) => r.name));
    for (const r of after.incoming || []) if (!had.has(r.name)) notify(`${r.name} sent you a friend request`, { kind: "request" });
    const invHad = new Set((before.serverInvites || []).map((i) => i.id));
    for (const i of after.serverInvites || []) if (!invHad.has(i.id) && !core.wsUp) notify(`${i.by} invited you to ${i.name}`, { kind: "invite" });
  }

  core.unreadTotal = () => {
    const d = core.data;
    if (!d) return 0;
    return Object.values(d.unread || {}).reduce((a, b) => a + b, 0)
      + (d.parties || []).reduce((a, p) => a + p.unread, 0)
      + (d.incoming?.length || 0)
      + (d.servers || []).reduce((a, s) => a + s.mentions, 0)
      + (d.serverInvites?.length || 0);
  };

  // Presence heartbeat; faster while the socket is down.
  let ticks = 0;
  setInterval(() => {
    if (!core.boot) return;
    ticks++;
    const beat = core.wsUp ? ticks % 9 === 0 : ticks % 3 === 0;
    if (beat || isIdle() !== wasIdle || gameMoved()) sync();
    if (!core.wsUp) emit("poll");
  }, 5000);

  // ---- small shared helpers for the UIs ----
  core.ago = (t) => {
    if (!t) return "a while ago";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString();
  };
  core.gameName = (id) => core.boot?.games?.find((g) => g.id === id)?.name || (id ? id[0].toUpperCase() + id.slice(1) : "");
  core.keyLabel = (code) => String(code || "").replace(/^Key|^Digit/, "").replace(/^Numpad/, "Num ").replace(/(Left|Right)$/, " $1");
})();
