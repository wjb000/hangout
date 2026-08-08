# Hangout · VLA World

In-browser **Vision-Language-Action** hangout sim.

**Live:** https://wjb000.github.io/hangout/

## Features

- **World:** Lobby, Lab, Den, Yard — walls, doors, props, collectible orbs
- **Agents:** Bit & Nox (VLA-driven) + ambient **Node** + **you** (mouse)
- **Vision:** Egocentric FOV camera (SmolVLM on WebGPU); multi-frame strips
- **Actions:** move/turn/skills (`orbit_other`, `follow`, `patrol_edge`), grab/drop/use, speech
- **Space rules:** hearing range + line-of-sight; wall collision
- **Memory:** short-term + `localStorage` long-term
- **Goals:** meet, collect orbs, visit rooms, talk quota
- **Audio:** steps, bumps, talk blips
- **Debug:** press `D`

## Requirements

Chrome/Edge with **WebGPU**. First load downloads SmolVLM (~hundreds of MB), then caches.

## Controls

| Input | Effect |
|--------|--------|
| Mouse move | You (green) in the world |
| Click | Say `hey.` if nearby agents can hear |
| `D` | Toggle debug overlay |

## Stack

- `transformers.js` + **SmolVLM-256M** (fallback 500M)
- Static GitHub Pages (no server)
