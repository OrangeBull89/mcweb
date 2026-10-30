// Launcher social UI (Discord-style): server rail, DMs and group DMs,
// friends, channels, chat, member list and voice. One component, two homes:
//   LauncherSocial.ui.mount(el, {mode: "page"})   the launcher's Social page
//   LauncherSocial.ui.mount(null, {mode: "overlay"}) a hotkey popup in a game
(() => {
  const S = (globalThis.LauncherSocial ||= {});
  if (S.ui) return;
  const core = S.core;
  const voice = S.voice;

  // Server permission bits (same as server/perms.js).
  const P = {
    VIEW_CHANNEL: 1, SEND_MESSAGES: 2, READ_HISTORY: 4, ATTACH_FILES: 8, ADD_REACTIONS: 16, MENTION_EVERYONE: 32,
    MANAGE_MESSAGES: 64, CREATE_INVITE: 128, CHANGE_NICKNAME: 256, MANAGE_NICKNAMES: 512, KICK_MEMBERS: 1024,
    BAN_MEMBERS: 2048, MANAGE_CHANNELS: 4096, MANAGE_ROLES: 8192, MANAGE_SERVER: 16384, ADMINISTRATOR: 32768,
    CONNECT: 65536, SPEAK: 131072, MUTE_MEMBERS: 262144,
  };
  const has = (perms, bit) => (perms & bit) === bit;
  const ic = (name, size) => S.icon(name, size);
  const emo = S.emoji;
  const STATUS_LABEL = { online: "Online", away: "Away", dnd: "Do Not Disturb", invisible: "Invisible", offline: "Offline" };
  const STATUS_HINT = {
    online: "Friends see you and can join your game",
    away: "Shown as away; nobody can join",
    dnd: "No pop-ups; nobody can join",
    invisible: "You appear offline",
  };

  // ---- DOM helpers ----
  function h(tag, props, ...kids) {
    const [name, ...classes] = tag.split(".");
    const n = document.createElement(name || "div");
    if (classes.length) n.className = classes.join(" ");
    if (props) {
      for (const [k, val] of Object.entries(props)) {
        if (val == null || val === false) continue;
        if (k === "class") n.className += (n.className ? " " : "") + val;
        else if (k === "style" && typeof val === "object") Object.assign(n.style, val);
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), val);
        else if (k === "text") n.textContent = val;
        else if (k in n && k !== "list") n[k] = val;
        else n.setAttribute(k, val === true ? "" : val);
      }
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
    return n;
  }
  const btn = (cls, label, onclick, title, extra = {}) => h("button." + cls, { type: "button", title, "aria-label": title || undefined, ...extra, onclick: (e) => { e.stopPropagation(); onclick(e); } }, label);

  // ---- drag to reorder ----
  // Rows marked data-drag inside `box` can be dragged: with a mouse or pen
  // after a few pixels, by touch after holding still a moment (a quick swipe
  // still scrolls). accepts(dragged, over) says where it may go: "edge"
  // (before or after `over`), "into" (onto a group header) or false;
  // drop(dragged, over, where) applies the move. The dragged row follows the
  // pointer, and the social panel waits to redraw until the drag ends.
  // onStart(dragged) runs as the drag begins (e.g. to fold the list).
  function sortable(box, { accepts, drop, onStart, onEnd, scroller }) {
    box.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || ui.dragging || down.target.closest("button, input, textarea, a, select")) return;
      const src = down.target.closest("[data-drag]");
      if (!src || !box.contains(src)) return;
      const touch = down.pointerType === "touch";
      const scrollBox = scroller || box;
      const grab = down.clientY - src.getBoundingClientRect().top;
      let started = false, over = null, where = null, lastY = down.clientY, timer = 0, raf = 0;
      const unmark = () => over?.classList.remove("ls-drop-before", "ls-drop-after", "ls-drop-into");
      const place = () => {
        src.style.transform = "";
        src.style.transform = `translateY(${Math.round(lastY - grab - src.getBoundingClientRect().top)}px)`;
        unmark();
        over = null;
        where = null;
        for (const el of box.querySelectorAll("[data-drag]")) {
          if (el === src || el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (lastY < r.top || lastY >= r.bottom) continue;
          const ok = accepts(src, el);
          if (ok === "into") where = "into";
          else if (ok === "edge") where = lastY < r.top + r.height / 2 ? "before" : "after";
          if (where) { over = el; el.classList.add("ls-drop-" + where); }
          break;
        }
      };
      // Near the top or bottom edge, the list scrolls.
      const edgeScroll = () => {
        const r = scrollBox.getBoundingClientRect();
        const v = lastY < r.top + 40 ? -9 : lastY > r.bottom - 40 ? 9 : 0;
        if (v) { scrollBox.scrollTop += v; place(); }
        raf = requestAnimationFrame(edgeScroll);
      };
      const begin = () => {
        started = true;
        ui.dragging = true;
        onStart?.(src);
        src.classList.add("ls-drag-src");
        box.classList.add("ls-sorting");
        document.documentElement.classList.add("ls-dragging");
        if (touch) navigator.vibrate?.(12);
        place();
        raf = requestAnimationFrame(edgeScroll);
      };
      const move = (e) => {
        lastY = e.clientY;
        if (!started) {
          const far = Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > (touch ? 10 : 5);
          if (touch) { if (far) end(true); return; } // moved before the hold: a scroll
          if (!far) return;
          begin();
        }
        e.preventDefault();
        place();
      };
      const stopScroll = (e) => { if (started) e.preventDefault(); };
      const noMenu = (e) => e.preventDefault();
      const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); end(true); } };
      const up = () => end(false);
      const cancel = () => end(true);
      function end(cancelled) {
        clearTimeout(timer);
        cancelAnimationFrame(raf);
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        removeEventListener("pointercancel", cancel);
        removeEventListener("keydown", key, true);
        removeEventListener("touchmove", stopScroll);
        removeEventListener("contextmenu", noMenu);
        if (!started) return;
        const target = over;
        const at = where;
        unmark();
        src.style.transform = "";
        src.classList.remove("ls-drag-src");
        box.classList.remove("ls-sorting");
        document.documentElement.classList.remove("ls-dragging");
        // The click that ends a drag isn't a click on the row under it.
        const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
        addEventListener("click", swallow, true);
        setTimeout(() => removeEventListener("click", swallow, true), 0);
        ui.dragging = false;
        onEnd?.(src);
        if (!cancelled && target) drop(src, target, at);
        if (ui.renderAfterDrag) { ui.renderAfterDrag = false; renderSoon(); }
      }
      addEventListener("pointermove", move, { passive: false });
      addEventListener("pointerup", up);
      addEventListener("pointercancel", cancel);
      addEventListener("keydown", key, true);
      addEventListener("touchmove", stopScroll, { passive: false });
      if (touch) {
        addEventListener("contextmenu", noMenu);
        timer = setTimeout(begin, 380);
      }
    });
  }

  // A friendly "nothing here yet": an icon, a title, a hint and maybe one button ([label, onclick]).
  function emptyState(icon, title, hint, action) {
    return h("div.ls-empty-state", null, h("div.ls-empty-art", null, ic(icon, 30)), h("b", { text: title }), h("div.ls-sub", { text: hint }),
      action ? btn("ls-btn.small", action[0], action[1]) : null);
  }
  const hue =(name) => [...String(name || "?")].reduce((x, c) => (x * 31 + c.charCodeAt(0)) % 360, 7);
  function avatar(who, size, status, speaking, speakKey) {
    const wrap = h("div.ls-av" + (speaking ? ".speaking" : ""), { style: { width: size + "px", height: size + "px" } });
    if (speakKey) wrap.dataset.vspeak = speakKey; // speaking rings update in place (see "voice-speaking")
    if (who?.avatar) wrap.append(h("img", { src: who.avatar, alt: "" }));
    else {
      wrap.append(h("div.ls-av-letter", {
        style: { background: `hsl(${hue(who?.name)} 45% 42%)`, fontSize: Math.round(size * 0.44) + "px" },
        text: String(who?.name || "?")[0].toUpperCase(),
      }));
    }
    if (status) wrap.append(h("span.ls-dot.ls-" + status, { title: STATUS_LABEL[status] }));
    return wrap;
  }
  function serverIcon(s, size) {
    if (s.icon) return h("img.ls-sicon", { src: s.icon, alt: "", style: { width: size + "px", height: size + "px" } });
    const initials = s.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3);
    return h("div.ls-sicon.ls-sicon-text", { style: { width: size + "px", height: size + "px", background: `hsl(${hue(s.name)} 35% 32%)` } }, initials);
  }
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayLabel = (t) => {
    const d = new Date(t);
    const today = new Date();
    const y = new Date(Date.now() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  };
  const meName = () => core.data?.me?.name;

  function statusText(f) {
    if (f.status === "offline") return `Offline · last online ${core.ago(f.lastSeen)}`;
    const parts = [];
    if (f.status === "away") parts.push(f.idleSince ? `Away · idle ${core.ago(f.idleSince).replace(" ago", "")}` : "Away");
    else if (f.status === "dnd") parts.push("Do Not Disturb");
    if (f.game) parts.push(`Playing ${core.gameName(f.game)}`);
    if (f.activity) parts.push(f.activity);
    if (f.playingWith) parts.push(f.playingWith === meName() ? "in your world" : `in ${f.playingWith}'s world`);
    else if (f.worldCode) parts.push(f.activity ? "open to join" : "hosting a world");
    if (!parts.length) parts.push("Online");
    return parts.join(" · ");
  }
  // How long a friend has been in their game (presence since), Discord style.
  function playTime(t) {
    const m = Math.floor((Date.now() - t) / 60_000);
    return m < 1 ? "just started" : m < 60 ? `for ${m}m` : `for ${Math.floor(m / 60)}h ${m % 60}m`;
  }
  // The line under "Playing X": what they're doing and for how long.
  function activityText(f) {
    const what = f.activity || (f.playingWith ? (f.playingWith === meName() ? "In your world" : `In ${f.playingWith}'s world`) : f.worldCode ? "Hosting a world" : null);
    return [what, f.since ? playTime(f.since) : null].filter(Boolean).join(" · ");
  }

  // ---- state ----
  const ui = {
    mode: "page",
    host: null, // element we render into
    open: true, // overlay: shown
    view: { kind: "home", server: null, chat: null, home: "friends" },
    friendsTab: "online",
    showMembers: true,
    drawer: false,
    error: "",
    statusMenu: false,
  };
  S.ui = ui;
  ui.sortable = sortable;
  const chats = new Map(); // chat key -> {msgs, lastId, since, more, seenUpTo, perms, loaded}
  const servers = new Map(); // server id -> server_get result
  const voiceRooms = new Map(); // room -> members (for rooms we display)
  const typing = new Map(); // chat key -> Map(name -> until)
  const drafts = new Map(); // chat key -> text
  let replyTo = null; // {id, from, body}
  let editing = null; // message id

  const chatKey = (c) => (!c ? "" : c.channel != null ? "c:" + c.channel : c.party != null ? "p:" + c.party : "u:" + c.dm);
  const evKey = (ev) => (ev.channel != null ? "c:" + ev.channel : ev.party != null ? "p:" + ev.party : ev.dm ? "u:" + ev.dm : "");
  const target = (c) => (c.channel != null ? { channel: c.channel } : c.party != null ? { party: c.party } : { with: c.dm });
  const visibleNow = () => !document.hidden && ui.host && (ui.mode === "page" ? ui.host.isConnected : ui.open);

  const currentServer = () => (ui.view.kind === "server" ? servers.get(ui.view.server) : null);
  const channelOf = (id) => currentServer()?.channels.find((ch) => ch.id === id) || null;
  const memberOf = (srv, name) => srv?.members.find((m) => m.name === name) || null;
  function topColor(srv, member) {
    if (!srv || !member) return null;
    let best = null;
    for (const rid of member.roles) {
      const r = srv.roles.find((x) => x.id === rid);
      if (r?.color && (!best || r.position > best.position)) best = r;
    }
    return best?.color || null;
  }
  const displayName = (srv, name) => memberOf(srv, name)?.nick || name;

  // ---- navigation ----
  ui.openHome = (home = "friends") => { ui.view = { kind: "home", server: null, chat: null, home }; ui.drawer = false; render(); };
  ui.openChat = (c) => {
    ui.view = c.channel != null ? { kind: "server", server: ui.view.server, chat: c } : { kind: "home", server: null, chat: c, home: "dm" };
    replyTo = editing = null;
    ui.drawer = false;
    if (ui.mode === "overlay") ui.show(true);
    render();
    loadChat();
    lookForCall(c);
  };
  ui.openDm = (name) => ui.openChat({ dm: name });
  ui.openServer = async (id, channel) => {
    ui.view = { kind: "server", server: id, chat: null };
    ui.drawer = false;
    render();
    await refreshServer(id);
    const srv = servers.get(id);
    if (!srv) return;
    const pick = channel ? srv.channels.find((ch) => ch.id === channel)
      : srv.channels.find((ch) => ch.id === ui.lastChannel?.[id]) || orderedChannels(srv).find((ch) => ch.kind === "text");
    if (pick) selectChannel(pick);
    else render();
  };
  ui.lastChannel = {};
  try { ui.lastChannel = JSON.parse(localStorage.getItem("launcher_last_channel") || "{}"); } catch {}
  function selectChannel(ch) {
    ui.lastChannel[ui.view.server] = ch.id;
    try { localStorage.setItem("launcher_last_channel", JSON.stringify(ui.lastChannel)); } catch {}
    if (ch.kind === "voice") {
      ui.view = { kind: "server", server: ui.view.server, chat: null, voice: ch.id };
      ui.drawer = false;
      render();
      return;
    }
    ui.openChat({ channel: ch.id });
  }

  async function refreshServer(id) {
    try {
      servers.set(id, await core.api("server_get", { id }));
      refreshVoice(id);
    } catch (e) {
      if (e.status === 404) {
        servers.delete(id);
        if (ui.view.server === id) ui.openHome();
        core.syncSoon(0);
      }
    }
    if (ui.view.server === id) render();
  }
  const serverTimers = new Map();
  function refreshServerSoon(id, ms = 400) {
    clearTimeout(serverTimers.get(id));
    serverTimers.set(id, setTimeout(() => refreshServer(id), ms));
  }
  async function refreshVoice(id) {
    try {
      const out = await core.api("voice_rooms", { server: id });
      for (const [room, members] of Object.entries(out.rooms || {})) voiceRooms.set(room, members);
      if (ui.view.server === id) render();
    } catch {}
  }
  async function refreshCall(c) {
    try {
      const out = await core.api("voice_rooms", target(c));
      for (const [room, members] of Object.entries(out.rooms || {})) { voiceRooms.set(room, members); voiceRooms.set(chatKey(c), members); }
      render();
    } catch {}
  }
  // Opening a DM or group shows its call if one is going. Asked at most every
  // 20 s per chat; live "voice" events keep it fresh after that.
  const callLooked = new Map();
  function lookForCall(c) {
    if (!c || c.channel != null || Date.now() - (callLooked.get(chatKey(c)) || 0) < 20_000) return;
    callLooked.set(chatKey(c), Date.now());
    refreshCall(c);
  }

  // ---- chat loading ----
  async function loadChat(older) {
    const c = ui.view.chat;
    if (!c || !visibleNow()) return;
    const key = chatKey(c);
    let st = chats.get(key);
    if (!st) chats.set(key, st = { msgs: [], lastId: 0, since: 0, more: false, seenUpTo: 0, perms: null, loaded: false });
    if (st.loading) { st.again = true; return; }
    st.loading = true;
    try {
      const body = older ? { ...target(c), before: st.msgs[0]?.id || 0 } : { ...target(c), after: st.lastId, ...(st.since ? { since: st.since } : {}) };
      const out = await core.api("messages", body);
      if (chatKey(ui.view.chat) !== key) return;
      const byId = new Map(st.msgs.map((m) => [m.id, m]));
      for (const m of out.messages) {
        if (m.deleted) byId.delete(m.id); else byId.set(m.id, m);
        st.lastId = Math.max(st.lastId, m.id);
      }
      st.msgs = [...byId.values()].sort((a, b) => a.id - b.id);
      if (older) st.more = out.more;
      else if (!st.loaded) st.more = out.more;
      if (!older) st.since = out.now;
      st.seenUpTo = out.seenUpTo;
      st.perms = out.perms;
      st.loaded = true;
      clearUnread(c);
      paintChat(older ? "older" : "new");
    } catch (e) {
      if (e.status === 403 || e.status === 404) { ui.error = e.message; ui.view.chat = null; render(); }
      else ui.error = e.message;
    } finally {
      st.loading = false;
      if (st.again) { st.again = false; loadChat(); }
    }
  }
  function clearUnread(c) {
    const d = core.data;
    if (!d) return;
    if (c.dm && d.unread?.[c.dm]) { delete d.unread[c.dm]; core.emit("state", d); }
    if (c.party != null) { const p = d.parties.find((x) => x.id === c.party); if (p?.unread) { p.unread = 0; core.emit("state", d); } }
    if (c.channel != null) {
      const srv = currentServer();
      const ch = srv?.channels.find((x) => x.id === c.channel);
      if (ch && (ch.unread || ch.mentions)) {
        ch.unread = ch.mentions = 0;
        const sum = d.servers?.find((s) => s.id === ui.view.server);
        if (sum) {
          sum.unread = srv.channels.some((x) => x.unread);
          sum.mentions = srv.channels.reduce((a, x) => a + (x.mentions || 0), 0);
        }
        core.emit("state", d);
        renderSoon();
      }
    }
  }

  async function send(body) {
    const c = ui.view.chat;
    if (!c) return;
    const reply = replyTo?.id;
    replyTo = null;
    if (!body.startsWith("::")) body = await emo.expand(body);
    try {
      await core.api("send", { ...(c.channel != null ? { channel: c.channel } : c.party != null ? { party: c.party } : { to: c.dm }), body, reply });
      await loadChat();
    } catch (e) { toast(e.message, true); }
  }
  ui.send = send;

  // ---- commands ----
  // /purge <amount>: deletes a channel's newest messages, for those who can
  // delete others' messages there (Manage Messages).
  const PURGE_MAX = 100; // the server's cap too
  const chatPerms = (c) => chats.get(chatKey(c))?.perms ?? channelOf(c.channel)?.perms ?? 0;
  const COMMANDS = [
    { name: "purge", args: "<amount>", hint: `Delete the newest messages here (1 to ${PURGE_MAX})`, can: (c) => c?.channel != null && has(chatPerms(c), P.MANAGE_MESSAGES) },
  ];
  /** A typed command (true: handled, not sent as a message). */
  function command(body) {
    const m = body.match(/^\/purge(?:\s+(\S+))?\s*$/i);
    if (!m) return false;
    purge(m[1]);
    return true;
  }
  async function purge(arg) {
    const c = ui.view.chat;
    if (c?.channel == null) return toast("/purge works in server channels.", true);
    if (!has(chatPerms(c), P.MANAGE_MESSAGES)) return toast("You need the Manage Messages permission to purge.", true);
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > PURGE_MAX) return toast(`Give an amount from 1 to ${PURGE_MAX}, like /purge 10.`, true);
    if (!confirm(`Delete the newest ${n} message${n === 1 ? "" : "s"} in #${channelOf(c.channel)?.name || "this channel"}? This can't be undone.`)) return;
    try {
      const out = await core.api("purge", { channel: c.channel, count: n });
      toast(`Deleted ${out.n} message${out.n === 1 ? "" : "s"}.`);
      await loadChat();
    } catch (e) { toast(e.message, true); }
  }
  let typingSent = 0;
  function sendTyping() {
    if (Date.now() - typingSent < 3000 || !ui.view.chat) return;
    typingSent = Date.now();
    core.api("typing", target(ui.view.chat)).catch(() => {});
  }

  // ---- pictures ----
  function shrink(source, w, hgt, max, quality) {
    const scale = Math.min(1, max / Math.max(w, hgt));
    const canvas = h("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hgt * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return { canvas, ctx, url: canvas.toDataURL("image/jpeg", quality) };
  }
  async function sendPicture(source, w, hgt) {
    let { url } = shrink(source, w, hgt, 1280, 0.8);
    if (url.length > 690_000) url = shrink(source, w, hgt, 960, 0.6).url;
    try {
      const { id } = await core.api("image", { data: url });
      await send("::img::" + id);
    } catch (e) { toast(e.message, true); }
  }
  ui.sendPicture = sendPicture;
  ui.shrink = shrink;
  function pickFile(accept, then) {
    const input = h("input", { type: "file", accept });
    input.onchange = () => { const f = input.files?.[0]; if (f) then(f); };
    input.click();
  }
  const attachPicture = () => pickFile("image/*", async (file) => {
    try { const bmp = await createImageBitmap(file); await sendPicture(bmp, bmp.width, bmp.height); } catch { toast("That picture couldn't be read.", true); }
  });
  ui.pickFile = pickFile;

  // ---- worlds (game adapters) ----
  /** Join a friend's game world: in a game page through its adapter, otherwise by opening the game. */
  ui.joinWorld = (name, code, game = "minecraft") => {
    if (core.game?.id === game && core.game.join) {
      core.game.join(name, code);
      if (ui.mode === "overlay") ui.show(false);
      return;
    }
    const g = core.boot?.games?.find((x) => x.id === game);
    if (!g?.path) { toast(g ? `You don't have access to ${g.name}.` : "That game isn't in your library.", true); return; }
    const frag = new URLSearchParams({ join: name, ...(code ? { code } : {}) });
    location.href = `${g.path}#${frag}`;
  };
  const inviteCode = () => core.game?.inviteCode?.() || null;

  // ---- toasts ----
  function toast(text, bad, action) {
    const box = document.querySelector(".ls-toasts") || document.body.appendChild(h("div.ls-toasts.ls-theme"));
    const t = h("div.ls-toast" + (bad ? ".bad" : ""), null, h("span", { text }));
    if (action) t.append(btn("ls-btn.small", action.label, () => { t.remove(); action.run(); }));
    t.append(btn("ls-x", ic("x", 16), () => t.remove(), "Dismiss"));
    box.append(t);
    setTimeout(() => t.remove(), action ? 15000 : 5000);
  }
  ui.toast = toast;
  core.on("toast", ({ text, action }) => {
    if (core.myStatus() === "dnd") return;
    toast(text, false, action);
  });

  // ---- events ----
  core.on("state", () => renderSoon());
  core.on("boot", () => renderSoon());
  core.on("voice", () => { renderSoon(); paintRing(); });
  core.on("error", (msg) => { if (msg !== ui.error) { ui.error = msg; renderSoon(); } });
  core.on("poll", () => { if (ui.view.chat) loadChat(); });
  core.on("socket", (up) => { if (up && ui.view.chat) loadChat(); if (up && ui.view.server) refreshServerSoon(ui.view.server, 0); });
  // When a message last arrived in each DM and group chat, so the list
  // reorders at once instead of on the next sync.
  const recentAt = new Map();
  core.on("ev:msg", (ev) => {
    const key = evKey(ev);
    const here = key && key === chatKey(ui.view.chat) && visibleNow();
    if (key && ev.channel == null) { recentAt.set(key, Date.now()); if (here) renderSoon(); }
    if (here) loadChat();
    else {
      if (ev.channel != null) {
        if (ev.server === ui.view.server) refreshServerSoon(ev.server, 800);
        core.syncSoon(800);
      } else core.syncSoon(200);
      if (ev.from !== meName() && ev.channel == null && core.pref("dmToasts") && !core.pref("mentionsOnly")) {
        const party = ev.party != null ? core.data?.parties.find((p) => p.id === ev.party) : null;
        core.notify(`${ev.from}${party ? " in " + party.name : ""}`, {
          tag: key, action: { label: "Open", run: () => ui.openChat(party ? { party: party.id } : { dm: ev.from }) },
        });
      }
    }
    typing.get(key)?.delete(ev.from);
  });
  core.on("ev:mention", (ev) => {
    const key = "c:" + ev.channel;
    if (key === chatKey(ui.view.chat) && visibleNow()) return;
    const name = core.data?.servers?.find((s) => s.id === ev.server)?.name || "a server";
    core.notify(`@ ${ev.from} mentioned you in ${name}`, { kind: "mention", action: { label: "Open", run: () => ui.openServer(ev.server, ev.channel) } });
  });
  core.on("ev:edit", (ev) => { if (evKey(ev) === chatKey(ui.view.chat)) loadChat(); });
  core.on("ev:seen", (ev) => { if (evKey(ev) === chatKey(ui.view.chat)) loadChat(); });
  core.on("ev:typing", (ev) => {
    const key = evKey(ev);
    if (!typing.has(key)) typing.set(key, new Map());
    typing.get(key).set(ev.from, Date.now() + 5000);
    paintTyping();
  });
  core.on("ev:server", (ev) => { if (servers.has(ev.server) || ev.server === ui.view.server) refreshServerSoon(ev.server); core.syncSoon(500); });
  core.on("ev:presence", () => { if (ui.view.server) refreshServerSoon(ui.view.server, 1500); });
  core.on("ev:voice", (ev) => {
    if (ev.room?.startsWith("c")) {
      const id = Number(ev.room.slice(1));
      const srv = currentServer();
      if (srv?.channels.some((ch) => ch.id === id)) {
        clearTimeout(ui.voiceTimer);
        ui.voiceTimer = setTimeout(() => refreshVoice(srv.server.id), 250);
      }
    } else if (ui.view.chat && ui.view.chat.channel == null) {
      clearTimeout(ui.voiceTimer);
      ui.voiceTimer = setTimeout(() => refreshCall(ui.view.chat), 250);
    }
  });
  core.on("ev:call", (ev) => {
    // The ringing card is voice.incoming (see paintRing). Show the call in its chat too.
    const c = ev.party != null ? { party: ev.party } : { dm: ev.from };
    callLooked.delete(chatKey(c));
    if (chatKey(c) === chatKey(ui.view.chat)) lookForCall(c);
  });
  core.on("ev:kick", (ev) => core.game?.onKick?.(ev.from));
  core.on("signedout", () => { chats.clear(); servers.clear(); ui.view = { kind: "home", server: null, chat: null, home: "friends" }; render(); });
  setInterval(paintTyping, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && ui.view.chat) loadChat(); });

  // ---- rendering ----
  let renderQueued = false;
  function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  ui.render = render;

  function render() {
    if (!ui.host) return;
    // Redrawing would replace a tile that's full screen (and leave full screen).
    if (document.fullscreenElement && ui.root?.contains(document.fullscreenElement)) { renderAfterFullscreen = true; return; }
    // ...and one mid-drag would drop the row being dragged.
    if (ui.dragging) { ui.renderAfterDrag = true; return; }
    if (ui.mode === "overlay") renderOverlayChrome();
    if (ui.mode === "overlay" && !ui.open) return;
    if (!core.data) {
      ui.root.replaceChildren(h("div.ls-empty.ls-grow", { text: core.boot ? "Loading…" : "Signed out." }));
      return;
    }
    const active = document.activeElement;
    const keepComposer = active && active.classList?.contains("ls-composer-input");
    ui.root.classList.toggle("drawer-open", ui.drawer);
    // Pages without a member list (friends, DMs, a server with no channel open) use the whole width.
    const members = renderMembers();
    ui.root.classList.toggle("no-members", !members);
    ui.root.replaceChildren(renderRail(), renderSide(), renderMain(), members || "");
    restoreScroll();
    for (const [key, el] of videoEls) {
      if (!el.isConnected) { el.srcObject = null; videoEls.delete(key); } else if (el.paused) el.play?.().catch(() => {});
    }
    if (keepComposer && composer.input.isConnected) composer.input.focus({ preventScroll: true });
    if (ui.statusMenu) positionStatusMenu();
  }

  // Rail: home + servers.
  function renderRail() {
    const d = core.data;
    const rail = h("nav.ls-rail", { "aria-label": "Servers" });
    const dmUnread = Object.values(d.unread || {}).reduce((a, b) => a + b, 0) + d.parties.reduce((a, p) => a + p.unread, 0) + d.incoming.length;
    const home = h("div.ls-rail-item" + (ui.view.kind === "home" ? ".on" : ""), { title: "Direct messages", onclick: () => ui.openHome() },
      h("div.ls-home-icon", null, S.logo(26)), dmUnread ? h("span.ls-pill", { text: String(dmUnread) }) : null);
    rail.append(home, h("div.ls-rail-sep"));
    for (const s of railServers()) {
      const item = h("div.ls-rail-item" + (ui.view.server === s.id ? ".on" : "") + (s.unread ? ".unread" : ""), { title: s.name, "data-drag": s.id, onclick: () => ui.openServer(s.id) },
        serverIcon(s, 44), s.mentions ? h("span.ls-pill", { text: String(s.mentions) }) : null);
      rail.append(item);
    }
    const invites = d.serverInvites?.length || 0;
    rail.append(h("div.ls-rail-item.ls-rail-add", { title: "Create a server or see invites", onclick: () => S.manage.addServer() },
      h("div.ls-home-icon", null, ic("plus", 22)), invites ? h("span.ls-pill", { text: String(invites) }) : null));
    // Servers can be dragged into any order; it's saved for this account.
    sortable(rail, {
      accepts: () => "edge",
      drop: (src, over, where) => {
        const ids = railServers().map((s) => s.id).filter((id) => id !== +src.dataset.drag);
        ids.splice(ids.indexOf(+over.dataset.drag) + (where === "after" ? 1 : 0), 0, +src.dataset.drag);
        core.setPrefs({ serverOrder: ids.join(",") }).catch((e) => toast(e.message, true));
        render();
      },
    });
    return rail;
  }
  // The user's own order first; servers joined since then go at the end.
  function railServers() {
    const list = core.data.servers || [];
    const order = String(core.pref("serverOrder") || "").split(",").filter(Boolean).map(Number);
    if (!order.length) return list;
    const at = (s) => { const i = order.indexOf(s.id); return i < 0 ? order.length + list.indexOf(s) : i; };
    return [...list].sort((a, b) => at(a) - at(b));
  }

  function renderSide() {
    const side = h("aside.ls-side");
    if (ui.view.kind === "server") side.append(...serverSide());
    else side.append(...homeSide());
    side.append(voicePanel(), userPanel());
    return side;
  }

  function homeSide() {
    const d = core.data;
    const head = h("div.ls-side-head", null, h("b", { text: "Direct Messages" }));
    const list = h("div.ls-side-list");
    const pending = d.incoming.length;
    list.append(h("div.ls-side-row" + (ui.view.kind === "home" && !ui.view.chat ? ".on" : ""), { onclick: () => ui.openHome() },
      h("span.ls-side-icon", null, ic("users", 20)), h("span.ls-grow", { text: "Friends" }), pending ? h("span.ls-pill.inline", { text: String(pending) }) : null));
    if (d.serverInvites?.length) {
      list.append(h("div.ls-side-row", { onclick: () => S.manage.addServer() },
        h("span.ls-side-icon", null, ic("inbox", 20)), h("span.ls-grow", { text: "Server invites" }), h("span.ls-pill.inline", { text: String(d.serverInvites.length) })));
    }
    list.append(h("div.ls-sect", null, h("span", { text: "Direct messages" }), btn("ls-sect-btn", ic("plus", 16), () => S.manage.newGroup(), "New group chat")));
    // Group chats and one-to-one chats together, the latest message first (like
    // Discord). Messages that arrived since the last sync count too.
    const rows = [];
    const at = (key, serverAt) => Math.max(serverAt || 0, recentAt.get(key) || 0);
    for (const p of d.parties) rows.push({ kind: "party", p, sort: at("p:" + p.id, p.lastAt) });
    const seen = new Set();
    for (const u of d.dms) { seen.add(u.name); rows.push({ kind: "dm", u, sort: at("u:" + u.name, u.lastAt) }); }
    for (const f of d.friends) if (d.unread[f.name] && !seen.has(f.name)) { seen.add(f.name); rows.push({ kind: "dm", u: f, sort: Infinity }); }
    // A chat opened before its first message is listed too, at the top.
    const open = ui.view.kind === "home" ? ui.view.chat?.dm : null;
    if (open && !seen.has(open)) rows.push({ kind: "dm", u: d.friends.find((f) => f.name === open) || { name: open, status: "offline" }, sort: Infinity });
    rows.sort((a, b) => b.sort - a.sort);
    if (!rows.length) list.append(h("div.ls-side-note", { text: "Your conversations show up here." }));
    for (const r of rows) {
      if (r.kind === "party") {
        const p = r.p;
        const on = ui.view.chat?.party === p.id;
        const online = p.members.filter((m) => m.status !== "offline").length;
        list.append(h("div.ls-side-row.ls-dm" + (on ? ".on" : "") + (p.unread ? ".unread" : ""), { onclick: () => ui.openChat({ party: p.id }) },
          avatar({ name: p.name }, 32), h("div.ls-grow.ls-ell", null, h("div.ls-ell", { text: p.name }), h("div.ls-sub.ls-ell", { text: `${p.members.length + 1} members · ${online} online` })),
          p.unread ? h("span.ls-pill.inline", { text: String(p.unread) }) : null));
      } else {
        const u = r.u;
        const on = ui.view.chat?.dm === u.name;
        const n = d.unread[u.name];
        list.append(h("div.ls-side-row.ls-dm" + (on ? ".on" : "") + (n ? ".unread" : ""), { onclick: () => ui.openDm(u.name) },
          avatar(u, 32, u.status), h("div.ls-grow.ls-ell", null, h("div.ls-ell", { text: u.name }),
            u.status !== "offline" && (u.game || u.status !== "online") ? h("div.ls-sub.ls-ell", { text: statusText(u) }) : null),
          n ? h("span.ls-pill.inline", { text: String(n) }) : null));
      }
    }
    return [head, list];
  }

  function orderedChannels(srv) {
    const cats = srv.channels.filter((c) => c.kind === "category").sort((a, b) => a.position - b.position || a.id - b.id);
    const kids = (parent) => srv.channels.filter((c) => c.kind !== "category" && (c.parent ?? null) === parent)
      .sort((a, b) => (a.kind === "voice") - (b.kind === "voice") || a.position - b.position || a.id - b.id);
    const out = [...kids(null)];
    for (const cat of cats) out.push(cat, ...kids(cat.id));
    return out;
  }
  ui.orderedChannels = orderedChannels;
  const collapsed = new Set();

  function serverSide() {
    const srv = currentServer();
    const sum = core.data.servers?.find((s) => s.id === ui.view.server);
    const name = srv?.server.name || sum?.name || "…";
    const head = h("div.ls-side-head.ls-click", { onclick: (e) => S.manage.serverMenu(srv, e.currentTarget) }, h("b.ls-grow.ls-ell", { text: name }), ic("chevronDown", 18));
    const list = h("div.ls-side-list");
    if (!srv) { list.append(h("div.ls-side-note", { text: "Loading…" })); return [head, list]; }
    const canSort = has(srv.perms, P.MANAGE_CHANNELS);
    const drag = (ch) => (canSort ? { "data-drag": ch.id, "data-kind": ch.kind } : {});
    let cat = null;
    for (const ch of orderedChannels(srv)) {
      if (ch.kind === "category") {
        cat = ch;
        const isCollapsed = collapsed.has(ch.id);
        list.append(h("div.ls-sect.ls-cat.ls-click" + (isCollapsed ? ".folded" : ""), { ...drag(ch), title: canSort ? "Click to fold · drag to move" : undefined, onclick: () => { isCollapsed ? collapsed.delete(ch.id) : collapsed.add(ch.id); render(); } },
          ic(isCollapsed ? "chevronRight" : "chevronDown", 12), h("span.ls-grow.ls-ell", { text: ch.name.toUpperCase() }),
          canSort ? btn("ls-sect-btn", ic("plus", 16), () => S.manage.createChannel(srv, ch.id), "Create channel") : null));
        continue;
      }
      if (cat && collapsed.has(cat.id) && ch.parent === cat.id && !(ch.unread || ch.mentions) && ui.view.chat?.channel !== ch.id) continue;
      const on = ui.view.chat?.channel === ch.id || ui.view.voice === ch.id;
      const row = h("div.ls-side-row.ls-chan" + (on ? ".on" : "") + (ch.unread ? ".unread" : ""), { ...drag(ch), onclick: () => selectChannel(ch) },
        h("span.ls-side-icon", null, ic(ch.kind === "voice" ? "volume" : "hash", 18)), h("span.ls-grow.ls-ell", { text: ch.name }),
        ch.mentions ? h("span.ls-pill.inline", { text: String(ch.mentions) }) : null,
        has(ch.perms, P.MANAGE_CHANNELS) ? btn("ls-row-gear", ic("settings", 15), () => S.manage.editChannel(srv, ch), "Edit channel") : null);
      if (ch.kind === "voice") {
        row.ondblclick = () => joinVoiceChannel(srv, ch);
        list.append(row);
        const members = voice.room === "c" + ch.id ? voice.members : voiceRooms.get("c" + ch.id) || [];
        for (const m of members) list.append(voiceMemberRow(srv, m, voice.room === "c" + ch.id));
      } else list.append(row);
    }
    if (!srv.channels.some((c) => c.kind !== "category")) list.append(h("div.ls-side-note", { text: "No channels you can see yet." }));
    if (canSort) sortChannels(srv, list);
    return [head, list];
  }

  // Channels move among their own kind (text above voice, as they're always
  // listed) and into other categories; dropped on a category header, a channel
  // goes to the end of it. Categories move among categories, folded while
  // they're dragged so the whole list fits.
  function sortChannels(srv, list) {
    const byId = (el) => srv.channels.find((c) => c.id === +el.dataset.drag);
    sortable(list, {
      accepts: (src, over) => {
        if (src.dataset.kind === "category") return over.dataset.kind === "category" ? "edge" : false;
        if (over.dataset.kind === "category") return "into";
        return over.dataset.kind === src.dataset.kind ? "edge" : false;
      },
      onStart: (src) => list.classList.toggle("ls-fold-all", src.dataset.kind === "category"),
      onEnd: () => list.classList.remove("ls-fold-all"),
      drop: (src, over, where) => {
        const moved = byId(src), at = byId(over);
        if (!moved || !at) return;
        const cats = orderedChannels(srv).filter((c) => c.kind === "category");
        const groups = new Map([[null, []], ...cats.map((c) => [c.id, []])]);
        for (const c of orderedChannels(srv)) if (c.kind !== "category" && c !== moved) (groups.get(c.parent ?? null) || groups.get(null)).push(c);
        if (moved.kind === "category") {
          cats.splice(cats.indexOf(moved), 1);
          cats.splice(cats.indexOf(at) + (where === "after" ? 1 : 0), 0, moved);
        } else if (where === "into") {
          const g = groups.get(at.id);
          const lastOfKind = g.map((c) => c.kind).lastIndexOf(moved.kind);
          // Text goes after the category's text (before its voice); voice at the very end.
          g.splice(lastOfKind >= 0 ? lastOfKind + 1 : moved.kind === "voice" ? g.length : 0, 0, moved);
        } else {
          const g = groups.get(at.parent ?? null) || groups.get(null);
          g.splice(g.indexOf(at) + (where === "after" ? 1 : 0), 0, moved);
        }
        // The same numbering the server does: categories in one run, channels per parent.
        const order = [];
        cats.forEach((c, i) => { c.position = i; order.push({ id: c.id }); });
        for (const [parent, g] of groups) {
          g.forEach((c, i) => { c.position = i; c.parent = parent; order.push({ id: c.id, parent }); });
        }
        if (moved.kind !== "category" && at.kind === "category") collapsed.delete(at.id);
        render();
        core.api("channel_order", { id: srv.server.id, order }).catch((e) => { toast(e.message, true); refreshServer(srv.server.id); });
      },
    });
  }
  function voiceMemberRow(srv, m, mine) {
    const key = mine ? speakKey(m.conn) : null;
    const member = memberOf(srv, m.name) || { name: m.name };
    return h("div.ls-voice-member", { onclick: (e) => S.manage.profile(m.name, e.currentTarget, srv) },
      avatar(member, 22, null, !!key && voice.speaking.has(key), key), h("span.ls-grow.ls-ell", { text: displayName(srv, m.name) }),
      m.screen ? h("span.ls-live.inline", { text: "LIVE", title: "Sharing their screen" }) : null,
      m.video ? h("span.ls-ic", { title: "Camera on" }, ic("video", 14)) : null,
      m.smute ? h("span.ls-ic.red", { title: "Server muted" }, ic("micOff", 14)) : m.deaf ? h("span.ls-ic.red", { title: "Deafened" }, ic("headphonesOff", 14)) : m.muted ? h("span.ls-ic", { title: "Muted" }, ic("micOff", 14)) : null);
  }
  function joinVoiceChannel(srv, ch, video) {
    if (!has(ch.perms, P.CONNECT)) { toast("You can't join this voice channel.", true); return; }
    voice.join({ channel: ch.id }, `${ch.name} / ${srv.server.name}`, srv.server.id, { video: !!video });
  }

  function userPanel() {
    const d = core.data;
    const panel = h("div.ls-user-panel");
    const status = core.shownStatus();
    const who = h("div.ls-user-who.ls-click", { onclick: (e) => { e.stopPropagation(); ui.statusMenu = !ui.statusMenu; render(); } },
      avatar(d.me, 34, status, voice.speaking.has("me"), "me"),
      h("div.ls-grow.ls-ell", null, h("div.ls-name.ls-ell", { text: d.me.name }),
        h("div.ls-sub.ls-ell", { text: core.isIdle() ? "Online · auto-away" : STATUS_LABEL[core.myStatus()] })));
    panel.append(who,
      btn("ls-icon" + (voice.muted ? ".danger" : ""), ic(voice.muted ? "micOff" : "mic", 19), () => voice.toggleMute(), voice.muted ? "Unmute" : "Mute"),
      btn("ls-icon" + (voice.deaf ? ".danger" : ""), ic(voice.deaf ? "headphonesOff" : "headphones", 19), () => voice.toggleDeaf(), voice.deaf ? "Undeafen" : "Deafen"),
      btn("ls-icon", ic("settings", 19), () => (ui.mode === "page" && S.openSettings ? S.openSettings() : S.manage.prefs()), "Settings"));
    if (ui.statusMenu) {
      const menu = h("div.ls-menu.ls-status-menu", { onclick: (e) => e.stopPropagation() });
      for (const s of ["online", "away", "dnd", "invisible"]) {
        menu.append(h("button.ls-menu-item", { type: "button", onclick: () => { ui.statusMenu = false; core.setStatus(s); render(); } },
          h("span.ls-dot.static.ls-" + s), h("div", null, h("div", { text: STATUS_LABEL[s] }), h("div.ls-sub", { text: STATUS_HINT[s] }))));
      }
      panel.append(menu);
    }
    return panel;
  }
  function positionStatusMenu() { /* positioned by CSS above the panel */ }

  // ---- main area ----
  function renderMain() {
    const main = h("main.ls-main");
    const menuBtn = btn("ls-icon.ls-drawer-btn", ic("menu", 20), () => { ui.drawer = !ui.drawer; render(); }, "Menu");
    if (ui.view.kind === "server" && ui.view.voice) main.append(...voiceChannelView(menuBtn));
    else if (ui.view.chat) main.append(...chatView(menuBtn));
    else if (ui.view.kind === "server") main.append(h("div.ls-main-head", null, menuBtn, h("b", { text: currentServer()?.server.name || "" })), emptyState("hash", "Pick a channel", "Choose a text channel to read and chat, or a voice channel to hang out."));
    else main.append(...friendsView(menuBtn));
    if (ui.error) main.append(h("div.ls-err", null, h("span.ls-grow", { text: ui.error }), btn("ls-x", ic("x", 16), () => { ui.error = ""; render(); }, "Dismiss")));
    return main;
  }

  function friendsView(menuBtn) {
    const d = core.data;
    const head = h("div.ls-main-head", null, menuBtn, h("span.ls-side-icon", null, ic("users", 20)), h("b", { text: "Friends" }), h("span.ls-head-sep"));
    const tabs = [["online", "Online"], ["all", "All"], ["pending", d.incoming.length ? `Pending (${d.incoming.length})` : "Pending"], ["blocked", "Blocked"]];
    for (const [id, label] of tabs) head.append(btn("ls-tab" + (ui.friendsTab === id ? ".on" : ""), label, () => { ui.friendsTab = id; render(); }));
    head.append(btn("ls-tab.add" + (ui.friendsTab === "add" ? ".on" : ""), "Add Friend", () => { ui.friendsTab = "add"; render(); }));
    const body = h("div.ls-main-body.ls-friends");
    const list = h("div.ls-friend-list.ls-grow");
    body.append(list);

    // Minecraft (or another game) tab: people in my world, with Kick.
    if (core.game && ui.friendsTab === "online") {
      const inMine = [...d.friends, ...d.parties.flatMap((p) => p.members)]
        .filter((f, i, all) => f.playingWith === meName() && all.findIndex((x) => x.name === f.name) === i);
      if (inMine.length) {
        list.append(h("div.ls-sect", { text: `In your world — ${inMine.length}` }));
        for (const f of inMine) {
          list.append(friendRow(f, [btn("ls-btn.small.grey", "Kick", () => {
            if (confirm(`Kick ${f.name} from your world?`)) core.api("kick", { name: f.name }).then(() => toast(`${f.name} was kicked.`)).catch((e) => toast(e.message, true));
          })]));
        }
      }
    }

    if (ui.friendsTab === "add") {
      const input = h("input.ls-input", { placeholder: "Enter a username", maxLength: 16, autocomplete: "off", spellcheck: false });
      const go = btn("ls-btn", "Send Friend Request", async () => {
        const name = input.value.trim();
        if (!name) return;
        go.disabled = true;
        try {
          const out = await core.run("request", { name });
          toast(out.friends.some((f) => f.name.toLowerCase() === name.toLowerCase()) ? `You and ${name} are now friends.` : `Friend request sent to ${name}.`);
          input.value = "";
        } catch (e) { toast(e.message, true); }
        go.disabled = false;
      });
      input.onkeydown = (e) => { if (e.key === "Enter") go.click(); };
      list.append(h("div.ls-add-friend", null, h("h3", { text: "Add Friend" }), h("p.ls-sub", { text: "Add a friend with their username. Usernames are case-insensitive." }),
        h("div.ls-add-row", null, input, go)));
      setTimeout(() => input.focus(), 0);
    } else if (ui.friendsTab === "pending") {
      if (!d.incoming.length && !d.outgoing.length) list.append(emptyState("inbox", "No pending requests", "Friend requests you send or get show up here."));
      if (d.incoming.length) list.append(h("div.ls-sect", { text: `Incoming — ${d.incoming.length}` }));
      for (const r of d.incoming) {
        list.append(h("div.ls-friend-row", null, avatar(r, 36), h("div.ls-grow", null, h("div.ls-name", { text: r.name }), h("div.ls-sub", { text: "Incoming friend request · " + core.ago(r.created) })),
          btn("ls-round.ok", ic("check", 18), () => core.run("respond", { name: r.name, accept: true }).catch((e) => toast(e.message, true)), "Accept"),
          btn("ls-round", ic("x", 18), () => core.run("respond", { name: r.name, accept: false }).catch((e) => toast(e.message, true)), "Ignore"),
          btn("ls-round.warn", ic("ban", 18), () => { if (confirm(`Block ${r.name}? They won't be able to find or message you.`)) core.run("block", { name: r.name }); }, "Block")));
      }
      if (d.outgoing.length) list.append(h("div.ls-sect", { text: `Sent — ${d.outgoing.length}` }));
      for (const r of d.outgoing) {
        list.append(h("div.ls-friend-row", null, avatar(r, 36), h("div.ls-grow", null, h("div.ls-name", { text: r.name }), h("div.ls-sub", { text: "Outgoing friend request · " + core.ago(r.created) })),
          btn("ls-round", ic("x", 18), () => core.run("cancel", { name: r.name }), "Cancel")));
      }
    } else if (ui.friendsTab === "blocked") {
      if (!d.blocked.length) list.append(emptyState("ban", "Nobody's blocked", "People you block can't message you or find you."));
      else list.append(h("div.ls-sect", { text: `Blocked — ${d.blocked.length}` }));
      for (const n of d.blocked) list.append(h("div.ls-friend-row", null, avatar({ name: n }, 36), h("div.ls-grow.ls-name", { text: n }), btn("ls-btn.small.grey", "Unblock", () => core.run("unblock", { name: n }))));
    } else {
      const order = { online: 0, dnd: 1, away: 2, offline: 3 };
      let rows = [...d.friends].sort((a, b) => order[a.status] - order[b.status] || (b.worldCode ? 1 : 0) - (a.worldCode ? 1 : 0) || a.name.localeCompare(b.name));
      if (ui.friendsTab === "online") rows = rows.filter((f) => f.status !== "offline");
      list.append(h("div.ls-sect", { text: `${ui.friendsTab === "online" ? "Online" : "All friends"} — ${rows.length}` }));
      if (!rows.length) {
        list.append(ui.friendsTab === "online" && d.friends.length
          ? emptyState("users", "Nobody's online right now", "Your friends show up here as soon as they open the launcher.", ["See all friends", () => { ui.friendsTab = "all"; render(); }])
          : emptyState("userPlus", "No friends yet", "Add someone with their username to chat, call and see what they play.", ["Add Friend", () => { ui.friendsTab = "add"; render(); }]));
      }
      for (const f of rows) list.append(friendRow(f));
    }

    // Wide screens: who's playing what.
    const playing = d.friends.filter((f) => f.game && f.status !== "offline");
    const activity = h("aside.ls-activity", null, h("h3", { text: "Active Now" }));
    if (!playing.length) {
      activity.append(h("div.ls-activity-empty", null, h("b", { text: "It's quiet for now…" }),
        h("div.ls-sub", { text: "When a friend starts a game, like Minecraft or Terraria, it shows up here." })));
    }
    for (const f of playing) {
      activity.append(h("div.ls-activity-card.ls-click", { onclick: () => ui.openDm(f.name) }, h("div.ls-row", null, avatar(f, 36, f.status), h("div.ls-grow.ls-ell", null, h("div.ls-name.ls-ell", { text: f.name }), h("div.ls-sub.ls-ell.ls-playing", null, h("span.ls-live-dot"), "Playing " + core.gameName(f.game)), activityText(f) ? h("div.ls-sub.ls-ell", { text: activityText(f) }) : null)),
        f.worldCode && f.playingWith !== meName() && f.game === "minecraft" ? btn("ls-btn.green.small.wide", "Join world", () => ui.joinWorld(f.name, f.worldCode, f.game)) : null));
    }
    body.append(activity);
    return [head, body];
  }

  function friendRow(f, extra) {
    const row = h("div.ls-friend-row.ls-click", { onclick: () => ui.openDm(f.name) },
      avatar(f, 36, f.status), h("div.ls-grow.ls-ell", null, h("div.ls-name", { text: f.name }), h("div.ls-sub.ls-ell", { text: statusText(f) })));
    if (extra) row.append(...extra);
    else {
      if (f.worldCode && f.playingWith !== meName()) row.append(btn("ls-btn.green.small", "Join", () => ui.joinWorld(f.name, f.worldCode, f.game || "minecraft"), "Join their world"));
      row.append(btn("ls-round", ic("chat", 18), () => ui.openDm(f.name), "Message"),
        btn("ls-round", ic("phone", 17), () => voice.join({ with: f.name }, f.name), "Voice call"),
        btn("ls-round", ic("more", 18), (e) => S.manage.profile(f.name, e.currentTarget, null), "More"));
    }
    const unread = core.data.unread[f.name];
    if (unread) row.append(h("span.ls-pill.inline", { text: String(unread) }));
    return row;
  }

  // ---- chat view ----
  const composer = { key: null, input: null, el: null };
  let msgsEl = null;
  let typingEl = null;
  let replyBar = null;

  function chatHeader(c, menuBtn) {
    const head = h("div.ls-main-head", null, menuBtn);
    const d = core.data;
    if (c.channel != null) {
      const ch = channelOf(c.channel);
      head.append(h("span.ls-side-icon", null, ic("hash", 20)), h("b", { text: ch?.name || "" }));
      if (ch?.topic) head.append(h("span.ls-head-sep"), h("span.ls-sub.ls-ell.ls-grow", { text: ch.topic, title: ch.topic }));
      else head.append(h("span.ls-grow"));
      head.append(btn("ls-icon", ic("pin", 19), (e) => S.manage.pins(c.channel, e.currentTarget), "Pinned messages"),
        btn("ls-icon" + (ui.showMembers ? ".on" : ""), ic("users", 19), () => { ui.showMembers = !ui.showMembers; render(); }, "Member list"));
    } else if (c.party != null) {
      const p = d.parties.find((x) => x.id === c.party);
      if (!p) return head;
      head.append(avatar({ name: p.name }, 26), h("b", { text: p.name }), h("span.ls-sub", { text: `${p.members.length + 1} members` }), h("span.ls-grow"));
      if (inviteCode()) head.append(btn("ls-btn.small", "Invite to world", () => send("::invite::" + inviteCode()), "Invite everyone here to your world"));
      head.append(btn("ls-icon", ic("phone", 19), () => voice.join({ party: p.id }, p.name), "Start a voice call"),
        btn("ls-icon", ic("edit", 18), () => S.manage.renameGroup(p), "Rename group"),
        btn("ls-icon" + (ui.showMembers ? ".on" : ""), ic("users", 19), () => { ui.showMembers = !ui.showMembers; render(); }, "Members"));
    } else {
      const f = d.friends.find((x) => x.name === c.dm) || d.dms.find((x) => x.name === c.dm) || { name: c.dm, status: "offline" };
      head.append(avatar(f, 26, f.status), h("b.ls-click", { text: f.name, onclick: (e) => S.manage.profile(f.name, e.currentTarget, null) }),
        h("span.ls-sub.ls-ell.ls-grow", { text: f.status ? statusText(f) : "" }));
      if (f.worldCode && f.playingWith !== meName()) head.append(btn("ls-btn.green.small", "Join world", () => ui.joinWorld(f.name, f.worldCode, f.game || "minecraft")));
      else if (inviteCode()) head.append(btn("ls-btn.small", "Invite to world", () => send("::invite::" + inviteCode()), "Invite them to your world"));
      else if (core.game?.join && f.status === "online" && f.game === core.game.id) head.append(btn("ls-btn.small.grey", "Ask to join", () => send("::ask::")));
      head.append(btn("ls-icon", ic("phone", 19), () => voice.join({ with: f.name }, f.name), "Start a voice call"),
        btn("ls-icon" + (ui.showMembers ? ".on" : ""), ic("user", 19), () => { ui.showMembers = !ui.showMembers; render(); }, "Profile"));
    }
    return head;
  }

  function chatView(menuBtn) {
    const c = ui.view.chat;
    const key = chatKey(c);
    const st = chats.get(key);
    const head = chatHeader(c, menuBtn);
    // The message list is kept between renders, and render() puts its scroll back.
    if (!msgsEl || msgsEl.dataset.key !== key) {
      stickToBottom = true;
      gapFromBottom = 0;
      const list = msgsEl = h("div.ls-msgs", {
        onscroll: () => {
          if (list !== msgsEl || !msgsVisible()) return;
          rememberScroll();
          const cur = chats.get(key);
          if (list.scrollTop < 80 && cur?.more && !cur.loading) loadChat(true);
        },
      });
      msgsEl.dataset.key = key;
      paintMessages(st);
    }
    typingEl = h("div.ls-typing");
    paintTyping();
    const stage = chatCall(c);
    return [head, stage, msgsEl, typingEl, composerFor(c, st)].filter(Boolean);
  }

  // Where the message list is scrolled to, kept while it's on screen. The
  // browser resets a list to the top when render() re-attaches it or the
  // overlay was hidden, so render() puts it back from these.
  let stickToBottom = true;
  let gapFromBottom = 0;
  const msgsVisible = () => !!msgsEl?.isConnected && msgsEl.clientHeight > 0;
  function rememberScroll() {
    if (!msgsVisible()) return;
    gapFromBottom = Math.max(0, msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight);
    stickToBottom = gapFromBottom < 60;
  }
  function restoreScroll() {
    if (!msgsVisible()) return;
    msgsEl.scrollTop = stickToBottom ? msgsEl.scrollHeight : msgsEl.scrollHeight - msgsEl.clientHeight - gapFromBottom;
  }

  function paintChat(why) {
    if (!msgsEl || msgsEl.dataset.key !== chatKey(ui.view.chat)) { render(); return; }
    const st = chats.get(msgsEl.dataset.key);
    rememberScroll();
    const oldHeight = msgsEl.scrollHeight;
    const oldTop = msgsEl.scrollTop;
    paintMessages(st);
    if (why === "older") msgsEl.scrollTop = msgsEl.scrollHeight - oldHeight + oldTop;
    else if (stickToBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
    rememberScroll();
    updateComposerPerms(st);
  }

  function chatTitle(c) {
    if (c.channel != null) return "#" + (channelOf(c.channel)?.name || "");
    if (c.party != null) return core.data.parties.find((p) => p.id === c.party)?.name || "group";
    return c.dm;
  }

  function paintMessages(st) {
    const c = ui.view.chat;
    msgsEl.replaceChildren();
    if (!st?.loaded) { msgsEl.append(h("div.ls-empty", { text: "Loading…" })); return; }
    if (st.more) msgsEl.append(h("div.ls-more", { text: "Scroll up for older messages" }));
    else {
      const ch = c.channel != null ? channelOf(c.channel) : null;
      const badge = c.channel != null ? h("div.ls-chat-badge", null, ic("hash", 38))
        : c.party != null ? avatar({ name: chatTitle(c) }, 76)
        : avatar(core.data.friends.find((f) => f.name === c.dm) || { name: c.dm }, 76);
      msgsEl.append(h("div.ls-chat-start", null, badge, h("h2", { text: ch ? `Welcome to #${ch.name}!` : chatTitle(c) }),
        h("p.ls-sub", { text: ch ? ch.topic || "This is the start of the channel." : c.party != null ? "This is the start of your group chat." : `This is the start of your conversation with ${c.dm}.` })));
    }
    const srv = c.channel != null ? currentServer() : null;
    const blockedNames = new Set(core.data.blocked);
    let prev = null;
    for (const m of st.msgs) {
      if (!prev || new Date(prev.created).toDateString() !== new Date(m.created).toDateString()) msgsEl.append(h("div.ls-day", null, h("span", { text: dayLabel(m.created) })));
      if (blockedNames.has(m.from)) {
        msgsEl.append(h("div.ls-blocked-msg", { text: "Message from someone you blocked." }));
        prev = null;
        continue;
      }
      const sameDay = prev && new Date(prev.created).toDateString() === new Date(m.created).toDateString();
      const cont = sameDay && prev.from === m.from && m.created - prev.created < 5 * 60_000 && !m.reply && editing !== m.id;
      msgsEl.append(messageRow(m, cont, srv, st));
      prev = m;
    }
    const last = st.msgs[st.msgs.length - 1];
    if (c.dm && last?.mine && last.id <= st.seenUpTo) msgsEl.append(h("div.ls-seen", { text: "Seen" }));
    requestAnimationFrame(() => { if (stickToBottom && msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight; });
  }

  function mentionsMe(m, srv) {
    if (m.mine) return false;
    const me = meName().toLowerCase();
    if (new RegExp(`(^|[^A-Za-z0-9_])@${me}\\b`, "i").test(m.body)) return true;
    if (srv && /(^|\s)@(everyone|here)\b/.test(m.body)) return true;
    if (srv) {
      const mine = memberOf(srv, meName())?.roles || [];
      for (const x of m.body.matchAll(/<@&(\d+)>/g)) if (mine.includes(Number(x[1]))) return true;
    }
    return false;
  }

  function messageRow(m, cont, srv, st) {
    const member = srv ? memberOf(srv, m.from) : null;
    const who = m.mine ? core.data.me : { name: m.from, avatar: m.avatar };
    const row = h("div.ls-msg" + (cont ? ".cont" : "") + (mentionsMe(m, srv) ? ".mention" : "") + (m.pinned ? ".pinned" : ""));
    row.title = new Date(m.created).toLocaleString();
    row.dataset.id = m.id;
    if (m.reply) {
      row.append(h("div.ls-reply-ref", { onclick: () => jumpTo(m.reply.id) }, h("span.ls-reply-curve"),
        h("b", { text: m.reply.from ? "@" + displayName(srv, m.reply.from) : "" }), " ",
        h("span.ls-ell", { text: m.reply.deleted ? "Original message was deleted" : previewText(m.reply.body) })));
    }
    const left = cont ? h("div.ls-msg-gutter", null, h("span.ls-msg-time", { text: clock(m.created) }))
      : h("div.ls-msg-av.ls-click", { onclick: (e) => S.manage.profile(m.from, e.currentTarget, srv) }, avatar(who, 38));
    const content = h("div.ls-msg-body.ls-grow");
    if (!cont) {
      const color = topColor(srv, member);
      content.append(h("div.ls-msg-head", null,
        h("b.ls-click", { text: displayName(srv, m.from), style: color ? { color } : null, onclick: (e) => S.manage.profile(m.from, e.currentTarget, srv) }),
        h("span.ls-sub", { text: `${dayLabel(m.created) === "Today" ? "Today at" : new Date(m.created).toLocaleDateString()} ${clock(m.created)}` }),
        m.pinned ? h("span.ls-sub.ls-pinned-ic", { title: "Pinned" }, ic("pin", 13)) : null));
    }
    content.append(messageBody(m, srv, st));
    row.append(h("div.ls-msg-line", null, left, content));
    row.append(messageTools(m, srv, st));
    return row;
  }
  const previewText = (body) => body.startsWith("::img::") ? "Picture" : body.startsWith("::invite::") ? "World invite" : body.startsWith("::ask::") ? "Asked to join" : body;
  function jumpTo(id) {
    const el = msgsEl?.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1500);
  }

  function messageTools(m, srv, st) {
    const tools = h("div.ls-tools");
    const perms = st.perms;
    const inChannel = ui.view.chat.channel != null;
    if (canReact(st)) {
      for (const e of emo.quick(3)) tools.append(btn("ls-tool-emoji", emo.img(e), () => { emo.remember(e); react(m.id, e); }, emo.nameOf(e) ? `React with :${emo.nameOf(e)}:` : "React"));
      tools.append(h("span.ls-tool-sep"));
      tools.append(btn("", ic("smilePlus", 18), (e) => emo.picker(e.currentTarget, (u) => react(m.id, u)), "Add reaction"));
    }
    if (!inChannel || has(perms, P.SEND_MESSAGES)) tools.append(btn("", ic("reply", 18), () => { replyTo = { id: m.id, from: m.from, body: m.body }; paintReply(); composer.input?.focus(); }, "Reply"));
    if (m.mine && !m.body.startsWith("::")) tools.append(btn("", ic("edit", 17), () => { editing = m.id; paintChat(); }, "Edit"));
    if (inChannel && has(perms, P.MANAGE_MESSAGES)) {
      tools.append(btn("", ic(m.pinned ? "pinOff" : "pin", 17), () => core.api("pin", { id: m.id, pinned: !m.pinned }).then(() => loadChat()).catch((e) => toast(e.message, true)), m.pinned ? "Unpin" : "Pin"));
    }
    if (m.mine || (inChannel && has(perms, P.MANAGE_MESSAGES))) {
      tools.append(btn("ls-tool-danger", ic("trash", 17), (e) => {
        if (e.shiftKey || confirm("Delete this message?")) core.api("delete", { id: m.id }).then(() => loadChat()).catch((err) => toast(err.message, true));
      }, "Delete (Shift-click skips the question)"));
    }
    return tools;
  }
  const canReact = (st) => ui.view.chat?.channel == null || has(st?.perms ?? 0, P.ADD_REACTIONS);

  // A floating tooltip (who reacted).
  let tipEl = null;
  function showTip(anchor, content) {
    hideTip();
    tipEl = h("div.ls-tip.ls-theme", { role: "tooltip" }, content);
    document.body.append(tipEl);
    const r = anchor.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    const top = r.top - tipEl.offsetHeight - 8;
    tipEl.style.top = (top < 8 ? r.bottom + 8 : top) + "px";
  }
  function hideTip() { tipEl?.remove(); tipEl = null; }
  function reactTip(r) {
    const me = meName();
    const names = r.names.map((n) => (n === me ? "you" : n));
    const shown = names.slice(0, 12);
    const more = r.n - shown.length;
    let who = shown.length === 1 ? shown[0]
      : more > 0 ? shown.join(", ")
        : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
    if (more > 0) who += ` and ${more} more`;
    who = who.replace(/^you/, "You");
    const name = emo.nameOf(r.emoji);
    return h("div.ls-tip-react", null, emo.img(r.emoji, "ls-emoji-big"),
      h("div", null, h("b", { text: who }), h("span", { text: ` reacted${name ? ` with :${name}:` : ""}` })));
  }
  const react = (id, emoji) => core.api("react", { id, emoji }).then(() => loadChat()).catch((e) => toast(e.message, true));

  // Light markdown: **bold**, *italic*, __underline__, ~~strike~~, `code`,
  // ```code blocks```, links and mentions. Everything is built as DOM text.
  function richText(text, srv) {
    const box = h("div.ls-msg-text");
    const parts = text.split(/(```[\s\S]*?```)/);
    for (const part of parts) {
      if (/^```[\s\S]*```$/.test(part)) { box.append(h("pre.ls-code", { text: part.slice(3, -3).replace(/^\w*\n/, "") })); continue; }
      inline(part, box, srv);
    }
    return box;
  }
  function inline(text, into, srv) {
    const re = /(https?:\/\/[^\s<>"]+)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(<@&\d+>)|(@(?:everyone|here)\b)|(@[A-Za-z0-9_]{3,16}\b)/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > at) emo.render(text.slice(at, m.index), into);
      const t = m[0];
      if (m[1]) into.append(h("a", { href: t, target: "_blank", rel: "noopener noreferrer", text: t }));
      else if (m[2]) into.append(h("code", { text: t.slice(1, -1) }));
      else if (m[3]) inline(t.slice(2, -2), into.appendChild(h("strong")), srv);
      else if (m[4]) inline(t.slice(2, -2), into.appendChild(h("u")), srv);
      else if (m[5]) inline(t.slice(2, -2), into.appendChild(h("s")), srv);
      else if (m[6]) inline(t.slice(1, -1), into.appendChild(h("em")), srv);
      else if (m[7]) {
        const role = srv?.roles.find((r) => r.id === Number(t.slice(3, -1)));
        into.append(h("span.ls-mention", { text: "@" + (role?.name || "deleted-role"), style: role?.color ? { color: role.color } : null }));
      } else if (m[8]) into.append(h("span.ls-mention", { text: t }));
      else into.append(h("span.ls-mention.ls-click", { text: t, onclick: (e) => S.manage.profile(t.slice(1), e.currentTarget, srv) }));
      at = m.index + t.length;
    }
    if (at < text.length) emo.render(text.slice(at), into);
  }

  function messageBody(m, srv, st) {
    const box = h("div");
    if (m.body.startsWith("::img::")) {
      const src = "/api/img/" + m.body.slice(7).replace(/[^0-9a-f]/g, "");
      box.append(h("img.ls-img", { src, alt: "picture", onclick: () => S.manage.lightbox(src), onload: () => { if (stickToBottom && msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight; } }));
    } else if (m.body.startsWith("::invite::")) {
      const code = m.body.slice(10, 16);
      box.append(h("div.ls-invite", null, h("div.ls-invite-art", null, ic("gamepad", 24)),
        h("div.ls-grow", null, h("b", { text: m.mine ? "You sent a world invite" : `${m.from} invited you to their world` }), h("div.ls-sub", { text: "Minecraft" })),
        m.mine ? null : btn("ls-btn.green", "Join", () => ui.joinWorld(m.from, code, "minecraft"))));
    } else if (m.body.startsWith("::ask::")) {
      const code = inviteCode();
      box.append(h("div.ls-invite", null, h("div.ls-invite-art", null, ic("hand", 22)),
        h("div.ls-grow", null, h("b", { text: m.mine ? "You asked to join" : `${m.from} wants to join your world` })),
        !m.mine && code ? btn("ls-btn", "Invite", () => send("::invite::" + code)) : null));
    } else if (editing === m.id) {
      const input = h("textarea.ls-input.ls-edit", { value: m.body, rows: Math.min(8, m.body.split("\n").length + 1) });
      const save = async () => {
        const text = await emo.expand(input.value);
        editing = null;
        try { await core.api("edit", { id: m.id, body: text }); await loadChat(); } catch (err) { toast(err.message, true); paintChat(); }
      };
      input.onkeydown = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); editing = null; paintChat(); }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
      };
      box.append(input, h("div.ls-sub", null, "Enter to save · Esc to cancel"));
      setTimeout(() => { input.focus(); input.selectionStart = input.value.length; }, 0);
    } else {
      const t = richText(m.body, srv);
      if (emo.onlyEmoji(m.body)) t.classList.add("jumbo");
      if (m.edited) t.append(" ", h("span.ls-edited", { text: "(edited)" }));
      box.append(t);
    }
    if (m.reactions.length) {
      const rs = h("div.ls-reacts");
      for (const r of m.reactions) {
        const chip = btn("ls-chip" + (r.mine ? ".mine" : ""), [emo.img(r.emoji), h("span.ls-chip-n", { text: String(r.n) })], () => { hideTip(); react(m.id, r.emoji); });
        chip.setAttribute("aria-label", `${r.n} reaction${r.n > 1 ? "s" : ""}, ${r.emoji}`);
        chip.onmouseenter = chip.onfocus = () => showTip(chip, reactTip(r));
        chip.onmouseleave = chip.onblur = hideTip;
        chip.oncontextmenu = (e) => { e.preventDefault(); showTip(chip, reactTip(r)); };
        rs.append(chip);
      }
      if (canReact(st)) rs.append(btn("ls-chip.add", ic("smilePlus", 16), (e) => emo.picker(e.currentTarget, (u) => react(m.id, u)), "Add reaction"));
      box.append(rs);
    }
    return box;
  }

  function paintTyping() {
    if (!typingEl || !ui.view.chat) return;
    const now = Date.now();
    const names = [...(typing.get(chatKey(ui.view.chat)) || new Map())].filter(([, until]) => until > now).map(([n]) => n);
    typingEl.textContent = names.length ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? " and others" : ""} ${names.length > 1 ? "are" : "is"} typing…` : "";
  }

  // ---- composer (kept across renders so typing never loses focus) ----
  function composerFor(c, st) {
    const key = chatKey(c);
    if (composer.key !== key || !composer.el) {
      if (composer.key && composer.input) drafts.set(composer.key, composer.input.value);
      composer.key = key;
      const input = h("textarea.ls-composer-input", { rows: 1, maxLength: 2000 });
      input.value = drafts.get(key) || "";
      const grow = () => { input.style.height = "auto"; input.style.height = Math.min(200, input.scrollHeight) + "px"; };
      input.oninput = () => { grow(); drafts.set(key, input.value); if (input.value) sendTyping(); autocomplete(input); };
      input.onkeydown = (e) => {
        if (ac.open && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key)) { acKey(e, input); return; }
        if (e.key === "Escape" && replyTo) { replyTo = null; paintReply(); return; }
        if (e.key === "ArrowUp" && !input.value) {
          const last = [...(chats.get(key)?.msgs || [])].reverse().find((m) => m.mine && !m.body.startsWith("::"));
          if (last) { e.preventDefault(); editing = last.id; paintChat(); }
          return;
        }
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        input.value = "";
        drafts.delete(key);
        grow();
        if (!command(body)) send(body);
      };
      input.addEventListener("paste", (e) => {
        const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
        if (!file) return;
        e.preventDefault();
        createImageBitmap(file).then((bmp) => sendPicture(bmp, bmp.width, bmp.height)).catch(() => toast("That picture couldn't be read.", true));
      });
      composer.input = input;
      composer.attach = btn("ls-icon.ls-attach", ic("plus", 18), attachPicture, "Send a picture");
      composer.shot = core.game?.screenshot ? btn("ls-icon", ic("camera", 19), async () => {
        const shot = await core.game.screenshot();
        if (typeof shot === "string") toast(shot, true);
        else if (shot) { toast("Screenshot sent."); sendPicture(shot.source, shot.width, shot.height); }
      }, "Send a screenshot of the game") : null;
      composer.emoji = btn("ls-icon", ic("smile", 19), (e) => emo.picker(e.currentTarget, (u) => insertAtCursor(input, u)), "Emoji");
      composer.box = h("div.ls-composer-box", null, composer.attach, input, composer.shot, composer.emoji);
      replyBar = h("div.ls-reply-bar");
      composer.el = h("div.ls-composer", null, replyBar, composer.box);
      setTimeout(grow, 0);
    }
    composer.input.placeholder = `Message ${chatTitle(c)}`;
    paintReply();
    updateComposerPerms(st);
    if (ui.mode === "page" || ui.open) setTimeout(() => { if (!editing && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") composer.input.focus({ preventScroll: true }); }, 0);
    return composer.el;
  }
  function insertAtCursor(input, text) {
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    input.value = input.value.slice(0, a) + text + input.value.slice(b);
    input.focus();
    input.selectionStart = input.selectionEnd = a + text.length;
    drafts.set(composer.key, input.value);
  }
  function updateComposerPerms(st) {
    if (!composer.input || ui.view.chat?.channel == null) {
      if (composer.input) { composer.input.disabled = false; composer.attach.hidden = false; }
      return;
    }
    const perms = st?.perms ?? channelOf(ui.view.chat.channel)?.perms ?? 0;
    const canSend = has(perms, P.SEND_MESSAGES);
    composer.input.disabled = !canSend;
    if (!canSend) composer.input.placeholder = "You don't have permission to send messages in this channel.";
    composer.attach.hidden = !has(perms, P.ATTACH_FILES);
    if (composer.shot) composer.shot.hidden = !has(perms, P.ATTACH_FILES);
  }
  function paintReply() {
    if (!replyBar) return;
    replyBar.replaceChildren();
    replyBar.hidden = !replyTo;
    if (replyTo) replyBar.append(h("span.ls-grow.ls-ell", null, "Replying to ", h("b", { text: replyTo.from })), btn("ls-x", ic("x", 16), () => { replyTo = null; paintReply(); }, "Cancel reply"));
  }

  // @mention autocomplete.
  const ac = { open: false, items: [], index: 0, start: 0, el: null };
  function mentionCandidates() {
    const c = ui.view.chat;
    if (c.channel != null) {
      const srv = currentServer();
      const out = (srv?.members || []).map((m) => ({ label: m.nick ? `${m.nick} (${m.name})` : m.name, insert: "@" + m.name + " ", key: (m.nick || "") + " " + m.name, av: m }));
      for (const r of srv?.roles || []) if (!r.everyone && (r.mentionable || has(srv.perms, P.MENTION_EVERYONE))) out.push({ label: "@" + r.name, insert: `<@&${r.id}> `, key: r.name, role: r });
      if (has(channelOf(c.channel)?.perms || 0, P.MENTION_EVERYONE)) out.push({ label: "@everyone", insert: "@everyone ", key: "everyone" });
      return out;
    }
    const names = c.party != null ? (core.data.parties.find((p) => p.id === c.party)?.members || []).map((m) => m.name) : [c.dm];
    return names.map((n) => ({ label: n, insert: "@" + n + " ", key: n, av: { name: n } }));
  }
  function autocomplete(input) {
    const upto = input.value.slice(0, input.selectionStart);
    // "/" at the start: the commands you can use here.
    const cm = upto.match(/^\/([a-z]*)$/i);
    if (cm) {
      ac.items = COMMANDS.filter((x) => x.name.startsWith(cm[1].toLowerCase()) && x.can(ui.view.chat))
        .map((x) => ({ label: `/${x.name} ${x.args}`, insert: `/${x.name} `, key: x.name, hint: x.hint, cmd: true }));
      if (!ac.items.length) return closeAc();
      ac.start = 0;
      ac.index = 0;
      ac.open = true;
      paintAc(input);
      return;
    }
    const em =upto.match(/(?:^|[\s([{])(:([a-z0-9_+-]{2,32}))$/i);
    if (em) {
      if (!emo.ready) { emo.load().then(() => { if (document.activeElement === input) autocomplete(input); }).catch(() => {}); return closeAc(); }
      ac.items = emo.search(em[2], 8).map((e) => ({ label: `:${e.sc[0]}:`, insert: e.u, emoji: e.u, hint: e.name }));
      if (!ac.items.length) return closeAc();
      ac.start = upto.length - em[1].length;
      ac.index = 0;
      ac.open = true;
      paintAc(input);
      return;
    }
    const m = upto.match(/(^|\s)@([A-Za-z0-9_]{0,16})$/);
    if (!m) return closeAc();
    const q = m[2].toLowerCase();
    ac.items = mentionCandidates().filter((x) => x.key.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || x.key.toLowerCase().includes(q)).slice(0, 8);
    if (!ac.items.length) return closeAc();
    ac.start = upto.length - m[2].length - 1;
    ac.index = 0;
    ac.open = true;
    paintAc(input);
  }
  function paintAc(input) {
    ac.el?.remove();
    ac.el = h("div.ls-ac");
    ac.items.forEach((it, i) => ac.el.append(h("div.ls-ac-item" + (i === ac.index ? ".on" : ""), { onmousedown: (e) => { e.preventDefault(); ac.index = i; pickAc(input); } },
      it.emoji ? emo.img(it.emoji) : it.av ? avatar(it.av, 20) : h("span.ls-side-icon", null, it.cmd ? "/" : "@"), h("span", { text: it.label, style: it.role?.color ? { color: it.role.color } : null }),
      it.hint ? h("span.ls-sub.ls-ac-hint", { text: it.hint }) : null)));
    ac.el.prepend(h("div.ls-ac-title", { text: ac.items[0]?.emoji ? "Emoji" : ac.items[0]?.cmd ? "Commands" : "Members" }));
    composer.el.append(ac.el);
  }
  function closeAc() { ac.open = false; ac.el?.remove(); ac.el = null; }
  function pickAc(input) {
    const it = ac.items[ac.index];
    const end = input.selectionStart;
    input.value = input.value.slice(0, ac.start) + it.insert + input.value.slice(end);
    input.selectionStart = input.selectionEnd = ac.start + it.insert.length;
    drafts.set(composer.key, input.value);
    closeAc();
  }
  function acKey(e, input) {
    e.preventDefault();
    if (e.key === "ArrowDown") ac.index = (ac.index + 1) % ac.items.length;
    else if (e.key === "ArrowUp") ac.index = (ac.index + ac.items.length - 1) % ac.items.length;
    else if (e.key === "Escape") return closeAc();
    else return pickAc(input);
    paintAc(input);
  }

  // ---- calls: the stage, the voice panel and the ringing card ----
  const speakKey = (conn) => (conn === core.conn ? "me" : conn);
  const videoEls = new Map(); // tile key -> <video>, kept between renders so playback doesn't restart
  let renderAfterFullscreen = false;
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && renderAfterFullscreen) { renderAfterFullscreen = false; render(); } });
  core.on("voice-speaking", () => {
    for (const el of document.querySelectorAll("[data-vspeak]")) el.classList.toggle("speaking", voice.speaking.has(el.dataset.vspeak));
  });
  function callTime() {
    if (!voice.since) return "";
    const s = Math.floor((Date.now() - voice.since) / 1000);
    const mm = Math.floor(s / 60) % 60;
    return (s >= 3600 ? Math.floor(s / 3600) + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(s % 60).padStart(2, "0");
  }
  setInterval(() => { if (voice.room) for (const el of document.querySelectorAll("[data-vtimer]")) el.textContent = callTime(); }, 1000);

  function videoEl(key, stream, mirror) {
    let el = videoEls.get(key);
    if (!el) {
      el = h("video.ls-tile-video", { autoplay: true, playsInline: true, muted: true });
      videoEls.set(key, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.classList.toggle("mirror", !!mirror);
    return el;
  }
  function fullscreen(el) {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }
  const personOf = (name, srv) => (srv && memberOf(srv, name)) || core.data.friends.find((f) => f.name === name)
    || (name === meName() ? core.data.me : null) || core.data.dms?.find((f) => f.name === name) || { name };
  const peerQuality = (p) => (!p || p.state !== "connected" ? 0 : p.rtt == null || p.rtt < 150 ? 3 : p.rtt < 300 ? 2 : 1);
  const peerRoute = (p) => (p ? `${p.relayed ? "Through the relay" : "Direct connection"}${p.rtt != null ? ` · ${p.rtt} ms` : ""}` : "");
  const bars = (q, title) => h("span.ls-bars.q" + q, { title }, h("i"), h("i"), h("i"));

  /** Whether this tab's call (or the one it's joining) belongs to this DM or group. */
  function callIsHere(c) {
    const t = voice.target;
    if (!t || c.channel != null || (!voice.room && !voice.joining && !voice.reconnecting)) return false;
    return c.party != null ? t.party === c.party : t.with === c.dm;
  }
  function callStatus() {
    if (voice.reconnecting) return { cls: "warn", text: "Reconnecting…" };
    if (voice.joining || !voice.room) return { cls: "warn", text: "Connecting…" };
    if (voice.calling()) return { cls: "ring", text: `Calling ${voice.target.with}…` };
    const peers = [...voice.peers.values()];
    if (peers.some((p) => p.state === "failed")) return { cls: "bad", text: "Partly connected" };
    if (peers.some((p) => p.state !== "connected")) return { cls: "warn", text: "Connecting…" };
    return { cls: "ok", text: voice.target?.channel != null ? "Voice Connected" : "In Call" };
  }
  function openCall() {
    const t = voice.target;
    if (!t) return;
    if (t.channel != null && voice.server != null) ui.openServer(voice.server, t.channel);
    else if (t.party != null) ui.openChat({ party: t.party });
    else if (t.with) ui.openDm(t.with);
  }

  /** Tiles for a call: each person, plus one per shared screen. */
  function stageTiles(members, inCall) {
    const list = [...members];
    if (inCall && !list.some((m) => m.conn === core.conn)) list.push({ conn: core.conn, name: meName(), since: Infinity, joining: true });
    const tiles = [];
    for (const m of list) {
      const self = m.conn === core.conn;
      tiles.push({ key: m.conn + ":cam", m, self, kind: "person", stream: inCall ? voice.video(m.conn, "cam") : null });
      const screen = inCall ? voice.video(m.conn, "screen") : null;
      if (screen || (inCall && voice.videoPending(m.conn, "screen")) || (!inCall && m.screen)) tiles.push({ key: m.conn + ":screen", m, self, kind: "screen", stream: screen });
    }
    return tiles;
  }
  const spotted = new Set(); // screens that were put in the spotlight when they started
  function stageTile(t, o, small) {
    const { m, self, kind, stream } = t;
    const p = self ? null : voice.peers.get(m.conn);
    const name = o.srv ? displayName(o.srv, m.name) : m.name;
    const tile = h("div.ls-tile" + (kind === "screen" ? ".screen" : "") + (stream ? ".has-video" : ""), {
      title: stream ? "Click to focus · double-click for full screen" : undefined,
      onclick: () => { ui.spot = ui.spot === t.key ? null : t.key; render(); },
      ondblclick: (e) => { if (stream) fullscreen(e.currentTarget); },
    });
    tile.style.setProperty("--hue", hue(m.name));
    if (kind === "person" && o.inCall) {
      tile.dataset.vspeak = speakKey(m.conn);
      if (voice.speaking.has(speakKey(m.conn))) tile.classList.add("speaking");
    }
    if (stream) tile.append(videoEl(t.key, stream, self && kind === "person"));
    else {
      const wait = kind === "screen" ? (o.inCall ? "Starting the stream…" : "Sharing their screen") : o.inCall && voice.videoPending(m.conn, "cam") ? "Starting video…" : "";
      tile.append(h("div.ls-tile-center", null,
        kind === "screen" ? h("div.ls-tile-screen-ic", null, ic("screenShare", small ? 22 : 34)) : avatar(personOf(m.name, o.srv), small ? 40 : o.full || ui.stageBig ? 96 : 72),
        wait ? h("div.ls-tile-wait", { text: wait }) : null));
    }
    if (kind === "screen") tile.append(h("span.ls-live", { text: "LIVE" }));
    const deaf = m.deaf || (self && voice.deaf);
    const muted = kind === "person" && (m.smute || deaf || m.muted || (self && voice.muted));
    tile.append(h("div.ls-tile-name", null,
      kind === "screen" ? ic("screenShare", 14) : muted ? h("span.ls-tile-mic", { title: deaf ? "Deafened" : "Muted" }, ic(deaf ? "headphonesOff" : "micOff", 14)) : null,
      h("span.ls-ell", { text: kind === "screen" ? (self ? "Your screen" : `${name}'s screen`) : self ? `${name} (you)` : name })));
    // Connection state, top right: bars when it's up, a chip while it isn't.
    const corner = h("div.ls-tile-corner");
    if (p && kind === "person") {
      if (p.state === "connected") corner.append(bars(peerQuality(p), peerRoute(p)));
      else if (p.state === "failed") {
        corner.append(h("span.ls-tile-chip.bad", { text: "Can't connect" }),
          btn("ls-tile-chip.act", [ic("refresh", 13), "Retry"], () => voice.retryPeer(m.conn), "Try to connect again"));
      } else corner.append(h("span.ls-tile-chip", { text: p.state === "relay" ? "Trying the relay…" : p.state === "reconnecting" ? "Reconnecting…" : "Connecting…" }));
    } else if (o.inCall && voice.room && !self && kind === "person" && !p) corner.append(h("span.ls-tile-chip", { text: "Connecting…" }));
    if (m.joining) corner.append(h("span.ls-tile-chip", { text: voice.reconnecting ? "Reconnecting…" : "Joining…" }));
    tile.append(corner);
    const tools = h("div.ls-tile-tools");
    if (stream) tools.append(btn("ls-tile-tool", ic("maximize", 15), (e) => fullscreen(e.currentTarget.closest(".ls-tile")), "Full screen"));
    if (o.inCall && voice.room && !self && kind === "person") tools.append(btn("ls-tile-tool", ic("more", 16), (e) => tileMenu(e.currentTarget, m, o), "More"));
    if (tools.childNodes.length) tile.append(tools);
    return tile;
  }
  /** Someone in a DM who isn't in the call (yet). */
  function ghostTile(name, o) {
    const calling = voice.calling();
    const tile = h("div.ls-tile.ghost" + (calling ? ".calling" : ""), null,
      h("div.ls-tile-center", null, h("div.ls-ringer", null, avatar(personOf(name), o.full || ui.stageBig ? 96 : 72)),
        h("div.ls-tile-wait", { text: calling ? "Ringing…" : "Not in the call" }),
        !calling && voice.room ? btn("ls-btn.small.green", [ic("phone", 14), "Ring"], () => voice.ring(), `Ring ${name}`) : null),
      h("div.ls-tile-name", null, h("span.ls-ell", { text: name })));
    tile.style.setProperty("--hue", hue(name));
    return tile;
  }
  function tileMenu(anchor, m, o) {
    const box = h("div.ls-menu.static.ls-tile-menu");
    const item = (icon, label, run, cls = "") => h("button.ls-menu-item" + cls, { type: "button", onclick: () => { pop.remove(); run(); } }, ic(icon, 16), h("span.ls-grow", { text: label }));
    box.append(h("div.ls-sect", { text: `Volume · ${m.name}` }),
      h("input.ls-range.wide", { type: "range", min: 0, max: 1, step: 0.05, value: voice.volume(m.name), oninput: (e) => voice.setVolume(m.name, Number(e.target.value)) }),
      item("refresh", "Reconnect", () => voice.retryPeer(m.conn)),
      item("user", "Profile", () => S.manage.profile(m.name, anchor, o.srv || null)));
    if (o.kind === "channel" && has(o.ch.perms, P.MUTE_MEMBERS)) {
      box.append(item("micOff", m.smute ? "Server unmute" : "Server mute",
        () => core.api("voice_mute", { channel: o.ch.id, name: m.name, muted: !m.smute }).catch((e) => toast(e.message, true)), ".danger"));
    }
    const pop = S.manage.popover(anchor, box);
  }
  async function deviceMenu(anchor) {
    const list = await voice.listDevices();
    const box = h("div.ls-menu.static.ls-dev-menu");
    const pick = (kind, devKind, label) => {
      const opts = list.filter((d) => d.kind === devKind && d.deviceId);
      return h("label.ls-dev-row", null, h("span.ls-sect", { text: label }),
        h("select.ls-input", { onchange: (e) => voice.setDevice(kind, e.target.value) },
          h("option", { value: "", text: "Default" }),
          ...opts.map((d, i) => h("option", { value: d.deviceId, text: d.label || `${label} ${i + 1}`, selected: d.deviceId === voice.device(kind) }))));
    };
    box.append(pick("mic", "audioinput", "Microphone"));
    if (voice.canVideo()) box.append(pick("cam", "videoinput", "Camera"));
    box.append(h("p.ls-sub.ls-dev-note", { text: "Calls are peer-to-peer: nothing is recorded or stored." }));
    S.manage.popover(anchor, box);
  }
  function callNotes() {
    const out = [];
    const note = (icon, text, kind, action) => out.push(h("div.ls-stage-note." + kind, null, ic(icon, 15), h("span.ls-grow", { text }), action || null));
    if (voice.needsClick) note("volume", "Click anywhere to turn on call sound.", "info");
    if (voice.micError) note("micOff", voice.micError, "warn", btn("ls-link", "Try again", () => voice.retryMic()));
    if (voice.camError) note("videoOff", voice.camError, "warn", btn("ls-x", ic("x", 14), () => { voice.camError = ""; render(); }, "Dismiss"));
    const failed = [...voice.peers.values()].filter((p) => p.state === "failed").map((p) => p.name);
    if (failed.length) {
      note("wifiOff", `Can't reach ${failed.join(", ")}. A network between you blocks direct calls (common on school or work Wi-Fi)${voice.relayError ? `, and the relay isn't available: ${voice.relayError}` : "."}`, "bad");
    }
    const self = voice.members.find((m) => m.conn === core.conn);
    if (self?.smute) note("micOff", "A moderator server-muted you.", "warn");
    else if (self && self.speak === false) note("micOff", "You can listen here but not talk.", "info");
    if (core.pref("ptt") && voice.room) note("mic", voice.pttDown ? "Talking…" : `Push to talk: hold ${core.keyLabel(core.pref("pttKey"))}`, "info");
    return out.length ? h("div.ls-stage-notes", null, out) : null;
  }
  const dockBtn = (icon, label, run, state, disabled) => btn("ls-dock-btn" + (state ? "." + state : ""), ic(icon, 21), run, label, { disabled: !!disabled });
  function callDock() {
    const can = voice.canSend() && !!voice.room;
    return h("div.ls-dock", null,
      dockBtn(voice.muted ? "micOff" : "mic", voice.muted ? "Unmute" : "Mute", () => voice.toggleMute(), voice.muted ? "off" : ""),
      dockBtn(voice.deaf ? "headphonesOff" : "headphones", voice.deaf ? "Undeafen" : "Deafen", () => voice.toggleDeaf(), voice.deaf ? "off" : ""),
      voice.canVideo() ? dockBtn("video", voice.cam ? "Turn off camera" : "Turn on camera", () => voice.toggleCam(), voice.cam ? "on" : "", !can) : null,
      voice.canShare() ? dockBtn("screenShare", voice.screen ? "Stop sharing" : "Share your screen", () => voice.toggleScreen(), voice.screen ? "on" : "", !can) : null,
      dockBtn("settings", "Microphone and camera", (e) => deviceMenu(e.currentTarget)),
      h("span.ls-dock-sep"),
      btn("ls-dock-leave", [ic("phoneOff", 24), h("span", { text: voice.room ? "Leave" : "Cancel" })], () => voice.leave(), "Leave the call"));
  }
  function joinBar(o) {
    const bar = h("div.ls-dock.join");
    if (o.kind === "channel" && !has(o.ch.perms, P.CONNECT)) { bar.append(h("div.ls-sub", { text: "You can't join this voice channel." })); return bar; }
    const join = (video) => (o.kind === "channel" ? joinVoiceChannel(o.srv, o.ch, video) : voice.join(o.target, o.label, null, { video, ring: !o.members.length }));
    bar.append(btn("ls-btn.green.ls-join", [ic("phone", 18), voice.joining ? "Joining…" : o.kind === "channel" ? "Join Voice" : "Join Call"], () => join(false), null, { disabled: voice.joining }));
    if (voice.canVideo()) bar.append(btn("ls-btn.grey.ls-join-alt", [ic("video", 18), "With camera"], () => join(true), "Join with your camera on", { disabled: voice.joining }));
    if (o.kind === "channel") bar.append(h("div.ls-sub.ls-join-note", { text: "Peer-to-peer · up to 8 people · nothing is recorded" }));
    return bar;
  }
  /**
   * The call area: o = {kind: "dm"|"party"|"channel", members, inCall, target,
   * label, c (chat), ch + srv (voice channel), full (fills the view)}.
   */
  function callStage(o) {
    const tiles = stageTiles(o.members, o.inCall);
    const screens = new Set(tiles.filter((t) => t.kind === "screen" && t.stream && !t.self).map((t) => t.key));
    for (const key of spotted) if (!screens.has(key)) spotted.delete(key);
    for (const key of screens) if (!spotted.has(key)) { spotted.add(key); if (!ui.spot) ui.spot = key; } // a new screen share takes the spotlight
    const spot = tiles.find((t) => t.key === ui.spot);
    const video = tiles.some((t) => t.stream);
    const stage = h("section.ls-stage" + (o.full ? ".full" : ui.stageBig ? ".big" : "") + (video ? ".has-video" : ""), { "aria-label": "Call" });
    const top = h("div.ls-stage-top");
    if (o.inCall) {
      const st = callStatus();
      top.append(h("span.ls-stage-chip." + st.cls, null, h("span.ls-stage-dot"), st.text), h("span.ls-stage-time", { "data-vtimer": "1", text: callTime() }));
    } else {
      top.append(h("span.ls-stage-chip.idle", null, h("span.ls-stage-dot"), o.members.length ? `${o.members.length} in ${o.kind === "channel" ? "voice" : "the call"}` : "Nobody's here yet"));
    }
    top.append(h("span.ls-grow"));
    if (!o.full) top.append(btn("ls-stage-btn", ic(ui.stageBig ? "shrink" : "grow", 16), () => { ui.stageBig = !ui.stageBig; render(); }, ui.stageBig ? "Make the call smaller" : "Make the call bigger"));
    stage.append(top);
    if (o.inCall) { const notes = callNotes(); if (notes) stage.append(notes); }
    const ghosts = o.kind === "dm" && o.inCall && !o.members.some((m) => m.name === o.c.dm) ? [ghostTile(o.c.dm, o)] : [];
    const body = h("div.ls-stage-body");
    if (spot) {
      const rest = tiles.filter((t) => t !== spot);
      body.append(h("div.ls-stage-spot", null, stageTile(spot, o, false),
        rest.length || ghosts.length ? h("div.ls-stage-film", null, ...rest.map((t) => stageTile(t, o, true)), ...ghosts) : null));
    } else {
      const n = tiles.length + ghosts.length;
      const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
      const grid = h("div.ls-stage-grid", null, ...tiles.map((t) => stageTile(t, o, false)), ...ghosts);
      // Half-width columns so a short last row can sit in the middle.
      grid.style.gridTemplateColumns = `repeat(${cols * 2}, minmax(0, 1fr))`;
      const rem = n % cols;
      if (rem) grid.children[n - rem].style.gridColumnStart = cols - rem + 1;
      if (!o.full && !ui.stageBig) grid.style.maxWidth = cols * (video ? 520 : 400) + "px";
      if (!n) grid.append(h("div.ls-stage-empty", { text: o.kind === "channel" ? "No one's in this voice channel yet." : "No one's in the call." }));
      body.append(grid);
    }
    stage.append(body, o.inCall ? callDock() : joinBar(o));
    return stage;
  }
  /** The call stage above a DM or group chat, when it has a call. */
  function chatCall(c) {
    if (c.channel != null) return null;
    const here = callIsHere(c);
    const members = here && voice.room ? voice.members : voiceRooms.get(chatKey(c)) || [];
    if (!members.length && !here) return null;
    const label = c.dm || core.data.parties.find((p) => p.id === c.party)?.name || "Call";
    return callStage({ kind: c.party != null ? "party" : "dm", c, members, inCall: here, target: target(c), label });
  }

  function voicePanel() {
    if (!voice.room && !voice.joining && !voice.reconnecting && !voice.error) return h("div");
    const box = h("div.ls-voice-panel");
    if (voice.error && !voice.room && !voice.joining && !voice.reconnecting) {
      box.append(h("div.ls-voice-err", null, ic("wifiOff", 16), h("span.ls-grow", { text: voice.error }), btn("ls-x", ic("x", 16), () => { voice.error = ""; render(); }, "Dismiss")));
      return box;
    }
    const st = callStatus();
    box.classList.add(st.cls);
    const only = voice.peers.size === 1 ? [...voice.peers.values()][0] : null;
    box.append(h("div.ls-voice-top", null,
      h("div.ls-voice-state", null, bars(st.cls === "ok" ? voice.quality() : 0, only ? peerRoute(only) : "Connection"), h("span", { text: st.text })),
      h("span.ls-voice-time", { "data-vtimer": "1", text: callTime() })),
      h("button.ls-voice-where.ls-ell", { type: "button", title: "Go to the call", onclick: openCall, text: voice.label }));
    const can = voice.canSend() && !!voice.room;
    box.append(h("div.ls-voice-acts", null,
      voice.canVideo() ? btn("ls-vbtn" + (voice.cam ? ".on" : ""), ic("video", 18), () => voice.toggleCam(), voice.cam ? "Turn off camera" : "Turn on camera", { disabled: !can }) : null,
      voice.canShare() ? btn("ls-vbtn" + (voice.screen ? ".on" : ""), ic("screenShare", 18), () => voice.toggleScreen(), voice.screen ? "Stop sharing" : "Share your screen", { disabled: !can }) : null,
      btn("ls-vbtn.leave", ic("phoneOff", 21), () => voice.leave(), voice.room ? "Disconnect" : "Cancel")));
    const failed = [...voice.peers.values()].filter((p) => p.state === "failed").map((p) => p.name);
    if (voice.micError) box.append(h("div.ls-voice-note", null, "Microphone unavailable. ", btn("ls-link", "Try again", () => voice.retryMic())));
    if (failed.length) box.append(h("div.ls-voice-note", { text: `Can't reach ${failed.join(", ")}.` }));
    const self = voice.members.find((m) => m.conn === core.conn);
    if (self?.smute) box.append(h("div.ls-voice-note", { text: "A moderator server-muted you." }));
    if (core.pref("ptt") && voice.room) box.append(h("div.ls-voice-note.info", { text: voice.pttDown ? "Talking…" : `Push to talk: hold ${core.keyLabel(core.pref("pttKey"))}` }));
    return box;
  }

  // Someone is calling: a card on top of everything, in games too.
  let ringHost = null;
  let ringShown = null;
  function paintRing() {
    const c = voice.incoming;
    if (c === ringShown) return;
    ringShown = c;
    if (!c || !core.data) { ringHost?.remove(); ringHost = null; ringShown = null; return; }
    if (!ringHost) {
      ringHost = h("div.ls-ring-host.ls-theme");
      for (const type of ["keydown", "keyup", "mousedown", "mouseup", "pointerdown", "wheel", "contextmenu"]) ringHost.addEventListener(type, (e) => e.stopPropagation());
      document.body.append(ringHost);
    }
    const group = c.party != null ? voice.callName(c) : null;
    const act = (cls, icon, label, run) => h("div.ls-ring-act", null, btn("ls-ring-btn." + cls, ic(icon, icon === "phoneOff" ? 30 : 24), run, label), h("span", { text: label }));
    ringHost.replaceChildren(h("div.ls-ring", { role: "alertdialog", "aria-label": `${c.from} is calling` },
      h("div.ls-ring-av", null, h("span.ls-ring-wave"), h("span.ls-ring-wave.b"), avatar(personOf(c.from), 88)),
      h("div.ls-ring-kicker", { text: group ? "Incoming group call" : "Incoming call" }),
      h("div.ls-ring-name", { text: group || c.from }),
      h("div.ls-sub", { text: group ? `${c.from} started a call` : core.myStatus() === "dnd" ? "Silent: you're on Do Not Disturb" : "wants to talk" }),
      document.pointerLockElement ? h("div.ls-sub.ls-ring-hint", { text: "Press Esc to use your mouse" }) : null,
      h("div.ls-ring-acts", null,
        act("decline", "phoneOff", "Decline", () => voice.decline()),
        voice.canVideo() ? act("video", "video", "Video", () => voice.accept(true)) : null,
        act("accept", "phone", "Answer", () => voice.accept(false)))));
  }

  // ---- voice channel view ----
  function voiceChannelView(menuBtn) {
    const srv = currentServer();
    const ch = channelOf(ui.view.voice);
    const head = h("div.ls-main-head", null, menuBtn, h("span.ls-side-icon", null, ic("volume", 20)), h("b", { text: ch?.name || "" }), h("span.ls-grow"),
      btn("ls-icon" + (ui.showMembers ? ".on" : ""), ic("users", 19), () => { ui.showMembers = !ui.showMembers; render(); }, "Member list"));
    if (!ch) return [head, h("div.ls-main-body")];
    const inCall = voice.room === "c" + ch.id || (!!voice.target && voice.target.channel === ch.id && (voice.joining || voice.reconnecting));
    const members = voice.room === "c" + ch.id ? voice.members : voiceRooms.get("c" + ch.id) || [];
    return [head, callStage({ kind: "channel", ch, srv, members, inCall, full: true, target: { channel: ch.id }, label: ch.name })];
  }

  // ---- member list / profile column ----
  function renderMembers() {
    if (!ui.showMembers) return null;
    const c = ui.view.chat;
    if (ui.view.kind === "server" && (c?.channel != null || ui.view.voice)) {
      const srv = currentServer();
      if (!srv) return null;
      const col = h("aside.ls-members");
      const groups = new Map();
      const hoisted = srv.roles.filter((r) => r.hoist && !r.everyone).sort((a, b) => b.position - a.position);
      const online = [];
      const offline = [];
      for (const m of srv.members) {
        if (m.status === "offline") { offline.push(m); continue; }
        const role = hoisted.find((r) => m.roles.includes(r.id));
        if (role) { if (!groups.has(role.id)) groups.set(role.id, []); groups.get(role.id).push(m); } else online.push(m);
      }
      const byName = (a, b) => (a.nick || a.name).localeCompare(b.nick || b.name);
      const section = (label, list, color) => {
        if (!list.length) return;
        col.append(h("div.ls-sect", { text: `${label} — ${list.length}`, style: color ? { color } : null }));
        for (const m of list.sort(byName)) {
          const color2 = topColor(srv, m);
          col.append(h("div.ls-member" + (m.status === "offline" ? ".off" : ""), { onclick: (e) => S.manage.profile(m.name, e.currentTarget, srv) },
            avatar(m, 32, m.status), h("div.ls-grow.ls-ell", null,
              h("div.ls-ell", null, h("span", { text: m.nick || m.name, style: color2 ? { color: color2 } : null }), m.owner ? h("span.ls-crown", { title: "Server owner" }, ic("crown", 13)) : null),
              m.status !== "offline" && m.game ? h("div.ls-sub.ls-ell", { text: [`Playing ${core.gameName(m.game)}`, m.activity].filter(Boolean).join(" · ") }) : null)));
        }
      };
      for (const r of hoisted) section(r.name, groups.get(r.id) || [], null);
      section("Online", online);
      section("Offline", offline);
      return col;
    }
    if (c?.party != null) {
      const p = core.data.parties.find((x) => x.id === c.party);
      if (!p) return null;
      const col = h("aside.ls-members");
      col.append(h("div.ls-sect", { text: `Members — ${p.members.length + 1}` }));
      const all = [{ ...core.data.me, status: core.shownStatus(), owner: p.mine }, ...p.members];
      for (const m of all) {
        col.append(h("div.ls-member" + (m.status === "offline" ? ".off" : ""), { onclick: (e) => S.manage.profile(m.name, e.currentTarget, null) },
          avatar(m, 32, m.status), h("div.ls-grow.ls-ell", null, h("div.ls-ell", null, m.name, m.owner ? h("span.ls-crown", { title: "Group owner" }, ic("crown", 13)) : null),
            m.status !== "offline" && m.game ? h("div.ls-sub.ls-ell", { text: statusText(m) }) : null),
          m.worldCode && m.playingWith !== meName() && m.name !== meName() ? btn("ls-btn.green.small", "Join", () => ui.joinWorld(m.name, m.worldCode, m.game || "minecraft")) : null));
      }
      const addable = core.data.friends.filter((f) => !p.members.some((m) => m.name === f.name));
      if (addable.length) col.append(btn("ls-btn.small.grey.wide", "Add friends", () => S.manage.addToGroup(p, addable)));
      col.append(btn("ls-btn.small.red.wide", "Leave group", () => {
        if (confirm(`Leave ${p.name}?`)) core.run("party_leave", { id: p.id }).then(() => ui.openHome()).catch((e) => toast(e.message, true));
      }));
      return col;
    }
    if (c?.dm) {
      const col = h("aside.ls-members.ls-profile-col");
      col.append(S.manage.profileCard(c.dm, null, true));
      return col;
    }
    return null;
  }

  // ---- mounting ----
  ui.mount = (el, opts = {}) => {
    ui.mode = opts.mode || "page";
    if (ui.mode === "overlay") {
      ui.host = h("div.ls-overlay.ls-theme", { role: "dialog", "aria-label": "Social" });
      ui.root = h("div.ls-social");
      ui.host.append(ui.root);
      ui.fab = btn("ls-fab.ls-theme", "", () => ui.show(!ui.open), "Social");
      ui.open = false;
      document.body.append(ui.fab, ui.host);
      // Keep typing and clicks inside the overlay away from the game.
      for (const type of ["keydown", "keyup", "keypress", "mousedown", "mouseup", "wheel", "contextmenu", "pointerdown"]) {
        ui.host.addEventListener(type, (e) => e.stopPropagation());
        ui.fab.addEventListener(type, (e) => e.stopPropagation());
      }
      ui.host.addEventListener("keydown", (e) => { if (e.key === "Escape" && !editing && !ac.open && !document.querySelector(".ls-modal")) ui.show(false); });
      ui.host.addEventListener("mousedown", (e) => { if (e.target === ui.host) ui.show(false); });
      installHotkey();
      document.addEventListener("pointerlockchange", renderOverlayChrome);
    } else {
      ui.host = el;
      ui.root = h("div.ls-social");
      el.replaceChildren(ui.root);
    }
    render();
  };
  ui.show = (open) => {
    ui.open = open;
    if (open) {
      core.syncSoon(0);
      if (ui.view.chat) loadChat();
      if (ui.view.server) refreshServerSoon(ui.view.server, 0);
      core.game?.onShow?.();
    } else core.game?.onHide?.();
    render();
  };
  function renderOverlayChrome() {
    const locked = !!document.pointerLockElement;
    const unread = core.unreadTotal();
    ui.host.hidden = !ui.open || locked;
    ui.fab.hidden = locked || !core.boot;
    ui.fab.replaceChildren(core.data?.me ? avatar(core.data.me, 28, core.shownStatus()) : ic("chat", 20),
      h("span", { text: "Social" }), h("kbd", { text: core.keyLabel(core.pref("hotkey")) }), ...(unread ? [h("span.ls-pill.inline", { text: String(unread) })] : []));
    if (voice.room) ui.fab.classList.add("in-voice"); else ui.fab.classList.remove("in-voice");
  }

  // Hotkey for the overlay (default P, set in settings).
  let swallowUp = null;
  const editable = (t) => t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function installHotkey() {
    addEventListener("keydown", (e) => {
      if (S.binding) return;
      if (e.code !== core.pref("hotkey") || e.repeat || e.ctrlKey || e.altKey || e.metaKey || editable(e.target) || !core.boot) return;
      if (core.game?.hotkeyBlocked?.() && !ui.open) return;
      e.preventDefault();
      e.stopPropagation();
      swallowUp = e.code;
      if (document.pointerLockElement) document.exitPointerLock();
      ui.show(!ui.open);
    }, true);
    addEventListener("keyup", (e) => {
      if (e.code !== swallowUp) return;
      swallowUp = null;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  // Title badge for unread things.
  const baseTitle = document.title;
  core.on("state", () => {
    const n = core.unreadTotal();
    document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  });
  document.addEventListener("click", () => {
    if (ui.statusMenu) { ui.statusMenu = false; render(); }
  });

  ui.helpers = { h, btn, avatar, serverIcon, statusText, activityText, playTime, P, has, STATUS_LABEL, richText, orderedChannels, displayName, topColor, memberOf, currentServer, refreshServer };
})();
