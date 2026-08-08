/** Lightweight Web Audio SFX for the sim */

let ctx = null;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function blip(freq, dur = 0.06, type = "square", gain = 0.03) {
  try {
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur);
  } catch {
    /* ignore autoplay blocks until user gesture */
  }
}

export const sfx = {
  step: () => blip(120 + Math.random() * 40, 0.04, "triangle", 0.02),
  bump: () => blip(70, 0.1, "sawtooth", 0.04),
  talk: (who) => blip(who === "nox" ? 280 : who === "node" ? 360 : 220, 0.08, "square", 0.035),
  grab: () => blip(440, 0.07, "sine", 0.04),
  drop: () => blip(180, 0.09, "triangle", 0.04),
  goal: () => {
    blip(523, 0.08, "sine", 0.04);
    setTimeout(() => blip(659, 0.1, "sine", 0.04), 80);
  },
  boot: () => blip(200, 0.12, "sine", 0.03),
};

// unlock audio on first interaction
export function unlockAudio() {
  try {
    ac();
  } catch {
    /* */
  }
}
