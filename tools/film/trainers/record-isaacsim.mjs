// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainers film's Isaac Sim take: on the trainer page, a pack run in Isaac
 * Sim with a trained brain (PhysX Pip beside an orange ghost replaying MuJoCo's
 * run of it), the stream in the page. Like record-trainers.mjs: frames,
 * marks.txt, focus.json, for compose-trainers.mjs.
 *
 *   node tools/film/trainers/record-isaacsim.mjs [dir]
 *
 * Needs the trainer page (LAB) and Isaac Sim with the Duck Lab bridge
 * (tools/isaac/start-isaac-sim.ps1). Env: NAME (the release to run:
 * pollen-ppo-3000), PACK (2026-10-22T07-53-10-falls).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const dir = process.argv[2] ?? 'artifacts/video/trainers/isaacsim';
const LAB = process.env.LAB ?? 'http://127.0.0.1:8790';
const NAME = process.env.NAME ?? 'pollen-ppo-3000';
const PACK = process.env.PACK ?? '2026-10-22T07-53-10-falls';
const VIEW = { width: 1440, height: 810 };
const SCALE = 2;
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/frames`, { recursive: true });
const now = () => Date.now() / 1000;
const marks = [];
const mark = (text) => {
  marks.push(`${now().toFixed(3)} ${text}`);
  console.log(`${new Date().toISOString().slice(11, 19)} MARK ${text}`);
};
const focus = [];
const frames = [];
let count = 0;

const state = await (await fetch(`${LAB}/api/state`)).json();
const release = (state.releases.releases ?? []).find((r) => r.name === NAME);
if (!release) throw new Error(`no release named ${NAME}`);
const isaac = await (await fetch(`${LAB}/api/isaac`)).json();
if (!isaac.available) throw new Error(`Isaac Sim is not reachable from the trainer page: ${isaac.error ?? ''}`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', `--force-device-scale-factor=${SCALE}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: VIEW });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const box = (sel, to, pad = 12) =>
  page.evaluate(
    ([a, b, p]) => {
      const r = document.querySelector(a).getBoundingClientRect();
      const s = document.querySelector(b ?? a).getBoundingClientRect();
      const card = document.querySelector(a).closest('.card').getBoundingClientRect();
      const y = Math.max(0, r.top - p);
      return { x: card.left - p, y, w: card.width + 2 * p, h: Math.min(innerHeight, s.bottom + p) - y };
    },
    [sel, to, pad],
  );
const moveTo = async (selector, steps = 22) => {
  const b = await page.locator(selector).first().boundingBox();
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
};
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  const file = `f${String(count++).padStart(6, '0')}.jpg`;
  writeFileSync(`${dir}/frames/${file}`, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
});
try {
  await page.goto(LAB, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.pack[data-id]').length > 0, null, { timeout: 60000 });
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `@keyframes duckFilmPulse { from { opacity: 0.98; } to { opacity: 1; } }
      body::after { content: ""; position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; background: #0f1020; animation: duckFilmPulse 0.1s infinite alternate; }
      #film-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none; }
      .film-ripple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #ffcf3f; z-index: 2147483646; pointer-events: none; animation: filmRipple 0.5s ease-out forwards; }
      @keyframes filmRipple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'film-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.5 15 L18.5 15 Z" fill="#fff4dc" stroke="#0f1020" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    let x = 0;
    let y = 0;
    addEventListener('mousemove', (e) => {
      x = e.clientX;
      y = e.clientY;
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    });
    addEventListener('mousedown', () => {
      const r = document.createElement('div');
      r.className = 'film-ripple';
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 600);
    });
  });
  // The pack, the new brain, "with the trained brain": set before the camera rolls.
  await page.evaluate((id) => {
    const el = document.querySelector(`.pack[data-id="${id}"]`);
    const list = document.getElementById('packs');
    list.scrollTop = el.offsetTop - list.offsetTop - 30;
  }, PACK);
  await page.locator(`.pack[data-id="${PACK}"] .title, .pack[data-id="${PACK}"]`).first().click({ position: { x: 150, y: 14 } });
  await wait(1500);
  await page.selectOption('#replay-release', release.id);
  await page.setChecked('#isaac-trained', true);
  await page.evaluate(() => {
    const card = document.getElementById('isaac-run').closest('.card');
    window.scrollTo(0, card.getBoundingClientRect().top + scrollY - 12);
  });
  await wait(800);
  await page.mouse.move(VIEW.width * 0.5, VIEW.height * 0.5);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 86, everyNthFrame: 2 });
  // The Scene card: the pack's map and the Isaac Sim row.
  focus.push({
    t: now(),
    ...(await page.evaluate(() => {
      const card = document.getElementById('isaac-run').closest('.card').getBoundingClientRect();
      const y = Math.max(0, card.top - 12);
      return { x: card.left - 12, y, w: card.width + 24, h: Math.min(innerHeight, card.bottom + 12) - y };
    })),
  });
  mark(`In NVIDIA Isaac Sim too: the new brain under PhysX, beside MuJoCo's run of the same pack (orange ghost)`);
  await wait(1600);
  await moveTo('#isaac-run');
  await wait(300);
  await page.mouse.down();
  await page.mouse.up();
  await wait(800);
  mark('!fit 5');
  // Built, drawn, running: the stream shows in the card.
  const started = Date.now();
  let running = false;
  while (Date.now() - started < 300000) {
    const s = await (await fetch(`${LAB}/api/isaac`)).json();
    if (s.testcase?.state === 'running' || s.testcase?.state === 'done') {
      running = true;
      break;
    }
    if (s.testcase?.state === 'error') throw new Error(`Isaac Sim: ${s.testcase.error}`);
    await wait(500);
  }
  if (!running) throw new Error('the test case never started');
  await page.mouse.move(VIEW.width - 8, VIEW.height - 8, { steps: 10 });
  await page.evaluate(() => {
    const r = document.getElementById('isaac-result');
    window.scrollTo({ top: r.getBoundingClientRect().top + scrollY - 20, behavior: 'smooth' });
  });
  await wait(700);
  focus.push({ t: now(), ...(await box('#isaac-result', '#isaac-stream', 14)) });
  mark('!fit 12'); // about 30 s of stream with little changing: shown in 12
  // The whole run, then its verdict under the stream.
  for (let i = 0; i < 90; i++) {
    const s = await (await fetch(`${LAB}/api/isaac`)).json();
    if (s.testcase?.state === 'done') break;
    await wait(500);
  }
  await wait(3500);
  mark('!end');
  await cdp.send('Page.stopScreencast');
} finally {
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
  writeFileSync(`${dir}/marks.txt`, `${marks.join('\n')}\n`);
  writeFileSync(`${dir}/focus.json`, JSON.stringify({ view: VIEW, scale: SCALE, focus }));
  await browser.close();
}
console.log(`REC ${count} frames -> ${dir}`);
