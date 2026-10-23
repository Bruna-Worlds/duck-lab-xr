// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The room mesh fills the terrain map (src/room/mesh-heights.ts), checked on
 * exact shapes in the page (the dev server compiles the module); terrain-check
 * seeds the map from the emulated room's own mesh.
 *
 *   npx @iwsdk/cli browser run tools/test/mesh-heights-check.mjs
 */
export default async function run({ page, frame }) {
  const target = frame ?? page;
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };

  const r = await target.evaluate(async () => {
    const { rasteriseMeshHeights } = await import('/src/room/mesh-heights.ts');
    const N = 201;
    const cellX = (col) => 1.2 - 4 + col * 0.04; // stage x
    const cellZ = (row) => -(-4 + row * 0.04); // three.js z (MuJoCo y = -z)
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const quad = [0, 1, 2, 0, 2, 3];

    // A box 30 cm along x, 40 cm along z, 20 cm tall: 8 corners, 12 triangles.
    const [x0, x1, z0, z1, h] = [0.85, 1.15, -0.7, -0.3, 0.2];
    const box = new Float32Array([
      x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1,
      x0, h, z0, x1, h, z0, x1, h, z1, x0, h, z1,
    ]);
    const boxIndex = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
    const heights = new Float32Array(N * N).fill(-1);
    const raised = rasteriseMeshHeights(box, boxIndex, identity, heights);
    const inFoot = (col, row, slack) =>
      cellX(col) >= x0 - slack && cellX(col) <= x1 + slack && cellZ(row) >= z0 - slack && cellZ(row) <= z1 + slack;
    let expected = 0;
    let inside = 0;
    let atTop = 0;
    let outside = 0;
    for (let row = 0; row < N; row++) {
      for (let col = 0; col < N; col++) {
        const v = heights[row * N + col];
        if (inFoot(col, row, 0.0199)) expected++;
        if (!(v >= 0.025)) continue;
        if (inFoot(col, row, 0.021)) {
          inside++;
          if (v > h - 0.005) atTop++;
        } else outside++;
      }
    }
    // Reading only the vertices, as before: the four top corners.
    let corners = 0;
    for (let v = 0; v < 8; v++) if (box[v * 3 + 1] >= 0.025 && box[v * 3 + 1] <= 0.55) corners++;

    // A 2 m floor and a table top at 75 cm add nothing; a 2.5 m wall becomes a ridge up to the cap.
    const room = new Float32Array(N * N).fill(-1);
    const floor = new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, -2, 0, 0, -2]);
    const table = floor.map((v, i) => (i % 3 === 1 ? 0.75 : v));
    const wall = new Float32Array([0, 0, -2, 2, 0, -2, 2, 2.5, -2, 0, 2.5, -2]);
    const floorRaised = rasteriseMeshHeights(floor, quad, identity, room);
    const tableRaised = rasteriseMeshHeights(table, quad, identity, room);
    const wallRaised = rasteriseMeshHeights(wall, quad, identity, room);
    let ridgeLow = Infinity;
    let ridgeHigh = 0;
    for (const v of room) {
      if (v < 0.025) continue;
      ridgeLow = Math.min(ridgeLow, v);
      ridgeHigh = Math.max(ridgeHigh, v);
    }
    return { raised, expected, inside, atTop, outside, corners, floorRaised, tableRaised, wallRaised, ridgeLow, ridgeHigh };
  });

  check(
    'a box fills its footprint',
    r.inside >= 0.9 * r.expected && r.atTop === r.inside,
    `${r.inside} of ${r.expected} cells under a 30 x 40 cm box raised, ${r.atTop} at its 20 cm top (the vertices alone gave ${r.corners} corner cells)`,
  );
  check('nothing raised outside the box', r.outside === 0, `${r.outside} cells outside`);
  check('the floor and a table top add nothing', r.floorRaised === 0 && r.tableRaised === 0, `floor ${r.floorRaised}, table ${r.tableRaised}`);
  check(
    'a wall becomes a ridge up to the cap',
    r.wallRaised >= 50 && r.ridgeHigh <= 0.55 && r.ridgeLow > 0.5,
    `${r.wallRaised} cells, ${r.ridgeLow.toFixed(3)} to ${r.ridgeHigh.toFixed(3)} m`,
  );
  const failed = results.filter((ok) => !ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  return results;
}
