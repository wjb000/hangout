/**
 * Deep social layer for Hangout:
 * - multi-turn conversation threads
 * - energy / social battery
 * - activity states (roam, chat, sit, work, follow)
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
];

const BIT_VOICE = {
  greet: ["hey", "oh — hi", "there you are", "missed the noise"],
  agree: ["yeah", "totally", "i feel that", "same wavelength"],
  wonder: ["what if…", "curious though", "hmm", "wild thought:"],
  soft: ["that's soft of you", "didn't expect that", "…nice"],
  leave: ["gonna wander", "coffee calls", "brb-ish", "orbiting off"],
};

const NOX_VOICE = {
  greet: ["hm", "you're back", "…hi", "figures"],
  agree: ["sure", "fine", "not wrong", "unfortunately yes"],
  wonder: ["doubt it", "or not", "overthinking", "maybe"],
  soft: ["don't read into it", "whatever", "…thanks", "shut up (affectionate)"],
  leave: ["enough", "lab time", "moving", "later"],
};

function voice(agent) {
  return agent.id === "bit" ? BIT_VOICE : NOX_VOICE;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function createDialogue() {
  return {
    active: false,
    topic: null,
    turns: 0,
    maxTurns: 0,
    lastSpeaker: null,
    history: [], // {who, text}
    cooldown: 0,
  };
}

export function tickSocialMeters(agent, dt, world, other) {
  // energy drains while moving, recovers while sitting/idle near partner
  const moving = agent.moving;
  const sitting = agent.activity === "sit";
  const working = agent.activity === "work";
  const d = dist(agent, other);
  const near = d < 90;

  agent.energy = clamp(
    agent.energy + dt * (sitting ? 0.08 : working ? -0.02 : moving ? -0.04 : 0.02),
    0.05,
    1
  );
  agent.social = clamp(
    agent.social + dt * (near && agent.activity === "chat" ? 0.06 : near ? 0.015 : -0.01),
    0,
    1
  );
  agent.boredom = clamp(
    agent.boredom + dt * (near ? -0.03 : 0.025) + (moving ? -0.01 : 0.01),
    0,
    1
  );

  // mood drift from meters
  if (agent.energy < 0.25) agent.moodBias = "tired";
  else if (agent.social > 0.7 && near) agent.moodBias = "warm";
  else if (agent.boredom > 0.7) agent.moodBias = "restless";
  else agent.moodBias = "neutral";
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/** Sit spots / work spots from props */
export function activitySpot(prop) {
  if (!prop) return null;
  if (prop.id === "couch" || prop.id === "bench") {
    return { type: "sit", x: prop.x, y: prop.y + 8, prop };
  }
  if (prop.id === "terminal" || prop.id === "server" || prop.id === "whiteboard") {
    return { type: "work", x: prop.x, y: prop.y + 18, prop };
  }
  if (prop.id === "coffee") {
    return { type: "use", x: prop.x, y: prop.y + 16, prop };
  }
  return { type: "use", x: prop.x, y: prop.y + 14, prop };
}

/**
 * High-level social decision — may start/continue dialogue or pick activity.
 */
export function planSocial(agent, other, human, world, dialogue, ctx = {}) {
  const dOther = dist(agent, other);
  const close = dOther < 78 && hasLOS(world, agent.x, agent.y, other.x, other.y);
  const room = roomAt(world, agent.x, agent.y);
  const rel = ctx.rel ?? 0.1;

  // Continue multi-turn dialogue
  if (dialogue.active && dialogue.turns < dialogue.maxTurns && close) {
    if (dialogue.lastSpeaker !== agent.id) {
      return continueDialogue(agent, other, dialogue, rel);
    }
    // wait politely — small idle
    return {
      see: "truth:listening",
      move: "idle",
      steps: 0,
      act: "none",
      say: "",
      mood: "think",
      thought: "…",
      goal: "listen",
      activity: "chat",
      _src: "social",
    };
  }

  // End dialogue if too far
  if (dialogue.active && dOther > 120) {
    endDialogue(dialogue);
  }

  // Low energy → seek seat
  if (agent.energy < 0.3 && Math.random() < 0.7) {
    const seat = world.props.find((p) => p.id === "couch" || p.id === "bench");
    if (seat) {
      const spot = activitySpot(seat);
      if (dist(agent, seat) < 40) {
        return {
          see: "truth:sit",
          move: "idle",
          steps: 0,
          act: "none",
          say: agent.id === "bit" ? "ahh" : "…rest",
          mood: "idle",
          thought: "SIT",
          goal: "rest",
          activity: "sit",
          face: seat.id === "couch" ? Math.PI / 2 : 0,
          _src: "social",
        };
      }
      return goNav(agent, spot.x, spot.y, "find seat", "REST", "sit");
    }
  }

  // High social need / mid boredom + near partner → start chat
  if (
    close &&
    !dialogue.active &&
    dialogue.cooldown <= 0 &&
    (agent.social < 0.45 || agent.boredom > 0.4 || Math.random() < 0.2)
  ) {
    return startDialogue(agent, other, dialogue, rel);
  }

  // Invite other if far and social low
  if (!close && agent.social < 0.35 && Math.random() < 0.35) {
    return goNav(agent, other.x, other.y, `find ${other.name}`, "FIND", "roam");
  }

  // Work at terminal when restless
  if (agent.boredom > 0.55 && Math.random() < 0.4) {
    const term = world.props.find((p) => p.id === "terminal" || p.id === "whiteboard");
    if (term) {
      if (dist(agent, term) < 42) {
        return {
          see: "truth:work",
          move: "idle",
          steps: 0,
          act: "use",
          say: agent.id === "bit" ? "tinkering" : "debugging existence",
          mood: "think",
          thought: "WORK",
          goal: "focus",
          activity: "work",
          _src: "social",
        };
      }
      const spot = activitySpot(term);
      return goNav(agent, spot.x, spot.y, "go work", "WORK", "work");
    }
  }

  // Coffee ritual
  if (agent.energy < 0.5 && Math.random() < 0.25) {
    const coffee = world.props.find((p) => p.id === "coffee");
    if (coffee) {
      if (dist(agent, coffee) < 40) {
        return {
          see: "truth:coffee",
          move: "idle",
          steps: 0,
          act: "use",
          say: agent.id === "bit" ? "warm pixels~" : "fuel",
          mood: "happy",
          thought: "SIP",
          goal: "coffee",
          activity: "use",
          energyBoost: 0.2,
          _src: "social",
        };
      }
      return goNav(agent, coffee.x, coffee.y + 16, "coffee run", "COFFEE", "use");
    }
  }

  // Human call / beacon
  if (ctx.callPulse > 0 && dist(agent, human) > 50) {
    return goNav(agent, human.x, human.y, "answer call", "COME", "follow");
  }
  if (world.beacon && dist(agent, world.beacon) > 40) {
    return goNav(agent, world.beacon.x, world.beacon.y, "beacon", "PING", "roam");
  }

  // Assignment
  if (ctx.assignTarget && (!ctx.assignTarget.forAgent || ctx.assignTarget.forAgent === agent.id)) {
    const a = ctx.assignTarget;
    return goNav(agent, a.x, a.y, "human ask", "GO", "roam");
  }

  // Explore room if bored
  if (agent.boredom > 0.35 || Math.random() < 0.4) {
    const dest = pick(world.rooms);
    return goNav(
      agent,
      dest.x + dest.w * (0.3 + Math.random() * 0.4),
      dest.y + dest.h * (0.3 + Math.random() * 0.4),
      `explore ${dest.name}`,
      "ROOM",
      "roam"
    );
  }

  // Orbit partner gently
  if (dOther < 160 && Math.random() < 0.3 + rel * 0.2) {
    return {
      see: "truth:orbit",
      move: "orbit_other",
      steps: 5,
      act: "none",
      say: Math.random() < 0.25 ? pick(voice(agent).greet) : "",
      mood: "curious",
      thought: "NEAR",
      goal: "stay close",
      activity: "roam",
      _src: "social",
    };
  }

  // default wander
  const ang = (agent.angle || 0) + (Math.random() - 0.5) * 2;
  const dd = 70 + Math.random() * 90;
  return goNav(
    agent,
    agent.x + Math.cos(ang) * dd,
    agent.y + Math.sin(ang) * dd,
    "wander",
    "WALK",
    "roam"
  );
}

function startDialogue(agent, other, dialogue, rel) {
  const topic = pick(TOPICS);
  dialogue.active = true;
  dialogue.topic = topic;
  dialogue.turns = 0;
  dialogue.maxTurns = 3 + Math.floor(Math.random() * 3) + (rel > 0.3 ? 1 : 0);
  dialogue.lastSpeaker = null;
  dialogue.history = [];
  dialogue.cooldown = 0;

  const opener = `${pick(voice(agent).greet)} — about ${topic}`;
  dialogue.history.push({ who: agent.id, text: opener });
  dialogue.lastSpeaker = agent.id;
  dialogue.turns = 1;

  return {
    see: `truth:start talk re ${topic}`,
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
    dialogue.cooldown = 8 + Math.random() * 10;
  } else if (t === 2) {
    line = `${pick(v.wonder)} ${dialogue.topic}`;
  } else if (Math.random() < 0.4) {
    line = pick(v.soft);
  } else {
    line = pick(v.agree);
  }
  if (t < dialogue.maxTurns || dialogue.active) {
    dialogue.history.push({ who: agent.id, text: line });
  }

  return {
    see: `truth:reply on ${dialogue.topic}`,
    move: "idle",
    steps: 0,
    act: t % 2 === 0 ? "wave" : "none",
    say: line,
    mood: rel > 0 ? "happy" : "think",
    thought: "CHAT",
    goal: `talk: ${dialogue.topic}`,
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
  const force = ctx.forceHeuristic || ctx.heuristicOnly;

  if (force || seeScore < 0.3 || !vlmAction) {
    return { ...social, _hybrid: force ? "heuristic" : "social-fallback" };
  }

  // Prefer social dialogue continuity over VLM if mid-conversation
  if (dialogue.active && social.activity === "chat") {
    return { ...social, _hybrid: "dialogue" };
  }

  if (seeScore >= 0.5) {
    return {
      ...vlmAction,
      thought: vlmAction.thought || (vlmAction.say ? "CHAT" : "…"),
      activity: vlmAction.say ? "chat" : "roam",
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
