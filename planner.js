/**
 * Social hangout planner — AIs explore, chat, use props, react to each other.
 * No missions or orbs.
 */
import { dist, roomAt, nearestProp, hasLOS } from "./world.js";

/**
 * @param {object} agent
 * @param {object} other
 * @param {object} human
 * @param {object} world
 * @param {object} ctx
 */
export function planFromTruth(agent, other, human, world, ctx = {}) {
  const assign = ctx.assignTarget;
  const room = roomAt(world, agent.x, agent.y);
  const otherRoom = roomAt(world, other.x, other.y);
  const dOther = dist(agent, other);
  const dHuman = dist(agent, human);
  const nearProp = nearestProp(world, agent.x, agent.y, 48);
  const close = dOther < 75 && hasLOS(world, agent.x, agent.y, other.x, other.y);
  const midClose = dOther < 140;
  const rel = ctx.rel ?? 0.1;
  const tick = agent.ticks || 0;

  // Human assignment
  if (assign && (!assign.forAgent || assign.forAgent === agent.id)) {
    if (assign.kind === "agent") {
      return goTo(agent, other.x, other.y, "meet friend", "MEET");
    }
    if (assign.kind === "human") {
      return navSocial(agent, human.x, human.y, "join human", "YOU", "follow_human");
    }
    if (assign.kind === "prop" || assign.kind === "point") {
      return goTo(agent, assign.x, assign.y, "check spot", "GO");
    }
  }

  if (ctx.callPulse > 0 && dHuman > 55) {
    return {
      see: "truth:call",
      move: "nav",
      _nav: { x: human.x, y: human.y },
      steps: 5,
      act: "none",
      say: agent.id === "bit" ? "coming!" : "fine.",
      mood: "curious",
      goal: "answer human",
      thought: "COME",
      _src: "planner",
    };
  }

  if (world.beacon && dist(agent, world.beacon) > 36) {
    return goTo(agent, world.beacon.x, world.beacon.y, "check beacon", "PING");
  }

  // Social: if far, sometimes approach partner
  if (dOther > 200 && Math.random() < 0.55 + rel * 0.2) {
    return goTo(agent, other.x, other.y, `find ${other.name}`, "FIND");
  }

  // Close: chat / emote / orbit
  if (close) {
    const r = Math.random();
    if (r < 0.35) {
      return {
        see: `truth:with ${other.name}`,
        move: "idle",
        steps: 0,
        act: "wave",
        say: banter(agent, other, rel),
        mood: "happy",
        goal: "hang with " + other.name,
        thought: "CHAT",
        _src: "planner",
      };
    }
    if (r < 0.55) {
      return {
        see: `truth:near ${other.name}`,
        move: "orbit_other",
        steps: 4,
        act: "none",
        say: Math.random() < 0.4 ? banter(agent, other, rel) : "",
        mood: "curious",
        goal: "circle " + other.name,
        thought: "ORBIT",
        _src: "planner",
      };
    }
    if (r < 0.7 && nearProp) {
      return {
        see: `truth:use ${nearProp.id}`,
        move: "idle",
        steps: 0,
        act: "use",
        say: "",
        mood: "curious",
        goal: `use ${nearProp.id}`,
        thought: "USE",
        _src: "planner",
      };
    }
    // drift slightly
    return wander(agent, room, "linger");
  }

  // Same room but not close — walk over
  if (room && otherRoom && room.id === otherRoom.id && dOther > 80) {
    return goTo(agent, other.x, other.y, "walk over", "HI");
  }

  // Mid distance: approach or explore
  if (midClose && Math.random() < 0.4 + rel * 0.15) {
    return goTo(agent, other.x, other.y, "rejoin", "JOIN");
  }

  // Use interesting prop in room
  if (nearProp && Math.random() < 0.25) {
    return {
      see: `truth:prop ${nearProp.id}`,
      move: "idle",
      steps: 0,
      act: "use",
      say: propLine(agent, nearProp),
      mood: "curious",
      goal: `fiddle with ${nearProp.id}`,
      thought: "USE",
      _src: "planner",
    };
  }

  // Head toward a prop in world for flavor
  if (Math.random() < 0.3 && world.props.length) {
    const p = world.props[Math.floor(Math.random() * world.props.length)];
    return goTo(agent, p.x, p.y, `visit ${p.id}`, "GO");
  }

  // Visit another room center
  if (Math.random() < 0.35) {
    const rooms = world.rooms;
    const dest = rooms[Math.floor(Math.random() * rooms.length)];
    return goTo(
      agent,
      dest.x + dest.w * 0.5,
      dest.y + dest.h * 0.5,
      `explore ${dest.name}`,
      "ROOM"
    );
  }

  // Human curiosity
  if (dHuman < 100 && Math.random() < 0.2) {
    return {
      see: "truth:human near",
      move: "nav",
      _nav: { x: human.x, y: human.y },
      steps: 3,
      act: Math.random() < 0.5 ? "wave" : "none",
      say: agent.id === "bit" ? "oh — hi" : "…you again",
      mood: "curious",
      goal: "notice human",
      thought: "YOU",
      _src: "planner",
    };
  }

  return wander(agent, room, "wander");
}

function wander(agent, room, tag) {
  const ang = (agent.angle || 0) + (Math.random() - 0.5) * 1.8;
  const dist = 60 + Math.random() * 100;
  const x = agent.x + Math.cos(ang) * dist;
  const y = agent.y + Math.sin(ang) * dist;
  return goTo(agent, x, y, tag, "WALK");
}

function goTo(agent, x, y, see, thought = "GO") {
  return {
    see: `truth:${see}`,
    move: "nav",
    steps: 4,
    act: "none",
    look_at: "none",
    say: "",
    mood: "curious",
    goal: see,
    thought,
    _nav: { x, y },
    _face: Math.atan2(y - agent.y, x - agent.x),
    _src: "planner",
  };
}

function navSocial(agent, x, y, see, thought, moveLabel) {
  return {
    see: `truth:${see}`,
    move: moveLabel || "nav",
    steps: 5,
    act: "none",
    say: "",
    mood: "curious",
    goal: see,
    thought,
    _nav: { x, y },
    _src: "planner",
  };
}

function banter(agent, other, rel) {
  const bitLines = [
    `hey ${other.name}`,
    "this place hums",
    "wanna roam?",
    "coffee later?",
    "void's cozy today",
    "i like your glow",
  ];
  const noxLines = [
    `hm ${other.name}`,
    "don't get weird",
    "lab's quieter",
    "fine. company.",
    "still here?",
    "…hi",
  ];
  const cold = [
    "space",
    "whatever",
    "moving on",
  ];
  const pool =
    rel < -0.2 ? cold : agent.id === "bit" ? bitLines : noxLines;
  return pool[Math.floor(Math.random() * pool.length)];
}

function propLine(agent, prop) {
  if (prop.id === "coffee") return agent.id === "bit" ? "warm pixels~" : "caffeine. sure.";
  if (prop.id === "terminal") return agent.id === "bit" ? "pretty logs" : "noisy code";
  if (prop.id === "whiteboard") return "notes…";
  if (prop.id === "couch") return agent.id === "bit" ? "soft!" : "five minutes";
  if (prop.id === "tree") return "green.";
  return "";
}

/**
 * Hybrid: VLM when see-score OK, else social planner.
 */
export function hybridDecide(vlmAction, seeScore, agent, other, human, world, ctx) {
  const planner = planFromTruth(agent, other, human, world, ctx);
  const force = ctx.forceHeuristic || ctx.heuristicOnly;

  if (force || seeScore < 0.28 || !vlmAction) {
    return { ...planner, _hybrid: force ? "heuristic" : "planner-fallback" };
  }

  if (seeScore >= 0.45) {
    // keep VLM but ensure we have social-ish defaults
    return {
      ...vlmAction,
      thought: vlmAction.thought || (vlmAction.say ? "CHAT" : vlmAction.move || "…"),
      _hybrid: "vlm",
      _src: "vlm",
    };
  }

  return {
    ...planner,
    say: vlmAction.say || planner.say,
    mood: vlmAction.mood || planner.mood,
    _hybrid: "blend",
  };
}
