// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Autopilot lab, in a headless browser of its own (an emulated mixed-reality
 * session in the sunlit living room; the managed window is left alone), with
 * the course at the demo films' spot.
 *
 *   node tools/test/nav-lab.mjs turns [shipped|offer]   how the walking brain answers forward/turn commands
 *   node tools/test/nav-lab.mjs course [shipped|offer] [label] [seconds]
 *       the autopilot runs the course; trace to artifacts/nav/trace-<label>.json
 *       (draw it with node tools/test/nav-plot.mjs)
 *
 * Needs the dev server (https://localhost:8081).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const [mode = 'course', brainArg = 'offer', labelArg, secondsArg] = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}?demoReset=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.IWER_DEVICE?.sessionOffered === true, null, { timeout: 90000 });
  await page.evaluate(() => globalThis.IWER_DEVICE.grantOfferedSession());
  await page.waitForFunction(() => !!globalThis.__duck.world.session && ['placed', 'tight'].includes(globalThis.__duck.room.state), null, { timeout: 60000 });
  const brain = await page.evaluate(async (which) => {
    const d = globalThis.__duck;
    const V = d.duck.rig.trunk.position.constructor;
    d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
    if (which === 'shipped') await d.policyInbox.revert?.();
    else if (d.policyInbox.offer) await d.policyInbox.accept();
    return d.duck.policyHash;
  }, brainArg);
  await page.waitForFunction(() => globalThis.__duck.duck.sim?.ready, null, { timeout: 40000 }).catch(() => {});
  await wait(2000);
  // Wake Pip (a fresh visit starts it asleep; the autopilot alone does not wake it).
  await page.keyboard.down('KeyW');
  await wait(1200);
  await page.keyboard.up('KeyW');
  await wait(1500);
  console.log(`brain ${brain}`);

  if (mode === 'turns') {
    const pairs = [
      [0.25, 1], [0.25, -1], [0.4, 1], [0.4, -1], [0.6, 1], [0.6, -1], [0.85, 1], [0.85, -1],
      [0.6, 0.6], [0.6, -0.6], [0.85, 0.5], [0.85, -0.5], [0.85, 0.25], [0.85, -0.25], [0.5, 0], [0.85, 0],
      [0, 1], [0, -1],
    ];
    const rows = [];
    for (const [f, r] of pairs) {
      const row = await page.evaluate(
        async ([f, r, neutral, rolling]) => {
          const d = globalThis.__duck;
          const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
          const yawOf = (p) => Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
          d.nav.stop();
          // Left turns curve north (+y), right turns south: start where the arc stays on open floor.
          d.duck.holdHeadNeutral = neutral;
          d.duck.sim.teleport(-0.15, r >= 0 ? 0.3 : 0.75, 0);
          d.duck.autopilot = { forward: 0, turn: 0 };
          await sleep(900);
          if (rolling) {
            d.duck.autopilot = { forward: 0.85, turn: 0.3 }; // already walking when the command comes
            await sleep(1200);
          }
          d.duck.autopilot = { forward: f, turn: r };
          await sleep(1000); // the gait settles into the command
          const falls0 = d.duck.sim.stats?.falls ?? 0;
          const a = Array.from(d.duck.pose);
          const ta = performance.now();
          let turned = 0;
          let last = yawOf(a);
          let walked = 0;
          let px = a[0];
          let py = a[1];
          while (performance.now() - ta < 2500) {
            await sleep(100);
            const p = d.duck.pose;
            const y = yawOf(p);
            let dy = y - last;
            dy = Math.atan2(Math.sin(dy), Math.cos(dy));
            turned += dy;
            last = y;
            walked += Math.hypot(p[0] - px, p[1] - py);
            px = p[0];
            py = p[1];
          }
          const s = (performance.now() - ta) / 1000;
          const out = { f, r, yawRate: (turned / s) * (180 / Math.PI), speed: walked / s, mode: d.duck.sim.mode, falls: (d.duck.sim.stats?.falls ?? 0) - falls0 };
          d.duck.autopilot = { forward: 0, turn: 0 };
          return out;
        },
        [f, r, process.env.HEAD === 'neutral', process.env.ROLLING === '1'],
      );
      rows.push(row);
      const want = { yaw: r * 57.3, v: f * 0.25 };
      console.log(
        `f ${f.toFixed(2)} r ${r.toFixed(2)} -> yaw ${row.yawRate.toFixed(0).padStart(4)} deg/s (asked ${want.yaw.toFixed(0)}), speed ${row.speed.toFixed(3)} m/s (asked ${want.v.toFixed(3)}), radius ${(row.speed / Math.max(1e-3, Math.abs(row.yawRate) / 57.3)).toFixed(2)} m, ${row.mode}${row.falls ? `, FELL ${row.falls}` : ''}`,
      );
    }
    mkdirSync('artifacts/nav', { recursive: true });
    writeFileSync(`artifacts/nav/turns-${brainArg}.json`, JSON.stringify({ brain, rows }, null, 1));
  } else {
    const label = labelArg ?? `${brainArg}`;
    const seconds = Number(secondsArg ?? 60);
    await page.evaluate(() => {
      const d = globalThis.__duck;
      const nav = d.nav;
      const duck = d.duck;
      duck.autopilot = null;
      const trace = (globalThis.__navTrace = { samples: [], t0: performance.now(), falls0: duck.sim?.stats?.falls ?? 0 });
      nav.runCourse();
      const pieces = [];
      for (const [kind, set] of [
        ['crumb', nav.queries.crumbs.entities],
        ['gate', nav.queries.gates.entities],
        ['goal', nav.queries.goals.entities],
        ['finish', nav.queries.finishes.entities],
      ]) {
        for (const e of set) {
          const p = e.object3D?.position;
          if (p) pieces.push({ kind, x: p.x, y: -p.z });
        }
      }
      trace.pieces = pieces;
      trace.timer = setInterval(() => {
        const p = duck.pose;
        const yaw = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
        const w = nav.waypoints?.[0];
        const g = nav.grid;
        if (g && !trace.grid) {
          trace.grid = { x0: g.x0, y0: g.y0, cols: g.cols, rows: g.rows, cell: 0.05, blocked: Array.from(g.blocked).join(''), solid: Array.from(g.solid).join('') };
        }
        trace.samples.push({
          t: (performance.now() - trace.t0) / 1000,
          x: p[0],
          y: p[1],
          yaw,
          tx: nav.targetX,
          ty: nav.targetY,
          w: w ? { x: w.x, y: w.y, through: w.through, optional: !!w.optional } : null,
          left: nav.waypoints?.length ?? 0,
          path: nav.path?.length ? nav.path.slice(nav.pathIndex, nav.pathIndex + 12) : [],
          f: duck.autopilot?.forward ?? null,
          r: duck.autopilot?.turn ?? null,
          mode: duck.sim?.mode,
          status: nav.status,
          stuck: nav.stuck,
          crumbs: d.course?.crumbsGot,
          gates: d.course?.gatesGot,
          falls: (duck.sim?.stats?.falls ?? 0) - trace.falls0,
        });
        if (!nav.task) {
          clearInterval(trace.timer);
          trace.done = true;
        }
      }, 100);
    });
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      if (await page.evaluate(() => globalThis.__navTrace.done === true)) break;
      await wait(500);
    }
    const trace = await page.evaluate(() => {
      const t = globalThis.__navTrace;
      clearInterval(t.timer);
      globalThis.__duck.nav.stop();
      return { samples: t.samples, pieces: t.pieces, grid: t.grid, done: !!t.done };
    });
    mkdirSync('artifacts/nav', { recursive: true });
    writeFileSync(`artifacts/nav/trace-${label}.json`, JSON.stringify({ brain, ...trace }));
    const last = trace.samples[trace.samples.length - 1];
    const stuckS = trace.samples.filter((s) => s.stuck).length / 10;
    let turned = 0;
    for (let k = 1; k < trace.samples.length; k++) {
      const dy = trace.samples[k].yaw - trace.samples[k - 1].yaw;
      turned += Math.abs(Math.atan2(Math.sin(dy), Math.cos(dy)));
    }
    console.log(
      `course ${label}: ${last?.t.toFixed(1)} s, ${last?.status}, crumbs ${last?.crumbs}, gates ${last?.gates}, falls ${last?.falls}, stuck ${stuckS.toFixed(1)} s, turned ${((turned * 180) / Math.PI).toFixed(0)} deg in all`,
    );
  }
} finally {
  await browser.close();
}
console.log(`errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
