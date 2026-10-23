// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Prints the scanned walls (centre, normal, size) and the robot panel's bar,
 * and the nearest wall to the bar, inside an emulated mixed reality session.
 *
 *   bash tools/test/mr.sh tools/test/walls-probe.mjs 14
 */
export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  await page.waitForTimeout(2000);
  const r = await app.evaluate(() => {
    const d = globalThis.__duck;
    const room = d.room;
    const V = d.world.scene.position.constructor;
    const round = (v) => v.toArray().map((n) => Math.round(n * 100) / 100);
    const walls = [];
    for (const entity of room.queries.planes.entities) {
      const object = entity.object3D;
      const plane = [...d.world.session ? [] : []];
      if (!object) continue;
      const p = object.getWorldPosition(new V());
      const n = new V(0, 1, 0).transformDirection(object.matrixWorld);
      if (Math.abs(n.y) > 0.5) continue;
      walls.push(`c ${round(p)} n ${round(n)}`);
    }
    const bar = d.world.scene.getObjectByName('robot-panel-bar');
    const b = bar.getWorldPosition(new V());
    const point = new V();
    const normal = new V();
    const near = room.nearestWall(b, 5, point, normal);
    return { walls, bar: round(b), near, point: round(point), normal: round(normal), head: round(d.world.player.head.getWorldPosition(new V())) };
  });
  console.log(`PASS walls ${JSON.stringify(r).replace(/"/g, "'")}`);
}
