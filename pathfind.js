/**
 * Grid A* pathfinding for the hangout world (avoids walls + solid props).
 */
import { WORLD_W, WORLD_H, PAD } from "./world.js";

const CELL = 20;

let gridCache = null;
let gridKey = "";

function cellKey(world) {
  // walls/props static per world instance layout
  return `${world.walls.length}:${world.props.length}`;
}

export function buildGrid(world) {
  const cols = Math.ceil(WORLD_W / CELL);
  const rows = Math.ceil(WORLD_H / CELL);
  const blocked = new Uint8Array(cols * rows);

  function markRect(x, y, w, h, inflate = 0) {
    const x0 = Math.max(0, Math.floor((x - inflate) / CELL));
    const y0 = Math.max(0, Math.floor((y - inflate) / CELL));
    const x1 = Math.min(cols - 1, Math.floor((x + w + inflate) / CELL));
    const y1 = Math.min(rows - 1, Math.floor((y + h + inflate) / CELL));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        blocked[cy * cols + cx] = 1;
      }
    }
  }

  // outer padding as soft border already in walls
  for (const w of world.walls) {
    markRect(w.x, w.y, w.w, w.h, 4);
  }
  for (const p of world.props) {
    if (!p.solid) continue;
    const r = p.r * 0.85;
    markRect(p.x - r, p.y - r, r * 2, r * 2, 2);
  }

  // keep outer PAD walkable-ish but walls cover edges
  gridCache = { cols, rows, blocked, cell: CELL };
  gridKey = cellKey(world);
  return gridCache;
}

function getGrid(world) {
  if (!gridCache || gridKey !== cellKey(world)) buildGrid(world);
  return gridCache;
}

function worldToCell(x, y, g) {
  return {
    cx: Math.max(0, Math.min(g.cols - 1, Math.floor(x / g.cell))),
    cy: Math.max(0, Math.min(g.rows - 1, Math.floor(y / g.cell))),
  };
}

function cellToWorld(cx, cy, g) {
  return {
    x: cx * g.cell + g.cell / 2,
    y: cy * g.cell + g.cell / 2,
  };
}

function isBlocked(g, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return true;
  return g.blocked[cy * g.cols + cx] === 1;
}

/** Find nearest free cell if start/goal blocked */
function nearestFree(g, cx, cy) {
  if (!isBlocked(g, cx, cy)) return { cx, cy };
  for (let r = 1; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!isBlocked(g, nx, ny)) return { cx: nx, cy: ny };
      }
    }
  }
  return { cx, cy };
}

/**
 * A* path in world coords. Returns array of {x,y} including goal-ish, or [].
 */
export function findPath(world, x0, y0, x1, y1) {
  const g = getGrid(world);
  let start = worldToCell(x0, y0, g);
  let goal = worldToCell(x1, y1, g);
  start = nearestFree(g, start.cx, start.cy);
  goal = nearestFree(g, goal.cx, goal.cy);

  if (start.cx === goal.cx && start.cy === goal.cy) {
    return [{ x: x1, y: y1 }];
  }

  const open = [];
  const came = new Map();
  const gScore = new Map();
  const fScore = new Map();
  const key = (cx, cy) => cy * g.cols + cx;

  const sk = key(start.cx, start.cy);
  gScore.set(sk, 0);
  fScore.set(sk, Math.hypot(goal.cx - start.cx, goal.cy - start.cy));
  open.push({ cx: start.cx, cy: start.cy, f: fScore.get(sk) });

  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  let guard = 0;
  while (open.length && guard++ < 4000) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (cur.cx === goal.cx && cur.cy === goal.cy) {
      // reconstruct
      const cells = [{ cx: cur.cx, cy: cur.cy }];
      let ck = key(cur.cx, cur.cy);
      while (came.has(ck)) {
        const prev = came.get(ck);
        cells.push(prev);
        ck = key(prev.cx, prev.cy);
      }
      cells.reverse();
      // convert + smooth: skip every other if colinear-ish, append exact goal
      const path = cells.map((c) => cellToWorld(c.cx, c.cy, g));
      // clamp to world
      for (const p of path) {
        p.x = Math.max(PAD, Math.min(WORLD_W - PAD, p.x));
        p.y = Math.max(PAD, Math.min(WORLD_H - PAD, p.y));
      }
      path.push({
        x: Math.max(PAD, Math.min(WORLD_W - PAD, x1)),
        y: Math.max(PAD, Math.min(WORLD_H - PAD, y1)),
      });
      return simplify(path);
    }

    const ck = key(cur.cx, cur.cy);
    const baseG = gScore.get(ck) ?? Infinity;

    for (const [dx, dy] of dirs) {
      const nx = cur.cx + dx;
      const ny = cur.cy + dy;
      if (isBlocked(g, nx, ny)) continue;
      // prevent corner cutting through walls
      if (dx !== 0 && dy !== 0) {
        if (isBlocked(g, cur.cx + dx, cur.cy) || isBlocked(g, cur.cx, cur.cy + dy)) continue;
      }
      const nk = key(nx, ny);
      const step = dx !== 0 && dy !== 0 ? 1.414 : 1;
      const tent = baseG + step;
      if (tent < (gScore.get(nk) ?? Infinity)) {
        came.set(nk, { cx: cur.cx, cy: cur.cy });
        gScore.set(nk, tent);
        const f = tent + Math.hypot(goal.cx - nx, goal.cy - ny);
        fScore.set(nk, f);
        if (!open.some((o) => o.cx === nx && o.cy === ny)) {
          open.push({ cx: nx, cy: ny, f });
        } else {
          const o = open.find((o) => o.cx === nx && o.cy === ny);
          if (o) o.f = f;
        }
      }
    }
  }

  // fallback: empty — caller can steer direct
  return [];
}

function simplify(path) {
  if (path.length <= 2) return path;
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = out[out.length - 1];
    const b = path[i];
    const c = path[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const bcx = c.x - b.x;
    const bcy = c.y - b.y;
    // keep if direction changes
    const cross = Math.abs(abx * bcy - aby * bcx);
    if (cross > 40) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Set agent nav path toward target; returns true if path found */
export function setNavTo(world, agent, tx, ty) {
  const path = findPath(world, agent.x, agent.y, tx, ty);
  agent.navPath = path.length ? path : [{ x: tx, y: ty }];
  agent.navIndex = 0;
  agent.moving = true;
  agent.move = "nav";
  return path.length > 0;
}

export function clearNav(agent) {
  agent.navPath = null;
  agent.navIndex = 0;
}

/**
 * Advance along navPath. Returns true if still navigating.
 */
export function followNav(world, agent, dt, speed, moveWithCollision) {
  if (!agent.navPath || !agent.navPath.length) return false;
  const target = agent.navPath[Math.min(agent.navIndex, agent.navPath.length - 1)];
  if (!target) {
    clearNav(agent);
    return false;
  }

  const dx = target.x - agent.x;
  const dy = target.y - agent.y;
  const dist = Math.hypot(dx, dy) || 1;

  if (dist < 10) {
    agent.navIndex += 1;
    if (agent.navIndex >= agent.navPath.length) {
      clearNav(agent);
      agent.moving = false;
      agent.move = "idle";
      return false;
    }
    return true;
  }

  const sp = speed * dt;
  const nx = agent.x + (dx / dist) * sp;
  const ny = agent.y + (dy / dist) * sp;
  const res = moveWithCollision(world, agent.x, agent.y, nx, ny, 14);
  agent.x = res.x;
  agent.y = res.y;
  agent.angle = Math.atan2(dy, dx);
  agent.facing = Math.cos(agent.angle) >= 0 ? 1 : -1;
  agent.walkPhase = (agent.walkPhase || 0) + dt * 14;
  agent.moving = true;

  if (res.hit) {
    // repath once
    const goal = agent.navPath[agent.navPath.length - 1];
    const path = findPath(world, agent.x, agent.y, goal.x, goal.y);
    if (path.length) {
      agent.navPath = path;
      agent.navIndex = 0;
    } else {
      clearNav(agent);
      return false;
    }
  }
  return true;
}
