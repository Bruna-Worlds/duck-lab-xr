// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cuts a Quest screen recording (both eyes side by side) down to the left
 * eye's lens circle, with captions from a marks file ("<epoch seconds>
 * <caption>" per line, timed against the recording's start).
 *
 *   node tools/test/encode-headset.mjs <raw.mp4> <out.mp4> <start epoch s> <marks>
 */
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from '../film/ffmpeg.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [raw, out, startArg, marksFile] = process.argv.slice(2);
const start = Number(startArg);

const tmp = resolve('artifacts/video/quest-captions');
mkdirSync(tmp, { recursive: true });
const marks = existsSync(marksFile)
  ? readFileSync(marksFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        return { t: Number(line.slice(0, space)) - start, text: line.slice(space + 1).trim() };
      })
  : [];
// The left eye of a 1920x1080 side-by-side recording, square around the lens centre.
const filters = ['crop=880:880:40:100', 'scale=1080:1080:flags=lanczos', 'setsar=1'];
const font = 'public/fonts/BebasNeue-Regular.ttf';
marks.forEach((m, i) => {
  const end = Math.min(marks[i + 1]?.t ?? m.t + 7, m.t + 7);
  const file = join(tmp, `caption-${i}.txt`);
  writeFileSync(file, m.text.toUpperCase());
  const rel = file.replace(resolve('.') + '\\', '').replace(/\\/g, '/');
  filters.push(
    `drawtext=fontfile=${font}:textfile=${rel}:fontsize=40:fontcolor=0xffcf3f:box=1:boxcolor=0x0f1020@0.82:boxborderw=18:x=(w-text_w)/2:y=h-text_h-60:enable='between(t,${Math.max(0, m.t).toFixed(2)},${end.toFixed(2)})'`,
  );
});
const args = ['-y', '-i', raw, '-an', '-vf', filters.join(','), '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
const result = spawnSync(findFfmpeg(), args, { encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr.split('\n').slice(-12).join('\n'));
  process.exit(1);
}
console.log(`ENC ${out} (${marks.length} captions)`);
