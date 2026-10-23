// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop PLAY | TRAINER check (development): the game shows the switch;
 * TRAINER shows Duck Lab XR's trainer over the game; the trainer's own switch
 * goes back, keys drive the duck again, and nothing reloaded either way; a
 * second swap is instant; #trainer opens on the trainer; the page reopens
 * on the view used last; and once the trainer has been used, the game loads
 * it (hidden) by itself so the headset link is up while playing.
 *
 *   node tools/test/views-check.mjs
 *
 * Needs the dev server; the trainer engine (npm run lab) is optional here.
 */
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  const views = () =>
    page.evaluate(() => {
      const box = document.getElementById('duck-views');
      const frame = document.getElementById('duck-trainer');
      return {
        switchShown: !!box && getComputedStyle(box).display !== 'none',
        on: document.querySelector('#duck-views button.on')?.dataset.view ?? null,
        frame: !!frame,
        frameShown: !!frame && !frame.hidden,
        hash: location.hash,
        mark: globalThis.__viewsMark ?? null,
        trainerMark: frame?.contentWindow?.__viewsMark ?? null,
      };
    });

  await page.goto(SITE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 90000 });
  await page.evaluate(() => {
    globalThis.__viewsMark = 'game';
  });
  let v = await views();
  check('game shows PLAY | TRAINER, on PLAY', v.switchShown && v.on === 'play' && !v.frame, JSON.stringify(v));

  await page.click('#duck-views button[data-view="trainer"]');
  const trainer = page.frameLocator('#duck-trainer');
  await trainer.locator('#views').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('duck-trainer')?.contentDocument?.getElementById('pair-code')?.textContent ?? ''), null, { timeout: 30000 });
  await page.evaluate(() => {
    document.getElementById('duck-trainer').contentWindow.__viewsMark = 'trainer';
  });
  v = await views();
  const trainerOn = await trainer.locator('#views .view.on').textContent();
  check('one click shows the trainer (with its own switch on TRAINER)', v.frameShown && !v.switchShown && v.hash === '#trainer' && trainerOn === 'TRAINER', JSON.stringify(v));
  await page.screenshot({ path: 'artifacts/layout/views-trainer.png' });

  await trainer.locator('#view-play').click();
  await page.waitForFunction(() => document.getElementById('duck-trainer')?.hidden === true, null, { timeout: 10000 });
  v = await views();
  check('one click back to the game, nothing reloaded', v.switchShown && v.on === 'play' && !v.frameShown && v.hash === '' && v.mark === 'game' && v.trainerMark === 'trainer', JSON.stringify(v));
  await page.screenshot({ path: 'artifacts/layout/views-play.png' });

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(400);
  const vx = await page.evaluate(() => globalThis.__duck.duck.commandVx);
  await page.keyboard.up('KeyW');
  check('keys drive the duck again after the swap', vx > 0, `vx ${vx.toFixed(2)}`);

  await page.click('#duck-views button[data-view="trainer"]');
  await page.waitForFunction(() => document.getElementById('duck-trainer')?.hidden === false, null, { timeout: 5000 });
  v = await views();
  check('second swap to the trainer is instant (same page, no reload)', v.trainerMark === 'trainer', JSON.stringify(v));

  // A new visit with #trainer opens on the trainer; one without loads it hidden (it was used).
  const second = await context.newPage();
  second.on('pageerror', (err) => errors.push(err.message));
  await second.goto(`${SITE}#trainer`, { waitUntil: 'load', timeout: 60000 });
  await second.waitForFunction(() => document.getElementById('duck-trainer')?.hidden === false, null, { timeout: 20000 });
  check('#trainer opens on the trainer', true);
  await second.close();
  const fourth = await context.newPage();
  await fourth.goto(SITE, { waitUntil: 'load', timeout: 60000 });
  await fourth.waitForFunction(() => document.getElementById('duck-trainer')?.hidden === false, null, { timeout: 20000 });
  check('a new visit reopens on the view used last (the trainer)', true);
  await fourth.frameLocator('#duck-trainer').locator('#view-play').click();
  await fourth.waitForFunction(() => document.getElementById('duck-trainer')?.hidden === true, null, { timeout: 10000 });
  await fourth.close();
  const third = await context.newPage();
  third.on('pageerror', (err) => errors.push(err.message));
  await third.goto(SITE, { waitUntil: 'load', timeout: 60000 });
  await third.waitForFunction(() => !!document.getElementById('duck-trainer'), null, { timeout: 20000 });
  const preloaded = await third.evaluate(() => ({ hidden: document.getElementById('duck-trainer').hidden, on: document.querySelector('#duck-views button.on')?.dataset.view }));
  check('after the trainer was used, the game loads it hidden', preloaded.hidden && preloaded.on === 'play', JSON.stringify(preloaded));
} catch (err) {
  check('views run', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
console.log(JSON.stringify({ passed, failed: results.length - passed }));
process.exit(passed === results.length ? 0 : 1);
