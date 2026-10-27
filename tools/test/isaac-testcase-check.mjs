// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Isaac Sim test case, end to end, as a person does it on the trainer page:
 * pick a pack, Run in Isaac Sim, Watch here, and follow it. Needs the streaming
 * Isaac Sim with the bridge (tools/isaac/start-isaac-sim.ps1) and the trainer
 * (npm run lab) running on this PC; it opens a browser of its own.
 *
 *   node tools/test/isaac-testcase-check.mjs [pack id]
 *
 * Checks the page, the build, the run to its end, the result lines, both paths
 * on the map, and the stream itself: it samples the streamed video's
 * brightness through the run (a dark frame means the viewport drew nothing).
 * Saves artifacts/isaac-testcase-page.png (mid-run) and -end.png.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const LAB = process.env.LAB ?? 'http://localhost:8790/';
const PACK = process.argv[2] ?? '2026-10-24T01-02-31-manual';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('artifacts', { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1250 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(LAB, { waitUntil: 'load' });
  const item = page.locator(`.pack[data-id="${PACK}"]`);
  await item.waitFor({ timeout: 20000 });
  await item.click({ position: { x: 120, y: 12 } });
  await page.waitForFunction(() => !document.getElementById('isaac-run').disabled, null, { timeout: 20000 });
  check('pack picked, Run in Isaac Sim enabled', true, PACK);

  await page.click('#isaac-run');
  await page.waitForFunction(() => /Building|Waiting|Running/.test(document.getElementById('isaac-result').textContent), null, { timeout: 60000 });
  check('Isaac Sim took the pack', true, (await page.textContent('#isaac-result')).slice(0, 80));

  // The stream in the page: Run opens it (no Duck Lab XR page holds it); else Watch here.
  await page.locator('#isaac-watch').waitFor({ state: 'visible', timeout: 30000 });
  if (await page.isHidden('#isaac-stream')) await page.click('#isaac-watch');
  const frame = await (async () => {
    for (let i = 0; i < 50; i++) {
      const f = page.frames().find((x) => x.url().includes('isaac/player.html'));
      if (f) return f;
      await wait(200);
    }
    return null;
  })();
  check('stream player in the page', !!frame);
  await frame.waitForFunction(() => {
    const v = document.getElementById('remote-video');
    return v && v.videoWidth > 0 && v.currentTime > 0.3;
  }, null, { timeout: 60000 });
  check('stream playing', true, await frame.evaluate(() => `${document.getElementById('remote-video').videoWidth}x${document.getElementById('remote-video').videoHeight}`));

  // Brightness of the streamed picture, twice a second, through the run and a little after.
  const brightness = () =>
    frame.evaluate(() => {
      const v = document.getElementById('remote-video');
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 36;
      const g = c.getContext('2d');
      g.drawImage(v, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return Math.round(s / (64 * 36));
    });
  const samples = [];
  let shot = false;
  for (let i = 0; i < 240; i++) {
    const text = await page.textContent('#isaac-result');
    const state = /^Done/.test(text) ? 'done' : /^Running/.test(text) ? 'running' : /Waiting/.test(text) ? 'waiting' : 'building';
    samples.push({ state, b: await brightness() });
    if (state === 'running' && !shot && /: [2-9]\.\d of/.test(text)) {
      await page.screenshot({ path: 'artifacts/isaac-testcase-page.png' });
      shot = true;
    }
    if (state === 'done' && samples.filter((s) => s.state === 'done').length >= 6) break;
    await wait(500);
  }
  const running = samples.filter((s) => s.state === 'running');
  // Lit: near the brightest frame (Isaac Sim's panels around a black viewport still read about 30).
  const top = Math.max(...samples.map((s) => s.b));
  const lit = (list) => list.filter((s) => s.b > top * 0.6).length;
  console.log(`      brightness: ${samples.map((s) => `${s.state[0]}${s.b}`).join(' ')}`);
  check('the run ended', samples.at(-1).state === 'done');
  check('the stream shows the run', running.length > 0 && lit(running) >= running.length * 0.9, `${lit(running)}/${running.length} frames lit while running`);
  const text = await page.textContent('#isaac-result');
  check('result lines for PhysX and MuJoCo', /PhysX: [\d.]+ m walked/.test(text) && /MuJoCo \(ghost\): [\d.]+ m walked/.test(text), text.replace(/\s+/g, ' ').slice(0, 220));
  const api = await page.evaluate(async () => (await fetch('/api/isaac')).json());
  const tc = api.testcase ?? {};
  check('both paths for the map', (tc.path?.length ?? 0) > 5 && (tc.mujocoPath?.length ?? 0) > 5, `PhysX ${tc.path?.length ?? 0} points, MuJoCo ${tc.mujocoPath?.length ?? 0}`);
  check("Pip in Pollen's full model, and the ghost", tc.info?.fullModel === true && tc.info?.ghost === true);
  await page.screenshot({ path: 'artifacts/isaac-testcase-end.png' });
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('ran to the end', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
