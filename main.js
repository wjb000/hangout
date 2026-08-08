/**
 * Hangout · Orb Heist
 * Hybrid VLA + truth planner, spectator cam, phases, human pathing
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
import { hybridDecide, planFromTruth } from "./planner.js";
import { setNavTo, clearNav, followNav } from "./pathfind.js";

// ── Config ──────────────────────────────────────────────────
const MODEL_CANDIDATES = [
  "HuggingFaceTB/SmolVLM-256M-Instruct",
  "HuggingFaceTB/SmolVLM-500M-Instruct",
];
const STEP_PX = 40;
const MOVE_SPEED = 130;
const HEAR_RANGE = 170;
const GRAB_RANGE = 40;
const VLA_GAP_MS = 100;
const MEMORY_KEY = "hangout_vla_memory_v3";
const REPLAY_KEY = "hangout_vla_last_replay";
const CHAT_MAX = 16;
const CHAT_FADE_MS = 12000;
const SCENARIO_SECS = 120; // tighter 2:00
const MAX_RETRIES = 1;
const SEE_TRUST = 0.32;

const MOVES = new Set([
  "forward", "back", "left", "right", "turn_left", "turn_right",
  "toward", "away", "idle", "wait", "nav",
  "orbit_other", "patrol_edge", "follow", "follow_human", "goto_beacon",
  "up", "down", "upleft", "upright", "downleft", "downright",
]);
const ACTS = new Set(["none", "grab", "drop", "use", "wave"]);
const MOODS = new Set(["idle", "think", "happy", "curious", "wave"]);

// brainMode: hybrid | vlm | heuristic
let brainMode = "hybrid";

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
const phaseLabel = document.getElementById("phase-label");
const brainModeEl = document.getElementById("brain-mode");
const winModal = document.getElementById("win-modal");
const winHeading = document.getElementById("win-heading");
const winText = document.getElementById("win-text");
const winStats = document.getElementById("win-stats");
const winAgain = document.getElementById("win-again");
const winReel = document.getElementById("win-reel");
const invLabel = document.getElementById("inv-label");

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
let phase = 1; // 1 get orbs, 2 meet, 3 finish remaining
let slowMo = 0;
let spectator = true; // auto cam
let cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1, tx: WORLD_W / 2, ty: WORLD_H / 2, tz: 1 };
let hintTimer = 45;
let juice = 0; // screen flash
let throws = []; // {x,y,vx,vy,orb,life}

const transcript = [];
const replayLog = [];
const highlightEvents = []; // {t, kind, x, y}
let replayPlaying = false;
let reelPlaying = false;

const human = {
  id: "you",
  name: "You",
  kind: "human",
  x: WORLD_W / 2,
  y: WORLD_H / 2,
  color: "#55ff88",
  headColor: "#c8ffe0",
  nameColor: "#6f6",
  angle: 0,
  facing: 1,
  walkPhase: 0,
  moving: false,
  lastSaid: "",
  holding: null,
  path: [],
  assign: null, // {forAgent, kind, id, x, y}
  thought: "",
  thoughtT: 0,
};

const relations = {
  bit_nox: 0.1,
  bit_you: 0,
  nox_you: -0.05,
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
    hybrid: "",
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
  persona: "optimistic cyan; team orb hunter",
  x: 160,
  y: 180,
  angle: 0,
  goal: "phase 1: grab an orb",
});

const nox = createAgent({
  id: "nox",
  name: "Nox",
  cssClass: "nox",
  color: "#ff7a6e",
  headColor: "#ffc4bc",
  nameColor: "#ff7a6e",
  persona: "dry coral; competitive orb hunter",
  x: 780,
  y: 180,
  angle: Math.PI,
  goal: "phase 1: grab an orb",
});

const agents = [bit, nox];

// Phase-linked quests
const quests = [
  { id: "p1", label: "P1: Each hold an orb", progress: 0, target: 2, done: false, phase: 1 },
  { id: "p2", label: "P2: Meet (same room + LOS)", progress: 0, target: 1, done: false, phase: 2 },
  { id: "p3", label: "P3: All 3 orbs held", progress: 0, target: 3, done: false, phase: 3 },
  { id: "talk", label: "Chat lines", progress: 0, target: 4, done: false, phase: 0 },
];

function loadMemory() {
  try {
    const data = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
    if (data.relations) Object.assign(relations, data.relations);
    for (const a of agents) {
      if (data[a.id]?.longTerm) a.longTerm = data[a.id].longTerm.slice(-12);
    }
    if (data.brainMode) brainMode = data.brainMode;
  } catch {
    /* */
  }
}
function saveMemory() {
  try {
    const data = { relations: { ...relations }, brainMode };
    for (const a of agents) data[a.id] = { longTerm: a.longTerm.slice(-12) };
    localStorage.setItem(MEMORY_KEY, JSON.stringify(data));
  } catch {
    /* */
  }
}
loadMemory();

// ── UI helpers ──────────────────────────────────────────────
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
  setTimeout(() => el.classList.add("fade"), 2200);
  setTimeout(() => el.remove(), 3000);
}

function juicePop(amount = 0.55) {
  juice = Math.max(juice, amount);
}

function showPhaseBanner(title, sub = "") {
  const el = document.getElementById("phase-banner");
  if (!el) return;
  el.querySelector(".pb-title").textContent = title;
  el.querySelector(".pb-sub").textContent = sub;
  el.classList.remove("hidden", "out");
  void el.offsetWidth;
  el.classList.add("show");
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.classList.add("hidden"), 500);
  }, 1600);
  juicePop(0.4);
}

function updateObjectiveHUD() {
  const el = document.getElementById("objective");
  if (!el) return;
  const lines = {
    1: "Each agent must hold an orb — click orbs to assign · pathfind is on",
    2: "Bit & Nox must meet in the same room (line of sight)",
    3: "Secure all 3 orbs (agents or you) — handoff with F, throw with T",
  };
  el.textContent = `▸ ${lines[phase] || lines[1]}`;
  const arrow = document.getElementById("obj-arrow");
  if (arrow) {
    // point toward nearest free orb or partner mid
    let tx = WORLD_W / 2;
    let ty = WORLD_H / 2;
    if (phase === 2) {
      tx = (bit.x + nox.x) / 2;
      ty = (bit.y + nox.y) / 2;
    } else {
      const free = world.pickups.filter((p) => !p.heldBy);
      if (free.length) {
        const mid = { x: (bit.x + nox.x) / 2, y: (bit.y + nox.y) / 2 };
        free.sort((a, b) => dist(mid, a) - dist(mid, b));
        tx = free[0].x;
        ty = free[0].y;
      }
    }
    const camX = spectator ? cam.x : WORLD_W / 2;
    const camY = spectator ? cam.y : WORLD_H / 2;
    const ang = Math.atan2(ty - camY, tx - camX);
    arrow.style.transform = `rotate(${ang}rad)`;
    arrow.classList.toggle("hidden", false);
  }
}
function fmtTime(s) {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}
function updateBrainLabel() {
  brainModeEl.textContent = `brain: ${brainMode}`;
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
  setTimeout(() => line.remove(), CHAT_FADE_MS + 1200);
  sfx.talk(cssClass, pos?.x, pos?.y, false);
  const tq = quests.find((q) => q.id === "talk");
  tq.progress = Math.min(tq.target, tq.progress + 1);
  updateQuests();
}
function remember(a, line) {
  a.memory.push(line);
  if (a.memory.length > 8) a.memory.shift();
}
function rememberLong(a, line) {
  if (!line || a.longTerm[a.longTerm.length - 1] === line) return;
  a.longTerm.push(line);
  if (a.longTerm.length > 12) a.longTerm.shift();
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
}
function renderRelations() {
  const f = (v) => (v > 0.35 ? "♥" : v < -0.25 ? "💢" : "·");
  relBar.textContent = `Bit↔Nox ${f(relations.bit_nox)} ${relations.bit_nox.toFixed(2)}  You ${f(relations.bit_you)}/${f(relations.nox_you)}`;
}
function renderGoals() {
  goalsEl.innerHTML = quests
    .map((q) => {
      const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
      const active = q.phase === phase || (q.phase === 0 && !q.done);
      return `<div class="goal-chip ${q.done ? "done" : ""} ${active && !q.done ? "active" : ""}">${q.done ? "✓ " : ""}${escapeHtml(q.label)}<span class="bar"><i style="width:${pct}%"></i></span></div>`;
    })
    .join("");
  phaseLabel.textContent = `Phase ${phase}/3`;
  invLabel.textContent = human.holding ? human.holding.id : "—";
}

function updatePhase() {
  const bothHold = bit.holding && nox.holding;
  const heldCount = world.pickups.filter((p) => p.heldBy).length;
  const p1 = quests.find((q) => q.id === "p1");
  const p2 = quests.find((q) => q.id === "p2");
  const p3 = quests.find((q) => q.id === "p3");

  // P1 progress: number of agents holding
  p1.progress = (bit.holding ? 1 : 0) + (nox.holding ? 1 : 0);
  if (p1.progress >= 2 && !p1.done) {
    p1.done = true;
    sfx.goal();
    toast("Phase 1 clear — now meet up!", "good");
    showPhaseBanner("PHASE 2", "Meet in the same room");
    markHighlight("phase", (bit.x + nox.x) / 2, (bit.y + nox.y) / 2);
    if (phase < 2) {
      phase = 2;
      bit.goal = "phase 2: meet Nox";
      nox.goal = "phase 2: meet Bit";
      slowMo = 0.9;
    }
  }

  // P2 meet
  const rb = roomAt(world, bit.x, bit.y);
  const rn = roomAt(world, nox.x, nox.y);
  if (
    !p2.done &&
    rb &&
    rn &&
    rb.id === rn.id &&
    dist(bit, nox) < 85 &&
    hasLOS(world, bit.x, bit.y, nox.x, nox.y)
  ) {
    p2.progress = 1;
    p2.done = true;
    sfx.goal();
    toast(`Phase 2 clear — met in ${rb.name}`, "good");
    showPhaseBanner("PHASE 3", "Lock down every orb");
    markHighlight("meet", (bit.x + nox.x) / 2, (bit.y + nox.y) / 2);
    slowMo = 1.2;
    juicePop(0.7);
    bumpRelation("bit_nox", 0.2);
    if (phase < 3) {
      phase = 3;
      bit.goal = "phase 3: secure remaining orbs";
      nox.goal = "phase 3: secure remaining orbs";
    }
  }

  p3.progress = heldCount;
  // count human-held too
  if (human.holding) p3.progress = world.pickups.filter((p) => p.heldBy).length;
  if (p3.progress >= 3 && !p3.done) {
    p3.done = true;
    sfx.goal();
    toast("All orbs secured!", "good");
    markHighlight("orbs", bit.x, bit.y);
    slowMo = 1.0;
  }

  // advance phase soft if stuck
  if (phase === 1 && p1.done) phase = 2;
  if (phase === 2 && p2.done) phase = 3;

  if (p1.done && p2.done && p3.done) {
    triggerWin("Orb heist complete — all phases cleared.");
  }

  renderGoals();
  renderRelations();
  updateObjectiveHUD();
}

function updateQuests() {
  updatePhase();
  for (const a of agents) {
    const r = roomAt(world, a.x, a.y);
    if (r && a._lastRoom !== r.id) {
      if (a._lastRoom) toast(`${a.name} → ${r.name}`);
      a._lastRoom = r.id;
    }
  }
  saveMemory();
}

function markHighlight(kind, x, y) {
  highlightEvents.push({ t: world.time, kind, x, y });
}

function triggerWin(msg) {
  if (won) return;
  won = true;
  running = false;
  sfx.win();
  winHeading.textContent = "Mission complete";
  winText.textContent = msg;
  winStats.textContent = `Time left ${fmtTime(scenarioLeft)} · Bit↔Nox ${relations.bit_nox.toFixed(2)} · brain ${brainMode}`;
  winModal.classList.remove("hidden");
  persistReplay();
  toast("MISSION COMPLETE", "good");
  slowMo = 1.5;
}

// ── Speech ──────────────────────────────────────────────────
function trySay(agent, text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  agent.lastSaid = msg.slice(0, 100);
  logSpeech(agent.name, agent.lastSaid, agent.cssClass, agent);
  for (const other of agents) {
    if (other.id === agent.id) continue;
    if (dist(agent, other) > HEAR_RANGE) continue;
    if (!hasLOS(world, agent.x, agent.y, other.x, other.y)) continue;
    remember(other, `heard <${agent.name}> ${msg.slice(0, 36)}`);
  }
  rememberLong(agent, `said: ${msg.slice(0, 40)}`);
}

// ── Movement / actions ──────────────────────────────────────
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
    agent.intent = { vx: 0, vy: 0, remaining: n * STEP_PX * 1.5, label: move, skill: move };
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
  } else {
    const map = {
      upleft: [-0.707, -0.707],
      upright: [0.707, -0.707],
      downleft: [-0.707, 0.707],
      downright: [0.707, 0.707],
    };
    if (map[move]) {
      vx = map[move][0];
      vy = map[move][1];
      setAngle(agent, Math.atan2(vy, vx));
    }
  }
  agent.intent = { vx, vy, remaining: n * STEP_PX, label: move, skill: null };
  agent.moving = true;
}

function failFx(agent, reason) {
  agent.envEvents.push(reason);
  sfx.fail(agent.x, agent.y);
  spawnFlash(world, agent.x, agent.y, "#f44", 28);
  spawnParticle(world, agent.x, agent.y, "#f66", 6);
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
    }, 1000);
    return;
  }
  if (act === "grab") {
    // agents grab world orbs; also can take from human if close
    if (agent.holding) return failFx(agent, "already holding");
    if (human.holding && dist(agent, human) < 45) {
      agent.holding = human.holding;
      agent.holding.heldBy = agent.id;
      human.holding = null;
      sfx.grab(agent.x, agent.y);
      spawnParticle(world, agent.x, agent.y, agent.holding.color, 10);
      toast(`${agent.name} took orb from you`, "good");
      updateQuests();
      return;
    }
    const p = nearestFreePickup(world, agent.x, agent.y, GRAB_RANGE);
    if (!p) return failFx(agent, "grab failed");
    p.heldBy = agent.id;
    agent.holding = p;
    sfx.grab(agent.x, agent.y);
    sfx.success(agent.x, agent.y);
    spawnParticle(world, agent.x, agent.y, p.color, 14);
    spawnFlash(world, agent.x, agent.y, p.color, 48);
    markHighlight("grab", agent.x, agent.y);
    slowMo = Math.max(slowMo, 0.65);
    juicePop();
    toast(`${agent.name} grabbed ${p.id}`, "good");
    rememberLong(agent, `got ${p.id}`);
    setThought(agent, "GOT");
    updateQuests();
    return;
  }
  if (act === "drop") {
    if (!agent.holding) return failFx(agent, "empty hands");
    const p = agent.holding;
    p.heldBy = null;
    p.x = agent.x + Math.cos(agent.angle) * 22;
    p.y = agent.y + Math.sin(agent.angle) * 22;
    agent.holding = null;
    sfx.drop(agent.x, agent.y);
    spawnParticle(world, p.x, p.y, p.color, 6);
    updateQuests();
    return;
  }
  if (act === "use") {
    const prop = nearestProp(world, agent.x, agent.y, 42);
    if (!prop) return failFx(agent, "no prop");
    sfx.success(agent.x, agent.y);
    spawnParticle(world, prop.x, prop.y, "#ff5", 8);
    if (prop.id === "coffee") trySay(agent, "fuel acquired");
    if (prop.id === "terminal") trySay(agent, "heist protocol online");
  }
}

function setThought(agent, text) {
  if (!text) return;
  agent.thought = String(text).slice(0, 8).toUpperCase();
  agent.thoughtT = 1.1;
}

function applyAction(agent, action) {
  if (!action) return;
  agent.lastAction = action;
  agent.hybrid = action._hybrid || action._src || "";
  if (action.goal) agent.goal = String(action.goal).slice(0, 80);
  if (action.mood && MOODS.has(String(action.mood))) agent.mood = String(action.mood);
  if (action.see) agent.lastSaw = String(action.see).slice(0, 120);

  if (action.thought) setThought(agent, action.thought);
  else if (action.act === "grab") setThought(agent, "GRAB");
  else if (action.move === "toward" || action.move === "follow") setThought(agent, "MEET");
  else if (action._nav) setThought(agent, "SEEK");
  else if (action.move && action.move !== "idle") setThought(agent, action.move.slice(0, 6));

  const face = action._face != null ? action._face : null;
  if (face != null) setAngle(agent, face);

  if (action.look_at && action.look_at !== "none") {
    const t = resolveLook(agent, action.look_at);
    if (t) setAngle(agent, Math.atan2(t.y - agent.y, t.x - agent.x));
  }

  // Wall-aware navigation target
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
  } else if (action.move === "nav" && !action._nav) {
    issueMove(agent, "idle", 0, face);
  } else {
    clearNav(agent);
    issueMove(agent, action.move || "idle", action.steps ?? 3, face);
  }

  if (action.act) applyAct(agent, action.act);
  if (action.say) trySay(agent, action.say);
  remember(agent, `${agent.hybrid || "?"} ${agent.move} ${action.act || ""}`.trim());
}

function resolveLook(agent, ref) {
  const r = String(ref).toLowerCase();
  if (r === "other") return agent === bit ? nox : bit;
  if (r === "bit") return bit;
  if (r === "nox") return nox;
  if (r === "human" || r === "you") return human;
  if (r === "beacon" && world.beacon) return world.beacon;
  if (r.startsWith("prop:")) return world.props.find((p) => p.id === r.slice(5));
  return null;
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
    phase,
    callPulse,
    forceHeuristic: brainMode === "heuristic",
    heuristicOnly: brainMode === "heuristic",
    assignTarget: human.assign && human.assign.forAgent === agent.id ? human.assign : human.assign,
  };
}

// compact prompt: top 3 visibles only
function buildPrompt(agent, truth) {
  const top = [];
  truth.entities.slice(0, 2).forEach((e) => top.push(`${e.name}@${e.d}`));
  truth.orbs.slice(0, 2).forEach((o) => top.push(`ORB ${o.id}@${o.d}`));
  truth.props.slice(0, 1).forEach((p) => top.push(p.id));
  const visible = top.join(", ") || "empty FOV";
  const other = agent === bit ? nox : bit;

  return (
    `You are ${agent.name}. Camera faces UP. Yellow=YOU. Phase ${phase}/3 heist.\n` +
    `VISIBLE (max 3): ${visible}\n` +
    `hold=${agent.holding?.id || "none"} partner_hold=${other.holding?.id || "none"} room=${truth.room}\n` +
    `JSON only: {"see":"brief","move":"forward|toward|follow_human|goto_beacon|idle","steps":2-5,"act":"none|grab|wave","say":""}`
  );
}

async function localVlmInfer(dataUrl, prompt) {
  const image = await RawImage.fromURL(dataUrl);
  const messages = [{
    role: "user",
    content: [{ type: "image" }, { type: "text", text: prompt }],
  }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, [image], {});
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 80,
    do_sample: true,
    temperature: 0.4,
    top_p: 0.85,
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
      max_tokens: 120,
      temperature: 0.4,
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
  // top-3 only in truth string for scoring
  const slim = {
    room: truth.room,
    entities: truth.entities.slice(0, 2),
    props: truth.props.slice(0, 1),
    orbs: truth.orbs.slice(0, 2),
  };
  agent.lastTruth = truthToString(slim);

  const ctx = plannerCtx(agent);

  // Heuristic-only: skip VLM entirely
  if (brainMode === "heuristic" || !model || model.remoteOnly && !window.HANGOUT_VLM?.apiKey) {
    const p = planFromTruth(agent, other, human, world, ctx);
    agent.seeScore = 1;
    agent.lastSaw = p.see;
    agent.lastRaw = "[heuristic]";
    return hybridDecide(null, 0, agent, other, human, world, { ...ctx, forceHeuristic: true });
  }

  // Capture vision
  const dataUrl = captureEgocentric(visionCanvas, world, agent, others, agent.frameHistory);
  await pushFrameHistory(agent.frameHistory, dataUrl, 2);
  visionMeta.textContent = `${agent.name} · ${agent.hybrid || brainMode} · see ${((agent.seeScore * 100) | 0)}%`;

  let vlmAction = null;
  let raw = "";

  if (brainMode !== "heuristic") {
    const prompt = buildPrompt(agent, slim);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (window.HANGOUT_VLM?.apiKey) raw = (await remoteVlmInfer(dataUrl, prompt)) || "";
        if (!raw && processor && model && !model.remoteOnly) raw = await localVlmInfer(dataUrl, prompt);
        if (!raw) break;
        agent.lastRaw = raw.slice(0, 300);
        vlmAction = parseAction(raw);
        if (vlmAction) break;
      } catch (err) {
        if (attempt === MAX_RETRIES) console.warn(err);
      }
    }
  }

  const seeScore = vlmAction ? scoreSee(vlmAction.see, slim) : 0;
  agent.seeScore = seeScore;
  if (vlmAction) agent.lastSaw = vlmAction.see || "";

  // Debug stub: inject perfect vision half the time when D and shift held — via window flag
  if (window.HANGOUT_VISION_STUB) {
    agent.seeScore = 1;
    agent.lastSaw = agent.lastTruth;
  }

  return hybridDecide(vlmAction, seeScore, agent, other, human, world, ctx);
}

// ── Simulation ──────────────────────────────────────────────
function skillStep(agent, dt) {
  const intent = agent.intent;
  if (!intent?.skill) return false;
  const other = agent === bit ? nox : bit;
  const sp = MOVE_SPEED * agent.speedMul * dt;
  let tx = agent.x;
  let ty = agent.y;

  const aim = (x, y, stopD = 45) => {
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
    const ang = Math.atan2(agent.y - other.y, agent.x - other.x) + dt * 1.7;
    tx = other.x + Math.cos(ang) * 70;
    ty = other.y + Math.sin(ang) * 70;
    setAngle(agent, Math.atan2(other.y - agent.y, other.x - agent.x));
  } else if (intent.skill === "follow") aim(other.x, other.y);
  else if (intent.skill === "follow_human") aim(human.x, human.y, 40);
  else if (intent.skill === "goto_beacon" && world.beacon) aim(world.beacon.x, world.beacon.y, 24);
  else if (intent.skill === "patrol_edge") {
    if (!intent._pvx) {
      intent._pvx = 1;
      intent._pvy = 0;
    }
    tx = agent.x + intent._pvx * sp;
    ty = agent.y + intent._pvy * sp;
  } else return false;

  const res = moveWithCollision(world, agent.x, agent.y, tx, ty, 14);
  if (res.hit) {
    sfx.bump(agent.x, agent.y);
    spawnFlash(world, agent.x, agent.y, "#f84", 20);
    if (intent.skill === "patrol_edge") {
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      const p = dirs[Math.floor(Math.random() * 4)];
      intent._pvx = p[0];
      intent._pvy = p[1];
    }
    agent.envEvents.push(`blocked:${res.hit}`);
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
  }
  return true;
}

function simulateAgent(agent, dt) {
  if (agent.thoughtT > 0) agent.thoughtT -= dt;

  // Prefer pathfinding nav
  if (agent.navPath && agent.navPath.length) {
    const still = followNav(world, agent, dt, MOVE_SPEED * agent.speedMul, moveWithCollision);
    if (agent.holding) {
      agent.holding.x = agent.x;
      agent.holding.y = agent.y;
    }
    if (still) {
      stepSfx(agent);
      return;
    }
  }

  if (skillStep(agent, dt)) {
    stepSfx(agent);
    return;
  }
  const intent = agent.intent;
  if (!intent || intent.remaining <= 0 || (intent.vx === 0 && intent.vy === 0)) {
    agent.moving = false;
    return;
  }
  const step = Math.min(intent.remaining, MOVE_SPEED * agent.speedMul * dt);
  const res = moveWithCollision(
    world,
    agent.x,
    agent.y,
    agent.x + intent.vx * step,
    agent.y + intent.vy * step,
    14
  );
  let fx = res.x;
  let fy = res.y;
  const other = agent === bit ? nox : bit;
  for (const o of [other, human]) {
    const d = Math.hypot(fx - o.x, fy - o.y);
    const minD = o.kind === "human" ? 26 : 28;
    if (d < minD && d > 0.01) {
      const push = (minD - d) / d;
      fx += (fx - o.x) * push * 0.45;
      fy += (fy - o.y) * push * 0.45;
    }
  }
  if (res.hit) {
    sfx.bump(agent.x, agent.y);
    spawnFlash(world, agent.x, agent.y, "#f84", 22);
    agent.envEvents.push(`blocked:${res.hit}`);
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
  if (agent.holding) {
    agent.holding.x = agent.x;
    agent.holding.y = agent.y;
  }
  stepSfx(agent);
}

function stepSfx(agent) {
  const now = performance.now();
  if (now - (lastStepSfx[agent.id] || 0) > 190) {
    const muted = !hasLOS(world, agent.x, agent.y, human.x, human.y);
    sfx.step(agent.x, agent.y, muted);
    lastStepSfx[agent.id] = now;
  }
}

function simulateHuman(dt) {
  if (human.thoughtT > 0) human.thoughtT -= dt;
  // follow drawn path with wall collision
  if (human.path.length) {
    const t = human.path[0];
    const dx = t.x - human.x;
    const dy = t.y - human.y;
    const L = Math.hypot(dx, dy) || 1;
    const sp = 165 * dt;
    if (L < 10) human.path.shift();
    else {
      const res = moveWithCollision(
        world,
        human.x,
        human.y,
        human.x + (dx / L) * sp,
        human.y + (dy / L) * sp,
        12
      );
      human.x = res.x;
      human.y = res.y;
      human.angle = Math.atan2(dy, dx);
      human.facing = Math.cos(human.angle) >= 0 ? 1 : -1;
      human.walkPhase += dt * 14;
      human.moving = true;
    }
  } else {
    human.moving = false;
  }
  if (human.holding && !throws.some((th) => th.orb === human.holding)) {
    human.holding.x = human.x;
    human.holding.y = human.y;
  }

  // flying orbs
  for (let i = throws.length - 1; i >= 0; i--) {
    const th = throws[i];
    th.life -= dt;
    th.x += th.vx * dt;
    th.y += th.vy * dt;
    th.orb.x = th.x;
    th.orb.y = th.y;
    // catch by agents
    for (const a of agents) {
      if (a.holding) continue;
      if (Math.hypot(a.x - th.x, a.y - th.y) < 28) {
        a.holding = th.orb;
        th.orb.heldBy = a.id;
        throws.splice(i, 1);
        sfx.grab(a.x, a.y);
        spawnParticle(world, a.x, a.y, th.orb.color, 10);
        juicePop(0.35);
        toast(`${a.name} caught the orb!`, "good");
        setThought(a, "CATCH");
        updateQuests();
        th._done = true;
        break;
      }
    }
    if (th._done) continue;
    if (th.life <= 0 || th.x < 20 || th.y < 20 || th.x > WORLD_W - 20 || th.y > WORLD_H - 20) {
      th.orb.heldBy = null;
      th.orb.x = Math.max(40, Math.min(WORLD_W - 40, th.x));
      th.orb.y = Math.max(40, Math.min(WORLD_H - 40, th.y));
      throws.splice(i, 1);
      spawnParticle(world, th.orb.x, th.orb.y, th.orb.color, 8);
    }
  }
}

function throwOrb() {
  if (!human.holding) {
    toast("Nothing to throw — grab an orb first (F)", "bad");
    return;
  }
  const orb = human.holding;
  // throw toward nearer agent or facing
  let tx = human.x + Math.cos(human.angle || 0) * 120;
  let ty = human.y + Math.sin(human.angle || 0) * 120;
  const nearer = dist(human, bit) <= dist(human, nox) ? bit : nox;
  if (dist(human, nearer) < 280) {
    tx = nearer.x;
    ty = nearer.y;
  }
  const dx = tx - human.x;
  const dy = ty - human.y;
  const L = Math.hypot(dx, dy) || 1;
  const speed = 220;
  orb.heldBy = "air";
  human.holding = null;
  throws.push({
    x: human.x,
    y: human.y,
    vx: (dx / L) * speed,
    vy: (dy / L) * speed,
    orb,
    life: 2.2,
  });
  sfx.drop(human.x, human.y);
  juicePop(0.3);
  spawnParticle(world, human.x, human.y, orb.color, 8);
  toast(`Threw ${orb.id}!`, "good");
  human.thought = "THROW";
  human.thoughtT = 0.8;
}

function tickNode(dt) {
  const n = world.node;
  n.phase += dt;
  const path = [[700, 450], [850, 420], [820, 520], [680, 500]];
  const [tx, ty] = path[Math.floor(n.phase / 3) % path.length];
  const dx = tx - n.x;
  const dy = ty - n.y;
  const L = Math.hypot(dx, dy) || 1;
  n.x += (dx / L) * 42 * dt;
  n.y += (dy / L) * 42 * dt;
}

function failForwardHint(dt) {
  hintTimer -= dt;
  if (hintTimer > 0) return;
  hintTimer = 40 + Math.random() * 15;
  // Node pings nearest free orb as soft beacon
  const free = world.pickups.filter((p) => !p.heldBy);
  if (!free.length) return;
  const orb = free[Math.floor(Math.random() * free.length)];
  world.beacon = { x: orb.x, y: orb.y, t: 12 };
  logSpeech("Node", `ping: ${orb.id} signature`, "node", world.node);
  toast(`Node pinged ${orb.id}`, "good");
  sfx.beacon(orb.x, orb.y);
  for (const a of agents) a.envEvents.push(`hint beacon on ${orb.id}`);
}

// ── Camera ──────────────────────────────────────────────────
function updateCamera(dt) {
  if (spectator) {
    cam.tx = (bit.x + nox.x) / 2;
    cam.ty = (bit.y + nox.y) / 2;
    // zoom when close together
    const d = dist(bit, nox);
    cam.tz = d < 120 ? 1.35 : d < 250 ? 1.15 : 1.0;
  } else {
    cam.tx = WORLD_W / 2;
    cam.ty = WORLD_H / 2;
    cam.tz = 1;
  }
  // ease
  cam.x += (cam.tx - cam.x) * Math.min(1, dt * 3);
  cam.y += (cam.ty - cam.y) * Math.min(1, dt * 3);
  cam.zoom += (cam.tz - cam.zoom) * Math.min(1, dt * 2);
}

function targetOrbIds() {
  const ids = new Set();
  for (const p of world.pickups) {
    if (!p.heldBy) ids.add(p.id);
  }
  return ids;
}

function targetLines() {
  const lines = [];
  for (const a of agents) {
    if (a.holding) continue;
    const orb = nearestFreePickup(world, a.x, a.y, 9999);
    if (orb) {
      lines.push({
        x0: a.x,
        y0: a.y,
        x1: orb.x,
        y1: orb.y,
        color: a.id === "bit" ? "rgba(110,198,255,0.35)" : "rgba(255,122,110,0.35)",
      });
    }
  }
  if (human.assign) {
    const t = human.assign;
    const agent = t.forAgent === "nox" ? nox : bit;
    lines.push({
      x0: agent.x,
      y0: agent.y,
      x1: t.x,
      y1: t.y,
      color: "rgba(80,255,80,0.5)",
    });
  }
  return lines;
}

function entityList() {
  return [
    {
      ...bit,
      moodColor: moodColor(bit),
      showFov: debugOn,
      fovRad: Math.PI * 0.55,
      thought: bit.thoughtT > 0 ? bit.thought : "",
      statusLine: `${bit.hybrid || brainMode} · ${bit.move}`,
    },
    {
      ...nox,
      moodColor: moodColor(nox),
      showFov: debugOn,
      fovRad: Math.PI * 0.55,
      thought: nox.thoughtT > 0 ? nox.thought : "",
      statusLine: `${nox.hybrid || brainMode} · ${nox.move}`,
    },
    { id: "node", name: "Node", kind: "node", x: world.node.x, y: world.node.y, color: world.node.color },
    {
      ...human,
      thought: human.thoughtT > 0 ? human.thought : "",
    },
  ];
}

function paint() {
  const camOpt = spectator ? { x: cam.x, y: cam.y, zoom: cam.zoom } : null;
  drawWorld(wctx, worldCanvas, world, entityList(), {
    camera: camOpt,
    targetOrbIds: targetOrbIds(),
    targetLines: targetLines(),
    path: human.path,
    juice,
  });
  // juice vignette overlay in screen space
  if (juice > 0) {
    wctx.save();
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.fillStyle = `rgba(180,255,200,${juice * 0.18})`;
    wctx.fillRect(0, 0, worldCanvas.width, worldCanvas.height);
    wctx.restore();
  }
  mctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  drawMinimap(mctx, 0, 0, minimapCanvas.width, minimapCanvas.height, world, entityList());
  if (debugOn) {
    dbgBody.textContent = [
      `brain=${brainMode} phase=${phase} cam=${spectator ? "spectator" : "wide"}`,
      `Bit see=${((bit.seeScore * 100) | 0)}% hybrid=${bit.hybrid} ${bit.move} hold=${bit.holding?.id || "-"}`,
      `Nox see=${((nox.seeScore * 100) | 0)}% hybrid=${nox.hybrid} ${nox.move} hold=${nox.holding?.id || "-"}`,
      `truth: ${bit.lastTruth || "—"}`,
      `see: ${bit.lastSaw || "—"}`,
      `raw: ${bit.lastRaw || "—"}`,
      `assign: ${JSON.stringify(human.assign)}`,
      `path pts: ${human.path.length} replay: ${replayLog.length}`,
    ].join("\n");
  }
}

// ── Replay / reel ───────────────────────────────────────────
function sampleReplay() {
  if (replayPlaying || reelPlaying) return;
  if (replayLog.length > 3500) replayLog.shift();
  replayLog.push({
    t: world.time,
    bit: { x: bit.x, y: bit.y, a: bit.angle, h: bit.holding?.id },
    nox: { x: nox.x, y: nox.y, a: nox.angle, h: nox.holding?.id },
    human: { x: human.x, y: human.y },
    phase,
  });
}
function persistReplay() {
  try {
    localStorage.setItem(REPLAY_KEY, JSON.stringify({
      frames: replayLog.slice(-1200),
      highlights: highlightEvents.slice(-40),
    }));
  } catch {
    /* */
  }
}

async function playHighlightReel() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(REPLAY_KEY) || "{}");
  } catch {
    data = {};
  }
  const frames = data.frames || replayLog;
  const highs = data.highlights || highlightEvents;
  if (!frames.length) {
    toast("No reel yet — play a bit first", "bad");
    return;
  }
  winModal.classList.add("hidden");
  toast("Highlight reel…");
  reelPlaying = true;
  running = false;
  spectator = true;

  // Prefer windows around highlight events; else subsample
  let picks = [];
  if (highs.length) {
    for (const h of highs) {
      const near = frames.filter((f) => Math.abs(f.t - h.t) < 2.5);
      picks.push(...near);
    }
  }
  if (picks.length < 30) {
    const step = Math.max(1, Math.floor(frames.length / 80));
    picks = frames.filter((_, i) => i % step === 0);
  }
  picks = picks.slice(0, 120);

  for (const frame of picks) {
    bit.x = frame.bit.x;
    bit.y = frame.bit.y;
    bit.angle = frame.bit.a;
    nox.x = frame.nox.x;
    nox.y = frame.nox.y;
    nox.angle = frame.nox.a;
    human.x = frame.human.x;
    human.y = frame.human.y;
    cam.tx = (bit.x + nox.x) / 2;
    cam.ty = (bit.y + nox.y) / 2;
    cam.x = cam.tx;
    cam.y = cam.ty;
    cam.zoom = 1.25;
    paint();
    await new Promise((r) => setTimeout(r, 55));
  }
  reelPlaying = false;
  if (!won) running = true;
  toast("Reel done", "good");
}

// ── Loops ───────────────────────────────────────────────────
function motorLoop(now) {
  let dt = Math.min(0.05, (now - (lastMotor || now)) / 1000);
  lastMotor = now;

  // slow-mo
  if (slowMo > 0) {
    dt *= 0.35;
    slowMo -= dt / 0.35;
  }
  if (juice > 0) juice = Math.max(0, juice - dt * 1.8);

  world.time += dt;
  updateCamera(dt);

  if (running && !won && !replayPlaying && !reelPlaying) {
    scenarioTimerEl.textContent = fmtTime(scenarioLeft);
    scenarioTimerEl.classList.toggle("urgent", scenarioLeft < 25);
    if (scenarioLeft <= 0) {
      scenarioLeft = 0;
      running = false;
      winHeading.textContent = "Time up";
      winText.textContent = "The heist window closed.";
      winStats.textContent = `Orbs held ${world.pickups.filter((p) => p.heldBy).length}/3 · phase ${phase}`;
      winModal.classList.remove("hidden");
      persistReplay();
      toast("Time up", "bad");
    }

    if (callPulse > 0) callPulse -= dt;
    for (const a of agents) simulateAgent(a, dt);
    simulateHuman(dt);
    tickNode(dt);
    tickFX(world, dt);
    failForwardHint(dt);
    setListener(human.x, human.y);
    if (Math.floor(world.time * 5) !== Math.floor((world.time - dt) * 5)) sampleReplay();
    updateQuests();
  }

  paint();
  requestAnimationFrame(motorLoop);
}

let lastScenarioWall = performance.now();
function scenarioTick(now) {
  const wallDt = Math.min(0.1, (now - lastScenarioWall) / 1000);
  lastScenarioWall = now;
  if (running && !won && !replayPlaying && !reelPlaying) {
    const scale = slowMo > 0 ? 0.35 : 1;
    scenarioLeft -= wallDt * scale;
    if (scenarioLeft < 0) scenarioLeft = 0;
  }
  requestAnimationFrame(scenarioTick);
}

async function think(agent) {
  if (!running || won || reelPlaying) return;
  agent.ticks += 1;
  agent.mood = "think";
  setStatus(`${agent.name} · ${brainMode}…`, "warn");
  try {
    const action = await decideAction(agent);
    if (running && !won) applyAction(agent, action);
    setStatus(
      `${agent.name} · ${agent.hybrid || brainMode} · see${((agent.seeScore * 100) | 0)}% · ${agent.move}`,
      ""
    );
    setTimeout(() => {
      statusEl.style.opacity = "0.4";
    }, 1800);
  } catch (err) {
    console.error(err);
    // hard fallback
    const action = planFromTruth(agent, agent === bit ? nox : bit, human, world, plannerCtx(agent));
    applyAction(agent, action);
    setStatus(`${agent.name} · planner rescue`, "warn");
  }
}

async function vlaLoop() {
  let i = 0;
  while (true) {
    if (!running || won || !model) {
      await new Promise((r) => setTimeout(r, 300));
      // still run heuristic if no model
      if (running && !won && !model) {
        const a = agents[i % 2];
        applyAction(a, planFromTruth(a, a === bit ? nox : bit, human, world, plannerCtx(a)));
        i++;
      }
      continue;
    }
    await think(agents[i % agents.length]);
    i++;
    await new Promise((r) => setTimeout(r, brainMode === "heuristic" ? 280 : VLA_GAP_MS));
  }
}

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  updateBrainLabel();
  if (model) return;

  progressEl.style.display = "block";
  setStatus("loading brain…", "warn");

  // Heuristic works without WebGPU
  if (brainMode === "heuristic") {
    model = { remoteOnly: true, heuristic: true };
    modelId = "heuristic";
    progressEl.style.display = "none";
    toast("Heuristic brain — no VLM", "good");
    finishBoot();
    return;
  }

  if (!navigator.gpu && !window.HANGOUT_VLM?.apiKey) {
    setStatus("No WebGPU — switching to heuristic. Click status to retry VLM.", "err");
    brainMode = "heuristic";
    updateBrainLabel();
    model = { remoteOnly: true, heuristic: true };
    modelId = "heuristic";
    progressEl.style.display = "none";
    finishBoot();
    return;
  }

  if (navigator.gpu) {
    for (const id of MODEL_CANDIDATES) {
      try {
        setStatus(`loading ${id.split("/").pop()}…`, "warn");
        processor = await AutoProcessor.from_pretrained(id, {
          progress_callback: (p) => {
            if (p?.progress != null) progressBar.style.width = `${p.progress * 40}%`;
          },
        });
        model = await AutoModelForVision2Seq.from_pretrained(id, {
          dtype: "fp32",
          device: "webgpu",
          progress_callback: (p) => {
            if (p?.progress != null) progressBar.style.width = `${40 + p.progress * 60}%`;
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
    model = { remoteOnly: true, heuristic: true };
    modelId = "heuristic";
    toast("VLM failed — heuristic mode", "bad");
  }

  progressBar.style.width = "100%";
  setTimeout(() => {
    progressEl.style.display = "none";
  }, 300);
  finishBoot();
}

function finishBoot() {
  sfx.boot();
  trySay(bit, "phase one — grab an orb.");
  trySay(nox, "race you.");
  toast("Phase 1: each grab an orb", "good");
  showPhaseBanner("PHASE 1", "Each grab an orb");
  updateObjectiveHUD();
  setStatus(`online · ${modelId}`, "");
  const onboard = document.getElementById("onboard");
  if (onboard) {
    onboard.classList.remove("hidden");
    const dismiss = () => {
      onboard.classList.add("hidden");
      unlockAudio();
    };
    onboard.querySelector("button")?.addEventListener("click", dismiss, { once: true });
    setTimeout(dismiss, 12000);
  }
}

function cycleBrain() {
  const order = ["hybrid", "heuristic", "vlm"];
  brainMode = order[(order.indexOf(brainMode) + 1) % order.length];
  updateBrainLabel();
  saveMemory();
  toast(`Brain: ${brainMode}`, "good");
  // if switching to vlm/hybrid and no model, boot
  if (brainMode !== "heuristic" && (!model || model.heuristic)) {
    model = null;
    boot();
  }
}

function resetGame() {
  world = createWorld();
  Object.assign(bit, {
    x: 160, y: 180, angle: 0, holding: null, memory: [],
    intent: { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null },
    goal: "phase 1: grab an orb",
  });
  Object.assign(nox, {
    x: 780, y: 180, angle: Math.PI, holding: null, memory: [],
    intent: { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null },
    goal: "phase 1: grab an orb",
  });
  human.holding = null;
  human.path = [];
  human.assign = null;
  for (const q of quests) {
    q.progress = 0;
    q.done = false;
  }
  phase = 1;
  scenarioLeft = SCENARIO_SECS;
  won = false;
  running = true;
  replayLog.length = 0;
  highlightEvents.length = 0;
  hintTimer = 45;
  winModal.classList.add("hidden");
  toast("New heist — Phase 1", "good");
  renderGoals();
}

// ── Human input ─────────────────────────────────────────────
let drawing = false;

function worldPos(e) {
  const rect = worldCanvas.getBoundingClientRect();
  const camOpt = spectator ? { x: cam.x, y: cam.y, zoom: cam.zoom } : null;
  const clientX = e.clientX ?? e.touches?.[0]?.clientX;
  const clientY = e.clientY ?? e.touches?.[0]?.clientY;
  return screenToWorld(worldCanvas, clientX - rect.left, clientY - rect.top, camOpt);
}

function pickEntityAt(wx, wy) {
  for (const p of world.pickups) {
    if (!p.heldBy && Math.hypot(p.x - wx, p.y - wy) < 22) return { kind: "orb", id: p.id, x: p.x, y: p.y };
  }
  if (Math.hypot(bit.x - wx, bit.y - wy) < 24) return { kind: "agent", id: "bit", x: bit.x, y: bit.y };
  if (Math.hypot(nox.x - wx, nox.y - wy) < 24) return { kind: "agent", id: "nox", x: nox.x, y: nox.y };
  return null;
}

worldCanvas.addEventListener("pointerdown", (e) => {
  unlockAudio();
  worldCanvas.setPointerCapture(e.pointerId);
  const p = worldPos(e);
  const ent = pickEntityAt(p.x, p.y);

  if (ent) {
    // assign target: click orb/agent — prefer closer agent or alternate
    const forAgent = dist(bit, p) <= dist(nox, p) ? "bit" : "nox";
    human.assign = { forAgent, kind: ent.kind, id: ent.id, x: ent.x, y: ent.y };
    toast(`Assigned ${ent.kind} → ${forAgent}`, "good");
    const a = forAgent === "bit" ? bit : nox;
    a.envEvents.push(`human assigned ${ent.kind} ${ent.id}`);
    // instant planner nudge
    applyAction(a, planFromTruth(a, a === bit ? nox : bit, human, world, plannerCtx(a)));
    drawing = false;
    return;
  }

  // start path
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

worldCanvas.addEventListener("pointerup", () => {
  drawing = false;
});

function tryHandoff() {
  // F: if human near agent, transfer orb either way
  for (const a of agents) {
    if (dist(a, human) > 48) continue;
    if (human.holding && !a.holding) {
      a.holding = human.holding;
      a.holding.heldBy = a.id;
      human.holding = null;
      toast(`Gave ${a.holding.id} to ${a.name}`, "good");
      sfx.grab(a.x, a.y);
      updateQuests();
      return;
    }
    if (a.holding && !human.holding) {
      human.holding = a.holding;
      human.holding.heldBy = "you";
      a.holding = null;
      toast(`Took ${human.holding.id} from ${a.name}`, "good");
      sfx.grab(human.x, human.y);
      updateQuests();
      return;
    }
  }
  // pickup free orb
  if (!human.holding) {
    const p = nearestFreePickup(world, human.x, human.y, 36);
    if (p) {
      p.heldBy = "you";
      human.holding = p;
      toast(`You grabbed ${p.id}`, "good");
      sfx.grab(human.x, human.y);
      updateQuests();
      return;
    }
  } else {
    // drop
    const p = human.holding;
    p.heldBy = null;
    p.x = human.x;
    p.y = human.y;
    human.holding = null;
    sfx.drop(human.x, human.y);
    toast("Dropped orb");
    updateQuests();
  }
}

function doCall() {
  keys.q = true;
  callPulse = 2;
  sfx.call(human.x, human.y);
  toast("Calling…", "good");
  for (const a of agents) {
    a.envEvents.push("human CALL");
    setNavTo(world, a, human.x, human.y);
    setThought(a, "COME");
  }
  setTimeout(() => {
    keys.q = false;
  }, 400);
}

function doBeacon() {
  world.beacon = { x: human.x, y: human.y, t: 18 };
  sfx.beacon(human.x, human.y);
  spawnFlash(world, human.x, human.y, "#0f0", 40);
  toast("Beacon planted", "good");
  for (const a of agents) a.envEvents.push("beacon");
}

window.addEventListener("keydown", (e) => {
  unlockAudio();
  const k = e.key.toLowerCase();
  if (k === "d") {
    debugOn = !debugOn;
    debugEl.classList.toggle("hidden", !debugOn);
  }
  if (k === "c") {
    spectator = !spectator;
    toast(spectator ? "Spectator cam" : "Wide cam");
  }
  if (k === "q") doCall();
  if (k === "e") doBeacon();
  if (k === "f") tryHandoff();
  if (k === "t") throwOrb();
  if (k === "h") playHighlightReel();
  if (k === "r") playHighlightReel();
  if (k === "b") cycleBrain();
});

brainModeEl.addEventListener("click", cycleBrain);
statusEl.addEventListener("click", () => {
  if (statusEl.classList.contains("err")) {
    model = null;
    boot();
  }
});
winAgain.addEventListener("click", resetGame);
winReel.addEventListener("click", playHighlightReel);

document.getElementById("m-call")?.addEventListener("click", doCall);
document.getElementById("m-beacon")?.addEventListener("click", doBeacon);
document.getElementById("m-cam")?.addEventListener("click", () => {
  spectator = !spectator;
  toast(spectator ? "Spectator" : "Wide");
});
document.getElementById("m-brain")?.addEventListener("click", cycleBrain);

// ── Start ───────────────────────────────────────────────────
updateBrainLabel();
renderGoals();
renderRelations();
updateObjectiveHUD();
paint();
requestAnimationFrame(motorLoop);
requestAnimationFrame(scenarioTick);
boot().then(() => vlaLoop());
window.addEventListener("resize", () => paint());

window.hangout = {
  cycleBrain,
  reset: resetGame,
  reel: playHighlightReel,
  setBrain: (m) => {
    brainMode = m;
    updateBrainLabel();
  },
  stubVision: (on) => {
    window.HANGOUT_VISION_STUB = !!on;
  },
};
