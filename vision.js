/**
 * High-contrast egocentric VLA camera + multi-frame strips.
 * Optimized for tiny VLMs: big labels, flat colors, clear FOV.
 */
import { hasLOS } from "./world.js";

// Lower res = faster VLA; still readable with high contrast
export const FRAME_W = 256;
export const FRAME_H = 160;

/**
 * Ground-truth summary of what is actually visible (for see-vs-truth scoring).
 */
export function visibleTruth(world, agent, others) {
  const room = world.rooms.find(
    (r) =>
      agent.x >= r.x &&
      agent.x <= r.x + r.w &&
      agent.y >= r.y &&
      agent.y <= r.y + r.h
  );
  const seen = {
    room: room?.name || "void",
    entities: [],
    props: [],
    orbs: [],
  };

  const ang = agent.angle ?? 0;
  const halfFov = (Math.PI * 0.55) / 2;
  const range = 200;

  function inFov(x, y) {
    const dx = x - agent.x;
    const dy = y - agent.y;
    const d = Math.hypot(dx, dy);
    if (d < 8) return true;
    if (d > range) return false;
    let a = Math.atan2(dy, dx) - ang;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return Math.abs(a) <= halfFov + 0.15;
  }

  for (const o of others) {
    const d = Math.hypot(o.x - agent.x, o.y - agent.y);
    if (d > range) continue;
    if (!inFov(o.x, o.y)) continue;
    if (!hasLOS(world, agent.x, agent.y, o.x, o.y)) continue;
    seen.entities.push({
      name: o.name,
      d: Math.round(d),
      kind: o.kind || "sprite",
    });
  }

  for (const p of world.props) {
    const d = Math.hypot(p.x - agent.x, p.y - agent.y);
    if (d > range || !inFov(p.x, p.y)) continue;
    if (!hasLOS(world, agent.x, agent.y, p.x, p.y)) continue;
    seen.props.push({ id: p.id, label: p.label, d: Math.round(d) });
  }

  for (const p of world.pickups) {
    if (p.heldBy) continue;
    const d = Math.hypot(p.x - agent.x, p.y - agent.y);
    if (d > range || !inFov(p.x, p.y)) continue;
    if (!hasLOS(world, agent.x, agent.y, p.x, p.y)) continue;
    seen.orbs.push({ id: p.id, d: Math.round(d) });
  }

  return seen;
}

export function truthToString(seen) {
  const bits = [`room:${seen.room}`];
  if (seen.entities.length) {
    bits.push(
      "see:" + seen.entities.map((e) => `${e.name}@${e.d}`).join(",")
    );
  } else bits.push("see:nobody");
  if (seen.props.length) {
    bits.push("props:" + seen.props.map((p) => p.id).join(","));
  }
  if (seen.orbs.length) {
    bits.push("orbs:" + seen.orbs.map((o) => o.id).join(","));
  }
  return bits.join(" | ");
}

/**
 * Score model "see" text vs ground truth (0–1 rough).
 */
export function scoreSee(seeText, truth) {
  if (!seeText) return 0;
  const s = String(seeText).toLowerCase();
  let hits = 0;
  let total = 1;
  if (truth.room && s.includes(truth.room.toLowerCase())) hits += 1;
  total += 1;
  for (const e of truth.entities) {
    total += 1;
    if (s.includes(e.name.toLowerCase())) hits += 1;
  }
  for (const p of truth.props.slice(0, 3)) {
    total += 1;
    if (s.includes(p.id) || s.includes(p.label.replace(/[^\w]/g, "").toLowerCase())) {
      hits += 1;
    }
  }
  for (const o of truth.orbs) {
    total += 1;
    if (s.includes("orb") || s.includes(o.id)) hits += 1;
  }
  return Math.min(1, hits / Math.max(1, total * 0.6));
}

export function captureEgocentric(canvas, world, agent, others, history = []) {
  const ctx = canvas.getContext("2d");
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const cw = FRAME_W;
  const ch = FRAME_H;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  const ang = agent.angle ?? 0;
  const range = 200;

  ctx.save();
  ctx.translate(cw / 2, ch * 0.75);
  ctx.rotate(-ang - Math.PI / 2);

  // rooms — high contrast fills
  for (const r of world.rooms) {
    const rx = r.x - agent.x;
    const ry = r.y - agent.y;
    ctx.fillStyle = r.visionColor || r.color || "#111";
    ctx.fillRect(rx, ry, r.w, r.h);
    // big room label on floor
    ctx.fillStyle = "#3a3a3a";
    ctx.font = "bold 22px monospace";
    ctx.textAlign = "center";
    ctx.fillText(r.name.toUpperCase(), rx + r.w / 2, ry + r.h / 2);
  }

  // walls thick bright
  ctx.fillStyle = "#666";
  for (const w of world.walls) {
    ctx.fillRect(w.x - agent.x, w.y - agent.y, w.w, w.h);
  }
  ctx.strokeStyle = "#aaa";
  ctx.lineWidth = 2;
  for (const w of world.walls) {
    ctx.strokeRect(w.x - agent.x + 0.5, w.y - agent.y + 0.5, w.w - 1, w.h - 1);
  }

  // props — large icons + text
  for (const p of world.props) {
    const dx = p.x - agent.x;
    const dy = p.y - agent.y;
    if (Math.hypot(dx, dy) > range) continue;
    const visible = hasLOS(world, agent.x, agent.y, p.x, p.y);
    ctx.globalAlpha = visible ? 1 : 0.12;
    ctx.fillStyle = p.visionFill || "#5a5a78";
    ctx.beginPath();
    ctx.arc(dx, dy, Math.max(14, p.r), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (visible) {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 13px monospace";
      ctx.textAlign = "center";
      ctx.fillText(p.id.toUpperCase(), dx, dy + 4);
      ctx.font = "11px monospace";
      ctx.fillStyle = "#ff6";
      ctx.fillText(p.label, dx, dy - p.r - 6);
    }
    ctx.globalAlpha = 1;
  }

  // orbs
  for (const p of world.pickups) {
    if (p.heldBy) continue;
    const dx = p.x - agent.x;
    const dy = p.y - agent.y;
    if (Math.hypot(dx, dy) > range) continue;
    if (!hasLOS(world, agent.x, agent.y, p.x, p.y)) continue;
    ctx.fillStyle = p.color;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dx, dy - 12);
    ctx.lineTo(dx + 10, dy);
    ctx.lineTo(dx, dy + 12);
    ctx.lineTo(dx - 10, dy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "center";
    ctx.fillText("ORB", dx, dy + 24);
  }

  // beacon
  if (world.beacon) {
    const dx = world.beacon.x - agent.x;
    const dy = world.beacon.y - agent.y;
    if (Math.hypot(dx, dy) < range + 40) {
      ctx.strokeStyle = "#0f0";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(dx, dy, 16 + (Date.now() / 100) % 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#0f0";
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "center";
      ctx.fillText("BEACON", dx, dy - 22);
    }
  }

  // entities
  for (const o of others) {
    const dx = o.x - agent.x;
    const dy = o.y - agent.y;
    const d = Math.hypot(dx, dy);
    if (d > range) continue;
    const visible = hasLOS(world, agent.x, agent.y, o.x, o.y);
    ctx.globalAlpha = visible ? 1 : 0.1;
    ctx.fillStyle = o.color || "#aaa";
    if (o.kind === "human") {
      ctx.strokeStyle = "#0f0";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(dx, dy, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#0f0";
    } else if (o.kind === "node") {
      ctx.fillRect(dx - 12, dy - 12, 24, 24);
      ctx.strokeStyle = "#ff0";
      ctx.lineWidth = 2;
      ctx.strokeRect(dx - 12, dy - 12, 24, 24);
    } else {
      ctx.fillRect(dx - 12, dy - 8, 24, 22);
      ctx.fillStyle = "#fff";
      ctx.fillRect(dx - 8, dy - 20, 16, 12);
    }
    if (visible) {
      ctx.fillStyle = "#ffff00";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.fillText((o.name || "?").toUpperCase(), dx, dy - 28);
      ctx.font = "11px monospace";
      ctx.fillStyle = "#fff";
      ctx.fillText(`${Math.round(d)}px`, dx, dy + 28);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // FOV mask — hard black outside cone
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.rect(0, 0, cw, ch);
  const fov = Math.PI * 0.55;
  ctx.moveTo(cw / 2, ch * 0.75);
  ctx.arc(cw / 2, ch * 0.75, ch, -Math.PI / 2 - fov / 2, -Math.PI / 2 + fov / 2);
  ctx.closePath();
  ctx.fill("evenodd");
  ctx.restore();

  // self marker
  ctx.fillStyle = "#ffff00";
  ctx.beginPath();
  ctx.moveTo(cw / 2, ch * 0.75);
  ctx.lineTo(cw / 2 - 8, ch * 0.75 + 12);
  ctx.lineTo(cw / 2 + 8, ch * 0.75 + 12);
  ctx.closePath();
  ctx.fill();
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`YOU=${agent.name.toUpperCase()}`, cw / 2, ch * 0.75 + 26);
  ctx.strokeStyle = "#ffff00";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cw / 2, ch * 0.75);
  ctx.lineTo(cw / 2, ch * 0.75 - 28);
  ctx.stroke();

  // history strips
  if (history.length) {
    const tw = 40;
    const th = 26;
    history.slice(-3).forEach((img, i) => {
      try {
        ctx.globalAlpha = 0.7;
        ctx.drawImage(img, 4 + i * (tw + 3), 4, tw, th);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#666";
        ctx.strokeRect(4 + i * (tw + 3), 4, tw, th);
      } catch {
        /* */
      }
    });
  }

  // HUD bar
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fillRect(0, ch - 18, cw, 18);
  ctx.fillStyle = "#0f0";
  ctx.font = "bold 10px monospace";
  ctx.textAlign = "left";
  const room = world.rooms.find(
    (r) =>
      agent.x >= r.x &&
      agent.x <= r.x + r.w &&
      agent.y >= r.y &&
      agent.y <= r.y + r.h
  );
  ctx.fillText(
    `${agent.name} | ${room?.name || "?"} | hold:${agent.holding?.id || "-"}`,
    4,
    ch - 5
  );

  return canvas.toDataURL("image/jpeg", 0.85);
}

export async function pushFrameHistory(history, dataUrl, max = 3) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => {});
  history.push(img);
  while (history.length > max) history.shift();
  return history;
}
