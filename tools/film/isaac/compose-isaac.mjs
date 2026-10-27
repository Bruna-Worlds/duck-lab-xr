// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Isaac Sim film (1080 x 1920, 30 fps): Duck Lab XR on top, Isaac Sim's
 * live view below, both from one take on one clock (record-isaac.mjs), so
 * the lag between them is the link's own. Captions in the band between, an
 * end card, and a score written to this cut (tools/film/trailer/music.mjs).
 * A take from Isaac Sim 4.x (data over the stream's own data channel) also
 * gets a card on how that works, before the end card.
 *
 *   node tools/film/isaac/compose-isaac.mjs [out.mp4]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';

const TAKE = 'artifacts/video/isaac/take';
const info = existsSync(join(TAKE, 'info.json')) ? JSON.parse(readFileSync(join(TAKE, 'info.json'), 'utf8')) : { version: '2022.2', transport: 'socket', stream: 'frames' };
const CHANNEL = info.transport === 'channel';
const VERSION = String(info.version).split('.').slice(0, 2).join('.'); // 4.5.0 -> 4.5, 2022.2.1 -> 2022.2
const OUTFILE = process.argv[2] ?? `artifacts/video/isaac/duck-lab-isaac-sim${CHANNEL ? `-${VERSION}` : ''}.mp4`;
const work = 'artifacts/video/isaac/work';
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1080;
const H = 1920;
// The page: the app on top, the caption band, Isaac Sim, a footer.
const APP_H = 1000;
const BAND = { y: APP_H, h: 250 };
const ISAAC = { y: BAND.y + BAND.h, h: 608 };
const FOOT = { y: ISAAC.y + ISAAC.h, h: H - ISAAC.y - ISAAC.h };
const END_DUR = 3.6;
const HOW_DUR = CHANNEL ? 4.4 : 0;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

const marks = Object.fromEntries(JSON.parse(readFileSync(join(TAKE, 'marks.json'), 'utf8')).map((m) => [m.name, m.t]));
const T0 = marks.walk;
const LIVE = marks.end - T0;
const at = (name, s = 0) => marks[name] - T0 + s;
const CAPTIONS = CHANNEL
  ? [
      { a: 0.2, b: 4.2, html: `DUCK LAB XR &rarr; ISAAC SIM ${VERSION}, <b>LIVE</b>` },
      { a: 4.2, b: at('room'), html: 'ONE WEBRTC LINK:<br><b>DATA UP, VIDEO DOWN</b>' },
      { a: at('room', 0.2), b: at('editor'), html: "YOUR ROOM'S SCAN AND DEPTH,<br><b>REBUILT IN USD</b>" },
      { a: at('editor', 0.2), b: LIVE - 0.1, html: `THE REAL ISAAC SIM ${VERSION},<br><b>RENDERED WITH RTX</b>` },
    ]
  : [
      { a: 0.2, b: 4.2, html: 'DUCK LAB XR &rarr; ISAAC SIM, <b>LIVE</b>' },
      { a: 4.2, b: at('room'), html: 'EVERY POSE, <b>30 TIMES A SECOND</b>' },
      { a: at('room', 0.2), b: at('editor'), html: "YOUR ROOM'S SCAN AND DEPTH,<br><b>REBUILT IN USD</b>" },
      { a: at('editor', 0.2), b: LIVE - 0.1, html: 'THE REAL ISAAC SIM,<br><b>STREAMED BACK OVER WEBRTC</b>' },
    ];

// --- Pictures: the frame (labels, band, footer), the captions, the end card ---------------------
const font = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const css = `@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${font}) format('truetype'); }
* { margin: 0; box-sizing: border-box; }
body { background: transparent; font-family: 'Segoe UI', system-ui, sans-serif; }
.frame { position: relative; width: ${W}px; height: ${H}px; }
.band { position: absolute; left: 0; top: ${BAND.y}px; width: ${W}px; height: ${BAND.h}px; background: #0f1020; border-top: 4px solid #ffcf3f; }
.sub { position: absolute; left: 0; bottom: 18px; width: ${W}px; text-align: center; font: 600 27px/1.2 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.66); }
.foot { position: absolute; left: 0; top: ${FOOT.y}px; width: ${W}px; height: ${FOOT.h}px; background: #0f1020; display: flex; align-items: center; justify-content: center; gap: 26px; font: 30px/1 Bebas; letter-spacing: 2px; color: rgba(255, 244, 220, 0.8); }
.foot b { color: #3de0b8; font-weight: 400; }
.label { position: absolute; left: 24px; display: inline-block; padding: 10px 18px 7px; border-radius: 999px; background: rgba(15, 16, 32, 0.78); color: #fff4dc; font: 28px/1 Bebas; letter-spacing: 2px; }
.label i { font-style: normal; color: #ffcf3f; }
.cap { width: ${W}px; height: ${BAND.h - 60}px; display: flex; align-items: center; justify-content: center; text-align: center; color: #fff4dc; font: 70px/1.02 Bebas; letter-spacing: 2px; }
.cap b { color: #ffcf3f; font-weight: 400; }
.end { width: ${W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; background: radial-gradient(circle at 50% 38%, #24264a 0%, #0f1020 62%); color: #fff4dc; text-align: center; }
.sticker-shadow { background: #ffcf3f; border-radius: 34px; padding: 0 14px 14px 0; }
.sticker { background: #1c1d36; border: 6px solid #ffcf3f; border-radius: 34px; padding: 26px 50px 14px; font: 170px/1 Bebas; color: #ffcf3f; letter-spacing: 4px; }
.tag { font: 64px/1.05 Bebas; letter-spacing: 3px; }
.url { font: 92px/1 Bebas; letter-spacing: 3px; color: #3de0b8; }
.gh { display: inline-block; padding: 18px 34px 12px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 50px/1 Bebas; letter-spacing: 2px; }
.small { font: 600 26px/1.35 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.6); }
.how { width: ${W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; background: radial-gradient(circle at 50% 45%, #24264a 0%, #0f1020 66%); color: #fff4dc; text-align: center; }
.how h1 { font: 110px/1 Bebas; letter-spacing: 4px; color: #ffcf3f; font-weight: 400; margin-bottom: 70px; }
.box { width: 820px; border-radius: 34px; padding: 34px 40px 30px; background: #1c1d36; border: 5px solid #fff4dc; }
.box.isaac { border-color: #76b900; }
.box .t { font: 64px/1 Bebas; letter-spacing: 2px; }
.box .d { margin-top: 14px; font: 600 30px/1.35 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.75); }
.pipes { display: flex; gap: 40px; height: 400px; padding: 22px 0; }
.pipe { width: 390px; display: flex; align-items: stretch; gap: 24px; }
.arrow { width: 60px; display: flex; flex-direction: column; align-items: center; }
.txt { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 12px; text-align: left; }
.shaft { width: 16px; flex: 1; border-radius: 8px; }
.up .shaft { background: linear-gradient(#76b900, #3d6000); }
.down .shaft { background: linear-gradient(#a8851f, #ffcf3f); }
.head { width: 0; height: 0; border-left: 30px solid transparent; border-right: 30px solid transparent; }
.down .head { border-top: 40px solid #ffcf3f; }
.up .head { border-bottom: 40px solid #76b900; }
.pipe .k { font: 46px/1 Bebas; letter-spacing: 2px; }
.down .k { color: #ffcf3f; }
.up .k { color: #9be03a; }
.pipe .v { font: 600 26px/1.35 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.75); }
.how .foot2 { margin-top: 64px; font: 600 28px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.6); }`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const shot = async (name, html, width, height) => {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(work, name), omitBackground: true, clip: { x: 0, y: 0, width, height } });
};
await shot(
  'frame.png',
  `<div class="frame">
    <div class="label" style="top:24px">DUCK LAB XR <i>&middot;</i> MIXED REALITY, EMULATED (IWER)</div>
    <div class="band"><div class="sub">${CHANNEL ? 'MuJoCo in the browser &middot; RTX in Isaac Sim &middot; one WebRTC link' : 'MuJoCo runs the physics in the browser &middot; Isaac Sim draws it with RTX'}</div></div>
    <div class="label" style="top:${ISAAC.y + ISAAC.h - 62}px">NVIDIA ISAAC SIM ${VERSION} <i>&middot;</i> LIVE, OVER WEBRTC</div>
    <div class="foot"><span>duck.bruna.world</span><b>&middot;</b><span>github.com/Bruna-Worlds/duck-lab-xr</span></div>
  </div>`,
  W,
  H,
);
for (const [i, c] of CAPTIONS.entries()) await shot(`cap-${i}.png`, `<div class="cap"><div>${c.html}</div></div>`, W, BAND.h - 60);
await shot(
  'end.png',
  `<div class="end">
    <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
    <div class="tag">LIVE IN NVIDIA ISAAC SIM</div>
    <div class="small">Your room, the course and the duck, mirrored as you play</div>
    <div class="url">duck.bruna.world</div>
    <div class="gh">OPEN SOURCE ON GITHUB</div>
    <div class="small">github.com/Bruna-Worlds/duck-lab-xr<br><br>Microduck model and walking AI (c) Pollen Robotics, meshes CC BY-NC-SA 4.0.<br>NVIDIA and Isaac Sim are trademarks of NVIDIA Corporation.<br>Duck Lab XR is not made or endorsed by NVIDIA or Pollen Robotics.<br>(c) 2026 BRUNA GOODS LLC</div>
  </div>`,
  W,
  H,
);
if (CHANNEL) {
  await shot(
    'how.png',
    `<div class="how">
      <h1>HOW IT WORKS</h1>
      <div class="box"><div class="t">DUCK LAB XR, IN THE BROWSER</div><div class="d">MuJoCo runs Pip's physics and walking AI</div></div>
      <div class="pipes">
        <div class="pipe down"><div class="arrow"><div class="shaft"></div><div class="head"></div></div><div class="txt"><div class="k">DATA CHANNEL</div><div class="v">the scene, Pip's meshes, his pose 30 times a second</div></div></div>
        <div class="pipe up"><div class="arrow"><div class="head"></div><div class="shaft"></div></div><div class="txt"><div class="k">VIDEO</div><div class="v">Isaac Sim's RTX viewport, live</div></div></div>
      </div>
      <div class="box isaac"><div class="t">NVIDIA ISAAC SIM ${VERSION}</div><div class="d">The Duck Lab bridge rebuilds it all in USD,<br>RTX draws it</div></div>
      <div class="foot2">One WebRTC connection, both ways:<br>the stream that brings the picture back carries the data up.</div>
    </div>`,
    W,
    H,
  );
}
await browser.close();

// --- The live part: both takes at a steady 30 fps on one clock ----------------------------------
/** A take as a concat list: at each 1/30 s, the newest frame drawn by then. */
const list = (take) => {
  const frames = JSON.parse(readFileSync(join(TAKE, take, 'frames.json'), 'utf8'));
  const lines = [];
  let i = 0;
  const count = Math.round(LIVE * FPS);
  for (let k = 0; k < count; k++) {
    const when = T0 + k / FPS;
    while (i + 1 < frames.length && frames[i + 1].t <= when) i++;
    lines.push(`file '${resolve(TAKE, take, 'frames', frames[i].file).replace(/\\/g, '/')}'`, `duration ${(1 / FPS).toFixed(6)}`);
  }
  lines.push(lines[lines.length - 2]); // the concat demuxer wants the last file again
  const file = join(work, `list-${take}.txt`);
  writeFileSync(file, lines.join('\n'));
  return file;
};
const still = (name, dur) => ['-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', join(work, name)];
const isaacInput = info.stream === 'webm' ? ['-i', join(TAKE, 'isaac', 'stream.webm')] : ['-f', 'concat', '-safe', '0', '-i', list('isaac')];
// The recording starts at recStart on the take's clock: line it up with the app.
const isaacSync = info.stream === 'webm' ? `fps=${FPS},trim=start=${(T0 - info.recStart).toFixed(3)}:duration=${LIVE.toFixed(3)},setpts=PTS-STARTPTS,` : '';
const inputs = ['-f', 'concat', '-safe', '0', '-i', list('app'), ...isaacInput, ...still('frame.png', LIVE)];
CAPTIONS.forEach((_, i) => inputs.push(...still(`cap-${i}.png`, LIVE)));
const filter = [
  `color=c=0x0f1020:s=${W}x${H}:r=${FPS}:d=${LIVE.toFixed(3)}[bg]`,
  `[0:v]scale=${W}:${APP_H},setsar=1,fps=${FPS}[app]`,
  `[1:v]${isaacSync}scale=${W}:${ISAAC.h}:force_original_aspect_ratio=increase,crop=${W}:${ISAAC.h},setsar=1,fps=${FPS}[isaac]`,
  `[bg][app]overlay=0:0[s1]`,
  `[s1][isaac]overlay=0:${ISAAC.y}[s2]`,
  `[s2][2:v]overlay=0:0[s3]`,
];
let last = 's3';
CAPTIONS.forEach((c, i) => {
  const fade = `fade=t=in:st=${c.a.toFixed(3)}:d=0.25:alpha=1,fade=t=out:st=${Math.max(c.a + 0.3, c.b - 0.25).toFixed(3)}:d=0.25:alpha=1`;
  filter.push(`[${3 + i}:v]format=rgba,${fade}[c${i}]`);
  filter.push(`[${last}][c${i}]overlay=0:${BAND.y + 8}:enable='between(t,${c.a.toFixed(3)},${c.b.toFixed(3)})'[k${i}]`);
  last = `k${i}`;
});
const live = join(work, 'seg-live.mp4');
run([...inputs, '-filter_complex', filter.join(';'), '-map', `[${last}]`, '-t', LIVE.toFixed(3), ...encode, live]);
console.log(`live part ${LIVE.toFixed(1)} s`);
const end = join(work, 'seg-end.mp4');
const zoom = `[0:v]scale=${W * 2}:${H * 2},zoompan=z='1+0.035*on/${Math.round(END_DUR * FPS)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`;
run([...still('end.png', END_DUR), '-filter_complex', zoom, '-map', '[v]', '-t', END_DUR.toFixed(3), ...encode, end]);
const segments = [live];
if (CHANNEL) {
  const how = join(work, 'seg-how.mp4');
  const drift = `[0:v]scale=${W * 2}:${H * 2},zoompan=z='1.03-0.03*on/${Math.round(HOW_DUR * FPS)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},fade=t=in:st=0:d=0.3,format=yuv420p[v]`;
  run([...still('how.png', HOW_DUR), '-filter_complex', drift, '-map', '[v]', '-t', HOW_DUR.toFixed(3), ...encode, how]);
  segments.push(how);
}
segments.push(end);
writeFileSync(join(work, 'segments.txt'), segments.map((s) => `file '${resolve(s).replace(/\\/g, '/')}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', join(work, 'segments.txt'), '-c', 'copy', join(work, 'video.mp4')]);

// --- The score, written to this cut ---------------------------------------------------------------
const DUR = LIVE + HOW_DUR + END_DUR;
const cut = {
  dur: DUR,
  sections: [
    { key: 'wear', t0: 0, t1: at('room') },
    { key: 'real', t0: at('room'), t1: LIVE + HOW_DUR },
    { key: 'end', t0: LIVE + HOW_DUR, t1: DUR },
  ],
  hits: [
    { t: 0.3, kind: 'arrive' },
    { t: at('room', 0.2), kind: 'arrive' },
    { t: at('editor', 0.1), kind: 'try' },
    ...(CHANNEL ? [{ t: LIVE + 0.05, kind: 'card' }] : []),
    { t: LIVE + HOW_DUR + 0.1, kind: 'success' },
  ],
};
writeFileSync(join(work, 'cut.json'), JSON.stringify(cut, null, 1));
execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUTFILE]);
console.log(`ISAAC FILM ${OUTFILE} (${DUR.toFixed(1)} s)`);
