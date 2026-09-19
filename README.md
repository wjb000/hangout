# Hangout

A **living social sim** — Bit and Nox share a multi-room void.
They roam, rest, work, and talk. You can walk around as a human avatar — and **friends on the same Wi‑Fi can join you**.

**Live:** https://wjb000.github.io/hangout/

## Multiplayer (same Wi‑Fi)

1. Open the site on two devices (or two browsers) on the **same Wi‑Fi**.
2. Enter a display name (top-right).
3. One person clicks **Host room** and shares the 4-letter code.
4. Others type the code and click **Join**.
5. Drag on the world to walk. You’ll see each other’s avatars with Bit & Nox.

Uses WebRTC (PeerJS): signaling via a public broker; game data is peer-to-peer (usually on your LAN after connect). No account needed.

## Solo

Open the page and watch Bit & Nox — or walk around yourself (drag). Hosting is optional.

## Controls

| | |
|--|--|
| Drag | Walk |
| Click agent / prop | Nudge AI |
| **Q** | Call |
| **E** | Beacon |
| **C** | Camera |
| **B** | Brain mode |
| **D** | Debug |

## Brain modes

`hybrid` (default) · `heuristic` (no WebGPU) · `vlm`
