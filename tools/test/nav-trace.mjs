// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Records what the autopilot does on the demo's course (the film's spot):
 * Pip's track, the target, the commands and the status, ten times a second,
 * plus the course pieces and the planning grid, to
 * artifacts/nav/trace-<LABEL>.json. node tools/test/nav-plot.mjs draws it.
 *
 *   BRAIN=shipped|offer LABEL=x bash tools/test/mr.sh tools/test/nav-trace.mjs 14
 */
import { mkdirSync, writeFileSync } from 'node:fs';

export default async function run({ page, frame }) {
  const app = frame ?? page;
  const label = process.env.LABEL ?? 'run';
  const runMs = Number(process.env.RUN_MS ?? 60000);
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  const brain = await app.evaluate(async (which) => {
    const d = globalThis.__duck;
    const V = d.world.scene.position.constructor;
    d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
    if (which === 'shipped') await d.policyInbox.revert?.();
    else if (d.policyInbox.offer) await d.policyInbox.accept();
    return d.duck.policyHash;
  }, process.env.BRAIN ?? 'offer');
  await app.waitForFunction(() => globalThis.__duck.duck.sim?.ready, null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await app.evaluate(() => {
    const d = globalThis.__duck;
    const nav = d.nav;
    const duck = d.duck;
    const trace = (globalThis.__navTrace = { samples: [], t0: performance.now(), falls0: duck.sim?.stats?.falls ?? 0 });
    nav.runCourse();
    const course = d.course;
    const pieces = [];
    const stage = duck.stageEntity?.object3D ?? null;
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
    trace.stageFound = !!stage;
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
        z: p[2],
        yaw,
        tx: nav.targetX,
        ty: nav.targetY,
        w: w ? { x: w.x, y: w.y, through: w.through, optional: !!w.optional } : null,
        left: nav.waypoints?.length ?? 0,
        path: nav.path?.length ? nav.path.slice(nav.pathIndex, nav.pathIndex + 12) : [],
        f: duck.autopilot?.forward ?? null,
        r: duck.autopilot?.turn ?? null,
        vx: duck.commandVx,
        wz: duck.commandWz,
        mode: duck.sim?.mode,
        status: nav.status,
        stuck: nav.stuck,
        crumbs: course?.crumbsGot,
        gates: course?.gatesGot,
        falls: (duck.sim?.stats?.falls ?? 0) - trace.falls0,
      });
      if (!nav.task) {
        clearInterval(trace.timer);
        trace.done = true;
      }
    }, 100);
  });
  const t0 = Date.now();
  while (Date.now() - t0 < runMs) {
    const done = await app.evaluate(() => globalThis.__navTrace.done === true);
    if (done) break;
    await page.waitForTimeout(1000);
  }
  const trace = await app.evaluate(() => {
    const t = globalThis.__navTrace;
    clearInterval(t.timer);
    globalThis.__duck.nav.stop();
    return { samples: t.samples, pieces: t.pieces, grid: t.grid, done: !!t.done };
  });
  mkdirSync('artifacts/nav', { recursive: true });
  writeFileSync(`artifacts/nav/trace-${label}.json`, JSON.stringify({ brain, ...trace }));
  const last = trace.samples[trace.samples.length - 1];
  console.log(
    `PASS trace ${label}: brain ${brain}, ${last?.t.toFixed(1)} s, ${last?.status}, crumbs ${last?.crumbs}, gates ${last?.gates}, falls ${last?.falls}, ${trace.samples.length} samples`,
  );
  console.log(JSON.stringify({ passed: 1, failed: 0 }));
}
