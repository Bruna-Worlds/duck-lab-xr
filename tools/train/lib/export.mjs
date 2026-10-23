// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Exports a scenario pack as plain files any MuJoCo tool can load, plus a
 * training job description for external trainers (the RL connector):
 *
 *   scene.xml      the pack's scene; meshdir assets/, height field terrain.bin
 *   assets/        collision meshes
 *   terrain.bin    MuJoCo binary height field (int32 nrow, int32 ncol, float32 data)
 *   state.json     control convention, start state, every recorded step, end state
 *   policies/      the ONNX policies the duck ran (61 obs in, 14 joint targets out)
 *   job.json       duckdash.trainjob.v1: what to train, how it is scored, where results go
 *   README.txt     how to load it
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function exportPack(loaded, dir, policyDir, job = null) {
  const { pack, meshes, terrain } = loaded;
  mkdirSync(join(dir, 'assets'), { recursive: true });
  for (const [file, bytes] of meshes) writeFileSync(join(dir, 'assets', file), bytes);
  let xml = pack.mjcf;
  if (terrain) {
    const header = Buffer.alloc(8);
    header.writeInt32LE(pack.terrain.nrow, 0);
    header.writeInt32LE(pack.terrain.ncol, 4);
    writeFileSync(join(dir, 'terrain.bin'), Buffer.concat([header, Buffer.from(terrain.buffer, terrain.byteOffset, terrain.byteLength)]));
    // MuJoCo's binary height field: int32 nrow, int32 ncol, float32 data (row-major, row 0 at -y).
    xml = xml.replace(/<hfield name="live-terrain"[^>]*?nrow="\d+" ncol="\d+"/, (m) => m.replace(/nrow="\d+" ncol="\d+"/, 'file="terrain.bin"'));
  }
  writeFileSync(join(dir, 'scene.xml'), xml);
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify(
      {
        control: pack.control,
        start: pack.start,
        stepColumns: pack.stepColumns,
        steps: pack.steps,
        end: pack.end,
        events: pack.events,
        reason: pack.reason,
        at: pack.at,
      },
      null,
      1,
    ),
  );
  const policies = join(dir, 'policies');
  mkdirSync(policies, { recursive: true });
  for (const file of Object.values(pack.policy.files)) {
    if (existsSync(join(policyDir, file))) copyFileSync(join(policyDir, file), join(policies, file));
  }
  if (existsSync(join(policyDir, 'ATTRIBUTION.md'))) copyFileSync(join(policyDir, 'ATTRIBUTION.md'), join(policies, 'ATTRIBUTION.md'));
  if (job) writeFileSync(join(dir, 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(
    join(dir, 'README.txt'),
    [
      `Duck Lab XR scenario pack (${pack.reason}) captured ${pack.at}`,
      `Playground: ${pack.playground?.title ?? '-'}; room: ${pack.room?.colliders || 'none'}; ${pack.room?.terrain ?? ''}`,
      '',
      'scene.xml     MuJoCo scene: Pollen Microduck (robot_allcollisions), course pieces, scanned walls',
      '              and furniture, and the live terrain height field (terrain.bin). meshdir is assets/.',
      'state.json    control convention, the start state (qpos/qvel/last action/smoothed command),',
      '              every control step since (t, vx, wz, head x4, move), and the end state to check against.',
      'policies/     the ONNX policies the duck ran (61 obs in, 14 joint targets out, 50 Hz).',
      job ? 'job.json      what to train and how it is scored (duckdash.trainjob.v1); see tools/train/README.md.' : '',
      '',
      'Load in Python:  m = mujoco.MjModel.from_xml_path("scene.xml"); d = mujoco.MjData(m)',
      '                 d.qpos[:] = state["start"]["qpos"]; d.qvel[:] = state["start"]["qvel"]',
      'then run the walk policy with onnxruntime at 50 Hz (4 physics steps of 5 ms per control step),',
      'feeding the recorded steps as commands; tools/train/lib/env.mjs has the exact observation layout.',
      'MJX / Isaac Sim: import scene.xml (Isaac Sim: Isaac Utils > Workflows > MJCF Importer).',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );
  return dir;
}

/** The connector's job description: what an external trainer should do with the exported packs. */
export function trainJob({ id, packs, baseHash, iterations, notes }) {
  return {
    version: 'duckdash.trainjob.v1',
    id,
    createdAt: new Date().toISOString(),
    task: 'Make the walking policy keep the duck up and walking as commanded in these scenes.',
    packs,
    base: { policy: 'policies/walk.onnx', walkHash: baseHash },
    control: {
      observation: 'gyro 3, projected gravity 3, joint positions minus standing pose 14, joint velocities 14, last action 14, command 13 (twist 3, head 4, body pose 6)',
      action: '14 joint targets as offsets from the standing pose (JOINT_NAMES order)',
      rateHz: 50,
      physicsStepsPerControl: 4,
      physicsTimestep: 0.005,
    },
    episode: {
      start: 'state.json start (qpos, qvel, lastAction, twistSmooth, headSmooth), plus noise: joints 0.03 rad, velocities 0.05',
      commands: 'state.json steps (vx, wz, head x4), smoothed with twistAlpha / headAlpha',
      shoves: '2-3 sideways pushes of 0.8-2.5 N for 0.1 s on trunk_base',
      fall: 'projected gravity z > -0.5 or trunk height < 0.02 m for 5 steps; ends the episode',
    },
    reward: '1 per step alive + exp(-(v_fwd - vx_cmd)^2 / 0.01) + 0.5 exp(-(w_z - wz_cmd)^2 / 0.25) - 0.5 |a - a_prev|^2 - 0.02 (w_x^2 + w_y^2); -50 on a fall',
    deliver: {
      format: 'ONNX, input "obs" [1, 61], output "actions" [1, 14], same file names as policies/',
      to: 'public/policies/incoming/<release-id>/ with manifest.json (duckdash.policyrelease.v1), then: node tools/train/release.mjs rescan',
    },
    iterations: iterations ?? null,
    notes: notes ?? '',
  };
}
