// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The motor test in the air, in MuJoCo: Pip in his standing pose 1 m up, at
 * rest, every motor's target stepped by +0.2 rad, and every joint's angle
 * after each 5 ms step for 0.2 s. No contact, so it shows the motors alone;
 * run_pack.py --air does the same in PhysX and sets one against the other.
 *
 *   node tools/isaac/scenario/mujoco-air-test.mjs <pack.scenario.json> <export folder>   -> <folder>/mujoco-air.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '@mujoco/mujoco';

export const AIR = { height: 1.0, step: 0.2, steps: 40 };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [packPath, folder] = process.argv.slice(2);
if (!packPath || !folder) {
  console.error('usage: node tools/isaac/scenario/mujoco-air-test.mjs <pack.scenario.json> <export folder>');
  process.exit(2);
}
const pack = JSON.parse(readFileSync(packPath, 'utf8'));
const control = pack.control;
const meshDir = join(root, 'public', pack.duck.localFolder, pack.duck.meshFolder);
const mj = await loadMujoco();
const vfs = new mj.MjVFS();
for (const file of pack.duck.meshFiles) vfs.addBuffer(`assets/${file}`, new Uint8Array(readFileSync(join(meshDir, file))));
const model = mj.MjModel.from_xml_string(pack.mjcf, vfs);
vfs.delete();
const data = new mj.MjData(model);
const scalar = (v) => (typeof v === 'number' ? v : Number(v[0]));
const qposAdr = control.jointNames.map((name) => {
  const j = model.jnt(name);
  const adr = scalar(j.qposadr);
  j.delete();
  return adr;
});
const key = mj.mj_name2id(model, mj.mjtObj.mjOBJ_KEY.value, control.standKeyframe ?? 'STAND');
mj.mj_resetDataKeyframe(model, data, key);
const free = model.jnt(control.freeJoint);
const freeAdr = scalar(free.qposadr);
free.delete();
data.qpos[freeAdr + 2] = AIR.height;
data.qvel.fill(0);
for (let j = 0; j < control.numJoints; j++) data.ctrl[j] = control.defaultPose[j] + AIR.step;
mj.mj_forward(model, data);
const angles = [];
for (let s = 0; s < AIR.steps; s++) {
  mj.mj_step(model, data);
  angles.push(qposAdr.map((a) => Number(data.qpos[a].toFixed(5))));
}
writeFileSync(join(folder, 'mujoco-air.json'), JSON.stringify({ ...AIR, dt: model.opt.timestep, joints: control.jointNames, angles }));
console.log(`wrote ${join(folder, 'mujoco-air.json')}: knee after 0.05 s ${(angles[9][3] - control.defaultPose[3]).toFixed(3)} rad, after 0.2 s ${(angles.at(-1)[3] - control.defaultPose[3]).toFixed(3)} rad`);
