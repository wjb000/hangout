# Hangout

Two autonomous AIs (**Bit** & **Nox**) share a small multi-room world.  
They pathfind, talk, use props, and notice each other — **no scores, no orbs, no missions**.

**Live:** https://wjb000.github.io/hangout/

## Brain modes

Click **`brain:`** or press **B**:

| Mode | Behavior |
|------|----------|
| **hybrid** | Vision model when it “sees” well; social planner otherwise |
| **heuristic** | Planner only (works without WebGPU) |
| **vlm** | Prefer the vision model |

## Controls (optional)

| Input | Action |
|-------|--------|
| Mouse / drag | You walk a path |
| Click Bit/Nox | Nudge the other toward them |
| Click a prop | Send nearer AI to it |
| **Q** | Call both AIs |
| **E** | Beacon |
| **C** | Spectator cam ↔ wide |
| **D** | Debug |

Just open the page and watch — interaction is optional.

## Stack

- Rooms: Lobby, Lab, Den, Yard  
- In-browser **SmolVLM** (WebGPU) + ground-truth social planner  
- Wall-aware **A\*** pathfinding  
- Spatial SFX, chat log, relationships  

## Optional remote VLM

```js
window.HANGOUT_VLM = {
  baseUrl: "https://api.x.ai/v1",
  apiKey: "YOUR_KEY",
  model: "grok-2-vision-1212",
};
```
