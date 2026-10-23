// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * One-click trainer start check (development): with the trainer engine not
 * running, the trainer page says so and offers "Start the trainer"; one click
 * starts it (through the dev server, in its own window on Windows) and the
 * page connects by itself.
 *
 *   node tools/test/trainer-start-check.mjs
 *
 * Leaves the started engine running (close its window to stop it).
 */
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const running = await fetch('http://127.0.0.1:8790/api/state').then((r) => r.ok, () => false);
if (running) {
  console.log('SKIP the trainer engine is already running (stop it first to test the start button)');
  process.exit(0);
}
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${SITE}trainer/`, { waitUntil: 'load', timeout: 60000 });
  await page.locator('#engine-start').waitFor({ state: 'visible', timeout: 20000 });
  check('trainer page says the trainer is not running and offers a start button', true, (await page.textContent('#engine-text')).trim().slice(0, 80));
  await page.screenshot({ path: 'artifacts/layout/trainer-start-before.png' });
  const t0 = Date.now();
  await page.click('#engine-start');
  await page.waitForFunction(() => document.getElementById('chip-inbox')?.className.includes('on'), null, { timeout: 45000 });
  check('one click starts it and the page connects', true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  check('the banner goes away', await page.locator('#engine-missing').isHidden());
  await page.screenshot({ path: 'artifacts/layout/trainer-start-after.png' });
} catch (err) {
  check('start run', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
}
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
console.log(JSON.stringify({ passed, failed: results.length - passed }));
process.exit(passed === results.length ? 0 : 1);
