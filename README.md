# Hangout · Orb Heist

In-browser **hybrid VLA** hangout — vision model + ground-truth planner.

**Live:** https://wjb000.github.io/hangout/

## Mission (2:00)

| Phase | Goal |
|-------|------|
| **1** | Each agent holds an orb |
| **2** | Meet in same room with line-of-sight |
| **3** | All 3 orbs held (agents and/or you) |

Node pings orb beacons if you're stuck. Fail-forward hints every ~45s.

## Brain modes (click `brain:` or **B**)

| Mode | Behavior |
|------|----------|
| **hybrid** | VLM when see-score OK; planner when not (+ grab rescue) |
| **heuristic** | Truth planner only — instant, no WebGPU needed |
| **vlm** | Prefer model; still hybrid-rescues |

## Controls

| Input | Action |
|-------|--------|
| Move / drag | You + draw path |
| Click orb/agent | Assign target to nearer agent |
| **Q** / Call | Agents follow you |
| **E** / Beacon | Plant beacon |
| **F** | Handoff / grab / drop orb |
| **C** | Spectator cam ↔ wide |
| **D** | Debug |
| **H** / **R** | Highlight reel |
| **B** | Cycle brain |

## Optional remote VLM

```js
window.HANGOUT_VLM = {
  baseUrl: "https://api.x.ai/v1",
  apiKey: "YOUR_KEY",
  model: "grok-2-vision-1212",
};
window.HANGOUT_VISION_STUB = true; // debug: pretend perfect vision
```

## Requirements

Chrome/Edge. **WebGPU** for local SmolVLM; heuristic mode works without it.
