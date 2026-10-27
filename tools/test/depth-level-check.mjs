// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How the duck stands and walks on what the terrain holds, per depth level,
 * in the emulated mixed-reality session (run through tools/test/mr.sh). A 12
 * cm block, 44 cm wide and a metre long, is written under the duck into one
 * layer (depth updates frozen so it stays), the duck is put down on it, its
 * trunk height read once settled, then it walks along the block for 2.5 s:
 *   Filtered, depth layer: hard (the reference)
 *   Fine, depth layer:     soft, so the duck sinks in a little and still walks
 *   Fine, scan layer:      hard, as the room scan's furniture stays
 * The level in use before the check is put back.
 *
 *   bash tools/test/mr.sh tools/test/depth-level-check.mjs
 */
export default async function run({ page, frame }) {
  const target = frame ?? page; // the app lives in the managed window's application frame
  const out = await target.evaluate(async () => {
    const d = globalThis.__duck;
    const t = d.terrain;
    if (!t?.setLevel) return null;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const N = 201;
    const before = t.level;
    const x = d.duck.pose[0];
    const y = d.duck.pose[1];
    const TOP = 0.12;
    const standOn = async (level, layer) => {
      t.setLevel(level);
      await sleep(800); // the sim gets the new extent and feel; the map starts over
      t.frozen = true;
      const map = layer === 'scan' ? t.scanHeights : t.heights;
      t.heights.fill(-1);
      const C = t.cell;
      const H = t.half;
      const col = Math.round((x - 1.2 + H) / C);
      const row = Math.round((y + H) / C);
      const wide = Math.round(0.22 / C);
      const along = Math.round(0.5 / C);
      for (let r = row - wide; r <= row + wide; r++) for (let c = col - along; c <= col + along; c++) map[r * N + c] = TOP;
      t.touch();
      await sleep(400);
      d.duck.sim.teleport(x, y, 0, 0, TOP + 0.13);
      await sleep(3000);
      const trunk = d.duck.pose[2];
      const standing = d.duck.sim.mode;
      // Walk along the block (2.5 s at a slow walk stays well inside its half metre).
      d.duck.autopilot = { forward: 1, turn: 0 };
      let fell = false;
      for (let k = 0; k < 25; k++) {
        await sleep(100);
        if (d.duck.sim.mode !== 'walk') fell = true;
      }
      d.duck.autopilot = null;
      t.heights.fill(-1);
      t.roomVersion = -1; // redraw the scan's colliders over the block
      t.frozen = false;
      t.touch();
      d.duck.sim.teleport(x, y, 0, 0, 0.13);
      await sleep(1500);
      return { level, layer, trunk, standing, fell, cell: C };
    };
    const hard = await standOn('filtered', 'depth');
    const soft = await standOn('fine', 'depth');
    const scan = await standOn('fine', 'scan');
    t.setLevel(before);
    await sleep(600);
    return { hard, soft, scan, before, restored: t.level };
  });
  if (!out) throw new Error('no __duck.terrain.setLevel on the page (dev build with the depth levels)');
  const cm = (v) => (v * 100).toFixed(2);
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} - ${detail}`);
  };
  const sink = out.hard.trunk - out.soft.trunk;
  check('stands and walks on a sensed block (hard)', out.hard.trunk > 0.2 && out.hard.standing === 'walk' && !out.hard.fell, `trunk ${cm(out.hard.trunk)} cm, ${out.hard.fell ? 'fell walking' : 'walked'}`);
  check(
    'sinks a little into the soft depth layer and still walks',
    sink > 0.0015 && sink < 0.015 && out.soft.standing === 'walk' && !out.soft.fell,
    `${cm(sink)} cm lower at Fine, ${out.soft.fell ? 'fell walking' : 'walked'}, cells ${cm(out.soft.cell)} cm`,
  );
  check('the scan layer stays hard at Fine', Math.abs(out.scan.trunk - out.hard.trunk) < 0.001 && !out.scan.fell, `${cm(out.scan.trunk - out.hard.trunk)} cm from the hard reference`);
  check('the level in use is put back', out.restored === out.before, `level ${out.restored} (was ${out.before})`);
  const passed = results.filter(Boolean).length;
  console.log(JSON.stringify({ passed, failed: results.length - passed }));
  return { passed, failed: results.length - passed, out };
}
