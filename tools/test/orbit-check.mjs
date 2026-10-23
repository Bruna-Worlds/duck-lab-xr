// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The 2D page's camera turns when the room is dragged (src/ui/orbit-camera-system.ts),
 * in a headless Chromium of its own: a mouse drag over empty floor turns it, the
 * wheel moves it in and out, a drag that starts on a panel leaves it alone, and on
 * a phone-sized touch page a one-finger drag (real touch events) turns it too.
 *
 *   node tools/test/orbit-check.mjs [url]   (default https://localhost:8081/)
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'https://localhost:8081/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const eye = (page) =>
  page.evaluate(() => {
    const c = globalThis.__duck.world.camera;
    c.updateWorldMatrix(true, false);
    const p = c.getWorldPosition(c.position.clone());
    return [p.x, p.y, p.z];
  });
const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p) => p.map((v) => v.toFixed(2)).join(', ');
// A spot over the floor with no panel on it: the middle of the canvas, a little low.
const open = async (browser, options, query = '') => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 1, ...options });
  const page = await context.newPage();
  await page.goto(`${base}${query}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && !document.getElementById('splash'), null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  return { context, page };
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  // Desktop: mouse.
  {
    const { context, page } = await open(browser, { viewport: { width: 1366, height: 768 } });
    page.on('pageerror', (e) => errors.push(e.message));
    // A first visit shows the How to play card over the middle of the page: Esc closes it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const start = await eye(page);
    await page.mouse.move(683, 520);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(683 + i * 18, 520 - i * 4);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const turned = await eye(page);
    check('a mouse drag over the floor turns the camera', moved(start, turned) > 0.2, `${fmt(start)} -> ${fmt(turned)}`);
    const distance = (p, t) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    const target = await page.evaluate(() => {
      const c = globalThis.__duck.world.camera;
      const d = c.getWorldDirection(c.position.clone());
      const p = c.getWorldPosition(c.position.clone());
      const t = (0.05 - p.y) / d.y;
      return [p.x + d.x * t, 0.05, p.z + d.z * t];
    });
    const before = distance(turned, target);
    await page.mouse.move(683, 520);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    const after = distance(await eye(page), target);
    check('the wheel moves the camera out', after > before + 0.1, `${before.toFixed(2)} m -> ${after.toFixed(2)} m from the spot it looks at`);
    // A drag that starts on the menu (top left) leaves the camera alone.
    const still = await eye(page);
    await page.mouse.move(120, 300);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(120 + i * 15, 300 + i * 6);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after2 = await eye(page);
    check('a drag that starts on a panel does not turn it', moved(still, after2) < 0.01, `${fmt(still)} -> ${fmt(after2)}`);
    await context.close();
  }
  // Phone: one finger, real touch events.
  {
    const { context, page } = await open(browser, { viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true }, '?touch=1');
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    const start = await eye(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', 200, 330);
    for (let i = 1; i <= 10; i++) await touch('touchMove', 200 + i * 12, 330 + i * 3);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(200);
    const turned = await eye(page);
    check('a finger drag over the floor turns the camera (phone)', moved(start, turned) > 0.2, `${fmt(start)} -> ${fmt(turned)}`);
    await context.close();
  }
} finally {
  await browser.close();
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((ok) => !ok).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
process.exit(failed ? 1 : 0);
