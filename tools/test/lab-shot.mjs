// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Opens Duck Lab XR (tools/lab/server.mjs, http://localhost:8790) in a second
 * tab of the managed browser, replays the selected pack with both brains and
 * saves artifacts/ui/lab.png, then the 3D replay tab as artifacts/ui/lab-3d.png.
 * The app tab is left alone.
 *
 *   npx @iwsdk/cli browser run tools/test/lab-shot.mjs --timeout 100000
 */
export default async function run({ context }) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    await page.setViewportSize({ width: 1500, height: 1050 });
    await page.goto(process.env.LAB_URL ?? 'http://localhost:8790/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('.pack.selected', { timeout: 20000 });
    await page.click('#replay-ship');
    await page.waitForFunction(() => /Shipped/.test(document.getElementById('replay-result').textContent), null, { timeout: 30000 });
    await page.click('#replay-rel');
    await page.waitForFunction(() => /Trained/.test(document.getElementById('replay-result').textContent), null, { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.LAB_OUT ?? 'artifacts/ui/lab.png' });
    const result = await page.evaluate(() => document.getElementById('replay-result').innerText);
    console.log(`LAB ${result.replace(/\n/g, ' / ').replace(/"/g, "'")}`);
    // 3D replay: the duck model loads, both replays start; scrub to the middle.
    await page.click('#tab-3d');
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const scrub = document.getElementById('scrub');
      scrub.value = '450';
      scrub.dispatchEvent(new Event('input'));
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'artifacts/ui/lab-3d.png' });
    console.log(`LAB3D errors ${errors.length}: ${errors.slice(0, 3).join(' | ').replace(/"/g, "'")}`);
  } finally {
    await page.close();
  }
}
