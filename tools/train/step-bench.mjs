// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How tall a step a walking brain gets onto: a box step across the duck's path
 * (on a plain floor, from a scenario pack's start), a steady forward walk, and
 * Pollen's randomisation over several seeds per height. An episode counts as
 * "up" when the trunk ends past the step's front edge, raised by most of the
 * step's height, and still standing.
 *
 *   node tools/train/step-bench.mjs [--brains shipped,<release id>|<folder>] [--heights 0,1,2,3,4,6] [--seeds 8]
 *                                   [--speed 0.15] [--seconds 10] [--pack <pack.scenario.json>] [--json <out.json>]
 *
 * Heights are in centimetres. A brain is "shipped", a release id in
 * public/policies/incoming, or a folder holding walk.onnx.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { brainDir } from './cross-check.mjs';
import { mujoco, PackEnv } from './lib/env.mjs';
import { loadPack } from './lib/pack.mjs';
import { seedOf } from './lib/rng.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const brains = option('--brains', 'shipped').split(',');
const heights = option('--heights', '0,1,1.5,2,3,4,5,6').split(',').map(Number);
const seeds = Number(option('--seeds', 8));
const speed = Number(option('--speed', 0.15));
const seconds = Number(option('--seconds', 10));
const packPath = option('--pack', join(root, 'artifacts', 'scenarios', '2026-10-22T19-24-24-stuck.scenario.json'));
const jsonOut = option('--json', null);

const GAP = 0.12; // m from the trunk to the step's front face
const DEPTH = 1.2; // m of step to walk onto
const WIDTH = 1.2;

/** The pack with a step in front of the duck and a steady forward walk for the commands. */
function stepPack(base, h) {
  const pack = structuredClone(base.pack);
  const q = pack.start.qpos;
  const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const along = GAP + DEPTH / 2;
  const step =
    h > 0
      ? `<geom name="bench_step" type="box" size="${DEPTH / 2} ${WIDTH / 2} ${h / 2}" pos="${q[0] + c * along} ${q[1] + s * along} ${h / 2}" euler="0 0 ${yaw}" rgba="0.8 0.6 0.3 1"/>`
      : '';
  pack.mjcf = pack.mjcf.replace(/<worldbody>/, `<worldbody>${step}`);
  const n = Math.round(seconds / (pack.control.ctrlDt ?? 0.02));
  pack.steps = Array.from({ length: n }, (_, i) => [i * 0.02, speed, 0, 0, 0, 0, 0, '']);
  pack.start.twistSmooth = [speed, 0, 0];
  pack.start.headSmooth = [0, 0, 0, 0];
  return { loaded: { ...base, pack }, yaw, front: GAP };
}

const policyFile = (brain) => (existsSync(join(brain, 'walk.onnx')) ? join(brain, 'walk.onnx') : join(brainDir(brain), 'walk.onnx'));

const mj = await mujoco();
const base = loadPack(packPath, root);
const obs = new Float32Array(61);
const table = [];
for (const brain of brains) {
  const session = await ort.InferenceSession.create(readFileSync(policyFile(brain)));
  for (const h of heights) {
    const { loaded, yaw, front } = stepPack(base, h / 100);
    const env = new PackEnv(mj, loaded, { randomize: 'pollen', flat: true });
    let up = 0;
    let fell = 0;
    let stuck = 0;
    let walked = 0;
    for (let k = 0; k < seeds; k++) {
      const ep = env.episode(seedOf(777, k), { noise: true });
      const [x0, y0, z0] = env.trunk(ep);
      while (ep.t < env.steps.length) {
        env.observe(ep, obs, 0);
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', obs, [1, 61]) });
        if (!env.act(ep, Float32Array.from(out[session.outputNames[0]].data))) break;
      }
      const [x, y, z] = env.trunk(ep);
      const ahead = Math.cos(yaw) * (x - x0) + Math.sin(yaw) * (y - y0);
      walked += ahead;
      if (ep.fallen) fell++;
      else if (ahead > front + 0.08 && z - z0 > 0.7 * (h / 100) - 0.01) up++;
      else stuck++;
      env.dispose(ep);
    }
    const row = { brain, heightCm: h, up, fell, stuck, seeds, aheadM: +(walked / seeds).toFixed(2) };
    table.push(row);
    console.log(`${brain.padEnd(36)} ${String(h).padStart(4)} cm  up ${up}/${seeds}  fell ${fell}  stuck ${stuck}  ahead ${row.aheadM} m`);
  }
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ speed, seconds, pack: packPath, table }, null, 2)}\n`);
