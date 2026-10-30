// Calls: a peer-to-peer WebRTC mesh (everyone in a room connects to everyone
// else, up to 8 people). Signalling goes through the launcher's live socket;
// voice, camera and screen go straight between browsers. When a network
// blocks the direct path, that connection retries through the TURN relay
// (/api/turn, capped in rt/turn.js); if the relay is off too, the call says
// who it can't reach. Nothing is recorded. The microphone opens when you join,
// the camera and the screen only when you turn them on.
//
// Each connection has three fixed transceivers (voice, camera, screen), so
// turning video on or off is a replaceTrack, not a renegotiation. Offers and
// answers follow the "perfect negotiation" pattern, one message at a time per
// connection, so ICE restarts from both ends can't collide.
(() => {
  const S = (globalThis.LauncherSocial ||= {});
  if (S.voice) return;
  const core = S.core;
  const STUN = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  const SLOTS = ["audio", "cam", "screen"]; // transceivers, in m-line order
  const CONNECT_MS = 15_000; // a connection that isn't up by then gets the next recovery step
  const RING_MS = 35_000;
  const NO_ANSWER_MS = 60_000;
  const VOL_STORE = "launcher_voice_volumes";
  const DEV_STORE = "launcher_voice_devices";
  const load = (key) => { try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { return {}; } };
  const save = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };
  const volumes = load(VOL_STORE);
  const devices = load(DEV_STORE); // {mic, cam}: device ids picked on this computer

  const v = {
    room: null, // room id while connected
    target: null, // {channel}|{party}|{with}
    label: "",
    server: null,
    members: [],
    peers: new Map(), // conn -> peer (see makePeer)
    speaking: new Set(), // conns (and "me")
    muted: false,
    deaf: false,
    pttDown: false,
    joining: false,
    reconnecting: false, // the socket dropped; rejoining when it's back
    since: 0, // when this tab joined the room
    rang: false, // this tab started the call and rang the others
    cam: false, // sending my camera
    screen: false, // sending my screen
    local: { cam: null, screen: null }, // my own camera / screen streams (previews)
    incoming: null, // {room, from, party, at}: someone is calling
    error: "",
    micError: "",
    camError: "",
    relayError: "",
    needsClick: false, // the browser held back call sound until a click
  };
  S.voice = v;
  const changed = () => core.emit("voice", v);

  let mic = null;
  let localAnalyser = null;
  let audioCtx = null;
  const ctx = () => (audioCtx ||= new AudioContext());

  const me = () => v.members.find((m) => m.conn === core.conn);
  const memberOf = (conn) => v.members.find((m) => m.conn === conn);
  /** Whether my microphone should be sending right now. */
  function micLive() {
    const self = me();
    if (!mic || v.muted || v.deaf || self?.smute || self?.speak === false) return false;
    return core.pref("ptt") ? v.pttDown : true;
  }
  function applyMic() {
    const live = micLive();
    for (const t of mic?.getAudioTracks() || []) t.enabled = live;
  }
  function applyAudio() {
    for (const [conn, p] of v.peers) {
      if (!p.audio) continue;
      p.audio.muted = v.deaf || !!memberOf(conn)?.smute;
      p.audio.volume = Math.max(0, Math.min(1, volumes[p.name] ?? 1));
    }
  }
  v.volume = (name) => volumes[name] ?? 1;
  v.setVolume = (name, value) => {
    volumes[name] = value;
    save(VOL_STORE, volumes);
    applyAudio();
  };
  /** May I send voice and video here (not server-muted, allowed to speak)? */
  v.canSend = () => {
    const self = me();
    return !!v.room && !self?.smute && self?.speak !== false;
  };
  v.canShare = () => !!navigator.mediaDevices?.getDisplayMedia;
  v.canVideo = () => !!navigator.mediaDevices?.getUserMedia;

  // ---- microphone, camera and screen ----
  function mediaError(e, what) {
    const name = e?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return what === "microphone"
        ? "The browser is blocking your microphone. Allow it for this site (the icon at the left of the address bar), then press Try again. You can still listen."
        : "The browser is blocking your camera. Allow it for this site (the icon at the left of the address bar), then try again.";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") return what === "microphone" ? "No microphone found. You can still listen." : "No camera found.";
    if (name === "NotReadableError" || name === "AbortError") return `Your ${what} is busy (another app or tab may be using it). Close that, then try again.`;
    return `Couldn't open your ${what}.`;
  }
  async function getMic() {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!devices.mic) return navigator.mediaDevices.getUserMedia({ audio });
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: devices.mic } } });
    } catch (e) {
      if (e?.name !== "OverconstrainedError" && e?.name !== "NotFoundError") throw e;
      delete devices.mic; // that microphone is gone: use the default one
      save(DEV_STORE, devices);
      return navigator.mediaDevices.getUserMedia({ audio });
    }
  }
  let micAsk = null;
  const openMic = () => (micAsk ||= askMic().finally(() => { micAsk = null; }));
  async function askMic() {
    v.micError = "";
    if (mic) return true;
    if (!navigator.mediaDevices?.getUserMedia) { v.micError = "This page can't use a microphone here. You can still listen."; return false; }
    let s;
    try { s = await getMic(); } catch (e) { v.micError = mediaError(e, "microphone"); return false; }
    if (!v.room && !v.joining && !v.reconnecting) { for (const t of s.getTracks()) t.stop(); return false; }
    mic = s;
    localAnalyser = analyse(s);
    const track = s.getAudioTracks()[0];
    track.onended = () => { if (mic === s) swapMic(); }; // unplugged
    applyMic();
    sendTrack("audio", track);
    return true;
  }
  async function swapMic() {
    const old = mic;
    mic = null;
    localAnalyser = null;
    for (const t of old?.getTracks() || []) t.stop();
    sendTrack("audio", null);
    if (v.room) await openMic();
    changed();
  }
  v.retryMic = async () => { await openMic(); changed(); };

  function camConstraints() {
    const c = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } };
    if (devices.cam) c.deviceId = { ideal: devices.cam };
    return c;
  }
  function setLocal(slot, stream) {
    const track = stream.getVideoTracks()[0];
    if (slot === "screen") track.contentHint = "detail";
    // The browser's own "Stop sharing" button, or an unplugged camera.
    track.onended = () => { if (v.local[slot] === stream) stopLocal(slot); };
    for (const t of v.local[slot]?.getTracks() || []) t.stop();
    v.local[slot] = stream;
    v[slot] = true;
    sendTrack(slot, track);
    announceMedia();
    changed();
  }
  function stopLocal(slot) {
    const s = v.local[slot];
    v.local[slot] = null;
    v[slot] = false;
    for (const t of s?.getTracks() || []) t.stop();
    sendTrack(slot, null);
    announceMedia();
    changed();
  }
  v.toggleCam = async () => {
    if (v.cam) { stopLocal("cam"); return; }
    if (!v.canSend() || !v.canVideo()) return;
    v.camError = "";
    changed();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
      if (!v.room) { for (const t of s.getTracks()) t.stop(); return; }
      setLocal("cam", s);
    } catch (e) { v.camError = mediaError(e, "camera"); changed(); }
  };
  v.toggleScreen = async () => {
    if (v.screen) { stopLocal("screen"); return; }
    if (!v.canSend()) return;
    if (!v.canShare()) { v.camError = "This browser can't share its screen."; changed(); return; }
    v.camError = "";
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: false, selfBrowserSurface: "include", surfaceSwitching: "include",
      });
      if (!v.room) { for (const t of s.getTracks()) t.stop(); return; }
      setLocal("screen", s);
    } catch (e) {
      // Cancelling the browser's picker is not an error.
      if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") { v.camError = "Couldn't share your screen."; changed(); }
    }
  };

  v.listDevices = async () => {
    try { return await navigator.mediaDevices.enumerateDevices(); } catch { return []; }
  };
  v.device = (kind) => devices[kind] || "";
  v.setDevice = async (kind, id) => {
    if (id) devices[kind] = id; else delete devices[kind];
    save(DEV_STORE, devices);
    if (kind === "mic" && mic) await swapMic();
    if (kind === "cam" && v.cam) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
        if (v.cam && v.room) setLocal("cam", s); else for (const t of s.getTracks()) t.stop();
      } catch (e) { v.camError = mediaError(e, "camera"); changed(); }
    }
  };

  function analyse(s) {
    try {
      const a = ctx().createAnalyser();
      a.fftSize = 512;
      ctx().createMediaStreamSource(s).connect(a);
      return a;
    } catch { return null; }
  }
  const buf = new Uint8Array(512);
  function level(a) {
    if (!a) return 0;
    a.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
    return Math.sqrt(sum / buf.length);
  }
  // Speaking rings change often, so they get their own event: the UI updates
  // them in place instead of redrawing everything.
  setInterval(() => {
    if (!v.room) return;
    const next = new Set();
    if (micLive() && level(localAnalyser) > 0.04) next.add("me");
    for (const [conn, p] of v.peers) if (!v.deaf && level(p.analyser) > 0.03) next.add(conn);
    if (next.size !== v.speaking.size || [...next].some((x) => !v.speaking.has(x))) { v.speaking = next; core.emit("voice-speaking", v); }
  }, 120);

  // ---- the relay ----
  let relay = null; // {iceServers, until}
  let relayAsk = null;
  let relayNoUntil = 0;
  function getRelay() {
    if (relay && relay.until > Date.now()) return Promise.resolve(relay);
    if (Date.now() < relayNoUntil) return Promise.resolve(null);
    relayAsk ||= core.api("turn").then((out) => {
      relay = { iceServers: out.iceServers || [], until: Date.now() + Math.max(60, (out.ttl || 3600) - 600) * 1000 };
      v.relayError = "";
      return relay;
    }).catch((e) => {
      v.relayError = e.message;
      relayNoUntil = Date.now() + 10 * 60_000; // don't ask again for every person in the call
      return null;
    }).finally(() => { relayAsk = null; });
    return relayAsk;
  }
  const rtcConfig = () => ({ iceServers: relay && relay.until > Date.now() ? [...STUN, ...relay.iceServers] : STUN });

  // ---- peers ----
  const randomGen = () => Math.random().toString(36).slice(2, 10);
  function signalTo(conn, data) { return core.send({ t: "rtc", to: conn, data }); }
  function signal(p, data) { return signalTo(p.conn, p.gen ? { ...data, gen: p.gen } : data); }
  /** The person who joined later starts each connection. */
  function iStart(m) {
    const mine = me();
    return !!mine && !!m && (mine.since > m.since || (mine.since === m.since && core.conn > m.conn));
  }

  function makePeer(member, initiator, gen) {
    const pc = new RTCPeerConnection(rtcConfig());
    const p = {
      pc, conn: member.conn, name: member.name, uid: member.uid, gen: gen || null,
      polite: core.conn < member.conn, makingOffer: false, ignoreOffer: false, chain: Promise.resolve(),
      state: "connecting", tries: 0, busy: false, relayed: false, rtt: null, born: Date.now(), timer: null,
      tx: {}, remote: { audio: null, cam: null, screen: null }, media: { cam: false, screen: false },
      audio: null, analyser: null,
    };
    v.peers.set(member.conn, p);
    pc.onnegotiationneeded = () => negotiate(p);
    pc.onicecandidate = (e) => { if (e.candidate) signal(p, { candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => onTrack(p, e);
    pc.onconnectionstatechange = () => onState(p);
    pc.onsignalingstatechange = () => { if (pc.signalingState === "stable") tune(p); };
    if (initiator) {
      p.gen = randomGen();
      p.tx.audio = pc.addTransceiver("audio", { direction: "sendrecv" });
      p.tx.cam = pc.addTransceiver("video", { direction: "sendrecv" });
      p.tx.screen = pc.addTransceiver("video", { direction: "sendrecv" });
      attach(p);
    }
    watch(p, CONNECT_MS);
    return p;
  }
  function closePeer(p) {
    clearTimeout(p.timer);
    const pc = p.pc;
    pc.onnegotiationneeded = pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.onsignalingstatechange = null;
    try { pc.close(); } catch {}
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    p.closed = true;
  }
  /** Puts my current tracks on a connection's senders. */
  function attach(p) {
    const tracks = { audio: mic?.getAudioTracks()[0] || null, cam: v.local.cam?.getVideoTracks()[0] || null, screen: v.local.screen?.getVideoTracks()[0] || null };
    for (const slot of SLOTS) {
      const t = p.tx[slot];
      if (t && t.sender.track !== tracks[slot]) t.sender.replaceTrack(tracks[slot]).catch(() => {});
    }
  }
  function sendTrack(slot, track) {
    for (const p of v.peers.values()) {
      const t = p.tx[slot];
      if (t && !p.closed) t.sender.replaceTrack(track).then(() => tune(p)).catch(() => {});
    }
  }
  function announceMedia() {
    for (const p of v.peers.values()) signal(p, { media: { cam: v.cam, screen: v.screen } });
    sendState();
  }
  const sendState = () => core.send({ t: "vset", muted: v.muted || v.deaf, deaf: v.deaf, video: v.cam, screen: v.screen });

  /** The answering side adopts the offer's transceivers: voice, camera, screen. */
  function adopt(p) {
    if (p.tx.audio) return;
    const list = p.pc.getTransceivers();
    const videos = list.filter((t) => t.receiver.track.kind === "video");
    p.tx = { audio: list.find((t) => t.receiver.track.kind === "audio"), cam: videos[0], screen: videos[1] };
    for (const slot of SLOTS) if (p.tx[slot]) p.tx[slot].direction = "sendrecv";
    attach(p);
  }
  function slotOf(p, tr) {
    for (const s of SLOTS) if (p.tx[s] === tr) return s;
    if (tr.receiver.track.kind === "audio") return "audio";
    return p.pc.getTransceivers().filter((t) => t.receiver.track.kind === "video").indexOf(tr) === 1 ? "screen" : "cam";
  }
  function onTrack(p, e) {
    const slot = slotOf(p, e.transceiver);
    const stream = new MediaStream([e.track]);
    p.remote[slot] = stream;
    if (slot === "audio") {
      if (!p.audio) {
        p.audio = document.createElement("audio");
        p.audio.autoplay = true;
        p.audio.hidden = true;
        document.body.append(p.audio);
      }
      p.audio.srcObject = stream;
      play(p.audio);
      p.analyser = analyse(stream);
      applyAudio();
    } else {
      e.track.onmute = e.track.onunmute = () => changed();
    }
    changed();
  }
  function play(el) {
    el.play?.()?.catch((e) => { if (e?.name === "NotAllowedError" && !v.needsClick) { v.needsClick = true; changed(); } });
  }
  v.unblock = () => {
    if (!v.needsClick) return;
    v.needsClick = false;
    ctx().resume?.();
    for (const p of v.peers.values()) if (p.audio) play(p.audio);
    changed();
  };
  addEventListener("pointerdown", () => v.unblock(), true);
  addEventListener("keydown", () => v.unblock(), true);

  /** Shown video for a person in the call: their camera or screen stream, or null. */
  v.video = (conn, slot) => {
    if (conn === core.conn) return v[slot] ? v.local[slot] : null;
    const p = v.peers.get(conn);
    const s = p?.media[slot] && p.state !== "failed" ? p.remote[slot] : null;
    const track = s?.getVideoTracks()[0];
    return track && track.readyState === "live" && !track.muted ? s : null;
  };
  /** Whether that person says they're sending video we haven't got yet. */
  v.videoPending = (conn, slot) => {
    const p = v.peers.get(conn);
    return !!p?.media[slot] && !v.video(conn, slot);
  };

  async function negotiate(p) {
    // The answering side has nothing to offer until it has adopted the first offer.
    if (p.closed || !p.tx.audio) return;
    try {
      p.makingOffer = true;
      await p.pc.setLocalDescription();
      signal(p, { sdp: p.pc.localDescription });
    } catch (e) {
      console.warn("[voice] offer failed", e);
    } finally {
      p.makingOffer = false;
    }
  }
  async function handle(p, data) {
    const pc = p.pc;
    if (p.closed) return;
    if (data.sdp) {
      const d = data.sdp;
      const collision = d.type === "offer" && (p.makingOffer || pc.signalingState !== "stable");
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(d); // rolls back my own offer if we collided
      if (d.type === "offer") {
        adopt(p);
        await pc.setLocalDescription();
        signal(p, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer && pc.remoteDescription) throw e; }
    }
  }

  function onState(p) {
    if (p.closed) return;
    const st = p.pc.connectionState;
    if (st === "connected") {
      clearTimeout(p.timer);
      p.timer = null;
      p.state = "connected";
      p.tries = 0;
      signal(p, { media: { cam: v.cam, screen: v.screen } });
      stats(p);
    } else if (st === "disconnected") {
      p.state = "reconnecting";
      watch(p, 5000); // give it a few seconds to come back by itself
    } else if (st === "failed") {
      recover(p);
    }
    changed();
  }
  function watch(p, ms) {
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (v.peers.get(p.conn) === p && p.pc.connectionState !== "connected") recover(p);
    }, ms);
  }
  /**
   * The next step for a connection that failed or isn't up in time: an ICE
   * restart, then the relay, then a fresh connection, then give up (the UI
   * offers Retry).
   */
  async function recover(p) {
    if (v.peers.get(p.conn) !== p || p.busy) return;
    p.busy = true;
    try {
      p.tries++;
      const m = memberOf(p.conn);
      const started = !!p.pc.remoteDescription;
      if (p.tries >= 4) { p.state = "failed"; changed(); return; }
      if (p.tries === 3 || !started) {
        // A fresh connection: the side that starts it rebuilds; the other side asks.
        if (iStart(m)) { rebuild(p.conn, p.tries); return; }
        signal(p, { reset: true });
        p.state = "connecting";
        watch(p, CONNECT_MS);
        changed();
        return;
      }
      if (p.tries === 2) {
        p.state = "relay";
        changed();
        const r = await getRelay();
        if (v.peers.get(p.conn) !== p) return;
        if (r) p.pc.setConfiguration(rtcConfig());
      } else p.state = "reconnecting";
      p.pc.restartIce();
      watch(p, CONNECT_MS);
      changed();
    } finally {
      p.busy = false;
    }
  }
  function rebuild(conn, tries) {
    const old = v.peers.get(conn);
    if (old) { closePeer(old); v.peers.delete(conn); }
    const m = memberOf(conn);
    if (!m) return;
    const p = makePeer(m, true);
    p.tries = tries;
    if (old) p.media = old.media;
    changed();
  }
  /** "Retry" or "Reconnect" on someone: a fresh connection now. */
  v.retryPeer = (conn) => {
    const m = memberOf(conn);
    if (!m) return;
    if (relayNoUntil && !relay) relayNoUntil = 0; // ask the relay again
    if (iStart(m)) { rebuild(conn, 1); return; }
    // The other side rebuilds; its new offer replaces this connection.
    const p = v.peers.get(conn);
    if (p) {
      p.tries = 1;
      if (p.state === "failed") { p.state = "connecting"; watch(p, CONNECT_MS); }
    }
    signalTo(conn, { reset: true, now: true, ...(p?.gen ? { gen: p.gen } : {}) });
    changed();
  };

  // Connection quality, and a safety net for a first offer that never came.
  async function stats(p) {
    try {
      const report = await p.pc.getStats();
      const byId = new Map();
      report.forEach((s) => byId.set(s.id, s));
      let pair = null;
      report.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId); });
      if (!pair) report.forEach((s) => { if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s; });
      if (!pair) return;
      const rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
      const relayed = byId.get(pair.localCandidateId)?.candidateType === "relay" || byId.get(pair.remoteCandidateId)?.candidateType === "relay";
      const bucket = (x) => (x == null ? 0 : x < 150 ? 3 : x < 300 ? 2 : 1);
      const moved = bucket(rtt) !== bucket(p.rtt) || relayed !== p.relayed;
      p.rtt = rtt;
      p.relayed = relayed;
      if (moved) { tune(p); changed(); }
    } catch {}
  }
  setInterval(() => {
    if (!v.room) return;
    for (const p of v.peers.values()) if (p.state === "connected") stats(p);
    const now = Date.now();
    for (const m of v.members) {
      if (m.conn === core.conn || v.peers.has(m.conn) || iStart(m)) continue;
      // They should have called us by now: ask them for a connection.
      if (now - (seenAt.get(m.conn) || now) > 8000 && now - (askedAt.get(m.conn) || 0) > 8000) {
        askedAt.set(m.conn, now);
        signalTo(m.conn, { reset: true });
      }
    }
  }, 4000);
  /** Video bit rates: lower with more people, and lower through the relay. */
  function tune(p) {
    if (p.closed) return;
    const n = Math.max(1, v.peers.size);
    const k = p.relayed ? 0.6 : 1;
    setRate(p.tx.cam?.sender, (n <= 2 ? 600 : n <= 4 ? 350 : 200) * k, 24);
    setRate(p.tx.screen?.sender, (n <= 2 ? 1500 : n <= 4 ? 900 : 500) * k, 15);
  }
  function setRate(sender, kbps, fps) {
    if (!sender?.track) return;
    try {
      const params = sender.getParameters();
      const enc = params.encodings?.[0];
      if (!enc) return; // not negotiated yet
      const want = Math.round(kbps * 1000);
      if (enc.maxBitrate === want && enc.maxFramerate === fps) return;
      enc.maxBitrate = want;
      enc.maxFramerate = fps;
      sender.setParameters(params).catch(() => {});
    } catch {}
  }

  // The first connection in a page pays for WebRTC's start-up (about 2 s in
  // a fresh browser). Pay it while the microphone prompt and the join request
  // are under way, or while a call rings.
  let warmed = false;
  v.warmUp = () => {
    if (warmed || typeof RTCPeerConnection !== "function") return;
    warmed = true;
    try {
      const pc = new RTCPeerConnection();
      pc.addTransceiver("audio");
      pc.addTransceiver("video");
      pc.setLocalDescription().catch(() => {}).finally(() => pc.close());
    } catch {}
  };

  // ---- joining and leaving ----
  let joinSeq = 0;
  let pendingRtc = []; // signalling that came before the room update
  let rejoinOff = null;
  let staleSince = null; // my "since" in the room this tab last left
  const seenAt = new Map(); // conn -> when they showed up in my room (local clock)
  const askedAt = new Map();
  function waitConn(ms) {
    return new Promise((resolve, reject) => {
      const off = core.on("conn", () => { clearTimeout(timer); off(); resolve(); });
      const timer = setTimeout(() => { off(); reject(new Error("Not connected to the launcher. Check your connection.")); }, ms);
    });
  }
  v.join = async (target, label, server = null, opts = {}) => {
    if (v.joining) return;
    if (v.room || v.reconnecting) v.leave(true, opts.keepMedia);
    const seq = ++joinSeq;
    v.joining = true;
    v.error = v.micError = v.camError = v.relayError = "";
    v.target = target;
    v.label = label;
    v.server = server;
    v.rang = false;
    if (v.incoming && sameCall(v.incoming, target)) stopRing();
    changed();
    try {
      // The microphone opens alongside the join: it goes on every connection
      // as soon as it's ready (or when the browser's prompt is answered).
      openMic().then(() => changed());
      if (!core.conn) await waitConn(8000);
      if (seq !== joinSeq) return;
      const asked = core.api("voice_join", { ...target, conn: core.conn, ring: opts.ring !== false });
      v.warmUp(); // while the request (and their phone) rings
      const out = await asked;
      if (seq !== joinSeq) { core.send({ t: "vleave", room: out.room }); return; } // left while joining
      enter(out.room);
      v.rang = !!out.rang && v.members.length <= 1;
      v.joining = false;
      changed();
      if (opts.video) v.toggleCam();
    } catch (e) {
      if (seq !== joinSeq) return;
      const wasIn = v.room;
      v.error = e.message;
      cleanup();
      if (wasIn) core.send({ t: "vleave", room: wasIn });
    } finally {
      if (seq === joinSeq) { v.joining = false; changed(); }
    }
  };
  /**
   * In the room. The Hub's room update often arrives over the socket before
   * the join request answers, so this runs from whichever comes first.
   */
  function enter(room) {
    if (v.room === room) return;
    v.room = room;
    v.since = Date.now();
    v.reconnecting = false;
    ctx().resume?.();
    applyMic();
    if (v.muted || v.deaf || v.cam || v.screen) sendState();
    core.beep("join");
  }
  v.leave = (quiet, keepMedia) => {
    if (!v.room && !v.joining && !v.reconnecting) return;
    const room = v.room;
    staleSince = me()?.since ?? staleSince;
    joinSeq++;
    v.joining = false;
    v.reconnecting = false;
    rejoinOff?.();
    rejoinOff = null;
    // The room goes with it: this can reach the Hub after the next join (which goes by HTTP).
    if (room && !core.send({ t: "vleave", room })) core.api("voice_leave", { conn: core.conn, room }).catch(() => {});
    cleanup(keepMedia);
    if (!quiet) core.beep("leave");
    changed();
  };
  function cleanup(keepMedia = false) {
    for (const p of v.peers.values()) closePeer(p);
    v.peers.clear();
    v.room = null;
    v.members = [];
    v.speaking = new Set();
    v.since = 0;
    v.rang = false;
    v.needsClick = false;
    pendingRtc = [];
    seenAt.clear();
    askedAt.clear();
    if (keepMedia) return;
    for (const t of mic?.getTracks() || []) t.stop();
    mic = null;
    localAnalyser = null;
    for (const slot of ["cam", "screen"]) {
      for (const t of v.local[slot]?.getTracks() || []) t.stop();
      v.local[slot] = null;
      v[slot] = false;
    }
  }
  v.toggleMute = () => {
    v.muted = !v.muted;
    if (!v.muted && v.deaf) v.deaf = false;
    applyMic();
    applyAudio();
    sendState();
    changed();
  };
  v.toggleDeaf = () => {
    v.deaf = !v.deaf;
    applyMic();
    applyAudio();
    sendState();
    changed();
  };
  /** Ring the people who aren't in the call again. */
  v.ring = () => {
    if (!v.room || !v.target || v.target.channel != null) return;
    core.api("voice_ring", v.target).then(() => { v.rang = true; v.since = Date.now(); changed(); }).catch((e) => { v.error = e.message; changed(); });
  };

  // Push-to-talk.
  const editable = (t) => t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  addEventListener("keydown", (e) => {
    if (!v.room || !core.pref("ptt") || e.code !== core.pref("pttKey") || e.repeat || editable(e.target)) return;
    v.pttDown = true;
    applyMic();
    changed();
  }, true);
  addEventListener("keyup", (e) => {
    if (!v.pttDown || e.code !== core.pref("pttKey")) return;
    v.pttDown = false;
    applyMic();
    changed();
  }, true);
  addEventListener("blur", () => { if (v.pttDown) { v.pttDown = false; applyMic(); changed(); } });
  core.on("prefs", () => { applyMic(); });

  // ---- the Hub's room updates and signalling ----
  core.on("ev:vroom", (ev) => {
    if (!ev.room) {
      if (v.room && !v.joining) { cleanup(); v.error = "You left voice (you joined from another tab)."; changed(); }
      return;
    }
    const mine = ev.members?.find((m) => m.conn === core.conn);
    // Not in it, or an update sent before this tab left that room.
    if (!mine || (staleSince != null && mine.since === staleSince)) return;
    if (ev.room !== v.room) {
      if (v.joining) enter(ev.room);
      else { core.send({ t: "vleave", room: ev.room }); return; } // a room this tab already left
    }
    const before = new Set(v.members.map((m) => m.conn));
    v.members = ev.members;
    const now = Date.now();
    for (const m of ev.members) {
      if (m.conn === core.conn) continue;
      if (!seenAt.has(m.conn)) seenAt.set(m.conn, now);
      const p = v.peers.get(m.conn);
      if (p) { p.name = m.name; continue; }
      if (iStart(m)) makePeer(m, true);
      if (before.size && !before.has(m.conn)) core.beep("join");
    }
    for (const [conn, p] of v.peers) {
      if (!ev.members.some((m) => m.conn === conn)) { closePeer(p); v.peers.delete(conn); core.beep("leave"); }
    }
    if (ev.members.length > 1) v.rang = false; // answered
    for (const p of v.peers.values()) tune(p);
    applyMic();
    applyAudio();
    const early = pendingRtc;
    pendingRtc = [];
    for (const e of early) onRtc(e);
    changed();
  });

  function onRtc(ev) {
    const data = ev.data;
    const member = memberOf(ev.from) || { conn: ev.from, name: "…", uid: 0, since: Infinity };
    let p = v.peers.get(ev.from);
    if (data.reset) {
      // They want a fresh connection. Only the side that starts connections
      // rebuilds; an automatic ask right after a rebuild is one we've answered.
      if (iStart(member) && (!p || data.now || Date.now() - p.born > 4000)) rebuild(ev.from, data.now ? 1 : p?.tries ?? 0);
      return;
    }
    if (data.gen && p?.gen && data.gen !== p.gen) {
      if (data.sdp?.type !== "offer" || iStart(member)) return; // from a connection that's been replaced
      const old = p;
      closePeer(old);
      v.peers.delete(ev.from);
      p = makePeer(member, false, data.gen);
      p.tries = old.tries;
      p.media = old.media;
    }
    if (data.media) {
      if (p) { p.media = { cam: !!data.media.cam, screen: !!data.media.screen }; changed(); }
      return;
    }
    if (!p) {
      if (data.sdp?.type !== "offer") return;
      p = makePeer(member, false, data.gen);
    } else if (!p.gen && data.gen && data.sdp?.type === "offer") p.gen = data.gen;
    p.chain = p.chain.then(() => handle(p, data)).catch((e) => console.warn("[voice] signalling failed", e));
  }
  core.on("ev:rtc", (ev) => {
    if (!ev.from || !ev.data) return;
    if (!v.room || !me()) { if (v.joining || v.room) pendingRtc.push(ev); return; }
    onRtc(ev);
  });

  // The socket dropped: the Hub already took us out of the room. Rejoin, with
  // the same microphone, camera and screen, once the new socket is up.
  core.on("socket", (up) => {
    if (up || (!v.room && !v.joining)) return;
    const again = { target: v.target, label: v.label, server: v.server };
    joinSeq++;
    v.joining = false;
    cleanup(true);
    v.reconnecting = true;
    v.error = "";
    changed();
    rejoinOff?.();
    rejoinOff = core.on("conn", () => {
      rejoinOff?.();
      rejoinOff = null;
      if (v.reconnecting) { v.reconnecting = false; v.join(again.target, again.label, again.server, { ring: false, keepMedia: true }); }
    });
  });
  core.on("signedout", () => { rejoinOff?.(); rejoinOff = null; v.reconnecting = false; cleanup(); stopRing(); changed(); });

  // ---- ringing ----
  const sameCall = (c, target) => (c.party != null ? target?.party === c.party : target?.with === c.from);
  let ringTimer = null;
  function stopRing() {
    clearInterval(ringTimer);
    ringTimer = null;
    if (v.incoming) { v.incoming = null; changed(); }
  }
  core.on("ev:call", (ev) => {
    if (!ev.room || v.room === ev.room || ev.from === core.data?.me?.name) return;
    v.incoming = { room: ev.room, from: ev.from, party: ev.party ?? null, at: Date.now() };
    v.warmUp();
    clearInterval(ringTimer);
    const tick = () => {
      if (!v.incoming || Date.now() - v.incoming.at > RING_MS) { stopRing(); return; }
      if (core.myStatus() !== "dnd") core.beep("call");
    };
    tick();
    ringTimer = setInterval(tick, 2600);
    changed();
  });
  // The call they rang us for is over.
  core.on("ev:voice", (ev) => { if (v.incoming?.room === ev.room && !ev.count) stopRing(); });
  v.callName = (c) => (c.party != null ? core.data?.parties?.find((p) => p.id === c.party)?.name || "Group call" : c.from);
  v.accept = (video) => {
    const c = v.incoming;
    if (!c) return;
    stopRing();
    v.join(c.party != null ? { party: c.party } : { with: c.from }, v.callName(c), null, { ring: false, video: !!video });
  };
  v.decline = () => {
    const c = v.incoming;
    if (!c) return;
    stopRing();
    if (c.party == null) core.api("voice_decline", { with: c.from }).catch(() => {});
  };
  const alone = () => !!v.room && v.members.length <= 1;
  /** I rang someone in a DM and nobody's picked up yet. */
  v.calling = () => !!(v.rang && alone() && v.target?.with);
  core.on("ev:calldecline", (ev) => {
    if (!(v.room && v.target?.with === ev.from && alone())) return;
    v.leave(true);
    core.beep("leave");
    core.notify(`${ev.from} declined the call.`, { sound: false });
  });
  // Ringback while calling; a DM call nobody answers ends after a minute.
  setInterval(() => {
    if (!v.calling()) return;
    if (Date.now() - v.since > NO_ANSWER_MS) {
      const who = v.target.with;
      v.leave(true);
      core.notify(`${who} didn't answer.`, { sound: false });
      return;
    }
    if (core.myStatus() !== "dnd") core.beep("ringback");
  }, 3000);

  v.peerState = (conn) => v.peers.get(conn)?.state || (conn === core.conn ? "connected" : "connecting");
  v.anyFailed = () => [...v.peers.values()].some((p) => p.state === "failed");
  /** Worst connection in the call: 3 good, 2 fair, 1 poor, 0 not connected yet. */
  v.quality = () => {
    let q = 3;
    for (const p of v.peers.values()) {
      if (p.state !== "connected") return 0;
      q = Math.min(q, p.rtt == null ? 3 : p.rtt < 150 ? 3 : p.rtt < 300 ? 2 : 1);
    }
    return q;
  };
})();
