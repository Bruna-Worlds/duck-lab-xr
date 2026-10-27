// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The depth brain demo film (1920 x 1080, 30 fps): a title card, the course
 * run and the coffee-table detour from record-brain.mjs (sped up, with a badge),
 * Pip cam's DEPTH feed inset in the corner (the head sensor's 8 x 8 frame, as
 * the brain sees it), captions, an end card, and a score written to the cut by
 * tools/film/trailer/music.mjs.
 *
 *   node tools/film/brain/compose-brain.mjs [out.mp4]
 *
 * Env: COURSE_SPEED (2), TABLE_SPEED (2), COURSE_CAPTION, TABLE_CAPTION, ROUNDS
 * (the brain's training rounds, for the end card).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';

const TAKE = 'artifacts/video/brain/take';
const OUTFILE = process.argv[2] ?? 'artifacts/video/brain/duck-depth-brain.mp4';
const work = 'artifacts/video/brain/work';
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1920;
const H = 1080;
const INSET_W = 480; // the DEPTH feed, drawn at 1.875x its 256 x 192
const INSET_H = 360;
const CAP_W = 1250; // captions at the bottom left, clear of the inset
const CAP_H = 240; // tall enough for three lines; the box sits at the bottom
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

const marks = Object.fromEntries(JSON.parse(readFileSync(join(TAKE, 'marks.json'), 'utf8')).map((m) => [m.name, m.t]));
const frames = JSON.parse(readFileSync(join(TAKE, 'frames.json'), 'utf8'));
const feed = JSON.parse(readFileSync(join(TAKE, 'feed.json'), 'utf8'));
const LABEL = 'MIXED REALITY, EMULATED IN IWER';
const shot = (key, speed, caption) => {
  const from = marks[key] + 0.8;
  const to = marks[`${key}-end`];
  return { key, from: 'live', at: from, speed, dur: (to - from) / speed, caption, label: LABEL };
};
const CUT = [
  { key: 'title', from: 'card', dur: 4.2 },
  shot('course', Number(process.env.COURSE_SPEED ?? 2), process.env.COURSE_CAPTION ?? 'THE AUTOPILOT PICKS THE TARGETS.<br><b>THE DEPTH BRAIN STEERS</b>'),
  shot('table', Number(process.env.TABLE_SPEED ?? 2), process.env.TABLE_CAPTION ?? 'SENT BEHIND THE COFFEE TABLE:<br><b>IT FINDS ITS OWN WAY ROUND</b>'),
  { key: 'end', from: 'card', dur: 5 },
];
let t = 0;
for (const c of CUT) {
  c.t0 = t;
  t += c.dur;
}
const DUR = t;

// --- Pictures drawn in Chromium -------------------------------------------------------------
const font = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const css = `@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${font}) format('truetype'); }
* { margin: 0; box-sizing: border-box; }
body { background: transparent; font-family: 'Segoe UI', system-ui, sans-serif; }
.cap { display: inline-block; max-width: 1500px; padding: 18px 34px 12px; border-radius: 26px; background: rgba(15, 16, 32, 0.84); color: #fff4dc; font: 64px/1.02 Bebas; letter-spacing: 2px; text-align: center; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); }
.cap b { color: #ffcf3f; font-weight: 400; }
.label { display: inline-block; padding: 10px 18px 7px; border-radius: 999px; background: rgba(15, 16, 32, 0.72); color: rgba(255, 244, 220, 0.88); font: 28px/1 Bebas; letter-spacing: 2px; }
.badge { display: inline-block; padding: 10px 20px 7px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 34px/1 Bebas; letter-spacing: 2px; }
.inset { width: ${INSET_W + 24}px; padding: 12px 12px 10px; border-radius: 20px; background: rgba(15, 16, 32, 0.86); }
.inset .hole { width: ${INSET_W}px; height: ${INSET_H}px; border-radius: 10px; background: transparent; outline: 2px solid rgba(255, 244, 220, 0.25); }
.inset .t { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; gap: 10px; color: #fff4dc; font: 26px/1 Bebas; letter-spacing: 1.5px; }
.legend { display: flex; gap: 6px; align-items: center; font: 600 15px/1 'Segoe UI'; color: rgba(255, 244, 220, 0.7); }
.legend i { display: inline-block; width: 16px; height: 12px; border-radius: 3px; }
.card { width: ${W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; background: radial-gradient(circle at 50% 40%, #24264a 0%, #0f1020 64%); color: #fff4dc; text-align: center; }
.sticker-shadow { background: #ffcf3f; border-radius: 30px; padding: 0 12px 12px 0; }
.sticker { background: #1c1d36; border: 6px solid #ffcf3f; border-radius: 30px; padding: 22px 44px 10px; font: 120px/1 Bebas; color: #ffcf3f; letter-spacing: 4px; }
.title { font: 92px/1.02 Bebas; letter-spacing: 3px; max-width: 1600px; }
.title b { color: #ffcf3f; font-weight: 400; }
.sub { font: 600 32px/1.45 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.78); max-width: 1450px; }
.chips { display: flex; gap: 16px; }
.chip { padding: 12px 22px 8px; border-radius: 999px; border: 3px solid rgba(255, 244, 220, 0.3); font: 34px/1 Bebas; letter-spacing: 2px; color: rgba(255, 244, 220, 0.85); }
.chip.on { border-color: #3de0b8; color: #3de0b8; }
.url { font: 76px/1 Bebas; letter-spacing: 3px; color: #3de0b8; }
.small { font: 600 22px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.55); max-width: 1500px; }`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const picture = async (name, html, width, height) => {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(work, name), omitBackground: true, clip: { x: 0, y: 0, width, height } });
};
const ROUNDS = process.env.ROUNDS ?? '400';
await picture(
  'title.png',
  `<div class="card">
    <div class="title">PIP <b>DRIVES ITSELF</b></div>
    <div class="sub">Pollen's own walking brain, untouched, steered by a new navigation brain<br>that sees with the Microduck's head depth sensor: 8 x 8 zones, out to 4 m.</div>
    <div class="chips"><div class="chip on">DEPTH SENSOR</div><div class="chip">+ GOAL</div><div class="chip on">NAVIGATION BRAIN</div><div class="chip">-> SPEED + TURN</div><div class="chip on">SHIPPED WALKER</div></div>
  </div>`,
  W,
  H,
);
await picture(
  'end.png',
  `<div class="card">
    <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
    <div class="title" style="font-size:64px">THE NAVIGATION BRAIN TRAINED IN POLLEN'S MICRODUCK_RL</div>
    <div class="sub">2,048 simulated ducks in random furnished rooms, ${ROUNDS} rounds of PPO on one RTX 3070,<br>the shipped walking policy frozen underneath. In the app: menu, AUTOPILOT DRIVER, Depth brain.</div>
    <div class="url">duck.bruna.world</div>
    <div class="small">Microduck model, sensor model and walking AI (c) Pollen Robotics; meshes CC BY-NC-SA 4.0. Duck Lab XR is not made or endorsed by Pollen Robotics. (c) 2026 BRUNA GOODS LLC</div>
  </div>`,
  W,
  H,
);
await picture(
  'inset.png',
  `<div class="inset"><div class="hole"></div><div class="t"><span style="white-space:nowrap">HEAD DEPTH SENSOR, 8 x 8</span><span class="legend"><i style="background:#ff5c8a"></i>near<i style="background:#ffcf3f"></i><i style="background:#3de0b8"></i><i style="background:#6fb7ff"></i>far<i style="background:#1c1d36;outline:1px solid #555"></i>none</span></div></div>`,
  INSET_W + 24,
  INSET_H + 24 + 44,
);
for (const c of CUT) {
  if (c.caption) await picture(`cap-${c.key}.png`, `<div style="width:${CAP_W}px;height:${CAP_H}px;padding:4px;display:flex;align-items:flex-end"><div class="cap" style="max-width:${CAP_W - 8}px;text-align:left">${c.caption}</div></div>`, CAP_W, CAP_H);
  if (c.label) await picture(`label-${c.key}.png`, `<div style="padding:4px"><div class="label">${c.label}</div></div>`, 600, 56);
  if (c.speed && c.speed > 1.05) await picture(`badge-${c.key}.png`, `<div style="padding:4px"><div class="badge">${c.speed}x SPEED</div></div>`, 260, 60);
}
await browser.close();

// --- Segments ---------------------------------------------------------------------------------
/** A steady 30 fps image sequence of hard links: the newest source frame by each output frame's time. */
function sequence(list, dir, folder, c) {
  mkdirSync(join(work, folder), { recursive: true });
  let i = 0;
  const count = Math.round(c.dur * FPS);
  for (let k = 0; k < count; k++) {
    const when = c.at + (k / FPS) * c.speed;
    while (i + 1 < list.length && list[i + 1].t <= when) i++;
    const target = join(work, folder, `${String(k).padStart(6, '0')}.jpg`);
    if (!existsSync(target)) linkSync(resolve(TAKE, dir, list[i].file), target);
  }
  return join(work, folder, '%06d.jpg');
}
const segs = [];
for (const c of CUT) {
  const out = join(work, `seg-${c.key}.mp4`);
  segs.push(out);
  if (c.from === 'card') {
    const n = Math.round(c.dur * FPS);
    const filter = `[0:v]scale=${W * 2}:${H * 2},zoompan=z='1+0.03*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},fade=t=in:st=0:d=0.3,format=yuv420p[v]`;
    run(['-loop', '1', '-framerate', String(FPS), '-t', c.dur.toFixed(3), '-i', join(work, `${c.key}.png`), '-filter_complex', filter, '-map', '[v]', '-t', c.dur.toFixed(3), ...encode, out]);
  } else {
    const live = sequence(frames, 'frames', `seq-${c.key}`, c);
    const inset = sequence(feed, 'feed', `feed-${c.key}`, c);
    const inputs = ['-framerate', String(FPS), '-start_number', '0', '-i', live, '-framerate', String(FPS), '-start_number', '0', '-i', inset];
    const still = (file) => inputs.push('-loop', '1', '-framerate', String(FPS), '-t', c.dur.toFixed(3), '-i', join(work, file));
    still('inset.png');
    still(`cap-${c.key}.png`);
    still(`label-${c.key}.png`);
    const badge = existsSync(join(work, `badge-${c.key}.png`));
    if (badge) still(`badge-${c.key}.png`);
    const ix = W - INSET_W - 24 - 36;
    const iy = H - (INSET_H + 24 + 44) - 36;
    const parts = [
      `[0:v]scale=${W}:${H},setsar=1[v0]`,
      `[v0][2:v]overlay=${ix}:${iy}[v1]`,
      `[1:v]scale=${INSET_W}:${INSET_H}:flags=neighbor[f]`,
      `[v1][f]overlay=${ix + 12}:${iy + 12}[v2]`,
      `[v2][3:v]overlay=36:${H - CAP_H - 28}:enable='between(t,0.2,${(c.dur - 0.1).toFixed(2)})'[v3]`,
      `[v3][4:v]overlay=28:24[v4]`,
    ];
    let last = 'v4';
    if (badge) {
      parts.push(`[v4][5:v]overlay=${W - 260 - 20}:24[v5]`);
      last = 'v5';
    }
    run([...inputs, '-filter_complex', parts.join(';'), '-map', `[${last}]`, '-t', c.dur.toFixed(3), ...encode, out]);
  }
  console.log(`segment ${c.key} ${c.dur.toFixed(1)} s${c.speed ? ` (${c.speed}x)` : ''}`);
}
writeFileSync(join(work, 'segments.txt'), segs.map((s) => `file '${resolve(s).replace(/\\/g, '/')}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', join(work, 'segments.txt'), '-c', 'copy', join(work, 'video.mp4')]);

// --- The score ------------------------------------------------------------------------------------
const at = (key, s) => CUT.find((c) => c.key === key).t0 + s;
const cut = {
  dur: DUR,
  sections: [
    { key: 'wear', t0: 0, t1: at('course', 0) },
    { key: 'real', t0: at('course', 0), t1: at('table', 0) },
    { key: 'catch', t0: at('table', 0), t1: at('end', 0) },
    { key: 'end', t0: at('end', 0), t1: DUR },
  ],
  hits: [
    { t: 0.3, kind: 'quack' },
    { t: at('course', 0.2), kind: 'arrive' },
    { t: at('table', 0.2), kind: 'brain' },
    { t: at('end', 0.1), kind: 'success' },
  ],
};
writeFileSync(join(work, 'cut.json'), JSON.stringify(cut, null, 1));
execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUTFILE]);
console.log(`BRAIN FILM ${OUTFILE} (${DUR.toFixed(1)} s)`);
