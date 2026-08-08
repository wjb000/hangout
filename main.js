/**
 * Hangout — living social sim (major revision)
 * Multi-turn dialogue, energy/social needs, activities, day cycle.
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
import {
  createDialogue,
  tickSocialMeters,
  tickDialogue,
  planSocial,
  hybridSocial,
  endDialogue,
} from "./social.js";
import { setNavTo, clearNav, followNav } from "./pathfind.js";

const MODEL_CANDIDATES = [
  "HuggingFaceTB/SmolVLM-256M-Instruct",
  "HuggingFaceTB/SmolVLM-500M-Instruct",
];
const MOVE_SPEED = 112;
const HEAR_RANGE = 175;
const VLA_GAP_MS = 160;
const MEMORY_KEY = "hangout_living_v1";
const CHAT_MAX = 20;
const CHAT_FADE_MS = 16000;
const DAY_LEN = 180; // seconds per full day cycle

const MOVES = new Set([
  "forward", "back", "left", "right", "turn_left", "turn_right",
  "toward", "away", "idle", "wait", "nav",
  "orbit_other", "patrol_edge", "follow", "follow_human", "goto_beacon",
]);
const ACTS = new Set(["none", "use", "wave"]);

let brainMode = "hybrid";

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
const dayLabel = document.getElementById("day-label");
const topicBar = document.getElementById("topic-bar");
const topicText = document.getElementById("topic-text");

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
let cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1.1, tx: WORLD_W / 2, ty: WORLD_H / 2, tz: 1.1 };
let dayPhase = 0.35; // 0..1

const transcript = [];
const dialogue = createDialogue();

const human = {
  id: "you",
  name: "You",
  kind: "human",
  x: WORLD_W / 2,
  y: WORLD_H / 2 + 50,
  color: "#55ff88",
  headColor: "#c8ffe0",
  nameColor: "#6f6",
  angle: -Math.PI / 2,
  facing: 1,
  walkPhase: 0,
  moving: false,
  path: [],
  assign: null,
  thought: "",
  thoughtT: 0,
};

const relations = { bit_nox: 0.2, bit_you: 0.05, nox_you: 0.0 };

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
    activity: "roam",
    energy: 0.75,
    social: 0.5,
    boredom: 0.3,
    moodBias: "neutral",
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
    walkPhase: 0,
    moving: false,
    navPath: null,
    navIndex: 0,
    thought: "",
    thoughtT: 0,
    activityT: 0,
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
  persona: "warm curious cyan glitch who loves company and soft moments",
  x: 170,
  y: 170,
  angle: 0.2,
  goal: "find Nox and talk",
});

const nox = createAgent({
  id: "nox",
  name: "Nox",
  cssClass: "nox",
  color: "#ff7a6e",
  headColor: "#ffc4bc",
  nameColor: "#ff7a6e",
  persona: "dry coral glitch who pretends not to need people",
  x: 780,
  y: 210,
  angle: Math.PI,
  goal: "map the rooms, stay near Bit",
});

const agents = [bit, nox];

function loadMemory() {
  try {
    const data = JSON.parse(localStorage.getItem(MEMORY_KEY) || "{}");
    if (data.relations) Object.assign(relations, data.relations);
    if (data.brainMode) brainMode = data.brainMode;
    for (const a of agents) {
      if (data[a.id]?.longTerm) a.longTerm = data[a.id].longTerm.slice(-16);
    }
  } catch { /* */ }
}
function saveMemory() {
  try {
    const data = { relations: { ...relations }, brainMode };
    for (const a of agents) data[a.id] = { longTerm: a.longTerm.slice(-16) };
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
  setTimeout(() => el.classList.add("fade"), 2200);
  setTimeout(() => el.remove(), 3000);
}
function juicePop(a = 0.35) {
  juice = Math.max(juice, a);
}
function updateBrainLabel() {
  if (brainModeEl) brainModeEl.textContent = brainMode;
}
function dayName(p) {
  if (p < 0.2 || p >= 0.9) return "night";
  if (p < 0.35) return "dawn";
  if (p < 0.55) return "day";
  if (p < 0.72) return "afternoon";
  return "dusk";
}
function updateCards() {
  const set = (id, a) => {
    const e = document.getElementById(`${id}-energy`);
    const s = document.getElementById(`${id}-social`);
    const act = document.getElementById(`${id}-act`);
    const goal = document.getElementById(`${id}-goal`);
    if (e) e.style.width = `${Math.round(a.energy * 100)}%`;
    if (s) s.style.width = `${Math.round(a.social * 100)}%`;
    if (act) act.textContent = a.activity || a.move || "…";
    if (goal) goal.textContent = a.goal || "…";
  };
  set("bit", bit);
  set("nox", nox);

  if (dialogue.active && topicBar && topicText) {
    topicBar.classList.remove("hidden");
    topicText.textContent = dialogue.topic || "…";
  } else if (topicBar) {
    topicBar.classList.add("hidden");
  }

  if (dayLabel) dayLabel.textContent = dayName(dayPhase);
  if (relBar) {
    const f = (v) => (v > 0.35 ? "♥" : v < -0.15 ? "💢" : "·");
    relBar.textContent = `Bit↔Nox ${f(relations.bit_nox)} ${relations.bit_nox.toFixed(2)}`;
  }
}

function setThought(agent, text) {
  if (!text) return;
  agent.thought = String(text).slice(0, 8).toUpperCase();
  agent.thoughtT = 1.15;
}
function remember(a, line) {
  a.memory.push(line);
  if (a.memory.length > 10) a.memory.shift();
}
function rememberLong(a, line) {
  if (!line || a.longTerm[a.longTerm.length - 1] === line) return;
  a.longTerm.push(line);
  if (a.longTerm.length > 16) a.longTerm.shift();
  saveMemory();
}
function moodColor(a) {
  if (a.activity === "sit") return shadeSoft(a.color, 20);
  if (a.mood === "think" || a.activity === "work") return "#c9a0ff";
  if (a.mood === "happy" || a.mood === "wave") return "#7dffb3";
  if (a.mood === "curious") return "#ffe08a";
  if (a.moodBias === "tired") return shadeSoft(a.color, -30);
  return a.color;
}
function shadeSoft(hex, amt) {
  // simple fallback — world has shade but not exported
  return hex;
}
function bumpRelation(key, delta) {
  if (!(key in relations)) return;
  relations[key] = Math.max(-1, Math.min(1, relations[key] + delta));
  saveMemory();
}

function logSpeech(name, text, cssClass, pos = null) {
  const msg = String(text || "").trim();
  if (!msg) return;
  transcript.push({ name, text: msg, t: Date.now() });
  if (transcript.length > 30) transcript.shift();
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
  agent.lastSaid = msg.slice(0, 120);
  logSpeech(agent.name, agent.lastSaid, agent.cssClass, agent);
  for (const other of agents) {
    if (other.id === agent.id) continue;
    if (dist(agent, other) > HEAR_RANGE) continue;
    if (!hasLOS(world, agent.x, agent.y, other.x, other.y)) continue;
    remember(other, `heard <${agent.name}> ${msg.slice(0, 48)}`);
    if (/hey|hi|like|warm|miss|nice|thanks|cozy|friend/i.test(msg)) bumpRelation("bit_nox", 0.04);
    if (/hate|shut|leave|annoying|whatever\./i.test(msg)) bumpRelation("bit_nox", -0.03);
  }
  rememberLong(agent, `said: ${msg.slice(0, 56)}`);
}

// ── Move / act ─────────────────────────────────────────────
function setAngle(agent, ang) {
  agent.angle = Math.atan2(Math.sin(ang), Math.cos(ang));
  agent.facing = Math.cos(agent.angle) >= 0 ? 1 : -1;
}

function issueMove(agent, moveName, steps = 3, faceAng = null) {
  let move = String(moveName || "idle").toLowerCase().replace(/[\s-]+/g, "_");
  if (!MOVES.has(move)) move = "idle";
  if (faceAng != null) setAngle(agent, faceAng);
  const n = Math.max(0, Math.min(8, Number(steps) || 0));
  agent.move = move;

  if (move === "idle" || move === "wait" || n === 0) {
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
    agent.intent = { vx: 0, vy: 0, remaining: n * 42 * 1.3, label: move, skill: move };
    agent.moving = true;
    return;
  }

  let vx = 0, vy = 0;
  const o = agent === bit ? nox : bit;
  if (move === "forward") { vx = Math.cos(agent.angle); vy = Math.sin(agent.angle); }
  else if (move === "back") { vx = -Math.cos(agent.angle); vy = -Math.sin(agent.angle); }
  else if (move === "left") {
    vx = Math.cos(agent.angle - Math.PI / 2); vy = Math.sin(agent.angle - Math.PI / 2);
  } else if (move === "right") {
    vx = Math.cos(agent.angle + Math.PI / 2); vy = Math.sin(agent.angle + Math.PI / 2);
  } else if (move === "toward") {
    const dx = o.x - agent.x, dy = o.y - agent.y, L = Math.hypot(dx, dy) || 1;
    vx = dx / L; vy = dy / L; setAngle(agent, Math.atan2(dy, dx));
  } else if (move === "away") {
    const dx = agent.x - o.x, dy = agent.y - o.y, L = Math.hypot(dx, dy) || 1;
    vx = dx / L; vy = dy / L; setAngle(agent, Math.atan2(dy, dx));
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
    spawnParticle(world, agent.x, agent.y - 8, "#ffe08a", 6);
    setTimeout(() => { if (agent.emote === "wave") agent.emote = "none"; }, 900);
    return;
  }
  if (act === "use") {
    const prop = nearestProp(world, agent.x, agent.y, 48);
    if (!prop) return;
    sfx.success(agent.x, agent.y);
    spawnParticle(world, prop.x, prop.y, "#ff8", 8);
    juicePop(0.2);
    rememberLong(agent, `used ${prop.id}`);
    if (prop.id === "coffee") agent.energy = Math.min(1, agent.energy + 0.22);
  }
}

function applyAction(agent, action) {
  if (!action) return;
  agent.lastAction = action;
  agent.hybrid = action._hybrid || action._src || "";
  if (action.goal) agent.goal = String(action.goal).slice(0, 80);
  if (action.mood) agent.mood = action.mood;
  if (action.see) agent.lastSaw = String(action.see).slice(0, 100);
  if (action.activity) {
    agent.activity = action.activity;
    agent.activityT = 0;
  }
  if (action.energyBoost) agent.energy = Math.min(1, agent.energy + action.energyBoost);

  if (action.thought) setThought(agent, action.thought);
  else if (action.say) setThought(agent, "CHAT");
  else if (action._nav) setThought(agent, "GO");

  if (action.faceOther) {
    const o = agent === bit ? nox : bit;
    setAngle(agent, Math.atan2(o.y - agent.y, o.x - agent.x));
  }
  if (action.face != null) setAngle(agent, action.face);
  if (action._face != null) setAngle(agent, action._face);

  // Sitting/work stays put
  if (action.activity === "sit" || action.activity === "work") {
    clearNav(agent);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.moving = false;
    agent.move = "idle";
  } else if (action._nav) {
    clearNav(agent);
    setNavTo(world, agent, action._nav.x, action._nav.y);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "nav", skill: null };
  } else if (action.move === "toward") {
    const o = agent === bit ? nox : bit;
    setNavTo(world, agent, o.x, o.y);
  } else if (action.move === "follow_human") {
    setNavTo(world, agent, human.x, human.y);
  } else if (action.move === "goto_beacon" && world.beacon) {
    setNavTo(world, agent, world.beacon.x, world.beacon.y);
  } else {
    clearNav(agent);
    issueMove(agent, action.move || "idle", action.steps ?? 3);
  }

  if (action.act) applyAct(agent, action.act);
  if (action.say) trySay(agent, action.say);
  remember(agent, `${agent.activity} ${agent.move}`);
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
    if (obj.move) {
      let m = String(obj.move).toLowerCase().replace(/\s+/g, "_");
      if (!MOVES.has(m)) m = "idle";
      obj.move = m;
    }
    if (obj.act && !ACTS.has(String(obj.act))) obj.act = "none";
    if (obj.act === "grab" || obj.act === "drop") obj.act = "none";
    return obj;
  } catch {
    return null;
  }
}

function ctxFor(agent) {
  return {
    callPulse,
    forceHeuristic: brainMode === "heuristic",
    heuristicOnly: brainMode === "heuristic",
    assignTarget: human.assign,
    rel: relations.bit_nox,
  };
}

function buildPrompt(agent, truth) {
  const other = agent === bit ? nox : bit;
  const top = [];
  truth.entities.slice(0, 2).forEach((e) => top.push(`${e.name}@${e.d}`));
  truth.props.slice(0, 2).forEach((p) => top.push(p.id));
  const chat = transcript.slice(-5).map((m) => `<${m.name}> ${m.text}`).join(" | ");
  const topic = dialogue.active ? `TOPIC: ${dialogue.topic} (turn ${dialogue.turns}/${dialogue.maxTurns})` : "not in a conversation";

  return (
    `You are ${agent.name}. ${agent.persona}\n` +
    `Living hangout sim — no games. energy=${agent.energy.toFixed(2)} social=${agent.social.toFixed(2)} activity=${agent.activity}\n` +
    `SEE: ${top.join(", ") || "empty"} room=${truth.room} day=${dayName(dayPhase)}\n` +
    `${other.name} @${Math.round(dist(agent, other))}px said="${other.lastSaid || ""}" rel=${relations.bit_nox.toFixed(2)}\n` +
    `${topic}\nCHAT: ${chat || "silence"}\n` +
    `JSON only: {"see":"brief","move":"nav|toward|orbit_other|idle|follow_human","steps":2-5,"act":"none|wave|use","say":"max 12 words or empty","mood":"curious|happy|think","thought":"CHAT|GO|SIT|WORK","activity":"roam|chat|sit|work"}`
  );
}

async function localVlmInfer(dataUrl, prompt) {
  const image = await RawImage.fromURL(dataUrl);
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, [image], {});
  const outputs = await model.generate({
    ...inputs, max_new_tokens: 90, do_sample: true, temperature: 0.6, top_p: 0.9,
  });
  const decoded = processor.batch_decode(outputs, { skip_special_tokens: true });
  let raw = decoded[0] || "";
  if (raw.includes("Assistant:")) raw = raw.split("Assistant:").pop();
  return raw.trim();
}

async function remoteVlmInfer(dataUrl, prompt) {
  const cfg = window.HANGOUT_VLM;
  if (!cfg?.apiKey || !cfg?.baseUrl) return null;
  const res = await fetch(cfg.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model || "grok-2-vision-1212",
      max_tokens: 110,
      temperature: 0.55,
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
  const others = [
    other,
    human,
    { id: "node", name: "Node", kind: "node", x: world.node.x, y: world.node.y, color: world.node.color },
  ];
  const truth = visibleTruth(world, agent, others);
  const slim = {
    room: truth.room,
    entities: truth.entities.slice(0, 2),
    props: truth.props.slice(0, 2),
    orbs: [],
  };
  agent.lastTruth = truthToString(slim);
  const ctx = ctxFor(agent);

  // Stay in sit/work a while
  if ((agent.activity === "sit" || agent.activity === "work") && agent.activityT < 4 + Math.random() * 4) {
    if (agent.activity === "sit" && agent.energy > 0.85 && Math.random() < 0.15) {
      /* allow leave via planner below */
    } else if (agent.activityT < 3.5) {
      return {
        see: "truth:activity hold",
        move: "idle",
        steps: 0,
        act: agent.activity === "work" && Math.random() < 0.3 ? "use" : "none",
        say: "",
        mood: agent.activity === "work" ? "think" : "idle",
        thought: agent.activity === "sit" ? "SIT" : "WORK",
        activity: agent.activity,
        goal: agent.goal,
        _hybrid: "hold",
      };
    }
  }

  if (brainMode === "heuristic" || !model || model.heuristic) {
    agent.seeScore = 1;
    return hybridSocial(null, 0, agent, other, human, world, dialogue, {
      ...ctx, forceHeuristic: true,
    });
  }

  const dataUrl = captureEgocentric(visionCanvas, world, agent, others, agent.frameHistory);
  await pushFrameHistory(agent.frameHistory, dataUrl, 2);
  if (visionMeta) visionMeta.textContent = `${agent.name} · ${agent.activity}`;

  let vlmAction = null;
  let raw = "";
  try {
    const prompt = buildPrompt(agent, slim);
    if (window.HANGOUT_VLM?.apiKey) raw = (await remoteVlmInfer(dataUrl, prompt)) || "";
    if (!raw && processor && model && !model.remoteOnly) raw = await localVlmInfer(dataUrl, prompt);
    agent.lastRaw = (raw || "").slice(0, 280);
    vlmAction = parseAction(raw);
  } catch (err) {
    console.warn(err);
  }

  const seeScore = vlmAction ? scoreSee(vlmAction.see, slim) : 0;
  agent.seeScore = seeScore;
  if (vlmAction) agent.lastSaw = vlmAction.see || "";

  return hybridSocial(vlmAction, seeScore, agent, other, human, world, dialogue, ctx);
}

// ── Physics ─────────────────────────────────────────────────
function skillStep(agent, dt) {
  const intent = agent.intent;
  if (!intent?.skill) return false;
  const other = agent === bit ? nox : bit;
  const sp = MOVE_SPEED * agent.speedMul * dt;
  let tx = agent.x, ty = agent.y;
  const aim = (x, y, stop = 48) => {
    const dx = x - agent.x, dy = y - agent.y, L = Math.hypot(dx, dy) || 1;
    if (L > stop) { tx = agent.x + (dx / L) * sp; ty = agent.y + (dy / L) * sp; }
    setAngle(agent, Math.atan2(dy, dx));
  };
  if (intent.skill === "orbit_other") {
    const ang = Math.atan2(agent.y - other.y, agent.x - other.x) + dt * 1.35;
    tx = other.x + Math.cos(ang) * 70;
    ty = other.y + Math.sin(ang) * 70;
    setAngle(agent, Math.atan2(other.y - agent.y, other.x - agent.x));
  } else if (intent.skill === "follow") aim(other.x, other.y);
  else if (intent.skill === "follow_human") aim(human.x, human.y, 44);
  else if (intent.skill === "goto_beacon" && world.beacon) aim(world.beacon.x, world.beacon.y, 30);
  else if (intent.skill === "patrol_edge") {
    if (!intent._pvx) { intent._pvx = 1; intent._pvy = 0; }
    tx = agent.x + intent._pvx * sp; ty = agent.y + intent._pvy * sp;
  } else return false;

  const res = moveWithCollision(world, agent.x, agent.y, tx, ty, 14);
  if (res.hit && intent.skill === "patrol_edge") {
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const p = dirs[Math.floor(Math.random() * 4)];
    intent._pvx = p[0]; intent._pvy = p[1];
  }
  agent.x = res.x; agent.y = res.y;
  agent.walkPhase += dt * 14;
  agent.moving = true;
  intent.remaining = Math.max(0, intent.remaining - MOVE_SPEED * dt);
  if (intent.remaining <= 0) {
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.moving = false; agent.move = "idle";
  }
  return true;
}

function simulateAgent(agent, dt) {
  if (agent.thoughtT > 0) agent.thoughtT -= dt;
  agent.activityT += dt;
  tickSocialMeters(agent, dt, world, agent === bit ? nox : bit);

  if (agent.activity === "sit" || agent.activity === "work") {
    agent.moving = false;
    agent.move = "idle";
    // occasional sit fidget
    if (agent.activity === "sit") agent.walkPhase += dt * 2;
    return;
  }

  if (agent.navPath?.length) {
    if (followNav(world, agent, dt, MOVE_SPEED * agent.speedMul, moveWithCollision)) {
      stepSfx(agent);
      return;
    }
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
  let fx = res.x, fy = res.y;
  for (const o of [agent === bit ? nox : bit, human]) {
    const d = Math.hypot(fx - o.x, fy - o.y);
    const minD = o.kind === "human" ? 26 : 32;
    if (d < minD && d > 0.01) {
      const push = (minD - d) / d;
      fx += (fx - o.x) * push * 0.5;
      fy += (fy - o.y) * push * 0.5;
    }
  }
  if (res.hit) {
    sfx.bump(agent.x, agent.y);
    agent.intent = { vx: 0, vy: 0, remaining: 0, label: "idle", skill: null };
    agent.moving = false; agent.move = "idle";
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
  if (now - (lastStepSfx[agent.id] || 0) > 210) {
    sfx.step(agent.x, agent.y, !hasLOS(world, agent.x, agent.y, human.x, human.y));
    lastStepSfx[agent.id] = now;
  }
}

function simulateHuman(dt) {
  if (human.thoughtT > 0) human.thoughtT -= dt;
  if (human.path.length) {
    const t = human.path[0];
    const dx = t.x - human.x, dy = t.y - human.y, L = Math.hypot(dx, dy) || 1;
    if (L < 10) human.path.shift();
    else {
      const res = moveWithCollision(
        world, human.x, human.y,
        human.x + (dx / L) * 155 * dt, human.y + (dy / L) * 155 * dt, 12
      );
      human.x = res.x; human.y = res.y;
      human.angle = Math.atan2(dy, dx);
      human.walkPhase += dt * 14;
      human.moving = true;
    }
  } else human.moving = false;
}

function tickNode(dt) {
  const n = world.node;
  n.phase += dt;
  const path = [[700, 450], [850, 420], [820, 520], [680, 500]];
  const [tx, ty] = path[Math.floor(n.phase / 4.5) % path.length];
  const dx = tx - n.x, dy = ty - n.y, L = Math.hypot(dx, dy) || 1;
  n.x += (dx / L) * 32 * dt;
  n.y += (dy / L) * 32 * dt;
  if (Math.random() < 0.0009 && agents.some((a) => dist(a, n) < 110)) {
    logSpeech("Node", pick(["ambient ok", "listening", "void stable", "…"]), "node", n);
  }
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function ambientFX() {
  if (Math.random() < 0.1) {
    const r = world.rooms[Math.floor(Math.random() * world.rooms.length)];
    world.particles.push({
      x: r.x + Math.random() * r.w,
      y: r.y + Math.random() * r.h,
      vx: (Math.random() - 0.5) * 10,
      vy: -6 - Math.random() * 14,
      life: 0.9 + Math.random(),
      color: r.accent || "#668",
      size: 1.2 + Math.random() * 2,
    });
  }
}

function updateCamera(dt) {
  if (spectator) {
    cam.tx = (bit.x + nox.x) / 2;
    cam.ty = (bit.y + nox.y) / 2 - 10;
    const d = dist(bit, nox);
    cam.tz = d < 90 ? 1.45 : d < 200 ? 1.2 : 1.08;
  } else {
    cam.tx = WORLD_W / 2; cam.ty = WORLD_H / 2; cam.tz = 1;
  }
  cam.x += (cam.tx - cam.x) * Math.min(1, dt * 2.6);
  cam.y += (cam.ty - cam.y) * Math.min(1, dt * 2.6);
  cam.zoom += (cam.tz - cam.zoom) * Math.min(1, dt * 2);
}

function entityList() {
  return [
    { ...bit, moodColor: moodColor(bit), showFov: debugOn, fovRad: Math.PI * 0.55, thought: bit.thoughtT > 0 ? bit.thought : "", activity: bit.activity },
    { ...nox, moodColor: moodColor(nox), showFov: debugOn, fovRad: Math.PI * 0.55, thought: nox.thoughtT > 0 ? nox.thought : "", activity: nox.activity },
    { id: "node", name: "Node", kind: "node", x: world.node.x, y: world.node.y, color: world.node.color },
    { ...human, thought: human.thoughtT > 0 ? human.thought : "" },
  ];
}

function socialLine() {
  if (dialogue.active) {
    return [{
      x0: bit.x, y0: bit.y, x1: nox.x, y1: nox.y,
      color: "rgba(255,220,120,0.35)",
    }];
  }
  if (dist(bit, nox) > 100) {
    return [{
      x0: bit.x, y0: bit.y, x1: nox.x, y1: nox.y,
      color: "rgba(160,140,255,0.15)",
    }];
  }
  return [];
}

function paint() {
  drawWorld(wctx, worldCanvas, world, entityList(), {
    camera: spectator ? { x: cam.x, y: cam.y, zoom: cam.zoom } : null,
    targetLines: socialLine(),
    path: human.path,
    dayPhase,
  });
  if (juice > 0) {
    wctx.save();
    wctx.setTransform(1, 0, 0, 1, 0, 0);
    wctx.fillStyle = `rgba(180,210,255,${juice * 0.12})`;
    wctx.fillRect(0, 0, worldCanvas.width, worldCanvas.height);
    wctx.restore();
  }
  mctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  drawMinimap(mctx, 0, 0, minimapCanvas.width, minimapCanvas.height, world, entityList());
  updateCards();
  if (debugOn && dbgBody) {
    dbgBody.textContent = [
      `day=${dayName(dayPhase)} (${dayPhase.toFixed(2)}) brain=${brainMode}`,
      `dialogue=${dialogue.active ? dialogue.topic : "—"} t=${dialogue.turns}/${dialogue.maxTurns}`,
      `Bit e=${bit.energy.toFixed(2)} s=${bit.social.toFixed(2)} ${bit.activity}`,
      `Nox e=${nox.energy.toFixed(2)} s=${nox.social.toFixed(2)} ${nox.activity}`,
      `rel=${relations.bit_nox.toFixed(2)}`,
      bit.lastRaw || "",
    ].join("\n");
  }
}

// ── Loops ───────────────────────────────────────────────────
function motorLoop(now) {
  let dt = Math.min(0.05, (now - (lastMotor || now)) / 1000);
  lastMotor = now;
  if (juice > 0) juice = Math.max(0, juice - dt * 1.5);

  world.time += dt;
  dayPhase = (dayPhase + dt / DAY_LEN) % 1;
  tickDialogue(dialogue, dt);
  updateCamera(dt);

  if (running) {
    if (callPulse > 0) callPulse -= dt;
    // break dialogue if far
    if (dialogue.active && dist(bit, nox) > 130) {
      endDialogue(dialogue);
      dialogue.cooldown = 5;
    }
    for (const a of agents) simulateAgent(a, dt);
    simulateHuman(dt);
    tickNode(dt);
    tickFX(world, dt);
    ambientFX();
    setListener(human.x, human.y);
    for (const a of agents) {
      const r = roomAt(world, a.x, a.y);
      if (r && a._lastRoom !== r.id) {
        if (a._lastRoom) toast(`${a.name} → ${r.name}`);
        a._lastRoom = r.id;
      }
    }
  }
  paint();
  requestAnimationFrame(motorLoop);
}

async function think(agent) {
  if (!running) return;
  agent.ticks += 1;
  setStatus(`${agent.name} · ${agent.activity}…`, "warn");
  try {
    const action = await decideAction(agent);
    if (running) applyAction(agent, action);
    setStatus(`${agent.name} · ${agent.hybrid || brainMode} · ${agent.activity}`, "");
    setTimeout(() => { statusEl.style.opacity = "0.35"; }, 1500);
  } catch (err) {
    console.error(err);
    applyAction(
      agent,
      planSocial(agent, agent === bit ? nox : bit, human, world, dialogue, ctxFor(agent))
    );
  }
}

async function vlaLoop() {
  let i = 0;
  while (true) {
    if (!running) {
      await sleep(400);
      continue;
    }
    // Prefer speaker who should reply in dialogue
    let agent = agents[i % 2];
    if (dialogue.active && dialogue.lastSpeaker) {
      agent = dialogue.lastSpeaker === "bit" ? nox : bit;
    }
    if (!model) {
      applyAction(
        agent,
        planSocial(agent, agent === bit ? nox : bit, human, world, dialogue, ctxFor(agent))
      );
    } else {
      await think(agent);
    }
    i++;
    await sleep(brainMode === "heuristic" ? 380 : VLA_GAP_MS);
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  updateBrainLabel();
  if (model) return;
  if (progressEl) progressEl.style.display = "block";

  if (brainMode === "heuristic" || (!navigator.gpu && !window.HANGOUT_VLM?.apiKey)) {
    brainMode = brainMode === "vlm" ? "heuristic" : brainMode;
    if (!navigator.gpu) brainMode = "heuristic";
    model = { heuristic: true, remoteOnly: true };
    modelId = "heuristic";
    updateBrainLabel();
    if (progressEl) progressEl.style.display = "none";
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
      } catch (e) {
        console.warn(e);
        model = null;
      }
    }
  }
  if (!model && window.HANGOUT_VLM?.apiKey) {
    model = { remoteOnly: true };
    modelId = "remote";
  }
  if (!model) {
    brainMode = "heuristic";
    model = { heuristic: true, remoteOnly: true };
    modelId = "heuristic";
    updateBrainLabel();
  }
  if (progressEl) setTimeout(() => { progressEl.style.display = "none"; }, 300);
  finishBoot();
}

function finishBoot() {
  sfx.boot();
  trySay(bit, "the rooms feel awake today");
  trySay(nox, "don't narrate it");
  juicePop(0.25);
  setStatus(`live · ${modelId}`, "");
  const onboard = document.getElementById("onboard");
  if (onboard) {
    onboard.classList.remove("hidden");
    const go = () => { onboard.classList.add("hidden"); unlockAudio(); };
    onboard.querySelector("button")?.addEventListener("click", go, { once: true });
    setTimeout(go, 11000);
  }
  const banner = document.getElementById("phase-banner");
  if (banner) {
    banner.classList.remove("hidden");
    banner.classList.add("show");
    setTimeout(() => {
      banner.classList.add("out");
      setTimeout(() => banner.classList.add("hidden"), 450);
    }, 1300);
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
  if (Math.hypot(bit.x - p.x, bit.y - p.y) < 30) {
    human.assign = { forAgent: "nox", kind: "agent", x: bit.x, y: bit.y };
    toast("Nox → Bit", "good");
    applyAction(nox, planSocial(nox, bit, human, world, dialogue, ctxFor(nox)));
    return;
  }
  if (Math.hypot(nox.x - p.x, nox.y - p.y) < 30) {
    human.assign = { forAgent: "bit", kind: "agent", x: nox.x, y: nox.y };
    toast("Bit → Nox", "good");
    applyAction(bit, planSocial(bit, nox, human, world, dialogue, ctxFor(bit)));
    return;
  }
  const prop = nearestProp(world, p.x, p.y, 32);
  if (prop) {
    const forAgent = dist(bit, prop) <= dist(nox, prop) ? "bit" : "nox";
    human.assign = { forAgent, kind: "prop", x: prop.x, y: prop.y };
    toast(`${forAgent} → ${prop.id}`, "good");
    const a = forAgent === "bit" ? bit : nox;
    applyAction(a, planSocial(a, a === bit ? nox : bit, human, world, dialogue, ctxFor(a)));
    return;
  }
  drawing = true;
  human.path = [{ x: p.x, y: p.y }];
  human.x = p.x; human.y = p.y;
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
  callPulse = 2.5;
  sfx.call(human.x, human.y);
  toast("Calling…", "good");
  for (const a of agents) {
    setNavTo(world, a, human.x, human.y);
    a.activity = "roam";
    setThought(a, "COME");
  }
}
function doBeacon() {
  world.beacon = { x: human.x, y: human.y, t: 18 };
  sfx.beacon(human.x, human.y);
  spawnFlash(world, human.x, human.y, "#0f0", 40);
  toast("Beacon", "good");
}

window.addEventListener("keydown", (e) => {
  unlockAudio();
  const k = e.key.toLowerCase();
  if (k === "d") { debugOn = !debugOn; debugEl?.classList.toggle("hidden", !debugOn); }
  if (k === "c") { spectator = !spectator; toast(spectator ? "Spectator" : "Wide"); }
  if (k === "q") doCall();
  if (k === "e") doBeacon();
  if (k === "b") cycleBrain();
});
brainModeEl?.addEventListener("click", cycleBrain);
document.getElementById("m-call")?.addEventListener("click", doCall);
document.getElementById("m-beacon")?.addEventListener("click", doBeacon);
document.getElementById("m-cam")?.addEventListener("click", () => {
  spectator = !spectator;
  toast(spectator ? "Spectator" : "Wide");
});
document.getElementById("m-brain")?.addEventListener("click", cycleBrain);

// Start
updateBrainLabel();
paint();
requestAnimationFrame(motorLoop);
boot().then(() => vlaLoop());
window.addEventListener("resize", () => paint());
window.hangout = { cycleBrain, dialogue, agents: () => agents, relations };
