const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],
  },
};

export const COLORS = ["#55ff88", "#66aaff", "#ff88cc", "#ffcc55", "#aa88ff", "#88ffee"];
export const HEAD = ["#c8ffe0", "#d0e8ff", "#ffe0f0", "#fff0c8", "#e8d0ff", "#d0fff8"];

function code4() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += c[(Math.random() * c.length) | 0];
  return s;
}

function loadPeer() {
  if (typeof window !== "undefined" && window.Peer) return Promise.resolve(window.Peer);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error("PeerJS failed")));
    s.onerror = () => reject(new Error("Could not load PeerJS"));
    document.head.appendChild(s);
  });
}

export function createSession(api) {
  let peer = null, role = null, room = null, selfId = null, destroyed = false, lastSend = 0;
  let profile = {
    name: localStorage.getItem("hangout_name") || "you",
    color: localStorage.getItem("hangout_color") || COLORS[0],
    headColor: localStorage.getItem("hangout_head") || HEAD[0],
  };
  const conns = new Map();
  const status = (msg, kind) => api.onStatus?.(msg, kind);
  const roster = () => [...conns.keys()].map((id) => ({ id, ...(conns.get(id)._meta || {}) }));
  function broadcast(msg, exceptId) {
    for (const [id, c] of conns) if (c.open && id !== exceptId) c.send(msg);
  }
  function wire(conn, asHost) {
    conn.on("data", (raw) => {
      let msg = raw;
      try { if (typeof raw === "string") msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      const from = conn.peer;
      if (msg.t === "hello") {
        conn._meta = { name: msg.name, color: msg.color, headColor: msg.headColor, avatar: msg.avatar };
        api.onRoster?.(roster());
        if (asHost) {
          conn.send({ t: "roster", peers: [{ id: selfId, ...profile, isHost: true }, ...roster().filter((p) => p.id !== from)] });
          broadcast({ t: "join", id: from, ...msg }, from);
        }
        return;
      }
      if (msg.t === "state") {
        api.onState(msg.id || from, msg);
        if (asHost) broadcast({ ...msg, id: msg.id || from }, from);
        return;
      }
      if (msg.t === "chat") {
        api.onChat?.(from, msg.text, msg.name);
        if (asHost) broadcast(msg, from);
        return;
      }
      if (msg.t === "join") api.onState(msg.id, msg);
      if (msg.t === "roster") for (const p of msg.peers || []) if (p.id !== selfId) api.onState(p.id, p);
      if (msg.t === "leave") api.onLeave(msg.id || from);
    });
    conn.on("close", () => {
      conns.delete(conn.peer);
      api.onLeave(conn.peer);
      if (asHost) broadcast({ t: "leave", id: conn.peer });
    });
    conns.set(conn.peer, conn);
    const hello = () => conn.send({ t: "hello", ...profile });
    if (conn.open) hello(); else conn.on("open", hello);
  }
  async function ensurePeer(preferredId) {
    const PeerCtor = await loadPeer();
    return new Promise((resolve, reject) => {
      const p = preferredId ? new PeerCtor(preferredId, PEER_OPTS) : new PeerCtor(PEER_OPTS);
      let opened = false;
      p.on("error", (err) => {
        const typ = err?.type || String(err);
        if (!opened && String(typ).includes("unavailable")) { try { p.destroy(); } catch {} reject(new Error("taken")); }
        else if (!opened) { try { p.destroy(); } catch {} reject(err); }
      });
      p.on("open", (id) => { opened = true; peer = p; selfId = id; resolve(id); });
    });
  }
  async function host(desiredCode) {
    destroySoft(); destroyed = false;
    const code = String(desiredCode || code4()).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || code4();
    room = code; role = "host";
    await ensurePeer("hang-" + code);
    peer.on("connection", (conn) => conn.on("open", () => { wire(conn, true); status("Someone joined", "good"); }));
    status("open", "good");
    return { role, room: code, id: selfId };
  }
  async function join(code) {
    destroySoft(); destroyed = false;
    const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    room = c; role = "guest";
    await ensurePeer();
    const conn = peer.connect("hang-" + c, { reliable: true });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no host")), 5000);
      conn.on("open", () => { clearTimeout(t); wire(conn, false); resolve(); });
      conn.on("error", (e) => { clearTimeout(t); reject(e); });
    });
    status("together", "good");
    return { role, room: c, id: selfId };
  }
  async function autoEnter(code = "LAN") {
    try { return await host(code); }
    catch { try { return await join(code); } catch { return { role: "solo", room: code }; } }
  }
  function setProfile(p = {}) {
    if (p.name != null) { profile.name = String(p.name).slice(0, 16) || "you"; localStorage.setItem("hangout_name", profile.name); }
    if (p.color) { profile.color = p.color; localStorage.setItem("hangout_color", p.color); }
    if (p.headColor) { profile.headColor = p.headColor; localStorage.setItem("hangout_head", p.headColor); }
    if (p.avatar) profile.avatar = p.avatar;
  }
  function pickColor(i) {
    const color = COLORS[i % COLORS.length], headColor = HEAD[i % HEAD.length];
    setProfile({ color, headColor }); return { color, headColor };
  }
  function sendState(state) {
    if (!peer || destroyed) return;
    const now = performance.now(); if (now - lastSend < 50) return; lastSend = now;
    const msg = { t: "state", id: selfId, ...profile, x: state.x, y: state.y, angle: state.angle, moving: !!state.moving, avatar: state.avatar || "aya" };
    if (role === "host") broadcast(msg); else for (const c of conns.values()) if (c.open) c.send(msg);
  }
  function sendChat(text) {
    if (!peer || destroyed) return;
    const msg = { t: "chat", name: profile.name, text: String(text).slice(0, 160) };
    if (role === "host") broadcast(msg); else for (const c of conns.values()) if (c.open) c.send(msg);
  }
  function destroySoft() {
    for (const c of conns.values()) try { c.close(); } catch {}
    conns.clear(); if (peer) try { peer.destroy(); } catch {}
    peer = null; role = null; room = null; selfId = null;
  }
  function destroy() { destroyed = true; destroySoft(); }
  return { host, join, autoEnter, setProfile, pickColor, sendState, sendChat, destroy,
    get profile() { return { ...profile }; }, get room() { return room; }, get role() { return role; }, get selfId() { return selfId; } };
}
