// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Replays a scenario pack captured by the app (artifacts/scenarios/*.scenario.json)
 * in MuJoCo on this machine, with the same policies, and checks that it ends
 * where the headset's sim ended. Also exports the pack as plain files for
 * other simulators.
 *
 *   node tools/train/replay.mjs artifacts/scenarios/<pack>.scenario.json
 *   node tools/train/replay.mjs <pack> --export artifacts/scenarios/<name>/
 *   node tools/train/replay.mjs <pack> --policies public/policies/incoming/latest/
 *
 * The export folder gets scene.xml (robot, course, room, terrain as
 * terrain.bin), assets/ (collision meshes), state.json (start state, every
 * input, end state) and the policy files it was captured with, which is what
 * a MuJoCo / MJX trainer or Isaac Sim's MJCF importer needs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '@mujoco/mujoco';
import * as ort from 'onnxruntime-node';
import { exportPack } from './lib/export.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const packPath = args.find((a) => !a.startsWith('--'));
if (!packPath) {
  console.error('usage: node tools/train/replay.mjs <pack.scenario.json> [--export <dir>] [--policies <folder>] [--quiet]');
  process.exit(2);
}
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const exportDir = option('--export');
const policyFolder = option('--policies');
const quiet = args.includes('--quiet');

const pack = JSON.parse(readFileSync(packPath, 'utf8'));
if (pack.version !== 'duckdash.scenario.v1') throw new Error(`not a scenario pack: ${pack.version}`);
const control = pack.control;
const duck = pack.duck;
if (!duck) throw new Error('the pack names no duck pack');

// Collision meshes come from this checkout (same files the app served).
const meshDir = join(root, 'public', duck.localFolder, duck.meshFolder);
const meshes = duck.meshFiles.map((file) => [file, new Uint8Array(readFileSync(join(meshDir, file)))]);
const terrain = pack.terrain ? decodeTerrain(pack.terrain) : null;

function decodeTerrain(t) {
  if (t.encoding !== 'base64-float32') throw new Error(`unknown terrain encoding ${t.encoding}`);
  const bytes = Buffer.from(t.data, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

if (exportDir) {
  const policyDir = policyFolder ? resolve(policyFolder) : join(root, 'public', 'policies', 'microduck');
  exportPack({ pack, meshes, terrain }, exportDir, policyDir);
  console.log(`exported to ${exportDir}`);
}

// --- Replay -----------------------------------------------------------------
const mj = await loadMujoco();
const vfs = new mj.MjVFS();
for (const [file, bytes] of meshes) vfs.addBuffer(`assets/${file}`, bytes);
const model = mj.MjModel.from_xml_string(pack.mjcf, vfs);
vfs.delete();
const data = new mj.MjData(model);
if (terrain) {
  const geom = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, 'terrain');
  if (geom >= 0) {
    const hfield = model.geom_dataid[geom];
    model.hfield_data.set(terrain, model.hfield_adr[hfield]);
  }
}
const scalar = (v) => (typeof v === 'number' ? v : Number(v[0]));
const qposAdr = control.jointNames.map((name) => {
  const j = model.jnt(name);
  const adr = scalar(j.qposadr);
  j.delete();
  return adr;
});
const dofAdr = control.jointNames.map((name) => {
  const j = model.jnt(name);
  const adr = scalar(j.dofadr);
  j.delete();
  return adr;
});
const free = model.jnt(control.freeJoint);
const freeAdr = scalar(free.qposadr);
free.delete();
const gyro = model.sensor(control.gyroSensor);
const gyroAdr = scalar(gyro.adr);
gyro.delete();

const folder = policyFolder ? resolve(policyFolder) : join(root, 'public', 'policies', 'microduck');
const session = await ort.InferenceSession.create(join(folder, pack.policy.files.walk));
const standSession = await ort.InferenceSession.create(join(folder, pack.policy.files.stand));

// Start state.
data.qpos.set(pack.start.qpos);
data.qvel.set(pack.start.qvel);
mj.mj_forward(model, data);
const lastAction = new Float32Array(pack.start.lastAction);
const twistSmooth = new Float32Array(pack.start.twistSmooth);
const headSmooth = new Float32Array(pack.start.headSmooth);
const obs = new Float32Array(control.obsSize);
const command = new Float32Array(control.cmdSize);
const N = control.numJoints;

function buildObs(action, cmd) {
  const qpos = data.qpos;
  const qvel = data.qvel;
  const sensors = data.sensordata;
  obs[0] = sensors[gyroAdr];
  obs[1] = sensors[gyroAdr + 1];
  obs[2] = sensors[gyroAdr + 2];
  const w = qpos[freeAdr + 3];
  const x = qpos[freeAdr + 4];
  const y = qpos[freeAdr + 5];
  const z = qpos[freeAdr + 6];
  obs[3] = -2 * (x * z - w * y);
  obs[4] = -2 * (y * z + w * x);
  obs[5] = -(1 - 2 * (x * x + y * y));
  for (let j = 0; j < N; j++) {
    obs[6 + j] = qpos[qposAdr[j]] - control.defaultPose[j];
    obs[6 + N + j] = qvel[dofAdr[j]];
    obs[6 + 2 * N + j] = action[j];
  }
  obs.set(cmd, 6 + 3 * N);
}

async function act(sess, cmd) {
  buildObs(lastAction, cmd);
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', obs, [1, control.obsSize]) });
  const result = out[sess.outputNames[0]].data;
  for (let j = 0; j < N; j++) if (!Number.isFinite(result[j])) return;
  lastAction.set(result.subarray(0, N));
  const ctrl = data.ctrl;
  for (let j = 0; j < N; j++) ctrl[j] = control.defaultPose[j] + result[j];
}

const gravityZ = () => {
  const q = data.qpos;
  const x = q[freeAdr + 4];
  const y = q[freeAdr + 5];
  return -(1 - 2 * (x * x + y * y));
};

let fellAt = null;
let recovering = false;
let upright = 0;
const t0 = performance.now();
const steps = pack.steps;
let lastPrint = -1;
for (let k = 0; k < steps.length; k++) {
  const [t, vx, wz, n0, n1, n2, n3, move] = steps[k];
  if (move) console.warn(`step ${k} (t=${t}s): move "${move}" ignored by this replay (walk policy only)`);
  twistSmooth[0] += control.twistAlpha * (vx - twistSmooth[0]);
  twistSmooth[2] += control.twistAlpha * (wz - twistSmooth[2]);
  const head = [n0, n1, n2, n3];
  for (let i = 0; i < 4; i++) headSmooth[i] += control.headAlpha * (head[i] - headSmooth[i]);
  command.fill(0);
  const tipped = gravityZ() > -0.5 || data.qpos[freeAdr + 2] < 0.02;
  if (tipped && fellAt === null) fellAt = t;
  if (tipped && !recovering) {
    recovering = true;
    lastAction.fill(0);
  }
  if (recovering) {
    upright = gravityZ() < -0.85 ? upright + 1 : 0;
    if (upright >= 50) {
      recovering = false;
      lastAction.fill(0);
    }
    await act(standSession, command);
  } else {
    command[0] = twistSmooth[0];
    command[1] = twistSmooth[1];
    command[2] = twistSmooth[2];
    for (let i = 0; i < 4; i++) command[3 + i] = headSmooth[i];
    await act(session, command);
  }
  for (let s = 0; s < control.decimation; s++) mj.mj_step(model, data);
  const second = Math.floor(t - steps[0][0]);
  if (!quiet && second !== lastPrint) {
    lastPrint = second;
    const q = data.qpos;
    console.log(`t=${(t - steps[0][0]).toFixed(1).padStart(5)} s  trunk (${q[freeAdr].toFixed(3)}, ${q[freeAdr + 1].toFixed(3)}, ${q[freeAdr + 2].toFixed(3)})  cmd vx=${vx.toFixed(2)} wz=${wz.toFixed(2)}${tipped ? '  TIPPED' : ''}`);
  }
}
const wall = performance.now() - t0;
const q = data.qpos;
const end = pack.end.qpos;
const drift = Math.hypot(q[freeAdr] - end[0], q[freeAdr + 1] - end[1], q[freeAdr + 2] - end[2]);
console.log(
  `replayed ${steps.length} steps (${(steps.length * control.ctrlDt).toFixed(1)} s of sim) in ${(wall / 1000).toFixed(1)} s; ` +
    `headset ended at (${end[0].toFixed(3)}, ${end[1].toFixed(3)}, ${end[2].toFixed(3)}) in mode ${pack.end.mode}, ` +
    `replay at (${q[freeAdr].toFixed(3)}, ${q[freeAdr + 1].toFixed(3)}, ${q[freeAdr + 2].toFixed(3)}): ${(drift * 100).toFixed(1)} cm apart` +
    (fellAt !== null ? `; first tipped at t=${(fellAt - steps[0][0]).toFixed(1)} s` : '; never tipped'),
);
console.log(JSON.stringify({ steps: steps.length, driftCm: Number((drift * 100).toFixed(1)), fellAt, reason: pack.reason }));
