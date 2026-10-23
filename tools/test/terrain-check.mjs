// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Mixed-reality physics check on the emulator, run through the managed
 * browser (`npx @iwsdk/cli browser run tools/test/terrain-check.mjs`; the
 * dev server needs --allow-browser-automation). Expects an immersive-ar
 * session to be active already (`npx @iwsdk/cli xr enter`).
 *
 * Checks that the room scan became colliders, that the depth sensor filled
 * the terrain, and that the duck can stand on something the scan found:
 * it is teleported onto the tallest raised cell and must settle high.
 */
export default async function run({ page, frame }) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const target = frame ?? page; // the app lives in the managed window's application frame
  const state = () =>
    target.evaluate(() => {
      const d = globalThis.__duck;
      if (!d) return null;
      const terrain = d.terrain;
      // The best landing spot: a plateau (5x5 cells, 20 cm) between 10 and 50 cm high, from depth or scan.
      const N = 201;
      const heights = terrain.heights;
      const scan = terrain.scanHeights;
      const at = (i) => Math.max(heights[i], scan[i]);
      let tallest = 0;
      let tallestIndex = -1;
      for (let row = 2; row < N - 2; row++) {
        for (let col = 2; col < N - 2; col++) {
          let low = Infinity;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              low = Math.min(low, at((row + dr) * N + col + dc));
            }
          }
          if (low > tallest && low < 0.5) {
            tallest = low;
            tallestIndex = row * N + col;
          }
        }
      }
      // The first scanned ridge along +x from the start line (row of y = 0): a wall to walk into.
      let wallX = null;
      for (let col = Math.round((0.3 + 4) / 0.04); col < N; col++) {
        const i = Math.round(4 / 0.04) * N + col;
        if (scan[i] >= 0.3) {
          wallX = 1.2 - 4 + col * 0.04;
          break;
        }
      }
      // Do the sensor and the scan agree? Depth cells taller than 30 cm should sit on or next to a scan ridge.
      let depthTall = 0;
      let agreeing = 0;
      for (let row = 2; row < N - 2; row++) {
        for (let col = 2; col < N - 2; col++) {
          if (heights[row * N + col] < 0.3) continue;
          depthTall++;
          let near = false;
          for (let dr = -2; dr <= 2 && !near; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              if (terrain.scanHeights[(row + dr) * N + col + dc] > 0) {
                near = true;
                break;
              }
            }
          }
          if (near) agreeing++;
        }
      }
      const sim = d.duck.sim;
      return {
        depthTall,
        agreeing,
        wallX,
        duckX: d.duck.hasPose ? d.duck.pose[0] : null,
        session: d.world.session ? d.world.session.environmentBlendMode : null,
        depthUsage: d.world.session ? d.world.session.depthUsage ?? null : null,
        roomState: d.room.state,
        roomSummary: d.room.physicsSummary,
        roomColliders: d.room.roomColliders.length,
        scanCells: terrain.scanCells,
        terrain: terrain.summary,
        active: terrain.active,
        raised: terrain.raised,
        tallest,
        tallestIndex,
        ngeom: sim && sim.ready ? sim.ready.ngeom : -1,
        duckHeight: d.duck.hasPose ? d.duck.pose[2] : null,
        mode: sim ? sim.mode : null,
      };
    });
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };

  let s = await state();
  if (!s) throw new Error('no __duck test hook on the page (dev build only)');
  // Give the scan, the placement and a few depth frames time to arrive.
  for (let i = 0; i < 20 && (!s.active || s.raised === 0 || s.roomColliders === 0); i++) {
    await wait(500);
    s = await state();
  }
  check('mixed reality session', s.session === 'alpha-blend' || s.session === 'additive', `blend ${s.session}, depth ${s.depthUsage}`);
  check('room colliders in the terrain', s.roomColliders > 0 && s.scanCells > 0, `${s.roomColliders} colliders (${s.roomSummary}) -> ${s.scanCells} cells, ngeom ${s.ngeom}`);
  check('terrain from depth', s.active && s.raised > 0, s.terrain);
  check(
    'depth agrees with the scan',
    s.depthTall > 0 && s.agreeing / s.depthTall > 0.6,
    `${s.agreeing} of ${s.depthTall} tall depth cells touch a scanned wall or furniture (${s.depthTall ? ((100 * s.agreeing) / s.depthTall).toFixed(0) : 0}%)`,
  );

  // Stand the duck on something the sensor found: the tallest flat spot, or,
  // when the room has none (the emulated living room has only walls and tall
  // furniture), a 28 cm wide, 15 cm tall block written into the map as the
  // sensor would, with depth updates frozen so the block is not carved away.
  let standX;
  let standY;
  let standH = s.tallest;
  if (s.tallest > 0.1) {
    const N = 201;
    standX = 1.2 - 4 + (s.tallestIndex % N) * 0.04;
    standY = 0 - 4 + Math.floor(s.tallestIndex / N) * 0.04;
  } else {
    standX = 0.6;
    standY = 0.55;
    standH = 0.15;
    await target.evaluate(
      ([x, y, h]) => {
        const t = globalThis.__duck.terrain;
        t.frozen = true;
        const N = 201;
        const col = Math.round((x - 1.2 + 4) / 0.04);
        const row = Math.round((y + 4) / 0.04);
        for (let r = row - 5; r <= row + 5; r++) for (let c = col - 5; c <= col + 5; c++) t.heights[r * N + c] = h;
        t.touch();
      },
      [standX, standY, standH],
    );
    await wait(600);
  }
  // Put it down standing on the surface (the trunk stands 0.12 m over whatever it is on).
  await target.evaluate(
    ([x, y, h]) => {
      globalThis.__duck.duck.sim.teleport(x, y, 0, 0, h + 0.12);
    },
    [standX, standY, standH],
  );
  await wait(2500);
  const stood = await state();
  check(
    'duck stays up on a sensed object',
    // Supported by the block: the trunk sits at least 3 cm over its top (standing
    // gives about 12, lying on it about 4-6); beside it the trunk is at 0.12 m or lower.
    stood.duckHeight !== null && stood.duckHeight > standH + 0.03,
    `block ${standH.toFixed(2)} m wide 44 cm at (${standX.toFixed(2)}, ${standY.toFixed(2)}); duck trunk at ${stood.duckHeight?.toFixed(2)} m (0.12 on the floor), ${stood.mode}`,
  );
  if (s.tallest <= 0.1) {
    await target.evaluate(() => {
      const t = globalThis.__duck.terrain;
      t.heights.fill(-1);
      t.frozen = false;
      t.touch();
    });
  }

  // Walk into a scanned wall: the duck must not pass through it.
  if (s.wallX !== null) {
    const startX = s.wallX - 0.45;
    await target.evaluate(
      ([x]) => {
        const d = globalThis.__duck;
        d.duck.sim.teleport(x, 0, 0, 0);
        d.duck.autopilot = { forward: 1, turn: 0 };
      },
      [startX],
    );
    await wait(5000);
    const after = await state();
    await target.evaluate(() => {
      globalThis.__duck.duck.autopilot = null;
    });
    check(
      'scanned wall stops the duck',
      after.duckX !== null && after.duckX < s.wallX + 0.02 && after.duckX > startX + 0.1,
      `wall at x=${s.wallX.toFixed(2)}, started at ${startX.toFixed(2)}, duck at ${after.duckX?.toFixed(2)} after 5 s walking (${after.mode})`,
    );
  } else {
    check('scanned wall stops the duck', false, 'no scanned wall along the course axis');
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  return results;
}
