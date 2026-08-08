# Hangout · VLA World

In-browser **Vision-Language-Action** hangout with a 3‑minute co-op mission.

**Live:** https://wjb000.github.io/hangout/

## Mission: Orb Heist

Collect orbs, meet up, talk, beat the clock.

### Win conditions
- Hold all **3 orbs** (combined) **and** Bit & Nox meet in the same room with LOS  
- **or** complete every objective chip  

## Features

| Area | Details |
|------|---------|
| World | Lobby / Lab / Den / Yard, walls, props, orbs, Node NPC |
| Vision | Egocentric FOV, high-contrast labels, multi-frame strips, see-vs-truth scoring |
| VLA | SmolVLM on WebGPU, JSON retries + repair, optional remote API |
| Actions | move/turn/skills, grab/drop/use, follow human, goto beacon |
| Space | Hearing range, LOS, spatial SFX |
| Social | Relationship scores Bit↔Nox↔You |
| Meta | Quests, minimap, toasts, replay (`R`), debug (`D`) |

## Controls

| Key | Action |
|-----|--------|
| Mouse | You (green) |
| Click | Say `hey.` |
| Hold **Q** | Call agents (`follow_human`) |
| **E** | Plant beacon |
| **D** | Debug (truth vs see, raw output) |
| **R** | Replay last trajectory |

## Optional remote VLM

In the browser console:

```js
window.HANGOUT_VLM = {
  baseUrl: "https://api.x.ai/v1",
  apiKey: "YOUR_KEY",
  model: "grok-2-vision-1212",
};
// reload page
```

Uses OpenAI-compatible chat completions with image_url. Falls back to local SmolVLM when available.

## Requirements

Chrome/Edge + **WebGPU** (or remote VLM only). First local load downloads model weights (cached after).
