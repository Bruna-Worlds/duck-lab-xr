// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The camera brain film (1920 x 1080, 30 fps): a title card; NVIDIA Isaac Lab
 * training it, in Isaac Lab's own viewer (record-viewer.mjs); what it sees in
 * training (the first eight ducks' 64 x 36 camera pictures, isaacnav/probe.py
 * --frames); then the app (record-brain.mjs DRIVER=camera): the course and the
 * coffee-table detour with Pip cam's DEPTH feed inset (the brain's camera
 * picture beside the 8 x 8 depth frame); then the step-up brain on 2 and 3 cm
 * terraces in mjlab's viewer (record-viewer.mjs + duckstep/play.py); an end
 * card; a score from tools/film/trailer/music.mjs.
 *
 *   node tools/film/brain/compose-camera-brain.mjs [out.mp4]
 *
 * Env: ISAAC_S (14), EYES_S (7), COURSE_SPEED (2), TABLE_SPEED (2), ENVS and
 * ROUNDS (the training run, for the captions and the end card).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';

const LIVE = 'artifacts/video/brain/take-camera';
const TABLE = process.env.TABLE_TAKE ?? 'artifacts/video/brain/take-camera2';
const ISAAC = 'artifacts/video/brain/isaac';
const STEPS = { step2: 'artifacts/video/brain/step2cm', step3: 'artifacts/video/brain/step3cm' };
// Viewer pages are filmed at 2x (2880 x 1620); the 3D view is left of the control panel.
const VIEWER_CROP = 'crop=2200:1238:0:191';
const STEP_SPEED = Number(process.env.STEP_SPEED ?? 4); // mjlab's viewer ran at about 0.24x real time
const EYES = 'artifacts/video/brain/eyes';
const OUTFILE = process.argv[2] ?? 'artifacts/video/brain/duck-camera-brain.mp4';
const work = 'artifacts/video/brain/work-camera';
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1920;
const H = 1080;
const INSET_W = 512; // the DEPTH feed (camera picture + depth grid), 2x its 256 x 192
const INSET_H = 384;
const CAP_W = 1250;
const CAP_H = 240;
const ENVS = process.env.ENVS ?? '256';
const ROUNDS = process.env.ROUNDS ?? '400';
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

const loadTake = (dir) => ({
  dir,
  marks: Object.fromEntries(JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8')).map((m) => [m.name, m.t])),
  frames: JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')),
  feed: JSON.parse(readFileSync(join(dir, 'feed.json'), 'utf8')),
});
const loadViewer = (dir) => ({
  dir,
  frames: JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')),
  start: Number(readFileSync(join(dir, 'marks.txt'), 'utf8').split('\n')[0].split(' ')[0]),
});
const takes = { live: loadTake(LIVE), table: loadTake(TABLE) };
const viewers = { isaac: loadViewer(ISAAC), step2: loadViewer(STEPS.step2), step3: loadViewer(STEPS.step3) };
const eyes = readdirSync(EYES).filter((f) => f.endsWith('.png')).sort();
const LABEL = 'IN THE APP: MIXED REALITY, EMULATED IN IWER';
const live = (key, take, shot, speed, caption, maxDur = Infinity) => {
  const from = takes[take].marks[shot] + 0.8;
  const to = takes[take].marks[`${shot}-end`];
  return { key, from: 'live', take, at: from, speed, dur: Math.min(maxDur, (to - from) / speed), caption, label: LABEL };
};
const viewer = (key, which, speed, dur, caption, label, skip = 1) => ({ key, from: 'viewer', which, at: viewers[which].start + skip, speed, dur, caption, label, badge: false });
const CUT = [
  { key: 'title', from: 'card', dur: 4.5 },
  viewer('isaac', 'isaac', 1, Number(process.env.ISAAC_S ?? 14), `TRAINED IN NVIDIA ISAAC LAB 3, ${ENVS} DUCKS AT ONCE:<br><b>THE DEPTH BRAIN TEACHES THE CAMERA BRAIN</b>`, 'NVIDIA ISAAC LAB 3 (NEWTON) &middot; ITS OWN VIEWER, LIVE TRAINING'),
  {
    key: 'eyes',
    from: 'eyes',
    speed: 1,
    dur: Math.min(Number(process.env.EYES_S ?? 7), eyes.length / 10),
    caption: 'WHAT IT SEES IN TRAINING: <b>64 x 36 PIXELS,</b><br>NEW ROOMS, COLOURS AND LIGHT EVERY EPISODE',
    label: 'ISAAC LAB &middot; 8 DUCKS\' HEAD CAMERAS',
  },
  live('course', 'live', 'course', Number(process.env.COURSE_SPEED ?? 2), 'IN THE APP: THE AUTOPILOT PICKS THE TARGETS,<br><b>THE CAMERA BRAIN STEERS THE COURSE</b>'),
  live('table', 'table', 'table', Number(process.env.TABLE_SPEED ?? 3), 'BEHIND THE COFFEE TABLE IT STILL GETS STUCK:<br><b>ITS TRAINING ROOMS HAVE NO TABLES YET</b>', 9),
  viewer('step2', 'step2', 2, 5, 'CLIMBING, FROM THE SHIPPED BRAIN:<br><b>2 CM STEPS, UP 5 TIMES IN 8 (SHIPPED: 0)</b>', "POLLEN'S MJLAB VIEWER &middot; STEP-UP BRAIN &middot; HALF SPEED", 0.5),
  viewer('step3', 'step3', STEP_SPEED, 5, "3 CM, A DOG BED'S EDGE:<br><b>1 IN 8 SO FAR. MORE TRAINING NEXT</b>", "POLLEN'S MJLAB VIEWER &middot; STEP-UP BRAIN &middot; REAL TIME", 14),
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
.cap { display: inline-block; max-width: 1500px; padding: 18px 34px 12px; border-radius: 26px; background: rgba(15, 16, 32, 0.84); color: #fff4dc; font: 60px/1.04 Bebas; letter-spacing: 2px; text-align: left; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45); }
.cap b { color: #ffcf3f; font-weight: 400; }
.label { display: inline-block; padding: 10px 18px 7px; border-radius: 999px; background: rgba(15, 16, 32, 0.72); color: rgba(255, 244, 220, 0.88); font: 28px/1 Bebas; letter-spacing: 2px; }
.badge { display: inline-block; padding: 10px 20px 7px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 34px/1 Bebas; letter-spacing: 2px; }
.inset { width: ${INSET_W + 24}px; padding: 12px 12px 10px; border-radius: 20px; background: rgba(15, 16, 32, 0.86); }
.inset .hole { width: ${INSET_W}px; height: ${INSET_H}px; border-radius: 10px; background: transparent; outline: 2px solid rgba(255, 244, 220, 0.25); }
.inset .t { margin-top: 10px; color: #fff4dc; font: 26px/1 Bebas; letter-spacing: 1.5px; white-space: nowrap; }
.card { width: ${W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; background: radial-gradient(circle at 50% 40%, #24264a 0%, #0f1020 64%); color: #fff4dc; text-align: center; }
.sticker-shadow { background: #ffcf3f; border-radius: 30px; padding: 0 12px 12px 0; }
.sticker { background: #1c1d36; border: 6px solid #ffcf3f; border-radius: 30px; padding: 22px 44px 10px; font: 120px/1 Bebas; color: #ffcf3f; letter-spacing: 4px; }
.title { font: 92px/1.02 Bebas; letter-spacing: 3px; max-width: 1600px; }
.title b { color: #ffcf3f; font-weight: 400; }
.sub { font: 600 32px/1.45 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.78); max-width: 1500px; }
.chips { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; max-width: 1700px; }
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
await picture(
  'title.png',
  `<div class="card">
    <div class="title">PIP <b>SEES WHERE IT GOES</b></div>
    <div class="sub">The Microduck's head camera and its 8 x 8 depth sensor feed a navigation brain<br>that steers Pollen's own walking brain, untouched.</div>
    <div class="chips"><div class="chip on">HEAD CAMERA</div><div class="chip on">DEPTH SENSOR</div><div class="chip">+ GOAL</div><div class="chip on">CAMERA BRAIN</div><div class="chip">-> SPEED + TURN</div><div class="chip on">SHIPPED WALKER</div></div>
  </div>`,
  W,
  H,
);
await picture(
  'end.png',
  `<div class="card">
    <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
    <div class="title" style="font-size:62px">CAMERA BRAIN: NVIDIA ISAAC LAB 3 &middot; CLIMBING: POLLEN'S MJLAB</div>
    <div class="sub">Camera brain: ${ENVS} ducks in random rooms on Newton, ${ROUNDS} rounds, learning from the depth brain.<br>Step-up brain: 1,024 ducks on terraces, 1,750 rounds from the shipped walker. One RTX 3070.</div>
    <div class="url">duck.bruna.world</div>
    <div class="small">Microduck model, sensor models and walking AI (c) Pollen Robotics; meshes CC BY-NC-SA 4.0. Isaac Lab and Newton are NVIDIA's; NVIDIA and Isaac are trademarks of NVIDIA Corporation. Duck Lab XR is not made or endorsed by Pollen Robotics or NVIDIA. (c) 2026 BRUNA GOODS LLC</div>
  </div>`,
  W,
  H,
);
await picture('inset.png', `<div class="inset"><div class="hole"></div><div class="t">WHAT THE BRAIN SEES: HEAD CAMERA + DEPTH SENSOR</div></div>`, INSET_W + 24, INSET_H + 24 + 40);
for (const c of CUT) {
  if (c.caption) await picture(`cap-${c.key}.png`, `<div style="width:${CAP_W}px;height:${CAP_H}px;padding:4px;display:flex;align-items:flex-end"><div class="cap" style="max-width:${CAP_W - 8}px">${c.caption}</div></div>`, CAP_W, CAP_H);
  if (c.label) await picture(`label-${c.key}.png`, `<div style="padding:4px"><div class="label">${c.label}</div></div>`, 1100, 56);
  if (c.speed && c.speed > 1.05 && c.badge !== false) await picture(`badge-${c.key}.png`, `<div style="padding:4px"><div class="badge">${c.speed}x SPEED</div></div>`, 260, 60);
}
await browser.close();

// --- Segments ---------------------------------------------------------------------------------
/** A steady 30 fps image sequence of hard links: the newest source frame by each output frame's time. */
function sequence(root, list, dir, folder, c, ext = 'jpg') {
  mkdirSync(join(work, folder), { recursive: true });
  let i = 0;
  const count = Math.round(c.dur * FPS);
  for (let k = 0; k < count; k++) {
    const when = c.at + (k / FPS) * c.speed;
    while (i + 1 < list.length && list[i + 1].t <= when) i++;
    const target = join(work, folder, `${String(k).padStart(6, '0')}.${ext}`);
    if (!existsSync(target)) linkSync(resolve(root, dir, list[i].file), target);
  }
  return join(work, folder, `%06d.${ext}`);
}
const segs = [];
for (const c of CUT) {
  const out = join(work, `seg-${c.key}.mp4`);
  segs.push(out);
  const dur = c.dur.toFixed(3);
  const overlays = (first) => {
    // Caption bottom left, label top left, speed badge top right, over the stream [first].
    const parts = [`[${first}][cap]overlay=36:${H - CAP_H - 28}:enable='between(t,0.2,${(c.dur - 0.1).toFixed(2)})'[o1]`, `[o1][lab]overlay=28:24[o2]`];
    return parts;
  };
  if (c.from === 'card') {
    const n = Math.round(c.dur * FPS);
    const filter = `[0:v]scale=${W * 2}:${H * 2},zoompan=z='1+0.03*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},fade=t=in:st=0:d=0.3,format=yuv420p[v]`;
    run(['-loop', '1', '-framerate', String(FPS), '-t', dur, '-i', join(work, `${c.key}.png`), '-filter_complex', filter, '-map', '[v]', '-t', dur, ...encode, out]);
  } else if (c.from === 'viewer') {
    const v = viewers[c.which];
    const seq = sequence(v.dir, v.frames, 'frames', `seq-${c.key}`, c);
    const inputs = ['-framerate', String(FPS), '-start_number', '0', '-i', seq];
    for (const f of [`cap-${c.key}.png`, `label-${c.key}.png`]) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', dur, '-i', join(work, f));
    const parts = [`[0:v]${VIEWER_CROP},scale=${W}:${H},setsar=1[v0]`, '[1:v]null[cap]', '[2:v]null[lab]', ...overlays('v0')];
    run([...inputs, '-filter_complex', parts.join(';'), '-map', '[o2]', '-t', dur, ...encode, out]);
  } else if (c.from === 'eyes') {
    // The mosaic at its own 10 pictures a second, centred on the dark backdrop.
    const inputs = ['-framerate', '10', '-start_number', '0', '-i', join(EYES, '%05d.png'), '-loop', '1', '-framerate', String(FPS), '-t', dur, '-i', join(work, 'title.png')];
    for (const f of [`cap-${c.key}.png`, `label-${c.key}.png`]) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', dur, '-i', join(work, f));
    const mw = 1560;
    const parts = [
      `[1:v]scale=${W}:${H},boxblur=40:2,eq=brightness=-0.25[bg]`,
      `[0:v]fps=${FPS},scale=${mw}:-2:flags=neighbor[m]`,
      `[bg][m]overlay=(W-w)/2:(H-h)/2-90:shortest=0[v0]`,
      '[2:v]null[cap]',
      '[3:v]null[lab]',
      ...overlays('v0'),
    ];
    run([...inputs, '-filter_complex', parts.join(';'), '-map', '[o2]', '-t', dur, ...encode, out]);
  } else {
    const take = takes[c.take];
    const liveSeq = sequence(take.dir, take.frames, 'frames', `seq-${c.key}`, c);
    const inset = sequence(take.dir, take.feed, 'feed', `feed-${c.key}`, c);
    const inputs = ['-framerate', String(FPS), '-start_number', '0', '-i', liveSeq, '-framerate', String(FPS), '-start_number', '0', '-i', inset];
    const still = (file) => inputs.push('-loop', '1', '-framerate', String(FPS), '-t', dur, '-i', join(work, file));
    still('inset.png');
    still(`cap-${c.key}.png`);
    still(`label-${c.key}.png`);
    const badge = existsSync(join(work, `badge-${c.key}.png`));
    if (badge) still(`badge-${c.key}.png`);
    const ix = W - INSET_W - 24 - 36;
    const iy = H - (INSET_H + 24 + 40) - 36;
    const parts = [
      `[0:v]scale=${W}:${H},setsar=1[v0]`,
      `[v0][2:v]overlay=${ix}:${iy}[v1]`,
      `[1:v]scale=${INSET_W}:${INSET_H}:flags=neighbor[f]`,
      `[v1][f]overlay=${ix + 12}:${iy + 12}[v2]`,
      '[3:v]null[cap]',
      '[4:v]null[lab]',
      ...overlays('v2'),
    ];
    let last = 'o2';
    if (badge) {
      parts.push(`[o2][5:v]overlay=${W - 260 - 20}:24[o3]`);
      last = 'o3';
    }
    run([...inputs, '-filter_complex', parts.join(';'), '-map', `[${last}]`, '-t', dur, ...encode, out]);
  }
  console.log(`segment ${c.key} ${c.dur.toFixed(1)} s${c.speed && c.speed !== 1 ? ` (${c.speed}x)` : ''}`);
}
writeFileSync(join(work, 'segments.txt'), segs.map((s) => `file '${resolve(s).replace(/\\/g, '/')}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', join(work, 'segments.txt'), '-c', 'copy', join(work, 'video.mp4')]);

// --- The score ------------------------------------------------------------------------------------
const at = (key, s) => CUT.find((c) => c.key === key).t0 + s;
const cut = {
  dur: DUR,
  sections: [
    { key: 'wear', t0: 0, t1: at('isaac', 0) },
    { key: 'real', t0: at('isaac', 0), t1: at('course', 0) },
    { key: 'catch', t0: at('course', 0), t1: at('step2', 0) },
    { key: 'real', t0: at('step2', 0), t1: at('end', 0) },
    { key: 'end', t0: at('end', 0), t1: DUR },
  ],
  hits: [
    { t: 0.3, kind: 'quack' },
    { t: at('isaac', 0.2), kind: 'brain' },
    { t: at('course', 0.2), kind: 'arrive' },
    { t: at('table', 0.2), kind: 'brain' },
    { t: at('step2', 0.2), kind: 'arrive' },
    { t: at('end', 0.1), kind: 'success' },
  ],
};
writeFileSync(join(work, 'cut.json'), JSON.stringify(cut, null, 1));
execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUTFILE]);
console.log(`CAMERA BRAIN FILM ${OUTFILE} (${DUR.toFixed(1)} s)`);
