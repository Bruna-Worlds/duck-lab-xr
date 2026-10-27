// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The parts the loop films are cut from (1920 x 1080, 30 fps): takes of the
 * trainer page and of trainers' own viewers (record-trainers.mjs,
 * record-viewer.mjs: frames, marks.txt, focus.json), app takes
 * (record-climb.mjs, record-avoid.mjs: frames, marks.json, trace.json), clips
 * of video files, and cards; captions in a band below, a label top left, a
 * speed badge top right; then the whole joined and scored
 * (tools/film/trailer/music.mjs). Used by tools/film/climb/compose-climb.mjs
 * and tools/film/avoid/compose-avoid.mjs.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { findFfmpeg } from './ffmpeg.mjs';

export const FPS = 30;
export const W = 1920;
export const H = 1080;
export const BAND = 150;
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
export const APP = 'IN THE APP <i>&middot;</i> MIXED REALITY, EMULATED IN IWER';
export const PAGE = 'DUCK LAB XR TRAINER <i>&middot;</i> IN THE BROWSER, ON THE PC';

const css = (font) => `@font-face { font-family: Bebas; src: url(data:font/ttf;base64,${font}) format('truetype'); }
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
.small { font: 600 24px/1.4 'Segoe UI', sans-serif; color: rgba(255, 244, 220, 0.58); max-width: 1500px; }
.pics { display: flex; gap: 18px; justify-content: center; }
.pics img { width: 384px; height: 216px; image-rendering: pixelated; border-radius: 10px; border: 3px solid rgba(255, 244, 220, 0.2); }`;

/**
 * A film's kit: `takes` (the takes' folder), `work` (scratch, emptied), `captions` (a page take's
 * captions reworded: recorded text -> HTML), `lapseFilm` (seconds a time-lapse plays in).
 */
export async function composeKit({ takes, work = join(takes, 'compose'), captions = {}, lapseFilm = 8 }) {
  const FFMPEG = findFfmpeg();
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const run = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  const encode = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS)];

  // --- Takes ----------------------------------------------------------------------------------------
  /** A page or viewer take: frames, marks.txt, focus.json. */
  function loadPageTake(name) {
    const dir = join(takes, name);
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
      const speed = kind === 'ff' ? Number(arg) || 1 : kind === 'fit' ? Math.max(1, (next - m.t) / Number(arg)) : kind === 'lapse' ? Math.max(1, (next - m.t) / lapseFilm) : 1;
      return { t: m.t, until: next, speed, lapse: kind === 'lapse' };
    });
    return { name, dir, frames, view, scale, focus, marks, end, segments, captions: marks.filter((m) => !m.text.startsWith('!')) };
  }
  /** An app take: frames, marks.json, trace.json (and feed/ + feed.json when it filmed Pip cam). */
  function loadAppTake(name) {
    const dir = join(takes, name);
    if (!existsSync(join(dir, 'frames.json'))) return null;
    const frames = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'))
      .map((f) => ({ ...f, path: resolve(dir, 'frames', f.file) }))
      .sort((a, b) => a.t - b.t);
    const marks = Object.fromEntries(JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8')).map((m) => [m.name, m.t]));
    const trace = JSON.parse(readFileSync(join(dir, 'trace.json'), 'utf8'));
    const feed = existsSync(join(dir, 'feed.json'))
      ? JSON.parse(readFileSync(join(dir, 'feed.json'), 'utf8'))
          .map((f) => ({ ...f, path: resolve(dir, 'feed', f.file) }))
          .sort((a, b) => a.t - b.t)
      : [];
    return { name, dir, frames, marks, trace, feed };
  }
  const markAt = (take, name) => take.marks.find((m) => m.text === name)?.t;

  // --- Pictures ----------------------------------------------------------------------------------------
  const style = css(readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64'));
  const browser = await chromium.launch({ headless: true });
  const shot = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  let pictures = 0;
  async function picture(html, width, height) {
    const name = `p${pictures++}.png`;
    await shot.setViewportSize({ width, height });
    await shot.setContent(`<!doctype html><html lang="en"><head><style>${style}</style></head><body>${html}</body></html>`);
    await shot.evaluate(() => document.fonts.ready);
    await shot.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r))))));
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
    // `lead` is HTML (b for the yellow words); the take's own captions are text.
    const caps = [...(lead ? [{ t: a, html: lead }] : prior.length ? [{ ...prior[prior.length - 1], t: a }] : []), ...take.captions.filter((c) => c.t > a && c.t < b)].map((c, k) => ({
      at: at(c.t) + (k === 0 ? 0 : 0.05),
      html: c.html ?? captions[c.text] ?? esc(c.text),
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
      const prev = runs[runs.length - 1];
      if (prev && prev.text === text) prev.n1 = k + 1;
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
  /**
   * `inset`: { feed, x, y, w, h } draws the take's Pip cam feed (feed/, at the same source times) over the
   * picture at that place and size.
   */
  async function appPart(take, a, b, name, speed, caps, label, crop = null, inset = null) {
    const times = [];
    for (let s = a; s < b; s += speed / FPS) times.push(s);
    const dur = times.length / FPS;
    const seq = sequence(take.frames, times, `${name}-seq`);
    const inputs = ['-framerate', String(FPS), '-start_number', '0', '-i', seq];
    const filter = [`[0:v]${crop ? `crop=${crop},` : ''}scale=${W}:${H},setsar=1[v0]`];
    let first = 'v0';
    let n = 1;
    if (inset && take.feed.length) {
      const feedSeq = sequence(take.feed, times, `${name}-feed`);
      inputs.push('-framerate', String(FPS), '-start_number', '0', '-i', feedSeq);
      filter.push(`[1:v]${inset.crop ? `crop=${inset.crop},` : ''}scale=${inset.w}:${inset.h}:flags=neighbor,setsar=1[f1]`);
      filter.push(`[v0][f1]overlay=${inset.x}:${inset.y}[i1]`);
      first = 'i1';
      n = 2;
    }
    const o = await overlays(inputs, first, n, dur, {
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

  // --- A clip of one video file -------------------------------------------------------------------------
  async function clipPart(file, from, dur, name, caps, label, { speed = 1, crop = null } = {}) {
    const inputs = ['-ss', from.toFixed(3), '-t', (dur * speed).toFixed(3), '-i', file];
    const filter = [`[0:v]${crop ? `crop=${crop},` : ''}${speed !== 1 ? `setpts=PTS/${speed},` : ''}fps=${FPS},scale=${W}:${H},setsar=1[v0]`];
    const o = await overlays(inputs, 'v0', 1, dur, { caps, label, badge: speed > 1.05 ? `${speed}x SPEED` : null });
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

  // --- The cut, and its score ------------------------------------------------------------------------------
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
  const now = () => clock;
  const hit = (t, kind, len) => hits.push({ t, kind, len });

  /** Joins the parts, writes the score to the cut and puts them together in `outfile`. */
  async function finish(outfile) {
    await browser.close();
    writeFileSync(join(work, 'parts.txt'), parts.map((p) => `file '${resolve(p.file).replace(/\\/g, '/')}'`).join('\n'));
    run(['-f', 'concat', '-safe', '0', '-i', join(work, 'parts.txt'), '-c', 'copy', join(work, 'video.mp4')]);
    const dur = clock;
    sections.forEach((s, i) => (s.t1 = sections[i + 1]?.t0 ?? dur));
    writeFileSync(join(work, 'cut.json'), JSON.stringify({ dur, sections, hits }, null, 1));
    execFileSync(process.execPath, ['tools/film/trailer/music.mjs', join(work, 'cut.json'), join(work, 'music.wav')], { stdio: 'inherit' });
    mkdirSync(resolve(outfile, '..'), { recursive: true });
    run(['-i', join(work, 'video.mp4'), '-i', join(work, 'music.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outfile]);
    return dur;
  }

  return { run, encode, work, loadPageTake, loadAppTake, markAt, picture, overlays, sequence, pagePart, appPart, clipPart, card, add, now, hit, finish };
}
