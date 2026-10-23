// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainer half of the stacked (phone) film: films Duck Lab XR's trainer
 * page from the website (https://localhost:8081/trainer/, so it pairs with the
 * emulated headset over WebRTC for real) in a browser of its own, and plays
 * its part of the story as things arrive over the link:
 *   - shows the pairing code (code.txt, for the driver) and waits for the headset;
 *   - waits for the test case the headset sends, shows it arriving;
 *   - replays a known falls test case with the shipped brain (it falls);
 *   - trains on it for a short while (filmed fast), stops;
 *   - sends the brain trained earlier on these test cases (LAB_SHOWN) to the
 *     headset (offered.txt), and waits for the driver's done.txt.
 * Frames carry wall-clock times (Date.now seconds) like the headset recorder,
 * so the composer lines both halves up. Also writes marks.txt (captions and
 * "!ff N" speed changes, wall clock) and focus.json (which card to zoom on, in
 * page pixels, over time).
 *
 *   node tools/film/stack/record-trainer.mjs <dir>
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const dir = process.argv[2] ?? 'artifacts/video/stack/trainer';
const SITE = process.env.SITE ?? 'https://localhost:8081/';
const FALLS = process.env.LAB_FALLS ?? '2026-10-22T07-53-10-falls';
const SHOWN = process.env.LAB_SHOWN ?? 'room-tuned';
const VIEW = { width: 1440, height: 1120 };
const SCALE = 1.5;
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/frames`, { recursive: true });

const now = () => Date.now() / 1000;
const marks = [];
const mark = (text) => {
  marks.push(`${now().toFixed(3)} ${text}`);
  console.log(`MARK ${text}`);
};
const focus = [];
const frames = [];
let count = 0;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, ignoreHTTPSErrors: true });
const page = await context.newPage();

/** Zoom the film onto the card holding `selector` (padding in page px), or the whole page. */
async function zoom(selector, pad = 14) {
  const rect = selector
    ? await page.evaluate(
        ([sel, p]) => {
          const el = document.querySelector(sel);
          const card = el?.closest('.card') ?? el;
          if (!card) return null;
          const r = card.getBoundingClientRect();
          return { x: r.left - p, y: r.top - p, w: r.width + 2 * p, h: r.height + 2 * p };
        },
        [selector, pad],
      )
    : null;
  focus.push({ t: now(), ...(rect ?? { x: 0, y: 0, w: VIEW.width, h: VIEW.height }) });
}

async function replay(button, label) {
  await page.click(button);
  await page.waitForFunction((l) => new RegExp(l).test(document.getElementById('replay-result').textContent), label, { timeout: 90000 });
}

async function show3dFrom(at) {
  await page.click('#tab-3d');
  await page.waitForTimeout(600);
  await page.evaluate((from) => {
    const scrub = document.getElementById('scrub');
    const total = Number(/\/\s*([\d.]+)/.exec(document.getElementById('clock').textContent)?.[1] ?? 0);
    if (!total) return;
    scrub.value = String(Math.round((1000 * Math.max(0, from)) / total));
    scrub.dispatchEvent(new Event('input'));
    scrub.dispatchEvent(new Event('change'));
    document.getElementById('play').click();
  }, at);
}

const waitFile = async (name, seconds) => {
  for (let i = 0; i < seconds * 4; i++) {
    if (existsSync(`${dir}/../${name}`)) return true;
    await page.waitForTimeout(250);
  }
  return false;
};

try {
  await page.goto(`${SITE}trainer/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('pair-code')?.textContent ?? ''), null, { timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('chip-inbox')?.className.includes('on'), null, { timeout: 30000 });
  // A repainting pixel keeps screencast frames coming while the page is still.
  await page.addStyleTag({
    content: '@keyframes duckFilmPulse { from { opacity: 0.98; } to { opacity: 1; } } body::after { content: ""; position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; background: #0f1020; animation: duckFilmPulse 0.1s infinite alternate; }',
  });
  const code = (await page.textContent('#pair-code')).replace(' ', '');
  writeFileSync(`${dir}/../code.txt`, code);
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const file = `f${String(count++).padStart(6, '0')}.jpg`;
    writeFileSync(`${dir}/frames/${file}`, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 86, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE, everyNthFrame: 1 });
  await zoom(null);
  // The headset pairs (the driver types this page's code into it).
  await page.waitForFunction(() => document.getElementById('chip-headset')?.className.includes('on'), null, { timeout: 120000 });
  await zoom('.pair-card', 18);
  writeFileSync(`${dir}/../paired.txt`, String(now()));

  // The headset's test case arrives over the link.
  const before = await page.locator('.pack[data-id]').count();
  await page.waitForFunction((n) => document.querySelectorAll('.pack[data-id]').length > n, before, { timeout: 180000 });
  await zoom('#packs', 12);
  mark('On the computer a moment later, over your Wi-Fi');
  await page.waitForTimeout(2600);
  await page.locator('.pack[data-id]').first().click();
  await page.waitForTimeout(2600);

  // A known falls test case, replayed with the shipped brain.
  const falls = page.locator(`.pack[data-id="${FALLS}"]`);
  await falls.scrollIntoViewIfNeeded();
  await falls.click();
  await zoom('#map', 12);
  mark('Replay a hard one in MuJoCo: the shipped brain falls here');
  await page.waitForTimeout(1500);
  mark('!ff 4');
  await replay('#replay-ship', 'Shipped');
  mark('!ff 1');
  const fellAt = await page.evaluate(() => Number(/fell after ([\d.]+) s/.exec(document.getElementById('replay-result').textContent)?.[1] ?? 6));
  await show3dFrom(fellAt - 3.0);
  await page.waitForTimeout(5200);

  // Train for a short while on camera.
  await page.click('#tab-map');
  await page.fill('#t-name', 'film-quick');
  await page.fill('#t-iterations', '30');
  await page.fill('#t-pairs', '12');
  await page.fill('#t-steps', '600');
  await page.setChecked('#t-publish', false);
  await page.locator(`.pack[data-id="${FALLS}"] input[data-check]`).check();
  await zoom('#chart', 12);
  mark('Train on your computer: copies of the brain practise that moment');
  await page.waitForTimeout(1200);
  await page.click('#train');
  await page.waitForTimeout(1500);
  mark('!ff 6');
  const started = Date.now();
  while (Date.now() - started < 22000) {
    const it = Number(/iteration (\d+)/.exec((await page.textContent('#chip-trainer')) ?? '')?.[1] ?? 0);
    if (it >= 3) break;
    await page.waitForTimeout(500);
  }
  await page.click('#stop');
  await page.waitForFunction(() => /Stopped at|Better:|No improvement|failed/i.test(document.getElementById('train-log').textContent), null, { timeout: 60000 }).catch(() => {});
  mark('!ff 1');

  // The brain trained earlier on these test cases goes to the headset.
  const card = page.locator('.release', { hasText: SHOWN }).first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await zoom('#releases', 12);
  const numbers = /falls (\d+%) to (\d+%)/.exec((await card.textContent()) ?? '');
  mark(numbers ? `A brain trained on these moments: falls ${numbers[1]} to ${numbers[2]}. Send it to the headset` : 'Send the brain trained on these moments to the headset');
  await page.waitForTimeout(2600);
  const send = card.locator('[data-activate]');
  if (await send.count()) await send.click();
  writeFileSync(`${dir}/../offered.txt`, String(now()));
  await page.waitForTimeout(1500);
  await page.locator('.pair-card').scrollIntoViewIfNeeded();
  await zoom('.pair-card', 18);
  await waitFile('done.txt', 120);
  await page.waitForTimeout(1500);
  await cdp.send('Page.stopScreencast');
} finally {
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
  writeFileSync(`${dir}/marks.txt`, `${marks.join('\n')}\n`);
  writeFileSync(`${dir}/focus.json`, JSON.stringify({ view: VIEW, scale: SCALE, focus }));
  await browser.close();
}
console.log(`REC ${count} frames -> ${dir}`);
