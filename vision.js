/**
 * Egocentric + multi-frame VLA camera.
 * Renders a first-person-ish top-down FOV for the active agent.
 */
import { hasLOS } from "./world.js";

const FRAME_W = 360;
const FRAME_H = 220;

/**
 * Paint egocentric frame for agent into canvas.
 * World is rotated so agent faces "up" the image.
 */
export function captureEgocentric(canvas, world, agent, others, history = []) {
  const ctx = canvas.getContext("2d");
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const cw = FRAME_W;
  const ch = FRAME_H;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, cw, ch);

  const ang = agent.angle ?? 0;
  // camera looks along agent facing; world rotates opposite
  const range = 220;

  ctx.save();
  ctx.translate(cw / 2, ch * 0.72);
  ctx.rotate(-ang - Math.PI / 2);

  // dim full map snippet around agent
  const viewR = range;

  // rooms relative
  for (const r of world.rooms) {
    const rx = r.x - agent.x;
    const ry = r.y - agent.y;
    if (Math.hypot(rx + r.w / 2, ry + r.h / 2) > viewR + 200) continue;
    ctx.fillStyle = r.color;
    ctx.globalAlpha = 0.95;
    ctx.fillRect(rx, ry, r.w, r.h);
  }
  ctx.globalAlpha = 1;

  // walls
  ctx.fillStyle = "#333";
  for (const w of world.walls) {
    ctx.fillRect(w.x - agent.x, w.y - agent.y, w.w, w.h);
  }

  // props
  for (const p of world.props) {
    const dx = p.x - agent.x;
    const dy = p.y - agent.y;
    if (Math.hypot(dx, dy) > viewR) continue;
    const visible = hasLOS(world, agent.x, agent.y, p.x, p.y);
    ctx.globalAlpha = visible ? 1 : 0.15;
    ctx.beginPath();
    ctx.fillStyle = "#3a3a48";
    ctx.arc(dx, dy, p.r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    if (visible) {
      ctx.fillStyle = "#889";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(p.label, dx, dy - p.r - 2);
    }
    ctx.globalAlpha = 1;
  }

  // pickups
  for (const p of world.pickups) {
    if (p.heldBy) continue;
    const dx = p.x - agent.x;
    const dy = p.y - agent.y;
    if (Math.hypot(dx, dy) > viewR) continue;
    if (!hasLOS(world, agent.x, agent.y, p.x, p.y)) continue;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(dx, dy - 7);
    ctx.lineTo(dx + 6, dy);
    ctx.lineTo(dx, dy + 7);
    ctx.lineTo(dx - 6, dy);
    ctx.closePath();
    ctx.fill();
  }

  // other entities
  for (const o of others) {
    const dx = o.x - agent.x;
    const dy = o.y - agent.y;
    const d = Math.hypot(dx, dy);
    if (d > viewR) continue;
    const visible = hasLOS(world, agent.x, agent.y, o.x, o.y);
    ctx.globalAlpha = visible ? 1 : 0.12;
    ctx.fillStyle = o.color || "#aaa";
    if (o.kind === "human") {
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dx, dy, 11, 0, Math.PI * 2);
      ctx.stroke();
    } else if (o.kind === "node") {
      ctx.fillRect(dx - 9, dy - 9, 18, 18);
    } else {
      ctx.fillRect(dx - 9, dy - 6, 18, 16);
      ctx.fillStyle = "#eee";
      ctx.fillRect(dx - 6, dy - 16, 12, 10);
    }
    if (visible) {
      ctx.fillStyle = "#ff5";
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(o.name || "?", dx, dy - 20);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // FOV darken outside cone (screen space, agent at bottom-center looking up)
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.beginPath();
  ctx.rect(0, 0, cw, ch);
  // cut out FOV triangle
  const fov = Math.PI * 0.55;
  ctx.moveTo(cw / 2, ch * 0.72);
  ctx.arc(cw / 2, ch * 0.72, ch * 0.95, -Math.PI / 2 - fov / 2, -Math.PI / 2 + fov / 2);
  ctx.closePath();
  ctx.fill("evenodd");
  ctx.restore();

  // self reticle
  ctx.strokeStyle = "#ffff55";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cw / 2, ch * 0.72);
  ctx.lineTo(cw / 2, ch * 0.72 - 22);
  ctx.stroke();
  ctx.fillStyle = "#ffff55";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`YOU:${agent.name}`, cw / 2, ch * 0.72 + 16);

  // history strips (previous frames) along top
  if (history.length) {
    const tw = 48;
    const th = 30;
    history.slice(-3).forEach((img, i) => {
      try {
        ctx.globalAlpha = 0.55;
        ctx.drawImage(img, 6 + i * (tw + 4), 6, tw, th);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#333";
        ctx.strokeRect(6 + i * (tw + 4), 6, tw, th);
      } catch {
        /* */
      }
    });
  }

  // HUD
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, ch - 20, cw, 20);
  ctx.fillStyle = "#9a9";
  ctx.font = "10px monospace";
  ctx.textAlign = "left";
  const room = world.rooms.find(
    (r) =>
      agent.x >= r.x &&
      agent.x <= r.x + r.w &&
      agent.y >= r.y &&
      agent.y <= r.y + r.h
  );
  ctx.fillText(
    `${agent.name} FOV · ${room?.name || "void"} · hold:${agent.holding?.id || "-"}`,
    6,
    ch - 6
  );

  return canvas.toDataURL("image/png");
}

/** Keep rolling HTMLImageElement history from data URLs */
export async function pushFrameHistory(history, dataUrl, max = 3) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => {});
  history.push(img);
  while (history.length > max) history.shift();
  return history;
}

export { FRAME_W, FRAME_H };
