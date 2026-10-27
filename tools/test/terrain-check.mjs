// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Mixed-reality physics check on the emulator, run through the managed
 * browser (`npx @iwsdk/cli browser run tools/test/terrain-check.mjs`; the
 * dev server needs --allow-browser-automation). Expects an immersive-ar
 * session to be active already (`npx @iwsdk/cli xr enter`).
 *
 * Checks that the session uses GPU depth (the Quest's code path), that the
 * room scan became colliders, that the depth sensor filled the terrain, that
 * the duck can stand on something the sensor found (teleported onto the
 * tallest raised cell, it must settle high), that a scanned wall stops it, and
 * that a block only the depth sensor knows about stops it too.
 */
export default async function run({ page, frame }) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const target = frame ?? page; // the app lives in the managed window's application frame
  const state = () =>
    target.evaluate(() => {
      const d = globalThis.__duck;
      if (!d) return null;
      const terrain = d.terrain;
      // The best landing spot: a plateau (5x5 cells) between 10 and 50 cm high, from depth or scan.
      const N = 201;
      const C = terrain.cell; // metres per cell and from the centre to the edge, as in use
      const H = terrain.half;
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
      for (let col = Math.round((0.3 + H) / C); col < N; col++) {
        const i = Math.round(H / C) * N + col;
        if (scan[i] >= 0.3) {
          wallX = 1.2 - H + col * C;
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
      let depthRaised = 0;
      for (let i = 0; i < N * N; i++) if (heights[i] >= 0.025) depthRaised++;
      return {
        depthRaised,
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
        cell: C,
        half: H,
        level: terrain.level,
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
  for (let i = 0; i < 20 && (!s.active || s.depthRaised === 0 || s.roomColliders === 0); i++) {
    await wait(500);
    s = await state();
  }
  check('mixed reality session', s.session === 'alpha-blend' || s.session === 'additive', `blend ${s.session}, depth ${s.depthUsage}`);
  check('GPU depth, as on the Quest', s.depthUsage === 'gpu-optimized', `depth usage ${s.depthUsage}`);
  check('room colliders in the terrain', s.roomColliders > 0 && s.scanCells > 0, `${s.roomColliders} colliders (${s.roomSummary}) -> ${s.scanCells} cells, ngeom ${s.ngeom}`);
  check('terrain from depth', s.active && s.depthRaised > 0, `${s.depthRaised} cells raised by the depth sensor at level ${s.level} (${Math.round(s.cell * 100)} cm cells); ${s.terrain}`);
  check(
    'depth agrees with the scan',
    s.depthTall > 0 && s.agreeing / s.depthTall > 0.6,
    `${s.agreeing} of ${s.depthTall} tall depth cells touch a scanned wall or furniture (${s.depthTall ? ((100 * s.agreeing) / s.depthTall).toFixed(0) : 0}%)`,
  );

  // The room scan's mesh seeds the map before the sensor has looked around: re-seed from it alone.
  const seed = await target.evaluate(async () => {
    const d = globalThis.__duck;
    const t = d.terrain;
    const mesh = d.room.globalMesh();
    t.frozen = true;
    t.heights.fill(-1);
    t.seeded = false; // seeds again on the next update
    t.touch();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const N = 201;
    let raised = 0;
    let isolated = 0;
    for (let row = 1; row < N - 1; row++) {
      for (let col = 1; col < N - 1; col++) {
        if (!(t.heights[row * N + col] >= 0.025)) continue;
        raised++;
        let near = 0;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (t.heights[(row + dr) * N + col + dc] >= 0.025) near++;
        if (near === 0) isolated++;
      }
    }
    t.frozen = false;
    return { triangles: mesh?.geometry.index ? mesh.geometry.index.count / 3 : 0, raised, isolated };
  });
  check(
    'the room mesh seeds the map',
    seed.triangles > 0 && seed.raised > 500 && seed.isolated < 0.05 * seed.raised,
    `${seed.triangles} triangles -> ${seed.raised} raised cells, ${seed.isolated} on their own`,
  );

  // Pip cam draws every raised cell (neighbours merged into blocks), not just the first few thousand.
  const cam = await target.evaluate(async () => {
    const d = globalThis.__duck;
    const t = d.terrain;
    t.frozen = true;
    const blocks = t.blocksForCam(d.duck.stageEntity);
    t.touch();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const N = 201;
    let raised = 0;
    for (let i = 0; i < N * N; i++) if (Math.max(t.heights[i], t.scanHeights[i]) >= 0.025) raised++;
    let covered = 0;
    const m = blocks ? blocks.instanceMatrix.array : [];
    for (let k = 0; k < (blocks ? blocks.count : 0); k++) covered += Math.round(m[k * 16] / t.cell + 0.1);
    t.frozen = false;
    return { raised, covered, count: blocks ? blocks.count : 0 };
  });
  check('Pip cam shows every raised cell', cam.raised > 0 && cam.covered === cam.raised, `${cam.covered} of ${cam.raised} raised cells in ${cam.count} blocks`);

  // Stand the duck on something the sensor found: the tallest flat spot, or,
  // when the room has none (the emulated living room has only walls and tall
  // furniture), a 28 cm wide, 15 cm tall block written into the map as the
  // sensor would, with depth updates frozen so the block is not carved away.
  let standX;
  let standY;
  let standH = s.tallest;
  if (s.tallest > 0.1) {
    const N = 201;
    standX = 1.2 - s.half + (s.tallestIndex % N) * s.cell;
    standY = 0 - s.half + Math.floor(s.tallestIndex / N) * s.cell;
  } else {
    standX = 0.6;
    standY = 0.55;
    standH = 0.15;
    await target.evaluate(
      ([x, y, h]) => {
        const t = globalThis.__duck.terrain;
        t.frozen = true;
        const N = 201;
        const col = Math.round((x - 1.2 + t.half) / t.cell);
        const row = Math.round((y + t.half) / t.cell);
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

  // A block only the depth sensor knows (nothing from the scan there) must stop
  // the duck too. In Your Room (no course pieces in the way), on open floor:
  // one walk without the block, one into a 15 cm block written into the map.
  const playground = await target.evaluate(() => globalThis.__duck.playgrounds.current);
  await target.evaluate(() => globalThis.__duck.playgrounds.load('free-roam'));
  let roaming = false;
  for (let i = 0; i < 40 && !roaming; i++) {
    await wait(500);
    roaming = await target.evaluate(() => {
      const d = globalThis.__duck;
      return d.playgrounds.current === 'free-roam' && !d.playgrounds.loading && d.duck.hasPose && !!d.duck.sim?.ready && d.terrain.active;
    });
  }
  await wait(1500);
  // Open floor near the duck: 1.5 m along +x, 0.9 m wide, nothing from the scan.
  const spot = roaming
    ? await target.evaluate(() => {
        const d = globalThis.__duck;
        const N = 201;
        const scan = d.terrain.scanHeights;
        const C = d.terrain.cell;
        const H = d.terrain.half;
        const cell = (x, y) => Math.round((y + H) / C) * N + Math.round((x - 1.2 + H) / C);
        const px = d.duck.pose[0];
        const py = d.duck.pose[1];
        let best = null;
        for (let sx = px - 2; sx <= px + 2; sx += 0.1) {
          for (let sy = py - 2; sy <= py + 2; sy += 0.1) {
            let clear = true;
            for (let x = sx - 0.3; x <= sx + 1.2 && clear; x += C) {
              for (let y = sy - 0.45; y <= sy + 0.45; y += C) {
                const i = cell(x, y);
                if (i < 0 || i >= N * N || scan[i] > 0) {
                  clear = false;
                  break;
                }
              }
            }
            const dist = Math.hypot(sx - px, sy - py);
            if (clear && (!best || dist < best.dist)) best = { sx, sy, dist };
          }
        }
        return best;
      })
    : null;
  if (spot) {
    const walk = (h) =>
      target.evaluate(
        async ([sx, sy, h]) => {
          const d = globalThis.__duck;
          const t = d.terrain;
          const N = 201;
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          t.frozen = true;
          t.heights.fill(-1);
          t.touch();
          d.duck.sim.teleport(sx, sy, 0);
          await sleep(2500);
          // 20 cm deep, 60 cm wide, 45 cm in front of the duck.
          const x0 = sx + 0.45;
          const x1 = sx + 0.65;
          if (h > 0) {
            const c0 = Math.round((x0 - 1.2 + t.half) / t.cell);
            const c1 = Math.round((x1 - 1.2 + t.half) / t.cell);
            const r0 = Math.round((sy - 0.3 + t.half) / t.cell);
            const r1 = Math.round((sy + 0.3 + t.half) / t.cell);
            for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) t.heights[r * N + c] = h;
            t.touch();
          }
          await sleep(800);
          d.duck.autopilot = { forward: 1, turn: 0 };
          let maxX = -Infinity;
          let maxZ = 0;
          for (let k = 0; k < 24; k++) {
            await sleep(250);
            maxX = Math.max(maxX, d.duck.pose[0]);
            maxZ = Math.max(maxZ, d.duck.pose[2]);
          }
          d.duck.autopilot = null;
          return { x0, maxX, maxZ };
        },
        [spot.sx, spot.sy, h],
      );
    const open = await walk(0);
    const blocked = await walk(0.15);
    await target.evaluate(() => {
      const t = globalThis.__duck.terrain;
      t.heights.fill(-1);
      t.frozen = false;
      t.touch();
    });
    const stopped = blocked.maxX < blocked.x0 + 0.02 || blocked.maxZ > 0.2;
    check(
      'a block only the depth sensor knows stops the duck',
      open.maxX > open.x0 + 0.05 && stopped,
      `block face at x=${blocked.x0.toFixed(2)}: on open floor the duck reached ${open.maxX.toFixed(2)}, with the 15 cm block ${blocked.maxX.toFixed(2)} (trunk up to ${blocked.maxZ.toFixed(2)} m)`,
    );
  } else {
    check('a block only the depth sensor knows stops the duck', false, roaming ? 'no open floor near the duck' : 'Your Room did not load');
  }
  if (playground && playground !== 'free-roam') await target.evaluate((id) => globalThis.__duck.playgrounds.load(id), playground);

  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  return results;
}
