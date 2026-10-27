// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How true the depth-built terrain is, on a synthetic scene put through the
 * app's own filters (TerrainSystem.probe; docs/microduck/DEPTH.md): a box of
 * 60 x 50 x 15 cm (about a dog bed) on the floor, seen from a standing
 * person's eyes as a 128 x 96 depth image (about what the Quest's GPU depth
 * gives after the readback), over 12 updates while the head sways a little.
 * The emulator's own depth is perfect, so the noise (1 cm per metre) and the
 * smearing of every edge into in-between depths that real sensors add are
 * made here. Measured per run:
 *   hover    how far the box's top sits above 15 cm (median over its cells)
 *   coverage share of the box's cells raised
 *   skirt    raised cells just outside the box (within 30 cm), and how far out
 *   floor    raised cells on open floor further away (noise bumps)
 * Runs: clean depth (old rule, new rule), then noisy smeared depth with the
 * old rule, each filter alone, and all of them (the app); then the same noisy
 * depth from 1.2 m (leaning in), where every cell gets many points and the
 * old "highest point" rule lifts surfaces the most.
 *
 *   npx @iwsdk/cli browser run tools/test/depth-quality-check.mjs
 * (no XR session needed; the dev server needs --allow-browser-automation)
 */
export default async function run({ page, frame }) {
  const target = frame ?? page; // the app lives in the managed window's application frame
  const out = await target.evaluate(() => {
    const terrain = globalThis.__duck?.terrain;
    if (!terrain?.probe) return null;
    const N = 201;
    const CX = 1.2; // the field's centre, stage x
    const BOX = { x0: 0.9, x1: 1.5, z0: -0.25, z1: 0.25, h: 0.15 }; // stage frame, three.js axes (y up)
    const W = 128;
    const H = 96;
    const ty = Math.tan((70 * Math.PI) / 180 / 2);
    const tx = ty * (W / H);
    const zn = 0.1;
    const zf = 20;
    const projection = [1 / tx, 0, 0, 0, 0, 1 / ty, 0, 0, 0, 0, (zf + zn) / (zn - zf), -1, 0, 0, (2 * zf * zn) / (zn - zf), 0];
    let seed = 7;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    /** View -> stage (column-major) for an eye at e looking at l. */
    const pose = (e, l) => {
      let fx = l[0] - e[0];
      let fy = l[1] - e[1];
      let fz = l[2] - e[2];
      const fl = Math.hypot(fx, fy, fz);
      fx /= fl;
      fy /= fl;
      fz /= fl;
      const rl = Math.hypot(fz, fx);
      const rx = -fz / rl;
      const rz = fx / rl;
      const ux = -rz * fy;
      const uy = rz * fx - rx * fz;
      const uz = rx * fy;
      return [rx, 0, rz, 0, ux, uy, uz, 0, -fx, -fy, -fz, 0, e[0], e[1], e[2], 1];
    };
    /** Distance along the ray (o + t d) to the floor or the box, whichever is nearer; 0 for none. */
    const hit = (o, d) => {
      let best = Infinity;
      if (d[1] < 0) best = -o[1] / d[1];
      let t0 = -Infinity;
      let t1 = Infinity;
      const lo = [BOX.x0, 0, BOX.z0];
      const hi = [BOX.x1, BOX.h, BOX.z1];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-12) {
          if (o[a] < lo[a] || o[a] > hi[a]) t0 = Infinity;
          continue;
        }
        let ta = (lo[a] - o[a]) / d[a];
        let tb = (hi[a] - o[a]) / d[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (t0 <= t1 && t0 > 0) best = Math.min(best, t0);
      return Number.isFinite(best) ? best : 0;
    };
    const render = (k, noisy, close = false) => {
      const e = close
        ? [0.45 + 0.04 * Math.sin(k * 0.7), 1.1 + 0.02 * Math.cos(k * 1.3), 0.15 * Math.sin(k * 0.5)]
        : [-0.25 + 0.05 * Math.sin(k * 0.7), 1.6 + 0.02 * Math.cos(k * 1.3), 0.2 * Math.sin(k * 0.5)];
      const m = pose(e, [1.2, 0.05, 0.03 * Math.cos(k)]);
      const depth = new Float32Array(W * H);
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          const vx = ((2 * (c + 0.5)) / W - 1) * tx;
          const vy = (1 - (2 * (r + 0.5)) / H) * ty;
          const d = [m[0] * vx + m[4] * vy - m[8], m[1] * vx + m[5] * vy - m[9], m[2] * vx + m[6] * vy - m[10]];
          depth[r * W + c] = hit(e, d); // the view vector has z = -1, so t is the view depth
        }
      }
      if (!noisy) return { width: W, height: H, metres: depth, projection, sensorToStage: m };
      // Real sensors smear edges: a 3 x 3 average puts in-between depths on every edge. Then noise.
      const smeared = new Float32Array(W * H);
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          if (!(depth[r * W + c] > 0)) continue;
          let sum = 0;
          let count = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
              const v = depth[rr * W + cc];
              if (v > 0) {
                sum += v;
                count++;
              }
            }
          }
          const v = sum / count;
          smeared[r * W + c] = v + gauss() * 0.01 * v;
        }
      }
      return { width: W, height: H, metres: smeared, projection, sensorToStage: m };
    };
    const clean = [];
    const noisy = [];
    const close = [];
    for (let k = 0; k < 12; k++) {
      clean.push(render(k, false));
      noisy.push(render(k, true));
      close.push(render(k, true, true));
    }
    const measure = ({ heights, kept, dropped, cell }) => {
      const CELL = cell; // the probe says which cell size it binned at (4 cm, or 3 cm at Fine)
      const HALF = (cell * (N - 1)) / 2;
      const inside = [];
      let insideCells = 0;
      let raisedInside = 0;
      let skirt = 0;
      let reach = 0;
      let floor = 0;
      for (let row = 0; row < N; row++) {
        for (let col = 0; col < N; col++) {
          const x = CX - HALF + col * CELL;
          const z = -(-HALF + row * CELL); // MuJoCo y = -three z
          const h = heights[row * N + col];
          const inX = x >= BOX.x0 + CELL / 2 && x <= BOX.x1 - CELL / 2;
          const inZ = z >= BOX.z0 + CELL / 2 && z <= BOX.z1 - CELL / 2;
          if (inX && inZ) {
            insideCells++;
            if (h >= 0) inside.push(h - BOX.h);
            if (h >= 0.025) raisedInside++;
            continue;
          }
          const outside = x < BOX.x0 - CELL / 2 || x > BOX.x1 + CELL / 2 || z < BOX.z0 - CELL / 2 || z > BOX.z1 + CELL / 2;
          if (!outside || !(h >= 0.025)) continue;
          const dist = Math.hypot(Math.max(BOX.x0 - x, 0, x - BOX.x1), Math.max(BOX.z0 - z, 0, z - BOX.z1));
          if (dist <= 0.3) {
            skirt++;
            reach = Math.max(reach, dist);
          } else {
            floor++;
          }
        }
      }
      inside.sort((a, b) => a - b);
      const hover = inside.length ? inside[Math.floor(inside.length / 2)] : NaN;
      return {
        hoverCm: +(hover * 100).toFixed(1),
        coverage: +(raisedInside / insideCells).toFixed(2),
        skirt,
        reachCm: Math.round(reach * 100),
        floor,
        edgeOnPct: kept + dropped ? Math.round((100 * dropped) / (kept + dropped)) : 0,
      };
    };
    const OFF = { edgeOn: false, robust: false, confidence: false };
    return {
      'clean, old rule': measure(terrain.probe(clean, OFF)),
      'clean, new rule': measure(terrain.probe(clean)),
      'noisy, old rule': measure(terrain.probe(noisy, OFF)),
      'noisy, edge-on only': measure(terrain.probe(noisy, { ...OFF, edgeOn: true })),
      'noisy, robust cells only': measure(terrain.probe(noisy, { ...OFF, robust: true })),
      'noisy, confidence only': measure(terrain.probe(noisy, { ...OFF, confidence: true })),
      'noisy, new rule': measure(terrain.probe(noisy)),
      'close noisy, old rule': measure(terrain.probe(close, OFF)),
      'close noisy, new rule': measure(terrain.probe(close)),
      'noisy, Fine (3 cm)': measure(terrain.probe(noisy, {}, 3)),
      'close noisy, Fine (3 cm)': measure(terrain.probe(close, {}, 3)),
    };
  });
  if (!out) throw new Error('no __duck.terrain.probe on the page (dev build with the new terrain filters)');
  console.log('run                          hover cm  coverage  skirt (reach cm)  floor bumps  edge-on %');
  for (const [name, r] of Object.entries(out)) {
    console.log(
      `${name.padEnd(28)} ${String(r.hoverCm).padStart(8)}  ${String(r.coverage).padStart(8)}  ${String(r.skirt).padStart(5)} (${String(r.reachCm).padStart(2)})        ${String(r.floor).padStart(5)}  ${String(r.edgeOnPct).padStart(9)}`,
    );
  }
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} - ${detail}`);
  };
  const cleanNew = out['clean, new rule'];
  const old = out['noisy, old rule'];
  const now = out['noisy, new rule'];
  check('clean depth stays true', Math.abs(cleanNew.hoverCm) <= 1 && cleanNew.coverage >= 0.9 && cleanNew.skirt <= 4 && cleanNew.floor === 0, JSON.stringify(cleanNew));
  const closeOld = out['close noisy, old rule'];
  const closeNow = out['close noisy, new rule'];
  check('less hover close up', Math.abs(closeNow.hoverCm) < Math.abs(closeOld.hoverCm) && Math.abs(closeNow.hoverCm) <= 1, `${closeOld.hoverCm} cm -> ${closeNow.hoverCm} cm (from 2 m: ${old.hoverCm} -> ${now.hoverCm})`);
  check('smaller skirt on smeared edges', now.skirt < old.skirt && now.reachCm <= old.reachCm, `${old.skirt} cells (out to ${old.reachCm} cm) -> ${now.skirt} cells (out to ${now.reachCm} cm)`);
  check('box still found', now.coverage >= 0.85, `coverage ${old.coverage} -> ${now.coverage}`);
  const fine = out['noisy, Fine (3 cm)'];
  const closeFine = out['close noisy, Fine (3 cm)'];
  check('Fine (3 cm) as true as Filtered', fine.coverage >= 0.85 && fine.floor <= 2 && Math.abs(closeFine.hoverCm) <= 1 && fine.reachCm <= now.reachCm + 4, `skirt ${fine.skirt} cells (out to ${fine.reachCm} cm), hover close up ${closeFine.hoverCm} cm, coverage ${fine.coverage}`);
  check('no noise bumps on open floor', now.floor <= old.floor && now.floor <= 2, `${old.floor} -> ${now.floor}`);
  const passed = results.filter(Boolean).length;
  console.log(JSON.stringify({ passed, failed: results.length - passed }));
  return { passed, failed: results.length - passed, out };
}
