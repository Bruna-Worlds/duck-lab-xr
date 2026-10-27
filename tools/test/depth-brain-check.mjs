// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Depth brain check (2D page, development): the menu's DRIVER chip "Depth
 * brain" hands the autopilot's steering to the navigation brain
 * (public/policies/ducklab/nav.onnx) in the sim, the robot panel's DEPTH tab
 * draws the head distance sensor's 8 x 8 frame, AUTO runs the course with the
 * brain steering (the head looking straight ahead), and "Planner" hands back.
 * Clicks the panels' own chips and tabs (their place on the screen comes from
 * the panel elements). Writes artifacts/depth-brain/feed.png (the DEPTH view)
 * and trace.json (the run, a sample every 0.5 s).
 *
 *   node tools/test/depth-brain-check.mjs        (SITE, RUN_MS)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const RUN_MS = Number(process.env.RUN_MS ?? 45000);
const OUT = 'artifacts/depth-brain';
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

/** Where a panel element is on the page (CSS px), or null when its panel is hidden. */
const spot = (page, node, id) =>
  page.evaluate(
    ([node, id]) => {
      const w = globalThis.__duck.world;
      const asset = w.getSceneObject(node);
      if (!asset?.document?.visible) return null;
      const el = asset.getElementById(id);
      if (!el) return null;
      const p = el.getWorldPosition(w.camera.position.clone());
      p.project(w.camera);
      const c = w.renderer.domElement;
      return { x: ((p.x + 1) / 2) * c.clientWidth, y: ((1 - p.y) / 2) * c.clientHeight };
    },
    [node, id],
  );
const click = async (page, node, id) => {
  const at = await spot(page, node, id);
  if (at) await page.mouse.click(at.x, at.y);
  return !!at;
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(SITE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.__duck.duck.sim?.ready, null, { timeout: 90000 });
  await page.waitForTimeout(1200);
  if (await page.$('#duck-controls:not([hidden]) .go')) await page.click('#duck-controls .go');
  // A fresh visit starts Pip asleep: a held W wakes it.
  await page.keyboard.down('w');
  await page.waitForTimeout(900);
  await page.keyboard.up('w');
  await page.waitForTimeout(1500);

  // The menu's DRIVER chip.
  await page.evaluate(() => globalThis.__duck.nav.setBrain(false)); // a known start
  const clicked = await click(page, 'menu-panel', 'driver-brain');
  await page.waitForTimeout(400);
  const brain = await page.evaluate(() => ({ on: globalThis.__duck.nav.brain, kept: localStorage.getItem('ducklab.nav.brain') }));
  check('the menu has the DRIVER chips and "Depth brain" picks the brain', clicked && brain.on && brain.kept === '1', JSON.stringify(brain));

  // Pip cam's DEPTH tab.
  if (!(await page.evaluate(() => globalThis.__duck.cam.visible))) await click(page, 'run-panel', 'cam-button') || (await click(page, 'menu-panel', 'cam-button'));
  await page.waitForTimeout(800);
  const tab = await click(page, 'robot-panel', 'rp-view-depth');
  await page.waitForFunction(() => globalThis.__duck.duck.sim?.tof?.zones?.length === 64, null, { timeout: 8000 }).catch(() => {});
  const depth = await page.evaluate(() => {
    const d = globalThis.__duck;
    const z = d.duck.sim?.tof?.zones;
    return { view: d.cam.view, zones: z ? Array.from(z) : null };
  });
  const near = depth.zones ? Math.min(...depth.zones) : null;
  check('DEPTH shows the head sensor (8 x 8 frames from the sim)', tab && depth.view === 'depth' && depth.zones?.length === 64, `nearest ${near?.toFixed(2)} m`);

  // AUTO, the brain steering.
  const falls0 = await page.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0);
  const start = await page.evaluate(() => Array.from(globalThis.__duck.duck.pose.slice(0, 2)));
  (await click(page, 'run-panel', 'auto-button')) || (await click(page, 'menu-panel', 'auto-button'));
  await page.waitForTimeout(500);
  const trace = [];
  const t0 = Date.now();
  let shot = false;
  while (Date.now() - t0 < RUN_MS) {
    const s = await page.evaluate(() => {
      const d = globalThis.__duck;
      const t = d.duck.sim?.tof;
      return {
        t: performance.now(),
        task: d.nav.task,
        status: d.nav.status,
        driving: !!t?.driving,
        forward: t?.forward ?? 0,
        turn: t?.turn ?? 0,
        head: Array.from(d.duck.head ?? []),
        at: Array.from(d.duck.pose.slice(0, 2)),
        left: d.nav.waypoints?.length ?? 0,
        nearest: t ? Math.min(...t.zones) : null,
      };
    });
    trace.push(s);
    if (!shot && s.driving && Date.now() - t0 > 6000) {
      shot = true;
      // The DEPTH feed itself, as Pip cam draws it.
      const png = await page.evaluate(() => {
        const d = globalThis.__duck;
        const r = d.world.renderer;
        const target = d.cam.target;
        const w = target.width;
        const h = target.height;
        const px = new Uint8Array(w * h * 4);
        r.readRenderTargetPixels(target, 0, 0, w, h, px);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const img = c.getContext('2d').createImageData(w, h);
        for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        c.getContext('2d').putImageData(img, 0, 0);
        return c.toDataURL('image/png').split(',')[1];
      });
      writeFileSync(`${OUT}/feed.png`, Buffer.from(png, 'base64'));
    }
    if (!s.task) break;
    await page.waitForTimeout(500);
  }
  writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace));
  const drove = trace.filter((s) => s.driving);
  const falls = (await page.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0)) - falls0;
  const end = trace.at(-1)?.at ?? start;
  const walked = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const headStill = drove.every((s) => s.head.every((v) => Math.abs(v) < 1e-6));
  check('AUTO with the depth brain: the brain steers', drove.length > 0.5 * trace.length, `${drove.length}/${trace.length} samples driving`);
  check('the head looks straight ahead while it drives', drove.length > 0 && headStill);
  check('Pip gets somewhere', walked > 0.5, `${walked.toFixed(2)} m from the start, ${trace[0]?.left ?? '?'} -> ${trace.at(-1)?.left ?? '?'} targets left, ${trace.at(-1)?.status ?? ''}`);
  console.log(`INFO falls ${falls}, forward mean ${(drove.reduce((a, s) => a + s.forward, 0) / Math.max(1, drove.length)).toFixed(3)} m/s`);

  // Planner hands back.
  await click(page, 'menu-panel', 'driver-planner');
  await page.waitForTimeout(1500);
  const back = await page.evaluate(() => ({ brain: globalThis.__duck.nav.brain, driving: globalThis.__duck.duck.sim?.driving, task: globalThis.__duck.nav.task }));
  check('"Planner" hands steering back to the path planner', !back.brain && !back.driving, JSON.stringify(back));
  await page.evaluate(() => globalThis.__duck.nav.stop());
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
process.exit(failed ? 1 : 0);
