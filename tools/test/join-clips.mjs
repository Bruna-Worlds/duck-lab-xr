// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Joins encoded clips into one MP4: each is fitted into 1280x720 (letterboxed
 * on the app's ink colour) at 30 fps, with the flow strip over the top when
 * the clip has a <clip>.steps.json, then they are concatenated.
 *
 *   node tools/test/join-clips.mjs <out.mp4> <clip.mp4> [<clip.mp4> ...]
 *
 * FFMPEG may point at an ffmpeg binary (see tools/film/ffmpeg.mjs for the
 * default search).
 */
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from '../film/ffmpeg.mjs';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [out, ...clips] = process.argv.slice(2);
if (!out || clips.length === 0) throw new Error('usage: join-clips.mjs <out.mp4> <clip.mp4> ...');

const ffmpeg = findFfmpeg();
const run = (args) => {
  const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr.split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
};
const FIT = 'scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x0f1020,fps=30,setsar=1';
/**
 * The flow strip over the top of a clip: <clip>.steps.json (from
 * encode-rec.mjs) says from when each step is lit; the strips are drawn by
 * flow-strip.mjs into artifacts/video/flow/.
 */
function stripArgs(clip) {
  const file = `${resolve(clip)}.steps.json`;
  if (!existsSync(file)) return { inputs: [], filter: ['-vf', FIT] };
  const steps = JSON.parse(readFileSync(file, 'utf8'));
  const inputs = [];
  const graph = [`[0:v]${FIT}[v0]`];
  steps.forEach((s, k) => {
    const png = resolve(`artifacts/video/flow/step-${s.step}.png`);
    if (!existsSync(png)) throw new Error(`missing ${png}: run node tools/test/flow-strip.mjs`);
    inputs.push('-loop', '1', '-i', png);
    const end = steps[k + 1]?.t ?? 99999;
    graph.push(`[v${k}][${k + 1}:v]overlay=0:0:shortest=1:enable='between(t,${s.t.toFixed(2)},${end.toFixed(2)})'[v${k + 1}]`);
  });
  return { inputs, filter: ['-filter_complex', graph.join(';'), '-map', `[v${steps.length}]`] };
}

const parts = [];
for (const [i, clip] of clips.entries()) {
  const part = resolve(dirname(resolve(out)), `.join-${i}.mp4`);
  const strip = stripArgs(clip);
  run([
    '-y',
    '-i',
    resolve(clip),
    ...strip.inputs,
    ...strip.filter,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '21',
    '-pix_fmt',
    'yuv420p',
    '-an',
    part,
  ]);
  parts.push(part);
}
const list = resolve(dirname(resolve(out)), '.join-list.txt');
writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', resolve(out)]);
for (const p of [...parts, list]) rmSync(p, { force: true });
console.log(`JOIN ${clips.length} clips -> ${out}`);
