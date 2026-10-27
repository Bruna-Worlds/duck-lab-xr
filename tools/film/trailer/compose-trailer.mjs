// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Duck Lab XR trailer (1080 x 1920, 30 fps, for phones): concept clips
 * rendered in Blender with the real Microduck model (the vision: a person in a
 * headset, the simulation in the real room, a stumble sent to the computer,
 * the brain on the real robot), real footage from a Meta Quest 3 (scene
 * understanding and depth sensing: Pip walks into a real chair, steps onto a
 * dog bed, falls off and gets up), the real app recorded in the stacked view
 * (tools/film/stack), an end card, and an original synthesized score written
 * to this cut (music.mjs).
 *
 *   node tools/film/trailer/compose-trailer.mjs [frames dir] [out.mp4]
 *
 * frames dir (default artifacts/video/concept-real) holds the Blender renders
 * per clip (sim, home, wear, catch, deploy: 0000.jpg ...), rendered in Blender
 * by scripts kept outside this repository. The headset takes are
 * artifacts/video/quest/a.mov and b-vertical.mov (QUEST_A, QUEST_B), kept out
 * of git.
 * Concept clips carry a "CONCEPT ANIMATION" tag, the headset takes "SHOT ON
 * META QUEST 3", and the recorded app says it is the real app.
 *
 * FILM_LANG=zh makes the Chinese version (trailer-zh.mp4, from stack-zh.mp4):
 * the same cut and music with Chinese words (../lang.mjs).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';
import { filmCss, HTML_LANG, LANG_SUFFIX, tr } from '../lang.mjs';

const FRAMES = process.argv[2] ?? 'artifacts/video/concept-real';
const OUTFILE = process.argv[3] ?? `artifacts/video/trailer${LANG_SUFFIX}.mp4`;
const STACK = `artifacts/video/stack${LANG_SUFFIX}.mp4`;
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1080;
const H = 1920;
const work = `artifacts/video/trailer-work${LANG_SUFFIX}`;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
/** Width and height of a PNG (its IHDR). */
const pngSize = (file) => {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

// The headset takes (Meta Quest 3), one after the other, each in a window whose top edge is
// at QUEST_TOP, its caption under it. `pieces` are [from, to] seconds of the take, played
// back to back; `crop` is [x, y, w, h] in the take, scaled to `h` pixels high.
const QUEST_TOP = 330;
const QUEST_SHOTS = [
  // Into the chair: 1920 x 1080 at full resolution, the top strip (the headset's performance overlay) left out.
  { file: process.env.QUEST_A ?? 'artifacts/video/quest/a.mov', pieces: [[0.8, 4.4]], crop: [420, 180, 1080, 900], h: 900 },
  // On the dog bed, off it (about 7.1 s) and up again, in one piece: a vertical take
  // (608 x 1080), below Pip cam's panel and the performance overlay.
  { file: process.env.QUEST_B ?? 'artifacts/video/quest/b-vertical.mov', pieces: [[5.0, 10.4]], crop: [0, 380, 608, 700], h: 1072 },
].map((q) => ({ ...q, w: 2 * Math.round((q.h * q.crop[2]) / q.crop[3] / 2), dur: q.pieces.reduce((s, [a, b]) => s + b - a, 0) }));
/** Seconds into the quest clip at which a take's own second `at` plays. */
const questTime = (shot, at) => {
  let t = QUEST_SHOTS.slice(0, shot).reduce((s, q) => s + q.dur, 0);
  for (const [a, b] of QUEST_SHOTS[shot].pieces) {
    if (at <= b) return t + Math.max(0, at - a);
    t += b - a;
  }
  return t;
};

// --- The cut ----------------------------------------------------------------------------
const stackEvents = JSON.parse(readFileSync(`${STACK}.events.json`, 'utf8'));
const CLIPS = [
  {
    key: 'gap',
    dur: 5.0,
    captions: [
      { a: 0.25, b: 2.45, text: 'Robots learn to walk in simulation...' },
      { a: 2.45, b: 5.0, text: '...then a real home trips them up.' },
    ],
    hits: [{ t: 2.35, kind: 'fall' }],
  },
  { key: 'wear', dur: 5.0, captions: [{ a: 0.3, b: 5.0, text: 'Put on a headset: the simulation runs in your real room' }], hits: [{ t: 0.1, kind: 'scan', len: 2.5 }, { t: 4.15, kind: 'quack' }] },
  {
    key: 'quest',
    dur: QUEST_SHOTS.reduce((s, q) => s + q.dur, 0),
    captions: [
      { a: 0.3, b: QUEST_SHOTS[0].dur - 0.1, text: 'Your real furniture becomes solid: Pip walks into the chair' },
      { a: QUEST_SHOTS[0].dur + 0.2, b: QUEST_SHOTS[0].dur + QUEST_SHOTS[1].dur, text: 'It steps onto the dog bed, and falls off, as a real robot would' },
    ],
    hits: [{ t: questTime(1, 7.1), kind: 'fall' }],
  },
  {
    key: 'catch',
    dur: 5.6,
    captions: [{ a: 1.6, b: 5.6, text: 'A stumble becomes a test case, sent straight to your computer' }],
    hits: [{ t: 1.7, kind: 'trip' }, { t: 2.25, kind: 'card' }, { t: 4.1, kind: 'arrive' }],
  },
  { key: 'stack', dur: stackEvents.dur, captions: [], hits: stackHits(stackEvents) },
  { key: 'deploy', dur: 6.0, captions: [{ a: 0.4, b: 6.0, text: 'Then the same brain runs on the real robot' }], hits: [{ t: 2.35, kind: 'brain' }, { t: 4.0, kind: 'success' }] },
  { key: 'end', dur: 5.5, captions: [], hits: [] },
];

function stackHits(ev) {
  const hits = [];
  const find = (re) => ev.captions.find((c) => re.test(c.text));
  const arrive = find(/on the computer/i);
  if (arrive) hits.push({ t: arrive.a, kind: 'arrive' });
  for (const f of ev.ff) if (f.v >= 5) hits.push({ t: f.a, kind: 'train', len: Math.min(3, f.b - f.a) });
  const brain = ev.tokens.find((t) => t.kind === 'brain');
  if (brain) hits.push({ t: brain.t + 1.2, kind: 'brain' });
  const tryIt = find(/try it/i);
  if (tryIt) hits.push({ t: tryIt.a + 2.4, kind: 'try' });
  const walks = find(/walks with the brain/i);
  if (walks) hits.push({ t: walks.a, kind: 'success' });
  return hits;
}

let t = 0;
const sections = CLIPS.map((c) => {
  const s = { key: c.key === 'stack' ? 'real' : c.key, t0: t, t1: t + c.dur };
  t += c.dur;
  return s;
});
const DUR = t;
const cut = {
  dur: DUR,
  sections,
  hits: CLIPS.flatMap((c, i) => c.hits.map((h) => ({ ...h, t: sections[i].t0 + h.t }))),
};
writeFileSync(join(work, 'cut.json'), `${JSON.stringify(cut, null, 1)}\n`);

// --- Pictures: captions, tags, labels, the end card --------------------------------------
// The display font goes in as data: a page made with setContent may not load file links.
const fontData = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const css = filmCss(`@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${fontData}) format('truetype'); }
* { margin: 0; box-sizing: border-box; }
body { background: transparent; font-family: 'Segoe UI', system-ui, sans-serif; }
.cap { width: ${W}px; display: flex; justify-content: center; padding: 0 60px; }
.cap div { background: rgba(15, 16, 32, 0.88); border: 3px solid rgba(255, 207, 63, 0.85); border-radius: 30px; padding: 22px 34px 24px; color: #fff4dc; font-weight: 800; font-size: 52px; line-height: 1.16; text-align: center; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }
.tag { display: inline-block; padding: 10px 18px 8px; border-radius: 999px; background: rgba(15, 16, 32, 0.8); border: 2px solid rgba(255, 244, 220, 0.35); color: rgba(255, 244, 220, 0.9); font: 28px/1 Bebas; letter-spacing: 3px; }
.half { display: inline-flex; align-items: center; gap: 14px; padding: 12px 24px 10px; border-radius: 999px; font: 46px/1 Bebas; letter-spacing: 3px; color: #0f1020; }
.end { width: ${W}px; height: ${H}px; background: radial-gradient(circle at 50% 38%, #1c1d36, #0f1020 70%); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; color: #fff4dc; text-align: center; }
.end .sticker { background: #1c1d36; border: 5px solid #ffcf3f; border-radius: 26px; padding: 16px 44px 6px; font: 150px/1 Bebas; letter-spacing: 4px; color: #ffcf3f; box-shadow: 12px 12px 0 #ffcf3f; }
.end .line { font: 800 54px/1.2 'Segoe UI', sans-serif; max-width: 880px; }
.end .flow { font: 50px/1 Bebas; letter-spacing: 4px; color: #3de0b8; }
.end .url { font: 64px/1 Bebas; letter-spacing: 3px; color: #ffcf3f; margin-top: 30px; }
.end .by { font: 700 34px/1 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.85); }
.end .small { font: 600 22px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.5); max-width: 860px; margin-top: 50px; }
.qbg { width: ${W}px; height: ${H}px; background: radial-gradient(circle at 50% 40%, #1c1d36, #0f1020 72%); }
.qhead { width: ${W}px; text-align: center; font: 58px/1 Bebas; letter-spacing: 4px; color: #3de0b8; padding: 10px 0; }
.qflow { width: ${W}px; text-align: center; padding: 6px 0; }
.qflow .f { font: 64px/1 Bebas; letter-spacing: 5px; color: rgba(255, 244, 220, 0.3); }
.qflow .f b { font-weight: normal; color: #ffcf3f; }
.qflow .s { font: 600 30px/1.3 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.75); margin-top: 14px; }`);
const browser = await chromium.launch({ headless: true });
const shot = async (name, html, width, height) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="${HTML_LANG}"><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const box = await page.evaluate(() => {
    const r = document.body.firstElementChild.getBoundingClientRect();
    return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
  });
  await page.screenshot({ path: join(work, name), omitBackground: true, clip: { x: 0, y: 0, width: Math.min(width, box.w), height: Math.min(height, box.h) } });
  await page.close();
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
for (const c of CLIPS) {
  for (let i = 0; i < c.captions.length; i++) await shot(`cap-${c.key}-${i}.png`, `<div class="cap"><div>${esc(tr(c.captions[i].text))}</div></div>`, W, 400);
}
const REAL = esc(tr('REAL'));
const SIM = esc(tr('SIM'));
await shot('tag-concept.png', `<div class="tag">${esc(tr('CONCEPT ANIMATION'))}</div>`, 500, 80);
await shot('tag-quest.png', `<div class="tag" style="color:#0f1020;background:#ffcf3f;border-color:#ffcf3f">${esc(tr('SHOT ON META QUEST 3'))}</div>`, 600, 80);
await shot('quest-bg.png', '<div class="qbg"></div>', W, H);
await shot('quest-head.png', `<div class="qhead">${esc(tr('SCENE UNDERSTANDING + DEPTH SENSING'))}</div>`, W, 120);
await shot('quest-flow.png', `<div class="qflow"><div class="f"><b>${REAL} &rarr; ${SIM}</b> &rarr; ${REAL}</div><div class="s">${esc(tr('Your real room, inside the simulation'))}</div></div>`, W, 160);
await shot('tag-real.png', `<div class="tag" style="color:#0f1020;background:#3de0b8;border-color:#3de0b8">${esc(tr('THE REAL APP, RECORDED'))}</div>`, 600, 80);
await shot('half-sim.png', `<div class="half" style="background:#6fb7ff">&#10003; ${esc(tr('IN SIMULATION'))}</div>`, 600, 90);
await shot('half-home.png', `<div class="half" style="background:#ff5c8a">&#10007; ${esc(tr('AT HOME'))}</div>`, 600, 90);
const credits = [
  tr('Microduck model and walking AI (c) Pollen Robotics. Unofficial fan project, not made or endorsed by Pollen Robotics. Music: original, made for this film.'),
  tr('(c) 2026 BRUNA GOODS LLC. All rights reserved.'),
].map(esc);
await shot(
  'end.png',
  `<div class="end"><div class="sticker">DUCK LAB XR</div><div class="line">${esc(tr('Train your robot in your own room'))}</div><div class="flow">${REAL} &rarr; ${SIM} &rarr; ${REAL}</div><div class="url">duck.bruna.world</div><div class="by">${esc(tr('Developed by Bruna Worlds'))}</div><div class="small">${credits.join('<br>')}</div></div>`,
  W,
  H,
);
await browser.close();
const conceptTagX = W - 26 - pngSize(join(work, 'tag-concept.png')).w; // right-aligned, whatever the language

// --- Segments ----------------------------------------------------------------------------
const encode = ['-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p'];
const overlayChain = (base, items) => {
  // items: [{ input, x, y, a, b }] -> filter lines, last label 'v'
  const parts = [];
  let last = base;
  items.forEach((it, k) => {
    const out = k === items.length - 1 ? 'v' : `o${k}`;
    const fade = it.a !== undefined ? `,fade=t=in:st=${it.a.toFixed(3)}:d=0.25:alpha=1,fade=t=out:st=${Math.max(it.a + 0.3, it.b - 0.25).toFixed(3)}:d=0.25:alpha=1` : '';
    parts.push(`[${it.input}:v]format=rgba${fade}[i${k}]`);
    parts.push(`[${last}][i${k}]overlay=x=${it.x}:y=${it.y}${it.a !== undefined ? `:enable='between(t,${it.a.toFixed(3)},${it.b.toFixed(3)})'` : ''}[${out}]`);
    last = out;
  });
  if (!items.length) parts.push(`[${base}]null[v]`);
  return parts;
};
const seqInput = (clip) => ['-framerate', String(FPS), '-start_number', '0', '-i', join(FRAMES, clip, '%04d.jpg')];
const imgInput = (name, dur) => ['-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', join(work, name)];
const segs = [];
for (const c of CLIPS) {
  const out = join(work, `seg-${c.key}.mp4`);
  segs.push(out);
  if (c.key === 'gap') {
    const inputs = [...seqInput('sim'), ...seqInput('home')];
    const imgs = ['half-sim.png', 'half-home.png', 'tag-concept.png', ...c.captions.map((_, i) => `cap-gap-${i}.png`)];
    for (const img of imgs) inputs.push(...imgInput(img, c.dur));
    const items = [
      { input: 2, x: 36, y: 40 },
      { input: 3, x: 36, y: 960 + 84 }, // under the caption on the seam (two lines reach about 960 + 60)
      { input: 4, x: conceptTagX, y: 40 },
      ...c.captions.map((cap, i) => ({ input: 5 + i, x: 0, y: 960 - 90, a: cap.a, b: cap.b })),
    ];
    const filter = [`[0:v]scale=${W}:960,setsar=1[top]`, `[1:v]scale=${W}:960,setsar=1[bot]`, '[top][bot]vstack=inputs=2[base]', ...overlayChain('base', items)].join(';');
    run([...inputs, '-filter_complex', filter, '-map', '[v]', '-t', c.dur.toFixed(3), ...encode, out]);
  } else if (c.key === 'stack') {
    const inputs = ['-i', STACK, ...imgInput('tag-real.png', c.dur)];
    // The tag in the headset half's free top-right corner (the HEADSET label holds the left, the band its own line).
    const tag = pngSize(join(work, 'tag-real.png'));
    const filter = [`[0:v]scale=${W}:${H},setsar=1,fps=${FPS}[base]`, ...overlayChain('base', [{ input: 1, x: W - 28 - tag.w, y: 24, a: 0.0, b: 3.6 }])].join(';');
    run([...inputs, '-filter_complex', filter, '-map', '[v]', '-t', c.dur.toFixed(3), ...encode, out]);
  } else if (c.key === 'quest') {
    // The real headset takes on a dark page, each in its own window (the take's pieces back to
    // back), shown only while it plays; the caption sits under the window of its take.
    const inputs = [...imgInput('quest-bg.png', c.dur)];
    const parts = [`[0:v]scale=${W}:${H},setsar=1,format=yuv420p[bg]`];
    const starts = [];
    let base = 'bg';
    let input = 1;
    let t0 = 0;
    QUEST_SHOTS.forEach((q, i) => {
      const labels = [];
      for (const [a, b] of q.pieces) {
        inputs.push('-ss', a.toFixed(3), '-t', (b - a).toFixed(3), '-i', q.file);
        const [cx, cy, cw, ch] = q.crop;
        parts.push(`[${input}:v]crop=${cw}:${ch}:${cx}:${cy},scale=${q.w}:${q.h}:flags=lanczos,fps=${FPS},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[p${input}]`);
        labels.push(`[p${input}]`);
        input++;
      }
      parts.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0,setpts=PTS-STARTPTS+${t0.toFixed(3)}/TB[q${i}]`);
      parts.push(`[${base}][q${i}]overlay=x=${(W - q.w) / 2}:y=${QUEST_TOP}:enable='between(t,${t0.toFixed(3)},${(t0 + q.dur).toFixed(3)})'[s${i}]`);
      base = `s${i}`;
      starts.push(t0);
      t0 += q.dur;
    });
    const imgs = ['quest-head.png', 'quest-flow.png', 'tag-quest.png', ...c.captions.map((_, i) => `cap-quest-${i}.png`)];
    for (const img of imgs) inputs.push(...imgInput(img, c.dur));
    const k = input;
    const tag = pngSize(join(work, 'tag-quest.png'));
    const capY = (cap) => QUEST_TOP + QUEST_SHOTS[Math.max(0, starts.findLastIndex((s) => cap.a >= s))].h + 32;
    const items = [
      { input: k, x: 0, y: QUEST_TOP - 130 },
      { input: k + 1, x: 0, y: 1650 },
      { input: k + 2, x: W - 40 - tag.w, y: 40 },
      ...c.captions.map((cap, i) => ({ input: k + 3 + i, x: 0, y: capY(cap), a: cap.a, b: cap.b })),
    ];
    const filter = [...parts, ...overlayChain(base, items)].join(';');
    run([...inputs, '-filter_complex', filter, '-map', '[v]', '-t', c.dur.toFixed(3), ...encode, out]);
  } else if (c.key === 'end') {
    const filter = `[0:v]scale=${W * 2}:${H * 2},zoompan=z='1+0.04*on/${Math.round(c.dur * FPS)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`;
    run([...imgInput('end.png', c.dur), '-filter_complex', filter, '-map', '[v]', '-t', c.dur.toFixed(3), ...encode, out]);
  } else {
    const inputs = [...seqInput(c.key), ...imgInput('tag-concept.png', c.dur)];
    c.captions.forEach((_, i) => inputs.push(...imgInput(`cap-${c.key}-${i}.png`, c.dur)));
    const items = [{ input: 1, x: conceptTagX, y: 40 }, ...c.captions.map((cap, i) => ({ input: 2 + i, x: 0, y: 1500, a: cap.a, b: cap.b }))];
    const filter = [`[0:v]scale=${W}:${H},setsar=1[base]`, ...overlayChain('base', items)].join(';');
    run([...inputs, '-filter_complex', filter, '-map', '[v]', '-t', c.dur.toFixed(3), ...encode, out]);
  }
  console.log(`segment ${c.key} ${c.dur.toFixed(1)} s`);
}
writeFileSync(join(work, 'segments.txt'), segs.map((s) => `file '${resolve(s).replace(/\\/g, '/')}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', join(work, 'segments.txt'), '-c', 'copy', join(work, 'video.mp4')]);

// --- Music, written to this cut, then the master ---------------------------------------
execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUTFILE]);
console.log(`TRAILER ${OUTFILE} (${DUR.toFixed(1)} s)`);
if (!existsSync(OUTFILE)) process.exit(1);
