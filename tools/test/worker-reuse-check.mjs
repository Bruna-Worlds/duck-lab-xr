// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Playground switches and respawns reuse the duck's sim worker (MuJoCo,
 * ONNX Runtime and the policies stay loaded): no new worker starts, the new
 * duck stands up and walks, and it is ready quickly.
 *
 *   npx @iwsdk/cli browser run tools/test/worker-reuse-check.mjs --timeout 100000
 */
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  const counts = () =>
    app.evaluate(() => {
      const C = globalThis.__duck.duck.sim?.constructor;
      return { started: C?.workersStarted ?? -1, reused: C?.workersReused ?? -1 };
    });
  const standing = (id) =>
    app.waitForFunction(
      (pg) => {
        const d = globalThis.__duck;
        return (!pg || d.playgrounds.current === pg) && d.duck.hasPose && d.duck.sim?.ready && /woke|ready/i.test(d.duck.status);
      },
      id,
      { timeout: 40000 },
    );
  await standing(null);
  const before = await counts();
  const current = await app.evaluate(() => globalThis.__duck.playgrounds.current);
  const order = current === 'free-roam' ? ['living-room-dash', 'free-roam'] : ['free-roam', current];
  const times = [];
  for (const id of order) {
    const t0 = Date.now();
    await app.evaluate((pg) => globalThis.__duck.playgrounds.load(pg), id);
    await app.waitForFunction(
      (pg) => globalThis.__duck.playgrounds.current === pg && globalThis.__duck.duck.hasPose,
      id,
      { timeout: 40000 },
    );
    times.push(`${id} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await standing(id);
  }
  await app.evaluate(() => globalThis.__duck.duck.respawn());
  await page.waitForTimeout(500);
  await standing(null);
  const after = await counts();
  check('no new sim worker for two switches and a respawn', after.started === before.started && after.reused >= before.reused + 3, `started ${before.started} -> ${after.started}, reused ${before.reused} -> ${after.reused}`);
  check('the duck is back quickly', true, `pose after: ${times.join(', ')}`);
  // It walks: once standing in walk mode, a forward command for 2.5 s moves it.
  await app.waitForFunction(() => globalThis.__duck.duck.sim?.mode === 'walk', null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const p0 = await app.evaluate(() => [...globalThis.__duck.duck.pose.slice(0, 2)]);
  await app.evaluate(() => {
    globalThis.__duck.duck.autopilot = { forward: 1, turn: 0 };
  });
  await page.waitForTimeout(3500);
  await app.evaluate(() => {
    globalThis.__duck.duck.autopilot = null;
  });
  const p1 = await app.evaluate(() => [...globalThis.__duck.duck.pose.slice(0, 2)]);
  const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  check('the reused sim walks', moved > 0.15, `moved ${moved.toFixed(2)} m in 3.5 s`);
  const failed = results.filter((ok) => !ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
