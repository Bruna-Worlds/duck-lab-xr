// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The climbing film (1920 x 1080, 30 fps): the whole loop for one skill, from
 * real takes.
 *   fail/     the app (record-climb.mjs TAKE=fail): the brain in use trips on
 *             the Dog Bed's 2 cm mat and the app saves the moment as a test case
 *   page/     the trainer page (record-trainers.mjs TRAINER=microduck-stepup
 *             SEND=1): the test case in the inbox, the step-up trainer, the run
 *             live and as a time-lapse, the export, the cross-check, the release
 *             sent to the headset
 *   videos    mjlab's own training video of that run (128 of the 1,024 ducks;
 *             duckstep/train.py, DUCKSTEP_VIDEO_ENVS), cut in at the start and
 *             the end of the time-lapse
 *   try/      the app (TAKE=try): New brain ready, TRY IT by the controller's
 *             ray, the same course on the new brain
 *   film-2cm.mp4, film-3cm.mp4  the new brain on 2 and 3 cm terraces, 32 ducks,
 *             at real speed (tools/train/python/duckstep/film.py)
 * plus a title, the step test's numbers on a card (BENCH, step-bench.mjs
 * --json) and an end card, captions in a band below, and a score written to
 * this cut (tools/film/trailer/music.mjs).
 *
 *   node tools/film/climb/compose-climb.mjs [takes dir] [out.mp4]
 *
 * Env: RUN (the training run's folder, for its videos), BENCH (the step test
 * JSON: brains shipped, BENCH_OLD and BENCH_NEW; BENCH_NAMES maps them to column
 * names), NAME (the release), ENVS, ROUNDS.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';

const TAKES = process.argv[2] ?? 'artifacts/video/climb';
const OUTFILE = process.argv[3] ?? join(TAKES, 'duck-lab-climb.mp4');
const RUN = process.env.RUN ?? '';
const BENCH = process.env.BENCH ?? 'artifacts/brains/bench-final.json';
const NAME = process.env.NAME ?? 'step-up-6';
const ENVS = process.env.ENVS ?? '1,024';
const ROUNDS = process.env.ROUNDS ?? '1,000';
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1920;
const H = 1080;
const BAND = 150;
const LAPSE_FILM = Number(process.env.LAPSE_FILM ?? 8);
const CROWD_S = Number(process.env.CROWD_S ?? 8);
const work = join(TAKES, 'compose');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// --- Takes ------------------------------------------------------------------------------------------
/** A page or viewer take (record-trainers.mjs, record-viewer.mjs): frames, marks.txt, focus.json. */
function loadPageTake(name) {
  const dir = join(TAKES, name);
  if (!existsSync(join(dir, 'frames.json'))) return null;
  const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'))
    .map((f) => ({ ...f, path: resolve(dir, 'frames', f.file) }))
    .sort((a, b) => a.t - b.t);
  if (!frames.length) return null;
  const { view, scale, focus } = JSON.parse(readFileSync(join(dir, 'focus.json'), 'utf8'));
  const marks = readFileSync(join(dir, 'marks.txt'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ t: Number(line.slice(0, line.indexOf(' '))), text: line.slice(line.indexOf(' ') + 1) }))
    .sort((a, b) => a.t - b.t);
  const end = marks.find((m) => m.text === '!end')?.t ?? frames[frames.length - 1].t;
  const speedMarks = marks.filter((m) => /^!(ff|fit|lapse|live)/.test(m.text));
  const segments = speedMarks.map((m, i) => {
    const next = speedMarks[i + 1]?.t ?? end;
    const [kind, arg] = m.text.slice(1).split(' ');
    const speed = kind === 'ff' ? Number(arg) || 1 : kind === 'fit' ? Math.max(1, (next - m.t) / Number(arg)) : kind === 'lapse' ? Math.max(1, (next - m.t) / LAPSE_FILM) : 1;
    return { t: m.t, until: next, speed, lapse: kind === 'lapse' };
  });
  return { name, dir, frames, view, scale, focus, marks, end, segments, captions: marks.filter((m) => !m.text.startsWith('!')) };
}
/** An app take (record-climb.mjs): frames, marks.json, trace.json. */
function loadAppTake(name) {
  const dir = join(TAKES, name);
  if (!existsSync(join(dir, 'frames.json'))) return null;
  const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'))
    .map((f) => ({ ...f, path: resolve(dir, 'frames', f.file) }))
    .sort((a, b) => a.t - b.t);
  const marks = Object.fromEntries(JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8')).map((m) => [m.name, m.t]));
  const trace = JSON.parse(readFileSync(join(dir, 'trace.json'), 'utf8'));
  return { name, dir, frames, marks, trace };
}
const page = loadPageTake('page');
const fail = loadAppTake('fail');
const tryTake = loadAppTake('try');
if (!page || !fail || !tryTake) throw new Error('the film needs the fail, page and try takes');
const markAt = (take, name) => take.marks.find((m) => m.text === name)?.t;

// --- Pictures ----------------------------------------------------------------------------------------
const font = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const css = `@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${font}) format('truetype'); }
* { margin: 0; box-sizing: border-box; }
body { background: transparent; font-family: 'Segoe UI', system-ui, sans-serif; }
.band { width: ${W}px; height: ${BAND}px; display: flex; align-items: center; justify-content: center; padding: 0 140px; background: linear-gradient(rgba(15, 16, 32, 0), rgba(15, 16, 32, 0.9) 28%, rgba(15, 16, 32, 0.96)); }
.band div { color: #fff4dc; font: 50px/1.08 Bebas; letter-spacing: 1.5px; text-align: center; text-shadow: 0 2px 10px rgba(0, 0, 0, 0.6); }
.band b { color: #ffcf3f; font-weight: 400; }
.label { display: inline-block; padding: 11px 20px 8px; border-radius: 999px; background: rgba(15, 16, 32, 0.82); color: #fff4dc; font: 32px/1 Bebas; letter-spacing: 2px; white-space: nowrap; }
.label i { font-style: normal; color: #ffcf3f; }
.badge { display: inline-block; padding: 12px 22px 8px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 36px/1 Bebas; letter-spacing: 2px; }
.card { width: ${W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; background: radial-gradient(circle at 50% 40%, #24264a 0%, #0f1020 64%); color: #fff4dc; text-align: center; }
.sticker-shadow { background: #ffcf3f; border-radius: 30px; padding: 0 12px 12px 0; }
.sticker { background: #1c1d36; border: 6px solid #ffcf3f; border-radius: 30px; padding: 22px 44px 10px; font: 130px/1 Bebas; color: #ffcf3f; letter-spacing: 4px; }
.title { font: 84px/1.02 Bebas; letter-spacing: 3px; max-width: 1600px; }
.title b { color: #ffcf3f; font-weight: 400; }
.sub { font: 600 30px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.72); max-width: 1500px; }
.chips { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; align-items: center; max-width: 1760px; }
.chip { padding: 12px 22px 8px; border-radius: 999px; border: 3px solid rgba(255, 244, 220, 0.3); font: 34px/1 Bebas; letter-spacing: 2px; color: rgba(255, 244, 220, 0.85); }
.chip.on { border-color: #3de0b8; color: #3de0b8; }
.arrow { font: 34px/1 Bebas; color: rgba(255, 244, 220, 0.45); }
table { border-collapse: collapse; font: 600 34px/1.2 'Segoe UI', sans-serif; }
th { font: 40px/1 Bebas; letter-spacing: 2px; color: rgba(255, 244, 220, 0.6); font-weight: 400; padding: 0 34px 18px; text-align: center; }
th:first-child { text-align: left; padding-left: 0; }
td { padding: 16px 34px; border-top: 2px solid rgba(255, 244, 220, 0.14); text-align: center; }
td:first-child { text-align: left; padding-left: 0; color: rgba(255, 244, 220, 0.85); }
td.best { color: #3de0b8; }
td.none { color: #ff6f91; }
.url { font: 84px/1 Bebas; letter-spacing: 3px; color: #3de0b8; }
.gh { display: inline-block; padding: 16px 30px 10px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 44px/1 Bebas; letter-spacing: 2px; }
.small { font: 600 24px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.58); max-width: 1500px; }`;
const browser = await chromium.launch({ headless: true });
const shot = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
let pictures = 0;
async function picture(html, width, height) {
  const name = `p${pictures++}.png`;
  await shot.setViewportSize({ width, height });
  await shot.setContent(`<!doctype html><html lang="en"><head><style>${css}</style></head><body>${html}</body></html>`);
  await shot.evaluate(() => document.fonts.ready);
  await shot.screenshot({ path: join(work, name), omitBackground: true, clip: { x: 0, y: 0, width, height } });
  return name;
}
/** Captions are HTML (b for the yellow words). */
const captionPicture = (html) => picture(`<div class="band"><div>${html}</div></div>`, W, BAND);
const labelPicture = (html) => picture(`<div style="padding:4px"><span class="label">${html}</span></div>`, 1400, 70);
const badgePicture = (text) => picture(`<div style="padding:4px"><span class="badge">${esc(text)}</span></div>`, 480, 74);
const still = (file, dur) => ['-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', join(work, file)];

/** Caption and label overlays over [first]; returns the filter parts, the last stream and the next input. */
async function overlays(inputs, first, n, dur, { caps = [], label = null, badge = null }) {
  const filter = [];
  let last = first;
  for (const [k, c] of caps.entries()) {
    const ca = Math.max(0, c.at);
    const cb = Math.min(dur, caps[k + 1]?.at ?? dur);
    if (cb - ca < 0.5) continue;
    inputs.push(...still(await captionPicture(c.html), dur));
    const fadeIn = ca < 0.1 ? '' : `fade=t=in:st=${ca.toFixed(3)}:d=0.25:alpha=1,`;
    filter.push(`[${n}:v]format=rgba,${fadeIn}fade=t=out:st=${Math.max(ca + 0.3, cb - 0.25).toFixed(3)}:d=0.25:alpha=1[c${n}]`);
    filter.push(`[${last}][c${n}]overlay=0:${H - BAND}:enable='between(t,${ca.toFixed(3)},${cb.toFixed(3)})'[k${n}]`);
    last = `k${n}`;
    n++;
  }
  if (label) {
    inputs.push(...still(await labelPicture(label), dur));
    filter.push(`[${last}][${n}:v]overlay=28:28[l${n}]`);
    last = `l${n}`;
    n++;
  }
  if (badge) {
    inputs.push(...still(await badgePicture(badge), dur));
    filter.push(`[${last}][${n}:v]overlay=W-w-24:26[b${n}]`);
    last = `b${n}`;
    n++;
  }
  return { filter, last, n };
}

/** Hard links (or copies) of the newest frame at each output frame's source time. */
function sequence(frames, times, folder) {
  const seq = join(work, folder);
  mkdirSync(seq, { recursive: true });
  let i = 0;
  times.forEach((s, n) => {
    while (i + 1 < frames.length && frames[i + 1].t <= s) i++;
    const to = join(seq, `${String(n).padStart(6, '0')}.jpg`);
    try {
      linkSync(frames[i].path, to);
    } catch {
      copyFileSync(frames[i].path, to);
    }
  });
  return join(seq, '%06d.jpg');
}

// --- A page take's part: zoomed onto the card in focus, its own captions -----------------------------
const fitAspect = (take, f) => {
  const fw = take.view.width * take.scale;
  const fh = take.view.height * take.scale;
  const MAX_ZOOM = 2.6;
  let w = f.w * take.scale;
  let h = (f.h * take.scale) / (1 - BAND / H);
  if (w / h < W / H) w = h * (W / H);
  else h = w / (W / H);
  w = Math.min(fw, Math.max(w, fw / MAX_ZOOM));
  h = Math.min(fh, Math.max(h, fh / MAX_ZOOM));
  const cx = f.x * take.scale + (f.w * take.scale) / 2;
  const x = Math.min(Math.max(0, cx - w / 2), fw - w);
  const y = Math.min(Math.max(0, f.y * take.scale - h * 0.02), fh - h);
  return { z: fw / w, x, y };
};
const CAPTIONS = {
  // The page take's own captions, reworded for this film (the rest stay as recorded).
  '1,024 robots at once on the GPU, 1,000 rounds of practice': `${ENVS} ducks at once on the GPU, <b>${ROUNDS} more rounds</b> of climbing practice`,
};
async function pagePart(take, a, b, name, { label = null, lead = null, clock = false, speed: mult = 1 } = {}) {
  // The take's own speed marks, times this part's speed: what the badges say is how fast it plays.
  const speedAt = (s) => {
    let v = 1;
    for (const g of take.segments) if (g.t <= s) v = g.speed;
    return v * mult;
  };
  const lapseAt = (s) => {
    let lapse = false;
    for (const g of take.segments) if (g.t <= s) lapse = g.lapse;
    return lapse;
  };
  const source = [];
  for (let s = a; s < b; s += speedAt(s) / FPS) source.push(s);
  const dur = source.length / FPS;
  const at = (s) => {
    let i = source.findIndex((x) => x >= s);
    if (i < 0) i = s < a ? 0 : source.length - 1;
    return i / FPS;
  };
  const seq = sequence(take.frames, source, `${name}-seq`);
  const ramp = Math.round(0.7 * FPS);
  const before = take.focus.filter((f) => f.t <= a);
  const list = [...(before.length ? [before[before.length - 1]] : take.focus.slice(0, 1)), ...take.focus.filter((f) => f.t > a && f.t < b)];
  const keys = list.map((f, k) => ({ frame: k === 0 ? 0 : Math.round(at(f.t) * FPS), ...fitAspect(take, f) }));
  const piecewise = (field) => {
    let expr = `${keys[keys.length - 1][field].toFixed(3)}`;
    for (let k = keys.length - 1; k >= 1; k--) {
      const p = keys[k - 1];
      const q = keys[k];
      const u = `((in-${q.frame})/${ramp})`;
      expr = `if(lt(in,${q.frame}),${p[field].toFixed(3)},if(lt(in,${q.frame + ramp}),${p[field].toFixed(3)}+(${(q[field] - p[field]).toFixed(3)})*${u}*${u}*(3-2*${u}),${expr}))`;
    }
    return expr;
  };
  const fw = take.view.width * take.scale;
  const fh = take.view.height * take.scale;
  const zoom = `zoompan=z='${piecewise('z')}':x='${piecewise('x')}':y='${piecewise('y')}':d=1:s=${W}x${H}:fps=${FPS}`;
  const prior = take.captions.filter((c) => c.t <= a);
  const caps = [...(lead ? [{ t: a, text: lead }] : prior.length ? [{ ...prior[prior.length - 1], t: a }] : []), ...take.captions.filter((c) => c.t > a && c.t < b)].map((c, k) => ({
    at: at(c.t) + (k === 0 ? 0 : 0.05),
    html: CAPTIONS[c.text] ?? esc(c.text),
  }));
  const inputs = ['-reinit_filter', '0', '-framerate', String(FPS), '-i', seq];
  const filter = [`[0:v]scale=${fw}:${fh}:flags=lanczos,setsar=1,${zoom},setsar=1[v0]`];
  const o = await overlays(inputs, 'v0', 1, dur, { caps, label });
  filter.push(...o.filter);
  let last = o.last;
  let n = o.n;
  // Badges: runs of output frames at one speed (TIME-LAPSE for the time-lapse), 0.6 s or longer.
  const badgeOf = (s) => {
    if (lapseAt(s)) return 'TIME-LAPSE';
    const v = speedAt(s);
    if (v < 1.15) return null;
    return `${v >= 3 ? Math.round(v) : Math.round(v * 10) / 10}x FASTER`;
  };
  const runs = [];
  source.forEach((s, k) => {
    const text = badgeOf(s);
    const last = runs[runs.length - 1];
    if (last && last.text === text) last.n1 = k + 1;
    else runs.push({ text, n0: k, n1: k + 1 });
  });
  for (const r of runs.filter((x) => x.text && (x.n1 - x.n0) / FPS >= 0.6)) {
    inputs.push(...still(await badgePicture(r.text), dur));
    filter.push(`[${last}][${n}:v]overlay=W-w-24:26:enable='between(t,${(r.n0 / FPS).toFixed(3)},${(r.n1 / FPS).toFixed(3)})'[b${n}]`);
    last = `b${n}`;
    n++;
  }
  for (const g of take.segments.filter((s) => s.lapse && s.until > a && s.t < b)) {
    const ga = at(Math.max(g.t, a));
    const gb = at(Math.min(g.until, b));
    if (gb - ga < 0.6) continue;
    const trainAt = markAt(take, '!train');
    if (clock && g.lapse && trainAt) {
      // The training clock under the badge: minutes of training at this frame.
      const E = `(${(Math.max(g.t, a) - trainAt).toFixed(2)}+(t-${ga.toFixed(3)})*${(g.speed * mult).toFixed(3)})`;
      const text = `%{eif\\:floor(${E}/60)\\:d} MIN`;
      const fnt = "fontfile='public/fonts/BebasNeue-Regular.ttf'";
      filter.push(`[${last}]drawtext=${fnt}:text='${text}':fontsize=88:fontcolor=0xfff4dc:borderw=4:bordercolor=0x0f1020:x=w-tw-40:y=112:enable='between(t,${ga.toFixed(3)},${gb.toFixed(3)})'[t${n}]`);
      filter.push(`[t${n}]drawtext=${fnt}:text='OF TRAINING':fontsize=34:fontcolor=0xffcf3f:borderw=3:bordercolor=0x0f1020:x=w-tw-42:y=204:enable='between(t,${ga.toFixed(3)},${gb.toFixed(3)})'[u${n}]`);
      last = `u${n}`;
    }
  }
  const file = join(work, `${name}.mp4`);
  run([...inputs, '-filter_complex', filter.join(';'), '-map', `[${last}]`, '-t', dur.toFixed(3), ...encode, file]);
  console.log(`${name}: ${dur.toFixed(1)} s from ${((b - a) / 60).toFixed(1)} min of ${take.name}`);
  return { file, dur };
}

// --- An app take's part: the frames at a steady speed, captions at source times ------------------------
async function appPart(take, a, b, name, speed, caps, label, crop = null) {
  const times = [];
  for (let s = a; s < b; s += speed / FPS) times.push(s);
  const dur = times.length / FPS;
  const seq = sequence(take.frames, times, `${name}-seq`);
  const inputs = ['-framerate', String(FPS), '-start_number', '0', '-i', seq];
  const filter = [`[0:v]${crop ? `crop=${crop},` : ''}scale=${W}:${H},setsar=1[v0]`];
  const o = await overlays(inputs, 'v0', 1, dur, {
    caps: caps.map((c) => ({ at: Math.max(0, (c.t - a) / speed), html: c.html })),
    label,
    badge: speed > 1.05 ? `${speed}x SPEED` : null,
  });
  filter.push(...o.filter);
  const file = join(work, `${name}.mp4`);
  run([...inputs, '-filter_complex', filter.join(';'), '-map', `[${o.last}]`, '-t', dur.toFixed(3), ...encode, file]);
  console.log(`${name}: ${dur.toFixed(1)} s (${speed}x) of ${take.name}`);
  return { file, dur };
}

// --- mjlab's own training video: a clip of one file --------------------------------------------------
async function clipPart(file, from, dur, name, caps, label) {
  const inputs = ['-ss', from.toFixed(3), '-t', dur.toFixed(3), '-i', file];
  const filter = [`[0:v]fps=${FPS},scale=${W}:${H},setsar=1[v0]`];
  const o = await overlays(inputs, 'v0', 1, dur, { caps, label });
  filter.push(...o.filter);
  const out = join(work, `${name}.mp4`);
  run([...inputs, '-filter_complex', filter.join(';'), '-map', `[${o.last}]`, '-t', dur.toFixed(3), ...encode, out]);
  console.log(`${name}: ${dur.toFixed(1)} s of ${file}`);
  return { file: out, dur };
}

async function card(name, html, dur, from, to) {
  const png = await picture(html, W, H);
  const out = join(work, `${name}.mp4`);
  const n = Math.round(dur * FPS);
  run([
    '-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', join(work, png),
    '-filter_complex', `[0:v]scale=${W * 2}:${H * 2},zoompan=z='${from}+${(to - from).toFixed(3)}*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},fade=t=in:st=0:d=0.3,format=yuv420p[v]`,
    '-map', '[v]', '-t', dur.toFixed(3), ...encode, out,
  ]);
  return { file: out, dur };
}

// --- What the run made: its videos, the release, the step test ------------------------------------------
const videos = RUN && existsSync(join(RUN, 'videos', 'train'))
  ? readdirSync(join(RUN, 'videos', 'train'))
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ file: join(RUN, 'videos', 'train', f), step: Number(/step-(\d+)/.exec(f)?.[1] ?? 0) }))
      .sort((p, q) => p.step - q.step)
  : [];
const STEPS_PER_ROUND = 24;
const incoming = 'public/policies/incoming';
const release = (existsSync(incoming) ? readdirSync(incoming) : [])
  .filter((d) => existsSync(join(incoming, d, 'manifest.json')))
  .map((d) => JSON.parse(readFileSync(join(incoming, d, 'manifest.json'), 'utf8')))
  .filter((r) => r.name === NAME)
  .sort((p, q) => String(q.createdAt).localeCompare(String(p.createdAt)))[0];
const bench = existsSync(BENCH) ? JSON.parse(readFileSync(BENCH, 'utf8')) : null;

// --- The cut ---------------------------------------------------------------------------------------------
const parts = [];
const hits = [];
const sections = [];
let clock = 0;
const add = (p, section, hit) => {
  if (!p) return;
  if (section && (!sections.length || sections[sections.length - 1].key !== section)) sections.push({ key: section, t0: clock });
  if (hit) hits.push({ t: clock + (hit.at ?? 0.1), kind: hit.kind, len: hit.len });
  parts.push(p);
  clock += p.dur;
};
const APP = 'IN THE APP <i>&middot;</i> MIXED REALITY, EMULATED IN IWER';
const PAGE = 'DUCK LAB XR TRAINER <i>&middot;</i> IN THE BROWSER, ON THE PC';

add(
  await card(
    'intro',
    `<div class="card">
      <div class="title">TEACHING PIP TO CLIMB:<br><b>THE WHOLE LOOP, FOR REAL</b></div>
      <div class="chips"><span class="chip on">A FALL IN THE APP</span><span class="arrow">&rarr;</span><span class="chip">TEST CASE</span><span class="arrow">&rarr;</span><span class="chip on">${ENVS} DUCKS TRAIN</span><span class="arrow">&rarr;</span><span class="chip">CROSS-CHECK</span><span class="arrow">&rarr;</span><span class="chip on">NEW BRAIN IN THE APP</span></div>
      <div class="sub">Every shot is a real take: the app, the trainer page and the training run on one RTX 3070.</div>
    </div>`,
    4.2,
    1.0,
    1.03,
  ),
  'gap',
  { kind: 'arrive', at: 0.3 },
);

// The fall, and the test case.
const failPacked = fail.marks.packed ?? fail.marks['course-end'];
const says = fail.trace.find((s) => s.packs > 0)?.says ?? '';
const seconds = /(\d+) s test case/.exec(says)?.[1];
const failFrom = fail.marks.course + 0.5;
const FAIL_SPEED = 2;
// The score's fall sound on each fall (the trace counts them, five times a second).
for (let i = 1; i < fail.trace.length; i++) {
  if (fail.trace[i].falls > fail.trace[i - 1].falls && fail.trace[i].t > failFrom) hits.push({ t: clock + (fail.trace[i].t - failFrom) / FAIL_SPEED, kind: 'fall' });
}
add(
  await appPart(fail, failFrom, Math.min(fail.marks['course-end'], failPacked + 3), 'fail', FAIL_SPEED, [
    { t: fail.marks.course + 0.5, html: 'A 2 CM PLAY MAT ON THE LIVING ROOM FLOOR: <b>THE SHIPPED BRAIN TRIPS ON ITS EDGE</b>' },
    { t: failPacked - 0.3, html: `TWO FALLS: THE APP SAVES THE MOMENT${seconds ? ` (${seconds} S)` : ''} AS A TEST CASE <b>AND SENDS IT TO THE PC</b>` },
  ], APP),
  'wear',
  { kind: 'quack', at: 0.4 },
);

// The trainer page: inbox, picker, Train, the first rounds.
const t0 = Math.max(page.frames[0].t, page.captions[0].t - 1.0);
const lapseAt = markAt(page, '!lapse');
const liveAt = markAt(page, '!live');
const trainAt = markAt(page, '!train');
add(await pagePart(page, t0, lapseAt, 'page-1', { label: PAGE, speed: 1.7 }), 'wear', trainAt ? { kind: 'try', at: 2 } : null);

// mjlab's training video, early in the run.
const roundOf = (v) => Math.round(v.step / STEPS_PER_ROUND);
// Round 0's clip starts as the episodes do, every duck still on its spawn square: the next one shows them climbing.
const early = videos.find((v) => v.step > 0) ?? videos[0];
const late = videos.length > 2 ? videos[videos.length - 1] : null;
if (early) {
  add(
    await clipPart(early.file, 0.6, CROWD_S, 'crowd-1', [
      { at: 0, html: `REAL TRAINING FRAMES: <b>128 OF THE ${ENVS} DUCKS</b>, EACH IN ITS OWN WORLD (THEY WALK THROUGH EACH OTHER)` },
      { at: CROWD_S / 2, html: 'TERRACES FROM 1.5 TO 4 CM: <b>A DUCK GOES UP A ROW WHEN IT CLIMBS THREE STEPS WITHOUT A FALL</b>' },
    ], `MJLAB'S OWN RENDERER <i>&middot;</i> THIS RUN, ROUND ${roundOf(early)} <i>&middot;</i> REAL TIME`),
    'real',
    { kind: 'train', len: CROWD_S },
  );
}
add(await pagePart(page, lapseAt, liveAt, 'lapse', { label: PAGE, clock: true }), 'real', { kind: 'brain' });
if (late) {
  add(
    await clipPart(late.file, 0.6, CROWD_S - 2, 'crowd-2', [{ at: 0, html: `ROUND ${roundOf(late)} OF ${ROUNDS}: <b>THE SAME CROWD, HIGHER UP THE TERRACES</b>` }], `MJLAB'S OWN RENDERER <i>&middot;</i> THIS RUN, ROUND ${roundOf(late)} <i>&middot;</i> REAL TIME`),
    'real',
  );
}
// Export, cross-check, release, Send to headset.
add(await pagePart(page, liveAt, page.end, 'page-2', { label: PAGE, speed: 1.4 }), 'deploy', { kind: 'brain' });

// The app: the offer, TRY IT, the same course.
const pressed = tryTake.marks.pressed;
add(
  await appPart(tryTake, tryTake.marks.offer, pressed + 1.5, 'offer', 1, [
    { t: tryTake.marks.offer, html: `BACK IN THE APP: <b>NEW BRAIN READY</b> ON PIP CAM (${esc(release?.name ?? NAME)})` },
    { t: pressed - 0.8, html: 'TRY IT, WITH THE CONTROLLER: <b>THE NEW BRAIN LOADS WHILE PIP STANDS THERE</b>' },
  ], APP, '1440:810:200:150'),
  'deploy',
  { kind: 'try', at: Math.max(0.2, pressed - tryTake.marks.offer) },
);
add(
  await appPart(tryTake, tryTake.marks['offer-end'] - 2.4, tryTake.marks['offer-end'], 'loaded', 1, [
    { t: tryTake.marks['offer-end'] - 2.4, html: `A FEW SECONDS LATER: <b>BRAIN: ${esc((release?.name ?? NAME).toUpperCase())}</b>, WITH A REVERT BUTTON` },
  ], APP, '1600:900:120:180'),
  'deploy',
  { kind: 'success', at: 0.2 },
);
const tryEnd = tryTake.marks['course-end'];
const climbFrom = tryTake.marks.course + 0.4;
const run6 = tryTake.trace.filter((s) => s.t >= tryTake.marks.course);
const z0 = run6[0].at[2];
const onMat = run6.find((s) => s.at[0] > 0.5 && s.at[0] < 1.0 && s.at[2] - z0 > 0.015)?.t;
const atBed = run6.find((s) => s.at[0] > 1.3)?.t;
const fellAt = run6.find((s, i) => i > 0 && s.falls > run6[i - 1].falls)?.t;
const climbStart = clock;
if (onMat) hits.push({ t: climbStart + (onMat - climbFrom) / 1.5, kind: 'success' });
if (fellAt) hits.push({ t: climbStart + (fellAt - climbFrom) / 1.5, kind: 'fall' });
add(
  await appPart(tryTake, climbFrom, tryEnd, 'climb', 1.5, [
    { t: climbFrom, html: 'THE SAME COURSE ON THE NEW BRAIN: <b>UP THE 2 CM MAT ON THE FIRST TRY</b>' },
    ...(atBed ? [{ t: atBed - 0.6, html: fellAt ? "THE 3 CM DOG BED: <b>IT TRIPS AND FALLS ONTO IT.</b> NOT THERE YET" : 'THE 3 CM DOG BED: <b>UP</b>' }] : []),
  ], APP),
  'catch',
);

// The step test.
if (bench) {
  const brains = [...new Set(bench.table.map((r) => r.brain))];
  const heights = [...new Set(bench.table.map((r) => r.heightCm))];
  const NAMES = JSON.parse(process.env.BENCH_NAMES ?? '{}');
  const cell = (brain, h) => {
    const r = bench.table.find((x) => x.brain === brain && x.heightCm === h);
    const best = Math.max(...brains.map((b) => bench.table.find((x) => x.brain === b && x.heightCm === h)?.up ?? 0));
    return `<td class="${r.up === 0 ? 'none' : r.up === best ? 'best' : ''}">${r.up} / ${r.seeds}</td>`;
  };
  add(
    await card(
      'bench',
      `<div class="card">
        <div class="title">HOW HIGH A STEP: <b>UP, OUT OF ${bench.table[0].seeds} TRIES</b></div>
        <table>
          <tr><th>Step</th>${brains.map((b) => `<th>${esc(NAMES[b] ?? b)}</th>`).join('')}</tr>
          ${heights.map((h) => `<tr><td>${h} cm</td>${brains.map((b) => cell(b, h)).join('')}</tr>`).join('')}
        </table>
        <div class="small">Our MuJoCo with Pollen's randomisation: a box step across the path, a steady ${bench.speed} m/s forward walk, a new seed each try.<br>A climbing skill: it walks forward only, and the shipped brain still turns better.</div>
      </div>`,
      7,
      1.02,
      1.0,
    ),
    'catch',
    { kind: 'card' },
  );
}
const upOf = (brain, h) => bench?.table.find((r) => r.brain === brain && r.heightCm === h);
const NEW = process.env.BENCH_NEW ?? 'artifacts/brains/stepup6';
const OLD = process.env.BENCH_OLD ?? 'artifacts/brains/stepup4';
for (const [h, file, from] of [
  [2, join(TAKES, 'film-2cm.mp4'), 2.5],
  [3, join(TAKES, 'film-3cm.mp4'), 2.5],
]) {
  if (!existsSync(file)) continue;
  const n = upOf(NEW, h);
  const shipped = upOf('shipped', h);
  const old = upOf(OLD, h);
  const tally = n ? `UP ${n.up} TIMES IN ${n.seeds} ON THE STEP TEST (SHIPPED: ${shipped?.up ?? 0}${old ? `, RUN 4: ${old.up}` : ''})` : '';
  add(
    await clipPart(file, from, Number(process.env.FILM_S ?? 6), `film-${h}`, [
      { at: 0, html: h === 2 ? `THE NEW BRAIN ON 2 CM TERRACES, 32 DUCKS: <b>${tally}</b>` : `3 CM, A DOG BED'S EDGE: <b>${tally}.</b> NOT THERE YET` },
    ], "MJLAB'S OWN RENDERER <i>&middot;</i> THE NEW BRAIN <i>&middot;</i> REAL TIME"),
    'real',
    { kind: 'arrive' },
  );
}
add(
  await card(
    'end',
    `<div class="card">
      <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
      <div class="title" style="font-size:64px">THE APP FINDS THE HARD MOMENT. <b>THE GPU PRACTISES IT.</b></div>
      <div class="url">duck.bruna.world</div>
      <div class="gh">OPEN SOURCE ON GITHUB</div>
      <div class="small">github.com/Bruna-Worlds/duck-lab-xr<br><br>microduck_rl, mjlab, the Microduck model and walking AI (c) Pollen Robotics and their authors (models CC BY-NC-SA 4.0). Duck Lab XR is not made or endorsed by Pollen Robotics. Music: original, made for this film.<br>(c) 2026 BRUNA GOODS LLC. All rights reserved.</div>
    </div>`,
    5,
    1.0,
    1.035,
  ),
  'end',
  { kind: 'card' },
);
await browser.close();

// --- The whole, and its score ---------------------------------------------------------------------------
writeFileSync(join(work, 'parts.txt'), parts.map((p) => `file '${resolve(p.file).replace(/\\/g, '/')}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', join(work, 'parts.txt'), '-c', 'copy', join(work, 'video.mp4')]);
const DUR = clock;
sections.forEach((s, i) => (s.t1 = sections[i + 1]?.t0 ?? DUR));
writeFileSync(join(work, 'cut.json'), JSON.stringify({ dur: DUR, sections, hits }, null, 1));
execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
mkdirSync(resolve(OUTFILE, '..'), { recursive: true });
run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUTFILE]);
console.log(`CLIMB FILM ${OUTFILE} (${DUR.toFixed(1)} s)`);
