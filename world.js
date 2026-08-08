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
    { id: "lobby", name: "Lobby", x: 40, y: 40, w: 400, h: 280, light: 0.42, color: "#0c1420", accent: "#3d7aad", visionColor: "#1a3048" },
    { id: "lab", name: "Lab", x: 480, y: 40, w: 440, h: 280, light: 0.5, color: "#120c1c", accent: "#8b5cf6", visionColor: "#281840" },
    { id: "den", name: "Den", x: 40, y: 360, w: 540, h: 200, light: 0.38, color: "#16100c", accent: "#c4783a", visionColor: "#302010" },
    { id: "yard", name: "Yard", x: 620, y: 360, w: 300, h: 200, light: 0.48, color: "#0a1610", accent: "#34a86a", visionColor: "#143020" },
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
    { id: "coffee", type: "machine", label: "☕ coffee", x: 120, y: 120, r: 18, solid: true, room: "lobby", visionFill: "#c80" },
    { id: "whiteboard", type: "board", label: "📋 board", x: 300, y: 90, r: 22, solid: true, room: "lobby", visionFill: "#aac" },
    { id: "terminal", type: "console", label: "💻 term", x: 700, y: 120, r: 18, solid: true, room: "lab", visionFill: "#0a8" },
    { id: "server", type: "rack", label: "🖧 rack", x: 820, y: 220, r: 20, solid: true, room: "lab", visionFill: "#66a" },
    { id: "couch", type: "seat", label: "🛋 couch", x: 180, y: 460, r: 24, solid: true, room: "den", visionFill: "#a64" },
    { id: "lamp", type: "light", label: "💡 lamp", x: 400, y: 420, r: 14, solid: false, room: "den", visionFill: "#ff5" },
    { id: "tree", type: "plant", label: "🌳 tree", x: 780, y: 480, r: 22, solid: true, room: "yard", visionFill: "#2a6" },
    { id: "bench", type: "seat", label: "🪑 bench", x: 700, y: 400, r: 18, solid: true, room: "yard", visionFill: "#864" },
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

  return {
    rooms,
    walls,
    props,
    pickups,
    node,
    time: 0,
    beacon: null, // {x,y,t}
    particles: [], // {x,y,vx,vy,life,color,size}
    fxFlash: [], // {x,y,r,color,life}
  };
}

export function spawnParticle(world, x, y, color = "#fff", n = 6) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 80;
    world.particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.35 + Math.random() * 0.35,
      color,
      size: 2 + Math.random() * 3,
    });
  }
}

export function spawnFlash(world, x, y, color = "#f44", r = 28) {
  world.fxFlash.push({ x, y, r, color, life: 0.35 });
}

export function tickFX(world, dt) {
  world.particles = world.particles.filter((p) => {
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.96;
    p.vy *= 0.96;
    return p.life > 0;
  });
  world.fxFlash = world.fxFlash.filter((f) => {
    f.life -= dt;
    return f.life > 0;
  });
  if (world.beacon) {
    world.beacon.t -= dt;
    if (world.beacon.t <= 0) world.beacon = null;
  }
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

/**
 * Map canvas → world. Optional camera: { x, y, zoom } focuses on a point.
 */
export function viewTransform(canvas, camera = null) {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  let scale = Math.min(cw / WORLD_W, ch / WORLD_H);
  let ox = (cw - WORLD_W * scale) / 2;
  let oy = (ch - WORLD_H * scale) / 2;

  if (camera && camera.zoom > 1) {
    scale *= camera.zoom;
    ox = cw / 2 - camera.x * scale;
    oy = ch / 2 - camera.y * scale;
  }

  return { scale, ox, oy, cw, ch };
}

export function screenToWorld(canvas, sx, sy, camera = null) {
  const { scale, ox, oy } = viewTransform(canvas, camera);
  return {
    x: (sx - ox) / scale,
    y: (sy - oy) / scale,
  };
}

export function drawWorld(ctx, canvas, world, entities, opts = {}) {
  const camera = opts.camera || null;
  const { scale, ox, oy, cw, ch } = viewTransform(canvas, camera);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const bg = ctx.createRadialGradient(cw * 0.5, ch * 0.45, 40, cw * 0.5, ch * 0.5, Math.max(cw, ch) * 0.75);
  bg.addColorStop(0, "#0c1220");
  bg.addColorStop(0.5, "#060a12");
  bg.addColorStop(1, "#020308");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  for (let i = 0; i < 48; i++) {
    ctx.fillRect((i * 97) % cw, (i * 53) % ch, i % 5 === 0 ? 1.5 : 1, i % 5 === 0 ? 1.5 : 1);
  }

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  const t = world.time || 0;

  for (const r of world.rooms) drawRoom(ctx, r, t);
  for (const w of world.walls) drawWall(ctx, w);
  drawDoorFrames(ctx);
  for (const p of world.props) drawProp(ctx, p, t);

  if (opts.targetLines) {
    for (const line of opts.targetLines) {
      const grd = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1);
      grd.addColorStop(0, line.color || "rgba(255,255,100,0.5)");
      grd.addColorStop(1, "rgba(255,255,255,0.05)");
      ctx.strokeStyle = grd;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 7]);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(line.x0, line.y0);
      ctx.lineTo(line.x1, line.y1);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (opts.path && opts.path.length > 1) {
    ctx.strokeStyle = "rgba(100,255,140,0.55)";
    ctx.lineWidth = 3;
    ctx.shadowColor = "rgba(80,255,120,0.4)";
    ctx.shadowBlur = 8;
    ctx.setLineDash([6, 6]);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(opts.path[0].x, opts.path[0].y);
    for (let i = 1; i < opts.path.length; i++) ctx.lineTo(opts.path[i].x, opts.path[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    const end = opts.path[opts.path.length - 1];
    ctx.fillStyle = "rgba(100,255,140,0.85)";
    ctx.beginPath();
    ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const p of world.pickups) {
    if (!p.heldBy || p.heldBy === "air") {
      drawOrb(ctx, p, t, opts.targetOrbIds && opts.targetOrbIds.has(p.id));
    }
  }

  if (world.beacon) {
    const pulse = 14 + Math.sin(t * 7) * 7;
    const a = 0.35 + 0.35 * Math.sin(t * 5);
    ctx.strokeStyle = `rgba(80,255,140,${a})`;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = "#5f5";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(world.beacon.x, world.beacon.y, pulse + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(world.beacon.x, world.beacon.y, pulse * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#9f9";
    ctx.beginPath();
    ctx.arc(world.beacon.x, world.beacon.y, 4, 0, Math.PI * 2);
    ctx.fill();
    drawNameplate(ctx, world.beacon.x, world.beacon.y - 28, "BEACON", "#7f7");
  }

  for (const f of world.fxFlash) {
    const a = Math.max(0, f.life / 0.35);
    ctx.globalAlpha = a * 0.5;
    const g = ctx.createRadialGradient(f.x, f.y, 2, f.x, f.y, f.r * (1.3 - a));
    g.addColorStop(0, f.color);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * (1.3 - a), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  for (const p of world.particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2.2));
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  const sorted = [...entities].sort((a, b) => a.y - b.y);
  for (const e of sorted) drawEntity(ctx, e, opts.highlightId === e.id, t);

  ctx.restore();
}

function drawRoom(ctx, r, t) {
  const floor = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
  floor.addColorStop(0, r.color);
  floor.addColorStop(1, shade(r.color, -14));
  ctx.fillStyle = floor;
  roundRect(ctx, r.x, r.y, r.w, r.h, 8);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, r.x, r.y, r.w, r.h, 8);
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  const tile = 28;
  for (let x = r.x; x < r.x + r.w; x += tile) {
    ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
  }
  for (let y = r.y; y < r.y + r.h; y += tile) {
    ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
  }
  const g = ctx.createRadialGradient(
    r.x + r.w * 0.45, r.y + r.h * 0.4, 16,
    r.x + r.w * 0.5, r.y + r.h * 0.5, Math.max(r.w, r.h) * 0.55
  );
  g.addColorStop(0, hexToRgba(r.accent || "#fff", r.light * 0.16));
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();

  ctx.strokeStyle = hexToRgba(r.accent || "#444", 0.28);
  ctx.lineWidth = 1.5;
  roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 8);
  ctx.stroke();

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  roundRect(ctx, r.x + 10, r.y + 10, 70, 20, 5);
  ctx.fill();
  ctx.fillStyle = r.accent || "#888";
  ctx.font = "bold 11px ui-monospace, Menlo, monospace";
  ctx.textAlign = "left";
  ctx.fillText(r.name.toUpperCase(), r.x + 16, r.y + 24);
}

function drawWall(ctx, w) {
  const g = ctx.createLinearGradient(w.x, w.y, w.x + (w.w > w.h ? 0 : w.w), w.y + (w.w > w.h ? w.h : 0));
  g.addColorStop(0, "#343c50");
  g.addColorStop(0.45, "#1e2433");
  g.addColorStop(1, "#12161f");
  ctx.fillStyle = g;
  ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.fillStyle = "rgba(140,160,200,0.22)";
  if (w.w >= w.h) ctx.fillRect(w.x, w.y, w.w, 2);
  else ctx.fillRect(w.x, w.y, 2, w.h);
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
}

function drawDoorFrames(ctx) {
  const doors = [
    { x: 440, y: 148, w: 16, h: 64 },
    { x: 248, y: 320, w: 64, h: 16 },
    { x: 580, y: 368, w: 16, h: 64 },
    { x: 748, y: 320, w: 44, h: 16 },
  ];
  for (const d of doors) {
    const g = ctx.createLinearGradient(d.x, d.y, d.x + d.w, d.y + d.h);
    g.addColorStop(0, "rgba(100,170,255,0.12)");
    g.addColorStop(1, "rgba(100,170,255,0.02)");
    ctx.fillStyle = g;
    ctx.fillRect(d.x, d.y, d.w, d.h);
    ctx.strokeStyle = "rgba(120,180,255,0.25)";
    ctx.strokeRect(d.x + 0.5, d.y + 0.5, d.w - 1, d.h - 1);
  }
}

function drawProp(ctx, p, t) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(0, p.r * 0.55, p.r * 0.95, p.r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  if (p.id === "coffee") {
    roundRect(ctx, -14, -18, 28, 28, 5);
    ctx.fillStyle = "#2a323c";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.stroke();
    roundRect(ctx, -10, -8, 20, 10, 3);
    ctx.fillStyle = "#c4783a";
    ctx.fill();
    ctx.fillStyle = "#6ec6ff";
    ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t * 3);
    ctx.beginPath();
    ctx.arc(0, -12, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (p.type === "board") {
    roundRect(ctx, -22, -16, 44, 30, 4);
    ctx.fillStyle = "#eef3f8";
    ctx.fill();
    ctx.strokeStyle = "#8a9aaa";
    ctx.stroke();
    ctx.strokeStyle = "#5a7a9a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-14, -6);
    ctx.lineTo(10, -8);
    ctx.lineTo(12, 6);
    ctx.stroke();
  } else if (p.id === "terminal") {
    roundRect(ctx, -16, -14, 32, 26, 4);
    ctx.fillStyle = "#1a222c";
    ctx.fill();
    ctx.fillStyle = "#0d3";
    ctx.globalAlpha = 0.65 + 0.25 * Math.sin(t * 4);
    roundRect(ctx, -12, -10, 24, 14, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (p.id === "server") {
    roundRect(ctx, -14, -22, 28, 38, 4);
    ctx.fillStyle = "#252a38";
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? "#3a8" : "#c44";
      ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t * 5 + i);
      ctx.fillRect(-10, -16 + i * 8, 7, 3);
    }
    ctx.globalAlpha = 1;
  } else if (p.id === "couch") {
    roundRect(ctx, -30, -10, 60, 24, 7);
    ctx.fillStyle = "#5c3c2c";
    ctx.fill();
    roundRect(ctx, -30, -18, 13, 16, 5);
    ctx.fill();
    roundRect(ctx, 17, -18, 13, 16, 5);
    ctx.fill();
    ctx.fillStyle = "#7a5040";
    roundRect(ctx, -24, -8, 48, 14, 5);
    ctx.fill();
  } else if (p.id === "lamp") {
    ctx.strokeStyle = "#778";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 10);
    ctx.lineTo(0, -4);
    ctx.stroke();
    ctx.fillStyle = "#ffe08a";
    ctx.shadowColor = "#ffe08a";
    ctx.shadowBlur = 22;
    ctx.beginPath();
    ctx.arc(0, -12, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  } else if (p.id === "tree") {
    ctx.fillStyle = "#3a2818";
    ctx.fillRect(-3.5, 2, 7, 14);
    ctx.fillStyle = "#247a42";
    ctx.beginPath();
    ctx.arc(0, -4, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#36b85e";
    ctx.beginPath();
    ctx.arc(-7, -10, 9, 0, Math.PI * 2);
    ctx.arc(8, -8, 8, 0, Math.PI * 2);
    ctx.fill();
  } else if (p.id === "bench") {
    ctx.fillStyle = "#5a4030";
    roundRect(ctx, -22, -4, 44, 11, 3);
    ctx.fill();
    ctx.fillRect(-19, 7, 5, 9);
    ctx.fillRect(14, 7, 5, 9);
  } else {
    ctx.fillStyle = p.visionFill || "#444";
    ctx.beginPath();
    ctx.arc(0, 0, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  const label = (p.label || p.id).replace(/^[^\w#]*/u, "").trim() || p.id;
  drawNameplate(ctx, 0, -p.r - 16, label, "#b8c4d4");
  ctx.restore();
}

function drawOrb(ctx, p, t, isTarget) {
  const pulse = 1 + Math.sin(t * 4 + p.x * 0.01) * 0.08;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (isTarget) {
    ctx.strokeStyle = "rgba(255,230,120,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 18 + Math.sin(t * 5) * 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 20 * pulse);
  g.addColorStop(0, p.color);
  g.addColorStop(0.4, hexToRgba(p.color, 0.4));
  g.addColorStop(1, "transparent");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, 20 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = p.color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(10, 0);
  ctx.lineTo(0, 12);
  ctx.lineTo(-10, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(4, 0);
  ctx.lineTo(0, 2);
  ctx.lineTo(-2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  drawNameplate(ctx, 0, 22, "ORB", p.color);
  ctx.restore();
}

function drawEntity(ctx, e, highlight, t = 0) {
  const bob = e.walkPhase != null ? Math.sin(e.walkPhase) * 2.2 : 0;
  const ang = e.angle ?? 0;
  const walking = !!(e.moving || (e.walkPhase != null && Math.abs(Math.sin(e.walkPhase || 0)) > 0.15));

  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.beginPath();
  ctx.ellipse(0, 11, 13, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(0, bob);

  if (e.kind === "human") {
    const ang = e.angle ?? 0;
    const body = e.color || "#55ff88";
    const head = e.headColor || "#c8ffe0";
    const walking = e.moving;
    const legSwing = walking ? Math.sin(e.walkPhase || 0) * 5 : 0;
    // legs
    ctx.fillStyle = shade(body, -40);
    ctx.fillRect(-7, 8, 5, 8 + legSwing * 0.3);
    ctx.fillRect(2, 8, 5, 8 - legSwing * 0.3);
    // body
    ctx.shadowColor = body;
    ctx.shadowBlur = 16;
    const bg = ctx.createLinearGradient(-12, -8, 12, 14);
    bg.addColorStop(0, shade(body, 25));
    bg.addColorStop(1, shade(body, -20));
    ctx.fillStyle = bg;
    roundRect(ctx, -11, -6, 22, 18, 7);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, -6, -1, 12, 8, 3);
    ctx.fill();
    // head
    const hg = ctx.createLinearGradient(-9, -22, 9, -6);
    hg.addColorStop(0, "#fff");
    hg.addColorStop(0.4, head);
    hg.addColorStop(1, shade(head, -15));
    ctx.fillStyle = hg;
    roundRect(ctx, -9, -22, 18, 16, 6);
    ctx.fill();
    // visor
    ctx.fillStyle = "#0a1a12";
    roundRect(ctx, -6, -16, 12, 5, 2);
    ctx.fill();
    ctx.fillStyle = "#6f6";
    ctx.globalAlpha = 0.85;
    ctx.fillRect(-4, -15, 3, 2);
    ctx.fillRect(1, -15, 3, 2);
    ctx.globalAlpha = 1;
    // facing
    ctx.strokeStyle = "rgba(200,255,220,0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * 6, Math.sin(ang) * 6);
    ctx.lineTo(Math.cos(ang) * 17, Math.sin(ang) * 17);
    ctx.stroke();
    if (e.holding) drawMiniOrb(ctx, Math.cos(ang + 0.8) * 14, -6, e.holding.color);
    drawNameplate(ctx, 0, -36, "YOU", "#6f6");
    if (e.thought) drawThought(ctx, 0, -48, e.thought);
    ctx.restore();
    return;
  }

  if (e.kind === "node") {
    ctx.shadowColor = "#ffaa00";
    ctx.shadowBlur = 18;
    roundRect(ctx, -13, -13, 26, 26, 6);
    const ng = ctx.createLinearGradient(-13, -13, 13, 13);
    ng.addColorStop(0, "#ffd866");
    ng.addColorStop(1, "#cc7700");
    ctx.fillStyle = ng;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,200,0.45)";
    ctx.stroke();
    ctx.fillStyle = "#2a1800";
    ctx.font = "bold 11px monospace";
    ctx.textAlign = "center";
    ctx.fillText("N", 0, 4);
    drawNameplate(ctx, 0, -26, "NODE", "#fc6");
    ctx.restore();
    return;
  }

  if (e.showFov) {
    ctx.fillStyle = "rgba(255,255,120,0.055)";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const fov = (e.fovRad || Math.PI / 2) / 2;
    ctx.arc(0, 0, 92, ang - fov, ang + fov);
    ctx.closePath();
    ctx.fill();
  }

  const body = e.moodColor || e.color || "#6ec6ff";
  const head = e.headColor || "#cde";
  const isBit = e.id === "bit" || e.name === "Bit";
  const legSwing = walking ? Math.sin(e.walkPhase || 0) * 5 : 0;

  ctx.fillStyle = shade(body, -45);
  ctx.fillRect(-8, 8, 5.5, 8 + legSwing * 0.35);
  ctx.fillRect(2.5, 8, 5.5, 8 - legSwing * 0.35);

  ctx.shadowColor = body;
  ctx.shadowBlur = highlight ? 22 : 14;
  const bg = ctx.createLinearGradient(-12, -8, 12, 14);
  bg.addColorStop(0, shade(body, 30));
  bg.addColorStop(1, shade(body, -25));
  ctx.fillStyle = bg;
  roundRect(ctx, -12, -7, 24, 20, 7);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = "rgba(255,255,255,0.14)";
  roundRect(ctx, -7, -2, 14, 9, 3);
  ctx.fill();
  ctx.fillStyle = body;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.arc(0, 2.5, 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  const hg = ctx.createLinearGradient(-10, -24, 10, -6);
  hg.addColorStop(0, "#ffffff");
  hg.addColorStop(0.35, head);
  hg.addColorStop(1, shade(head, -18));
  ctx.fillStyle = hg;
  roundRect(ctx, -10, -24, 20, 17, 6);
  ctx.fill();

  if (isBit) {
    ctx.strokeStyle = body;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(0, -24);
    ctx.lineTo(0, -30);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.shadowColor = body;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, -32, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = shade(body, -8);
    ctx.beginPath();
    ctx.moveTo(-8, -20);
    ctx.lineTo(-13, -30);
    ctx.lineTo(-3, -22);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(8, -20);
    ctx.lineTo(13, -30);
    ctx.lineTo(3, -22);
    ctx.fill();
  }

  const blink = Math.sin(t * 2.1 + (e.x || 0) * 0.05) > 0.96 ? 0.15 : 1;
  ctx.fillStyle = "#0a0e14";
  ctx.fillRect(-5.5, -17.5, 4, 4.2 * blink);
  ctx.fillRect(1.5, -17.5, 4, 4.2 * blink);
  if (blink > 0.5) {
    ctx.fillStyle = isBit ? "#9ee7ff" : "#ffb0a0";
    ctx.fillRect(-4.2, -16.5, 1.6, 1.6);
    ctx.fillRect(2.8, -16.5, 1.6, 1.6);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(Math.cos(ang) * 7, Math.sin(ang) * 7);
  ctx.lineTo(Math.cos(ang) * 19, Math.sin(ang) * 19);
  ctx.stroke();

  if (e.holding) {
    drawMiniOrb(ctx, Math.cos(ang + 0.9) * 15, Math.sin(ang + 0.9) * 11 - 4, e.holding.color);
  }
  if (e.emote && e.emote !== "none") {
    const emo = e.emote === "wave" ? "✦" : e.emote === "happy" ? "♪" : "…";
    ctx.font = "15px sans-serif";
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(emo, 15, -28);
  }

  drawNameplate(ctx, 0, -38, e.name, e.nameColor || body);
  if (e.thought) drawThought(ctx, 0, -52, e.thought);
  else if (e.statusLine && e.showFov) {
    // debug status under name when FOV debug on
  }
  ctx.restore();
}

function drawThought(ctx, x, y, text) {
  ctx.save();
  ctx.font = "bold 9px ui-monospace, monospace";
  ctx.textAlign = "center";
  const w = Math.max(28, ctx.measureText(text).width + 10);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  roundRect(ctx, x - w / 2, y - 10, w, 14, 6);
  ctx.fill();
  // tail
  ctx.beginPath();
  ctx.moveTo(x - 3, y + 4);
  ctx.lineTo(x, y + 9);
  ctx.lineTo(x + 4, y + 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#1a2030";
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawMiniOrb(ctx, x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(5, 0);
  ctx.lineTo(0, 6);
  ctx.lineTo(-5, 0);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawNameplate(ctx, x, y, text, color) {
  ctx.save();
  ctx.font = "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  const w = Math.max(28, ctx.measureText(text).width + 12);
  ctx.fillStyle = "rgba(0,0,0,0.58)";
  roundRect(ctx, x - w / 2, y - 10, w, 15, 5);
  ctx.fill();
  ctx.strokeStyle = hexToRgba(color, 0.4);
  ctx.lineWidth = 1;
  roundRect(ctx, x - w / 2, y - 10, w, 15, 5);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + 1);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shade(hex, amt) {
  const c = (hex || "#888888").replace("#", "");
  if (c.length < 6) return hex;
  const n = parseInt(c.slice(0, 6), 16);
  let r = (n >> 16) + amt;
  let g = ((n >> 8) & 0xff) + amt;
  let b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function hexToRgba(hex, a) {
  const c = (hex || "#ffffff").replace("#", "");
  if (c.length < 6) return `rgba(255,255,255,${a})`;
  const n = parseInt(c.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function drawMinimap(ctx, x, y, w, h, world, entities) {
  ctx.save();
  ctx.fillStyle = "rgba(8,12,20,0.88)";
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(100,150,220,0.3)";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 8);
  ctx.stroke();

  const sx = (w - 6) / WORLD_W;
  const sy = (h - 6) / WORLD_H;
  const ox = x + 3;
  const oy = y + 3;

  for (const r of world.rooms) {
    ctx.fillStyle = r.color;
    ctx.fillRect(ox + r.x * sx, oy + r.y * sy, r.w * sx, r.h * sy);
    ctx.strokeStyle = hexToRgba(r.accent || "#444", 0.45);
    ctx.strokeRect(ox + r.x * sx, oy + r.y * sy, r.w * sx, r.h * sy);
  }
  ctx.fillStyle = "#2e3648";
  for (const wall of world.walls) {
    ctx.fillRect(ox + wall.x * sx, oy + wall.y * sy, Math.max(1, wall.w * sx), Math.max(1, wall.h * sy));
  }
  for (const p of world.pickups) {
    if (p.heldBy) continue;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.arc(ox + p.x * sx, oy + p.y * sy, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  if (world.beacon) {
    ctx.strokeStyle = "#7f7";
    ctx.beginPath();
    ctx.arc(ox + world.beacon.x * sx, oy + world.beacon.y * sy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const e of entities) {
    ctx.fillStyle = e.color || "#fff";
    ctx.shadowColor = e.color || "#fff";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(ox + e.x * sx, oy + e.y * sy, e.kind === "human" ? 3.2 : 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}
