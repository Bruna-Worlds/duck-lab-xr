// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Films Duck Lab XR in a browser of its own (headless Chromium from Playwright;
 * the managed IWSDK window is left alone) while it clicks through one part
 * of the end-to-end demo, with captions. Writes artifacts/video/<name>/
 * (frames, frames.json, marks.txt, meta.json) for encode-rec.mjs.
 *
 *   node tools/test/record-lab.mjs <part> <name> [lab url]
 *   parts: train   the headset's new test case arrives; a falls test case is
 *                  replayed with the shipped brain (it falls); training starts
 *                  and runs about 30 s on camera (stopped before it releases
 *                  anything), then the brain a full run on these test cases
 *                  made earlier (LAB_SHOWN, default room-tuned) replays the
 *                  same moment beside the shipped one and is sent to the
 *                  headset. LAB_TRAIN=full instead films a whole run as a
 *                  time-lapse (LAB_LAPSE times faster) and shows its brain
 *                  (named LAB_RELEASE, default living-room).
 *          publish publish that brain to (a stand-in) Hugging Face
 *
 * LAB_FALLS: the falls test case to replay (default: the one from a Quest 3
 * session). LAB_PACKS: more test cases for a full run, comma separated.
 * Captions that start "[n] " also light step n of the flow strip.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [part = 'train', name = `lab-${part}`, url = 'http://localhost:8790/'] = process.argv.slice(2);
const FALLS = process.env.LAB_FALLS ?? '2026-10-22T07-53-10-falls';
const FULL = process.env.LAB_TRAIN === 'full'; // film a whole training run as a time-lapse and show its brain
const RELEASE = process.env.LAB_RELEASE ?? 'living-room'; // the brain a full run makes
const SHOWN = process.env.LAB_SHOWN ?? 'room-tuned'; // otherwise: a brain trained earlier on these test cases
const BRAIN = FULL ? RELEASE : SHOWN; // the brain sent to the headset and published
const MORE_PACKS = (process.env.LAB_PACKS ?? '2026-10-22T07-43-01-stuck,2026-10-22T07-36-31-manual').split(',').filter(Boolean);
const LAPSE = Number(process.env.LAB_LAPSE ?? 15); // training is filmed this many times faster than it runs (LAB_LAPSE)
const dir = `artifacts/video/${name}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/frames`, { recursive: true });
const VIEW = { width: 1600, height: 900 };

// Film time: real time, except during a time-lapse, which runs LAPSE times faster.
let offset = 0;
let lapse = null;
const filmTime = (real) => (lapse ? lapse.film + (real - lapse.real) / lapse.speed : real - offset);
const marks = [];
const mark = (text) => marks.push(`${filmTime(Date.now() / 1000).toFixed(3)} ${text}`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
const page = await context.newPage();
const frames = [];
let count = 0;

async function startLapse() {
  const now = Date.now() / 1000;
  lapse = { speed: LAPSE, real: now, film: now - offset, kept: 0 };
  await page.evaluate((speed) => {
    const chart = document.getElementById('chart');
    chart.insertAdjacentHTML('beforebegin', `<div id="film-lapse" style="font: 22px DuckBebas, sans-serif; letter-spacing: 1px; color: #0f1020; background: #ffcf3f; border-radius: 8px; padding: 4px 10px; margin: 10px 0 6px; display: inline-block;">&#9654;&#9654; TRAINING, SHOWN ${speed}x FASTER</div>`);
  }, LAPSE);
}
async function endLapse() {
  const now = Date.now() / 1000;
  offset = now - filmTime(now);
  lapse = null;
  await page.evaluate(() => document.getElementById('film-lapse')?.remove());
}

/** Replays the selected pack with one brain ('Shipped' or 'Trained') and waits for the result. */
async function replay(button, label) {
  await page.click(button);
  await page.waitForFunction((l) => new RegExp(l).test(document.getElementById('replay-result').textContent), label, { timeout: 60000 });
}

/** The 3D replay, playing from `at` seconds. */
async function show3dFrom(at) {
  await page.click('#tab-3d');
  await page.waitForTimeout(600);
  await page.evaluate((from) => {
    const scrub = document.getElementById('scrub');
    const total = Number(/\/\s*([\d.]+)/.exec(document.getElementById('clock').textContent)?.[1] ?? 0);
    if (!total) return;
    scrub.value = String(Math.round((1000 * Math.max(0, from)) / total));
    scrub.dispatchEvent(new Event('input')); // pauses and seeks
    scrub.dispatchEvent(new Event('change'));
    document.getElementById('play').click(); // and plays from there
  }, at);
}

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('.pack[data-id]', { timeout: 20000 });
  // The screencast only sends repainted frames: a one-pixel pulse keeps them
  // coming, so a still page still films at its real length. The top padding
  // leaves room for the flow strip drawn over the film.
  await page.addStyleTag({
    content:
      '@keyframes duckFilmPulse { from { opacity: 0.98; } to { opacity: 1; } } body::after { content: ""; position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; background: #0f1020; animation: duckFilmPulse 0.1s infinite alternate; } body { padding-top: 58px; }',
  });
  await page.waitForTimeout(800);
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const real = metadata.timestamp;
    if (lapse) {
      if (real - lapse.kept < LAPSE / 30) return; // a time-lapse keeps enough frames for 30 a second of film
      lapse.kept = real;
    }
    const file = `f${String(count++).padStart(6, '0')}.jpg`;
    writeFileSync(`${dir}/frames/${file}`, Buffer.from(data, 'base64'));
    frames.push({ file, t: filmTime(real), w: metadata.deviceWidth, h: metadata.deviceHeight });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 2 });
  await page.waitForTimeout(400);

  if (part === 'train') {
    mark('[2] Duck Lab XR on your PC: the moment you just saved in the headset is already in its inbox');
    const newest = await page.locator('.pack[data-id]').first().getAttribute('data-id');
    await page.locator('.pack[data-id]').first().click();
    await page.waitForTimeout(3800);
    mark('This test case came from a session on a Quest 3: Pip fell twice in a tight turn');
    const falls = page.locator(`.pack[data-id="${FALLS}"]`);
    await falls.scrollIntoViewIfNeeded();
    await falls.click();
    await page.waitForTimeout(3200);
    mark('MuJoCo replays it from that exact moment, with the brain the duck ships with');
    await page.waitForTimeout(1500);
    mark('!ff 4'); // waiting for the replay: little changes on screen
    await replay('#replay-ship', 'Shipped');
    mark('!ff 1');
    const fellAt = await page.evaluate(() => {
      const m = /fell after ([\d.]+) s/.exec(document.getElementById('replay-result').textContent);
      return m ? Number(m[1]) : 6;
    });
    await show3dFrom(fellAt - 3.2);
    await page.waitForTimeout(2600);
    mark('It falls again: now it is a test the brain fails');
    await page.waitForTimeout(3000);

    mark('[3] Train on your test cases: reinforcement learning in MuJoCo physics, right on this PC');
    await page.click('#tab-map');
    if (!FULL) {
      // A short run on camera, then the brain a full run on these test cases made earlier.
      await page.fill('#t-name', 'demo-quick');
      await page.fill('#t-iterations', '30');
      await page.fill('#t-pairs', '12');
      await page.fill('#t-steps', '600');
      await page.setChecked('#t-publish', false);
      for (const id of [FALLS, newest]) {
        const box = page.locator(`.pack[data-id="${id}"] input[data-check]`);
        if (await box.count()) {
          await box.scrollIntoViewIfNeeded();
          await box.check();
          await page.waitForTimeout(350);
        }
      }
      await page.locator(`.pack[data-id="${FALLS}"]`).scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      await page.click('#train');
      await page.waitForTimeout(2200);
      mark('Each round, 24 tweaked copies of the walking brain try every test case, with shoves and noise. The best tweaks stay');
      await page.waitForTimeout(3500);
      mark('!ff 4'); // the chart grows a point every few seconds
      // About 30 s, and stopped before the first check on held-out tries (every 5 rounds), so this run releases nothing.
      const started = Date.now();
      let captioned = false;
      while (Date.now() - started < 34000) {
        const chip = await page.textContent('#chip-trainer');
        const it = Number(/iteration (\d+)/.exec(chip ?? '')?.[1] ?? 0);
        if (!captioned && it >= 2) {
          captioned = true;
          mark('Yellow: the score going up. Red: how often it falls');
        }
        if (it >= 4) break;
        await page.waitForTimeout(500);
      }
      await page.click('#stop');
      await page.waitForFunction(() => /Stopped at|Better:|No improvement|failed/i.test(document.getElementById('train-log').textContent), null, { timeout: 60000 }).catch(() => {});
      mark('!ff 1');
      await page.waitForTimeout(1200);
      const card = page.locator('.release', { hasText: SHOWN }).first();
      await card.scrollIntoViewIfNeeded();
      const nums = (await card.textContent()) ?? '';
      const falls = /falls (\d+%) to (\d+%)/.exec(nums);
      mark(
        `Stopped here for the film: a full run takes about 5 minutes. This brain is one from earlier on these test cases${falls ? `: falls ${falls[1]} to ${falls[2]} on tries it never trained on` : ''}`,
      );
      await page.waitForTimeout(5200);
      const option = await page.evaluate((n) => [...document.getElementById('replay-release').options].find((o) => o.textContent.startsWith(n))?.value ?? '', SHOWN);
      if (option) await page.selectOption('#replay-release', option);
      if (!/Shipped/.test(await page.textContent('#replay-result'))) await replay('#replay-ship', 'Shipped');
      mark('!ff 4');
      await replay('#replay-rel', 'Trained');
      mark('!ff 1');
      mark('Same moment, both brains: the shipped one (orange) falls, the trained one keeps walking');
      await show3dFrom(fellAt - 3.2);
      await page.waitForTimeout(7500);
      mark('Send it to the headset');
      await page.click('#tab-map');
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      const send = card.locator('[data-activate]');
      if (await send.count()) await send.click();
      await page.waitForTimeout(2600);
    } else {
    await page.fill('#t-name', RELEASE);
    await page.fill('#t-iterations', '30');
    await page.fill('#t-pairs', '24');
    await page.fill('#t-steps', '900');
    await page.setChecked('#t-publish', true);
    for (const id of [FALLS, newest, ...MORE_PACKS]) {
      const box = page.locator(`.pack[data-id="${id}"] input[data-check]`);
      if (await box.count()) {
        await box.scrollIntoViewIfNeeded();
        await box.check();
        await page.waitForTimeout(350);
      }
    }
    await page.locator(`.pack[data-id="${FALLS}"]`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.click('#train');
    await page.waitForTimeout(2200);
    mark('Each round, 48 tweaked copies of the walking brain try every test case, with shoves and noise. The best tweaks stay');
    await startLapse();
    let captioned = false;
    const started = Date.now();
    while (Date.now() - started < 20 * 60 * 1000) {
      const s = await page.evaluate(() => ({
        chip: document.getElementById('chip-trainer').textContent,
        log: document.getElementById('train-log').textContent,
      }));
      if (/Better:|No improvement|failed/i.test(s.log)) break;
      const it = Number(/iteration (\d+)/.exec(s.chip)?.[1] ?? 0);
      if (!captioned && it >= 10) {
        captioned = true;
        mark('Yellow: the score rising. Red: how often it falls. Green dots: tries it never trained on');
      }
      await page.waitForTimeout(1000);
    }
    await endLapse();
    const result = await page.evaluate(() => document.getElementById('train-log').textContent);
    const better = /Better: falls (\d+%) to (\d+%)/.exec(result);
    mark(
      better
        ? `Checked on tries it never trained on: falls ${better[1]} to ${better[2]}. Better, so the headset is offered it`
        : 'No better than the shipped brain this time, so nothing is released',
    );
    await page.waitForTimeout(4200);
    if (better) {
      if (!/Shipped/.test(await page.textContent('#replay-result'))) await replay('#replay-ship', 'Shipped');
      const option = await page.evaluate((n) => [...document.getElementById('replay-release').options].find((o) => o.textContent.startsWith(n))?.value ?? '', RELEASE);
      if (option) await page.selectOption('#replay-release', option);
      mark('!ff 4');
      await replay('#replay-rel', 'Trained');
      mark('!ff 1');
      mark('Same moment, both brains: the shipped one (orange) falls, the trained one keeps walking');
      await show3dFrom(fellAt - 3.2);
      await page.waitForTimeout(7500);
      mark('The new brain is waiting for you in the headset');
      await page.click('#tab-map');
      await page.locator('.release').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(3200);
    }
    }
  } else if (part === 'publish') {
    mark('[5] Publish the trained brain to Hugging Face, where a real Microduck downloads brains');
    await page.waitForTimeout(1200);
    await page.locator('.release', { hasText: BRAIN }).locator('[data-publish]').first().click();
    await page.waitForTimeout(1800);
    await page.fill('#publish-token', 'hf_duckdash_demo_token');
    await page.waitForTimeout(1200);
    await page.click('#publish-go');
    mark('!ff 3');
    await page.waitForFunction(() => /Published to/.test(document.getElementById('publish-out').textContent), null, { timeout: 30000 });
    mark('!ff 1');
    mark("A model repo with policy.onnx, the duck's manifest and a model card (a stand-in Hub for this demo)");
    await page.waitForTimeout(4500);
  }
  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(300);
} finally {
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
  writeFileSync(`${dir}/marks.txt`, `${marks.join('\n')}\n`);
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ box: null, viewport: { w: VIEW.width, h: VIEW.height, dpr: 1 } }));
  await browser.close();
}
console.log(`REC ${count} frames -> ${dir}`);
