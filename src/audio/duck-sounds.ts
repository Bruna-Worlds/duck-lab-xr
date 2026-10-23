// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Game sounds, synthesised with WebAudio (no audio files, nothing to
 * licence). Browsers only start audio after a user gesture, so the context
 * is created on the first pointer, key or XR-session gesture.
 */

export type GameSound =
  | 'crumb'
  | 'peck-bonus'
  | 'gate'
  | 'goal'
  | 'kick'
  | 'roll'
  | 'bail'
  | 'finish'
  | 'combo';

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

function ensureContext(): AudioContext | null {
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      return null;
    }
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
    noise = context.createBuffer(1, context.sampleRate * 0.5, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.random() * 2 - 1;
    }
  }
  if (context.state === 'suspended') {
    void context.resume();
  }
  return context;
}

/** Call from any user gesture; safe to call often. */
export function unlockAudio(): void {
  ensureContext();
}

/** Installs one-time listeners that unlock audio on the first gesture. */
export function installAudioUnlock(): () => void {
  const unlock = () => unlockAudio();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
}

function tone(
  ctx: AudioContext,
  type: OscillatorType,
  from: number,
  to: number,
  start: number,
  duration: number,
  peak: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(master!);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function whoosh(ctx: AudioContext, start: number, duration: number, from: number, to: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 2;
  filter.frequency.setValueAtTime(from, start);
  filter.frequency.exponentialRampToValueAtTime(to, start + duration);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.5, start + duration * 0.3);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  src.connect(filter).connect(gain).connect(master!);
  src.start(start);
  src.stop(start + duration + 0.02);
}

/**
 * A duck "quack": a nasal sawtooth through a formant band, with a pitch
 * drop. `pitch` personalises the voice (1 = average duck).
 */
export function playQuack(pitch = 1, mood: 'happy' | 'grumpy' | 'woozy' | 'plain' = 'plain'): void {
  const ctx = ensureContext();
  if (!ctx || !master) {
    return;
  }
  const t = ctx.currentTime + 0.01;
  const base = 520 * pitch;
  const honks = mood === 'happy' ? 2 : 1;
  for (let h = 0; h < honks; h++) {
    const start = t + h * 0.16;
    const length = mood === 'woozy' ? 0.32 : 0.14;
    const end = mood === 'grumpy' ? base * 0.45 : mood === 'woozy' ? base * 0.5 : base * 0.7;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base * (mood === 'happy' ? 1.15 : 1), start);
    osc.frequency.exponentialRampToValueAtTime(end, start + length);
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = 1100 * pitch;
    formant.Q.value = 3.5;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.9, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(formant).connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }
}

export function playSound(sound: GameSound): void {
  const ctx = ensureContext();
  if (!ctx || !master) {
    return;
  }
  const t = ctx.currentTime + 0.01;
  switch (sound) {
    case 'crumb':
      tone(ctx, 'sine', 880, 1320, t, 0.12, 0.35);
      break;
    case 'peck-bonus':
      tone(ctx, 'sine', 990, 1480, t, 0.1, 0.35);
      tone(ctx, 'sine', 1480, 1980, t + 0.09, 0.14, 0.3);
      break;
    case 'gate':
      whoosh(ctx, t, 0.35, 400, 3000);
      tone(ctx, 'triangle', 660, 990, t + 0.05, 0.2, 0.2);
      break;
    case 'goal':
      [523, 659, 784, 1047].forEach((f, i) => tone(ctx, 'triangle', f, f, t + i * 0.09, 0.22, 0.3));
      whoosh(ctx, t, 0.8, 800, 4000);
      break;
    case 'kick':
      tone(ctx, 'sine', 160, 50, t, 0.12, 0.6);
      break;
    case 'roll':
      whoosh(ctx, t, 0.5, 300, 1500);
      break;
    case 'bail':
      tone(ctx, 'sine', 220, 70, t, 0.35, 0.6);
      tone(ctx, 'square', 330, 110, t + 0.05, 0.3, 0.12);
      break;
    case 'finish':
      [523, 659, 784, 659, 784, 1047].forEach((f, i) =>
        tone(ctx, 'triangle', f, f, t + i * 0.11, 0.25, 0.3),
      );
      break;
    case 'combo':
      tone(ctx, 'triangle', 784, 1175, t, 0.18, 0.25);
      break;
  }
}
