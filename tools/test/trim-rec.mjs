// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cuts a stretch out of a recording from record-xr.mjs before encoding: the
 * frames between two times are dropped, later frames and captions move up,
 * and a caption marks the cut. Writes a new recording folder that points at
 * the original frames.
 *
 *   node tools/test/trim-rec.mjs <rec dir> <out dir> <from s> <to s> "<caption at the cut>"
 *   node tools/test/encode-rec.mjs <out dir> <out>.mp4
 *
 * Times are seconds from the recording's first frame.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const [src, out, fromArg, toArg, caption = ''] = process.argv.slice(2);
const dir = resolve(src);
const outDir = resolve(out);
const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
const t0 = frames[0].t;
const from = t0 + Number(fromArg);
const to = t0 + Number(toArg);
const cut = to - from;
if (!(cut > 0)) throw new Error('nothing to cut');
mkdirSync(join(outDir, 'frames'), { recursive: true });
// Frame files stay where they are: point at them from the new folder's frames/.
const back = relative(join(outDir, 'frames'), join(dir, 'frames')).replace(/\\/g, '/');
const kept = [];
for (const f of frames) {
  if (f.t >= from && f.t < to) continue;
  kept.push({ ...f, file: `${back}/${basename(f.file)}`, t: f.t >= to ? f.t - cut : f.t });
}
writeFileSync(join(outDir, 'frames.json'), JSON.stringify(kept));
copyFileSync(join(dir, 'meta.json'), join(outDir, 'meta.json'));
const marks = existsSync(join(dir, 'marks.txt'))
  ? readFileSync(join(dir, 'marks.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        return { t: Number(line.slice(0, space)), text: line.slice(space + 1) };
      })
  : [];
const moved = marks.filter((m) => m.t < from || m.t >= to).map((m) => ({ t: m.t >= to ? m.t - cut : m.t, text: m.text }));
if (caption) moved.push({ t: from, text: caption });
moved.sort((a, b) => a.t - b.t);
writeFileSync(join(outDir, 'marks.txt'), `${moved.map((m) => `${m.t.toFixed(3)} ${m.text}`).join('\n')}\n`);
console.log(`TRIM ${frames.length} -> ${kept.length} frames, cut ${cut.toFixed(1)} s at ${Number(fromArg).toFixed(1)} s -> ${outDir}`);
