// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The autopilot runs the whole course in the demo's fixed scene: the course
 * put at the demo's spot, the offered brain taken (TRY IT) when there is
 * one, then Auto (P): around the book stacks, through both gates, onto the
 * finish pad. Reports the time, the falls and whether it got stuck.
 *
 *   bash tools/test/mr.sh tools/test/course-run-check.mjs 14
 */
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  const brain = await app.evaluate(async (shipped) => {
    const d = globalThis.__duck;
    const V = d.world.scene.position.constructor;
    d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
    if (shipped) await d.policyInbox.revert?.();
    else if (d.policyInbox.offer) await d.policyInbox.accept();
    return d.duck.policyHash;
  }, process.env.BRAIN === 'shipped');
  await app.waitForFunction(() => /woke|ready/i.test(globalThis.__duck.duck.status) && globalThis.__duck.duck.sim?.ready, null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const falls0 = await app.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0);
  await app.evaluate(() => globalThis.__duck.nav.runCourse());
  const t0 = Date.now();
  let last = '';
  let stuck = false;
  while (Date.now() - t0 < Number(process.env.RUN_MS ?? 70000)) {
    const s = await app.evaluate(() => { const n = globalThis.__duck.nav; const p = globalThis.__duck.duck.pose; const w = n.waypoints?.[0]; return { status: n.status, stuck: n.stuck, task: n.task, at: p ? [p[0], p[1]].map((v) => v.toFixed(2)).join(',') : '?', next: w ? [w.x, w.y].map((v) => v.toFixed(2)).join(',') + (w.through ? ' gate' : '') : '-', left: n.waypoints?.length ?? 0 }; });
    if (process.env.TRACE && Math.round((Date.now() - t0) / 500) % 6 === 0) console.log('PASS trace ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s at ' + s.at + ' next ' + s.next + ' left ' + s.left + ' ' + s.status);
    last = s.status;
    stuck ||= s.stuck;
    if (!s.task) break;
    await page.waitForTimeout(500);
  }
  const seconds = (Date.now() - t0) / 1000;
  const falls = (await app.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0)) - falls0;
  check('Auto runs the course to the finish', /finished/.test(last), `${last || 'no status'} after ${seconds.toFixed(1)} s, brain ${brain}`);
  check('no falls on the way', falls === 0, `${falls} falls`);
  check('never stuck', !stuck);
  await app.evaluate(() => globalThis.__duck.nav.stop());
  const failed = results.filter((ok) => !ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
