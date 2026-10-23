// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Loads an exported pack folder (tools/lab Connect, or replay.mjs --export)
 * the way an external trainer would: scene.xml from its own files (meshes in
 * assets/, height field in terrain.bin), the start state from state.json,
 * and steps it for two seconds with the shipped walking policy.
 *
 *   node tools/train/check-export.mjs artifacts/connector/<job>/<pack>/
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import * as ort from 'onnxruntime-node';

const dir = resolve(process.argv[2] ?? '.');
const mj = await loadMujoco();
const vfs = new mj.MjVFS();
for (const file of readdirSync(join(dir, 'assets'))) vfs.addBuffer(`assets/${file}`, new Uint8Array(readFileSync(join(dir, 'assets', file))));
try {
  vfs.addBuffer('terrain.bin', new Uint8Array(readFileSync(join(dir, 'terrain.bin'))));
} catch {
  // a pack without terrain
}
const model = mj.MjModel.from_xml_string(readFileSync(join(dir, 'scene.xml'), 'utf8'), vfs);
vfs.delete();
const data = new mj.MjData(model);
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
data.qpos.set(state.start.qpos);
data.qvel.set(state.start.qvel);
mj.mj_forward(model, data);
const geom = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, 'terrain');
let raised = 0;
if (geom >= 0) {
  const h = model.geom_dataid[geom];
  const adr = model.hfield_adr[h];
  const n = model.hfield_nrow[h] * model.hfield_ncol[h];
  for (let i = 0; i < n; i++) if (model.hfield_data[adr + i] > 0.01) raised++;
}
const session = await ort.InferenceSession.create(join(dir, 'policies', 'walk.onnx'));
const c = state.control;
const scalar = (v) => (typeof v === 'number' ? v : Number(v[0]));
const adr = (name, field) => {
  const j = model.jnt(name);
  const a = scalar(j[field]);
  j.delete();
  return a;
};
const qposAdr = c.jointNames.map((n) => adr(n, 'qposadr'));
const dofAdr = c.jointNames.map((n) => adr(n, 'dofadr'));
const free = adr(c.freeJoint, 'qposadr');
const gyroSensor = model.sensor(c.gyroSensor);
const gyro = scalar(gyroSensor.adr);
gyroSensor.delete();
const obs = new Float32Array(61);
const last = Float32Array.from(state.start.lastAction);
for (let t = 0; t < 100; t++) {
  const q = data.qpos;
  const v = data.qvel;
  obs[0] = data.sensordata[gyro];
  obs[1] = data.sensordata[gyro + 1];
  obs[2] = data.sensordata[gyro + 2];
  const [w, x, y, z] = [q[free + 3], q[free + 4], q[free + 5], q[free + 6]];
  obs[3] = -2 * (x * z - w * y);
  obs[4] = -2 * (y * z + w * x);
  obs[5] = -(1 - 2 * (x * x + y * y));
  for (let j = 0; j < 14; j++) {
    obs[6 + j] = q[qposAdr[j]] - c.defaultPose[j];
    obs[20 + j] = v[dofAdr[j]];
    obs[34 + j] = last[j];
  }
  obs.fill(0, 48);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', obs, [1, 61]) });
  last.set(out[session.outputNames[0]].data);
  for (let j = 0; j < 14; j++) data.ctrl[j] = c.defaultPose[j] + last[j];
  for (let s = 0; s < c.decimation; s++) mj.mj_step(model, data);
}
const q = data.qpos;
console.log(
  `ok: ${model.nbody} bodies, ${model.ngeom} geoms, ${raised} raised terrain cells; after 2 s standing, trunk at ` +
    `(${q[free].toFixed(3)}, ${q[free + 1].toFixed(3)}, ${q[free + 2].toFixed(3)})`,
);
