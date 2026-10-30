// Emoji for chat: Twemoji pictures in messages and reactions, Discord-style
// :shortcodes:, and the emoji picker. Pictures come from Twemoji (CC-BY 4.0)
// and names/shortcodes from emojibase-data (MIT), both on jsDelivr. The
// emoji list is only downloaded when the picker or :autocomplete: is used.
(() => {
  const S = (globalThis.LauncherSocial ||= {});
  if (S.emoji) return;
  const TWEMOJI = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/";
  const DATA = "https://cdn.jsdelivr.net/npm/emojibase-data@15.3.2/en/";
  const RECENT_STORE = "launcher_emoji_recent";
  const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👀"];
  const GROUPS = [
    [0, "Smileys", "😀"], [1, "People", "👋"], [3, "Nature", "🐻"], [4, "Food", "🍔"],
    [5, "Travel", "🚗"], [6, "Activities", "⚽"], [7, "Objects", "💡"], [8, "Symbols", "❤️"], [9, "Flags", "🏁"],
  ];
  // One emoji: a flag pair, a keycap, or pictographs joined by ZWJ with
  // optional variation selectors and skin tones.
  const ONE = "(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*)*)";
  const EMOJI_RE = new RegExp(ONE, "gu");
  const ONLY_EMOJI_RE = new RegExp(`^(?:\\s*${ONE})+\\s*$`, "u");

  /** Twemoji's file name: code points in hex, without FE0F unless it's a ZWJ sequence. */
  function code(str) {
    const s = str.includes("‍") ? str : str.replace(/️/g, "");
    return [...s].map((ch) => ch.codePointAt(0).toString(16)).join("-");
  }
  function img(str, cls = "ls-emoji") {
    const el = document.createElement("img");
    el.className = cls;
    el.alt = str;
    el.draggable = false;
    el.decoding = "async";
    el.src = TWEMOJI + code(str) + ".svg";
    el.onerror = () => el.replaceWith(document.createTextNode(str));
    return el;
  }
  /** Appends text to an element with emoji drawn as Twemoji pictures. */
  function render(text, into) {
    let at = 0;
    for (const m of text.matchAll(EMOJI_RE)) {
      if (m.index > at) into.append(text.slice(at, m.index));
      // Plain © ® ™ and the like stay as text.
      if (m[0].length === 1 && m[0].charCodeAt(0) < 0x2100) into.append(m[0]);
      else into.append(img(m[0]));
      at = m.index + m[0].length;
    }
    if (at < text.length) into.append(text.slice(at));
  }
  const onlyEmoji = (text) => text.length <= 60 && ONLY_EMOJI_RE.test(text) && [...text.matchAll(EMOJI_RE)].length <= 27;

  // ---- data (lazy) ----
  let data = null;
  let loading = null;
  function load() {
    if (data) return Promise.resolve(data);
    loading ||= Promise.all([fetch(DATA + "compact.json").then((r) => r.json()), fetch(DATA + "shortcodes/iamcal.json").then((r) => r.json())])
      .then(([list, codes]) => {
        const all = [];
        const byCode = new Map();
        const byChar = new Map();
        for (const e of list) {
          if (e.group == null || e.group === 2) continue;
          const sc = [].concat(codes[e.hexcode] || []).map((x) => x.replace(/[^a-z0-9_+-]/gi, "_").toLowerCase());
          if (!sc.length) sc.push(e.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
          const item = { u: e.unicode, name: e.label, sc, group: e.group, order: e.order ?? 1e6, tags: (e.tags || []).join(" ") };
          all.push(item);
          byChar.set(e.unicode.replace(/️/g, ""), item);
          for (const s of sc) if (!byCode.has(s)) byCode.set(s, e.unicode);
        }
        all.sort((a, b) => a.order - b.order);
        // Discord-style aliases people type.
        for (const [alias, to] of [["thumbsup", "+1"], ["thumbsdown", "-1"], ["laughing", "satisfied"], ["slight_smile", "slightly_smiling_face"]]) {
          if (!byCode.has(alias) && byCode.has(to)) byCode.set(alias, byCode.get(to));
        }
        data = { all, byCode, byChar };
        return data;
      })
      .catch((e) => { loading = null; throw e; });
    return loading;
  }
  /** Turns :name: into the emoji, for names it knows. */
  async function expand(text) {
    if (!/:[a-z0-9_+-]{2,40}:/i.test(text)) return text;
    try { await load(); } catch { return text; }
    // Leave code spans alone.
    return text.split(/(```[\s\S]*?```|`[^`\n]+`)/).map((part, i) => (i % 2 ? part
      : part.replace(/:([a-z0-9_+-]{2,40}):/gi, (all, name) => data.byCode.get(name.toLowerCase()) || all))).join("");
  }
  function search(q, limit = 8) {
    if (!data) return [];
    q = q.toLowerCase();
    const starts = [];
    const has = [];
    for (const e of data.all) {
      if (e.sc.some((s) => s.startsWith(q))) starts.push(e);
      else if (e.sc.some((s) => s.includes(q)) || e.name.toLowerCase().includes(q)) has.push(e);
      if (starts.length >= limit) break;
    }
    return [...starts, ...has].slice(0, limit);
  }
  const nameOf = (u) => data?.byChar.get(u.replace(/️/g, ""))?.sc[0];

  function recent() {
    try { const r = JSON.parse(localStorage.getItem(RECENT_STORE) || "[]"); if (Array.isArray(r)) return r.filter((x) => typeof x === "string").slice(0, 16); } catch {}
    return [];
  }
  function remember(u) {
    const r = [u, ...recent().filter((x) => x !== u)].slice(0, 16);
    try { localStorage.setItem(RECENT_STORE, JSON.stringify(r)); } catch {}
  }
  /** The reactions offered first: recently used, then the usual ones. */
  const quick = (n = 8) => [...new Set([...recent(), ...QUICK])].slice(0, n);

  // ---- picker ----
  function picker(anchor, onPick) {
    document.querySelector(".ls-emoji-picker")?.remove();
    const h = (tag, cls, props = {}) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, props);
    const box = h("div", "ls-emoji-picker ls-theme");
    const search = h("input", "ls-input ls-emoji-search", { placeholder: "Find an emoji", type: "search" });
    const tabs = h("div", "ls-emoji-tabs");
    const grid = h("div", "ls-emoji-grid");
    const foot = h("div", "ls-emoji-foot");
    const footImg = h("span", "ls-emoji-foot-pic");
    const footName = h("span", "ls-emoji-foot-name", { textContent: "Pick an emoji" });
    foot.append(footImg, footName);
    box.append(search, tabs, grid, foot);
    for (const t of ["keydown", "keyup", "keypress", "mousedown", "pointerdown", "wheel"]) box.addEventListener(t, (e) => e.stopPropagation());
    const close = () => { box.remove(); removeEventListener("mousedown", away, true); removeEventListener("keydown", esc, true); };
    const away = (e) => { if (!box.contains(e.target) && e.target !== anchor) close(); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const cell = (e) => {
      const b = h("button", "ls-emoji-cell", { type: "button", title: `:${e.sc[0]}:` });
      const pic = img(e.u, "ls-emoji-big");
      pic.loading = "lazy";
      b.append(pic);
      b.onmouseenter = () => { footImg.replaceChildren(img(e.u, "ls-emoji-big")); footName.textContent = `:${e.sc[0]}:`; };
      b.onclick = () => { remember(e.u); close(); onPick(e.u); };
      return b;
    };
    const section = (title, items) => {
      if (!items.length) return;
      grid.append(h("div", "ls-emoji-sect", { textContent: title }));
      const g = h("div", "ls-emoji-cells");
      for (const e of items) g.append(cell(e));
      grid.append(g);
      return g;
    };
    const paint = () => {
      grid.replaceChildren();
      const q = search.value.trim().toLowerCase().replace(/^:|:$/g, "");
      if (!data) { grid.append(h("div", "ls-sub ls-emoji-empty", { textContent: "Loading emoji…" })); return; }
      if (q) {
        // Exact shortcodes first, then prefixes, then names, then tags.
        const score = (e) => (e.sc.includes(q) ? 0 : e.sc.some((s) => s.startsWith(q)) ? 1
          : e.sc.some((s) => s.includes(q)) || e.name.toLowerCase().includes(q) ? 2 : e.tags.includes(q) ? 3 : 9);
        const found = data.all.map((e) => [score(e), e]).filter(([n]) => n < 9).sort((a, b) => a[0] - b[0]).slice(0, 160).map(([, e]) => e);
        if (!found.length) grid.append(h("div", "ls-sub ls-emoji-empty", { textContent: "No emoji match." }));
        section("Search results", found);
        return;
      }
      section("Recently used", recent().map((u) => data.byChar.get(u.replace(/️/g, "")) || { u, sc: [u], name: u }));
      for (const [g, title] of GROUPS) {
        const g2 = section(title, data.all.filter((e) => e.group === g));
        if (g2) g2.previousSibling.dataset.group = g;
      }
    };
    for (const [g, title, u] of GROUPS) {
      const t = h("button", "ls-emoji-tab", { type: "button", title });
      t.append(img(u, "ls-emoji"));
      t.onclick = () => { search.value = ""; paint(); grid.querySelector(`[data-group="${g}"]`)?.scrollIntoView({ block: "start" }); };
      tabs.append(t);
    }
    search.oninput = paint;
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    const w = Math.min(352, innerWidth - 16);
    box.style.width = w + "px";
    box.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + "px";
    const below = innerHeight - r.bottom;
    if (below > 420 || below > r.top) box.style.top = Math.max(8, Math.min(innerHeight - 8 - 400, r.bottom + 6)) + "px";
    else box.style.bottom = innerHeight - r.top + 6 + "px";
    paint();
    load().then(paint).catch(() => { grid.replaceChildren(h("div", "ls-sub ls-emoji-empty", { textContent: "Couldn't load the emoji list. Check your connection." })); });
    setTimeout(() => { addEventListener("mousedown", away, true); addEventListener("keydown", esc, true); search.focus(); }, 0);
  }

  S.emoji = { img, render, onlyEmoji, load, expand, search, nameOf, quick, remember, picker, get ready() { return !!data; } };
})();
