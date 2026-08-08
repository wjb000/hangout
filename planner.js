/**
 * Ground-truth heuristic planner — hybrid fallback when VLM see-score is low.
 */
import { dist, roomAt, nearestFreePickup, hasLOS } from "./world.js";

/**
 * Plan next action from perfect world state (no vision needed).
 * @param {object} agent
 * @param {object} other partner agent
 * @param {object} human
 * @param {object} world
 * @param {object} ctx { phase, beacon, callPulse, assignTarget }
 */
export function planFromTruth(agent, other, human, world, ctx = {}) {
  const phase = ctx.phase || 1;
  const assign = ctx.assignTarget; // {kind, id, x, y} from human click
  const holding = !!agent.holding;
  const otherHolding = !!other.holding;
  const freeOrbs = world.pickups.filter((p) => !p.heldBy);
  const nearOrb = nearestFreePickup(world, agent.x, agent.y, 200);
  const grabOrb = nearestFreePickup(world, agent.x, agent.y, 40);

  // Human assignment (for this agent, or unscoped)
  if (assign && (!assign.forAgent || assign.forAgent === agent.id)) {
    if (assign.kind === "orb") {
      const orb = world.pickups.find((p) => p.id === assign.id && !p.heldBy);
      if (orb) {
        const d = dist(agent, orb);
        if (d < 40) {
          return act("grab", "forward", 1, `grabbing ${orb.id}`, "got it");
        }
        return goTo(agent, orb.x, orb.y, `seek ${orb.id}`);
      }
    }
    if (assign.kind === "agent") {
      return goTo(agent, other.x, other.y, "meet assigned", "toward");
    }
    if (assign.kind === "human") {
      return { see: "truth:human", move: "follow_human", steps: 5, act: "none", say: "", mood: "curious", goal: "follow you", _src: "planner" };
    }
    if (assign.kind === "point") {
      return goTo(agent, assign.x, assign.y, "go to point");
    }
  }

  // Call / beacon
  if (ctx.callPulse > 0 && dist(agent, human) > 50) {
    return { see: "truth:call", move: "follow_human", steps: 5, act: "none", say: "coming!", mood: "happy", goal: "answer call", _src: "planner" };
  }
  if (world.beacon && dist(agent, world.beacon) > 30) {
    return { see: "truth:beacon", move: "goto_beacon", steps: 6, act: "none", say: "", mood: "curious", goal: "beacon", _src: "planner" };
  }

  // Phase-aware goals
  // Phase 1: each get an orb
  // Phase 2: meet partner
  // Phase 3: get remaining orbs together
  if (phase === 1) {
    if (!holding) {
      if (grabOrb) return act("grab", "forward", 1, `orb@${Math.round(dist(agent, grabOrb))}`, "mine");
      if (nearOrb) return goTo(agent, nearOrb.x, nearOrb.y, `hunt ${nearOrb.id}`);
      // explore toward unexplored-ish center of rooms without orbs held
      const target = freeOrbs[0] || { x: 480, y: 300 };
      return goTo(agent, target.x, target.y, "search orbs");
    }
    // has orb — wait for partner or go center
    if (!otherHolding) {
      return {
        see: "truth:have orb wait",
        move: "idle",
        steps: 0,
        act: "wave",
        say: "got one",
        mood: "happy",
        goal: "wait for partner orb",
        _src: "planner",
      };
    }
    // both have → phase will advance; approach
    return goTo(agent, other.x, other.y, "rendezvous", "toward");
  }

  if (phase === 2) {
    const d = dist(agent, other);
    const sameRoom =
      roomAt(world, agent.x, agent.y)?.id === roomAt(world, other.x, other.y)?.id;
    if (d < 70 && sameRoom && hasLOS(world, agent.x, agent.y, other.x, other.y)) {
      return {
        see: "truth:met",
        move: "idle",
        steps: 0,
        act: "wave",
        say: "team up",
        mood: "happy",
        goal: "met partner",
        _src: "planner",
      };
    }
    return goTo(agent, other.x, other.y, "meet partner", "toward");
  }

  // Phase 3: remaining free orbs
  if (!holding && grabOrb) {
    return act("grab", "forward", 1, "last orbs", "yes");
  }
  if (!holding && nearOrb) {
    return goTo(agent, nearOrb.x, nearOrb.y, `secure ${nearOrb.id}`);
  }
  if (freeOrbs.length) {
    // split: bit prefers lower index, nox higher
    const idx = agent.id === "bit" ? 0 : freeOrbs.length - 1;
    const orb = freeOrbs[Math.max(0, idx)];
    return goTo(agent, orb.x, orb.y, `split hunt ${orb.id}`);
  }
  // all held — celebrate near partner
  if (dist(agent, other) > 80) {
    return goTo(agent, other.x, other.y, "victory lap", "toward");
  }
  return {
    see: "truth:done",
    move: "orbit_other",
    steps: 4,
    act: "wave",
    say: "we did it",
    mood: "happy",
    goal: "celebrate",
    _src: "planner",
  };
}

function goTo(agent, x, y, see, moveOverride) {
  const dx = x - agent.x;
  const dy = y - agent.y;
  const d = Math.hypot(dx, dy) || 1;
  const steps = Math.max(2, Math.min(6, Math.round(d / 40)));
  // prefer toward if chasing other-like; else forward after angle
  return {
    see: `truth:${see}`,
    move: moveOverride || "forward",
    steps,
    act: "none",
    look_at: "none",
    say: "",
    mood: "curious",
    goal: see,
    _face: Math.atan2(dy, dx),
    _src: "planner",
  };
}

function act(actName, move, steps, see, say = "") {
  return {
    see: `truth:${see}`,
    move,
    steps,
    act: actName,
    say,
    mood: actName === "grab" ? "happy" : "curious",
    goal: see,
    _src: "planner",
  };
}

/**
 * Merge VLM action with planner: if see-score low or forceHeuristic, use planner.
 * If medium score, prefer VLM move but allow planner grab when orb in range.
 */
export function hybridDecide(vlmAction, seeScore, agent, other, human, world, ctx) {
  const planner = planFromTruth(agent, other, human, world, ctx);
  const force = ctx.forceHeuristic || ctx.heuristicOnly;

  if (force || seeScore < 0.28 || !vlmAction) {
    return { ...planner, _hybrid: force ? "heuristic" : "planner-fallback" };
  }

  // high confidence vision — trust VLM but rescue obvious grabs
  if (seeScore >= 0.45) {
    const grabOrb = nearestFreePickup(world, agent.x, agent.y, 38);
    if (grabOrb && !agent.holding && vlmAction.act !== "grab") {
      return {
        ...vlmAction,
        act: "grab",
        see: (vlmAction.see || "") + " +rescue-grab",
        _hybrid: "vlm+rescue",
      };
    }
    return { ...vlmAction, _hybrid: "vlm", _src: "vlm" };
  }

  // medium: blend — use planner navigation, keep VLM speech if any
  return {
    ...planner,
    say: vlmAction.say || planner.say,
    mood: vlmAction.mood || planner.mood,
    _hybrid: "blend",
  };
}
