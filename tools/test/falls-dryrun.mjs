// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dry run for the demo's hard moment: in an emulated mixed reality session,
 * Pip walks a tight right-hand circle (80% forward, 57% turn, like the falls
 * test case from the headset) until two falls save a test case, or 45 s.
 * Also lists the emulated room's top-level objects (name, centre, size), so
 * decoration that is not in the room scan can be spotted.
 *
 *   bash tools/test/mr.sh tools/test/falls-dryrun.mjs 14
 */
export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  await app.waitForFunction(() => /woke|ready/i.test(globalThis.__duck.duck.status), null, { timeout: 40000 }).catch(() => {});
  const room = await app.evaluate(() => {
    const root = globalThis.IWER_MCP?.device?.sem?.sceneEnvironment?.root;
    if (!root) return 'no emulated room';
    const V = globalThis.__duck.world.scene.position.constructor;
    const out = [];
    const box = (o) => {
      let lo = [Infinity, Infinity, Infinity];
      let hi = [-Infinity, -Infinity, -Infinity];
      o.updateWorldMatrix(true, true);
      o.traverse((m) => {
        if (!m.geometry) return;
        m.geometry.computeBoundingBox?.();
        const bb = m.geometry.boundingBox;
        if (!bb) return;
        for (const x of [bb.min.x, bb.max.x])
          for (const y of [bb.min.y, bb.max.y])
            for (const z of [bb.min.z, bb.max.z]) {
              const p = new V(x, y, z).applyMatrix4(m.matrixWorld);
              lo = [Math.min(lo[0], p.x), Math.min(lo[1], p.y), Math.min(lo[2], p.z)];
              hi = [Math.max(hi[0], p.x), Math.max(hi[1], p.y), Math.max(hi[2], p.z)];
            }
      });
      return { lo, hi };
    };
    const walk = (o, depth) => {
      for (const c of o.children) {
        const b = box(c);
        if (Number.isFinite(b.lo[0]) && b.lo[1] < 0.6 && b.hi[1] - b.lo[1] < 1.2) {
          out.push(`${c.name || '?'} x ${b.lo[0].toFixed(2)}..${b.hi[0].toFixed(2)} y ${b.lo[1].toFixed(2)}..${b.hi[1].toFixed(2)} z ${b.lo[2].toFixed(2)}..${b.hi[2].toFixed(2)}`);
        }
        if (depth < 1) walk(c, depth + 1);
      }
    };
    walk(root, 0);
    return out.slice(0, 40);
  });
  console.log(`PASS room objects low on the floor: ${JSON.stringify(room).replace(/"/g, "'")}`);
  const before = await app.evaluate(() => ({ status: globalThis.__duck.duck.status }));
  await app.evaluate(() => {
    globalThis.__duck.duck.autopilot = { forward: 0.8, turn: -0.57 };
  });
  const t0 = Date.now();
  let saved = null;
  const falls0 = await app.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0);
  let falls = 0;
  while (Date.now() - t0 < 45000) {
    const s = await app.evaluate(() => ({ status: globalThis.__duck.duck.status, falls: globalThis.__duck.duck.sim?.stats?.falls ?? 0 }));
    falls = s.falls - falls0;
    if (/test case/i.test(s.status)) {
      saved = s.status;
      break;
    }
    if (falls >= 1 && !saved && process.env.SAVE_AFTER_FALL) {
      await page.waitForTimeout(2500);
      await app.evaluate(() => globalThis.__duck.scenario.capture('manual'));
      await app.waitForFunction(() => /test case/i.test(globalThis.__duck.duck.status), null, { timeout: 10000 }).catch(() => {});
      saved = await app.evaluate(() => globalThis.__duck.duck.status);
      break;
    }
    await page.waitForTimeout(250);
  }
  await app.evaluate(() => {
    globalThis.__duck.duck.autopilot = null;
  });
  console.log(`PASS dry run: ${((Date.now() - t0) / 1000).toFixed(1)} s, falls seen ${falls}, saved: ${saved ?? 'no'} (before: ${before.status})`);
}
