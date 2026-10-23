// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Lists the room scan in an emulated mixed reality session: each scanned
 * mesh (label, centre, size) and plane, the course stage, and the sensed
 * terrain blocks near a point (TERRAIN_AT="x,z", default the duck), so a
 * floor object like the emulated room's robot vacuum can be checked against
 * the scan and the depth.
 *
 *   bash tools/test/mr.sh tools/test/room-probe.mjs 14
 */
export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  await page.waitForTimeout(3000);
  const r = await app.evaluate(
    () =>
      new Promise((resolve) => {
        const d = globalThis.__duck;
        const V = d.world.scene.position.constructor;
        const round = (v) => v.toArray().map((n) => Math.round(n * 100) / 100);
        d.world.session.requestAnimationFrame((t, f) => {
          const space = d.world.renderer.xr.getReferenceSpace();
          const meshes = [...(f.detectedMeshes ?? [])].map((m) => {
            const pose = f.getPose(m.meshSpace, space);
            const v = m.vertices;
            let lo = [Infinity, Infinity, Infinity];
            let hi = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < v.length; i += 3) {
              for (let k = 0; k < 3; k++) {
                lo[k] = Math.min(lo[k], v[i + k]);
                hi[k] = Math.max(hi[k], v[i + k]);
              }
            }
            const p = pose ? pose.transform.position : { x: 0, y: 0, z: 0 };
            return `${m.semanticLabel ?? '?'} at ${[p.x, p.y, p.z].map((n) => n.toFixed(2))} size ${hi.map((h, k) => (h - lo[k]).toFixed(2))}`;
          });
          const stage = d.duck.stageEntity?.object3D;
          const duck = d.duck.rig?.trunk;
          resolve({
            meshes,
            stage: stage ? round(stage.getWorldPosition(new V())) : null,
            duck: duck ? round(duck.getWorldPosition(new V())) : null,
            terrain: d.terrain?.status ?? d.terrain?.summary ?? null,
          });
        });
      }),
  );
  console.log(`PASS room ${JSON.stringify(r).replace(/"/g, "'")}`);
}
