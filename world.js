/**
 * Hangout world: rooms, walls, props, pickups, collision, LOS.
 * Coordinates are in world pixels; canvas maps world → screen.
 */

export const PAD = 24;

/** Fixed logical world size (letterboxed onto canvas) */
export const WORLD_W = 960;
export const WORLD_H = 600;

export function createWorld() {
  const rooms = [
    { id: "lobby", name: "Lobby", x: 40, y: 40, w: 400, h: 280, light: 0.35, color: "#0a1018" },
    { id: "lab", name: "Lab", x: 480, y: 40, w: 440, h: 280, light: 0.5, color: "#0c0a14" },
    { id: "den", name: "Den", x: 40, y: 360, w: 540, h: 200, light: 0.28, color: "#100c0a" },
    { id: "yard", name: "Yard", x: 620, y: 360, w: 300, h: 200, light: 0.45, color: "#0a120c" },
  ];

  // solid walls (axis-aligned)
  const walls = [
    // outer shell
    { x: 0, y: 0, w: WORLD_W, h: 16 },
    { x: 0, y: WORLD_H - 16, w: WORLD_W, h: 16 },
    { x: 0, y: 0, w: 16, h: WORLD_H },
    { x: WORLD_W - 16, y: 0, w: 16, h: WORLD_H },
    // room dividers with door gaps
    { x: 440, y: 40, w: 16, h: 100 }, // lobby|lab top
    { x: 440, y: 220, w: 16, h: 100 }, // lobby|lab bottom (door 140-220)
    { x: 40, y: 320, w: 200, h: 16 }, // lobby|den left
    { x: 320, y: 320, w: 260, h: 16 }, // lobby|den right (door 240-320)
    { x: 580, y: 320, w: 16, h: 40 }, // den|yard top
    { x: 580, y: 440, w: 16, h: 120 }, // den|yard bottom (door 360-440)
    { x: 620, y: 320, w: 120, h: 16 }, // lab|yard left
    { x: 800, y: 320, w: 120, h: 16 }, // lab|yard right (door 740-800)
  ];

  const props = [
    { id: "coffee", type: "machine", label: "☕ coffee", x: 120, y: 120, r: 18, solid: true, room: "lobby" },
    { id: "whiteboard", type: "board", label: "📋 board", x: 300, y: 90, r: 22, solid: true, room: "lobby" },
    { id: "terminal", type: "console", label: "💻 term", x: 700, y: 120, r: 18, solid: true, room: "lab" },
    { id: "server", type: "rack", label: "🖧 rack", x: 820, y: 220, r: 20, solid: true, room: "lab" },
    { id: "couch", type: "seat", label: "🛋 couch", x: 180, y: 460, r: 24, solid: true, room: "den" },
    { id: "lamp", type: "light", label: "💡 lamp", x: 400, y: 420, r: 14, solid: false, room: "den" },
    { id: "tree", type: "plant", label: "🌳 tree", x: 780, y: 480, r: 22, solid: true, room: "yard" },
    { id: "bench", type: "seat", label: "🪑 bench", x: 700, y: 400, r: 18, solid: true, room: "yard" },
  ];

  const pickups = [
    { id: "orb-a", label: "◆ orb", x: 200, y: 200, heldBy: null, color: "#6ec6ff" },
    { id: "orb-b", label: "◆ orb", x: 750, y: 180, heldBy: null, color: "#ff7a6e" },
    { id: "orb-c", label: "◆ orb", x: 500, y: 480, heldBy: null, color: "#7dffb3" },
  ];

  // ambient third "agent" node (state machine, not full VLA)
  const node = {
    id: "node",
    name: "Node",
    x: 700,
    y: 450,
    phase: 0,
    mood: "idle",
    lastSaid: "",
    color: "#ffaa00",
  };

  return { rooms, walls, props, pickups, node, time: 0 };
}

export function roomAt(world, x, y) {
  return world.rooms.find(
    (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
  ) || null;
}

export function circleRectHit(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/** Try move circle; returns {x,y,hit} */
export function moveWithCollision(world, x, y, nx, ny, radius = 14, ignorePickupId = null) {
  let hit = null;

  // walls
  for (const w of world.walls) {
    if (circleRectHit(nx, ny, radius, w)) {
      // slide axes
      if (!circleRectHit(nx, y, radius, w)) {
        ny = y;
        hit = "wall";
      } else if (!circleRectHit(x, ny, radius, w)) {
        nx = x;
        hit = "wall";
      } else {
        return { x, y, hit: "wall" };
      }
    }
  }

  // solid props
  for (const p of world.props) {
    if (!p.solid) continue;
    const d = Math.hypot(nx - p.x, ny - p.y);
    if (d < radius + p.r * 0.7) {
      hit = `prop:${p.id}`;
      const push = (radius + p.r * 0.7 - d) / (d || 1);
      nx += (nx - p.x) * push;
      ny += (ny - p.y) * push;
    }
  }

  // world bounds
  nx = Math.max(PAD, Math.min(WORLD_W - PAD, nx));
  ny = Math.max(PAD, Math.min(WORLD_H - PAD, ny));

  return { x: nx, y: ny, hit };
}

/** Segment vs AABB */
function segRect(x0, y0, x1, y1, r) {
  // Liang-Barsky-ish coarse: sample
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

/** Line of sight blocked by walls? */
export function hasLOS(world, x0, y0, x1, y1) {
  for (const w of world.walls) {
    if (segRect(x0, y0, x1, y1, w)) return false;
  }
  return true;
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function nearestProp(world, x, y, maxD = 40) {
  let best = null;
  let bestD = maxD;
  for (const p of world.props) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export function nearestFreePickup(world, x, y, maxD = 36) {
  let best = null;
  let bestD = maxD;
  for (const p of world.pickups) {
    if (p.heldBy) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Map screen canvas CSS size → world + letterbox transform */
export function viewTransform(canvas) {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const scale = Math.min(cw / WORLD_W, ch / WORLD_H);
  const ox = (cw - WORLD_W * scale) / 2;
  const oy = (ch - WORLD_H * scale) / 2;
  return { scale, ox, oy, cw, ch };
}

export function screenToWorld(canvas, sx, sy) {
  const { scale, ox, oy } = viewTransform(canvas);
  return {
    x: (sx - ox) / scale,
    y: (sy - oy) / scale,
  };
}

export function drawWorld(ctx, canvas, world, entities, opts = {}) {
  const { scale, ox, oy, cw, ch } = viewTransform(canvas);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  // rooms
  for (const r of world.rooms) {
    ctx.fillStyle = r.color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    // light vignette
    const g = ctx.createRadialGradient(
      r.x + r.w / 2,
      r.y + r.h / 2,
      10,
      r.x + r.w / 2,
      r.y + r.h / 2,
      Math.max(r.w, r.h) * 0.6
    );
    g.addColorStop(0, `rgba(255,255,255,${r.light * 0.08})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(r.x, r.y, r.w, r.h);

    ctx.fillStyle = "#1a1a1a";
    ctx.font = "12px monospace";
    ctx.fillText(r.name, r.x + 10, r.y + 18);
  }

  // walls
  ctx.fillStyle = "#222";
  for (const w of world.walls) {
    ctx.fillRect(w.x, w.y, w.w, w.h);
  }
  // wall edge highlight
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  for (const w of world.walls) {
    ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
  }

  // props
  for (const p of world.props) {
    ctx.beginPath();
    ctx.fillStyle = p.solid ? "#2a2a32" : "#1a2a1a";
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#444";
    ctx.stroke();
    ctx.fillStyle = "#666";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(p.label, p.x, p.y - p.r - 4);
    ctx.textAlign = "left";
  }

  // pickups
  for (const p of world.pickups) {
    if (p.heldBy) continue;
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.moveTo(p.x, p.y - 8);
    ctx.lineTo(p.x + 7, p.y);
    ctx.lineTo(p.x, p.y + 8);
    ctx.lineTo(p.x - 7, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#888";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText(p.label, p.x, p.y + 18);
    ctx.textAlign = "left";
  }

  // entities (sprites + human + node)
  for (const e of entities) {
    drawEntity(ctx, e, opts.highlightId === e.id);
  }

  ctx.restore();
}

function drawEntity(ctx, e, highlight) {
  const x = e.x;
  const y = e.y;
  const facing = e.facing ?? 1;
  const color = e.color || "#aaa";

  // body
  ctx.save();
  ctx.translate(x, y);

  if (e.kind === "human") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("you", 0, -18);
    ctx.restore();
    return;
  }

  if (e.kind === "node") {
    ctx.fillStyle = color;
    ctx.fillRect(-10, -10, 20, 20);
    ctx.strokeStyle = "#ffcc66";
    ctx.strokeRect(-10, -10, 20, 20);
    ctx.fillStyle = "#caa";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Node", 0, -16);
    ctx.restore();
    return;
  }

  // sprite body
  const body = e.moodColor || color;
  ctx.fillStyle = body;
  ctx.shadowColor = body;
  ctx.shadowBlur = highlight ? 16 : 10;
  ctx.fillRect(-10, -6, 20, 18);
  ctx.shadowBlur = 0;
  // head
  ctx.fillStyle = e.headColor || "#ddd";
  ctx.fillRect(-7, -18, 14, 12);
  // eyes
  ctx.fillStyle = "#111";
  ctx.fillRect(-4, -14, 3, 3);
  ctx.fillRect(2, -14, 3, 3);
  // facing arrow
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  const ang = e.angle ?? (facing >= 0 ? 0 : Math.PI);
  ctx.lineTo(Math.cos(ang) * 16, Math.sin(ang) * 16);
  ctx.stroke();

  // held item
  if (e.holding) {
    ctx.fillStyle = e.holding.color || "#fff";
    ctx.beginPath();
    ctx.arc(12, -8, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // name
  ctx.fillStyle = e.nameColor || "#aaa";
  ctx.font = "11px monospace";
  ctx.textAlign = "center";
  ctx.fillText(e.name, 0, -24);
  if (e.emote && e.emote !== "none") {
    ctx.fillText(e.emote === "wave" ? "👋" : e.emote === "happy" ? "♪" : "…", 14, -20);
  }

  // FOV cone ghost (debug-ish faint)
  if (e.showFov) {
    ctx.fillStyle = "rgba(255,255,100,0.04)";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const fov = (e.fovRad || Math.PI / 2) / 2;
    ctx.arc(0, 0, 80, ang - fov, ang + fov);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}
