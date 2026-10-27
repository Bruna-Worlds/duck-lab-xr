// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A pickup shot for the trainers film: the release card of NAME on the trainer
 * page, the cursor moving to Send to headset. compose-trainers.mjs puts it in
 * place of the main take's end (from its "!release" mark) when the folder
 * exists, for when the page changed after the take. Frames, marks.txt and
 * focus.json like the other takes.
 *
 *   node tools/film/trainers/record-release.mjs [dir]
 *
 * Env: LAB (http://127.0.0.1:8790), NAME (pollen-ppo-3000), CAPTION, CLICK=1 (press Send to headset).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const dir = process.argv[2] ?? 'artifacts/video/trainers/release';
const LAB = process.env.LAB ?? 'http://127.0.0.1:8790';
const NAME = process.env.NAME ?? 'pollen-ppo-3000';
const CAPTION = process.env.CAPTION ?? 'A release, beside the shipped brain: send it to the headset when the numbers say so';
const VIEW = { width: 1440, height: 810 };
const SCALE = 2;
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/frames`, { recursive: true });
const now = () => Date.now() / 1000;
const marks = [];
const focus = [];
const frames = [];
let count = 0;

const state = await (await fetch(`${LAB}/api/state`)).json();
const release = (state.releases.releases ?? []).find((r) => r.name === NAME);
if (!release) throw new Error(`no release named ${NAME}`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', `--force-device-scale-factor=${SCALE}`] });
const context = await browser.newContext({ viewport: VIEW });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  const file = `f${String(count++).padStart(6, '0')}.jpg`;
  writeFileSync(`${dir}/frames/${file}`, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
});
try {
  await page.goto(LAB, { waitUntil: 'load', timeout: 60000 });
  const card = page.locator('.release', { has: page.locator('.name', { hasText: new RegExp(`^${NAME}$`) }) }).first();
  await card.waitFor({ timeout: 60000 });
  // The same cursor as the main take (record-trainers.mjs), and a pulse so the screencast keeps sending frames.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `@keyframes duckFilmPulse { from { opacity: 0.98; } to { opacity: 1; } }
      body::after { content: ""; position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; background: #0f1020; animation: duckFilmPulse 0.1s infinite alternate; }
      #film-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none; }`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'film-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.5 15 L18.5 15 Z" fill="#fff4dc" stroke="#0f1020" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
    addEventListener('mousemove', (e) => {
      cursor.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`;
    });
  });
  // The card a little below the middle, as the main take left it.
  await card.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - innerHeight * 0.45));
  await wait(1200);
  await page.mouse.move(VIEW.width * 0.62, VIEW.height * 0.4);
  const box = await card.boundingBox();
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 86, everyNthFrame: 2 });
  focus.push({ t: now(), x: box.x - 10, y: box.y - 10, w: box.width + 20, h: box.height + 20 });
  marks.push(`${now().toFixed(3)} ${CAPTION}`);
  await wait(1200);
  const send = card.locator('[data-activate]');
  if (await send.count()) {
    const b = await send.boundingBox();
    if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 26 });
    if (process.env.CLICK === '1') {
      // CLICK=1: send it, as the main take did ("!sent").
      await wait(900);
      await page.mouse.down();
      await page.mouse.up();
      marks.push(`${now().toFixed(3)} !sent`);
    }
  }
  await wait(4500);
  marks.push(`${now().toFixed(3)} !end`);
  await cdp.send('Page.stopScreencast');
} finally {
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
  writeFileSync(`${dir}/marks.txt`, `${marks.join('\n')}\n`);
  writeFileSync(`${dir}/focus.json`, JSON.stringify({ view: VIEW, scale: SCALE, focus }));
  await browser.close();
}
console.log(`REC ${count} frames -> ${dir}`);
