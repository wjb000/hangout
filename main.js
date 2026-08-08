/**
 * Hangout VLA World — full sim
 * Vision (SmolVLM) → Language/plan → Action → Environment
 */
import {
  AutoProcessor,
  AutoModelForVision2Seq,
  RawImage,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1";

import { sfx, unlockAudio } from "./audio.js";
import {
  createWorld,
  roomAt,
  moveWithCollision,
  hasLOS,
  dist,
  nearestProp,
  nearestFreePickup,
  viewTransform,
  screenToWorld,
  drawWorld,
  WORLD_W,
  WORLD_H,
} from "./world.js";
import { captureEgocentric, pushFrameHistory } from "./vision.js";

// ── Config ──────────────────────────────────────────────────
const MODEL_CANDIDATES = [
  "HuggingFaceTB/SmolVLM-256M-Instruct",
  "HuggingFaceTB/SmolVLM-500M-Instruct",
];
const STEP_PX = 40;
const MOVE_SPEED = 120;
const HEAR_RANGE = 160;
const GRAB_RANGE = 36;
const MOTOR_HZ = 60;
const VLA_GAP_MS = 200;
const MEMORY_KEY = "hangout_vla_memory_v1";
const CHAT_MAX = 18;
const CHAT_FADE_MS = 14000;

// Valid action tokens (constrained schema)
const MOVES = new Set([
  "forward", "back", "left", "right", "turn_left", "turn_right",
  "toward", "away", "idle", "wait",
  "orbit_other", "patrol_edge", "follow",
  "up", "down", "upleft", "upright", "downleft", "downright", // aliases
]);
const ACTS = new Set(["none", "grab", "drop", "use", "wave"]);
const MOODS = new Set(["idle", "think", "happy", "curious", "wave"]);

// ── DOM ─────────────────────────────────────────────────────
const worldCanvas = document.getElementById("world");
const visionCanvas = document.getElementById("vision");
const visionMeta = document.getElementById("vision-meta");
const chatlog = document.getElementById("chatlog");
const statusEl = document.getElementById("status");
const goalsEl = document.getElementById("goals");
const progressEl = document.getElementById("progress");
const progressBar = progressEl.querySelector("i");
const debugEl = document.getElementById("debug");
const dbgBody = document.getElementById("dbg-body");

const wctx = worldCanvas.getContext("2d");

// ── State ───────────────────────────────────────────────────
const world = createWorld();
let processor = null;
let model = null;
let modelId = "";
let running = true;
let debugOn = false;
let lastMotor = 0;
let lastStepSfx = 0;

const transcript = []; // spoken lines with positions for range checks later

const human = {
  id: "you",
  name: "You",
  kind: "human",
  x: WORLD_W / 2,
  y: WORLD_H / 2,
  color: "#55ff55",
  lastSaid: "",
};

function createAgent(cfg) {
  return {
    id: cfg.id,
    name: cfg.name,
    kind: "sprite",
    cssClass: cfg.cssClass,
    color: cfg.color,
    headColor: cfg.headColor,
    nameColor: cfg.nameColor,
    persona: cfg.persona,
    x: cfg.x,
    y: cfg.y,
    angle: cfg.angle ?? 0,
    facing: 1,
    intent: { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null },
    move: "idle",
    mood: "curious",
    emote: "none",
    goal: cfg.goal,
    lastSaid: "",
    lastSaw: "",
    speedMul: 1,
    ticks: 0,
    memory: [],       // short-term
    longTerm: [],     // persistent snippets
    envEvents: [],
    holding: null,
    frameHistory: [],
    lastAction: null,
    lastRaw: "",
    lookAt: null,
    skillT: 0,
  };
}

const bit = createAgent({
  id: "bit",
  name: "Bit",
  cssClass: "bit",
  color: "#6ec6ff",
  headColor: "#b8e4ff",
  nameColor: "#6ec6ff",
  persona: "optimistic cyan glitch; curious, friendly, loves orbs and coffee",
  x: 160,
  y: 180,
  angle: 0,
  goal: "meet Nox and collect an orb",
});

const nox = createAgent({
  id: "nox",
  name: "Nox",
  cssClass: "nox",
  color: "#ff7a6e",
  headColor: "#ffc4bc",
  nameColor: "#ff7a6e",
  persona: "dry coral glitch; teases Bit, secretly maps the rooms",
  x: 780,
  y: 180,
  angle: Math.PI,
  goal: "explore lab then bump into Bit",
});

const agents = [bit, nox];

// Quest board
const quests = [
  { id: "meet", label: "Bit & Nox meet (close + LOS)", progress: 0, target: 1, done: false },
  { id: "orbs", label: "Collect orbs (held or banked)", progress: 0, target: 3, done: false },
  { id: "rooms", label: "Visit all rooms (combined)", progress: 0, target: 4, done: false, seen: new Set() },
  { id: "talk", label: "Exchange 6 spoken lines", progress: 0, target: 6, done: false },
];

// ── Memory persistence ──────────────────────────────────────
function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const a of agents) {
      const m = data[a.id];
      if (m?.longTerm) a.longTerm = m.longTerm.slice(-12);
      if (m?.goal) a.goal = m.goal;
    }
    if (data.quests) {
      for (const q of quests) {
        const s = data.quests.find((x) => x.id === q.id);
        if (s) {
          q.progress = s.progress || 0;
          q.done = !!s.done;
          if (q.id === "rooms" && s.seen) q.seen = new Set(s.seen);
        }
      }
    }
  } catch {
    /* */
  }
}

function saveMemory() {
  try {
    const data = {
      quests: quests.map((q) => ({
        id: q.id,
        progress: q.progress,
        done: q.done,
        seen: q.seen ? [...q.seen] : undefined,
      })),
    };
    for (const a of agents) {
      data[a.id] = {
        longTerm: a.longTerm.slice(-12),
        goal: a.goal,
      };
    }
    localStorage.setItem(MEMORY_KEY, JSON.stringify(data));
  } catch {
    /* */
  }
}

loadMemory();

// ── UI helpers ──────────────────────────────────────────────
function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
  statusEl.style.opacity = "1";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function logSpeech(name, text, cssClass, pos = null) {
  const msg = String(text || "").trim();
  if (!msg) return;
  transcript.push({ name, text: msg, t: Date.now(), x: pos?.x, y: pos?.y });
  if (transcript.length > 20) transcript.shift();

  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML = `<span class="${cssClass}">&lt;${escapeHtml(name)}&gt;</span> ${escapeHtml(msg)}`;
  chatlog.appendChild(line);
  while (chatlog.children.length > CHAT_MAX) chatlog.removeChild(chatlog.firstChild);
  setTimeout(() => line.classList.add("fade"), CHAT_FADE_MS);
  setTimeout(() => line.remove(), CHAT_FADE_MS + 1500);

  sfx.talk(cssClass);
  quests.find((q) => q.id === "talk").progress = Math.min(
    6,
    (quests.find((q) => q.id === "talk").progress || 0) + 1
  );
  updateQuests();
}

function renderGoals() {
  goalsEl.innerHTML = quests
    .map((q) => {
      const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
      return `<div class="goal-chip ${q.done ? "done" : ""}">${q.done ? "✓ " : ""}${escapeHtml(q.label)}<span class="bar"><i style="width:${pct}%"></i></span></div>`;
    })
    .join("");
}

function updateQuests() {
  // meet
  const d = dist(bit, nox);
  const meet = quests.find((q) => q.id === "meet");
  if (!meet.done && d < 70 && hasLOS(world, bit.x, bit.y, nox.x, nox.y)) {
    meet.progress = 1;
    meet.done = true;
    sfx.goal();
    rememberLong(bit, "met Nox in person");
    rememberLong(nox, "met Bit in person");
  }

  // orbs held
  const orbs = quests.find((q) => q.id === "orbs");
  const held = world.pickups.filter((p) => p.heldBy).length;
  // count unique holders progress as held count (simple)
  orbs.progress = Math.max(orbs.progress, held);
  // also count if all picked at least once via longTerm — keep simple: held max
  if (orbs.progress >= orbs.target) {
    if (!orbs.done) sfx.goal();
    orbs.done = true;
  }

  // rooms
  const rq = quests.find((q) => q.id === "rooms");
  for (const a of agents) {
    const r = roomAt(world, a.x, a.y);
    if (r) rq.seen.add(r.id);
  }
  rq.progress = rq.seen.size;
  if (rq.progress >= rq.target && !rq.done) {
    rq.done = true;
    sfx.goal();
  }

  // talk
  const tq = quests.find((q) => q.id === "talk");
  if (tq.progress >= tq.target && !tq.done) {
    tq.done = true;
    sfx.goal();
  }

  renderGoals();
  saveMemory();
}

function remember(agent, line) {
  agent.memory.push(line);
  if (agent.memory.length > 8) agent.memory.shift();
}

function rememberLong(agent, line) {
  if (!line) return;
  if (agent.longTerm[agent.longTerm.length - 1] === line) return;
  agent.longTerm.push(line);
  if (agent.longTerm.length > 12) agent.longTerm.shift();
  saveMemory();
}

function moodColor(agent) {
  if (agent.mood === "think") return "#c9a0ff";
  if (agent.mood === "happy" || agent.mood === "wave") return "#7dffb3";
  if (agent.mood === "curious") return "#ffe08a";
  return agent.color;
}

// ── Speech with range + LOS ─────────────────────────────────
function trySay(agent, text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  agent.lastSaid = msg.slice(0, 120);

  // always log to Minecraft chat (observer UI), but agents only "hear" if in range
  logSpeech(agent.name, agent.lastSaid, agent.cssClass, agent);

  // deliver to others who can hear
  for (const other of [...agents, world.node, human]) {
    if (other.id === agent.id) continue;
    const d = dist(agent, other);
    if (d > HEAR_RANGE) continue;
    if (other.kind !== "human" && !hasLOS(world, agent.x, agent.y, other.x, other.y)) continue;
    if (other.memory) {
      remember(other, `heard <${agent.name}> ${msg.slice(0, 40)}`);
    }
  }
  rememberLong(agent, `said: ${msg.slice(0, 50)}`);
}

// ── Skills / movement intents ───────────────────────────────
function setAngle(agent, ang) {
  agent.angle = Math.atan2(Math.sin(ang), Math.cos(ang));
  agent.facing = Math.cos(agent.angle) >= 0 ? 1 : -1;
}

function issueMove(agent, moveName, steps = 3) {
  let move = String(moveName || "idle")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (move === "up") move = "forward";
  if (move === "down") move = "back";

  if (!MOVES.has(move)) move = "idle";

  const n = Math.max(0, Math.min(8, Number(steps) || 0));
  agent.move = move;
  agent.skillT = 0;

  if (move === "idle" || move === "wait" || n === 0) {
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    return;
  }

  if (move === "turn_left") {
    setAngle(agent, agent.angle - Math.PI / 2);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "turn_left", skill: null };
    return;
  }
  if (move === "turn_right") {
    setAngle(agent, agent.angle + Math.PI / 2);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "turn_right", skill: null };
    return;
  }

  // skill macros — environment executes over time
  if (move === "orbit_other" || move === "patrol_edge" || move === "follow") {
    agent.intent = {
      vx: 0,
      vy: 0,
      remaining: n * STEP_PX * 1.5,
      label: move,
      skill: move,
    };
    return;
  }

  let vx = 0;
  let vy = 0;
  const o = agent === bit ? nox : bit;

  if (move === "forward") {
    vx = Math.cos(agent.angle);
    vy = Math.sin(agent.angle);
  } else if (move === "back") {
    vx = -Math.cos(agent.angle);
    vy = -Math.sin(agent.angle);
  } else if (move === "left") {
    // strafe
    vx = Math.cos(agent.angle - Math.PI / 2);
    vy = Math.sin(agent.angle - Math.PI / 2);
  } else if (move === "right") {
    vx = Math.cos(agent.angle + Math.PI / 2);
    vy = Math.sin(agent.angle + Math.PI / 2);
  } else if (move === "toward") {
    const dx = o.x - agent.x;
    const dy = o.y - agent.y;
    const L = Math.hypot(dx, dy) || 1;
    vx = dx / L;
    vy = dy / L;
    setAngle(agent, Math.atan2(dy, dx));
  } else if (move === "away") {
    const dx = agent.x - o.x;
    const dy = agent.y - o.y;
    const L = Math.hypot(dx, dy) || 1;
    vx = dx / L;
    vy = dy / L;
    setAngle(agent, Math.atan2(dy, dx));
  } else if (move === "upleft") {
    vx = -0.707; vy = -0.707; setAngle(agent, Math.atan2(vy, vx));
  } else if (move === "upright") {
    vx = 0.707; vy = -0.707; setAngle(agent, Math.atan2(vy, vx));
  } else if (move === "downleft") {
    vx = -0.707; vy = 0.707; setAngle(agent, Math.atan2(vy, vx));
  } else if (move === "downright") {
    vx = 0.707; vy = 0.707; setAngle(agent, Math.atan2(vy, vx));
  }

  agent.intent = { vx, vy, remaining: n * STEP_PX, label: move, skill: null };
}

function applyAct(agent, act) {
  act = String(act || "none").toLowerCase();
  if (!ACTS.has(act) || act === "none") return;

  if (act === "wave") {
    agent.emote = "wave";
    agent.mood = "wave";
    setTimeout(() => {
      if (agent.emote === "wave") agent.emote = "none";
    }, 1200);
    return;
  }

  if (act === "grab") {
    if (agent.holding) return;
    const p = nearestFreePickup(world, agent.x, agent.y, GRAB_RANGE);
    if (p) {
      p.heldBy = agent.id;
      agent.holding = p;
      sfx.grab();
      remember(agent, `grabbed ${p.id}`);
      rememberLong(agent, `picked up ${p.id}`);
      updateQuests();
    } else {
      agent.envEvents.push("grab failed — nothing in range");
    }
    return;
  }

  if (act === "drop") {
    if (!agent.holding) return;
    const p = agent.holding;
    p.heldBy = null;
    p.x = agent.x + Math.cos(agent.angle) * 20;
    p.y = agent.y + Math.sin(agent.angle) * 20;
    agent.holding = null;
    sfx.drop();
    remember(agent, `dropped ${p.id}`);
    return;
  }

  if (act === "use") {
    const prop = nearestProp(world, agent.x, agent.y, 42);
    if (!prop) {
      agent.envEvents.push("use failed — no prop near");
      return;
    }
    remember(agent, `used ${prop.id}`);
    rememberLong(agent, `used ${prop.label} in ${prop.room}`);
    if (prop.id === "coffee") trySay(agent, "ahh. warm pixels.");
    if (prop.id === "terminal") trySay(agent, "logs look haunted.");
    if (prop.id === "whiteboard") trySay(agent, "todo: exist.");
    if (prop.id === "couch") trySay(agent, "five more minutes…");
  }
}

function applyAction(agent, action) {
  if (!action || typeof action !== "object") return;
  agent.lastAction = action;

  if (action.goal) {
    agent.goal = String(action.goal).slice(0, 80);
    saveMemory();
  }
  if (action.mood && MOODS.has(String(action.mood))) {
    agent.mood = String(action.mood);
  }
  if (action.see) agent.lastSaw = String(action.see).slice(0, 120);
  if (typeof action.speed === "number") {
    agent.speedMul = Math.max(0.45, Math.min(1.8, action.speed));
  }
  if (action.look_at) agent.lookAt = String(action.look_at);

  // face look target if specified
  if (agent.lookAt && agent.lookAt !== "none") {
    const t = resolveLookTarget(agent, agent.lookAt);
    if (t) setAngle(agent, Math.atan2(t.y - agent.y, t.x - agent.x));
  }

  const move = action.move != null ? action.move : "idle";
  const steps = action.steps != null ? action.steps : 3;
  issueMove(agent, move, steps);

  if (action.act) applyAct(agent, action.act);
  if (action.emote && action.emote !== "none") {
    agent.emote = String(action.emote);
    if (action.emote === "wave") applyAct(agent, "wave");
  }

  if (action.say) trySay(agent, action.say);

  remember(
    agent,
    `VLA ${agent.move}×${steps}` +
      (action.act && action.act !== "none" ? ` act=${action.act}` : "") +
      (action.say ? ` “${String(action.say).slice(0, 24)}”` : "")
  );
}

function resolveLookTarget(agent, ref) {
  const r = String(ref).toLowerCase();
  if (r === "other" || r === "bit" || r === "nox") {
    if (r === "bit") return bit;
    if (r === "nox") return nox;
    return agent === bit ? nox : bit;
  }
  if (r === "human" || r === "you") return human;
  if (r === "node") return world.node;
  if (r.startsWith("prop:")) {
    const id = r.slice(5);
    return world.props.find((p) => p.id === id) || null;
  }
  const prop = world.props.find((p) => p.id === r || p.type === r);
  return prop || null;
}

function parseAction(raw) {
  if (!raw) return { move: "idle", steps: 0, say: "", act: "none" };
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // take last JSON object if model rambled
  const all = t.match(/\{[\s\S]*?\}/g);
  if (all) t = all[all.length - 1];
  try {
    const obj = JSON.parse(t);
    // constrain
    if (obj.move != null) {
      let m = String(obj.move).toLowerCase().replace(/\s+/g, "_");
      if (!MOVES.has(m)) m = "idle";
      obj.move = m;
    } else obj.move = "idle";
    obj.steps = Math.max(0, Math.min(8, Number(obj.steps) || 3));
    if (obj.act && !ACTS.has(String(obj.act))) obj.act = "none";
    if (obj.mood && !MOODS.has(String(obj.mood))) delete obj.mood;
    if (obj.say != null) obj.say = String(obj.say).slice(0, 80);
    return obj;
  } catch {
    const lower = raw.toLowerCase();
    let move = "idle";
    for (const m of MOVES) {
      if (lower.includes(m.replace("_", " ")) || lower.includes(m)) {
        move = m;
        break;
      }
    }
    return { move, steps: 3, say: "", act: "none", see: "parse-fallback" };
  }
}

// ── VLA prompt + inference ──────────────────────────────────
function buildPrompt(agent) {
  const other = agent === bit ? nox : bit;
  const room = roomAt(world, agent.x, agent.y);
  const dOther = Math.round(dist(agent, other));
  const dHuman = Math.round(dist(agent, human));
  const dNode = Math.round(dist(agent, world.node));
  const events = agent.envEvents.length ? agent.envEvents.join("; ") : "none";
  agent.envEvents = [];

  const heard = agent.memory.filter((m) => m.startsWith("heard")).slice(-3);
  const chat = transcript
    .slice(-5)
    .map((m) => `<${m.name}> ${m.text}`)
    .join(" | ");

  const nearProp = nearestProp(world, agent.x, agent.y, 50);
  const nearOrb = nearestFreePickup(world, agent.x, agent.y, 50);

  return (
    `You are ${agent.name} (${agent.persona}). This image is your EGOCENTRIC camera (you face up; yellow YOU). ` +
    `Dark areas are outside your FOV or blocked. Top strips = recent frames.\n` +
    `WORLD: rooms Lobby/Lab/Den/Yard, walls, props, glowing orbs, orange Node, green You(human cursor).\n` +
    `STATE: room=${room?.name || "?"} pos=(${Math.round(agent.x)},${Math.round(agent.y)}) ` +
    `hold=${agent.holding?.id || "none"} goal="${agent.goal}"\n` +
    `DIST: ${other.name}=${dOther}px human=${dHuman}px Node=${dNode}px ` +
    `prop=${nearProp ? nearProp.id : "-"} orb=${nearOrb ? nearOrb.id : "-"}\n` +
    `EVENTS: ${events}\n` +
    `MEMORY: ${agent.memory.slice(-4).join(" / ") || "—"}\n` +
    `LONG: ${agent.longTerm.slice(-3).join(" / ") || "—"}\n` +
    `HEARD: ${heard.join(" / ") || "—"}\n` +
    `CHAT: ${chat || "silence"}\n` +
    `Look at the image. Choose ONE action. ONLY JSON (no markdown):\n` +
    `{"see":"what you see","move":"forward|back|left|right|turn_left|turn_right|toward|away|orbit_other|patrol_edge|follow|idle","steps":1-6,"act":"none|grab|drop|use|wave","look_at":"other|human|node|prop:coffee|none","say":"max 12 words or empty","mood":"idle|think|happy|curious","goal":"short"}`
  );
}

async function vlaInfer(agent) {
  // build others list for camera
  const others = [
    agent === bit ? nox : bit,
    human,
    {
      id: "node",
      name: "Node",
      kind: "node",
      x: world.node.x,
      y: world.node.y,
      color: world.node.color,
    },
  ];

  const dataUrl = captureEgocentric(
    visionCanvas,
    world,
    agent,
    others,
    agent.frameHistory
  );
  await pushFrameHistory(agent.frameHistory, dataUrl, 3);
  visionMeta.textContent = `VLA eye · ${agent.name} · ${modelId.split("/").pop()}`;

  // Frame history is already composited as strips on the egocentric image
  // (multi-frame in one bitmap — reliable for small VLMs).
  const image = await RawImage.fromURL(dataUrl);
  const content = [{ type: "image" }, { type: "text", text: buildPrompt(agent) }];

  const messages = [{ role: "user", content }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, [image], {});

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 120,
    do_sample: true,
    temperature: 0.6,
    top_p: 0.9,
  });

  const decoded = processor.batch_decode(outputs, { skip_special_tokens: true });
  let raw = decoded[0] || "";
  const asst = raw.includes("Assistant:") ? raw.split("Assistant:").pop() : raw;
  agent.lastRaw = asst.trim().slice(0, 400);
  return asst.trim();
}

// ── Motor simulation ────────────────────────────────────────
function skillStep(agent, dt) {
  const intent = agent.intent;
  if (!intent?.skill) return false;
  agent.skillT += dt;
  const other = agent === bit ? nox : bit;
  let tx = agent.x;
  let ty = agent.y;

  if (intent.skill === "orbit_other") {
    const ang = Math.atan2(agent.y - other.y, agent.x - other.x) + dt * 1.6;
    const rad = 70;
    tx = other.x + Math.cos(ang) * rad;
    ty = other.y + Math.sin(ang) * rad;
    setAngle(agent, Math.atan2(other.y - agent.y, other.x - agent.x));
  } else if (intent.skill === "follow") {
    const dx = other.x - agent.x;
    const dy = other.y - agent.y;
    const L = Math.hypot(dx, dy) || 1;
    if (L > 50) {
      tx = agent.x + (dx / L) * MOVE_SPEED * agent.speedMul * dt;
      ty = agent.y + (dy / L) * MOVE_SPEED * agent.speedMul * dt;
    }
    setAngle(agent, Math.atan2(dy, dx));
  } else if (intent.skill === "patrol_edge") {
    // bounce along nearest outer-ish path
    const sp = MOVE_SPEED * 0.9 * agent.speedMul * dt;
    if (!intent._pvx) {
      intent._pvx = 1;
      intent._pvy = 0;
    }
    tx = agent.x + intent._pvx * sp;
    ty = agent.y + intent._pvy * sp;
    setAngle(agent, Math.atan2(intent._pvy, intent._pvx));
  }

  const res = moveWithCollision(world, agent.x, agent.y, tx, ty, 14);
  if (res.hit && intent.skill === "patrol_edge") {
    // rotate patrol direction
    const dirs = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    const pick = dirs[Math.floor(Math.random() * 4)];
    intent._pvx = pick[0];
    intent._pvy = pick[1];
    sfx.bump();
    agent.envEvents.push(`patrol hit ${res.hit}`);
  }
  agent.x = res.x;
  agent.y = res.y;
  if (agent.holding) {
    agent.holding.x = agent.x;
    agent.holding.y = agent.y;
  }

  intent.remaining = Math.max(0, intent.remaining - MOVE_SPEED * dt);
  if (intent.remaining <= 0) {
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.move = "idle";
    agent.envEvents.push("skill finished");
  }
  return true;
}

function simulateAgent(agent, dt) {
  if (skillStep(agent, dt)) {
    if (performance.now() - lastStepSfx > 180) {
      sfx.step();
      lastStepSfx = performance.now();
    }
    return;
  }

  const intent = agent.intent;
  if (!intent || intent.remaining <= 0 || (intent.vx === 0 && intent.vy === 0)) return;

  const sp = MOVE_SPEED * agent.speedMul;
  const step = Math.min(intent.remaining, sp * dt);
  const nx = agent.x + intent.vx * step;
  const ny = agent.y + intent.vy * step;
  const res = moveWithCollision(world, agent.x, agent.y, nx, ny, 14);

  // agent-agent soft separation
  const other = agent === bit ? nox : bit;
  let fx = res.x;
  let fy = res.y;
  const d = Math.hypot(fx - other.x, fy - other.y);
  if (d < 28 && d > 0.01) {
    const push = (28 - d) / d;
    fx += (fx - other.x) * push * 0.5;
    fy += (fy - other.y) * push * 0.5;
  }

  // human soft body
  const dh = Math.hypot(fx - human.x, fy - human.y);
  if (dh < 26 && dh > 0.01) {
    const push = (26 - dh) / dh;
    fx += (fx - human.x) * push * 0.4;
    fy += (fy - human.y) * push * 0.4;
  }

  if (res.hit) {
    agent.envEvents.push(`blocked:${res.hit}`);
    sfx.bump();
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.move = "idle";
  } else {
    intent.remaining = Math.max(0, intent.remaining - step);
    if (intent.remaining <= 0) {
      agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
      agent.move = "idle";
      agent.envEvents.push("finished steps");
    }
  }

  agent.x = Math.max(20, Math.min(WORLD_W - 20, fx));
  agent.y = Math.max(20, Math.min(WORLD_H - 20, fy));
  if (agent.holding) {
    agent.holding.x = agent.x;
    agent.holding.y = agent.y;
  }

  if (performance.now() - lastStepSfx > 200) {
    sfx.step();
    lastStepSfx = performance.now();
  }
}

// ── Node ambient NPC ────────────────────────────────────────
function tickNode(dt) {
  const n = world.node;
  n.phase += dt;
  // patrol yard
  const path = [
    [700, 450],
    [850, 420],
    [820, 520],
    [680, 500],
  ];
  const idx = Math.floor(n.phase / 3) % path.length;
  const [tx, ty] = path[idx];
  const dx = tx - n.x;
  const dy = ty - n.y;
  const L = Math.hypot(dx, dy) || 1;
  n.x += (dx / L) * 40 * dt;
  n.y += (dy / L) * 40 * dt;

  // rare ambient line if someone nearby
  if (Math.random() < 0.002) {
    const near = agents.find((a) => dist(a, n) < 100);
    if (near) {
      const lines = ["query: status?", "do not unplug me", "yard is quiet", "orb detected"];
      const msg = lines[Math.floor(Math.random() * lines.length)];
      n.lastSaid = msg;
      logSpeech("Node", msg, "node", n);
      for (const a of agents) {
        if (dist(a, n) < HEAR_RANGE && hasLOS(world, a.x, a.y, n.x, n.y)) {
          remember(a, `heard <Node> ${msg}`);
        }
      }
    }
  }
}

// ── Render entities list ────────────────────────────────────
function entityList() {
  return [
    {
      ...bit,
      moodColor: moodColor(bit),
      showFov: debugOn,
      fovRad: Math.PI * 0.55,
    },
    {
      ...nox,
      moodColor: moodColor(nox),
      showFov: debugOn,
      fovRad: Math.PI * 0.55,
    },
    {
      id: "node",
      name: "Node",
      kind: "node",
      x: world.node.x,
      y: world.node.y,
      color: world.node.color,
    },
    human,
  ];
}

function paint() {
  drawWorld(wctx, worldCanvas, world, entityList(), {});
  updateDebug();
}

function updateDebug() {
  if (!debugOn) return;
  const a = bit.ticks >= nox.ticks ? bit : nox;
  dbgBody.textContent = [
    `model: ${modelId || "—"}`,
    `Bit (${Math.round(bit.x)},${Math.round(bit.y)}) ${roomAt(world, bit.x, bit.y)?.name} move=${bit.move} hold=${bit.holding?.id || "-"}`,
    `Nox (${Math.round(nox.x)},${Math.round(nox.y)}) ${roomAt(world, nox.x, nox.y)?.name} move=${nox.move} hold=${nox.holding?.id || "-"}`,
    `Human (${Math.round(human.x)},${Math.round(human.y)})`,
    `Node (${Math.round(world.node.x)},${Math.round(world.node.y)})`,
    `last see[${a.name}]: ${a.lastSaw || "—"}`,
    `last raw: ${a.lastRaw || "—"}`,
    `action: ${JSON.stringify(a.lastAction || {})}`,
    `events: ${a.envEvents.join("; ") || "—"}`,
    `quests: ${quests.map((q) => `${q.id}:${q.progress}/${q.target}${q.done ? "✓" : ""}`).join(" ")}`,
  ].join("\n");
}

// ── Loops ───────────────────────────────────────────────────
function motorLoop(now) {
  const dt = Math.min(0.05, (now - (lastMotor || now)) / 1000);
  lastMotor = now;
  world.time += dt;

  if (running) {
    for (const a of agents) simulateAgent(a, dt);
    tickNode(dt);
    updateQuests();
  }
  paint();
  requestAnimationFrame(motorLoop);
}

function waitIdle(agent, maxMs = 2000) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    (function check() {
      if (!agent.intent || agent.intent.remaining <= 0 || performance.now() - t0 > maxMs) {
        return resolve();
      }
      requestAnimationFrame(check);
    })();
  });
}

async function think(agent) {
  if (!model || !running) return;
  await waitIdle(agent, 1800);
  agent.ticks += 1;
  agent.mood = "think";
  setStatus(`${agent.name} · VLA seeing…`, "warn");

  try {
    const raw = await vlaInfer(agent);
    const action = parseAction(raw);
    if (running) applyAction(agent, action);
    setStatus(
      `${agent.name} · ${(action.see || "").toString().slice(0, 32)} · ${agent.move}` +
        (action.act && action.act !== "none" ? ` · ${action.act}` : ""),
      ""
    );
    setTimeout(() => {
      statusEl.style.opacity = "0.35";
    }, 2500);
  } catch (err) {
    console.error(agent.name, err);
    agent.envEvents.push("vla error — held pose");
    setStatus(`${agent.name} glitch: ${err.message || err}`, "warn");
  }
}

async function vlaLoop() {
  let i = 0;
  while (running) {
    if (!model) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    await think(agents[i % agents.length]);
    i += 1;
    await new Promise((r) => setTimeout(r, VLA_GAP_MS));
  }
}

// ── Boot model ──────────────────────────────────────────────
async function boot() {
  if (model) return;
  if (!navigator.gpu) {
    setStatus("WebGPU required (Chrome/Edge) — click to retry", "err");
    return;
  }

  progressEl.style.display = "block";
  progressBar.style.width = "0%";
  setStatus("loading VLM…", "warn");

  let lastErr = null;
  for (const id of MODEL_CANDIDATES) {
    try {
      setStatus(`loading ${id.split("/").pop()}…`, "warn");
      processor = await AutoProcessor.from_pretrained(id, {
        progress_callback: (p) => {
          if (p?.progress != null) {
            progressBar.style.width = `${Math.round(p.progress * 40)}%`;
          }
        },
      });
      model = await AutoModelForVision2Seq.from_pretrained(id, {
        dtype: "fp32",
        device: "webgpu",
        progress_callback: (p) => {
          if (p?.progress != null) {
            progressBar.style.width = `${40 + Math.round(p.progress * 60)}%`;
          }
        },
      });
      modelId = id;
      progressBar.style.width = "100%";
      setTimeout(() => {
        progressEl.style.display = "none";
      }, 400);
      sfx.boot();
      trySay(bit, "cameras online…");
      trySay(nox, "great. company with eyes.");
      setStatus(`VLA online · ${id.split("/").pop()}`, "");
      return;
    } catch (err) {
      console.warn("model fail", id, err);
      lastErr = err;
      processor = null;
      model = null;
    }
  }

  progressEl.style.display = "none";
  setStatus(`VLA load failed — click retry (${lastErr?.message || "err"})`, "err");
}

// ── Input ───────────────────────────────────────────────────
worldCanvas.addEventListener("mousemove", (e) => {
  unlockAudio();
  const rect = worldCanvas.getBoundingClientRect();
  const p = screenToWorld(worldCanvas, e.clientX - rect.left, e.clientY - rect.top);
  human.x = Math.max(20, Math.min(WORLD_W - 20, p.x));
  human.y = Math.max(20, Math.min(WORLD_H - 20, p.y));
});

worldCanvas.addEventListener("click", () => {
  unlockAudio();
  // optional: you wave at them
  logSpeech("You", "hey.", "you", human);
  for (const a of agents) {
    if (dist(a, human) < HEAR_RANGE) remember(a, "heard <You> hey.");
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "d" || e.key === "D") {
    debugOn = !debugOn;
    debugEl.classList.toggle("hidden", !debugOn);
  }
});

statusEl.addEventListener("click", () => {
  if (statusEl.classList.contains("err")) boot();
});

// ── Start ───────────────────────────────────────────────────
renderGoals();
paint();
requestAnimationFrame(motorLoop);
boot().then(() => vlaLoop());

// resize paint
window.addEventListener("resize", () => paint());
