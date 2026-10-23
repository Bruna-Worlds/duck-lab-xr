// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The social film (1080 x 1920, 30 fps, about 30 s): for phones, one picture
 * at a time, big captions in the upper third (clear of the apps' buttons at
 * the bottom and the right), and an end card with the address.
 *   hook, course, depth, fall   the live shots (record-social.mjs)
 *   train                       the trainer page from the stacked film (6x speed)
 *   tryit                       the new brain arriving on the headset (stacked film)
 *   end                         logo, duck.bruna.world, the GitHub repository
 * The score is written to this cut by tools/film/trailer/music.mjs.
 *
 *   node tools/film/social/compose-social.mjs [out.mp4]
 *
 * Needs artifacts/video/social/take (record-social.mjs) and
 * artifacts/video/stack.mp4 (tools/film/stack).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';

const TAKE = 'artifacts/video/social/take';
const STACK = 'artifacts/video/stack.mp4';
const OUTFILE = process.argv[2] ?? 'artifacts/video/social/duck-lab-xr-social.mp4';
const work = 'artifacts/video/social/work';
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1080;
const H = 1920;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

// --- The cut ---------------------------------------------------------------------------
const marks = Object.fromEntries(JSON.parse(readFileSync(join(TAKE, 'marks.json'), 'utf8')).map((m) => [m.name, m.t]));
const LIVE_LABEL = 'MIXED REALITY, EMULATED IN IWER';
const CUT = [
  { key: 'hook', from: 'live', at: marks.hook + 0.6, dur: 4.2, caption: 'THIS ROBOT DUCK<br>LEARNS <b>YOUR ROOM</b>', label: LIVE_LABEL },
  { key: 'course', from: 'live', at: marks.course + 1.2, dur: 6.0, caption: 'REAL ROBOT PHYSICS.<br>ITS <b>REAL WALKING BRAIN</b>', label: LIVE_LABEL },
  { key: 'depth', from: 'live', at: marks.depth + 0.8, dur: 4.2, caption: 'YOUR REAL FURNITURE<br>IS <b>SOLID</b> TO IT', label: LIVE_LABEL },
  { key: 'fall', from: 'live', at: marks.fall + 0.1, dur: 3.2, caption: 'A FALL BECOMES<br>A <b>TEST CASE</b>...', label: LIVE_LABEL },
  { key: 'train', from: 'stack', at: 29.6, dur: 5.8, caption: '...YOUR PC TRAINS<br>A <b>BETTER BRAIN</b>', label: 'THE TRAINER, ON YOUR COMPUTER (SPED UP)', crop: '1080:840:0:1080' },
  { key: 'tryit', from: 'stack', at: 40.0, dur: 4.0, caption: '...AND SENDS IT BACK.<br><b>ONE TAP: TRY IT</b>', label: 'BACK ON THE HEADSET', crop: '480:480:300:150' },
  { key: 'end', from: 'card', dur: 3.8 },
];
let t = 0;
for (const c of CUT) {
  c.t0 = t;
  t += c.dur;
}
const DUR = t;

// --- Pictures drawn in Chromium: captions, labels, the end card ---------------------------
const font = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const css = `@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${font}) format('truetype'); }
* { margin: 0; box-sizing: border-box; }
body { background: transparent; font-family: 'Segoe UI', system-ui, sans-serif; }
.cap { display: inline-block; max-width: 980px; padding: 22px 34px 16px; border-radius: 30px; background: rgba(15, 16, 32, 0.82); color: #fff4dc; font: 84px/1.02 Bebas; letter-spacing: 2px; text-align: center; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); }
.cap b { color: #ffcf3f; font-weight: 400; }
.label { display: inline-block; padding: 10px 18px 7px; border-radius: 999px; background: rgba(15, 16, 32, 0.7); color: rgba(255, 244, 220, 0.85); font: 26px/1 Bebas; letter-spacing: 2px; }
.end { width: ${W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; background: radial-gradient(circle at 50% 38%, #24264a 0%, #0f1020 62%); color: #fff4dc; text-align: center; }
.sticker-shadow { background: #ffcf3f; border-radius: 34px; padding: 0 14px 14px 0; }
.sticker { background: #1c1d36; border: 6px solid #ffcf3f; border-radius: 34px; padding: 26px 50px 14px; font: 170px/1 Bebas; color: #ffcf3f; letter-spacing: 4px; }
.tag { font: 64px/1.05 Bebas; letter-spacing: 3px; }
.url { font: 92px/1 Bebas; letter-spacing: 3px; color: #3de0b8; }
.gh { display: inline-block; padding: 18px 34px 12px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 50px/1 Bebas; letter-spacing: 2px; }
.small { font: 600 26px/1.35 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.6); }`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const shot = async (name, html, width, height) => {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(work, name), omitBackground: true, clip: { x: 0, y: 0, width, height } });
};
for (const c of CUT) {
  if (c.caption) await shot(`cap-${c.key}.png`, `<div style="width:${W}px;display:flex;justify-content:center;padding-top:6px"><div class="cap">${c.caption}</div></div>`, W, 260);
  if (c.label) await shot(`label-${c.key}.png`, `<div style="width:${W}px;display:flex;justify-content:center;padding-top:4px"><div class="label">${c.label}</div></div>`, W, 60);
}
await shot(
  'end.png',
  `<div class="end">
    <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
    <div class="tag">TRAIN A ROBOT DUCK<br>IN YOUR OWN ROOM</div>
    <div class="small">Free, in a Meta Quest browser or on any computer or phone</div>
    <div class="url">duck.bruna.world</div>
    <div class="gh">OPEN SOURCE ON GITHUB</div>
    <div class="small">github.com/Bruna-Worlds/duck-lab-xr<br><br>Microduck model and walking AI (c) Pollen Robotics, meshes CC BY-NC-SA 4.0.<br>Duck Lab XR is not made or endorsed by Pollen Robotics.<br>(c) 2026 BRUNA GOODS LLC</div>
  </div>`,
  W,
  H,
);
await browser.close();

// --- Segments ------------------------------------------------------------------------------
const frames = JSON.parse(readFileSync(join(TAKE, 'frames.json'), 'utf8'));
/** The live take as a steady 30 fps from `at` for `dur` seconds: the newest frame drawn by then. */
const liveList = (c) => {
  const lines = [];
  let i = 0;
  const count = Math.round(c.dur * FPS);
  for (let k = 0; k < count; k++) {
    const when = c.at + k / FPS;
    while (i + 1 < frames.length && frames[i + 1].t <= when) i++;
    lines.push(`file '${resolve(TAKE, 'frames', frames[i].file).replace(/\\/g, '/')}'`, `duration ${(1 / FPS).toFixed(6)}`);
  }
  lines.push(lines[lines.length - 2]); // the concat demuxer wants the last file again
  const list = join(work, `list-${c.key}.txt`);
  writeFileSync(list, lines.join('\n'));
  return list;
};
// The caption sits in the upper third (y 250), the label just above it.
const overlays = (c, base, first) => {
  const parts = [];
  let last = base;
  let input = first;
  if (c.label) {
    parts.push(`[${last}][${input}:v]overlay=0:170[l${c.key}]`);
    last = `l${c.key}`;
    input++;
  }
  if (c.caption) {
    parts.push(`[${last}][${input}:v]overlay=0:250:enable='between(t,0.15,${(c.dur - 0.05).toFixed(2)})'[c${c.key}]`);
    last = `c${c.key}`;
  }
  return { parts, last };
};
const stills = (c) => {
  const inputs = [];
  if (c.label) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', c.dur.toFixed(3), '-i', join(work, `label-${c.key}.png`));
  if (c.caption) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', c.dur.toFixed(3), '-i', join(work, `cap-${c.key}.png`));
  return inputs;
};
const segs = [];
for (const c of CUT) {
  const out = join(work, `seg-${c.key}.mp4`);
  segs.push(out);
  if (c.from === 'live') {
    const { parts, last } = overlays(c, 'v0', 1);
    const filter = [`[0:v]scale=${W}:${H},setsar=1,fps=${FPS}[v0]`, ...parts].join(';');
    run(['-f', 'concat', '-safe', '0', '-i', liveList(c), ...stills(c), '-filter_complex', filter, '-map', `[${last}]`, '-t', c.dur.toFixed(3), ...encode, out]);
  } else if (c.from === 'stack') {
    // The picture over a blurred, darkened copy of itself that fills the frame.
    const [cw, ch] = c.crop.split(':').map(Number);
    const fgH = Math.round((W * ch) / cw / 2) * 2;
    const { parts, last } = overlays(c, 'v0', 1);
    const filter = [
      `[0:v]crop=${c.crop},split[a][b]`,
      `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:4,eq=brightness=-0.22[bg]`,
      `[b]scale=${W}:${fgH}[fg]`,
      `[bg][fg]overlay=0:${Math.round((H - fgH) / 2 + 120)},setsar=1,fps=${FPS}[v0]`,
      ...parts,
    ].join(';');
    run(['-ss', String(c.at), '-t', c.dur.toFixed(3), '-i', STACK, ...stills(c), '-filter_complex', filter, '-map', `[${last}]`, '-t', c.dur.toFixed(3), ...encode, out]);
  } else {
    const frames = Math.round(c.dur * FPS);
    const filter = `[0:v]scale=${W * 2}:${H * 2},zoompan=z='1+0.035*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`;
    run(['-loop', '1', '-framerate', String(FPS), '-t', c.dur.toFixed(3), '-i', join(work, 'end.png'), '-filter_complex', filter, '-map', '[v]', '-t', c.dur.toFixed(3), ...encode, out]);
  }
  console.log(`segment ${c.key} ${c.dur.toFixed(1)} s`);
}
writeFileSync(join(work, 'segments.txt'), segs.map((s) => `file '${resolve(s).replace(/\\/g, '/')}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', join(work, 'segments.txt'), '-c', 'copy', join(work, 'video.mp4')]);

// --- The score, written to this cut -------------------------------------------------------------
const at = (key, s) => CUT.find((c) => c.key === key).t0 + s;
const cut = {
  dur: DUR,
  sections: [
    { key: 'wear', t0: 0, t1: at('depth', 0) },
    { key: 'catch', t0: at('depth', 0), t1: at('train', 0) },
    { key: 'real', t0: at('train', 0), t1: at('end', 0) },
    { key: 'end', t0: at('end', 0), t1: DUR },
  ],
  hits: [
    { t: 0.3, kind: 'quack' },
    { t: at('course', 2.3), kind: 'goal' },
    { t: at('depth', 1.6), kind: 'trip' },
    { t: at('fall', 0.35), kind: 'fall' },
    { t: at('fall', 2.6), kind: 'card' },
    { t: at('train', 0.2), kind: 'arrive' },
    { t: at('train', 0.8), kind: 'train', len: 4.4 },
    { t: at('tryit', 0.3), kind: 'brain' },
    { t: at('tryit', 1.9), kind: 'try' },
    { t: at('end', 0.1), kind: 'success' },
  ],
};
writeFileSync(join(work, 'cut.json'), JSON.stringify(cut, null, 1));
execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUTFILE]);
console.log(`SOCIAL ${OUTFILE} (${DUR.toFixed(1)} s)`);
