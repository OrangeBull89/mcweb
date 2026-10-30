// Launcher social: dialogs and popouts. Profiles (with moderation actions),
// creating servers, server settings (overview, roles, members, bans, audit
// log), channel editing with permission overwrites, group chats, pins and
// the in-game preferences dialog.
(() => {
  const S = (globalThis.LauncherSocial ||= {});
  if (S.manage) return;
  const core = S.core;
  const ui = S.ui;
  const voice = S.voice;
  const { h, btn, avatar, serverIcon, statusText, P, has, displayName, topColor, memberOf, refreshServer } = ui.helpers;
  const toast = (t, bad) => ui.toast(t, bad);
  const M = {};
  S.manage = M;

  const PERM_INFO = [
    ["General", [
      ["VIEW_CHANNEL", "View Channels", "See channels and read their names."],
      ["MANAGE_CHANNELS", "Manage Channels", "Create, edit and delete channels."],
      ["MANAGE_ROLES", "Manage Roles", "Create and edit roles below their own, and set channel permissions."],
      ["MANAGE_SERVER", "Manage Server", "Change the server name and icon, and read the audit log."],
      ["ADMINISTRATOR", "Administrator", "Every permission, and every channel. Give this out carefully."],
    ]],
    ["Members", [
      ["CREATE_INVITE", "Invite People", "Invite their friends to the server."],
      ["CHANGE_NICKNAME", "Change Nickname", "Change their own nickname here."],
      ["MANAGE_NICKNAMES", "Manage Nicknames", "Change other people's nicknames."],
      ["KICK_MEMBERS", "Kick Members", "Remove people below them. They can be invited back."],
      ["BAN_MEMBERS", "Ban Members", "Remove people below them for good."],
    ]],
    ["Text", [
      ["SEND_MESSAGES", "Send Messages", ""],
      ["READ_HISTORY", "Read Message History", "Without this, channels stay empty."],
      ["ATTACH_FILES", "Attach Pictures", ""],
      ["ADD_REACTIONS", "Add Reactions", ""],
      ["MENTION_EVERYONE", "Mention @everyone and all roles", ""],
      ["MANAGE_MESSAGES", "Manage Messages", "Delete and pin other people's messages."],
    ]],
    ["Voice", [
      ["CONNECT", "Connect", "Join voice channels."],
      ["SPEAK", "Speak", "Talk in voice channels."],
      ["MUTE_MEMBERS", "Mute Members", "Server-mute people below them."],
    ]],
  ];
  const CHANNEL_PERMS = new Set(["VIEW_CHANNEL", "MANAGE_CHANNELS", "SEND_MESSAGES", "READ_HISTORY", "ATTACH_FILES", "ADD_REACTIONS", "MENTION_EVERYONE", "MANAGE_MESSAGES", "CONNECT", "SPEAK", "MUTE_MEMBERS"]);

  // ---- modal ----
  function modal(title, body, opts = {}) {
    const close = () => { back.remove(); opts.onClose?.(); };
    const card = h("div.ls-modal" + (opts.wide ? ".wide" : ""), { role: "dialog", "aria-label": title, onclick: (e) => e.stopPropagation() },
      h("div.ls-modal-head", null, h("h2.ls-grow", { text: title }), btn("ls-x", S.icon("x", 18), close, "Close")), body);
    if (opts.actions) card.append(h("div.ls-modal-actions", null, ...opts.actions(close)));
    const back = h("div.ls-modal-back.ls-theme", { onmousedown: (e) => { if (e.target === back) close(); } }, card);
    back.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    for (const type of ["keydown", "keyup", "keypress", "mousedown", "mouseup", "wheel", "pointerdown"]) back.addEventListener(type, (e) => e.stopPropagation());
    document.body.append(back);
    setTimeout(() => card.querySelector("input:not([type=checkbox]):not([type=color]),textarea,select")?.focus(), 0);
    return { close, card };
  }
  M.modal = modal;
  const field = (label, input, hint) => h("label.ls-field", null, h("span.ls-field-label", { text: label }), input, hint ? h("span.ls-sub", { text: hint }) : null);
  const errorLine = () => h("div.ls-form-err");
  async function attempt(errEl, fn) {
    errEl.textContent = "";
    try { return await fn(); } catch (e) { errEl.textContent = e.message; return undefined; }
  }
  function popover(anchor, content) {
    document.querySelector(".ls-pop")?.remove();
    const pop = h("div.ls-pop.ls-theme", { onclick: (e) => e.stopPropagation(), onmousedown: (e) => e.stopPropagation(), onkeydown: (e) => e.stopPropagation() }, content);
    document.body.append(pop);
    const r = anchor?.getBoundingClientRect?.() || { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3 };
    const w = pop.offsetWidth;
    const hgt = pop.offsetHeight;
    let left = r.right + 8;
    if (left + w > innerWidth - 8) left = Math.max(8, r.left - w - 8);
    const top = Math.min(Math.max(8, r.top), innerHeight - hgt - 8);
    Object.assign(pop.style, { left: left + "px", top: Math.max(8, top) + "px" });
    const away = (e) => { if (!pop.contains(e.target)) { pop.remove(); removeEventListener("mousedown", away, true); } };
    setTimeout(() => addEventListener("mousedown", away, true), 0);
    return pop;
  }
  M.popover = popover;
  M.lightbox = (src) => {
    const back = h("div.ls-modal-back.ls-theme.ls-lightbox", { onclick: () => back.remove() }, h("img", { src, alt: "" }),
      h("a.ls-btn.small", { href: src, target: "_blank", rel: "noopener", text: "Open original", onclick: (e) => e.stopPropagation() }));
    document.body.append(back);
  };

  // ---- profiles ----
  const profiles = new Map();
  M.profileCard = (name, srv, inColumn) => {
    const d = core.data;
    const isMe = name === d.me.name;
    const friend = d.friends.find((f) => f.name === name);
    const member = srv ? memberOf(srv, name) : null;
    const base = isMe ? { ...d.me, status: core.shownStatus() } : friend || member || d.dms.find((x) => x.name === name) || { name };
    const card = h("div.ls-profile");
    card.append(h("div.ls-profile-banner", { style: { background: `linear-gradient(135deg, hsl(${[...name].reduce((x, c) => (x * 31 + c.charCodeAt(0)) % 360, 7)} 40% 30%), var(--ls-panel2))` } }));
    card.append(h("div.ls-profile-av", null, avatar(base, 80, base.status)));
    card.append(h("div.ls-profile-name", null, h("b", { text: member?.nick || name }), member?.nick ? h("div.ls-sub", { text: name }) : null));
    if (base.status) card.append(h("div.ls-sub.ls-profile-status", { text: statusText(base) }));
    const extra = h("div.ls-profile-extra");
    card.append(extra);
    const cached = profiles.get(name);
    const fill = (p) => {
      extra.replaceChildren();
      const line = (label, text) => extra.append(h("div.ls-sect", { text: label }), h("div.ls-profile-line", { text }));
      line("Member since", new Date(p.joined).toLocaleDateString());
      if (p.since) line("Friends since", new Date(p.since).toLocaleDateString());
      if (srv && member) line("Joined this server", new Date(member.joined).toLocaleDateString());
      if (p.games?.length) {
        const hrs = (ms) => (ms >= 3_600_000 ? ` · ${Math.round(ms / 3_600_000).toLocaleString()} hrs` : "");
        line("Recently played", p.games.slice(0, 3).map((g) => core.gameName(g.game) + hrs(g.ms)).join(", "));
      }
      if (p.achCount) line("Achievements", `${p.achCount} unlocked` + (p.rarest[0] ? ` · rarest: ${p.rarest[0].name} (${S.ach?.pctText(p.rarest[0].pct) ?? Math.round(p.rarest[0].pct) + "%"})` : ""));
      if (!isMe) {
        if (p.together?.length) {
          const total = p.together.reduce((n, w) => n + w.ms, 0);
          const worlds = p.together.length;
          extra.append(h("div.ls-sect", null, "Played together", btn("ls-sect-btn.ls-played-more", "Details", () => playedTogether(name, p.together), "Every world you played in together")));
          extra.append(h("div.ls-profile-line", {
            text: [`${worlds} world${worlds === 1 ? "" : "s"}`, total >= 60_000 ? `${duration(total)} together` : null, `last ${core.ago(p.together[0].last)}`].filter(Boolean).join(" · "),
          }));
        }
        line(`Mutual friends — ${p.mutual.length}`, p.mutual.join(", ") || "None");
        if (p.mutualServers?.length) line(`Mutual servers — ${p.mutualServers.length}`, p.mutualServers.join(", "));
      }
      if (srv && member) {
        const roles = srv.roles.filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position);
        extra.append(h("div.ls-sect", { text: roles.length ? "Roles" : "No roles" }));
        const chips = h("div.ls-role-chips");
        for (const r of roles) chips.append(h("span.ls-role-chip", null, h("span.ls-role-dot", { style: { background: r.color || "var(--ls-muted)" } }), r.name));
        extra.append(chips);
      }
    };
    if (cached) fill(cached);
    else {
      extra.append(h("div.ls-sub", { text: "Loading…" }));
      core.api("profile", { name }).then((p) => { profiles.set(name, p); setTimeout(() => profiles.delete(name), 60_000); fill(p); }).catch((e) => { extra.replaceChildren(h("div.ls-sub", { text: e.message })); });
    }
    // The launcher has full profile pages; game pages don't.
    const full = S.openProfile ? btn("ls-btn.small.grey", "View profile", () => { document.querySelector(".ls-pop")?.remove(); S.openProfile(name); }) : null;
    if (isMe && full) card.append(h("div.ls-profile-actions", null, full));
    if (!isMe) {
      const acts = h("div.ls-profile-actions");
      if (!inColumn) acts.append(btn("ls-btn.small", "Message", () => { document.querySelector(".ls-pop")?.remove(); ui.openDm(name); }));
      if (full) acts.append(full);
      acts.append(btn("ls-btn.small.grey", "Call", () => { document.querySelector(".ls-pop")?.remove(); voice.join({ with: name }, name); }));
      if (base.worldCode && base.playingWith !== d.me.name) acts.append(btn("ls-btn.small.green", "Join world", () => ui.joinWorld(name, base.worldCode, base.game || "minecraft")));
      if (friend) {
        acts.append(btn("ls-btn.small.grey", "Remove friend", () => { if (confirm(`Remove ${name} from your friends?`)) core.run("remove", { name }).catch((e) => toast(e.message, true)); }));
      } else if (!d.outgoing.some((r) => r.name === name)) {
        acts.append(btn("ls-btn.small.grey", "Add friend", () => core.run("request", { name }).then(() => toast(`Friend request sent to ${name}.`)).catch((e) => toast(e.message, true))));
      }
      acts.append(btn("ls-btn.small.red", "Block", () => { if (confirm(`Block ${name}? This also removes them as a friend.`)) core.run("block", { name }).catch((e) => toast(e.message, true)); }));
      card.append(acts);
    }
    if (srv && member) card.append(modActions(srv, member, isMe));
    return card;
  };
  M.profile = (name, anchor, srv) => popover(anchor, M.profileCard(name, srv || null, false));

  // "Played together": each world two friends played in, whose it is, and for how long.
  const duration = (ms) => {
    const m = Math.round(ms / 60_000);
    if (m < 1) return "under a minute";
    if (m < 60) return `${m}m`;
    const hours = Math.floor(m / 60);
    return hours < 24 ? `${hours}h ${m % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
  };
  function playedTogether(name, worlds) {
    document.querySelector(".ls-pop")?.remove();
    const me = core.data.me.name;
    const list = h("div.ls-played");
    for (const w of worlds) {
      const owner = w.host === me ? "Your world" : `${w.host}'s world`;
      // Rows carried over from before sessions were timed have no name or length.
      const timed = w.ms > 0;
      list.append(h("div.ls-friend-row.ls-played-row", null,
        h("div.ls-grow", null,
          h("div.ls-name", { text: w.world || (timed ? "Unnamed world" : "A world from before") }),
          h("div.ls-sub", { text: `${core.gameName(w.game)} · ${owner}` })),
        h("div.ls-played-stat", null,
          h("b", { text: timed ? duration(w.ms) : "Time not recorded" }),
          h("div", { text: `${w.sessions} session${w.sessions === 1 ? "" : "s"} · ${core.ago(w.last)}` }),
          timed && w.first < w.last - 86_400_000 ? h("div", { text: `since ${new Date(w.first).toLocaleDateString()}` }) : null)));
    }
    modal(`Played with ${name}`, list, { actions: (close) => [btn("ls-btn", "Close", close)] });
  }

  function modActions(srv, member, isMe) {
    const box = h("div.ls-profile-actions");
    const outranks = isMe || srv.top > topOf(srv, member);
    if (has(srv.perms, P.MANAGE_ROLES) && (outranks || isMe)) box.append(btn("ls-btn.small.grey", "Roles", () => memberRolesDialog(srv, member)));
    if ((isMe && has(srv.perms, P.CHANGE_NICKNAME)) || (has(srv.perms, P.MANAGE_NICKNAMES) && outranks)) {
      box.append(btn("ls-btn.small.grey", "Nickname", () => {
        const input = h("input.ls-input", { value: member.nick || "", maxLength: 32, placeholder: member.name });
        const err = errorLine();
        modal(`Nickname for ${member.name}`, h("div.ls-form", null, field("Nickname (empty to reset)", input), err), {
          actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn", "Save", () => attempt(err, async () => {
            await core.api("server_nick", { id: srv.server.id, name: isMe ? undefined : member.name, nick: input.value }); close(); refreshServer(srv.server.id);
          }))],
        });
      }));
    }
    if (!isMe && !member.owner && outranks && !srv.server.general) {
      if (has(srv.perms, P.KICK_MEMBERS)) box.append(btn("ls-btn.small.red", "Kick", () => confirmReason(`Kick ${member.name}?`, "They can come back if someone invites them again.", (reason) => core.api("server_kick", { id: srv.server.id, name: member.name, reason }), srv)));
      if (has(srv.perms, P.BAN_MEMBERS)) box.append(btn("ls-btn.small.red", "Ban", () => confirmReason(`Ban ${member.name}?`, "They're removed and can't be invited back until unbanned.", (reason) => core.api("server_ban", { id: srv.server.id, name: member.name, reason }), srv)));
    }
    return box;
  }
  const topOf = (srv, member) => {
    if (member.owner) return 1e9;
    return Math.max(0, ...srv.roles.filter((r) => member.roles.includes(r.id)).map((r) => r.position));
  };
  function confirmReason(title, text, run, srv) {
    const reason = h("input.ls-input", { maxLength: 200, placeholder: "Reason (optional, shown in the audit log)" });
    const err = errorLine();
    modal(title, h("div.ls-form", null, h("p", { text }), reason, err), {
      actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn.red", "Confirm", () => attempt(err, async () => {
        await run(reason.value); close(); document.querySelector(".ls-pop")?.remove(); refreshServer(srv.server.id);
      }))],
    });
  }
  function memberRolesDialog(srv, member) {
    const err = errorLine();
    const list = h("div.ls-check-list");
    const picked = new Set(member.roles);
    for (const r of srv.roles.filter((x) => !x.everyone).sort((a, b) => b.position - a.position)) {
      const box = h("input", { type: "checkbox", checked: picked.has(r.id), disabled: r.position >= srv.top, onchange: (e) => (e.target.checked ? picked.add(r.id) : picked.delete(r.id)) });
      list.append(h("label.ls-check", null, box, h("span.ls-role-dot", { style: { background: r.color || "var(--ls-muted)" } }), h("span", { text: r.name })));
    }
    if (!list.children.length) list.append(h("div.ls-sub", { text: "This server has no roles yet. Make some in Server Settings → Roles." }));
    modal(`Roles for ${member.name}`, h("div.ls-form", null, list, err), {
      actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn", "Save", () => attempt(err, async () => {
        await core.api("member_roles", { id: srv.server.id, name: member.name, roles: [...picked] }); close(); document.querySelector(".ls-pop")?.remove(); refreshServer(srv.server.id);
      }))],
    });
  }

  // ---- servers ----
  M.addServer = () => {
    const d = core.data;
    const body = h("div.ls-form");
    const ownsOne = d.servers.some((s) => s.mine && !s.general);
    if (d.serverInvites?.length) {
      body.append(h("div.ls-sect", { text: "Invites" }));
      for (const inv of d.serverInvites) {
        body.append(h("div.ls-friend-row", null, serverIcon(inv, 40), h("div.ls-grow", null, h("b", { text: inv.name }), h("div.ls-sub", { text: `Invited by ${inv.by} · ${core.ago(inv.created)}` })),
          btn("ls-btn.small.green", "Join", async () => {
            try { const out = await core.api("server_invite_respond", { id: inv.id, accept: true }); m.close(); await core.sync(); ui.openServer(out.server); } catch (e) { toast(e.message, true); }
          }),
          btn("ls-btn.small.grey", "Decline", async () => { try { await core.api("server_invite_respond", { id: inv.id, accept: false }); m.close(); core.sync(); } catch (e) { toast(e.message, true); } })));
      }
    }
    body.append(h("div.ls-sect", { text: "Create your server" }));
    if (ownsOne) body.append(h("p.ls-sub", { text: "You already own a server. Everyone can own one." }));
    else {
      const name = h("input.ls-input", { maxLength: 32, placeholder: `${d.me.name}'s server` });
      const err = errorLine();
      const go = btn("ls-btn", "Create", () => attempt(err, async () => {
        const out = await core.api("server_create", { name: name.value.trim() || `${d.me.name}'s server` });
        m.close();
        await core.sync();
        ui.openServer(out.server);
      }));
      name.onkeydown = (e) => { if (e.key === "Enter") go.click(); };
      body.append(h("p.ls-sub", { text: "A server is a place for your friends, with text and voice channels and roles. You can own one server." }),
        field("Server name", name), err, go);
    }
    body.append(h("p.ls-sub", { text: "To join someone else's server, they invite you from inside it." }));
    const m = modal("Servers", body);
  };

  M.serverMenu = (srv, anchor) => {
    if (!srv) return;
    const items = h("div.ls-menu.static");
    const item = (label, run, cls = "", icon = null) => items.append(h("button.ls-menu-item" + cls, { type: "button", onclick: () => { document.querySelector(".ls-pop")?.remove(); run(); } }, h("span.ls-grow", { text: label }), icon ? S.icon(icon, 16) : null));
    if (has(srv.perms, P.CREATE_INVITE) && !srv.server.general) item("Invite friends", () => M.inviteFriends(srv), ".accent", "userPlus");
    if (has(srv.perms, P.MANAGE_SERVER) || has(srv.perms, P.MANAGE_ROLES) || has(srv.perms, P.BAN_MEMBERS) || has(srv.perms, P.KICK_MEMBERS)) item("Server settings", () => M.serverSettings(srv), "", "settings");
    if (has(srv.perms, P.MANAGE_CHANNELS)) {
      item("Create channel", () => M.createChannel(srv, null), "", "plus");
      item("Create category", () => M.createChannel(srv, null, "category"), "", "folder");
    }
    if (has(srv.perms, P.CHANGE_NICKNAME)) item("Change my nickname", () => {
      const me = memberOf(srv, core.data.me.name);
      const input = h("input.ls-input", { value: me?.nick || "", maxLength: 32, placeholder: core.data.me.name });
      const err = errorLine();
      modal("Your nickname here", h("div.ls-form", null, field("Nickname (empty to reset)", input), err), {
        actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn", "Save", () => attempt(err, async () => { await core.api("server_nick", { id: srv.server.id, nick: input.value }); close(); refreshServer(srv.server.id); }))],
      });
    }, "", "edit");
    if (!srv.server.mine && !srv.server.general) item("Leave server", () => {
      if (confirm(`Leave ${srv.server.name}?`)) core.api("server_leave", { id: srv.server.id }).then(() => { ui.openHome(); core.sync(); }).catch((e) => toast(e.message, true));
    }, ".danger", "logout");
    popover(anchor, items);
  };

  M.inviteFriends = (srv) => {
    const friends = core.data.friends.filter((f) => !memberOf(srv, f.name));
    const list = h("div.ls-check-list");
    const sent = new Set();
    if (!friends.length) list.append(h("div.ls-sub", { text: "All your friends are already here." }));
    for (const f of friends) {
      const b = btn("ls-btn.small", "Invite", async () => {
        try { await core.api("server_invite", { id: srv.server.id, name: f.name }); sent.add(f.name); b.textContent = "Sent"; b.disabled = true; } catch (e) { toast(e.message, true); }
      });
      list.append(h("div.ls-friend-row", null, avatar(f, 32, f.status), h("span.ls-grow", { text: f.name }), b));
    }
    modal(`Invite friends to ${srv.server.name}`, h("div.ls-form", null, h("p.ls-sub", { text: "They get an invite they can accept from the + button in the server list." }), list));
  };

  // ---- channels ----
  M.createChannel = (srv, parent, kind0) => {
    let kind = kind0 || "text";
    const name = h("input.ls-input", { maxLength: 32, placeholder: kind === "category" ? "New category" : "new-channel" });
    const cats = srv.channels.filter((c) => c.kind === "category");
    const parentSel = h("select.ls-input", null, h("option", { value: "", text: "No category" }), ...cats.map((c) => h("option", { value: c.id, text: c.name, selected: c.id === parent })));
    const priv = h("input", { type: "checkbox" });
    const err = errorLine();
    const kinds = h("div.ls-seg");
    const body = h("div.ls-form");
    const paint = () => {
      kinds.replaceChildren(...(kind0 === "category" ? [] : [["text", "Text"], ["voice", "Voice"]].map(([k, l]) => btn("ls-seg-btn" + (kind === k ? ".on" : ""), l, () => { kind = k; paint(); }))));
      body.replaceChildren(kinds, field(kind === "category" ? "Category name" : "Channel name", name),
        kind === "category" ? null : field("Category", parentSel),
        kind === "category" ? null : h("label.ls-check", null, priv, h("span", { text: "Private channel: only you (and people you add in its permissions) can see it" })), err);
    };
    paint();
    modal(kind0 === "category" ? "Create category" : "Create channel", body, {
      actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn", "Create", () => attempt(err, async () => {
        await core.api("channel_create", { id: srv.server.id, kind, name: name.value, parent: parentSel.value ? Number(parentSel.value) : null, private: priv.checked });
        close();
        refreshServer(srv.server.id);
      }))],
    });
  };

  M.editChannel = (srv, ch) => {
    const err = errorLine();
    const name = h("input.ls-input", { value: ch.name, maxLength: 32 });
    const topic = h("textarea.ls-input", { value: ch.topic || "", maxLength: 300, rows: 3 });
    const cats = srv.channels.filter((c) => c.kind === "category");
    const parentSel = h("select.ls-input", null, h("option", { value: "", text: "No category" }), ...cats.map((c) => h("option", { value: c.id, text: c.name, selected: c.id === ch.parent })));
    const tabs = h("div.ls-seg");
    const body = h("div.ls-form");
    let tab = "overview";
    const paint = () => {
      tabs.replaceChildren(btn("ls-seg-btn" + (tab === "overview" ? ".on" : ""), "Overview", () => { tab = "overview"; paint(); }),
        has(srv.perms, P.MANAGE_ROLES) ? btn("ls-seg-btn" + (tab === "perms" ? ".on" : ""), "Permissions", () => { tab = "perms"; paint(); }) : null);
      body.replaceChildren(tabs);
      if (tab === "overview") {
        body.append(field(ch.kind === "category" ? "Category name" : "Channel name", name));
        if (ch.kind === "text") body.append(field("Topic", topic));
        if (ch.kind !== "category") body.append(field("Category", parentSel));
        body.append(err, h("div.ls-row-gap", null,
          btn("ls-btn", "Save", () => attempt(err, async () => {
            await core.api("channel_update", { channel: ch.id, name: name.value, topic: topic.value, parent: ch.kind === "category" ? undefined : parentSel.value ? Number(parentSel.value) : null });
            m.close(); refreshServer(srv.server.id);
          })),
          btn("ls-btn.red", ch.kind === "category" ? "Delete category" : "Delete channel", () => {
            if (!confirm(`Delete ${ch.kind === "text" ? "#" : ""}${ch.name}? ${ch.kind === "text" ? "Its messages are deleted too. " : ""}This can't be undone.`)) return;
            attempt(err, async () => { await core.api("channel_delete", { channel: ch.id }); m.close(); refreshServer(srv.server.id); });
          })));
      } else body.append(overwritesEditor(srv, ch, err), err);
    };
    paint();
    const m = modal(ch.kind === "category" ? `Category: ${ch.name}` : `${ch.kind === "voice" ? "" : "#"}${ch.name}`, body, { wide: true });
  };

  function overwritesEditor(srv, ch, err) {
    const wrap = h("div.ls-ow");
    const list = h("div.ls-ow-list");
    const editor = h("div.ls-ow-edit.ls-grow");
    wrap.append(list, editor);
    const ows = [...(ch.overwrites || [])];
    const everyone = srv.roles.find((r) => r.everyone);
    if (!ows.some((o) => o.kind === "role" && o.target === everyone.id)) ows.unshift({ kind: "role", target: everyone.id, allow: 0, deny: 0, fresh: true });
    let sel = ows[0];
    const label = (o) => (o.kind === "role" ? srv.roles.find((r) => r.id === o.target)?.name || "?" : "@" + o.name);
    const paint = () => {
      list.replaceChildren(h("div.ls-sect", { text: "Roles / members" }));
      for (const o of ows) list.append(h("div.ls-side-row" + (o === sel ? ".on" : ""), { onclick: () => { sel = o; paint(); } }, h("span.ls-ell", { text: label(o) })));
      const add = h("select.ls-input", null, h("option", { value: "", text: "Add a role or member…" }),
        ...srv.roles.filter((r) => !ows.some((o) => o.kind === "role" && o.target === r.id)).map((r) => h("option", { value: "r" + r.id, text: r.name })),
        ...srv.members.filter((mm) => !ows.some((o) => o.kind === "member" && o.name === mm.name)).map((mm) => h("option", { value: "m" + mm.name, text: "@" + mm.name })));
      add.onchange = () => {
        const v = add.value;
        if (!v) return;
        const o = v[0] === "r" ? { kind: "role", target: Number(v.slice(1)), allow: 0, deny: 0, fresh: true } : { kind: "member", target: v.slice(1), name: v.slice(1), allow: 0, deny: 0, fresh: true };
        ows.push(o);
        sel = o;
        paint();
      };
      list.append(add);
      editor.replaceChildren(h("div.ls-sub", { text: ch.parent && !(ch.overwrites || []).length ? "This channel uses its category's permissions until you save here." : "✓ allow · / inherit · ✕ deny" }));
      for (const [group, perms] of PERM_INFO) {
        const rows = perms.filter(([k]) => CHANNEL_PERMS.has(k) && (ch.kind !== "voice" || ["VIEW_CHANNEL", "MANAGE_CHANNELS", "CONNECT", "SPEAK", "MUTE_MEMBERS"].includes(k))
          && (ch.kind !== "text" || !["CONNECT", "SPEAK", "MUTE_MEMBERS"].includes(k)));
        if (!rows.length) continue;
        editor.append(h("div.ls-sect", { text: group }));
        for (const [k, title] of rows) {
          const bit = P[k];
          const state = sel.allow & bit ? "allow" : sel.deny & bit ? "deny" : "inherit";
          const set = (s) => { sel.allow &= ~bit; sel.deny &= ~bit; if (s === "allow") sel.allow |= bit; if (s === "deny") sel.deny |= bit; paint(); };
          editor.append(h("div.ls-ow-row", null, h("span.ls-grow", { text: title }),
            h("div.ls-tri", null, btn("deny" + (state === "deny" ? ".on" : ""), S.icon("x", 14), () => set("deny"), "Deny"),
              btn("inherit" + (state === "inherit" ? ".on" : ""), "/", () => set("inherit"), "Inherit"),
              btn("allow" + (state === "allow" ? ".on" : ""), S.icon("check", 14), () => set("allow"), "Allow"))));
        }
      }
      const target = sel.kind === "role" ? sel.target : sel.name;
      editor.append(h("div.ls-row-gap", null,
        btn("ls-btn", "Save permissions", () => attempt(err, async () => {
          await core.api("overwrite_set", { channel: ch.id, kind: sel.kind, target, allow: sel.allow, deny: sel.deny });
          sel.fresh = false;
          toast("Permissions saved.");
          await refreshServer(srv.server.id);
        })),
        sel.fresh ? null : btn("ls-btn.grey", "Remove", () => attempt(err, async () => {
          await core.api("overwrite_set", { channel: ch.id, kind: sel.kind, target, remove: true });
          ows.splice(ows.indexOf(sel), 1);
          sel = ows[0];
          paint();
          refreshServer(srv.server.id);
        }))));
    };
    paint();
    return wrap;
  }

  // ---- server settings ----
  M.serverSettings = (srv0) => {
    let srv = srv0;
    let tab = has(srv.perms, P.MANAGE_SERVER) ? "overview" : has(srv.perms, P.MANAGE_ROLES) ? "roles" : "members";
    const nav = h("nav.ls-settings-nav");
    const pane = h("div.ls-settings-pane.ls-grow");
    const err = errorLine();
    const reload = async () => { await refreshServer(srv.server.id); srv = ui.helpers.currentServer() || srv; paint(); };
    const tabs = [
      ["overview", "Overview", P.MANAGE_SERVER], ["roles", "Roles", P.MANAGE_ROLES], ["members", "Members", 0],
      ["bans", "Bans", P.BAN_MEMBERS], ["audit", "Audit Log", P.MANAGE_SERVER],
    ];
    const paint = () => {
      nav.replaceChildren(h("div.ls-sect", { text: srv.server.name }));
      for (const [id, label, perm] of tabs) if ((!perm || has(srv.perms, perm)) && !(id === "bans" && srv.server.general)) nav.append(h("div.ls-side-row" + (tab === id ? ".on" : ""), { onclick: () => { tab = id; paint(); } }, label));
      if (srv.server.mine && !srv.server.general) nav.append(h("div.ls-side-row.danger" + (tab === "danger" ? ".on" : ""), { onclick: () => { tab = "danger"; paint(); } }, "Ownership & delete"));
      pane.replaceChildren();
      err.textContent = "";
      if (tab === "overview") overview();
      else if (tab === "roles") roles();
      else if (tab === "members") members();
      else if (tab === "bans") bans();
      else if (tab === "audit") audit();
      else danger();
      pane.append(err);
    };
    function overview() {
      const name = h("input.ls-input", { value: srv.server.name, maxLength: 32 });
      let icon;
      const preview = h("div.ls-icon-preview", null, serverIcon(srv.server, 72));
      pane.append(h("h3", { text: "Server overview" }), h("div.ls-row-gap", null, preview,
        btn("ls-btn.small.grey", "Change icon", () => ui.pickFile("image/*", async (file) => {
          try {
            const bmp = await createImageBitmap(file);
            const side = Math.min(bmp.width, bmp.height);
            const c = h("canvas", { width: 128, height: 128 });
            c.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 128, 128);
            icon = c.toDataURL("image/webp", 0.85);
            if (!icon.startsWith("data:image/webp")) icon = c.toDataURL("image/jpeg", 0.85);
            preview.replaceChildren(serverIcon({ name: name.value, icon }, 72));
          } catch { toast("That picture couldn't be read.", true); }
        })),
        srv.server.icon ? btn("ls-btn.small.grey", "Remove icon", () => { icon = null; preview.replaceChildren(serverIcon({ name: name.value }, 72)); }) : null),
      field("Server name", name),
      btn("ls-btn", "Save changes", () => attempt(err, async () => { await core.api("server_update", { id: srv.server.id, name: name.value, ...(icon !== undefined ? { icon } : {}) }); toast("Saved."); core.sync(); reload(); })));
    }
    function roles() {
      const list = h("div.ls-role-list");
      const editor = h("div.ls-role-edit.ls-grow");
      const sorted = srv.roles.slice().sort((a, b) => b.position - a.position);
      let sel = M._roleSel && sorted.find((r) => r.id === M._roleSel) || sorted.find((r) => !r.everyone && r.position < srv.top) || sorted.find((r) => r.everyone);
      const paintRoles = () => {
        list.replaceChildren(btn("ls-btn.small.wide", "Create role", () => attempt(err, async () => { await core.api("role_create", { id: srv.server.id, name: "new role" }); await reload(); })));
        for (const r of sorted) {
          const canMove = !r.everyone && r.position < srv.top;
          list.append(h("div.ls-side-row.ls-role-row" + (r === sel ? ".on" : "") + (canMove ? ".movable" : ""), { "data-drag": canMove ? r.id : undefined, onclick: () => { sel = r; M._roleSel = r.id; paintRoles(); } },
            canMove ? h("span.ls-grip", { title: "Drag to move" }, S.icon("grip", 14)) : null,
            h("span.ls-role-dot", { style: { background: r.color || "var(--ls-muted)" } }), h("span.ls-grow.ls-ell", { text: r.name }),
            canMove ? btn("ls-x.ls-role-move", S.icon("arrowUp", 15), () => move(r, 1), "Move up") : null, canMove ? btn("ls-x.ls-role-move", S.icon("arrowDown", 15), () => move(r, -1), "Move down") : null));
        }
        editRole(editor, sel);
      };
      const saveOrder = (movable) => attempt(err, async () => {
        await core.api("role_order", { id: srv.server.id, order: movable.map((x) => x.id) });
        await reload();
      });
      const move = (r, dir) => {
        const movable = sorted.filter((x) => !x.everyone && x.position < srv.top);
        const i = movable.indexOf(r);
        const j = i - dir;
        if (j < 0 || j >= movable.length) return;
        [movable[i], movable[j]] = [movable[j], movable[i]];
        saveOrder(movable);
      };
      // Roles you can move drag among themselves (the ones above yours and @everyone stay put).
      ui.sortable(list, {
        accepts: (src, over) => (over.dataset.drag ? "edge" : false),
        drop: (src, over, where) => {
          const movable = sorted.filter((x) => !x.everyone && x.position < srv.top);
          const r = movable.find((x) => x.id === +src.dataset.drag);
          const at = movable.find((x) => x.id === +over.dataset.drag);
          movable.splice(movable.indexOf(r), 1);
          movable.splice(movable.indexOf(at) + (where === "after" ? 1 : 0), 0, r);
          // Shown in the new order at once; the server's answer redraws it.
          sorted.sort((a, b) => (movable.includes(a) && movable.includes(b) ? movable.indexOf(a) - movable.indexOf(b) : b.position - a.position));
          paintRoles();
          saveOrder(movable);
        },
      });
      pane.append(h("h3", { text: "Roles" }), h("p.ls-sub", { text: "Higher roles outrank lower ones. You can edit roles below your own top role. @everyone applies to all members." }),
        h("div.ls-roles", null, list, editor));
      paintRoles();
    }
    function editRole(box, r) {
      box.replaceChildren();
      if (!r) return;
      const locked = !r.everyone && r.position >= srv.top;
      let perms = r.perms;
      const name = h("input.ls-input", { value: r.name, maxLength: 32, disabled: r.everyone || locked });
      const color = h("input.ls-color", { type: "color", value: r.color || "#99aab5", disabled: r.everyone || locked });
      const hoist = h("input", { type: "checkbox", checked: r.hoist, disabled: r.everyone || locked });
      const mention = h("input", { type: "checkbox", checked: r.mentionable, disabled: r.everyone || locked });
      box.append(field("Role name", name));
      if (!r.everyone) box.append(h("div.ls-row-gap", null, field("Colour", color), btn("ls-btn.small.grey", "No colour", () => { color.dataset.none = "1"; color.value = "#99aab5"; }, null, { disabled: locked })),
        h("label.ls-check", null, hoist, h("span", { text: "Show members with this role separately in the member list" })),
        h("label.ls-check", null, mention, h("span", { text: "Anyone can @mention this role" })));
      for (const [group, list] of PERM_INFO) {
        box.append(h("div.ls-sect", { text: group }));
        for (const [k, title, hint] of list) {
          const bit = P[k];
          const mine = has(srv.perms, bit);
          box.append(h("label.ls-perm" + (!mine || locked ? ".off" : ""), null, h("div.ls-grow", null, h("div", { text: title }), hint ? h("div.ls-sub", { text: hint }) : null),
            h("input.ls-switch", { type: "checkbox", checked: has(perms, bit), disabled: !mine || locked, onchange: (e) => { perms = e.target.checked ? perms | bit : perms & ~bit; } })));
        }
      }
      if (locked) box.append(h("div.ls-sub", { text: "This role is at or above your top role, so you can't change it." }));
      else {
        box.append(h("div.ls-row-gap", null,
          btn("ls-btn", "Save role", () => attempt(err, async () => {
            await core.api("role_update", { role: r.id, name: name.value, color: color.dataset.none ? null : r.everyone ? undefined : color.value, perms, hoist: hoist.checked, mentionable: mention.checked });
            toast("Role saved.");
            await reload();
          })),
          r.everyone ? null : btn("ls-btn.red", "Delete role", () => {
            if (confirm(`Delete the role ${r.name}?`)) attempt(err, async () => { await core.api("role_delete", { role: r.id }); M._roleSel = null; await reload(); });
          })));
      }
    }
    function members() {
      const q = h("input.ls-input", { placeholder: "Search members" });
      const list = h("div");
      const fill = () => {
        list.replaceChildren();
        for (const m of srv.members.filter((x) => (x.name + " " + (x.nick || "")).toLowerCase().includes(q.value.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))) {
          const roles = srv.roles.filter((r) => m.roles.includes(r.id)).sort((a, b) => b.position - a.position);
          const row = h("div.ls-friend-row", null, avatar(m, 32, m.status), h("div.ls-grow", null,
            h("b", { text: displayName(srv, m.name), style: topColor(srv, m) ? { color: topColor(srv, m) } : null }), m.owner ? h("span.ls-crown", { title: "Server owner" }, S.icon("crown", 13)) : "",
            h("div.ls-sub", { text: `${m.name} · joined ${new Date(m.joined).toLocaleDateString()}` }),
            h("div.ls-role-chips", null, ...roles.map((r) => h("span.ls-role-chip", null, h("span.ls-role-dot", { style: { background: r.color || "var(--ls-muted)" } }), r.name)))));
          row.append(modActions(srv, m, m.name === core.data.me.name));
          list.append(row);
        }
      };
      q.oninput = fill;
      fill();
      pane.append(h("h3", { text: `Members — ${srv.members.length}` }), q, list);
    }
    function bans() {
      pane.append(h("h3", { text: "Bans" }));
      if (!srv.bans.length) pane.append(h("p.ls-sub", { text: "No one is banned." }));
      for (const b of srv.bans) {
        pane.append(h("div.ls-friend-row", null, avatar({ name: b.name }, 32), h("div.ls-grow", null, h("b", { text: b.name }), h("div.ls-sub", { text: (b.reason ? `Reason: ${b.reason} · ` : "") + new Date(b.created).toLocaleDateString() })),
          btn("ls-btn.small.grey", "Unban", () => attempt(err, async () => { await core.api("server_ban", { id: srv.server.id, name: b.name, ban: false }); await reload(); }))));
      }
    }
    async function audit() {
      pane.append(h("h3", { text: "Audit log" }));
      const list = h("div.ls-audit", null, h("div.ls-sub", { text: "Loading…" }));
      pane.append(list);
      try {
        const out = await core.api("server_audit_log", { id: srv.server.id });
        list.replaceChildren();
        if (!out.entries.length) list.append(h("div.ls-sub", { text: "Nothing yet." }));
        for (const e of out.entries) {
          const detail = e.detail ? Object.entries(e.detail).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" · ") : "";
          list.append(h("div.ls-audit-row", null, h("b", { text: e.actor }), " ", h("span", { text: e.action.replace(".", " ") }), detail ? h("div.ls-sub", { text: detail }) : null,
            h("div.ls-sub", { text: new Date(e.at).toLocaleString() })));
        }
      } catch (e) { list.replaceChildren(h("div.ls-form-err", { text: e.message })); }
    }
    function danger() {
      const others = srv.members.filter((m) => !m.owner);
      const sel = h("select.ls-input", null, h("option", { value: "", text: "Pick a member…" }), ...others.map((m) => h("option", { value: m.name, text: m.name })));
      pane.append(h("h3", { text: "Ownership" }), h("p.ls-sub", { text: "Hand the server to another member. They must not already own a server. You become a regular member." }),
        sel, btn("ls-btn.grey", "Transfer ownership", () => {
          if (!sel.value) return;
          if (confirm(`Give ${srv.server.name} to ${sel.value}? You can't undo this yourself.`)) attempt(err, async () => { await core.api("server_transfer", { id: srv.server.id, name: sel.value }); m.close(); refreshServer(srv.server.id); });
        }),
        h("h3", { text: "Delete server" }), h("p.ls-sub", { text: "Deletes every channel, message and role. This can't be undone." }),
        btn("ls-btn.red", "Delete server", () => {
          const typed = prompt(`Type the server name (${srv.server.name}) to delete it.`);
          if (typed !== srv.server.name) return;
          attempt(err, async () => { await core.api("server_delete", { id: srv.server.id }); m.close(); ui.openHome(); core.sync(); });
        }));
    }
    const m = modal("Server settings", h("div.ls-settings", null, nav, pane), { wide: true });
    paint();
  };

  // ---- group chats ----
  M.newGroup = () => {
    const name = h("input.ls-input", { maxLength: 32, placeholder: "Group name" });
    const picked = new Set();
    const list = h("div.ls-check-list");
    for (const f of core.data.friends) {
      list.append(h("label.ls-check", null, h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? picked.add(f.name) : picked.delete(f.name)) }), avatar(f, 24, f.status), h("span", { text: f.name })));
    }
    if (!core.data.friends.length) list.append(h("div.ls-sub", { text: "Add some friends first." }));
    const err = errorLine();
    modal("New group chat", h("div.ls-form", null, field("Name", name), h("div.ls-sect", { text: "Friends (up to 9)" }), list, err), {
      actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn", "Create group", () => attempt(err, async () => {
        const out = await core.run("party_create", { name: name.value.trim(), members: [...picked] });
        close();
        ui.openChat({ party: out.party });
      }))],
    });
  };
  M.renameGroup = (p) => {
    const name = h("input.ls-input", { value: p.name, maxLength: 32 });
    const err = errorLine();
    modal("Rename group", h("div.ls-form", null, field("Name", name), err), {
      actions: (close) => [btn("ls-btn.grey", "Cancel", close), btn("ls-btn", "Save", () => attempt(err, async () => { await core.run("party_rename", { id: p.id, name: name.value }); close(); }))],
    });
  };
  M.addToGroup = (p, addable) => {
    const list = h("div.ls-check-list");
    for (const f of addable) list.append(h("div.ls-friend-row", null, avatar(f, 28, f.status), h("span.ls-grow", { text: f.name }),
      btn("ls-btn.small", "Add", (e) => core.run("party_add", { id: p.id, name: f.name }).then(() => { e.target.textContent = "Added"; e.target.disabled = true; }).catch((x) => toast(x.message, true)))));
    modal(`Add friends to ${p.name}`, h("div.ls-form", null, list));
  };

  // ---- pins ----
  M.pins = async (channel, anchor) => {
    const box = h("div.ls-pins", null, h("div.ls-sect", { text: "Pinned messages" }), h("div.ls-sub", { text: "Loading…" }));
    popover(anchor, box);
    try {
      const out = await core.api("pins", { channel });
      box.lastChild.remove();
      if (!out.pins.length) box.append(h("div.ls-sub", { text: "Nothing pinned yet. People with Manage Messages can pin from a message's pin button." }));
      for (const p of out.pins) {
        box.append(h("div.ls-pin", null, h("div", null, h("b", { text: p.from }), " ", h("span.ls-sub", { text: new Date(p.created).toLocaleString() })),
          p.body.startsWith("::img::") ? h("img.ls-img.small", { src: "/api/img/" + p.body.slice(7).replace(/[^0-9a-f]/g, "") }) : ui.helpers.richText(p.body, ui.helpers.currentServer())));
      }
    } catch (e) { box.lastChild.textContent = e.message; }
  };

  // ---- preferences (used in game overlays; the launcher has a full page) ----
  M.prefs = () => {
    const body = h("div.ls-form");
    const paint = () => {
      body.replaceChildren();
      const toggle = (key, label) => h("label.ls-perm", null, h("span.ls-grow", { text: label }),
        h("input.ls-switch", { type: "checkbox", checked: !!core.pref(key), onchange: (e) => core.setPrefs({ [key]: e.target.checked }).then(paint) }));
      body.append(h("div.ls-sect", { text: "Social hotkey" }),
        btn("ls-btn.grey", S.binding === "hotkey" ? "Press a key… (Esc cancels)" : `Opens social: ${core.keyLabel(core.pref("hotkey"))} · change`, () => bindKey("hotkey", paint)),
        h("div.ls-sect", { text: "Auto-away" }),
        h("div.ls-seg", null, ...[5, 10, 15, 30, 0].map((m) => btn("ls-seg-btn" + (core.pref("afk") === m ? ".on" : ""), m ? `${m} min` : "Off", () => core.setPrefs({ afk: m }).then(paint)))),
        h("div.ls-sect", { text: "Notifications" }), toggle("sounds", "Sounds"), toggle("dmToasts", "Pop-ups for direct messages"), toggle("mentionsOnly", "Only pop up for @mentions"),
        h("div.ls-sect", { text: "Voice" }), toggle("ptt", "Push to talk"),
        core.pref("ptt") ? btn("ls-btn.grey", S.binding === "pttKey" ? "Press a key… (Esc cancels)" : `Talk key: ${core.keyLabel(core.pref("pttKey"))} · change`, () => bindKey("pttKey", paint)) : null,
        h("div.ls-sect", { text: "Theme" }),
        h("div.ls-seg", null, ...[["dark", "Dark"], ["light", "Light"], ["system", "Match device"]].map(([k, l]) => btn("ls-seg-btn" + (core.pref("theme") === k ? ".on" : ""), l, () => core.setPrefs({ theme: k }).then(paint)))),
        h("p.ls-sub", null, "More settings (password, devices, picture) are on the launcher's Settings page."));
    };
    paint();
    modal("Settings", body);
  };
  function bindKey(pref, repaint) {
    S.binding = pref;
    repaint();
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeEventListener("keydown", onKey, true);
      S.binding = null;
      if (e.code !== "Escape") core.setPrefs({ [pref]: e.code }).then(repaint);
      else repaint();
    };
    addEventListener("keydown", onKey, true);
  }
  M.bindKey = bindKey;
})();
