// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainers film (1920 x 1080, 30 fps): the whole flow with an outside
 * trainer, cut from the takes in one folder (each recorded with
 * record-trainers.mjs or record-viewer.mjs: frames, marks, focus):
 *   take/           the trainer page, from the packs to the release (required)
 *   isaaclab/       Isaac Lab 3 training MicroDuck, in its own viewer (cut in when the picker shows it)
 *   pollen-viewer/  Pollen's viewer playing the new brain (after the time-lapse)
 *   isaacsim/       the trainer page running the new brain in Isaac Sim (after the cross-check)
 * plus real Quest footage at the start (QUEST, artifacts/video/quest-headset.mp4),
 * an opening card, the cross-check's numbers on a card (read from the release
 * the run made), an end card, and a score written to this cut
 * (tools/film/trailer/music.mjs). Each take zooms onto the card that matters
 * (focus.json), with its captions in a band below.
 *
 *   node tools/film/trainers/compose-trainers.mjs [takes dir] [out.mp4]
 *
 * With FILM_LANG=zh, the same film with Chinese words (../lang.mjs).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from '../ffmpeg.mjs';
import { filmCss, HTML_LANG, LANG_SUFFIX, speedLabel, tr } from '../lang.mjs';

const TAKES = process.argv[2] ?? 'artifacts/video/trainers';
const OUTFILE = process.argv[3] ?? join(TAKES, `duck-lab-trainers${LANG_SUFFIX}.mp4`);
const QUEST = process.env.QUEST ?? 'artifacts/video/quest-headset.mp4';
const NAME = process.env.NAME ?? 'pollen-ppo-3000';
const FFMPEG = findFfmpeg();
const FPS = 30;
const W = 1920;
const H = 1080;
const BAND = 150; // the caption band, over the bottom of the picture
const LAPSE_FILM = Number(process.env.LAPSE_FILM ?? 14); // seconds the hours of training take
const VIEWER_SECONDS = Number(process.env.VIEWER_SECONDS ?? 7); // a trainer's own viewer, cut in
const POLLEN_SECONDS = Number(process.env.POLLEN_SECONDS ?? VIEWER_SECONDS + 1); // Pollen's viewer: long enough for a shove and its outcome
const INTRO = 3.4;
const RESULT = 6.5;
const END = 4.4;
const work = join(TAKES, `compose${LANG_SUFFIX}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// --- Takes ----------------------------------------------------------------------------------------
function loadTake(name) {
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
  // Speed segments: "!ff N" (N times faster), "!fit N" (fit up to the next speed mark into N s), "!lapse" (into LAPSE_FILM).
  const speedMarks = marks.filter((m) => /^!(ff|fit|lapse|live)/.test(m.text));
  const segments = speedMarks.map((m, i) => {
    const next = speedMarks[i + 1]?.t ?? end;
    const [kind, arg] = m.text.slice(1).split(' ');
    const speed = kind === 'ff' ? Number(arg) || 1 : kind === 'fit' ? Math.max(1, (next - m.t) / Number(arg)) : kind === 'lapse' ? Math.max(1, (next - m.t) / LAPSE_FILM) : 1;
    return { t: m.t, until: next, speed, lapse: kind === 'lapse' };
  });
  return { name, dir, frames, view, scale, focus, marks, end, segments, captions: marks.filter((m) => !m.text.startsWith('!')) };
}
const main = loadTake('take');
if (!main) throw new Error(`no trainer take in ${join(TAKES, 'take')} (record-trainers.mjs)`);
const isaacLab = loadTake('isaaclab');
const pollenViewer = loadTake('pollen-viewer');
const isaacSim = loadTake('isaacsim');
// A pickup of the release card (record-release.mjs), in place of the main take's end from its "!release" mark.
const releaseTake = loadTake('release');
const markAt = (take, name) => take.marks.find((m) => m.text === name)?.t;

// --- Pictures: captions, labels, badges, cards -------------------------------------------------------
const font = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const css = filmCss(`@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${font}) format('truetype'); }
* { margin: 0; box-sizing: border-box; }
body { background: transparent; font-family: 'Segoe UI', system-ui, sans-serif; }
.band { width: ${W}px; height: ${BAND}px; display: flex; align-items: center; justify-content: center; padding: 0 140px; background: linear-gradient(rgba(15, 16, 32, 0), rgba(15, 16, 32, 0.9) 28%, rgba(15, 16, 32, 0.96)); }
.band div { color: #fff4dc; font: 50px/1.08 Bebas; letter-spacing: 1.5px; text-align: center; text-shadow: 0 2px 10px rgba(0, 0, 0, 0.6); }
.label { display: inline-block; padding: 11px 20px 8px; border-radius: 999px; background: rgba(15, 16, 32, 0.82); color: #fff4dc; font: 32px/1 Bebas; letter-spacing: 2px; white-space: nowrap; }
.label i { font-style: normal; color: #ffcf3f; }
.badge { display: inline-block; padding: 12px 22px 8px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 36px/1 Bebas; letter-spacing: 2px; }
.card { width: ${W}px; height: ${H}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; background: radial-gradient(circle at 50% 40%, #24264a 0%, #0f1020 64%); color: #fff4dc; text-align: center; }
.sticker-shadow { background: #ffcf3f; border-radius: 30px; padding: 0 12px 12px 0; }
.sticker { background: #1c1d36; border: 6px solid #ffcf3f; border-radius: 30px; padding: 22px 44px 10px; font: 130px/1 Bebas; color: #ffcf3f; letter-spacing: 4px; }
.title { font: 84px/1.02 Bebas; letter-spacing: 3px; max-width: 1500px; }
.title b { color: #ffcf3f; font-weight: 400; }
.sub { font: 600 30px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.72); max-width: 1400px; }
.chips { display: flex; gap: 18px; flex-wrap: wrap; justify-content: center; max-width: 1600px; }
.chip { padding: 12px 24px 8px; border-radius: 999px; border: 3px solid rgba(255, 244, 220, 0.3); font: 34px/1 Bebas; letter-spacing: 2px; color: rgba(255, 244, 220, 0.8); }
.chip.on { border-color: #3de0b8; color: #3de0b8; }
table { border-collapse: collapse; font: 600 34px/1.2 'Segoe UI', sans-serif; }
th { font: 40px/1 Bebas; letter-spacing: 2px; color: rgba(255, 244, 220, 0.6); font-weight: 400; padding: 0 34px 18px; text-align: center; }
th:first-child { text-align: left; padding-left: 0; }
td { padding: 18px 34px; border-top: 2px solid rgba(255, 244, 220, 0.14); text-align: center; }
td:first-child { text-align: left; padding-left: 0; color: rgba(255, 244, 220, 0.85); }
td .m { display: block; font-size: 24px; color: rgba(255, 244, 220, 0.55); margin-top: 6px; font-weight: 600; }
td.up { color: #3de0b8; }
td.fell { color: #ff6f91; }
.url { font: 84px/1 Bebas; letter-spacing: 3px; color: #3de0b8; }
.gh { display: inline-block; padding: 16px 30px 10px; border-radius: 999px; background: #ffcf3f; color: #0f1020; font: 44px/1 Bebas; letter-spacing: 2px; }
.small { font: 600 24px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.58); max-width: 1500px; }`);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
let pictures = 0;
/** An overlay picture (transparent around it), its file name. */
async function picture(html, width, height) {
  const name = `p${pictures++}.png`;
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html lang="${HTML_LANG}"><head><style>${css}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(work, name), omitBackground: true, clip: { x: 0, y: 0, width, height } });
  return name;
}
const captionPicture = (text) => picture(`<div class="band"><div>${esc(tr(text))}</div></div>`, W, BAND);
const labelPicture = async (text) => {
  // Sized to the label: rendered wide, then trimmed by ffmpeg's overlay to what it covers.
  return picture(`<div style="padding:4px"><span class="label">${text}</span></div>`, 1200, 70);
};

// --- A part of a take, zoomed and captioned -------------------------------------------------------------
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

/**
 * The film of `take` from source time a to b: returns { file, dur, at(s) } where at() gives a source
 * time's place in this part. `label` puts a chip at the top left for the whole part.
 */
async function part(take, a, b, name, { label = null, lead = null } = {}) {
  const speedAt = (s) => {
    let v = 1;
    for (const g of take.segments) if (g.t <= s) v = g.speed;
    return v;
  };
  const source = [];
  for (let s = a; s < b; s += speedAt(s) / FPS) source.push(s);
  const dur = source.length / FPS;
  const at = (s) => {
    let i = source.findIndex((x) => x >= s);
    if (i < 0) i = s < a ? 0 : source.length - 1;
    return i / FPS;
  };
  const seq = join(work, `${name}-seq`);
  mkdirSync(seq, { recursive: true });
  let i = 0;
  source.forEach((s, n) => {
    while (i + 1 < take.frames.length && take.frames[i + 1].t <= s) i++;
    const to = join(seq, `${String(n).padStart(6, '0')}.jpg`);
    try {
      linkSync(take.frames[i].path, to);
    } catch {
      copyFileSync(take.frames[i].path, to);
    }
  });
  // Zoom keys: the focus in force at a, then each change, eased (smoothstep) over 0.7 s.
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
  // Captions: the one in force at a (from the start), then those inside.
  const prior = take.captions.filter((c) => c.t <= a);
  const caps = [...(lead ? [{ t: a, text: lead }] : prior.length ? [{ ...prior[prior.length - 1], t: a }] : []), ...take.captions.filter((c) => c.t > a && c.t < b)];
  const inputs = ['-reinit_filter', '0', '-framerate', String(FPS), '-i', join(seq, '%06d.jpg')];
  const still = (file) => ['-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', join(work, file)];
  const filter = [`[0:v]scale=${fw}:${fh}:flags=lanczos,setsar=1,${zoom},setsar=1[v0]`];
  let last = 'v0';
  let n = 1;
  for (const [k, c] of caps.entries()) {
    const ca = Math.max(0, at(c.t) + (k === 0 ? 0 : 0.05));
    const next = caps[k + 1];
    const cb = Math.min(dur, next ? at(next.t) : dur);
    if (cb - ca < 0.5) continue;
    inputs.push(...still(await captionPicture(c.text)));
    const fadeIn = ca < 0.1 ? '' : `fade=t=in:st=${ca.toFixed(3)}:d=0.25:alpha=1,`;
    filter.push(`[${n}:v]format=rgba,${fadeIn}fade=t=out:st=${Math.max(ca + 0.3, cb - 0.25).toFixed(3)}:d=0.25:alpha=1[c${n}]`);
    filter.push(`[${last}][c${n}]overlay=0:${H - BAND}:enable='between(t,${ca.toFixed(3)},${cb.toFixed(3)})'[k${n}]`);
    last = `k${n}`;
    n++;
  }
  if (label) {
    inputs.push(...still(await labelPicture(label)));
    filter.push(`[${last}][${n}:v]overlay=28:28[l${n}]`);
    last = `l${n}`;
    n++;
  }
  for (const g of take.segments.filter((s) => s.speed > 1.5 && s.until > a && s.t < b)) {
    const ga = at(Math.max(g.t, a));
    const gb = at(Math.min(g.until, b));
    if (gb - ga < 0.6) continue;
    inputs.push(...still(await picture(`<div style="padding:4px"><span class="badge">${esc(g.lapse ? tr('TIME-LAPSE') : speedLabel(Math.round(g.speed)))}</span></div>`, 480, 74)));
    filter.push(`[${n}:v]crop=iw:ih:0:0[g${n}]`, `[${last}][g${n}]overlay=W-w-24:26:enable='between(t,${ga.toFixed(3)},${gb.toFixed(3)})'[b${n}]`);
    last = `b${n}`;
    n++;
    const trainAt = markAt(take, '!train');
    if (g.lapse && trainAt) {
      // The training clock under the badge: hours of training at this frame.
      const E = `(${(Math.max(g.t, a) - trainAt).toFixed(2)}+(t-${ga.toFixed(3)})*${g.speed.toFixed(3)})`;
      const text = `%{eif\\:floor(${E}/3600)\\:d}\\:%{eif\\:floor(${E}/60)-60*floor(${E}/3600)\\:d\\:2}`;
      const font = "fontfile='public/fonts/BebasNeue-Regular.ttf'";
      filter.push(`[${last}]drawtext=${font}:text='${text}':fontsize=88:fontcolor=0xfff4dc:borderw=4:bordercolor=0x0f1020:x=w-tw-40:y=112:enable='between(t,${ga.toFixed(3)},${gb.toFixed(3)})'[t${n}]`);
      filter.push(`[t${n}]drawtext=${font}:text='${tr('HOURS OF TRAINING').replace(/'/g, '')}':fontsize=34:fontcolor=0xffcf3f:borderw=3:bordercolor=0x0f1020:x=w-tw-42:y=204:enable='between(t,${ga.toFixed(3)},${gb.toFixed(3)})'[u${n}]`);
      last = `u${n}`;
    }
  }
  const file = join(work, `${name}.mp4`);
  run([...inputs, '-filter_complex', filter.join(';'), '-map', `[${last}]`, '-t', dur.toFixed(3), ...encode, file]);
  console.log(`${name}: ${dur.toFixed(1)} s from ${((b - a) / 60).toFixed(1)} min of ${take.name}`);
  return { file, dur, at };
}

// --- The run's numbers: the release it made, and its cross-check -------------------------------------------
const incoming = 'public/policies/incoming';
const releases = existsSync(incoming)
  ? readdirSync(incoming)
      .filter((d) => existsSync(join(incoming, d, 'manifest.json')))
      .map((d) => JSON.parse(readFileSync(join(incoming, d, 'manifest.json'), 'utf8')))
  : [];
const release = releases.filter((r) => r.name === NAME && r.crossCheck).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
const ENGINES = { mujoco: 'MuJoCo, as on the headset', pollen: 'MuJoCo, randomised', newton: 'Newton (MuJoCo-Warp)' };
const rows = release
  ? Object.keys(ENGINES)
      .map((e) => ({ e, a: release.crossCheck.table.find((r) => r.engine === e && r.brain === 'shipped'), b: release.crossCheck.table.find((r) => r.engine === e && r.brain === release.id) }))
      .filter((r) => r.a && r.b)
  : [];
const better = rows.filter((r) => r.b.falls < r.a.falls - 1e-9).length;
const worse = rows.filter((r) => r.b.falls > r.a.falls + 1e-9).length;
const verdict = !rows.length
  ? 'Cross-check: no numbers in the take'
  : worse === 0 && better > 0
    ? 'Falls less than the shipped brain'
    : better === 0 && worse > 0
      ? 'Not yet as sure-footed as the shipped brain'
      : better === 0 && worse === 0
        ? 'As sure-footed as the shipped brain'
        : 'Better in some engines, not yet in all';
console.log(`release ${release?.id ?? '(none)'}: ${verdict}`);

// --- Cards ---------------------------------------------------------------------------------------------------
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
const cell = (r, engine) => `<td class="${r.falls > (engine === 'pollen' ? 0.25 : 0) ? 'fell' : 'up'}">${Math.round(r.falls * 100)}% ${tr('fell')}<span class="m">${r.walkedM.toFixed(2)} m</span></td>`;

// --- The real headset at the start: Quest 3 footage, the room and Pip -------------------------------------------
async function questPart() {
  if (!existsSync(QUEST)) return null;
  const from = Number(process.env.QUEST_FROM ?? 3);
  const dur = Number(process.env.QUEST_DUR ?? 6.5);
  const cap = await captionPicture('On the headset, Pip walks your real room: every fall or stuck moment can be saved as a scenario pack');
  const lab = await labelPicture(`${esc(tr('SHOT ON META QUEST 3'))} <i>&middot;</i> ${esc(tr('MIXED REALITY'))}`);
  const out = join(work, 'quest.mp4');
  // The square headset view, filling the width: its middle band (the room, Pip and the course).
  run([
    '-ss', String(from), '-t', dur.toFixed(3), '-i', QUEST,
    '-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', join(work, cap),
    '-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(3), '-i', join(work, lab),
    '-filter_complex',
    // (Its own caption, burned in at the bottom of the square, stays below the crop.)
    `[0:v]fps=${FPS},scale=${W}:${W},crop=${W}:${H}:0:${Math.round(W * Number(process.env.QUEST_Y ?? 0.33))},setsar=1[v];[1:v]format=rgba,fade=t=in:st=0.2:d=0.25:alpha=1[c];[v][c]overlay=0:${H - BAND}[k];[k][2:v]overlay=28:28,format=yuv420p[o]`,
    '-map', '[o]', '-t', dur.toFixed(3), ...encode, out,
  ]);
  return { file: out, dur };
}

// --- The cut ---------------------------------------------------------------------------------------------------------
const parts = [];
const hits = [];
const sections = [];
let clock = 0;
const add = (p, section, hit) => {
  if (!p) return null;
  if (section && (!sections.length || sections[sections.length - 1].key !== section)) sections.push({ key: section, t0: clock });
  if (hit) hits.push({ t: clock + (hit.at ?? 0.1), kind: hit.kind, len: hit.len });
  parts.push(p);
  const start = clock;
  clock += p.dur;
  return start;
};
add(
  await card(
    'intro',
    `<div class="card">
      <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
      <div class="title">${tr('From the hard moments in your room')}<br><b>${tr('to a new brain, trained on your PC')}</b></div>
      <div class="chips"><span class="chip">${tr('Duck Lab fine-tune')}</span><span class="chip">NVIDIA Isaac Lab 3</span><span class="chip on">Pollen microduck_rl</span><span class="chip">${tr('your own trainer')}</span></div>
    </div>`,
    INTRO,
    1.0,
    1.03,
  ),
  'gap',
  { kind: 'arrive', at: 0.3 },
);
add(await questPart(), 'wear');
const t0 = Math.max(main.frames[0].t, main.captions[0].t - 1.2);
const isaacLabAt = markAt(main, '!isaaclab');
const pickedAt = markAt(main, '!picked');
const trainAt = markAt(main, '!train');
const lapseAt = markAt(main, '!lapse');
const liveAt = markAt(main, '!live');
const LABEL_PAGE = `${esc(tr('DUCK LAB XR TRAINER'))} <i>&middot;</i> ${esc(tr('IN THE BROWSER'))}`;
if (isaacLab && isaacLabAt && pickedAt) {
  // The picker shows Isaac Lab: cut to Isaac Lab itself, back for the pick.
  add(await part(main, t0, isaacLabAt + 1.0, 'page-1', { label: LABEL_PAGE }), 'wear');
  const from = isaacLab.captions[0]?.t ?? isaacLab.frames[0].t;
  add(await part(isaacLab, from, Math.min(isaacLab.end, from + VIEWER_SECONDS), 'isaaclab', { label: `NVIDIA ISAAC LAB 3 <i>&middot;</i> ${esc(tr('ITS OWN VIEWER'))}` }), 'wear', { kind: 'arrive' });
  add(await part(main, pickedAt - 0.6, lapseAt ?? main.end, 'page-2', { label: LABEL_PAGE }), 'wear', trainAt ? { kind: 'try', at: 0.6 + (trainAt - pickedAt) } : null);
} else add(await part(main, t0, lapseAt ?? main.end, 'page-1', { label: LABEL_PAGE }), 'wear');
if (lapseAt && liveAt) {
  add(await part(main, lapseAt, liveAt, 'lapse', { label: LABEL_PAGE }), 'real', { kind: 'train', len: LAPSE_FILM });
  if (pollenViewer) {
    const from = pollenViewer.captions[0]?.t ?? pollenViewer.frames[0].t;
    add(
      await part(pollenViewer, from, Math.min(pollenViewer.end, from + POLLEN_SECONDS), 'pollen-viewer', { label: `POLLEN microduck_rl <i>&middot;</i> ${esc(tr('ITS OWN VIEWER'))}` }),
      'real',
      { kind: 'brain' },
    );
  }
  const releaseAt = releaseTake ? markAt(main, '!release') : null;
  add(await part(main, liveAt, releaseAt ?? main.end, 'page-3', { label: LABEL_PAGE }), 'deploy', { kind: 'brain' });
  if (releaseAt) add(await part(releaseTake, releaseTake.captions[0]?.t ?? releaseTake.frames[0].t, releaseTake.end, 'release', { label: LABEL_PAGE }), 'deploy');
}
if (isaacSim) add(await part(isaacSim, isaacSim.captions[0]?.t ?? isaacSim.frames[0].t, isaacSim.end, 'isaacsim', { label: `NVIDIA ISAAC SIM 4.5 <i>&middot;</i> ${esc(tr('PHYSX, RTX, STREAMED TO THE PAGE'))}` }), 'deploy', { kind: 'arrive' });
add(
  await card(
    'result',
    `<div class="card">
      <div class="title"><b>${tr(verdict)}</b></div>
      <div class="sub">${tr('Falls on the same packs, before it can go to the headset')}</div>
      <table>
        <tr><th>${tr('Physics engine')}</th><th>${tr('Shipped brain')}</th><th>${esc(release?.name ?? NAME)}</th></tr>
        ${rows.map((r) => `<tr><td>${tr(ENGINES[r.e])}</td>${cell(r.a, r.e)}${cell(r.b, r.e)}</tr>`).join('')}
      </table>
      <div class="small">${esc(tr(`${release?.crossCheck?.packs?.length ?? 6} packs from the headset; randomised MuJoCo runs each pack with several seeds of the training randomisation.`))}</div>
    </div>`,
    RESULT,
    1.03,
    1.0,
  ),
  'deploy',
  { kind: rows.length && worse === 0 && better > 0 ? 'success' : 'card' },
);
add(
  await card(
    'end',
    `<div class="card">
      <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
      <div class="title">${tr('Connect any trainer')}</div>
      <div class="url">duck.bruna.world</div>
      <div class="gh">${tr('OPEN SOURCE ON GITHUB')}</div>
      <div class="small">github.com/Bruna-Worlds/duck-lab-xr<br><br>${tr(
        "microduck_rl, the Microduck model and walking AI (c) Pollen Robotics (models CC BY-NC-SA 4.0). Isaac Lab, Isaac Sim, Newton and Warp are NVIDIA's; NVIDIA and Isaac Sim are trademarks of NVIDIA Corporation. Duck Lab XR is not made or endorsed by Pollen Robotics or NVIDIA. Music: original, made for this film.",
      )}<br>${tr('(c) 2026 BRUNA GOODS LLC. All rights reserved.')}</div>
    </div>`,
    END,
    1.0,
    1.035,
  ),
  'end',
  { kind: 'card' },
);
await browser.close();

// --- The whole, and its score ------------------------------------------------------------------------------------------
writeFileSync(join(work, 'parts.txt'), parts.map((p) => `file '${resolve(p.file).replace(/\\/g, '/')}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', join(work, 'parts.txt'), '-c', 'copy', join(work, 'video.mp4')]);
const DUR = clock;
sections.forEach((s, i) => (s.t1 = sections[i + 1]?.t0 ?? DUR));
writeFileSync(join(work, 'cut.json'), JSON.stringify({ dur: DUR, sections, hits }, null, 1));
execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
mkdirSync(resolve(OUTFILE, '..'), { recursive: true });
run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUTFILE]);
console.log(`TRAINERS FILM ${OUTFILE} (${DUR.toFixed(1)} s)`);
