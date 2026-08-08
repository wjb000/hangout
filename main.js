/**
 * Hangout — pure AI social sim
 * Bit & Nox live in a small world. No missions. No orbs.
 */
import {
  AutoProcessor,
  AutoModelForVision2Seq,
  RawImage,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1";

import { sfx, unlockAudio, setListener } from "./audio.js";
import {
  createWorld,
  roomAt,
  moveWithCollision,
  hasLOS,
  dist,
  nearestProp,
  screenToWorld,
  drawWorld,
  drawMinimap,
  spawnParticle,
  spawnFlash,
  tickFX,
  WORLD_W,
  WORLD_H,
} from "./world.js";
import {
  captureEgocentric,
  pushFrameHistory,
  visibleTruth,
  truthToString,
  scoreSee,
} from "./vision.js";
import { hybridDecide, planFromTruth } from "./planner.js";
import { setNavTo, clearNav, followNav } from "./pathfind.js";

const MODEL_CANDIDATES = [
  "HuggingFaceTB/SmolVLM-256M-Instruct",
  "HuggingFaceTB/SmolVLM-500M-Instruct",
];
const MOVE_SPEED = 118;
const HEAR_RANGE = 170;
const VLA_GAP_MS = 140;
const MEMORY_KEY = "hangout_social_v1";
const CHAT_MAX = 18;
const CHAT_FADE_MS = 14000;
const MAX_RETRIES = 1;

const MOVES = new Set([
  "forward", "back", "left", "right", "turn_left", "turn_right",
  "toward", "away", "idle", "wait", "nav",
  "orbit_other", "patrol_edge", "follow", "follow_human", "goto_beacon",
  "up", "down", "upleft", "upright", "downleft", "downright",
]);
const ACTS = new Set(["none", "use", "wave"]);
const MOODS = new Set(["idle", "think", "happy", "curious", "wave"]);

let brainMode = "hybrid";

// DOM
const worldCanvas = document.getElementById("world");
const visionCanvas = document.getElementById("vision");
const visionMeta = document.getElementById("vision-meta");
const minimapCanvas = document.getElementById("minimap");
const chatlog = document.getElementById("chatlog");
const statusEl = document.getElementById("status");
const relBar = document.getElementById("rel-bar");
const progressEl = document.getElementById("progress");
const progressBar = progressEl?.querySelector("i");
const debugEl = document.getElementById("debug");
const dbgBody = document.getElementById("dbg-body");
const toastsEl = document.getElementById("toasts");
const brainModeEl = document.getElementById("brain-mode");
const objectiveEl = document.getElementById("objective");

const wctx = worldCanvas.getContext("2d");
const mctx = minimapCanvas.getContext("2d");

let world = createWorld();
let processor = null;
let model = null;
let modelId = "";
let running = true;
let debugOn = false;
let lastMotor = 0;
let lastStepSfx = { bit: 0, nox: 0 };
let callPulse = 0;
let juice = 0;
let spectator = true;
let cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1.08, tx: WORLD_W / 2, ty: WORLD_H / 2, tz: 1.08 };

const transcript = [];

const human = {
  id: "you",
  name: "You",
  kind: "human",
  x: WORLD_W / 2,
  y: WORLD_H / 2 + 40,
  color: "#55ff88",
  headColor: "#c8ffe0",
  nameColor: "#6f6",
  angle: -Math.PI / 2,
  facing: 1,
  walkPhase: 0,
  moving: false,
  lastSaid: "",
  path: [],
  assign: null,
  thought: "",
  thoughtT: 0,
};

const relations = { bit_nox: 0.15, bit_you: 0.05, nox_you: 0 };

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
    lastTruth: "",
    seeScore: 0,
    hybrid: "",
    speedMul: 1,
    ticks: 0,
    memory: [],
    longTerm: [],
    envEvents: [],
    holding: null,
    frameHistory: [],
    lastAction: null,
    lastRaw: "",
    skillT: 0,
    walkPhase: 0,
    moving: false,
    navPath: null,
    navIndex: 0,
    thought: "",
    thoughtT: 0,
    _lastRoom: null,
  };
}

const bit = createAgent({
  id: "bit",
  name: "Bit",
  cssClass: "bit",
  color: "#6ec6ff",
  headColor: "#b8e4ff",
  nameColor: "#6ec6ff",
  persona: "optimistic cyan glitch; warm, curious, likes company and coffee",
  x: 180,
  y: 180,
  angle: 0.3,
  goal: "hang with Nox and explore",
});

const nox = createAgent({
  id: "nox",
  name: "Nox",
  cssClass: "nox",
  color: "#ff7a6e",
  headColor: "#ffc4bc",
  nameColor: "#ff7a6e",
  persona: "dry coral glitch; sharp, low-key affectionate, maps rooms",
  x: 760,
  y: 200,
  angle: Math.PI,
  goal: "pretend not to care while staying near Bit",
});

const agents = [bit, nox];

// ── Memory ──────────────────────────────────────────────────
function loadMemory() {
  try {
    const data = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
    if (data.relations) Object.assign(relations, data.relations);
    if (data.brainMode) brainMode = data.brainMode;
    for (const a of agents) {
      if (data[a.id]?.longTerm) a.longTerm = data[a.id].longTerm.slice(-14);
    }
  } catch { /* */ }
}
function saveMemory() {
  try {
    const data = { relations: { ...relations }, brainMode };
    for (const a of agents) data[a.id] = { longTerm: a.longTerm.slice(-14) };
    localStorage.setItem(MEMORY_KEY, JSON.stringify(data));
  } catch { /* */ }
}
loadMemory();

// ── UI ──────────────────────────────────────────────────────
function setStatus(t, kind = "") {
  statusEl.textContent = t;
  statusEl.className = kind;
  statusEl.style.opacity = "1";
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toastsEl.appendChild(el);
  setTimeout(() => el.classList.add("fade"), 2000);
  setTimeout(() => el.remove(), 2800);
}
function juicePop(a = 0.4) {
  juice = Math.max(juice, a);
}
function updateBrainLabel() {
  if (brainModeEl) brainModeEl.textContent = `brain: ${brainMode}`;
}
function renderRelations() {
  const f = (v) => (v > 0.35 ? "♥" : v < -0.2 ? "💢" : "·");
  if (relBar) {
    relBar.textContent =
      `Bit↔Nox ${f(relations.bit_nox)} ${relations.bit_nox.toFixed(2)}   ` +
      `you ${f(relations.bit_you)}/${f(relations.nox_you)}`;
  }
}
function updateObjective() {
  if (!objectiveEl) return;
  const rb = roomAt(world, bit.x, bit.y)?.name || "?";
  const rn = roomAt(world, nox.x, nox.y)?.name || "?";
  const d = Math.round(dist(bit, nox));
  objectiveEl.textContent =
    `▸ Bit @ ${rb} · Nox @ ${rn} · ${d}px apart · ${bit.move}/${nox.move}`;
}
function setThought(agent, text) {
  if (!text) return;
  agent.thought = String(text).slice(0, 8).toUpperCase();
  agent.thoughtT = 1.0;
}
function remember(a, line) {
  a.memory.push(line);
  if (a.memory.length > 8) a.memory.shift();
}
function rememberLong(a, line) {
  if (!line || a.longTerm[a.longTerm.length - 1] === line) return;
  a.longTerm.push(line);
  if (a.longTerm.length > 14) a.longTerm.shift();
  saveMemory();
}
function moodColor(a) {
  if (a.mood === "think") return "#c9a0ff";
  if (a.mood === "happy" || a.mood === "wave") return "#7dffb3";
  if (a.mood === "curious") return "#ffe08a";
  return a.color;
}
function bumpRelation(key, delta) {
  if (!(key in relations)) return;
  relations[key] = Math.max(-1, Math.min(1, relations[key] + delta));
  saveMemory();
  renderRelations();
}

function logSpeech(name, text, cssClass, pos = null) {
  const msg = String(text || "").trim();
  if (!msg) return;
  transcript.push({ name, text: msg, t: Date.now(), x: pos?.x, y: pos?.y });
  if (transcript.length > 24) transcript.shift();
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML = `<span class="${cssClass}">&lt;${escapeHtml(name)}&gt;</span> ${escapeHtml(msg)}`;
  chatlog.appendChild(line);
  while (chatlog.children.length > CHAT_MAX) chatlog.removeChild(chatlog.firstChild);
  setTimeout(() => line.classList.add("fade"), CHAT_FADE_MS);
  setTimeout(() => line.remove(), CHAT_FADE_MS + 1200);
  sfx.talk(cssClass, pos?.x, pos?.y, false);
}

function trySay(agent, text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  agent.lastSaid = msg.slice(0, 100);
  logSpeech(agent.name, agent.lastSaid, agent.cssClass, agent);
  for (const other of agents) {
    if (other.id === agent.id) continue;
    if (dist(agent, other) > HEAR_RANGE) continue;
    if (!hasLOS(world, agent.x, agent.y, other.x, other.y)) continue;
    remember(other, `heard <${agent.name}> ${msg.slice(0, 40)}`);
    if (/hey|hi|like|love|thanks|warm|cozy|friend/i.test(msg)) bumpRelation("bit_nox", 0.03);
    if (/hate|shut|leave|annoying/i.test(msg)) bumpRelation("bit_nox", -0.05);
  }
  if (dist(agent, human) < HEAR_RANGE) {
    const key = agent.id === "bit" ? "bit_you" : "nox_you";
    if (/hi|hey|you|human/i.test(msg)) bumpRelation(key, 0.04);
  }
  rememberLong(agent, `said: ${msg.slice(0, 48)}`);
}

// ── Movement ────────────────────────────────────────────────
function setAngle(agent, ang) {
  agent.angle = Math.atan2(Math.sin(ang), Math.cos(ang));
  agent.facing = Math.cos(agent.angle) >= 0 ? 1 : -1;
}

function issueMove(agent, moveName, steps = 3, faceAng = null) {
  let move = String(moveName || "idle").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (move === "up") move = "forward";
  if (move === "down") move = "back";
  if (!MOVES.has(move)) move = "idle";
  if (faceAng != null) setAngle(agent, faceAng);
  const n = Math.max(0, Math.min(8, Number(steps) || 0));
  agent.move = move;

  if (move === "idle" || move === "wait" || n === 0) {
    if (move === "turn_left") setAngle(agent, agent.angle - Math.PI / 2);
    if (move === "turn_right") setAngle(agent, agent.angle + Math.PI / 2);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: move, skill: null };
    agent.moving = false;
    return;
  }
  if (move === "turn_left") {
    setAngle(agent, agent.angle - Math.PI / 2);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: move, skill: null };
    return;
  }
  if (move === "turn_right") {
    setAngle(agent, agent.angle + Math.PI / 2);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: move, skill: null };
    return;
  }
  if (["orbit_other", "patrol_edge", "follow", "follow_human", "goto_beacon"].includes(move)) {
    agent.intent = { vx: 0, vy: 0, remaining: n * 40 * 1.4, label: move, skill: move };
    agent.moving = true;
    return;
  }

  let vx = 0;
  let vy = 0;
  const o = agent === bit ? nox : bit;
  if (move === "forward") {
    vx = Math.cos(agent.angle); vy = Math.sin(agent.angle);
  } else if (move === "back") {
    vx = -Math.cos(agent.angle); vy = -Math.sin(agent.angle);
  } else if (move === "left") {
    vx = Math.cos(agent.angle - Math.PI / 2); vy = Math.sin(agent.angle - Math.PI / 2);
  } else if (move === "right") {
    vx = Math.cos(agent.angle + Math.PI / 2); vy = Math.sin(agent.angle + Math.PI / 2);
  } else if (move === "toward") {
    const dx = o.x - agent.x; const dy = o.y - agent.y;
    const L = Math.hypot(dx, dy) || 1;
    vx = dx / L; vy = dy / L;
    setAngle(agent, Math.atan2(dy, dx));
  } else if (move === "away") {
    const dx = agent.x - o.x; const dy = agent.y - o.y;
    const L = Math.hypot(dx, dy) || 1;
    vx = dx / L; vy = dy / L;
    setAngle(agent, Math.atan2(dy, dx));
  }
  agent.intent = { vx, vy, remaining: n * 40, label: move, skill: null };
  agent.moving = true;
}

function applyAct(agent, act) {
  act = String(act || "none").toLowerCase();
  if (!ACTS.has(act) || act === "none") return;
  if (act === "wave") {
    agent.emote = "wave";
    agent.mood = "wave";
    spawnParticle(world, agent.x, agent.y - 10, "#ff8", 5);
    setTimeout(() => { if (agent.emote === "wave") agent.emote = "none"; }, 1000);
    return;
  }
  if (act === "use") {
    const prop = nearestProp(world, agent.x, agent.y, 46);
    if (!prop) {
      agent.envEvents.push("nothing to use");
      return;
    }
    sfx.success(agent.x, agent.y);
    spawnParticle(world, prop.x, prop.y, "#ff5", 8);
    juicePop(0.25);
    remember(agent, `used ${prop.id}`);
    rememberLong(agent, `used ${prop.label || prop.id}`);
    if (prop.id === "coffee" && !agent.lastSaid) trySay(agent, agent.id === "bit" ? "warm~" : "hm.");
    if (prop.id === "couch") trySay(agent, agent.id === "bit" ? "comfy!" : "…fine");
  }
}

function applyAction(agent, action) {
  if (!action) return;
  agent.lastAction = action;
  agent.hybrid = action._hybrid || action._src || "";
  if (action.goal) agent.goal = String(action.goal).slice(0, 80);
  if (action.mood && MOODS.has(String(action.mood))) agent.mood = String(action.mood);
  if (action.see) agent.lastSaw = String(action.see).slice(0, 120);

  if (action.thought) setThought(agent, action.thought);
  else if (action.say) setThought(agent, "CHAT");
  else if (action._nav) setThought(agent, "GO");
  else if (action.move && action.move !== "idle") setThought(agent, action.move.slice(0, 6));

  const face = action._face != null ? action._face : null;
  if (face != null) setAngle(agent, face);

  if (action._nav && action._nav.x != null) {
    clearNav(agent);
    setNavTo(world, agent, action._nav.x, action._nav.y);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "nav", skill: null };
  } else if (action.move === "toward") {
    const o = agent === bit ? nox : bit;
    setNavTo(world, agent, o.x, o.y);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "nav", skill: null };
  } else if (action.move === "follow_human") {
    setNavTo(world, agent, human.x, human.y);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "nav", skill: null };
  } else if (action.move === "goto_beacon" && world.beacon) {
    setNavTo(world, agent, world.beacon.x, world.beacon.y);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "nav", skill: null };
  } else {
    clearNav(agent);
    issueMove(agent, action.move || "idle", action.steps ?? 3, face);
  }

  if (action.act) applyAct(agent, action.act);
  if (action.say) trySay(agent, action.say);
  remember(agent, `${agent.hybrid || "?"} ${agent.move}`);
}

function parseAction(raw) {
  if (!raw) return null;
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const all = t.match(/\{[\s\S]*?\}/g);
  if (all) t = all[all.length - 1];
  try {
    const obj = JSON.parse(t);
    if (obj.move != null) {
      let m = String(obj.move).toLowerCase().replace(/\s+/g, "_");
      if (!MOVES.has(m)) m = "idle";
      obj.move = m;
    } else obj.move = "idle";
    obj.steps = Math.max(0, Math.min(8, Number(obj.steps) || 3));
    if (obj.act && !ACTS.has(String(obj.act))) obj.act = "none";
    // strip grab/drop if model still invents them
    if (obj.act === "grab" || obj.act === "drop") obj.act = "none";
    return obj;
  } catch {
    return null;
  }
}

function othersFor(agent) {
  return [
    agent === bit ? nox : bit,
    human,
    { id: "node", name: "Node", kind: "node", x: world.node.x, y: world.node.y, color: world.node.color },
  ];
}

function plannerCtx(agent) {
  return {
    callPulse,
    forceHeuristic: brainMode === "heuristic",
    heuristicOnly: brainMode === "heuristic",
    assignTarget: human.assign,
    rel: relations.bit_nox,
  };
}

function buildPrompt(agent, truth) {
  const top = [];
  truth.entities.slice(0, 2).forEach((e) => top.push(`${e.name}@${e.d}`));
  truth.props.slice(0, 2).forEach((p) => top.push(p.id));
  const other = agent === bit ? nox : bit;
  const chat = transcript.slice(-4).map((m) => `<${m.name}> ${m.text}`).join(" | ");

  return (
    `You are ${agent.name} (${agent.persona}). Social hangout — no games, no orbs. Live with ${other.name}.\n` +
    `Camera faces UP. Yellow=YOU.\n` +
    `VISIBLE: ${top.join(", ") || "empty"} · room=${truth.room}\n` +
    `partner@${Math.round(dist(agent, other))}px said="${other.lastSaid || ""}" rel=${relations.bit_nox.toFixed(2)}\n` +
    `CHAT: ${chat || "silence"}\n` +
    `MEM: ${agent.memory.slice(-3).join(" / ") || "—"}\n` +
    `JSON only: {"see":"brief","move":"nav|toward|orbit_other|follow_human|idle","steps":2-5,"act":"none|wave|use","say":"max 10 words or empty","mood":"curious|happy|think","thought":"CHAT|GO|HI"}`
  );
}

async function localVlmInfer(dataUrl, prompt) {
  const image = await RawImage.fromURL(dataUrl);
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, [image], {});
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 80,
    do_sample: true,
    temperature: 0.55,
    top_p: 0.9,
  });
  const decoded = processor.batch_decode(outputs, { skip_special_tokens: true });
  let raw = decoded[0] || "";
  if (raw.includes("Assistant:")) raw = raw.split("Assistant:").pop();
  return raw.trim();
}

async function remoteVlmInfer(dataUrl, prompt) {
  const cfg = window.HANGOUT_VLM;
  if (!cfg?.baseUrl || !cfg?.apiKey) return null;
  const res = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model || "grok-2-vision-1212",
      max_tokens: 100,
      temperature: 0.5,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`remote ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function decideAction(agent) {
  const other = agent === bit ? nox : bit;
  const others = othersFor(agent);
  const truth = visibleTruth(world, agent, others);
  const slim = {
    room: truth.room,
    entities: truth.entities.slice(0, 2),
    props: truth.props.slice(0, 2),
    orbs: [],
  };
  agent.lastTruth = truthToString(slim);
  const ctx = plannerCtx(agent);

  if (brainMode === "heuristic" || !model || model.heuristic) {
    agent.seeScore = 1;
    return hybridDecide(null, 0, agent, other, human, world, { ...ctx, forceHeuristic: true });
  }

  const dataUrl = captureEgocentric(visionCanvas, world, agent, others, agent.frameHistory);
  await pushFrameHistory(agent.frameHistory, dataUrl, 2);
  visionMeta.textContent = `${agent.name} · ${agent.hybrid || brainMode}`;

  let vlmAction = null;
  let raw = "";
  const prompt = buildPrompt(agent, slim);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (window.HANGOUT_VLM?.apiKey) raw = (await remoteVlmInfer(dataUrl, prompt)) || "";
      if (!raw && processor && model && !model.remoteOnly) raw = await localVlmInfer(dataUrl, prompt);
      if (!raw) break;
      agent.lastRaw = raw.slice(0, 280);
      vlmAction = parseAction(raw);
      if (vlmAction) break;
    } catch (err) {
      if (attempt === MAX_RETRIES) console.warn(err);
    }
  }

  const seeScore = vlmAction ? scoreSee(vlmAction.see, slim) : 0;
  agent.seeScore = seeScore;
  if (vlmAction) agent.lastSaw = vlmAction.see || "";
  return hybridDecide(vlmAction, seeScore, agent, other, human, world, ctx);
}

// ── Sim ─────────────────────────────────────────────────────
function skillStep(agent, dt) {
  const intent = agent.intent;
  if (!intent?.skill) return false;
  const other = agent === bit ? nox : bit;
  const sp = MOVE_SPEED * agent.speedMul * dt;
  let tx = agent.x;
  let ty = agent.y;
  const aim = (x, y, stopD = 48) => {
    const dx = x - agent.x;
    const dy = y - agent.y;
    const L = Math.hypot(dx, dy) || 1;
    if (L > stopD) {
      tx = agent.x + (dx / L) * sp;
      ty = agent.y + (dy / L) * sp;
    }
    setAngle(agent, Math.atan2(dy, dx));
  };

  if (intent.skill === "orbit_other") {
    const ang = Math.atan2(agent.y - other.y, agent.x - other.x) + dt * 1.5;
    tx = other.x + Math.cos(ang) * 72;
    ty = other.y + Math.sin(ang) * 72;
    setAngle(agent, Math.atan2(other.y - agent.y, other.x - agent.x));
  } else if (intent.skill === "follow") aim(other.x, other.y);
  else if (intent.skill === "follow_human") aim(human.x, human.y, 42);
  else if (intent.skill === "goto_beacon" && world.beacon) aim(world.beacon.x, world.beacon.y, 28);
  else if (intent.skill === "patrol_edge") {
    if (!intent._pvx) { intent._pvx = 1; intent._pvy = 0; }
    tx = agent.x + intent._pvx * sp;
    ty = agent.y + intent._pvy * sp;
  } else return false;

  const res = moveWithCollision(world, agent.x, agent.y, tx, ty, 14);
  if (res.hit) {
    sfx.bump(agent.x, agent.y);
    if (intent.skill === "patrol_edge") {
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      const p = dirs[Math.floor(Math.random() * 4)];
      intent._pvx = p[0]; intent._pvy = p[1];
    }
  }
  agent.x = res.x; agent.y = res.y;
  agent.walkPhase += dt * 14;
  agent.moving = true;
  intent.remaining = Math.max(0, intent.remaining - MOVE_SPEED * dt);
  if (intent.remaining <= 0) {
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.move = "idle";
    agent.moving = false;
  }
  return true;
}

function simulateAgent(agent, dt) {
  if (agent.thoughtT > 0) agent.thoughtT -= dt;

  if (agent.navPath && agent.navPath.length) {
    const still = followNav(world, agent, dt, MOVE_SPEED * agent.speedMul, moveWithCollision);
    if (still) { stepSfx(agent); return; }
  }
  if (skillStep(agent, dt)) { stepSfx(agent); return; }

  const intent = agent.intent;
  if (!intent || intent.remaining <= 0 || (intent.vx === 0 && intent.vy === 0)) {
    agent.moving = false;
    return;
  }
  const step = Math.min(intent.remaining, MOVE_SPEED * agent.speedMul * dt);
  const res = moveWithCollision(
    world, agent.x, agent.y,
    agent.x + intent.vx * step, agent.y + intent.vy * step, 14
  );
  let fx = res.x; let fy = res.y;
  for (const o of [agent === bit ? nox : bit, human]) {
    const d = Math.hypot(fx - o.x, fy - o.y);
    const minD = o.kind === "human" ? 26 : 30;
    if (d < minD && d > 0.01) {
      const push = (minD - d) / d;
      fx += (fx - o.x) * push * 0.45;
      fy += (fy - o.y) * push * 0.45;
    }
  }
  if (res.hit) {
    sfx.bump(agent.x, agent.y);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.moving = false;
    agent.move = "idle";
  } else {
    intent.remaining -= step;
    agent.moving = intent.remaining > 0;
    agent.walkPhase += dt * 14;
    if (intent.remaining <= 0) {
      agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
      agent.move = "idle";
    }
  }
  agent.x = Math.max(20, Math.min(WORLD_W - 20, fx));
  agent.y = Math.max(20, Math.min(WORLD_H - 20, fy));
  stepSfx(agent);
}

function stepSfx(agent) {
  const now = performance.now();
  if (now - (lastStepSfx[agent.id] || 0) > 200) {
    const muted = !hasLOS(world, agent.x, agent.y, human.x, human.y);
    sfx.step(agent.x, agent.y, muted);
    lastStepSfx[agent.id] = now;
  }
}

function simulateHuman(dt) {
  if (human.thoughtT > 0) human.thoughtT -= dt;
  if (human.path.length) {
    const t = human.path[0];
    const dx = t.x - human.x;
    const dy = t.y - human.y;
    const L = Math.hypot(dx, dy) || 1;
    if (L < 10) human.path.shift();
    else {
      const res = moveWithCollision(
        world, human.x, human.y,
        human.x + (dx / L) * 160 * dt, human.y + (dy / L) * 160 * dt, 12
      );
      human.x = res.x; human.y = res.y;
      human.angle = Math.atan2(dy, dx);
      human.facing = Math.cos(human.angle) >= 0 ? 1 : -1;
      human.walkPhase += dt * 14;
      human.moving = true;
    }
  } else human.moving = false;
}

function tickNode(dt) {
  const n = world.node;
  n.phase += dt;
  const path = [[700, 450], [850, 420], [820, 520], [680, 500]];
  const [tx, ty] = path[Math.floor(n.phase / 4) % path.length];
  const dx = tx - n.x; const dy = ty - n.y;
  const L = Math.hypot(dx, dy) || 1;
  n.x += (dx / L) * 36 * dt;
  n.y += (dy / L) * 36 * dt;
  if (Math.random() < 0.0012) {
    if (agents.some((a) => dist(a, n) < 120)) {
      const lines = ["systems nominal", "void stable", "do not unplug", "observing…"];
      logSpeech("Node", lines[Math.floor(Math.random() * lines.length)], "node", n);
    }
  }
}

function ambientRoomFX(dt) {
  // soft room dust / steam
  if (Math.random() < 0.08) {
    const r = world.rooms[Math.floor(Math.random() * world.rooms.length)];
    const x = r.x + Math.random() * r.w;
    const y = r.y + Math.random() * r.h;
    world.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 12,
      vy: -8 - Math.random() * 16,
      life: 0.8 + Math.random() * 0.8,
      color: r.accent || "#668",
      size: 1.5 + Math.random() * 2,
    });
  }
}

function updateCamera(dt) {
  if (spectator) {
    cam.tx = (bit.x + nox.x) / 2;
    cam.ty = (bit.y + nox.y) / 2;
    const d = dist(bit, nox);
    cam.tz = d < 100 ? 1.4 : d < 220 ? 1.15 : 1.05;
  } else {
    cam.tx = WORLD_W / 2;
    cam.ty = WORLD_H / 2;
    cam.tz = 1;
  }
  cam.x += (cam.tx - cam.x) * Math.min(1, dt * 2.8);
  cam.y += (cam.ty - cam.y) * Math.min(1, dt * 2.8);
  cam.zoom += (cam.tz - cam.zoom) * Math.min(1, dt * 2);
}

function entityList() {
  return [
    {
      ...bit,
      moodColor: moodColor(bit),
      showFov: debugOn,
      fovRad: Math.PI * 0.55,
      thought: bit.thoughtT > 0 ? bit.thought : "",
    },
    {
      ...nox,
      moodColor: moodColor(nox),
      showFov: debugOn,
      fovRad: Math.PI * 0.55,
      thought: nox.thoughtT > 0 ? nox.thought : "",
    },
    { id: "node", name: "Node", kind: "node", x: world.node.x, y: world.node.y, color: world.node.color },
    { ...human, thought: human.thoughtT > 0 ? human.thought : "" },
  ];
}

function socialLines() {
  // soft line between Bit and Nox when far
  if (dist(bit, nox) > 90) {
    return [{
      x0: bit.x, y0: bit.y, x1: nox.x, y1: nox.y,
      color: "rgba(180,160,255,0.2)",
    }];
  }
  return [];
}

function paint() {
  const camOpt = spectator ? { x: cam.x, y: cam.y, zoom: cam.zoom } : null;
  drawWorld(wctx, worldCanvas, world, entityList(), {
    camera: camOpt,
    targetLines: socialLines(),
    path: human.path,
  });
  if (juice > 0) {
    wctx.save();
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.fillStyle = `rgba(160,200,255,${juice * 0.12})`;
    wctx.fillRect(0, 0, worldCanvas.width, worldCanvas.height);
    wctx.restore();
  }
  mctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  drawMinimap(mctx, 0, 0, minimapCanvas.width, minimapCanvas.height, world, entityList());
  updateObjective();
  if (debugOn && dbgBody) {
    dbgBody.textContent = [
      `brain=${brainMode}  model=${modelId || "—"}`,
      `Bit (${Math.round(bit.x)},${Math.round(bit.y)}) ${roomAt(world, bit.x, bit.y)?.name} ${bit.move} ${bit.hybrid}`,
      `Nox (${Math.round(nox.x)},${Math.round(nox.y)}) ${roomAt(world, nox.x, nox.y)?.name} ${nox.move} ${nox.hybrid}`,
      `rel bit_nox=${relations.bit_nox.toFixed(2)}`,
      `truth: ${bit.lastTruth || "—"}`,
      `raw: ${bit.lastRaw || "—"}`,
    ].join("\n");
  }
}

function roomEnterToast() {
  for (const a of agents) {
    const r = roomAt(world, a.x, a.y);
    if (r && a._lastRoom !== r.id) {
      if (a._lastRoom) toast(`${a.name} → ${r.name}`);
      a._lastRoom = r.id;
    }
  }
}

// ── Loops ───────────────────────────────────────────────────
function motorLoop(now) {
  let dt = Math.min(0.05, (now - (lastMotor || now)) / 1000);
  lastMotor = now;
  if (juice > 0) juice = Math.max(0, juice - dt * 1.6);
  world.time += dt;
  updateCamera(dt);

  if (running) {
    if (callPulse > 0) callPulse -= dt;
    for (const a of agents) simulateAgent(a, dt);
    simulateHuman(dt);
    tickNode(dt);
    tickFX(world, dt);
    ambientRoomFX(dt);
    setListener(human.x, human.y);
    roomEnterToast();
    renderRelations();
  }
  paint();
  requestAnimationFrame(motorLoop);
}

async function think(agent) {
  if (!running) return;
  agent.ticks += 1;
  agent.mood = "think";
  setStatus(`${agent.name} · ${brainMode}…`, "warn");
  try {
    const action = await decideAction(agent);
    if (running) applyAction(agent, action);
    setStatus(`${agent.name} · ${agent.hybrid || brainMode} · ${agent.move}`, "");
    setTimeout(() => { statusEl.style.opacity = "0.35"; }, 1600);
  } catch (err) {
    console.error(err);
    applyAction(agent, planFromTruth(agent, agent === bit ? nox : bit, human, world, plannerCtx(agent)));
  }
}

async function vlaLoop() {
  let i = 0;
  while (true) {
    if (!running) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (!model) {
      const a = agents[i % 2];
      applyAction(a, planFromTruth(a, a === bit ? nox : bit, human, world, plannerCtx(a)));
      i++;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    await think(agents[i % agents.length]);
    i++;
    await new Promise((r) => setTimeout(r, brainMode === "heuristic" ? 320 : VLA_GAP_MS));
  }
}

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  updateBrainLabel();
  if (model) return;
  if (progressEl) progressEl.style.display = "block";
  setStatus("loading…", "warn");

  if (brainMode === "heuristic") {
    model = { heuristic: true, remoteOnly: true };
    modelId = "heuristic";
    if (progressEl) progressEl.style.display = "none";
    finishBoot();
    return;
  }

  if (!navigator.gpu && !window.HANGOUT_VLM?.apiKey) {
    brainMode = "heuristic";
    updateBrainLabel();
    model = { heuristic: true, remoteOnly: true };
    modelId = "heuristic";
    if (progressEl) progressEl.style.display = "none";
    toast("Heuristic mode (no WebGPU)", "good");
    finishBoot();
    return;
  }

  if (navigator.gpu) {
    for (const id of MODEL_CANDIDATES) {
      try {
        setStatus(`loading ${id.split("/").pop()}…`, "warn");
        processor = await AutoProcessor.from_pretrained(id, {
          progress_callback: (p) => {
            if (p?.progress != null && progressBar) progressBar.style.width = `${p.progress * 40}%`;
          },
        });
        model = await AutoModelForVision2Seq.from_pretrained(id, {
          dtype: "fp32",
          device: "webgpu",
          progress_callback: (p) => {
            if (p?.progress != null && progressBar) progressBar.style.width = `${40 + p.progress * 60}%`;
          },
        });
        modelId = id;
        break;
      } catch (err) {
        console.warn(id, err);
        model = null;
        processor = null;
      }
    }
  }
  if (!model && window.HANGOUT_VLM?.apiKey) {
    model = { remoteOnly: true };
    modelId = "remote";
  }
  if (!model) {
    brainMode = "heuristic";
    updateBrainLabel();
    model = { heuristic: true, remoteOnly: true };
    modelId = "heuristic";
  }
  if (progressBar) progressBar.style.width = "100%";
  setTimeout(() => { if (progressEl) progressEl.style.display = "none"; }, 300);
  finishBoot();
}

function finishBoot() {
  sfx.boot();
  trySay(bit, "hey… you're here.");
  trySay(nox, "don't make it a thing.");
  juicePop(0.3);
  setStatus(`live · ${modelId}`, "");
  const onboard = document.getElementById("onboard");
  if (onboard) {
    onboard.classList.remove("hidden");
    const dismiss = () => {
      onboard.classList.add("hidden");
      unlockAudio();
    };
    onboard.querySelector("button")?.addEventListener("click", dismiss, { once: true });
    setTimeout(dismiss, 10000);
  }
  const banner = document.getElementById("phase-banner");
  if (banner) {
    banner.classList.remove("hidden");
    banner.classList.add("show");
    setTimeout(() => {
      banner.classList.add("out");
      setTimeout(() => banner.classList.add("hidden"), 500);
    }, 1400);
  }
}

function cycleBrain() {
  const order = ["hybrid", "heuristic", "vlm"];
  brainMode = order[(order.indexOf(brainMode) + 1) % order.length];
  updateBrainLabel();
  saveMemory();
  toast(`Brain: ${brainMode}`, "good");
  if (brainMode !== "heuristic" && (!model || model.heuristic)) {
    model = null;
    boot();
  }
}

// ── Input ───────────────────────────────────────────────────
let drawing = false;

function worldPos(e) {
  const rect = worldCanvas.getBoundingClientRect();
  const camOpt = spectator ? { x: cam.x, y: cam.y, zoom: cam.zoom } : null;
  const cx = e.clientX ?? e.touches?.[0]?.clientX;
  const cy = e.clientY ?? e.touches?.[0]?.clientY;
  return screenToWorld(worldCanvas, cx - rect.left, cy - rect.top, camOpt);
}

worldCanvas.addEventListener("pointerdown", (e) => {
  unlockAudio();
  worldCanvas.setPointerCapture(e.pointerId);
  const p = worldPos(e);
  // click agent to assign other to approach them / human
  if (Math.hypot(bit.x - p.x, bit.y - p.y) < 28) {
    human.assign = { forAgent: "nox", kind: "agent", id: "bit", x: bit.x, y: bit.y };
    toast("Nox → Bit", "good");
    applyAction(nox, planFromTruth(nox, bit, human, world, plannerCtx(nox)));
    return;
  }
  if (Math.hypot(nox.x - p.x, nox.y - p.y) < 28) {
    human.assign = { forAgent: "bit", kind: "agent", id: "nox", x: nox.x, y: nox.y };
    toast("Bit → Nox", "good");
    applyAction(bit, planFromTruth(bit, nox, human, world, plannerCtx(bit)));
    return;
  }
  const prop = nearestProp(world, p.x, p.y, 30);
  if (prop) {
    const forAgent = dist(bit, prop) <= dist(nox, prop) ? "bit" : "nox";
    human.assign = { forAgent, kind: "prop", id: prop.id, x: prop.x, y: prop.y };
    toast(`${forAgent} → ${prop.id}`, "good");
    const a = forAgent === "bit" ? bit : nox;
    applyAction(a, planFromTruth(a, a === bit ? nox : bit, human, world, plannerCtx(a)));
    return;
  }
  drawing = true;
  human.path = [{ x: p.x, y: p.y }];
  human.x = p.x;
  human.y = p.y;
});

worldCanvas.addEventListener("pointermove", (e) => {
  const p = worldPos(e);
  if (drawing) {
    const last = human.path[human.path.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 12) {
      human.path.push({ x: p.x, y: p.y });
      if (human.path.length > 80) human.path.shift();
    }
  } else if (!human.path.length) {
    human.x = Math.max(20, Math.min(WORLD_W - 20, p.x));
    human.y = Math.max(20, Math.min(WORLD_H - 20, p.y));
  }
});
worldCanvas.addEventListener("pointerup", () => { drawing = false; });

function doCall() {
  callPulse = 2.2;
  sfx.call(human.x, human.y);
  toast("Calling…", "good");
  for (const a of agents) {
    a.envEvents.push("human CALL");
    setNavTo(world, a, human.x, human.y);
    setThought(a, "COME");
  }
}
function doBeacon() {
  world.beacon = { x: human.x, y: human.y, t: 16 };
  sfx.beacon(human.x, human.y);
  spawnFlash(world, human.x, human.y, "#0f0", 36);
  toast("Beacon", "good");
  for (const a of agents) a.envEvents.push("beacon");
}

window.addEventListener("keydown", (e) => {
  unlockAudio();
  const k = e.key.toLowerCase();
  if (k === "d") {
    debugOn = !debugOn;
    debugEl?.classList.toggle("hidden", !debugOn);
  }
  if (k === "c") {
    spectator = !spectator;
    toast(spectator ? "Spectator cam" : "Wide cam");
  }
  if (k === "q") doCall();
  if (k === "e") doBeacon();
  if (k === "b") cycleBrain();
});

brainModeEl?.addEventListener("click", cycleBrain);
statusEl?.addEventListener("click", () => {
  if (statusEl.classList.contains("err")) { model = null; boot(); }
});
document.getElementById("m-call")?.addEventListener("click", doCall);
document.getElementById("m-beacon")?.addEventListener("click", doBeacon);
document.getElementById("m-cam")?.addEventListener("click", () => {
  spectator = !spectator;
  toast(spectator ? "Spectator" : "Wide");
});
document.getElementById("m-brain")?.addEventListener("click", cycleBrain);

function cycleBrain() {
  const order = ["hybrid", "heuristic", "vlm"];
  brainMode = order[(order.indexOf(brainMode) + 1) % order.length];
  updateBrainLabel();
  saveMemory();
  toast(`Brain: ${brainMode}`, "good");
  if (brainMode !== "heuristic" && (!model || model.heuristic)) {
    model = null;
    boot();
  }
}

// ── Start ───────────────────────────────────────────────────
updateBrainLabel();
renderRelations();
paint();
requestAnimationFrame(motorLoop);
boot().then(() => vlaLoop());
window.addEventListener("resize", () => paint());

window.hangout = {
  cycleBrain,
  agents: () => agents,
  setBrain: (m) => { brainMode = m; updateBrainLabel(); },
};
