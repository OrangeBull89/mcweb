"use strict";

// Which build of each game this browser has installed, and whether a newer
// build needs a new game file (the server's games list gives that build as
// gameFileBuild, from the patch notes). The library and each game page show
// "Update Needed" until the player loads a game file at least that new. An
// optional new file (optionalUpdate {build, title}) is only offered: "Update
// available", and the old file keeps working.
// Pages load this after /social/core.js; a game page shows the notice in its
// #update-needed box after sign-in and calls McWebBuilds.paint() after an install.
globalThis.McWebBuilds = (() => {
  // Minecraft game files from before builds were stamped into them, by the
  // version the Minecraft page stores (its two runtime hashes).
  const MINECRAFT_FILES = Object.freeze({ "51cb9166-14c473a8": 24, "110134f1-06e9709a": 23, "d597f9de-4c4037ae": 22 });
  const number = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null);

  // caches.has comes first: caches.open would create an empty cache.
  async function stored(cacheName, url) {
    if (!globalThis.caches || !(await caches.has(cacheName))) return null;
    const res = await (await caches.open(cacheName)).match(url);
    return res ? res.json().catch(() => null) : null;
  }
  async function unpacked(cacheName, url, before) {
    const meta = await stored(cacheName, url);
    if (!meta?.cache || !(await caches.has(meta.cache))) return false;
    return number(meta.build) ?? before;
  }
  const INSTALLED = {
    async minecraft() {
      const pointer = await stored("mcweb-dev-build-v1", "/dev/graal/current.json");
      if (!pointer?.version) return false;
      const [, js = "", wasm = ""] = String(pointer.version).split("-");
      return number(pointer.build) ?? MINECRAFT_FILES[`${js.slice(0, 8)}-${wasm.slice(0, 8)}`] ?? 0;
    },
    // Installs from before builds were recorded came from each game's first build.
    gardendless: () => unpacked("gardendless-meta", "/games/gardendless/__install.json", 1),
    terraria: () => unpacked("terraria-meta", "/games/terraria/__install.json", 1),
    gettingoverit: () => unpacked("gettingoverit-meta", "/games/gettingoverit/__install.json", 1),
    plague: () => unpacked("plague-meta", "/games/plague/__install.json", 1),
    amongus: () => unpacked("amongus-meta", "/games/amongus/__install.json", 1),
    stickfight: () => unpacked("stickfight-meta", "/games/stickfight/__install.json", 1),
    btd6: () => unpacked("btd6-meta", "/games/btd6/__install.json", 1),
  };

  /** false: not installed; a number: the installed build (0: too old to tell); undefined: unknown. */
  async function installed(id) {
    const check = INSTALLED[id];
    return check ? check().catch(() => undefined) : undefined;
  }
  const needsUpdate = (game, build) => typeof build === "number" && (game?.gameFileBuild || 0) > build;
  const updateAvailable = (game, build) => typeof build === "number" && !needsUpdate(game, build) && (game?.optionalUpdate?.build || 0) > build;
  /** Where Update Needed sends players (Admin → Site → Update link), or null. */
  function updateLink() {
    const url = globalThis.LauncherSocial?.core?.boot?.site?.update;
    return typeof url === "string" && /^https:\/\//.test(url) ? url : null;
  }

  const HOW = {
    minecraft: "Get the newest game file (.mcweb) and load it with LOAD GAME FILE. Your worlds stay.",
    terraria: "Build your game file again on your PC with the newest MC-Web tools (tools\\terraria\\build.ps1), then load it with LOAD GAME FILE. Your characters and worlds stay.",
    gardendless: "Load your Gardendless .exe again with LOAD GAME FILE. Your save stays.",
    gettingoverit: "Build your game file again on your PC with the newest MC-Web tools (tools\\gettingoverit\\build.ps1), then load it with LOAD GAME FILE. Your climb stays.",
    plague: "Build your game file again on your PC with the newest MC-Web tools (tools\\plague\\build.ps1), then load it with LOAD GAME FILE. Your saves stay.",
    amongus: "Build your game file again on your PC with the newest MC-Web tools (tools\\amongus\\build.ps1), then load it with LOAD GAME FILE. Your name, colour and outfit stay.",
    stickfight: "Build your game file again on your PC with the newest MC-Web tools (tools\\stickfight\\build.ps1), then load it with LOAD GAME FILE. Your settings stay.",
    btd6: "Build your game file again on your PC with the newest MC-Web tools (tools\\btd6\\build.ps1), then load it with LOAD GAME FILE.",
  };
  const pageGame = () => (location.pathname.match(/^\/games\/([a-z0-9-]+)\//) || [])[1];

  /** Shows or hides this game page's Update Needed (or optional Update available) box. */
  async function paint(id = pageGame()) {
    const box = document.getElementById("update-needed");
    const game = globalThis.LauncherSocial?.core?.boot?.games?.find((g) => g.id === id);
    if (!box || !game) return;
    const build = await installed(id);
    const need = needsUpdate(game, build);
    const offer = !need && updateAvailable(game, build);
    box.hidden = !need && !offer;
    box.classList.toggle("optional", offer);
    if (box.hidden) return;
    const label = document.createElement("strong");
    label.textContent = need ? "UPDATE NEEDED" : "UPDATE AVAILABLE";
    const text = need ? ` Build ${game.gameFileBuild} needs a new game file. ${HOW[id] || "Load the new game file."}`
      : ` Build ${game.optionalUpdate.build}: ${game.optionalUpdate.title}. It's optional: your game file keeps working. Want it? ${HOW[id] || "Load the new game file."}`;
    const url = updateLink();
    if (!url) return void box.replaceChildren(label, text);
    // The whole box opens the update link.
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const go = document.createElement("span");
    go.className = "update-needed-go";
    go.textContent = "UPDATE NOW ↗";
    link.append(label, text, " ", go);
    box.replaceChildren(link);
  }
  globalThis.LauncherSocial?.core?.on?.("boot", () => paint());

  return Object.freeze({ installed, needsUpdate, updateAvailable, updateLink, paint });
})();
