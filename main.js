/**
 * Hangout VLA World — improved sim
 * Vision reliability, spatial audio, scenario, replay, relationships, API path
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
  nearestFreePickup,
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

// ── Config ──────────────────────────────────────────────────
const MODEL_CANDIDATES = [
  "HuggingFaceTB/SmolVLM-256M-Instruct",
  "HuggingFaceTB/SmolVLM-500M-Instruct",
];
const STEP_PX = 40;
const MOVE_SPEED = 125;
const HEAR_RANGE = 160;
const GRAB_RANGE = 36;
const VLA_GAP_MS = 120;
const IDLE_SKIP_CHANCE = 0.35;
const MEMORY_KEY = "hangout_vla_memory_v2";
const REPLAY_KEY = "hangout_vla_last_replay";
const CHAT_MAX = 18;
const CHAT_FADE_MS = 14000;
const SCENARIO_SECS = 180; // 3 minutes
const MAX_RETRIES = 2;

const MOVES = new Set([
  "forward", "back", "left", "right", "turn_left", "turn_right",
  "toward", "away", "idle", "wait",
  "orbit_other", "patrol_edge", "follow", "follow_human", "goto_beacon",
  "up", "down", "upleft", "upright", "downleft", "downright",
]);
const ACTS = new Set(["none", "grab", "drop", "use", "wave"]);
const MOODS = new Set(["idle", "think", "happy", "curious", "wave"]);

// Optional remote OpenAI-compatible VLM (set in console):
//   window.HANGOUT_VLM = { baseUrl: "https://api.x.ai/v1", apiKey: "...", model: "grok-2-vision-1212" }
// Leaves local SmolVLM as default when unset.

// ── DOM ─────────────────────────────────────────────────────
const worldCanvas = document.getElementById("world");
const visionCanvas = document.getElementById("vision");
const visionMeta = document.getElementById("vision-meta");
const minimapCanvas = document.getElementById("minimap");
const chatlog = document.getElementById("chatlog");
const statusEl = document.getElementById("status");
const goalsEl = document.getElementById("goals");
const relBar = document.getElementById("rel-bar");
const progressEl = document.getElementById("progress");
const progressBar = progressEl.querySelector("i");
const debugEl = document.getElementById("debug");
const dbgBody = document.getElementById("dbg-body");
const toastsEl = document.getElementById("toasts");
const scenarioTimerEl = document.getElementById("scenario-timer");
const winModal = document.getElementById("win-modal");
const winText = document.getElementById("win-text");
const winStats = document.getElementById("win-stats");
const winAgain = document.getElementById("win-again");

const wctx = worldCanvas.getContext("2d");
const mctx = minimapCanvas.getContext("2d");

// ── State ───────────────────────────────────────────────────
let world = createWorld();
let processor = null;
let model = null;
let modelId = "";
let running = true;
let won = false;
let debugOn = false;
let lastMotor = 0;
let lastStepSfx = { bit: 0, nox: 0 };
let scenarioLeft = SCENARIO_SECS;
let keys = { q: false };
let callPulse = 0;

const transcript = [];
const replayLog = []; // compact samples
let replayPlaying = false;

const human = {
  id: "you",
  name: "You",
  kind: "human",
  x: WORLD_W / 2,
  y: WORLD_H / 2,
  color: "#55ff55",
  lastSaid: "",
};

// relationship matrix: -1..1
const relations = {
  bit_nox: 0.1,
  bit_you: 0,
  nox_you: -0.05,
  bit_node: 0,
  nox_node: 0,
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
    lastTruth: "",
    seeScore: 0,
    speedMul: 1,
    ticks: 0,
    idleTicks: 0,
    memory: [],
    longTerm: [],
    envEvents: [],
    holding: null,
    frameHistory: [],
    lastAction: null,
    lastRaw: "",
    lookAt: null,
    skillT: 0,
    walkPhase: 0,
    moving: false,
  };
}

const bit = createAgent({
  id: "bit",
  name: "Bit",
  cssClass: "bit",
  color: "#6ec6ff",
  headColor: "#b8e4ff",
  nameColor: "#6ec6ff",
  persona: "optimistic cyan glitch; loves orbs, coffee, and teamwork",
  x: 160,
  y: 180,
  angle: 0,
  goal: "help collect all three orbs with Nox before time runs out",
});

const nox = createAgent({
  id: "nox",
  name: "Nox",
  cssClass: "nox",
  color: "#ff7a6e",
  headColor: "#ffc4bc",
  nameColor: "#ff7a6e",
  persona: "dry coral glitch; competitive but will cooperate on the orb heist",
  x: 780,
  y: 180,
  angle: Math.PI,
  goal: "grab orbs fast, maybe let Bit help",
});

const agents = [bit, nox];

// Scenario quests
const quests = [
  { id: "orbs", label: "Hold all 3 orbs (combined)", progress: 0, target: 3, done: false },
  { id: "meet", label: "Meet in same room with LOS", progress: 0, target: 1, done: false },
  { id: "bank", label: "Both hold an orb at once", progress: 0, target: 1, done: false },
  { id: "talk", label: "6 lines of chat", progress: 0, target: 6, done: false },
];

// ── Memory ──────────────────────────────────────────────────
function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const a of agents) {
      const m = data[a.id];
      if (m?.longTerm) a.longTerm = m.longTerm.slice(-12);
    }
    if (data.relations) Object.assign(relations, data.relations);
  } catch {
    /* */
  }
}

function saveMemory() {
  try {
    const data = { relations: { ...relations } };
    for (const a of agents) {
      data[a.id] = { longTerm: a.longTerm.slice(-12), goal: a.goal };
    }
    localStorage.setItem(MEMORY_KEY, JSON.stringify(data));
  } catch {
    /* */
  }
}

loadMemory();

// ── UI ──────────────────────────────────────────────────────
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

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toastsEl.appendChild(el);
  setTimeout(() => el.classList.add("fade"), 2200);
  setTimeout(() => el.remove(), 3000);
}

function logSpeech(name, text, cssClass, pos = null, opts = {}) {
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
  setTimeout(() => line.remove(), CHAT_FADE_MS + 1500);

  const muted = !!opts.muted;
  sfx.talk(cssClass, pos?.x, pos?.y, muted);

  const tq = quests.find((q) => q.id === "talk");
  tq.progress = Math.min(tq.target, tq.progress + 1);
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

function renderRelations() {
  const bn = relations.bit_nox;
  const by = relations.bit_you;
  const ny = relations.nox_you;
  const face = (v) => (v > 0.35 ? "♥" : v < -0.25 ? "💢" : "·");
  relBar.textContent = `Bit↔Nox ${face(bn)} ${bn.toFixed(2)}  Bit↔You ${face(by)} ${by.toFixed(2)}  Nox↔You ${face(ny)} ${ny.toFixed(2)}`;
}

function bumpRelation(key, delta, reason) {
  if (!(key in relations)) return;
  const before = relations[key];
  relations[key] = Math.max(-1, Math.min(1, relations[key] + delta));
  if (Math.abs(relations[key] - before) > 0.04) {
    saveMemory();
  }
  if (reason && Math.abs(delta) >= 0.08) {
    toast(`${reason}`, delta > 0 ? "good" : "bad");
  }
}

function updateQuests() {
  const held = world.pickups.filter((p) => p.heldBy).length;
  const oq = quests.find((q) => q.id === "orbs");
  if (held > oq.progress) {
    toast(`Orb secured (${held}/3)`, "good");
  }
  oq.progress = held;
  if (oq.progress >= oq.target && !oq.done) {
    oq.done = true;
    sfx.goal();
    toast("All orbs held!", "good");
  }

  const meet = quests.find((q) => q.id === "meet");
  const rb = roomAt(world, bit.x, bit.y);
  const rn = roomAt(world, nox.x, nox.y);
  if (
    !meet.done &&
    rb &&
    rn &&
    rb.id === rn.id &&
    dist(bit, nox) < 90 &&
    hasLOS(world, bit.x, bit.y, nox.x, nox.y)
  ) {
    meet.progress = 1;
    meet.done = true;
    sfx.goal();
    toast(`${rb.name}: Bit & Nox reunited`, "good");
    bumpRelation("bit_nox", 0.15, "Bit & Nox bonded");
  }

  const bank = quests.find((q) => q.id === "bank");
  if (!bank.done && bit.holding && nox.holding) {
    bank.progress = 1;
    bank.done = true;
    sfx.goal();
    toast("Both agents holding orbs!", "good");
    bumpRelation("bit_nox", 0.1);
  }

  const tq = quests.find((q) => q.id === "talk");
  if (tq.progress >= tq.target && !tq.done) {
    tq.done = true;
    sfx.goal();
    toast("Chatty void achieved", "good");
  }

  // room enter toasts
  for (const a of agents) {
    const r = roomAt(world, a.x, a.y);
    if (r && a._lastRoom !== r.id) {
      if (a._lastRoom) toast(`${a.name} entered ${r.name}`);
      a._lastRoom = r.id;
    }
  }

  renderGoals();
  renderRelations();
  checkWin();
  saveMemory();
}

function checkWin() {
  if (won) return;
  // Win: all orbs held AND meet done, or all 4 quests done, within time
  const orbsDone = quests.find((q) => q.id === "orbs").done;
  const meetDone = quests.find((q) => q.id === "meet").done;
  const allDone = quests.every((q) => q.done);
  if ((orbsDone && meetDone) || allDone) {
    triggerWin(allDone ? "Full clear — every objective done." : "Orb heist success — team has the loot.");
  }
}

function triggerWin(msg) {
  if (won) return;
  won = true;
  running = false;
  sfx.win();
  winText.textContent = msg;
  winStats.textContent = `Time left ${fmtTime(scenarioLeft)} · Bit↔Nox ${relations.bit_nox.toFixed(2)} · lines ${transcript.length}`;
  winModal.classList.remove("hidden");
  persistReplay();
  toast("MISSION COMPLETE", "good");
}

function fmtTime(s) {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
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

// ── Speech with spatial range + LOS ─────────────────────────
function trySay(agent, text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  agent.lastSaid = msg.slice(0, 120);

  // Observer always sees chat; audio is spatial from listener (human)
  logSpeech(agent.name, agent.lastSaid, agent.cssClass, agent);

  for (const other of agents) {
    if (other.id === agent.id) continue;
    const d = dist(agent, other);
    if (d > HEAR_RANGE) continue;
    if (!hasLOS(world, agent.x, agent.y, other.x, other.y)) continue;
    remember(other, `heard <${agent.name}> ${msg.slice(0, 40)}`);
    // relationship nudge on hearing friendly words
    if (/thanks|sorry|help|love|hey|hi|friend/i.test(msg)) {
      bumpRelation("bit_nox", 0.04);
    }
    if (/hate|shut|dumb|leave/i.test(msg)) {
      bumpRelation("bit_nox", -0.06);
    }
  }
  // human nearby
  if (dist(agent, human) < HEAR_RANGE && hasLOS(world, agent.x, agent.y, human.x, human.y)) {
    const key = agent.id === "bit" ? "bit_you" : "nox_you";
    if (/hey|you|human|friend/i.test(msg)) bumpRelation(key, 0.05);
  }
  rememberLong(agent, `said: ${msg.slice(0, 50)}`);
}

// ── Actions ─────────────────────────────────────────────────
function setAngle(agent, ang) {
  agent.angle = Math.atan2(Math.sin(ang), Math.cos(ang));
  agent.facing = Math.cos(agent.angle) >= 0 ? 1 : -1;
}

function issueMove(agent, moveName, steps = 3) {
  let move = String(moveName || "idle").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (move === "up") move = "forward";
  if (move === "down") move = "back";
  if (!MOVES.has(move)) move = "idle";

  const n = Math.max(0, Math.min(8, Number(steps) || 0));
  agent.move = move;
  agent.skillT = 0;

  if (move === "idle" || move === "wait" || n === 0) {
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.moving = false;
    return;
  }

  if (move === "turn_left") {
    setAngle(agent, agent.angle - Math.PI / 2);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "turn_left", skill: null };
    spawnParticle(world, agent.x, agent.y, "#aaa", 3);
    return;
  }
  if (move === "turn_right") {
    setAngle(agent, agent.angle + Math.PI / 2);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "turn_right", skill: null };
    spawnParticle(world, agent.x, agent.y, "#aaa", 3);
    return;
  }

  if (
    move === "orbit_other" ||
    move === "patrol_edge" ||
    move === "follow" ||
    move === "follow_human" ||
    move === "goto_beacon"
  ) {
    agent.intent = {
      vx: 0,
      vy: 0,
      remaining: n * STEP_PX * 1.6,
      label: move,
      skill: move,
    };
    agent.moving = true;
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
  agent.moving = true;
}

function applyAct(agent, act) {
  act = String(act || "none").toLowerCase();
  if (!ACTS.has(act) || act === "none") return;

  if (act === "wave") {
    agent.emote = "wave";
    agent.mood = "wave";
    spawnParticle(world, agent.x, agent.y - 10, "#ff8", 5);
    setTimeout(() => {
      if (agent.emote === "wave") agent.emote = "none";
    }, 1200);
    return;
  }

  if (act === "grab") {
    if (agent.holding) {
      failFx(agent, "already holding");
      return;
    }
    const p = nearestFreePickup(world, agent.x, agent.y, GRAB_RANGE);
    if (p) {
      p.heldBy = agent.id;
      agent.holding = p;
      sfx.grab(agent.x, agent.y);
      sfx.success(agent.x, agent.y);
      spawnParticle(world, agent.x, agent.y, p.color, 10);
      spawnFlash(world, agent.x, agent.y, p.color, 36);
      remember(agent, `grabbed ${p.id}`);
      rememberLong(agent, `picked up ${p.id}`);
      toast(`${agent.name} grabbed ${p.id}`, "good");
      updateQuests();
    } else {
      failFx(agent, "grab failed — nothing in range");
    }
    return;
  }

  if (act === "drop") {
    if (!agent.holding) {
      failFx(agent, "drop failed — empty hands");
      return;
    }
    const p = agent.holding;
    p.heldBy = null;
    p.x = agent.x + Math.cos(agent.angle) * 22;
    p.y = agent.y + Math.sin(agent.angle) * 22;
    agent.holding = null;
    sfx.drop(agent.x, agent.y);
    spawnParticle(world, p.x, p.y, p.color, 6);
    remember(agent, `dropped ${p.id}`);
    updateQuests();
    return;
  }

  if (act === "use") {
    const prop = nearestProp(world, agent.x, agent.y, 42);
    if (!prop) {
      failFx(agent, "use failed — no prop near");
      return;
    }
    sfx.success(agent.x, agent.y);
    spawnParticle(world, prop.x, prop.y, "#ff5", 8);
    remember(agent, `used ${prop.id}`);
    rememberLong(agent, `used ${prop.label}`);
    toast(`${agent.name} used ${prop.id}`, "good");
    if (prop.id === "coffee") trySay(agent, "ahh. warm pixels.");
    if (prop.id === "terminal") trySay(agent, "logs look haunted.");
    if (prop.id === "whiteboard") trySay(agent, "todo: steal orbs.");
    if (prop.id === "couch") trySay(agent, "five more minutes…");
  }
}

function failFx(agent, reason) {
  agent.envEvents.push(reason);
  sfx.fail(agent.x, agent.y);
  spawnFlash(world, agent.x, agent.y, "#f44", 30);
  spawnParticle(world, agent.x, agent.y, "#f66", 7);
}

function applyAction(agent, action) {
  if (!action || typeof action !== "object") return;
  agent.lastAction = action;

  if (action.goal) {
    agent.goal = String(action.goal).slice(0, 80);
    saveMemory();
  }
  if (action.mood && MOODS.has(String(action.mood))) agent.mood = String(action.mood);
  if (action.see) agent.lastSaw = String(action.see).slice(0, 120);
  if (typeof action.speed === "number") {
    agent.speedMul = Math.max(0.45, Math.min(1.8, action.speed));
  }
  if (action.look_at) agent.lookAt = String(action.look_at);

  if (agent.lookAt && agent.lookAt !== "none") {
    const t = resolveLookTarget(agent, agent.lookAt);
    if (t) setAngle(agent, Math.atan2(t.y - agent.y, t.x - agent.x));
  }

  // relationship biases movement slightly
  const rel = relations.bit_nox;
  let move = action.move != null ? action.move : "idle";
  if (rel < -0.4 && move === "toward") {
    // annoyed — sometimes refuse approach
    if (Math.random() < 0.35) move = "away";
  }
  if (rel > 0.5 && move === "away" && Math.random() < 0.3) move = "toward";

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
      (action.act && action.act !== "none" ? ` ${action.act}` : "") +
      (action.say ? ` “${String(action.say).slice(0, 20)}”` : "")
  );
}

function resolveLookTarget(agent, ref) {
  const r = String(ref).toLowerCase();
  if (r === "other") return agent === bit ? nox : bit;
  if (r === "bit") return bit;
  if (r === "nox") return nox;
  if (r === "human" || r === "you") return human;
  if (r === "node") return world.node;
  if (r === "beacon" && world.beacon) return world.beacon;
  if (r.startsWith("prop:")) return world.props.find((p) => p.id === r.slice(5)) || null;
  return world.props.find((p) => p.id === r) || null;
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
    if (obj.mood && !MOODS.has(String(obj.mood))) delete obj.mood;
    if (obj.say != null) obj.say = String(obj.say).slice(0, 80);
    return obj;
  } catch {
    return null;
  }
}

/** Repair pass: extract move keywords if JSON failed */
function repairAction(raw, agent) {
  const lower = String(raw || "").toLowerCase();
  let move = "idle";
  for (const m of [
    "goto_beacon", "follow_human", "orbit_other", "patrol_edge", "follow",
    "toward", "away", "turn_left", "turn_right", "forward", "back", "left", "right",
  ]) {
    if (lower.includes(m.replace("_", " ")) || lower.includes(m)) {
      move = m;
      break;
    }
  }
  let act = "none";
  if (lower.includes("grab") || lower.includes("pick")) act = "grab";
  else if (lower.includes("drop")) act = "drop";
  else if (lower.includes("use") || lower.includes("coffee")) act = "use";
  else if (lower.includes("wave")) act = "wave";

  // if orb visible and free, bias grab
  const truth = visibleTruth(world, agent, othersFor(agent));
  if (truth.orbs.length && !agent.holding && act === "none" && Math.random() < 0.5) {
    act = "grab";
    move = "forward";
  }

  return {
    see: "repair",
    move,
    steps: 3,
    act,
    say: "",
    mood: "curious",
  };
}

function othersFor(agent) {
  return [
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
}

// ── VLA ─────────────────────────────────────────────────────
function buildPrompt(agent, truthStr) {
  const other = agent === bit ? nox : bit;
  const room = roomAt(world, agent.x, agent.y);
  const dOther = Math.round(dist(agent, other));
  const dHuman = Math.round(dist(agent, human));
  const events = agent.envEvents.length ? agent.envEvents.join("; ") : "none";
  agent.envEvents = [];
  const chat = transcript.slice(-4).map((m) => `<${m.name}> ${m.text}`).join(" | ");
  const rel = relations.bit_nox;
  const nearOrb = nearestFreePickup(world, agent.x, agent.y, 80);
  const nearProp = nearestProp(world, agent.x, agent.y, 50);

  return (
    `You are ${agent.name}. EGOCENTRIC camera: yellow YOU faces up; labels are BIG. Mission: collect orbs with partner before timer ends.\n` +
    `GROUND TRUTH (use this + image): ${truthStr}\n` +
    `STATE room=${room?.name} hold=${agent.holding?.id || "none"} goal="${agent.goal}" rel_partner=${rel.toFixed(2)}\n` +
    `DIST ${other.name}=${dOther} you=${dHuman} orb=${nearOrb ? nearOrb.id + "@" + Math.round(dist(agent, nearOrb)) : "-"} prop=${nearProp?.id || "-"}\n` +
    `BEACON=${world.beacon ? `${Math.round(world.beacon.x)},${Math.round(world.beacon.y)}` : "none"} CALL=${callPulse > 0 ? "human calling" : "no"}\n` +
    `EVENTS: ${events}\nMEM: ${agent.memory.slice(-3).join(" / ") || "—"}\nLONG: ${agent.longTerm.slice(-2).join(" / ") || "—"}\nCHAT: ${chat || "silence"}\n` +
    `Reply ONLY JSON:\n` +
    `{"see":"match ground truth briefly","move":"forward|back|left|right|turn_left|turn_right|toward|away|orbit_other|follow|follow_human|goto_beacon|patrol_edge|idle","steps":1-6,"act":"none|grab|drop|use|wave","look_at":"other|human|beacon|prop:coffee|none","say":"max 10 words or empty","mood":"idle|think|happy|curious","goal":"short"}`
  );
}

async function remoteVlmInfer(dataUrl, prompt) {
  const cfg = window.HANGOUT_VLM;
  if (!cfg?.baseUrl || !cfg?.apiKey) return null;
  const modelName = cfg.model || "grok-2-vision-1212";
  const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 150,
      temperature: 0.5,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`remote VLM ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function localVlmInfer(dataUrl, prompt) {
  const image = await RawImage.fromURL(dataUrl);
  const messages = [
    {
      role: "user",
      content: [
        { type: "image" },
        { type: "text", text: prompt },
      ],
    },
  ];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, [image], {});
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 100,
    do_sample: true,
    temperature: 0.45,
    top_p: 0.9,
  });
  const decoded = processor.batch_decode(outputs, { skip_special_tokens: true });
  let raw = decoded[0] || "";
  if (raw.includes("Assistant:")) raw = raw.split("Assistant:").pop();
  return raw.trim();
}

async function vlaInfer(agent) {
  const others = othersFor(agent);
  const truth = visibleTruth(world, agent, others);
  const truthStr = truthToString(truth);
  agent.lastTruth = truthStr;

  const dataUrl = captureEgocentric(
    visionCanvas,
    world,
    agent,
    others,
    agent.frameHistory
  );
  await pushFrameHistory(agent.frameHistory, dataUrl, 3);
  visionMeta.textContent = `VLA · ${agent.name} · seeScore ${(agent.seeScore * 100) | 0}%`;

  const prompt = buildPrompt(agent, truthStr);

  let raw = "";
  let action = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      raw = "";
      if (window.HANGOUT_VLM?.apiKey) {
        raw = (await remoteVlmInfer(dataUrl, prompt)) || "";
      }
      if (!raw && processor && model && !model.remoteOnly) {
        raw = await localVlmInfer(dataUrl, prompt);
      }
      if (!raw) throw new Error("no VLM response");
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      continue;
    }

    agent.lastRaw = raw.slice(0, 400);
    action = parseAction(raw);
    if (action) break;
  }

  if (!action) {
    action = repairAction(raw, agent);
    agent.lastRaw = (raw || "") + " [repaired]";
  }

  agent.seeScore = scoreSee(action.see, truth);
  if (agent.seeScore < 0.25 && truth.entities.length) {
    // inject truth into see for memory honesty
    action.see = (action.see || "") + " | truth:" + truthStr.slice(0, 60);
  }

  return action;
}

// ── Motor ───────────────────────────────────────────────────
function skillStep(agent, dt) {
  const intent = agent.intent;
  if (!intent?.skill) return false;
  agent.skillT += dt;
  const other = agent === bit ? nox : bit;
  let tx = agent.x;
  let ty = agent.y;
  const sp = MOVE_SPEED * agent.speedMul * dt;

  if (intent.skill === "orbit_other") {
    const ang = Math.atan2(agent.y - other.y, agent.x - other.x) + dt * 1.7;
    tx = other.x + Math.cos(ang) * 70;
    ty = other.y + Math.sin(ang) * 70;
    setAngle(agent, Math.atan2(other.y - agent.y, other.x - agent.x));
  } else if (intent.skill === "follow") {
    const dx = other.x - agent.x;
    const dy = other.y - agent.y;
    const L = Math.hypot(dx, dy) || 1;
    if (L > 48) {
      tx = agent.x + (dx / L) * sp;
      ty = agent.y + (dy / L) * sp;
    }
    setAngle(agent, Math.atan2(dy, dx));
  } else if (intent.skill === "follow_human") {
    const dx = human.x - agent.x;
    const dy = human.y - agent.y;
    const L = Math.hypot(dx, dy) || 1;
    if (L > 40) {
      tx = agent.x + (dx / L) * sp;
      ty = agent.y + (dy / L) * sp;
    }
    setAngle(agent, Math.atan2(dy, dx));
  } else if (intent.skill === "goto_beacon" && world.beacon) {
    const dx = world.beacon.x - agent.x;
    const dy = world.beacon.y - agent.y;
    const L = Math.hypot(dx, dy) || 1;
    if (L > 20) {
      tx = agent.x + (dx / L) * sp;
      ty = agent.y + (dy / L) * sp;
    }
    setAngle(agent, Math.atan2(dy, dx));
  } else if (intent.skill === "patrol_edge") {
    if (!intent._pvx) {
      intent._pvx = 1;
      intent._pvy = 0;
    }
    tx = agent.x + intent._pvx * sp;
    ty = agent.y + intent._pvy * sp;
    setAngle(agent, Math.atan2(intent._pvy, intent._pvx));
  } else {
    return false;
  }

  const res = moveWithCollision(world, agent.x, agent.y, tx, ty, 14);
  if (res.hit) {
    sfx.bump(agent.x, agent.y);
    spawnFlash(world, agent.x, agent.y, "#f84", 22);
    agent.envEvents.push(`blocked:${res.hit}`);
    if (intent.skill === "patrol_edge") {
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      const pick = dirs[Math.floor(Math.random() * 4)];
      intent._pvx = pick[0];
      intent._pvy = pick[1];
    }
  }
  agent.x = res.x;
  agent.y = res.y;
  if (agent.holding) {
    agent.holding.x = agent.x;
    agent.holding.y = agent.y;
  }
  agent.walkPhase += dt * 14;
  agent.moving = true;

  intent.remaining = Math.max(0, intent.remaining - MOVE_SPEED * dt);
  if (intent.remaining <= 0) {
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.move = "idle";
    agent.moving = false;
    agent.envEvents.push("skill finished");
  }
  return true;
}

function simulateAgent(agent, dt) {
  if (skillStep(agent, dt)) {
    maybeStepSfx(agent);
    return;
  }

  const intent = agent.intent;
  if (!intent || intent.remaining <= 0 || (intent.vx === 0 && intent.vy === 0)) {
    agent.moving = false;
    return;
  }

  const sp = MOVE_SPEED * agent.speedMul;
  const step = Math.min(intent.remaining, sp * dt);
  const nx = agent.x + intent.vx * step;
  const ny = agent.y + intent.vy * step;
  const res = moveWithCollision(world, agent.x, agent.y, nx, ny, 14);

  let fx = res.x;
  let fy = res.y;
  const other = agent === bit ? nox : bit;
  const d = Math.hypot(fx - other.x, fy - other.y);
  if (d < 28 && d > 0.01) {
    const push = (28 - d) / d;
    fx += (fx - other.x) * push * 0.5;
    fy += (fy - other.y) * push * 0.5;
  }
  const dh = Math.hypot(fx - human.x, fy - human.y);
  if (dh < 26 && dh > 0.01) {
    const push = (26 - dh) / dh;
    fx += (fx - human.x) * push * 0.4;
    fy += (fy - human.y) * push * 0.4;
  }

  if (res.hit) {
    agent.envEvents.push(`blocked:${res.hit}`);
    sfx.bump(agent.x, agent.y);
    spawnFlash(world, agent.x, agent.y, "#f84", 24);
    spawnParticle(world, agent.x, agent.y, "#fa6", 5);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.move = "idle";
    agent.moving = false;
  } else {
    intent.remaining = Math.max(0, intent.remaining - step);
    if (intent.remaining <= 0) {
      agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
      agent.move = "idle";
      agent.moving = false;
      agent.envEvents.push("finished steps");
    } else {
      agent.moving = true;
      agent.walkPhase += dt * 14;
    }
  }

  agent.x = Math.max(20, Math.min(WORLD_W - 20, fx));
  agent.y = Math.max(20, Math.min(WORLD_H - 20, fy));
  if (agent.holding) {
    agent.holding.x = agent.x;
    agent.holding.y = agent.y;
  }
  maybeStepSfx(agent);
}

function maybeStepSfx(agent) {
  const now = performance.now();
  if (now - (lastStepSfx[agent.id] || 0) > 190) {
    // mute footsteps if no LOS to human (spatial + occlusion)
    const muted = !hasLOS(world, agent.x, agent.y, human.x, human.y);
    sfx.step(agent.x, agent.y, muted);
    lastStepSfx[agent.id] = now;
  }
}

function tickNode(dt) {
  const n = world.node;
  n.phase += dt;
  const path = [[700, 450], [850, 420], [820, 520], [680, 500]];
  const idx = Math.floor(n.phase / 3) % path.length;
  const [tx, ty] = path[idx];
  const dx = tx - n.x;
  const dy = ty - n.y;
  const L = Math.hypot(dx, dy) || 1;
  n.x += (dx / L) * 40 * dt;
  n.y += (dy / L) * 40 * dt;

  if (Math.random() < 0.0015) {
    const near = agents.some((a) => dist(a, n) < 110);
    if (near) {
      const lines = ["orb heist active", "timer ticking", "do not unplug", "yard clear"];
      const msg = lines[Math.floor(Math.random() * lines.length)];
      n.lastSaid = msg;
      logSpeech("Node", msg, "node", n);
    }
  }
}

function entityList() {
  return [
    { ...bit, moodColor: moodColor(bit), showFov: debugOn, fovRad: Math.PI * 0.55 },
    { ...nox, moodColor: moodColor(nox), showFov: debugOn, fovRad: Math.PI * 0.55 },
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

function sampleReplay() {
  if (replayPlaying) return;
  if (replayLog.length > 4000) replayLog.shift();
  replayLog.push({
    t: world.time,
    bit: { x: bit.x, y: bit.y, a: bit.angle, m: bit.move, h: bit.holding?.id || null },
    nox: { x: nox.x, y: nox.y, a: nox.angle, m: nox.move, h: nox.holding?.id || null },
    human: { x: human.x, y: human.y },
  });
}

function persistReplay() {
  try {
    localStorage.setItem(REPLAY_KEY, JSON.stringify(replayLog.slice(-1500)));
  } catch {
    /* */
  }
}

async function playReplay() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(REPLAY_KEY) || "[]");
  } catch {
    data = [];
  }
  if (!data.length) {
    toast("No replay saved yet", "bad");
    return;
  }
  toast(`Replaying ${data.length} frames…`);
  replayPlaying = true;
  running = false;
  for (const frame of data) {
    bit.x = frame.bit.x;
    bit.y = frame.bit.y;
    bit.angle = frame.bit.a;
    bit.move = frame.bit.m;
    nox.x = frame.nox.x;
    nox.y = frame.nox.y;
    nox.angle = frame.nox.a;
    nox.move = frame.nox.m;
    human.x = frame.human.x;
    human.y = frame.human.y;
    paint();
    await new Promise((r) => setTimeout(r, 40));
  }
  replayPlaying = false;
  if (!won) running = true;
  toast("Replay done", "good");
}

function paint() {
  drawWorld(wctx, worldCanvas, world, entityList(), {});
  // minimap in its own canvas
  mctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  drawMinimap(mctx, 0, 0, minimapCanvas.width, minimapCanvas.height, world, entityList());
  updateDebug();
}

function updateDebug() {
  if (!debugOn) return;
  const a = bit.ticks >= nox.ticks ? bit : nox;
  dbgBody.textContent = [
    `model: ${modelId || (window.HANGOUT_VLM ? "remote+local" : "—")}`,
    `time: ${fmtTime(scenarioLeft)} world.t=${world.time.toFixed(1)}`,
    `Bit (${Math.round(bit.x)},${Math.round(bit.y)}) ${roomAt(world, bit.x, bit.y)?.name} ${bit.move} hold=${bit.holding?.id || "-"} see=${(bit.seeScore * 100) | 0}%`,
    `Nox (${Math.round(nox.x)},${Math.round(nox.y)}) ${roomAt(world, nox.x, nox.y)?.name} ${nox.move} hold=${nox.holding?.id || "-"} see=${(nox.seeScore * 100) | 0}%`,
    `truth[${a.name}]: ${a.lastTruth || "—"}`,
    `see[${a.name}]: ${a.lastSaw || "—"}`,
    `raw: ${a.lastRaw || "—"}`,
    `action: ${JSON.stringify(a.lastAction || {})}`,
    `rel: ${JSON.stringify(relations)}`,
    `replay frames: ${replayLog.length}`,
  ].join("\n");
}

// ── Loops ───────────────────────────────────────────────────
function motorLoop(now) {
  const dt = Math.min(0.05, (now - (lastMotor || now)) / 1000);
  lastMotor = now;
  world.time += dt;

  if (running && !won) {
    scenarioLeft -= dt;
    scenarioTimerEl.textContent = fmtTime(scenarioLeft);
    scenarioTimerEl.classList.toggle("urgent", scenarioLeft < 30);
    if (scenarioLeft <= 0) {
      scenarioLeft = 0;
      running = false;
      toast("Time up — mission failed", "bad");
      winText.textContent = "Time expired. The orbs remain scattered.";
      winStats.textContent = `Held ${world.pickups.filter((p) => p.heldBy).length}/3 orbs`;
      winModal.classList.remove("hidden");
      persistReplay();
    }

    if (callPulse > 0) callPulse -= dt;

    for (const a of agents) simulateAgent(a, dt);
    tickNode(dt);
    tickFX(world, dt);
    setListener(human.x, human.y);
    if (Math.floor(world.time * 4) !== Math.floor((world.time - dt) * 4)) {
      sampleReplay();
    }
    updateQuests();
  }

  paint();
  requestAnimationFrame(motorLoop);
}

function waitIdle(agent, maxMs = 1600) {
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

function shouldSkipAgent(agent) {
  // performance: skip some idle thinking if nothing nearby changed
  if (agent.moving) return false;
  if (agent.envEvents.length) return false;
  if (callPulse > 0) return false;
  if (world.beacon) return false;
  if (agent.idleTicks < 1) return false;
  return Math.random() < IDLE_SKIP_CHANCE;
}

async function think(agent) {
  if (!model || !running || won) return;

  // hold Q → bias agents toward human
  if (keys.q) {
    callPulse = 1.2;
    agent.envEvents.push("human is calling — consider follow_human");
  }

  if (shouldSkipAgent(agent)) {
    agent.idleTicks += 1;
    return;
  }

  await waitIdle(agent, 1400);
  agent.ticks += 1;
  agent.idleTicks = 0;
  agent.mood = "think";
  setStatus(`${agent.name} · VLA…`, "warn");

  try {
    const action = await vlaInfer(agent);
    if (running && !won) applyAction(agent, action);
    setStatus(
      `${agent.name} · see${((agent.seeScore * 100) | 0)}% · ${agent.move}` +
        (action.act && action.act !== "none" ? ` · ${action.act}` : ""),
      ""
    );
    setTimeout(() => {
      statusEl.style.opacity = "0.4";
    }, 2000);
  } catch (err) {
    console.error(agent.name, err);
    agent.envEvents.push("vla error");
    setStatus(`${agent.name}: ${err.message || err}`, "warn");
  }
}

async function vlaLoop() {
  // Shared scene cadence: alternate agents, skip idles
  let i = 0;
  while (true) {
    if (!model || !running || won) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    await think(agents[i % agents.length]);
    i += 1;
    await new Promise((r) => setTimeout(r, VLA_GAP_MS));
  }
}

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  if (model) return;
  if (!navigator.gpu && !window.HANGOUT_VLM?.apiKey) {
    setStatus("WebGPU or window.HANGOUT_VLM required — click retry", "err");
    return;
  }

  progressEl.style.display = "block";
  progressBar.style.width = "0%";

  // Prefer remote if configured
  if (window.HANGOUT_VLM?.apiKey) {
    setStatus("using remote VLM (+ local fallback)…", "warn");
  }

  if (navigator.gpu) {
    let lastErr = null;
    for (const id of MODEL_CANDIDATES) {
      try {
        setStatus(`loading ${id.split("/").pop()}…`, "warn");
        processor = await AutoProcessor.from_pretrained(id, {
          progress_callback: (p) => {
            if (p?.progress != null) progressBar.style.width = `${Math.round(p.progress * 40)}%`;
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
        break;
      } catch (err) {
        console.warn(id, err);
        lastErr = err;
        processor = null;
        model = null;
      }
    }
    if (!model && !window.HANGOUT_VLM?.apiKey) {
      progressEl.style.display = "none";
      setStatus(`load failed — click retry (${lastErr?.message || "err"})`, "err");
      return;
    }
  }

  // stub model flag for remote-only
  if (!model && window.HANGOUT_VLM?.apiKey) {
    model = { remoteOnly: true };
    modelId = "remote:" + (window.HANGOUT_VLM.model || "vlm");
  }

  progressBar.style.width = "100%";
  setTimeout(() => {
    progressEl.style.display = "none";
  }, 400);
  sfx.boot();
  trySay(bit, "mission clock is live.");
  trySay(nox, "three orbs. try keep up.");
  toast("Mission: Orb Heist — 3:00", "good");
  setStatus(`VLA online · ${modelId.split("/").pop()}`, "");
}

function resetGame() {
  world = createWorld();
  bit.x = 160;
  bit.y = 180;
  bit.angle = 0;
  bit.holding = null;
  bit.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
  bit.memory = [];
  nox.x = 780;
  nox.y = 180;
  nox.angle = Math.PI;
  nox.holding = null;
  nox.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
  nox.memory = [];
  for (const q of quests) {
    q.progress = 0;
    q.done = false;
  }
  scenarioLeft = SCENARIO_SECS;
  won = false;
  running = true;
  replayLog.length = 0;
  winModal.classList.add("hidden");
  toast("New heist started", "good");
  renderGoals();
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
  logSpeech("You", "hey.", "you", human);
  for (const a of agents) {
    if (dist(a, human) < HEAR_RANGE) {
      remember(a, "heard <You> hey.");
      const key = a.id === "bit" ? "bit_you" : "nox_you";
      bumpRelation(key, 0.03);
    }
  }
});

window.addEventListener("keydown", (e) => {
  unlockAudio();
  if (e.key === "d" || e.key === "D") {
    debugOn = !debugOn;
    debugEl.classList.toggle("hidden", !debugOn);
  }
  if (e.key === "r" || e.key === "R") {
    playReplay();
  }
  if (e.key === "q" || e.key === "Q") {
    keys.q = true;
    callPulse = 1.5;
    sfx.call(human.x, human.y);
    toast("Calling agents…", "good");
    for (const a of agents) {
      a.envEvents.push("human CALL — use follow_human");
      // soft auto-bias
      if (Math.random() < 0.5) issueMove(a, "follow_human", 5);
    }
  }
  if (e.key === "e" || e.key === "E") {
    world.beacon = { x: human.x, y: human.y, t: 20 };
    sfx.beacon(human.x, human.y);
    spawnFlash(world, human.x, human.y, "#0f0", 40);
    toast("Beacon planted", "good");
    for (const a of agents) a.envEvents.push("beacon placed — consider goto_beacon");
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "q" || e.key === "Q") keys.q = false;
});

statusEl.addEventListener("click", () => {
  if (statusEl.classList.contains("err")) boot();
});

winAgain.addEventListener("click", () => resetGame());

// ── Start ───────────────────────────────────────────────────
renderGoals();
renderRelations();
paint();
requestAnimationFrame(motorLoop);
boot().then(() => vlaLoop());
window.addEventListener("resize", () => paint());

// expose helpers
window.hangout = {
  relations,
  quests,
  agents: () => agents,
  replay: playReplay,
  reset: resetGame,
};
