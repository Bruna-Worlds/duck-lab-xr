// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck Lab XR film music: a small synthesizer in plain JavaScript. Every sound
 * is made from maths here (sine partials, filtered noise, a Freeverb-style
 * room), so the music belongs to this project and is free to use anywhere,
 * with nothing to licence or credit. Instruments: pad, strings, piano, pluck,
 * pizz, arp, bell, celesta, brass, squeeze, bass, sub, kick, snare, clap,
 * brush, hat, shaker, taiko, timpani, blow, swell, riser; effects (on their
 * own bus): click, thunk, chime, beep, whir, swish, step, thud, quack, tap,
 * powerup, sparkle, montage, rec, alert, strain and more.
 *
 * track(seed, seconds) -> { L, R, SL, SR, FX, I, add, rnd, N }: write notes
 * with T.I.<instrument>(...), then master(T, seconds, options) -> a 48 kHz
 * stereo 16-bit WAV buffer.
 */
export const RATE = 48000;
export const TAU = Math.PI * 2;
export const midi = (n) => 440 * 2 ** ((n - 69) / 12);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const LOW = { bass: 0.32, sub: 0.2, kick: 0.45, taiko: 0.5, timpani: 0.5, blow: 0.45, step: 0.45 };

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function track(seed, TOTAL) {
  const N = Math.ceil((TOTAL + 0.5) * RATE);
  const L = new Float32Array(N), R = new Float32Array(N), SL = new Float32Array(N), SR = new Float32Array(N);
  const FX = { L: new Float32Array(N), R: new Float32Array(N) };
  const rnd = random(seed);
  const noise = () => rnd() * 2 - 1;
  function add(start, length, gain, pan, send, sample, fx = false) {
    const first = Math.round(start * RATE);
    const count = Math.round(length * RATE);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    const tl = fx ? FX.L : L, tr = fx ? FX.R : R;
    for (let i = 0; i < count; i++) {
      const at = first + i;
      if (at < 0 || at >= N) continue;
      const x = sample(i / RATE, i);
      tl[at] += x * gl; tr[at] += x * gr; SL[at] += x * gl * send; SR[at] += x * gr * send;
    }
  }
  function lowpass(hz) {
    let y = 0;
    let a = 1 - Math.exp((-TAU * hz) / RATE);
    const f = (x) => (y += a * (x - y));
    f.tune = (to) => { a = 1 - Math.exp((-TAU * to) / RATE); };
    return f;
  }
  function harmonics(freq, strengths) {
    const count = Math.min(strengths.length, Math.floor(15000 / freq));
    return (t) => { const p = TAU * freq * t; let x = 0; for (let n = 1; n <= count; n++) x += strengths[n - 1] * Math.sin(n * p); return x; };
  }
  const falling = (count, power) => Array.from({ length: count }, (_, n) => 1 / (n + 1) ** power);
  const I = {
    pad(note, start, length, gain, bright = 1.7) {
      for (const [d, pan] of [[-0.003, -0.6], [0.003, 0.6], [0, 0]]) {
        const w = harmonics(midi(note) * (1 + d), falling(8, bright));
        const hold = length + 0.8;
        add(start, hold, gain * 0.33, pan, 0.9, (t) => w(t) * clamp01(t / 0.5) * clamp01((hold - t) / 0.8));
      }
    },
    strings(note, start, gain, pan, length = 0.2) {
      const w = harmonics(midi(note), falling(12, 1.05));
      add(start, length + 0.15, gain, pan, 0.45, (t) => w(t) * clamp01(t / 0.006) * (t < length ? Math.exp(-t * 5) : Math.exp(-length * 5) * clamp01((length + 0.15 - t) / 0.15)));
    },
    piano(note, start, gain, pan = 0, decay = 1) {
      const f = midi(note), parts = [1, 0.55, 0.32, 0.18, 0.1, 0.06];
      add(start, 2.4, gain, pan, 0.6, (t) => {
        let x = 0;
        for (let n = 1; n <= parts.length; n++) { const fn = f * n * Math.sqrt(1 + 0.0004 * n * n); if (fn > 12000) break; x += parts[n - 1] * Math.sin(TAU * fn * t) * Math.exp(-t * (1.5 + 0.9 * n) * decay); }
        return x * clamp01(t / 0.004) * clamp01((2.4 - t) / 0.3);
      });
    },
    pluck(note, start, gain, pan = 0, decay = 7) {
      const f = midi(note);
      add(start, 0.7, gain, pan, 0.35, (t) => (Math.sin(TAU * f * t) * Math.exp(-t * decay) + 0.35 * Math.sin(TAU * f * 4 * t) * Math.exp(-t * 22) + 0.12 * Math.sin(TAU * f * 10 * t) * Math.exp(-t * 40)) * clamp01(t / 0.002));
    },
    pizz(note, start, gain, pan = 0) {
      const f = midi(note);
      add(start, 0.4, gain, pan, 0.4, (t) => { let x = 0; for (let n = 1; n <= 6; n++) x += Math.sin(TAU * f * n * t) / (n * n) * Math.exp(-t * (9 + n * 4)); return x * clamp01(t / 0.003); });
    },
    arp(note, start, gain, pan = 0, length = 0.12) {
      const f = midi(note);
      const lp = lowpass(4200);
      add(start, length + 0.08, gain, pan, 0.4, (t) => {
        let x = 0; for (let n = 1; n <= 10; n++) x += Math.sin(TAU * f * n * t * (1 + 0.002 * (n % 2))) / n;
        return lp(x) * clamp01(t / 0.004) * Math.exp(-t * 9) * clamp01((length + 0.08 - t) / 0.08);
      });
    },
    bell(note, start, gain, pan = 0) {
      const f = midi(note);
      add(start, 2.6, gain, pan, 1.0, (t) => (Math.sin(TAU * f * t) * Math.exp(-t * 2.2) + 0.4 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t * 4) + 0.2 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t * 7)) * clamp01(t / 0.003));
    },
    celesta(note, start, gain, pan = 0) {
      const f = midi(note);
      add(start, 1.6, gain, pan, 1.1, (t) => (Math.sin(TAU * f * t) * Math.exp(-t * 3) + 0.25 * Math.sin(TAU * f * 4 * t) * Math.exp(-t * 9) + 0.1 * Math.sin(TAU * f * 8.1 * t) * Math.exp(-t * 16)) * clamp01(t / 0.002));
    },
    brass(note, start, length, gain, pan = 0) {
      const f = midi(note); let ph = 0; const hold = length + 0.15;
      add(start, hold, gain, pan, 0.6, (t) => {
        ph += (TAU * f * (1 + 0.003 * Math.sin(TAU * 5.2 * t) * clamp01((t - 0.2) / 0.4))) / RATE;
        const sw = clamp01(t / 0.05) * (0.75 + 0.25 * Math.exp(-t * 2.5)) * clamp01((hold - t) / 0.15);
        let x = 0; for (let n = 1; n <= 10; n++) x += Math.sin(n * ph) / n * Math.exp(-n * (1 - sw) * 0.4);
        return x * sw;
      });
    },
    squeeze(note, start, length, gain, pan = 0) { // accordion-ish reed
      const f = midi(note); const hold = length + 0.1;
      add(start, hold, gain, pan, 0.5, (t) => {
        let x = 0; for (let n = 1; n <= 9; n += 1) x += (n % 2 ? 1 : 0.5) * Math.sin(TAU * f * n * t * (1 + 0.004 * Math.sin(TAU * 4.5 * t))) / n;
        x += 0.6 * Math.sin(TAU * f * 1.004 * t);
        return x * clamp01(t / 0.03) * clamp01((hold - t) / 0.1);
      });
    },
    bass(note, start, length, gain, plucked = true) {
      const f = midi(note); const hold = length + 0.06;
      add(start, hold, gain * LOW.bass, 0, 0.05, (t) => { const p = TAU * f * t; return (Math.sin(p) + 0.5 * Math.sin(2 * p) + 0.2 * Math.sin(3 * p)) * clamp01(t / 0.005) * (plucked ? Math.exp(-t * 4.5) : 1) * clamp01((hold - t) / 0.06); });
    },
    sub(note, start, length, gain) {
      const f = midi(note); const hold = length + 0.1;
      add(start, hold, gain * LOW.sub, 0, 0, (t) => (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t)) * clamp01(t / 0.04) * clamp01((hold - t) / 0.1));
    },
    kick(start, gain) { let ph = 0; add(start, 0.4, gain * LOW.kick, 0, 0.08, (t) => { ph += (TAU * (48 + 110 * Math.exp(-t * 40))) / RATE; return Math.sin(ph) * Math.exp(-t * 10); }); },
    snare(start, gain, pan = 0.1) { const lp = lowpass(1400); add(start, 0.3, gain, pan, 0.4, (t) => { const x = noise(); return (x - lp(x)) * Math.exp(-t * 20) + Math.sin(TAU * 190 * t) * Math.exp(-t * 32) * 0.6; }); },
    clap(start, gain, pan = 0) {
      const lp = lowpass(2600), hp = lowpass(700);
      add(start, 0.35, gain, pan, 0.5, (t) => { const x = noise(); const b = lp(x); const env = (t < 0.03 ? (Math.exp(-((t % 0.011) * 300))) : Math.exp(-(t - 0.03) * 16)); return (b - hp(b)) * 1.8 * env; });
    },
    brush(start, gain, pan = 0.2) { const lp = lowpass(5000), hp = lowpass(1800); add(start, 0.25, gain, pan, 0.3, (t) => { const x = lp(noise()); return (x - hp(x)) * Math.exp(-t * 14) * clamp01(t / 0.01); }); },
    hat(start, gain, pan = 0.35) { const lp = lowpass(7000); add(start, 0.07, gain, pan, 0.12, (t) => { const x = noise(); return (x - lp(x)) * Math.exp(-t * 80); }); },
    shaker(start, gain, pan = 0.4) { const lp = lowpass(9000), hp = lowpass(3500); add(start, 0.1, gain, pan, 0.2, (t) => { const x = lp(noise()); return (x - hp(x)) * Math.sin(Math.PI * clamp01(t / 0.1)); }); },
    taiko(start, gain, pan = 0) { const sk = lowpass(900); let ph = 0; add(start, 0.9, gain * LOW.taiko, pan, 0.4, (t) => { ph += (TAU * (58 + 70 * Math.exp(-t * 28))) / RATE; return Math.sin(ph) * Math.exp(-t * 6.5) + sk(noise()) * Math.exp(-t * 30) * 1.4; }); },
    timpani(note, start, gain, pan = -0.2) { const f = midi(note), sk = lowpass(700); let ph = 0; add(start, 1.2, gain * LOW.timpani, pan, 0.5, (t) => { ph += (TAU * f * (1 + 0.25 * Math.exp(-t * 22))) / RATE; return (Math.sin(ph) + 0.35 * Math.sin(ph * 1.5) * Math.exp(-t * 6)) * Math.exp(-t * 4) + sk(noise()) * Math.exp(-t * 26) * 1.2; }); },
    blow(start, gain) {
      const rum = lowpass(380), air = lowpass(5200);
      add(start, 3.5, gain * LOW.blow, 0, 0.9, (t) => { const x = noise(); return (Math.sin(TAU * 38 * t) * Math.exp(-t * 1.6) + 0.7 * Math.sin(TAU * (52 + 60 * Math.exp(-t * 18)) * t) * Math.exp(-t * 3) + rum(x) * Math.exp(-t * 3.2) * 2.0 + (x - air(x)) * Math.exp(-t * 2.2) * 0.25) * clamp01(t / 0.002); });
    },
    swell(end, length, gain) { const lp = lowpass(2500); add(end - length, length, gain, 0, 0.8, (t) => { const x = noise(); return (x - lp(x)) * Math.exp((t - length) * 3.4); }); },
    riser(start, length, gain) {
      const f = lowpass(300); let ph = 0;
      add(start, length, gain, 0, 0.6, (t) => { const u = t / length; f.tune(300 + 9000 * u * u); ph += (TAU * (220 * 4 ** u)) / RATE; return (f(noise()) * 1.6 + Math.sin(ph) * 0.2) * u * u * clamp01((length - t) / 0.03); });
    },
    // ---------------- effects (written to the FX bus: louder, less reverb)
    click(start, gain, pan = 0) { const lp = lowpass(9000), hp = lowpass(2500); add(start, 0.05, gain, pan, 0.1, (t) => { const x = lp(noise()); return (x - hp(x)) * Math.exp(-t * 120) + Math.sin(TAU * 1800 * t) * Math.exp(-t * 90) * 0.4; }, true); },
    thunk(start, gain, pan = 0, pitch = 140) { const lp = lowpass(600); add(start, 0.35, gain, pan, 0.2, (t) => Math.sin(TAU * (pitch * (1 + 0.5 * Math.exp(-t * 30))) * t) * Math.exp(-t * 14) + lp(noise()) * Math.exp(-t * 35) * 0.8, true); },
    chime(notes, start, gain, pan = 0.1, step = 0.07) { notes.forEach((n, k) => I.bell(n, start + k * step, gain * (1 - k * 0.12), pan + (k % 2 ? 0.15 : -0.15))); },
    beep(note, start, length, gain, pan = 0) { const f = midi(note); add(start, length, gain, pan, 0.25, (t) => (Math.sin(TAU * f * t) + 0.2 * Math.sin(TAU * 3 * f * t)) * clamp01(t / 0.004) * clamp01((length - t) / 0.02), true); },
    whir(start, length, gain, f0 = 180, f1 = 260, pan = 0) {
      const lp = lowpass(1600); let ph = 0;
      add(start, length, gain, pan, 0.15, (t) => {
        const u = t / length; const f = f0 + (f1 - f0) * Math.sin(Math.PI * u); ph += (TAU * f) / RATE;
        let x = 0; for (let n = 1; n <= 8; n++) x += Math.sin(n * ph) / n;
        return lp(x + 0.15 * noise()) * clamp01(t / 0.06) * clamp01((length - t) / 0.1) * (0.8 + 0.2 * Math.sin(TAU * 31 * t));
      }, true);
    },
    swish(start, length, gain, pan = 0) {
      const lo = lowpass(400), hi = lowpass(3500);
      add(start, length, gain, pan, 0.4, (t) => { const u = t / length; hi.tune(900 + 3200 * Math.sin(Math.PI * u)); const x = hi(noise()); return (x - lo(x)) * Math.sin(Math.PI * u) ** 1.5; }, true);
    },
    step(start, gain, pan = 0) { // robot footstep: rubber sole thump + tiny servo zip
      const lp = lowpass(500); let ph = 0;
      add(start, 0.22, gain * LOW.step, pan, 0.08, (t) => { ph += (TAU * (75 + 40 * Math.exp(-t * 50))) / RATE; return Math.sin(ph) * Math.exp(-t * 28) + lp(noise()) * Math.exp(-t * 60) * 0.9; }, true);
      add(start - 0.07, 0.08, gain * 0.12, pan, 0.05, (t) => Math.sin(TAU * (520 + 900 * t) * t) * Math.sin(Math.PI * t / 0.08), true);
    },
    bonk(start, gain, pan = 0) { // hollow foam-hammer bonk + spring boing
      add(start, 0.5, gain, pan, 0.3, (t) => { const f = 210 * (1 + 0.6 * Math.exp(-t * 40)); return (Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * f * 2.7 * t) * Math.exp(-t * 12)) * Math.exp(-t * 9) * clamp01(t / 0.002); }, true);
      let ph = 0;
      add(start + 0.03, 0.9, gain * 0.45, pan, 0.5, (t) => { ph += (TAU * (330 + 120 * Math.sin(TAU * 11 * t) * Math.exp(-t * 3))) / RATE; return Math.sin(ph) * Math.exp(-t * 4) * clamp01(t / 0.01); }, true);
    },
    splash(start, gain, pan = 0) { // into foam: soft whump + patter of cubes
      const lp = lowpass(1100), lp2 = lowpass(2500);
      add(start, 0.9, gain, pan, 0.4, (t) => lp(noise()) * 2.2 * Math.exp(-t * 6) * clamp01(t / 0.01) + Math.sin(TAU * 70 * t) * Math.exp(-t * 14) * 0.8, true);
      for (let k = 0; k < 9; k++) { const d = 0.15 + rnd() * 0.9; add(start + d, 0.08, gain * 0.25, pan + (rnd() - 0.5) * 0.6, 0.2, (t) => lp2(noise()) * Math.exp(-t * 60), true); }
    },
    splat(start, gain, pan = 0) {
      const bp = lowpass(1400), hp = lowpass(500);
      add(start, 0.3, gain, pan, 0.2, (t) => { const x = bp(noise()); return (x - hp(x)) * 2.4 * Math.exp(-t * 18) + Math.sin(TAU * (300 - 400 * t) * t) * Math.exp(-t * 20) * 0.6; }, true);
    },
    thud(start, gain, pan = 0) { I.thunk(start, gain, pan, 70); I.thunk(start + 0.02, gain * 0.5, -pan, 110); },
    creak(start, length, gain, pan = 0) {
      let ph = 0; const res = lowpass(900);
      add(start, length, gain, pan, 0.3, (t) => { const f = 180 + 120 * Math.sin(TAU * 0.7 * t) + 40 * Math.sin(TAU * 3.1 * t); ph += (TAU * f) / RATE; const saw = ((ph / TAU) % 1) * 2 - 1; const am = 0.5 + 0.5 * Math.sin(TAU * 23 * t); return res(saw) * am * clamp01(t / 0.1) * clamp01((length - t) / 0.2); }, true);
    },
    crowd(start, length, gain, surge = []) {
      const b1 = lowpass(1800), b2 = lowpass(350);
      add(start, length, gain, 0, 0.6, (t) => {
        let amp = 0.55 + 0.15 * Math.sin(TAU * 0.7 * t) + 0.1 * Math.sin(TAU * 1.9 * t + 1);
        for (const [s, d, k] of surge) amp += k * Math.exp(-Math.max(0, t + start - s) * d) * (t + start >= s ? clamp01((t + start - s) / 0.15) : 0);
        const x = b1(noise()); return (x - b2(x)) * amp;
      }, true);
    },
    wave(start, length, gain, pan = 0) { const lp = lowpass(600); add(start, length, gain, pan, 0.5, (t) => lp(noise()) * 2.0 * Math.sin(Math.PI * clamp01(t / length)) ** 2, true); },
    gull(start, gain, pan = 0.4) {
      for (let k = 0; k < 3; k++) {
        let ph = 0;
        add(start + k * 0.22, 0.2, gain * (1 - k * 0.2), pan, 0.5, (t) => { const u = t / 0.2; const f = 1300 + 900 * Math.sin(Math.PI * u) - 300 * u; ph += (TAU * f) / RATE; return (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph)) * Math.sin(Math.PI * u); }, true);
      }
    },
    meow(start, gain, pan = 0.3) {
      let ph = 0;
      add(start, 0.55, gain, pan, 0.4, (t) => { const u = t / 0.55; const f = 520 + 260 * Math.sin(Math.PI * u * 0.9) + 12 * Math.sin(TAU * 7 * t); ph += (TAU * f) / RATE; let x = 0; for (let n = 1; n <= 6; n++) x += Math.sin(n * ph) * (n === 2 || n === 3 ? 0.7 : 0.3) / n; return x * Math.sin(Math.PI * u); }, true);
    },
    hum(start, length, gain) { add(start, length, gain, 0, 0.1, (t) => (Math.sin(TAU * 120 * t) + 0.4 * Math.sin(TAU * 240 * t) + 0.2 * Math.sin(TAU * 360 * t)) * clamp01(t / 0.3) * clamp01((length - t) / 0.3), true); },
    squeak(start, gain, pan = 0) { let ph = 0; add(start, 0.18, gain, pan, 0.3, (t) => { ph += (TAU * (1900 - 2500 * t)) / RATE; return (Math.sin(ph) + 0.3 * Math.sin(2 * ph)) * Math.sin(Math.PI * t / 0.18); }, true); },
    pour(start, length, gain, pan = 0) {
      const lp = lowpass(2200);
      add(start, length, gain, pan, 0.4, (t) => lp(noise()) * 0.8 * clamp01(t / 0.1) * clamp01((length - t) / 0.2), true);
      for (let s = 0; s < length; s += 0.05 + rnd() * 0.07) { let ph = 0; const f0 = 500 + rnd() * 700; add(start + s, 0.05, gain * 0.5, pan, 0.4, (t) => { ph += (TAU * (f0 + 3000 * t)) / RATE; return Math.sin(ph) * Math.sin(Math.PI * t / 0.05); }, true); }
    },
    whistle(start, length, gain, pan = 0.2) { let ph = 0; add(start, length, gain, pan, 0.4, (t) => { ph += (TAU * (2600 + 60 * Math.sin(TAU * 28 * t))) / RATE; return Math.sin(ph) * clamp01(t / 0.02) * clamp01((length - t) / 0.03); }, true); },
    buzzer(start, length, gain) { add(start, length, gain, 0, 0.2, (t) => { const p = TAU * 150 * t; let x = 0; for (let n = 1; n < 12; n += 2) x += Math.sin(n * p) / n; return x * clamp01(t / 0.01) * clamp01((length - t) / 0.03); }, true); },
    alert(start, gain, pan = 0) { for (let k = 0; k < 3; k++) { I.beep(86, start + k * 0.32, 0.13, gain, pan); I.beep(79, start + k * 0.32 + 0.15, 0.13, gain, pan); } },
    strain(start, length, gain, pan = 0) {
      const lp = lowpass(2400); let ph = 0;
      add(start, length, gain, pan, 0.15, (t) => { const u = t / length; const f = 340 + 520 * u + 30 * Math.sin(TAU * 13 * t); ph += (TAU * f) / RATE; let x = 0; for (let n = 1; n <= 7; n++) x += Math.sin(n * ph) / n; return lp(x + 0.25 * noise()) * (0.5 + 0.5 * u) * clamp01(t / 0.08) * clamp01((length - t) / 0.12) * (0.75 + 0.25 * Math.sin(TAU * 22 * t)); }, true);
    },
    quack(start, gain, pan = 0) {
      for (const [d, f0] of [[0, 520], [0.16, 470]]) {
        let ph = 0; const bp = lowpass(1800), hp = lowpass(500);
        add(start + d, 0.15, gain, pan, 0.35, (t) => { const u = t / 0.15; const f = f0 * (1 + 0.25 * Math.sin(Math.PI * u)) * (1 - 0.15 * u); ph += (TAU * f) / RATE; let x = 0; for (let n = 1; n <= 9; n++) x += Math.sin(n * ph) * (n === 3 || n === 4 ? 1 : 0.4) / n; const y = bp(x); return (y - hp(y)) * 3.2 * Math.sin(Math.PI * u) ** 0.6; }, true);
      }
    },
    tap(start, gain, pan = 0) { const hp = lowpass(1200); add(start, 0.05, gain, pan, 0.05, (t) => { const x = noise(); return (x - hp(x)) * Math.exp(-t * 140) + Math.sin(TAU * (900 - 2000 * t) * t) * Math.exp(-t * 90) * 0.5; }, true); },
    kickball(start, gain, pan = 0) { I.thunk(start, gain, pan, 260); add(start + 0.01, 0.12, gain * 0.5, pan, 0.1, (t) => Math.sin(TAU * 600 * t) * Math.exp(-t * 40), true); },
    powerup(start, gain, pan = 0) { [72, 76, 79, 84, 88, 91, 96].forEach((n, k) => I.celesta(n, start + k * 0.055, gain * (0.7 + k * 0.05), pan + (k % 2 ? 0.2 : -0.2))); I.swell(start + 0.4, 0.45, 0.06); },
    scanfx(start, length, gain) { const hp = lowpass(3000); let ph = 0; add(start, length, gain, 0, 0.6, (t) => { const u = t / length; ph += (TAU * (300 + 2400 * u)) / RATE; const x = noise(); return ((x - hp(x)) * 0.5 + Math.sin(ph) * 0.15) * Math.sin(Math.PI * u) * (0.6 + 0.4 * Math.sin(TAU * 18 * t)); }, true); },
    montage(start, length, gain) { for (let s2 = 0; s2 < length; s2 += 0.09) I.beep(84 + ((s2 * 11) % 12 > 6 ? 7 : 0) + Math.round(rnd() * 5), start + s2, 0.05, gain * (0.5 + 0.5 * s2 / length), (rnd() - 0.5) * 0.8); I.riser(start, length, gain * 1.2); },
    rec(start, gain) { I.beep(93, start, 0.09, gain, 0.3); I.beep(93, start + 0.14, 0.09, gain, 0.3); },
    sparkle(start, gain, pan = 0) { for (let k = 0; k < 6; k++) I.celesta(84 + [0, 4, 7, 11, 12, 16][k], start + k * 0.05, gain * (1 - k * 0.1), pan + (k % 2 ? 0.2 : -0.2)); },
  };
  return { L, R, SL, SR, FX, I, add, rnd, N };
}

function room(input, spread, N) {
  const scale = RATE / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({ line: new Float32Array(Math.round((n + spread) * scale)), at: 0, damp: 0 }));
  const passes = [556, 441, 341, 225].map((n) => ({ line: new Float32Array(Math.round((n + spread) * scale)), at: 0 }));
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = input[i] * 0.015; let y = 0;
    for (const c of combs) { const was = c.line[c.at]; c.damp = was * 0.72 + c.damp * 0.28; c.line[c.at] = x + c.damp * 0.84; c.at = (c.at + 1) % c.line.length; y += was; }
    for (const p of passes) { const was = p.line[p.at]; p.line[p.at] = y + was * 0.5; p.at = (p.at + 1) % p.line.length; y = was - y; }
    out[i] = y;
  }
  return out;
}


/**
 * Mixes the music bed (with its room) and the effects bus, levels them, and
 * returns a WAV. options: { bed: [t0, t1] to level the music on, bedRms,
 * fxRms, fadeIn, fadeOut }.
 */
export function master(T, TOTAL, options = {}) {
  const { L, R, SL, SR, FX, N } = T;
  const wl = room(SL, 0, N);
  const wr = room(SR, 23, N);
  for (let i = 0; i < N; i++) {
    L[i] += wl[i] * 2.0;
    R[i] += wr[i] * 2.0;
  }
  const [a, b] = options.bed ?? [0, TOTAL];
  let sum = 0;
  for (let i = Math.floor(a * RATE); i < Math.floor(b * RATE); i++) sum += L[i] * L[i] + R[i] * R[i];
  const drive = (options.bedRms ?? 0.15) / Math.sqrt(sum / (2 * (b - a) * RATE) + 1e-12);
  let fsum = 0;
  for (let i = 0; i < N; i++) fsum += FX.L[i] * FX.L[i] + FX.R[i] * FX.R[i];
  const frms = Math.sqrt(fsum / (2 * N) + 1e-12);
  const fdrive = frms > 1e-9 ? Math.min(3.0, (options.fxRms ?? 0.11) / frms) : 1;
  const hpA = Math.exp((-TAU * 35) / RATE);
  let hl = 0;
  let hr = 0;
  let pl = 0;
  let pr = 0;
  for (let i = 0; i < N; i++) {
    const xl = L[i] * drive + FX.L[i] * fdrive;
    const xr = R[i] * drive + FX.R[i] * fdrive;
    hl = hpA * (hl + xl - pl);
    pl = xl;
    hr = hpA * (hr + xr - pr);
    pr = xr;
    L[i] = hl;
    R[i] = hr;
  }
  const fadeIn = options.fadeIn ?? 0.03;
  const fadeOut = options.fadeOut ?? 1.4;
  for (let i = 0; i < N; i++) {
    const t = i / RATE;
    const fade = clamp01(t / fadeIn) * clamp01((TOTAL + 0.2 - t) / fadeOut);
    L[i] = Math.tanh(L[i] * 1.15) * 0.88 * fade;
    R[i] = Math.tanh(R[i] * 1.15) * 0.88 * fade;
    if (!Number.isFinite(L[i] + R[i])) throw new Error('NaN sample');
  }
  const n = Math.round(TOTAL * RATE);
  const wav = Buffer.alloc(44 + n * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 4, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  const loud = (x, y) => {
    let s = 0;
    let pk = 0;
    for (let i = Math.floor(x * RATE); i < Math.floor(Math.min(y, TOTAL) * RATE); i++) {
      s += L[i] * L[i] + R[i] * R[i];
      pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    }
    return { rmsDb: 20 * Math.log10(Math.sqrt(s / (2 * Math.max(1e-6, y - x) * RATE)) + 1e-9), peakDb: 20 * Math.log10(pk + 1e-9) };
  };
  return { wav, loud };
}
