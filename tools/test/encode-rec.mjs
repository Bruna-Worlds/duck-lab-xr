// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns a recording from record-xr.mjs into an MP4: frames timed by their
 * screencast timestamps, cropped to the app frame, 30 fps H.264, with the
 * driver's captions (marks.txt: "<epoch seconds> <caption>" per line) drawn
 * at the bottom in the HUD's display face. A caption that starts "[n] " also
 * starts step n of the flow strip: the steps go to <out>.steps.json for
 * join-clips.mjs.
 *
 *   node tools/test/encode-rec.mjs artifacts/video/<name> artifacts/video/<name>.mp4
 *
 * FFMPEG may point at an ffmpeg binary (see tools/film/ffmpeg.mjs for the
 * default search).
 */
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from '../film/ffmpeg.mjs';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2]);
const out = resolve(process.argv[3] ?? `${dir}.mp4`);
const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
if (!frames.length) throw new Error('no frames');

// Concat list: each frame shown until the next one arrived.
// Marks: "<epoch seconds> <caption>". "[n] caption" also starts step n of the
// flow strip (join-clips.mjs draws it); "!ff 4" plays the film 4 times faster
// from there ("!ff 1" back to normal), with a badge saying so.
const t0 = frames[0].t;
const marks = existsSync(join(dir, 'marks.txt'))
  ? readFileSync(join(dir, 'marks.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        return { t: Number(line.slice(0, space)) - t0, text: line.slice(space + 1).trim() };
      })
      .filter((m) => Number.isFinite(m.t))
      .map((m) => {
        const ff = /^!ff\s+([\d.]+)$/.exec(m.text);
        if (ff) return { t: m.t, text: '', speed: Math.max(1, Number(ff[1])) };
        const step = /^\[(\d)\]\s*/.exec(m.text);
        return step ? { ...m, step: Number(step[1]), text: m.text.slice(step[0].length) } : m;
      })
  : [];
const speeds = marks.filter((m) => m.speed).sort((a, b) => a.t - b.t);
/** Recording seconds (from the first frame) to film seconds, through the fast-forward stretches. */
function warp(t) {
  let film = 0;
  let at = 0;
  let speed = 1;
  for (const s of speeds) {
    if (s.t >= t) break;
    film += (Math.max(at, s.t) - at) / speed;
    at = Math.max(at, s.t);
    speed = s.speed;
  }
  return film + (t - at) / speed;
}

// Concat list: each frame shown until the next one arrived (in film time).
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const t = warp(frames[i].t - t0);
  const next = frames[i + 1] ? warp(frames[i + 1].t - t0) : t + 0.1;
  const duration = Math.max(0.001, Math.min(1, next - t));
  lines.push(`file '${join(dir, 'frames', frames[i].file).replace(/\\/g, '/')}'`, `duration ${duration.toFixed(4)}`);
}
lines.push(`file '${join(dir, 'frames', frames[frames.length - 1].file).replace(/\\/g, '/')}'`);
writeFileSync(join(dir, 'list.txt'), lines.join('\n'));

// Crop to the app frame (CSS pixels scaled to the frame images).
const fw = frames[0].w ?? meta.viewport.w;
const scale = (readJpegWidth(join(dir, 'frames', frames[0].file)) ?? fw) / meta.viewport.w;
const filters = [];
if (meta.box) {
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  filters.push(`crop=${even(meta.box.width * scale)}:${even(meta.box.height * scale)}:${Math.round(meta.box.x * scale)}:${Math.round(meta.box.y * scale)}`);
}
filters.push('fps=30', 'scale=1280:-2:flags=lanczos');

// Captions: each shows from its mark until the next one (at most 7 s of film).
const filmMarks = marks.map((m) => ({ ...m, t: m.t > 0 ? warp(m.t) : m.t }));
const steps = filmMarks.filter((m) => m.step).map((m, i) => ({ t: i === 0 ? 0 : Math.max(0, m.t), step: m.step }));
if (steps.length) writeFileSync(`${out}.steps.json`, JSON.stringify(steps));
else rmSync(`${out}.steps.json`, { force: true });
const captions = filmMarks.filter((m) => m.text);
const font = 'public/fonts/BebasNeue-Regular.ttf';
/** Long captions break onto lines of at most `width` characters (the frame is 1280 px wide). */
function wrap(text, width = 46) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
captions.forEach((m, i) => {
  const end = Math.min(captions[i + 1]?.t ?? m.t + 7, m.t + 7);
  const file = join(dir, `caption-${i}.txt`);
  writeFileSync(file, wrap(m.text.toUpperCase()));
  const rel = file.replace(resolve('.') + '\\', '').replace(/\\/g, '/');
  filters.push(
    `drawtext=fontfile=${font}:textfile=${rel}:fontsize=42:line_spacing=8:fontcolor=0xffcf3f:box=1:boxcolor=0x0f1020@0.82:boxborderw=18:x=(w-text_w)/2:y=h-text_h-40:enable='between(t,${Math.max(0, m.t).toFixed(2)},${end.toFixed(2)})'`,
  );
});
// Where it was recorded (record-xr.mjs): small, top right, under the flow
// strip that join-clips.mjs lays over the top 46 px of the 1280x720 film.
// Fast-forward stretches: a badge, top left under the flow strip, sized like the label.
{
  const src = meta.box ?? { width: meta.viewport.w, height: meta.viewport.h };
  const fit = Math.min(1, 720 / ((1280 * src.height) / src.width));
  const px = (v) => Math.round(v / fit);
  const fast = filmMarks.filter((m) => m.speed).sort((a, b) => a.t - b.t);
  fast.forEach((m, i) => {
    if (m.speed <= 1) return;
    const end = fast[i + 1]?.t ?? 99999;
    const file = join(dir, `ff-${i}.txt`);
    writeFileSync(file, `FAST FORWARD ${m.speed}X`);
    const rel = file.replace(resolve('.') + '\\', '').replace(/\\/g, '/');
    filters.push(
      `drawtext=fontfile=${font}:textfile=${rel}:fontsize=${px(19)}:fontcolor=0x0f1020:box=1:boxcolor=0xffcf3f@0.95:boxborderw=${px(6)}:x=${px(14)}:y=${px(46 + 14)}:enable='between(t,${Math.max(0, m.t).toFixed(2)},${end.toFixed(2)})'`,
    );
  });
}
if (meta.label) {
  const src = meta.box ?? { width: meta.viewport.w, height: meta.viewport.h };
  const fit = Math.min(1, 720 / ((1280 * src.height) / src.width)); // how much join-clips shrinks this frame
  const file = join(dir, 'label.txt');
  writeFileSync(file, meta.label.toUpperCase());
  const rel = file.replace(resolve('.') + '\\', '').replace(/\\/g, '/');
  const px = (v) => Math.round(v / fit);
  filters.push(
    `drawtext=fontfile=${font}:textfile=${rel}:fontsize=${px(17)}:fontcolor=0xfff4dc@0.82:box=1:boxcolor=0x0f1020@0.5:boxborderw=${px(6)}:x=w-text_w-${px(14)}:y=${px(46 + 14)}`,
  );
}

const ffmpeg = findFfmpeg();
const args = ['-y', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
const result = spawnSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr.split('\n').slice(-15).join('\n'));
  process.exit(1);
}
const seconds = warp(frames[frames.length - 1].t - t0);
console.log(`ENC ${out} (${frames.length} frames over ${seconds.toFixed(1)} s, ${captions.length} captions${steps.length ? `, steps ${steps.map((x) => x.step).join(" ")}` : ""})`);

/** Width of a baseline JPEG from its SOF marker. */
function readJpegWidth(file) {
  const b = readFileSync(file);
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return b.readUInt16BE(i + 7);
    i += 2 + length;
  }
  return null;
}
