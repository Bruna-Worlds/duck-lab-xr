// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Composes the stacked phone film from the takes stack.sh records:
 *   top    (1080 x 840)  the headset, emulated mixed reality (the headset-N segments)
 *   band   (1080 x 240)  the caption of the moment, and the link between the halves
 *   bottom (1080 x 840)  the trainer page, zooming onto the card that matters
 * Both halves run on one wall clock; "!ff N" marks speed both up together
 * (with a badge). Output: artifacts/video/stack.mp4 (1080 x 1920, 30 fps).
 *
 *   node tools/film/stack/compose-stack.mjs [takes dir] [out.mp4]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';

const TAKES = process.argv[2] ?? 'artifacts/video/stack';
const OUTFILE = process.argv[3] ?? 'artifacts/video/stack.mp4';
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1080;
const HALF = 840;
const BAND = 240;
const work = join(TAKES, 'compose');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// --- Takes ----------------------------------------------------------------------------
const segments = readdirSync(TAKES)
  .filter((d) => /^headset-\d+$/.test(d) && existsSync(join(TAKES, d, 'frames.json')))
  .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
const top = segments.flatMap((d) => JSON.parse(readFileSync(join(TAKES, d, 'frames.json'), 'utf8')).map((f) => ({ ...f, path: resolve(TAKES, d, 'frames', f.file) })));
top.sort((a, b) => a.t - b.t);
const meta = JSON.parse(readFileSync(join(TAKES, segments[0], 'meta.json'), 'utf8'));
const bottom = JSON.parse(readFileSync(join(TAKES, 'trainer', 'frames.json'), 'utf8')).map((f) => ({ ...f, path: resolve(TAKES, 'trainer', 'frames', f.file) }));
bottom.sort((a, b) => a.t - b.t);
const { view, scale, focus } = JSON.parse(readFileSync(join(TAKES, 'trainer', 'focus.json'), 'utf8'));
const readMarks = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => ({ t: Number(line.slice(0, line.indexOf(' '))), text: line.slice(line.indexOf(' ') + 1) }))
    : [];
const marks = [...readMarks(join(TAKES, 'headset.marks')), ...readMarks(join(TAKES, 'trainer', 'marks.txt'))].sort((a, b) => a.t - b.t);
const captions = marks.filter((m) => !m.text.startsWith('!'));
const speeds = marks.filter((m) => m.text.startsWith('!ff ')).map((m) => ({ t: m.t, speed: Number(m.text.slice(4)) || 1 }));
const doneAt = existsSync(join(TAKES, 'done.txt')) ? statSync(join(TAKES, 'done.txt')).mtimeMs / 1000 : top[top.length - 1].t;
const t0 = Math.max(captions[0].t - 1.2, top[0].t, bottom[0].t);
const tEnd = Math.min(doneAt + 0.5, top[top.length - 1].t, bottom[bottom.length - 1].t);

// --- Source time for each film frame (both halves speed up together) -----------------
const speedAt = (s) => {
  let v = 1;
  for (const m of speeds) if (m.t <= s) v = m.speed;
  return v;
};
const source = [];
// Cuts: "!cut" ... "!resume" marks drop the time between (waiting on the headset, say). A
// take without them gets one between TRY IT and Pip walking on the new brain when that wait
// is long: the viewer goes from the offer straight to the new brain running.
const cuts = [];
let open = null;
for (const m of marks) {
  if (m.text === '!cut') open = m.t;
  else if (m.text === '!resume' && open !== null) {
    cuts.push([open, m.t]);
    open = null;
  }
}
if (!cuts.length) {
  const offer = captions.find((c) => /new brain is on the headset/i.test(c.text));
  const walks = captions.find((c) => /walks with the brain/i.test(c.text));
  if (offer && walks && walks.t - offer.t > 9) cuts.push([offer.t + 3.2, walks.t - 0.8]);
}
const inCut = (s) => cuts.find(([a, b]) => s >= a && s < b);
for (let s = t0; s < tEnd; s += speedAt(s) / FPS) {
  const cut = inCut(s);
  if (cut) s = cut[1];
  source.push(s);
}
if (cuts.length) console.log(`cut ${cuts.map(([a, b]) => `${(b - a).toFixed(1)} s`).join(', ')} of waiting`);
// Tighter beats: some beats (a caption to the next) are capped, the excess cut just before the
// next caption (both halves jump; nothing moves much there), and the last beat ends after TAIL s.
const TRIMS = [
  [/walks your living room/i, 4.6],
  [/on the computer a moment later/i, 4.2],
  [/train on your computer/i, 5.2],
];
const TAIL = Number(process.env.STACK_TAIL ?? 11);
{
  const frameAt = (s) => {
    const i = source.findIndex((x) => x >= s);
    return i < 0 ? source.length : i;
  };
  const lead = Math.round(0.4 * FPS);
  const drops = [];
  captions.forEach((c, i) => {
    const next = captions[i + 1];
    if (!next) {
      const end = frameAt(c.t) + Math.round(TAIL * FPS);
      if (end < source.length) drops.push([end, source.length]);
      return;
    }
    const rule = TRIMS.find(([re]) => re.test(c.text));
    if (!rule) return;
    const fa = frameAt(c.t);
    const fb = frameAt(next.t);
    const excess = fb - fa - Math.round(rule[1] * FPS);
    if (excess > 0) drops.push([fb - lead - excess, fb - lead]);
  });
  for (const [a, b] of drops.sort((x, y) => y[0] - x[0])) source.splice(a, b - a);
  if (drops.length) console.log(`trimmed ${(drops.reduce((s, [a, b]) => s + b - a, 0) / FPS).toFixed(1)} s from long beats and the tail`);
}
const filmOf = (s) => {
  // Film time of a source time (the first film frame at or after it).
  let i = source.findIndex((x) => x >= s);
  if (i < 0) i = source.length - 1;
  return i / FPS;
};
console.log(`film ${(source.length / FPS).toFixed(1)} s from ${(tEnd - t0).toFixed(1)} s of takes; ${top.length} headset and ${bottom.length} trainer frames`);

const pick = (list, s, from) => {
  let i = from;
  while (i + 1 < list.length && list[i + 1].t <= s) i++;
  return i;
};
const concat = (list, name) => {
  const lines = ['ffconcat version 1.0'];
  let i = 0;
  for (const s of source) {
    i = pick(list, s, i);
    lines.push(`file '${list[i].path.replace(/\\/g, '/')}'`, `duration ${(1 / FPS).toFixed(6)}`);
  }
  lines.push(`file '${list[i].path.replace(/\\/g, '/')}'`);
  writeFileSync(join(work, name), `${lines.join('\n')}\n`);
};
concat(top, 'top.ffconcat');
concat(bottom, 'bottom.ffconcat');

// --- The trainer half's zoom: keyframes per focus change, eased over 0.6 s ------------
const fw = view.width * scale;
const fh = view.height * scale;
const aspect = W / HALF;
const region = (f) => {
  // The focus rect (page px) grown to the film's aspect, in frame pixels, inside the frame.
  let w = f.w * scale;
  let h = f.h * scale;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  w = Math.min(w, fw);
  h = Math.min(h, fh);
  const x = Math.min(Math.max(0, f.x * scale + (f.w * scale) / 2 - w / 2), fw - w);
  const y = Math.min(Math.max(0, f.y * scale + (f.h * scale) / 2 - h / 2), fh - h);
  return { z: fw / w, x, y };
};
const ramp = Math.round(0.6 * FPS);
const keys = focus.map((f) => ({ frame: Math.round(filmOf(f.t) * FPS), ramp: f.ease ? Math.round(f.ease * FPS) : ramp, ...region(f) }));
const piecewise = (list, field) => {
  // Hold each key's value; ease into the next over its ramp (smoothstep).
  let expr = `${list[list.length - 1][field].toFixed(3)}`;
  for (let k = list.length - 1; k >= 1; k--) {
    const a = list[k - 1];
    const b = list[k];
    const n = b.ramp ?? ramp;
    const start = b.frame;
    const end = b.frame + n;
    const u = `((in-${start})/${n})`;
    expr = `if(lt(in,${start}),${a[field].toFixed(3)},if(lt(in,${end}),${a[field].toFixed(3)}+(${(b[field] - a[field]).toFixed(3)})*${u}*${u}*(3-2*${u}),${expr}))`;
  }
  return expr;
};
const zoompan = (list, w, h) =>
  list.length > 1
    ? `zoompan=z='${piecewise(list, 'z')}':x='${piecewise(list, 'x')}':y='${piecewise(list, 'y')}':d=1:s=${w}x${h}:fps=${FPS}`
    : `scale=${w}:${h}:flags=lanczos`;
const zoomFilter = zoompan(keys, W, HALF);

// --- The headset half's zoom: in on Pip cam's live data, out; in on the new brain's offer, out once Pip walks with it.
// Pip cam's place in the picture comes from its world corners (the recorder's log) and the seat camera.
const topBox = meta.box ?? { x: 0, y: 0, width: meta.viewport.w, height: meta.viewport.h };
// At rest the headset picture is trimmed by 5% (anchored at the top): the emulated right
// controller's axis handles (red and green cones) poke into the bottom corner of the raw view.
const REST_Z = 1.05;
const rest = { z: REST_Z, x: (topBox.width * (1 - 1 / REST_Z)) / 2, y: 0 };
const topKeys = [];
const seatFile = join(TAKES, 'seat.txt');
const lastTargets = join(TAKES, segments[segments.length - 1], 'targets.json');
const offerCap = captions.find((c) => /new brain is on the headset/i.test(c.text));
const walksCap = captions.find((c) => /walks with the brain/i.test(c.text));
const liveCap = captions.find((c) => /live robot data/i.test(c.text));
const targetsLog = segments.flatMap((d) => {
  const file = join(TAKES, d, 'targets-log.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
});
/** The logged snapshot nearest to wall time t that has `key`. */
const snapshotAt = (t, key) => {
  let best = null;
  for (const s of targetsLog) if (s[key] && s.wall && (!best || Math.abs(s.wall - t) < Math.abs(best.wall - t))) best = s;
  return best;
};
if (existsSync(seatFile) && targetsLog.some((s) => s.wall) && (offerCap || liveCap)) {
  const [ex, ey, ez, tx, ty, tz] = readFileSync(seatFile, 'utf8').trim().split(/\s+/).map(Number);
  const tw = topBox.width;
  const th = topBox.height;
  const fovy = (Number(process.env.REC_FOV ?? 62) * Math.PI) / 180;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((v) => v / Math.hypot(...a));
  const E = [ex, ey, ez];
  const f = unit(sub([tx, ty, tz], E));
  const r = unit(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const project = (p) => {
    const d = sub([p.x, p.y, p.z], E);
    const k = Math.tan(fovy / 2);
    return [((dot(d, r) / (dot(d, f) * k * (tw / th)) + 1) / 2) * tw, ((1 - dot(d, u) / (dot(d, f) * k)) / 2) * th];
  };
  // The headset frames are only about 1250 px wide: closer than this turns to mush.
  const MAX_TOP_ZOOM = Number(process.env.MAX_TOP_ZOOM ?? 3.2);
  /** The zoom that shows these world corners filling `fill` of the half (its aspect kept), at most MAX_TOP_ZOOM. */
  const frameOn = (corners, fill) => {
    const pts = corners.map(project);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    let w = (Math.max(...xs) - Math.min(...xs)) / fill;
    let h = (Math.max(...ys) - Math.min(...ys)) / fill;
    if (w / h < tw / th) w = h * (tw / th);
    else h = w / (tw / th);
    w = Math.min(tw, Math.max(w, tw / MAX_TOP_ZOOM));
    h = Math.min(th, Math.max(h, th / MAX_TOP_ZOOM));
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    return { z: tw / w, x: Math.min(Math.max(0, cx - w / 2), tw - w), y: Math.min(Math.max(0, cy - h / 2), th - h) };
  };
  const at = (t) => Math.max(1, Math.round(filmOf(t) * FPS));
  topKeys.push({ frame: 0, ...rest });
  if (liveCap) {
    // Pip cam opened on its live data: the panel, feed and charts, filling most of the picture.
    const snap = snapshotAt(liveCap.t + 3, 'detailsCorners');
    const next = captions.find((c) => c.t > liveCap.t);
    if (snap?.robotCorners) {
      topKeys.push({ frame: at(liveCap.t + 1.0), ramp: Math.round(0.8 * FPS), ...frameOn(snap.robotCorners, 0.94) });
      if (next) topKeys.push({ frame: at(next.t - 0.5), ramp: Math.round(0.7 * FPS), ...rest });
      console.log(`headset zoom: live data ${topKeys[topKeys.length - (next ? 2 : 1)].z.toFixed(2)}x`);
    }
  }
  if (offerCap) {
    // The new brain's card on Pip cam, close enough to read: NEW BRAIN READY, its numbers, TRY IT.
    const snap = snapshotAt(offerCap.t + 0.5, 'offerCorners');
    if (snap?.offerCorners) {
      topKeys.push({ frame: at(offerCap.t - 0.4), ramp: Math.round(0.8 * FPS), ...frameOn(snap.offerCorners, 0.82) });
      if (walksCap) topKeys.push({ frame: at(walksCap.t + 0.6), ...rest });
      console.log(`headset zoom: offer card ${topKeys[topKeys.length - (walksCap ? 2 : 1)].z.toFixed(2)}x`);
    }
  }
}
if (!topKeys.length && existsSync(seatFile) && existsSync(lastTargets) && offerCap) {
  const [ex, ey, ez, tx, ty, tz] = readFileSync(seatFile, 'utf8').trim().split(/\s+/).map(Number);
  const tw = topBox.width;
  const th = topBox.height;
  const fovy = (Number(process.env.REC_FOV ?? 62) * Math.PI) / 180;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((v) => v / Math.hypot(...a));
  const E = [ex, ey, ez];
  const f = unit(sub([tx, ty, tz], E));
  const r = unit(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const project = (p) => {
    const d = sub([p.x, p.y, p.z], E);
    const k = Math.tan(fovy / 2);
    return [((dot(d, r) / (dot(d, f) * k * (tw / th)) + 1) / 2) * tw, ((1 - dot(d, u) / (dot(d, f) * k)) / 2) * th];
  };
  const t = JSON.parse(readFileSync(lastTargets, 'utf8'));
  if (t.bar && t.more) {
    const [bx, by] = project(t.bar);
    const [mx, my] = project(t.more);
    // The panel: from its top-right button down to the bar under it; zoom so it fills about half the picture.
    const cx = (bx + mx) / 2 - 20;
    const cy = (by + my) / 2;
    const zw = Math.min(tw, Math.max(560, (by - my) * 2.4 * (tw / th)));
    const zh = zw / (tw / th);
    const full = rest;
    const panel = { z: tw / zw, x: Math.min(Math.max(0, cx - zw / 2), tw - zw), y: Math.min(Math.max(0, cy - zh / 2), th - zh) };
    topKeys.push({ frame: 0, ...full });
    topKeys.push({ frame: Math.max(1, Math.round((filmOf(offerCap.t) - 0.4) * FPS)), ...panel });
    if (walksCap) topKeys.push({ frame: Math.round((filmOf(walksCap.t) + 0.6) * FPS), ...full });
    console.log(`headset zoom: Pip cam at ${Math.round(cx)},${Math.round(cy)} px, ${panel.z.toFixed(2)}x`);
  }
}
if (!topKeys.length) topKeys.push({ frame: 0, ...rest }, { frame: 1, ...rest }); // no Pip cam zoom: just the trim
const topZoom = zoompan(topKeys, W, HALF);

// --- Overlays drawn as pictures (Chromium): band captions, labels, badge, tokens -----
// The display font goes in as data: a page made with setContent may not load file links.
const fontData = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const css = `@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${fontData}) format('truetype'); }
* { margin: 0; box-sizing: border-box; }
body { background: transparent; font-family: 'Segoe UI', system-ui, sans-serif; }
.band { width: ${W}px; height: ${BAND}px; background: #0f1020; border-top: 3px solid #ffcf3f; border-bottom: 3px solid #ffcf3f; display: flex; flex-direction: column; justify-content: center; padding: 0 56px; position: relative; }
.band .link { position: absolute; left: 56px; top: 22px; font: 26px/1 Bebas; letter-spacing: 3px; color: #3de0b8; }
.band .text { color: #fff4dc; font-weight: 800; font-size: 44px; line-height: 1.18; text-align: center; margin-top: 18px; }
.pill { display: inline-flex; align-items: center; gap: 12px; padding: 10px 20px 8px; border-radius: 999px; background: rgba(15, 16, 32, 0.86); border: 2px solid rgba(255, 244, 220, 0.3); color: #fff4dc; font: 32px/1 Bebas; letter-spacing: 2px; }
.pill i { width: 14px; height: 14px; border-radius: 50%; background: #3de0b8; display: inline-block; }
.pill small { font: 600 20px/1 'Segoe UI', sans-serif; letter-spacing: 0; color: rgba(255, 244, 220, 0.7); }
.badge { display: inline-block; padding: 12px 22px 9px; border-radius: 14px; background: #ffcf3f; color: #0f1020; font: 38px/1 Bebas; letter-spacing: 2px; }
.token { display: inline-flex; align-items: center; gap: 10px; padding: 12px 18px 10px; border-radius: 16px; font: 30px/1 Bebas; letter-spacing: 2px; color: #0f1020; box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5); }`;
const browser = await chromium.launch({ headless: true });
const shot = async (name, html, width, height) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(work, name), omitBackground: true, clip: { x: 0, y: 0, width, height } });
  await page.close();
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
await shot('band-0.png', `<div class="band"><div class="link">&#8645; HEADSET AND COMPUTER, LINKED OVER WI-FI</div><div class="text">&nbsp;</div></div>`, W, BAND);
for (let i = 0; i < captions.length; i++) {
  await shot(`band-${i + 1}.png`, `<div class="band"><div class="link">&#8645; HEADSET AND COMPUTER, LINKED OVER WI-FI</div><div class="text">${esc(captions[i].text)}</div></div>`, W, BAND);
}
await shot('label-top.png', `<div class="pill"><i></i>HEADSET <small>mixed reality, emulated (IWER)</small></div>`, 760, 64);
await shot('label-bottom.png', `<div class="pill"><i style="background:#ffcf3f"></i>YOUR COMPUTER <small>Duck Lab XR trainer, in the browser</small></div>`, 760, 64);
const speedsUsed = [...new Set(speeds.map((s) => s.speed).filter((v) => v > 1))];
for (const v of speedsUsed) await shot(`ff-${v}.png`, `<div class="badge">&#9654;&#9654; ${v}&times; FASTER</div>`, 300, 64);
await browser.close();

// --- Timing of overlays on the film clock ----------------------------------------------
const filmEnd = source.length / FPS;
const capTimes = captions.map((c, i) => {
  const a = filmOf(c.t);
  const next = i + 1 < captions.length ? filmOf(captions[i + 1].t) : filmEnd;
  return { a, b: i + 1 < captions.length ? Math.min(next, a + 6.5) : filmEnd - 0.1 };
});
const ffWindows = [];
for (let i = 0; i < speeds.length; i++) {
  if (speeds[i].speed > 1) ffWindows.push({ v: speeds[i].speed, a: filmOf(speeds[i].t), b: i + 1 < speeds.length ? filmOf(speeds[i + 1].t) : filmEnd });
}
// When the test case goes up and the brain comes down (for the trailer's music; nothing is drawn for them).
const packAt = captions.find((c) => /test case/i.test(c.text) && /saves|tap/i.test(c.text));
const brainAt = captions.find((c) => /new brain is on the headset/i.test(c.text));
const tokens = [];
if (packAt) tokens.push({ a: filmOf(packAt.t) + 1.6, down: true });
if (brainAt) tokens.push({ a: Math.max(0, filmOf(brainAt.t) - 1.2), down: false });

// --- ffmpeg ------------------------------------------------------------------------------
const box = meta.box ?? { x: 0, y: 0, width: meta.viewport.w, height: meta.viewport.h };
const inputs = ['-f', 'concat', '-safe', '0', '-i', join(work, 'top.ffconcat'), '-f', 'concat', '-safe', '0', '-i', join(work, 'bottom.ffconcat')];
const images = ['band-0.png', ...captions.map((_, i) => `band-${i + 1}.png`), 'label-top.png', 'label-bottom.png', ...speedsUsed.map((v) => `ff-${v}.png`)];
for (const img of images) inputs.push('-loop', '1', '-framerate', String(FPS), '-t', filmEnd.toFixed(3), '-i', join(work, img));
const idx = (img, from = 2) => from + images.indexOf(img);
const parts = [];
parts.push(`[0:v]crop=${Math.round(box.width)}:${Math.round(box.height)}:${Math.round(box.x)}:${Math.round(box.y)},setsar=1,${topZoom},setsar=1,fps=${FPS},format=yuv420p[top]`);
parts.push(`[1:v]scale=${fw}:${fh},setsar=1,${zoomFilter},setsar=1,format=yuv420p[bot]`);
parts.push(`[${idx('band-0.png')}:v]format=yuv420p[band]`);
parts.push(`[top][band][bot]vstack=inputs=3[v0]`);
let last = 'v0';
let n = 0;
const over = (input, x, y, enable) => {
  const out = `v${++n}`;
  parts.push(`[${last}][${input}]overlay=x=${x}:y=${y}${enable ? `:enable='${enable}'` : ''}[${out}]`);
  last = out;
};
captions.forEach((_, i) => {
  const { a, b } = capTimes[i];
  const fadeIn = `[${idx(`band-${i + 1}.png`)}:v]format=rgba,fade=t=in:st=${a.toFixed(3)}:d=0.25:alpha=1,fade=t=out:st=${Math.max(a + 0.3, b - 0.25).toFixed(3)}:d=0.25:alpha=1[c${i}]`;
  parts.push(fadeIn);
  over(`c${i}`, 0, HALF, `between(t,${a.toFixed(3)},${b.toFixed(3)})`);
});
over(`${idx('label-top.png')}:v`, 24, 22);
over(`${idx('label-bottom.png')}:v`, 24, HALF + BAND + 22);
for (const f of ffWindows) over(`${idx(`ff-${f.v}.png`)}:v`, W - 300 + 40, HALF + BAND + HALF - 86, `between(t,${f.a.toFixed(3)},${f.b.toFixed(3)})`);
parts.push(`[${last}]format=yuv420p[out]`);
const script = join(work, 'filter.txt');
writeFileSync(script, parts.join(';\n'));
const args = ['-y', ...inputs, '-filter_complex_script', script, '-map', '[out]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', filmEnd.toFixed(3), OUTFILE];
console.log(`ffmpeg: ${images.length} overlays, ${keys.length} zoom keys`);
execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'inherit'] });
// Film-time events for the trailer's music (tools/film/trailer).
writeFileSync(
  `${OUTFILE}.events.json`,
  `${JSON.stringify(
    {
      dur: filmEnd,
      captions: captions.map((c, i) => ({ ...capTimes[i], text: c.text })),
      tokens: tokens.map((t) => ({ kind: t.down ? 'pack' : 'brain', t: t.a })),
      ff: ffWindows,
    },
    null,
    1,
  )}\n`,
);
console.log(`STACK ${OUTFILE} (${filmEnd.toFixed(1)} s)`);
