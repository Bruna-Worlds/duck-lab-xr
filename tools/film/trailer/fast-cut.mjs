// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trailer's fast cut (about 37 s, for feeds): the finished trailer with its
 * sections played faster, as in a cut made by hand on 2026-10-23: the concept
 * opening at 2x, the Quest footage at 1.5x, everything from the test case on at
 * 2.6x. The speed changes only on the trailer's own cuts, never part way
 * through a shot, and frames are picked rather than blended, so text stays sharp.
 *
 *   FILM_LANG=zh node tools/film/trailer/fast-cut.mjs [--music file] [out.mp4]
 *
 * Reads the picture and the section times that compose-trailer.mjs leaves in
 * artifacts/video/trailer-work{-zh}/ (run it first, in the same language) and
 * writes artifacts/video/trailer{-zh}-fast.mp4. --music takes any audio or
 * video file and lays its sound under the cut as it is (it should run the
 * cut's length; silence fills the rest). Without it, the trailer's own score is
 * written again to the fast cut's sections and hits (music.mjs).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findFfmpeg } from '../ffmpeg.mjs';
import { LANG_SUFFIX } from '../lang.mjs';

/** How many times faster each section of the trailer plays, by its key in cut.json. */
const SPEED = { gap: 2, wear: 2, quest: 1.5, catch: 2.6, real: 2.6, deploy: 2.6, end: 2.6 };
const FPS = 30;

const args = process.argv.slice(2);
const at = args.indexOf('--music');
const MUSIC = at >= 0 ? args.splice(at, 2)[1] : null;
const OUTFILE = args[0] ?? `artifacts/video/trailer${LANG_SUFFIX}-fast.mp4`;
const work = `artifacts/video/trailer-work${LANG_SUFFIX}`;
const VIDEO = join(work, 'video.mp4');
if (!existsSync(VIDEO)) throw new Error(`fast-cut.mjs: no ${VIDEO}; run compose-trailer.mjs first (with the same FILM_LANG)`);
if (MUSIC && !existsSync(MUSIC)) throw new Error(`fast-cut.mjs: no music file ${MUSIC}`);
const FFMPEG = findFfmpeg();
const run = (a) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...a], { stdio: ['ignore', 'ignore', 'inherit'] });

// Neighbouring sections at the same speed play as one run; o0 is where a run starts in the fast cut.
const cut = JSON.parse(readFileSync(join(work, 'cut.json'), 'utf8'));
const runs = [];
for (const s of cut.sections) {
  const v = SPEED[s.key];
  if (!v) throw new Error(`fast-cut.mjs: no speed for the trailer's section "${s.key}"`);
  const last = runs.at(-1);
  if (last?.v === v) last.t1 = s.t1;
  else runs.push({ v, t0: s.t0, t1: s.t1, o0: last ? last.o0 + (last.t1 - last.t0) / last.v : 0 });
}
const runAt = (t) => runs.find((r) => t < r.t1) ?? runs.at(-1);
/** Where a second of the trailer lands in the fast cut. */
const fastTime = (t) => {
  const r = runAt(t);
  return r.o0 + (t - r.t0) / r.v;
};
const DUR = fastTime(cut.dur);

// One time map for the whole picture (each frame's new time), then the frames nearest to 30 fps kept.
const map = runs.reduceRight((rest, r, i) => {
  const here = `${r.o0.toFixed(6)}+(T-${r.t0.toFixed(6)})/${r.v}`;
  return i === runs.length - 1 ? here : `if(lt(T,${r.t1.toFixed(6)}),${here},${rest})`;
}, '');

let music = MUSIC;
if (!music) {
  // The score again, to the fast cut: sections and hits moved, a hit's length shortened with its run.
  const fast = {
    dur: DUR,
    sections: cut.sections.map((s) => ({ ...s, t0: fastTime(s.t0), t1: fastTime(s.t1) })),
    hits: cut.hits.map((h) => ({ ...h, t: fastTime(h.t), ...(h.len ? { len: h.len / runAt(h.t).v } : {}) })),
  };
  writeFileSync(join(work, 'cut-fast.json'), `${JSON.stringify(fast, null, 1)}\n`);
  music = join(work, 'music-fast.wav');
  execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut-fast.json'), music], { stdio: 'inherit' });
}
run([
  '-i', VIDEO,
  '-i', music,
  '-filter_complex', `[0:v]setpts='(${map})/TB',fps=${FPS}[v];[1:a:0]apad[a]`,
  '-map', '[v]', '-map', '[a]', '-t', DUR.toFixed(3),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUTFILE,
]);
for (const r of runs) console.log(`${r.t0.toFixed(1)}-${r.t1.toFixed(1)} s at ${r.v}x -> ${r.o0.toFixed(2)}-${fastTime(r.t1 - 1e-9).toFixed(2)} s`);
console.log(`FAST CUT ${OUTFILE} (${DUR.toFixed(2)} s, ${MUSIC ? `sound from ${MUSIC}` : 'the score written to the fast cut'})`);
