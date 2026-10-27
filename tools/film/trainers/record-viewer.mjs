// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A trainer's own viewer, filmed: starts a command that serves a viser page
 * (Isaac Lab's `--viz viser` while it trains, mjlab's `play --viewer viser`
 * with a checkpoint), waits for the page, films it for SECONDS in a browser of
 * its own (1440 x 810, drawn at 2x), then stops the command (the whole tree).
 * Writes frames/, frames.json, marks.txt (CAPTION at the start) and focus.json
 * (the whole page) like record-trainers.mjs, for compose-trainers.mjs.
 *
 *   node tools/film/trainers/record-viewer.mjs <dir> <cwd> <program> [args...]
 *   node tools/film/trainers/record-viewer.mjs <dir> - -      (a viewer already up: a trainer page's job)
 *
 * Env: URL (http://localhost:8080), SECONDS (24), CAPTION, WARM (s to wait once
 * the page is up, for the scene to load and the training to get going: 20),
 * SETUP (JavaScript run in the page before filming, to tidy it), and any env
 * the command needs (PYTHONUTF8 for Isaac Lab on a GBK console). ZOOM (wheel steps,
 * negative: closer) moves the view in slowly while it films.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [dir, cwd, program, ...args] = process.argv.slice(2);
const URL = process.env.URL ?? 'http://localhost:8080';
const SECONDS = Number(process.env.SECONDS ?? 24);
const WARM = Number(process.env.WARM ?? 20);
const VIEW = { width: 1440, height: 810 };
const SCALE = 2;
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/frames`, { recursive: true });
const now = () => Date.now() / 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// '-': film a viewer something else started (a trainer page's job), and leave it running.
const child = program && program !== '-' ? spawn(program, args, { cwd, env: { ...process.env }, shell: process.platform === 'win32' }) : null;
let out = '';
const take = (d) => {
  out += d;
  if (out.length > 200000) out = out.slice(-100000);
};
child?.stdout.on('data', take);
child?.stderr.on('data', take);
const stop = () =>
  !child ? null : process.platform === 'win32' && child.pid ? spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill();

const frames = [];
const marks = [];
let count = 0;
let browser;
try {
  // The viewer's page comes up once the scene is built (the first run compiles GPU code first).
  const up = Date.now();
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`${program} ended before its viewer came up:\n${out.slice(-2000)}`);
    const ok = await fetch(URL)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    if (Date.now() - up > 900000) throw new Error('no viewer after 15 minutes');
    await wait(2000);
  }
  console.log(`viewer up after ${((Date.now() - up) / 1000).toFixed(0)} s`);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', `--force-device-scale-factor=${SCALE}`] });
  const context = await browser.newContext({ viewport: VIEW });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await wait(WARM * 1000);
  if (process.env.SETUP) await page.evaluate(process.env.SETUP).catch((err) => console.log(`setup: ${err.message}`));
  // The film's camera, by hand as a person would: ORBIT "dx,dy" drags the view round its target,
  // WHEEL scrolls (negative: closer), both over the middle of the scene.
  const cx = VIEW.width * 0.36;
  const cy = VIEW.height * 0.5;
  await page.mouse.move(cx, cy);
  if (process.env.ORBIT) {
    const [dx, dy] = process.env.ORBIT.split(',').map(Number);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + dy, { steps: 30 });
    await page.mouse.up();
  }
  for (let left = Number(process.env.WHEEL ?? 0); Math.abs(left) > 0; ) {
    const step = Math.sign(left) * Math.min(Math.abs(left), 100);
    await page.mouse.wheel(0, step);
    left -= step;
    await wait(60);
  }
  await page.mouse.move(VIEW.width - 6, VIEW.height - 6);
  await wait(1500);
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const file = `f${String(count++).padStart(6, '0')}.jpg`;
    writeFileSync(`${dir}/frames/${file}`, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 2 });
  marks.push(`${now().toFixed(3)} ${process.env.CAPTION ?? 'The trainer, in its own viewer'}`);
  // A slow move in while it films (ZOOM wheel steps over the take), or a still view.
  const zoomTotal = Number(process.env.ZOOM ?? 0);
  const ticks = Math.max(1, Math.round(SECONDS * 4));
  for (let i = 0; i < ticks; i++) {
    if (zoomTotal) {
      await page.mouse.move(VIEW.width * 0.36, VIEW.height * 0.5);
      await page.mouse.wheel(0, zoomTotal / ticks);
      await page.mouse.move(VIEW.width - 6, VIEW.height - 6);
    }
    await wait(250);
  }
  marks.push(`${now().toFixed(3)} !end`);
  await cdp.send('Page.stopScreencast');
} finally {
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
  writeFileSync(`${dir}/marks.txt`, `${marks.join('\n')}\n`);
  writeFileSync(`${dir}/focus.json`, JSON.stringify({ view: VIEW, scale: SCALE, focus: [{ t: 0, x: 0, y: 0, w: VIEW.width, h: VIEW.height }] }));
  writeFileSync(`${dir}/command.log`, out);
  await browser?.close();
  stop();
}
console.log(`REC ${count} frames -> ${dir}`);
