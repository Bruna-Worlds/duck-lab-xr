// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Duck Lab XR trailer's music, written to the trailer's cut (cut.json from
 * compose-trailer.mjs): sections with their times, and hits (a fall, a test
 * case sent, a brain arriving, a success) that the score lands on. All of it
 * is synthesized here (synth.mjs): original, free to use, nothing to credit.
 *
 *   node tools/film/trailer/music.mjs <cut.json> <out.wav>
 *
 * Shape: a curious intro (simulation vs home, a dip when the duck falls), a
 * light groove for the headset clips (concept and Quest), a steady bed under the real footage
 * (chimes where things arrive), a fuller payoff for the real robot, and a warm
 * resolve on the end card. G major, 112 bpm.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { master, track } from './synth.mjs';

const [cutFile, outFile] = process.argv.slice(2);
const cut = JSON.parse(readFileSync(cutFile, 'utf8'));
const DUR = cut.dur;
const BPM = 112;
const beat = 60 / BPM;
const bar = beat * 4;
const ROOT = 55; // G
const MAJ = [0, 4, 7];
const MIN = [0, 3, 7];
// I - V - vi - IV, and a darker turn for the problem.
const PROG = [[0, MAJ], [7, MAJ], [9, MIN], [5, MAJ]];
const sectionAt = (t) => cut.sections.find((s) => t >= s.t0 - 1e-6 && t < s.t1) ?? cut.sections[cut.sections.length - 1];

const T = track(7, DUR);
const { I } = T;
let b = 0;
for (let t0 = 0; t0 < DUR; t0 += bar, b++) {
  const sec = sectionAt(t0 + 0.01).key;
  const [deg, tri] = sec === 'gap' && t0 > (cut.hits.find((h) => h.kind === 'fall')?.t ?? 99) - 0.5 ? [9, MIN] : PROG[b % PROG.length];
  const root = ROOT + deg;
  const intro = sec === 'gap';
  const groove = sec === 'wear' || sec === 'quest' || sec === 'catch';
  const bed = sec === 'real';
  const pay = sec === 'deploy';
  const end = sec === 'end';
  // pad everywhere, warmer at the ends
  for (const s of [0, tri[1], tri[2], 12]) I.pad(root + 12 + s, t0, bar, (end ? 0.05 : intro ? 0.035 : bed ? 0.03 : 0.04) * (s ? 0.8 : 1));
  // a celesta line in the intro, plucks in the groove, soft arps under the footage
  const arpN = [0, tri[1], tri[2], 12, tri[2] + 12, 12, tri[2], tri[1]];
  for (let q = 0; q < 8; q++) {
    const tq = t0 + (q * beat) / 2;
    const n = root + 24 + arpN[q];
    if (intro && q % 2 === 0) I.celesta(n + 12, tq, 0.05, (q % 4) - 1.5 > 0 ? 0.3 : -0.3);
    if (groove) I.pluck(n, tq, 0.11, ((q % 4) - 1.5) * 0.3);
    if (bed && q % 2 === 0) I.arp(n, tq, 0.05, q % 4 ? 0.35 : -0.35);
    if (pay) I.pizz(n - 12, tq, 0.15, ((q % 4) - 1.5) * 0.3);
    if (end && q < 4 && q % 2 === 0) I.bell(n + 12, tq, 0.035, 0.1);
  }
  // the hook: bells in the groove, brass at the payoff
  if (groove || pay) {
    const tune = [[12, 1], [tri[2] + 12, 0.5], [tri[1] + 12, 0.5], [12, 1], [tri[2], 1]];
    let bt = 0;
    for (const [s, d] of tune) {
      if (pay) I.brass(root + 24 + s, t0 + bt * beat, d * beat * 0.8, 0.05);
      else I.bell(root + 24 + s, t0 + bt * beat, 0.04, 0.15);
      bt += d;
    }
  }
  // bass
  if (intro) I.bass(root - 12, t0, bar, 0.15, false);
  else if (end) {
    I.bass(root - 12, t0, bar, 0.2, false);
    I.sub(root - 24, t0, bar, 0.2);
  } else for (let q = 0; q < 8; q++) I.bass(root - 12 + [0, 0, tri[2], 0, 12, 0, tri[2], tri[1]][q], t0 + (q * beat) / 2, beat * 0.4, (bed ? 0.2 : 0.27) * (q % 2 ? 0.8 : 1));
  // drums: brushes for the groove, a light kit under the footage, the full kit at the payoff
  if (groove) {
    I.kick(t0, 0.32);
    I.kick(t0 + beat * 2, 0.3);
    I.brush(t0 + beat, 0.18);
    I.brush(t0 + 3 * beat, 0.2);
    for (let q = 0; q < 8; q++) I.hat(t0 + (q * beat) / 2, q % 2 ? 0.02 : 0.035, 0.3);
  }
  if (bed) {
    I.kick(t0, 0.26);
    I.kick(t0 + beat * 2, 0.24);
    I.clap(t0 + beat * 3, 0.08);
    for (let q = 0; q < 4; q++) I.shaker(t0 + q * beat + beat / 2, 0.03);
  }
  if (pay) {
    for (let q = 0; q < 4; q++) I.kick(t0 + q * beat, 0.4);
    I.snare(t0 + beat, 0.16);
    I.snare(t0 + 3 * beat, 0.18);
    for (let q = 0; q < 8; q++) I.hat(t0 + (q * beat) / 2 + beat / 4, 0.045);
  }
}

// Section seams: a riser into the groove, a lift into the payoff, a swell at the end card.
for (const s of cut.sections) {
  if (s.key === 'wear') {
    I.riser(Math.max(0, s.t0 - 1.4), 1.35, 0.1);
    I.blow(s.t0, 0.22);
  }
  if (s.key === 'real') I.swell(s.t0, 0.9, 0.06);
  if (s.key === 'deploy') {
    I.riser(s.t0 - 1.0, 0.95, 0.1);
    I.blow(s.t0, 0.3);
  }
  if (s.key === 'end') {
    I.swell(s.t0, 1.2, 0.08);
    I.blow(s.t0, 0.32);
  }
}

// Hits from the cut.
for (const h of cut.hits) {
  if (h.kind === 'fall') {
    I.thud(h.t, 0.5);
    I.alert(h.t - 0.5, 0.06);
  } else if (h.kind === 'scan') I.scanfx(h.t, h.len ?? 2.4, 0.05);
  else if (h.kind === 'goal') I.chime([84, 88, 91, 96], h.t, 0.1);
  else if (h.kind === 'trip') I.alert(h.t, 0.07);
  else if (h.kind === 'card') I.swish(h.t, 1.6, 0.22);
  else if (h.kind === 'arrive') I.chime([79, 84, 88], h.t, 0.1);
  else if (h.kind === 'train') I.montage(h.t, h.len ?? 2.8, 0.05);
  else if (h.kind === 'brain') I.powerup(h.t, 0.1);
  else if (h.kind === 'try') I.click(h.t, 0.3);
  else if (h.kind === 'success') I.chime([84, 88, 91, 96], h.t, 0.12);
  else if (h.kind === 'step') I.step(h.t, 0.3);
  else if (h.kind === 'quack') I.quack(h.t, 0.18);
}

const bedFrom = cut.sections.find((s) => s.key === 'wear')?.t0 ?? 3;
const bedTo = cut.sections.find((s) => s.key === 'end')?.t0 ?? DUR;
const { wav, loud } = master(T, DUR, { bed: [bedFrom, bedTo], bedRms: 0.13, fxRms: 0.08, fadeOut: 1.8 });
writeFileSync(outFile, wav);
const fmt = (x) => `${x.rmsDb.toFixed(1)} dB rms, peak ${x.peakDb.toFixed(1)} dB`;
for (const s of cut.sections) console.log(`${s.key.padEnd(7)} ${s.t0.toFixed(1)}-${s.t1.toFixed(1)} s: ${fmt(loud(s.t0, s.t1))}`);
console.log(`MUSIC ${outFile} (${DUR.toFixed(1)} s)`);
