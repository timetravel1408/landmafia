// Original synthesized SFX via WebAudio (no sound files). Muted by default; not remembered.
let ctx: AudioContext | null = null;
let enabled = false;

export function setSound(on: boolean) {
  enabled = on;
  if (on && !ctx) ctx = new AudioContext();
  if (on) ctx?.resume();
}
export const soundOn = () => enabled;

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'triangle', vol = 0.15, slideTo?: number) {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(start: number, dur: number, vol = 0.2, hp = 1200) {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

export const sfx = {
  claim() {
    if (!enabled) return;
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.25, 'triangle', 0.12));
  },
  capture() {
    if (!enabled) return;
    tone(196, 0, 0.35, 'sawtooth', 0.08);
    tone(294, 0.12, 0.45, 'sawtooth', 0.08);
  },
  cut() {
    if (!enabled) return;
    noise(0, 0.25, 0.25, 2500);
    tone(880, 0, 0.3, 'square', 0.05, 220);
  },
  bounty() {
    if (!enabled) return;
    [392, 523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3, 'square', 0.06));
  },
  tax() {
    if (!enabled) return;
    [988, 784, 659].forEach((f, i) => tone(f, i * 0.08, 0.15, 'sine', 0.1));
  },
  blocked() {
    if (!enabled) return;
    tone(150, 0, 0.25, 'square', 0.07, 110);
  },
};
