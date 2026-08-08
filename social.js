/**
 * Life schedule + social brain for Little Land dwellers.
 */
import { dist, roomAt, nearestProp, hasLOS } from "./world.js";

export const TOPICS = [
  "the hearth fire",
  "tonight's stew",
  "old songs",
  "the garden oak",
  "whether the innkeep sleeps",
  "rain on the roof",
  "what 'home' means",
  "Bit's optimism",
  "Nox's walls",
  "the guest watching us",
  "fresh bread",
  "quiet mornings",
  "who washes the mugs",
  "a joke that almost landed",
];

const BIT_VOICE = {
  greet: ["hey", "oh — hi", "there you are", "saved you a seat"],
  agree: ["yeah", "totally", "i feel that", "same"],
  wonder: ["what if…", "curious though", "hmm —", "wild thought:"],
  soft: ["that's soft of you", "didn't expect that", "…nice", "means a lot"],
  leave: ["gonna wander", "bar calls", "orbiting off", "catch you"],
};

const NOX_VOICE = {
  greet: ["hm", "you're back", "…hi", "figures"],
  agree: ["sure", "fine", "not wrong", "unfortunately yes"],
  wonder: ["doubt it", "or not", "overthinking", "maybe"],
  soft: ["don't read into it", "whatever", "…thanks", "shut up (fond)"],
  leave: ["enough", "kitchen", "moving", "later"],
};

function voice(agent) {
  return agent.id === "bit" ? BIT_VOICE : NOX_VOICE;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/** dayPhase 0..1 → schedule block */
export function dayBlock(dayPhase) {
  if (dayPhase < 0.18 || dayPhase >= 0.88) return "night";
  if (dayPhase < 0.32) return "morning";
  if (dayPhase < 0.55) return "day";
  if (dayPhase < 0.72) return "evening";
  return "dusk";
}

export function createDialogue() {
  return {
    active: false,
    topic: null,
    turns: 0,
    maxTurns: 0,
    lastSpeaker: null,
    history: [],
    cooldown: 0,
  };
}

export function tickSocialMeters(agent, dt, world, other) {
  const moving = agent.moving;
  const sitting = agent.activity === "sit";
  const working = agent.activity === "work";
  const near = dist(agent, other) < 95;

  agent.energy = clamp(
    agent.energy + dt * (sitting ? 0.1 : working ? -0.015 : moving ? -0.035 : 0.025),
    0.08,
    1
  );
  agent.social = clamp(
    agent.social + dt * (near && agent.activity === "chat" ? 0.07 : near ? 0.02 : -0.012),
    0,
    1
  );
  agent.boredom = clamp(
    agent.boredom + dt * (near ? -0.035 : 0.02) + (moving ? -0.012 : 0.008),
    0,
    1
  );

  if (agent.energy < 0.28) agent.moodBias = "tired";
  else if (agent.social > 0.65 && near) agent.moodBias = "warm";
  else if (agent.boredom > 0.65) agent.moodBias = "restless";
  else agent.moodBias = "neutral";
}

export function activitySpot(prop) {
  if (!prop) return null;
  if (prop.id === "couch" || prop.id === "bench") {
    return { type: "sit", x: prop.x, y: prop.y + 10, prop };
  }
  if (prop.id === "terminal" || prop.id === "server" || prop.id === "whiteboard") {
    return { type: "work", x: prop.x, y: prop.y + 18, prop };
  }
  if (prop.id === "coffee" || prop.type === "table") {
    return { type: "use", x: prop.x, y: prop.y + 16, prop };
  }
  if (prop.id === "lamp") {
    return { type: "sit", x: prop.x - 30, y: prop.y + 8, prop };
  }
  return { type: "use", x: prop.x, y: prop.y + 14, prop };
}

export function planSocial(agent, other, human, world, dialogue, ctx = {}) {
  const dOther = dist(agent, other);
  const close = dOther < 78 && hasLOS(world, agent.x, agent.y, other.x, other.y);
  const rel = ctx.rel ?? 0.15;
  const block = ctx.dayBlock || "day";

  // ── Continue dialogue ──
  if (dialogue.active && dialogue.turns < dialogue.maxTurns && close) {
    if (dialogue.lastSpeaker !== agent.id) {
      return continueDialogue(agent, other, dialogue, rel);
    }
    return hold("listen", "…", "chat", "think");
  }
  if (dialogue.active && dOther > 125) {
    endDialogue(dialogue);
    dialogue.cooldown = 6;
  }

  // ── Hold sit/work long enough to feel real ──
  const holdMin = block === "night" ? 6 : 4;
  if (
    (agent.activity === "sit" || agent.activity === "work") &&
    (agent.activityT || 0) < holdMin + Math.random() * 3
  ) {
    if (agent.activity === "sit" && agent.energy > 0.9 && Math.random() < 0.08) {
      /* allow leave */
    } else {
      return hold(
        agent.activity === "sit" ? "resting" : "busy",
        agent.activity === "sit" ? "SIT" : "WORK",
        agent.activity,
        agent.activity === "work" ? "think" : "idle",
        agent.activity === "work" && Math.random() < 0.2 ? "use" : "none"
      );
    }
  }

  // ── Time-of-day routines ──
  const routine = scheduleBias(agent, block, world, other, close, dialogue);
  if (routine) return routine;

  // ── Needs ──
  if (agent.energy < 0.32) {
    const seat = world.props.find((p) => p.id === "couch" || p.id === "bench" || p.id === "lamp");
    if (seat) {
      if (dist(agent, seat) < 45) {
        return hold("rest", "SIT", "sit", "idle", "none", agent.id === "bit" ? "ahh…" : "…rest");
      }
      const spot = activitySpot(seat);
      return goNav(agent, spot.x, spot.y, "find rest", "REST", "sit");
    }
  }

  if (close && !dialogue.active && dialogue.cooldown <= 0 &&
      (agent.social < 0.5 || agent.boredom > 0.35 || Math.random() < 0.22)) {
    return startDialogue(agent, other, dialogue, rel);
  }

  if (!close && agent.social < 0.4 && Math.random() < 0.4) {
    return goNav(agent, other.x, other.y, `find ${other.name}`, "FIND", "roam");
  }

  // Human
  if (ctx.callPulse > 0 && dist(agent, human) > 50) {
    return goNav(agent, human.x, human.y, "answer call", "COME", "follow");
  }
  if (world.beacon && dist(agent, world.beacon) > 40) {
    return goNav(agent, world.beacon.x, world.beacon.y, "beacon", "PING", "roam");
  }
  if (ctx.assignTarget && (!ctx.assignTarget.forAgent || ctx.assignTarget.forAgent === agent.id)) {
    const a = ctx.assignTarget;
    return goNav(agent, a.x, a.y, "go where asked", "GO", "roam");
  }

  // Soft orbit or explore
  if (dOther < 150 && Math.random() < 0.28 + rel * 0.2) {
    return {
      see: "truth:near partner",
      move: "orbit_other",
      steps: 4,
      act: "none",
      say: Math.random() < 0.2 ? pick(voice(agent).greet) : "",
      mood: "curious",
      thought: "NEAR",
      goal: "stay nearby",
      activity: "roam",
      _src: "social",
    };
  }

  const dest = pick(world.rooms);
  return goNav(
    agent,
    dest.x + dest.w * (0.25 + Math.random() * 0.5),
    dest.y + dest.h * (0.25 + Math.random() * 0.5),
    `wander ${dest.name}`,
    "WALK",
    "roam"
  );
}

function scheduleBias(agent, block, world, other, close, dialogue) {
  // Morning → kitchen / bar
  if (block === "morning" && Math.random() < 0.55) {
    const p = world.props.find((x) => x.id === "coffee" || x.id === "terminal");
    if (p && dist(agent, p) > 40) {
      return goNav(agent, p.x, p.y + 16, "morning ritual", "AWAKE", "use");
    }
    if (p && dist(agent, p) <= 40) {
      return hold("morning brew", "SIP", "use", "happy", "use",
        agent.id === "bit" ? "morning~" : "coffee.");
    }
  }

  // Day → work or garden
  if (block === "day" && agent.boredom > 0.3 && Math.random() < 0.45) {
    const p = world.props.find((x) =>
      agent.id === "nox" ? x.id === "terminal" || x.id === "server" : x.id === "tree" || x.id === "whiteboard"
    ) || world.props.find((x) => x.id === "terminal");
    if (p) {
      if (dist(agent, p) < 42) {
        return hold("at work", "WORK", "work", "think", "use");
      }
      const spot = activitySpot(p);
      return goNav(agent, spot.x, spot.y, "go work", "WORK", "work");
    }
  }

  // Evening / dusk → hearth + talk
  if ((block === "evening" || block === "dusk") && Math.random() < 0.5) {
    if (close && !dialogue.active && dialogue.cooldown <= 0) {
      return startDialogue(agent, other, dialogue, 0.3);
    }
    const hearth = world.props.find((x) => x.id === "lamp" || x.id === "couch");
    if (hearth && dist(agent, hearth) > 50) {
      return goNav(agent, hearth.x - 20, hearth.y + 10, "evening hearth", "FIRE", "roam");
    }
    if (!close) {
      return goNav(agent, other.x, other.y, "evening company", "HI", "roam");
    }
  }

  // Night → sit / low energy
  if (block === "night") {
    if (agent.energy < 0.7 || Math.random() < 0.6) {
      const seat = world.props.find((x) => x.id === "couch" || x.id === "bench");
      if (seat) {
        if (dist(agent, seat) < 45) {
          return hold("night rest", "ZZZ", "sit", "idle", "none",
            Math.random() < 0.15 ? (agent.id === "bit" ? "sleepy…" : "…") : "");
        }
        return goNav(agent, seat.x, seat.y + 8, "turn in", "BED", "sit");
      }
    }
  }

  return null;
}

function hold(goal, thought, activity, mood, act = "none", say = "") {
  return {
    see: `truth:${goal}`,
    move: "idle",
    steps: 0,
    act,
    say,
    mood,
    thought,
    goal,
    activity,
    faceOther: activity === "chat",
    _src: "social",
  };
}

function startDialogue(agent, other, dialogue, rel) {
  const topic = pick(TOPICS);
  dialogue.active = true;
  dialogue.topic = topic;
  dialogue.turns = 1;
  dialogue.maxTurns = 4 + Math.floor(Math.random() * 3) + (rel > 0.25 ? 1 : 0);
  dialogue.lastSpeaker = agent.id;
  dialogue.history = [];
  dialogue.cooldown = 0;

  const opener = `${pick(voice(agent).greet)} — ${topic}`;
  dialogue.history.push({ who: agent.id, text: opener });

  return {
    see: `truth:start ${topic}`,
    move: "idle",
    steps: 0,
    act: "wave",
    say: opener,
    mood: "happy",
    thought: "CHAT",
    goal: `talk: ${topic}`,
    activity: "chat",
    faceOther: true,
    _src: "social",
  };
}

function continueDialogue(agent, other, dialogue, rel) {
  dialogue.turns += 1;
  dialogue.lastSpeaker = agent.id;
  const v = voice(agent);
  let line;
  const t = dialogue.turns;
  if (t >= dialogue.maxTurns) {
    line = pick(v.leave);
    dialogue.history.push({ who: agent.id, text: line });
    endDialogue(dialogue);
    dialogue.cooldown = 10 + Math.random() * 14;
  } else if (t === 2) {
    line = `${pick(v.wonder)} ${dialogue.topic}`;
  } else if (Math.random() < 0.35) {
    line = pick(v.soft);
  } else {
    line = pick(v.agree);
  }
  if (dialogue.active || t >= dialogue.maxTurns) {
    if (t < dialogue.maxTurns) dialogue.history.push({ who: agent.id, text: line });
  }

  return {
    see: `truth:reply ${dialogue.topic || ""}`,
    move: "idle",
    steps: 0,
    act: t % 2 === 0 ? "wave" : "none",
    say: line,
    mood: rel > 0 ? "happy" : "think",
    thought: "CHAT",
    goal: dialogue.topic ? `talk: ${dialogue.topic}` : "chat",
    activity: "chat",
    faceOther: true,
    _src: "social",
  };
}

export function endDialogue(dialogue) {
  dialogue.active = false;
  dialogue.lastSpeaker = null;
}

export function tickDialogue(dialogue, dt) {
  if (dialogue.cooldown > 0) dialogue.cooldown -= dt;
}

function goNav(agent, x, y, see, thought, activity) {
  return {
    see: `truth:${see}`,
    move: "nav",
    steps: 4,
    act: "none",
    say: "",
    mood: "curious",
    thought,
    goal: see,
    activity: activity || "roam",
    _nav: { x, y },
    _face: Math.atan2(y - agent.y, x - agent.x),
    _src: "social",
  };
}

export function hybridSocial(vlmAction, seeScore, agent, other, human, world, dialogue, ctx) {
  const social = planSocial(agent, other, human, world, dialogue, ctx);
  const force = ctx.forceHeuristic || ctx.heuristicOnly || ctx.preferSocial;

  // Dialogue continuity always wins
  if (dialogue.active && social.activity === "chat") {
    return { ...social, _hybrid: "dialogue" };
  }

  if (force || seeScore < 0.32 || !vlmAction) {
    return { ...social, _hybrid: force ? "life" : "social-fallback" };
  }

  if (seeScore >= 0.55) {
    return {
      ...vlmAction,
      thought: vlmAction.thought || (vlmAction.say ? "CHAT" : "…"),
      activity: vlmAction.activity || (vlmAction.say ? "chat" : "roam"),
      _hybrid: "vlm",
      _src: "vlm",
    };
  }

  return {
    ...social,
    say: vlmAction.say || social.say,
    _hybrid: "blend",
  };
}
