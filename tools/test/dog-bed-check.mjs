// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dog Bed playground check (2D page, development): the playground loads with
 * its two steps solid in the sim (a 2 cm play mat, a 3 cm dog bed) and open to
 * the autopilot's planner, then AUTO runs the course with the walking brain in
 * use and reports how far up Pip got: onto the mat, onto the bed, the finish.
 * With POLICIES=<folder url> (for example policies/incoming/<release>/) the
 * page runs that policy set (?policies=). Writes artifacts/dog-bed/trace.json.
 *
 *   node tools/test/dog-bed-check.mjs        (SITE, RUN_MS, POLICIES, EXPECT=climb|stuck)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const RUN_MS = Number(process.env.RUN_MS ?? 60000);
const POLICIES = process.env.POLICIES ?? '';
const EXPECT = process.env.EXPECT ?? '';
const OUT = 'artifacts/dog-bed';
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
// The course in the stage frame (public/scenes/playgrounds/dog-bed.iwsdk.scene.json).
const MAT = { x0: 0.5, x1: 1.0, top: 0.02 };
const BED = { x0: 1.42, x1: 2.02, top: 0.03 };

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(err.message));
  const url = POLICIES ? `${SITE}?policies=${encodeURIComponent(POLICIES)}` : SITE;
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.__duck.duck.sim?.ready, null, { timeout: 180000, polling: 500 });
  await page.evaluate(() => {
    globalThis.__duck.scenario.autoCapture = false; // a test run sends no packs
    return globalThis.__duck.playgrounds.load('dog-bed');
  });
  await page.waitForFunction(
    () => {
      const d = globalThis.__duck;
      return d.playgrounds.current === 'dog-bed' && !d.playgrounds.loading && d.duck.hasPose && d.duck.sim?.ready;
    },
    null,
    { timeout: 180000, polling: 500 },
  );
  await page.waitForTimeout(1500);
  if (await page.$('#duck-controls:not([hidden]) .go')) await page.click('#duck-controls .go');
  await page.keyboard.down('w');
  await page.waitForTimeout(900);
  await page.keyboard.up('w');
  await page.waitForTimeout(1500);

  const z0 = await page.evaluate(() => globalThis.__duck.duck.pose[2]);
  const falls0 = await page.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0);
  await page.evaluate(() => globalThis.__duck.nav.runCourse());
  await page.waitForTimeout(600);
  const setup = await page.evaluate(() => {
    const d = globalThis.__duck;
    const grid = d.nav.grid; // the autopilot builds its map when a task starts
    const CELL = 0.05;
    const blockedAt = (x, y) => {
      if (!grid) return null;
      const i = Math.floor((x - grid.x0) / CELL);
      const j = Math.floor((y - grid.y0) / CELL);
      return grid.blocked[j * grid.cols + i] === 1;
    };
    return {
      pieces: d.playgrounds.current,
      walkable: (() => {
        let n = 0;
        d.world.scene.traverse((o) => {
          if (o.visible !== false) n += (o.userData.colliders ?? []).filter((c) => c.walkable).length;
        });
        return n;
      })(),
      matBlocked: blockedAt(0.75, 0),
      bedBlocked: blockedAt(1.72, 0),
      policies: d.duck.policyBaseUrl,
    };
  });
  check('the two steps are solid and walkable (the planner plans across them)', setup.walkable === 2 && setup.matBlocked === false && setup.bedBlocked === false, JSON.stringify(setup));

  const trace = [];
  const t0 = Date.now();
  let onMat = null;
  let onBed = null;
  while (Date.now() - t0 < RUN_MS) {
    const s = await page.evaluate(() => {
      const d = globalThis.__duck;
      return { at: Array.from(d.duck.pose.slice(0, 3)), run: d.course.state, left: d.nav.waypointsLeft, task: d.nav.task, status: d.nav.status };
    });
    s.t = (Date.now() - t0) / 1000;
    trace.push(s);
    const lift = s.at[2] - z0;
    if (onMat === null && s.at[0] > MAT.x0 + 0.12 && s.at[0] < MAT.x1 && lift > MAT.top * 0.6) onMat = s.t;
    if (onBed === null && s.at[0] > BED.x0 + 0.12 && lift > BED.top * 0.6) onBed = s.t;
    if (s.run === 'finished') break;
    await page.waitForTimeout(250);
  }
  writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace));
  const falls = (await page.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0)) - falls0;
  const last = trace.at(-1);
  const farthest = Math.max(...trace.map((s) => s.at[0]));
  const summary = `onto the mat ${onMat === null ? 'no' : `${onMat.toFixed(1)} s`}, onto the bed ${onBed === null ? 'no' : `${onBed.toFixed(1)} s`}, run ${last.run}, falls ${falls}, farthest x ${farthest.toFixed(2)} m, ${last.status}`;
  console.log(`INFO ${POLICIES || 'shipped brain'}: ${summary}`);
  if (EXPECT === 'climb') check('Pip climbs onto the mat', onMat !== null, summary);
  if (EXPECT === 'stuck') check('Pip does not get onto the mat', onMat === null, summary);
  await page.evaluate(() => globalThis.__duck.nav.stop());
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
process.exit(failed ? 1 : 0);
