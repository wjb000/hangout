/** Spatial Web Audio SFX */

let ctx = null;
let listenerPos = { x: 480, y: 300 };

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function setListener(x, y) {
  listenerPos = { x, y };
}

/**
 * @param {number} freq
 * @param {object} opts
 * @param {number} [opts.x] world x for spatial
 * @param {number} [opts.y] world y
 * @param {boolean} [opts.muted] force mute (e.g. no LOS)
 * @param {number} [opts.maxDist]
 */
function blip(freq, dur = 0.06, type = "square", gain = 0.03, opts = {}) {
  try {
    if (opts.muted) return;
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;

    let vol = gain;
    if (opts.x != null && opts.y != null) {
      const d = Math.hypot(opts.x - listenerPos.x, opts.y - listenerPos.y);
      const maxD = opts.maxDist || 280;
      const att = Math.max(0, 1 - d / maxD);
      vol *= att * att;
      if (vol < 0.002) return;
    }

    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur);
  } catch {
    /* autoplay */
  }
}

export const sfx = {
  step: (x, y, muted) =>
    blip(110 + Math.random() * 50, 0.035, "triangle", 0.022, { x, y, muted, maxDist: 220 }),
  bump: (x, y) => blip(65, 0.1, "sawtooth", 0.045, { x, y, maxDist: 300 }),
  talk: (who, x, y, muted) =>
    blip(who === "nox" ? 280 : who === "node" ? 360 : who === "you" ? 200 : 220, 0.09, "square", 0.04, {
      x,
      y,
      muted,
      maxDist: 320,
    }),
  grab: (x, y) => blip(440, 0.07, "sine", 0.045, { x, y }),
  drop: (x, y) => blip(180, 0.09, "triangle", 0.04, { x, y }),
  fail: (x, y) => blip(90, 0.12, "sawtooth", 0.05, { x, y }),
  success: (x, y) => blip(520, 0.08, "sine", 0.04, { x, y }),
  goal: () => {
    blip(523, 0.08, "sine", 0.05);
    setTimeout(() => blip(659, 0.1, "sine", 0.05), 80);
    setTimeout(() => blip(784, 0.12, "sine", 0.045), 160);
  },
  call: (x, y) => {
    blip(330, 0.1, "sine", 0.05, { x, y, maxDist: 500 });
    setTimeout(() => blip(440, 0.12, "sine", 0.05, { x, y, maxDist: 500 }), 100);
  },
  beacon: (x, y) => blip(600, 0.15, "sine", 0.035, { x, y, maxDist: 600 }),
  win: () => {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => blip(f, 0.15, "sine", 0.05), i * 120));
  },
  boot: () => blip(200, 0.12, "sine", 0.03),
};

export function unlockAudio() {
  try {
    ac();
  } catch {
    /* */
  }
}
