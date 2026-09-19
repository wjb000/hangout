/**
 * Same-WiFi hangout multiplayer via WebRTC (PeerJS).
 * PeerJS cloud is signaling only; game data is peer-to-peer.
 */
const PEER_OPTS = {
  debug: 1,
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
  let PeerCtor = null;
  let peer = null;
  let role = null;
  let room = null;
  let selfId = null;
  let profile = {
    name: localStorage.getItem("hangout_name") || "Player",
    color: localStorage.getItem("hangout_color") || COLORS[0],
    headColor: localStorage.getItem("hangout_head") || HEAD[0],
  };
  const conns = new Map();
  let lastSend = 0;
  let destroyed = false;

  function status(msg, kind) {
    api.onStatus?.(msg, kind);
  }

  function roster() {
    return [...conns.keys()].map((id) => ({ id, ...(conns.get(id)._meta || {}) }));
  }

  function setMeta(conn, meta) {
    conn._meta = { ...(conn._meta || {}), ...meta };
    api.onRoster?.(roster());
  }

  function broadcast(msg, exceptId) {
    for (const [id, c] of conns) {
      if (exceptId && id === exceptId) continue;
      if (c.open) c.send(msg);
    }
  }

  function wire(conn, asHost) {
    conn.on("data", (raw) => {
      let msg = raw;
      try {
        if (typeof raw === "string") msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const from = conn.peer;

      if (msg.t === "hello") {
        setMeta(conn, {
          name: msg.name || "Player",
          color: msg.color || COLORS[1],
          headColor: msg.headColor || HEAD[1],
        });
        if (asHost) {
          conn.send({
            t: "roster",
            host: selfId,
            you: from,
            peers: [
              {
                id: selfId,
                name: profile.name,
                color: profile.color,
                headColor: profile.headColor,
                isHost: true,
              },
              ...roster()
                .filter((p) => p.id !== from)
                .map((p) => ({
                  id: p.id,
                  name: p.name,
                  color: p.color,
                  headColor: p.headColor,
                })),
            ],
          });
          broadcast(
            {
              t: "join",
              id: from,
              name: msg.name,
              color: msg.color,
              headColor: msg.headColor,
            },
            from
          );
        }
        return;
      }

      if (msg.t === "roster" && !asHost) {
        for (const p of msg.peers || []) {
          if (p.id === selfId) continue;
          api.onState(p.id, {
            name: p.name,
            color: p.color,
            headColor: p.headColor,
            x: p.x,
            y: p.y,
            angle: p.angle || 0,
            moving: false,
            walkPhase: 0,
          });
        }
        api.onRoster?.(msg.peers || []);
        return;
      }

      if (msg.t === "join") {
        api.onState(msg.id, {
          name: msg.name,
          color: msg.color,
          headColor: msg.headColor,
          x: msg.x,
          y: msg.y,
          angle: 0,
          moving: false,
          walkPhase: 0,
        });
        return;
      }

      if (msg.t === "state") {
        const id = msg.id || from;
        api.onState(id, {
          name: msg.name,
          color: msg.color,
          headColor: msg.headColor,
          x: msg.x,
          y: msg.y,
          angle: msg.angle,
          moving: !!msg.moving,
          walkPhase: msg.walkPhase || 0,
        });
        if (asHost) broadcast({ ...msg, id }, from);
        return;
      }

      if (msg.t === "leave") {
        api.onLeave(msg.id || from);
        if (asHost) broadcast({ t: "leave", id: msg.id || from }, from);
      }
    });

    conn.on("close", () => {
      conns.delete(conn.peer);
      api.onLeave(conn.peer);
      if (asHost) broadcast({ t: "leave", id: conn.peer });
      api.onRoster?.(roster());
    });

    conn.on("error", (err) => console.warn("conn error", err));
    conns.set(conn.peer, conn);
    const hello = () =>
      conn.send({
        t: "hello",
        name: profile.name,
        color: profile.color,
        headColor: profile.headColor,
      });
    if (conn.open) hello();
    else conn.on("open", hello);
  }

  async function ensurePeer(preferredId) {
    PeerCtor = await loadPeer();
    return new Promise((resolve, reject) => {
      const p = preferredId ? new PeerCtor(preferredId, PEER_OPTS) : new PeerCtor(PEER_OPTS);
      let opened = false;
      p.on("error", (err) => {
        const typ = err?.type || String(err);
        if (!opened && (typ === "unavailable-id" || String(typ).includes("unavailable"))) {
          try { p.destroy(); } catch {}
          reject(new Error("Room code taken — pick another"));
        } else if (!opened) {
          try { p.destroy(); } catch {}
          reject(err instanceof Error ? err : new Error(String(err)));
        } else console.warn(err);
      });
      p.on("open", (id) => {
        opened = true;
        peer = p;
        selfId = id;
        resolve(id);
      });
    });
  }

  async function host(desiredCode) {
    destroySoft();
    destroyed = false;
    const code =
      String(desiredCode || code4())
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6) || code4();
    room = code;
    role = "host";
    status("Starting room…");
    await ensurePeer(`hang-${code}`);
    peer.on("connection", (conn) => {
      conn.on("open", () => {
        wire(conn, true);
        status("Someone joined", "good");
      });
    });
    status(`Room ${code} — friends on this Wi‑Fi can Join`, "good");
    return { role, room: code, id: selfId };
  }

  async function join(code) {
    destroySoft();
    destroyed = false;
    const c = String(code || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (c.length < 3) throw new Error("Enter a room code");
    room = c;
    role = "guest";
    status(`Joining ${c}…`);
    await ensurePeer();
    const conn = peer.connect(`hang-${c}`, { reliable: true });
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("Timed out — host must have the room open on the same Wi‑Fi")),
        14000
      );
      conn.on("open", () => {
        clearTimeout(t);
        wire(conn, false);
        resolve();
      });
      conn.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    status(`Joined room ${c}`, "good");
    return { role, room: c, id: selfId };
  }

  function setProfile({ name, color, headColor } = {}) {
    if (name != null) {
      profile.name = String(name).slice(0, 16) || "Player";
      localStorage.setItem("hangout_name", profile.name);
    }
    if (color) {
      profile.color = color;
      localStorage.setItem("hangout_color", color);
    }
    if (headColor) {
      profile.headColor = headColor;
      localStorage.setItem("hangout_head", headColor);
    }
  }

  function pickColor(i) {
    const color = COLORS[i % COLORS.length];
    const headColor = HEAD[i % HEAD.length];
    setProfile({ color, headColor });
    return { color, headColor };
  }

  function sendState(state) {
    if (!peer || destroyed) return;
    const now = performance.now();
    if (now - lastSend < 50) return;
    lastSend = now;
    const msg = {
      t: "state",
      id: selfId,
      name: profile.name,
      color: profile.color,
      headColor: profile.headColor,
      x: state.x,
      y: state.y,
      angle: state.angle,
      moving: !!state.moving,
      walkPhase: state.walkPhase || 0,
    };
    if (role === "host") broadcast(msg);
    else for (const c of conns.values()) if (c.open) c.send(msg);
  }

  function destroySoft() {
    for (const c of conns.values()) {
      try { c.close(); } catch {}
    }
    conns.clear();
    if (peer) {
      try { peer.destroy(); } catch {}
    }
    peer = null;
    role = null;
    room = null;
    selfId = null;
  }

  function destroy() {
    destroyed = true;
    destroySoft();
  }

  return {
    host,
    join,
    setProfile,
    pickColor,
    sendState,
    destroy,
    get profile() { return { ...profile }; },
    get room() { return room; },
    get role() { return role; },
    get selfId() { return selfId; },
  };
}
