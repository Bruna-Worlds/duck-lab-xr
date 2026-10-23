// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * "Export for any simulator" (the trainer page's Export card): the selected
 * test cases (scenario packs) and motion sets as one folder and one .zip that
 * any simulator or training setup can take:
 *
 *   START_HERE.md        how to load it in the chosen target, then the others
 *   job.json             duckdash.trainjob.v1: what to train, how it is scored
 *   <pack>/              one per test case (export.mjs): scene.xml (MuJoCo MJCF:
 *                        Pollen's Microduck, the course, the scanned room, the
 *                        terrain height field), assets/, terrain.bin, state.json
 *                        (start state + every recorded command), policies/ (ONNX),
 *                        and, for engines that do not read MJCF:
 *                        terrain.obj, obstacles.obj (Z up, metres, MuJoCo frame),
 *                        trajectory.csv (the moment replayed with the shipped
 *                        brain: commands, trunk pose, joints, actions, per 20 ms step)
 *   motion-sets/<set>.npz  behaviour-cloning data: obs (N x 61), act (N x 14),
 *                        episode_lengths, success; <set>.json has the convention
 *   python/              duck_env.py (Gymnasium env), train_ppo.py (Stable-
 *                        Baselines3), replay.py, requirements.txt
 *
 * MJCF is the common ground: MuJoCo, MJX, MuJoCo Playground, mjlab (what
 * Pollen's microduck_rl trains with), Genesis and Isaac Sim / Isaac Lab (MJCF
 * importer) load it directly; the OBJ meshes and CSV serve everything else.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { mujoco, PackEnv } from './env.mjs';
import { exportPack, trainJob } from './export.mjs';
import { loadPack } from './pack.mjs';
import { policyHash } from './policy.mjs';
import { directoryEntries, npz, zip } from './zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = join(here, '..', 'python');

/** What the Export card offers; `start` is the quickstart put first in START_HERE.md. */
export const TARGETS = {
  mujoco: {
    title: 'MuJoCo, MJX, MuJoCo Playground',
    start: [
      'Each test case folder is a MuJoCo scene: `scene.xml` (with `assets/` and `terrain.bin` beside it).',
      '```python',
      'import mujoco, json',
      'm = mujoco.MjModel.from_xml_path("<pack>/scene.xml"); d = mujoco.MjData(m)',
      'state = json.load(open("<pack>/state.json")); d.qpos[:] = state["start"]["qpos"]; d.qvel[:] = state["start"]["qvel"]',
      '```',
      'Run the walking policy (`policies/walk.onnx`, 61 numbers in, 14 joint targets out) at 50 Hz, four 5 ms physics steps per',
      'control step, feeding `state.json` steps as commands. `python/replay.py <pack>` does exactly that.',
      'MJX: `mujoco.mjx.put_model(m)`; MuJoCo Playground: wrap the scene as an environment like `python/duck_env.py` does.',
    ],
  },
  mjlab: {
    title: "mjlab and Pollen's microduck_rl",
    start: [
      "Pollen's `microduck_rl` trains the Microduck with PPO in mjlab (MuJoCo Warp). Use a test case as a training terrain:",
      '- the robot in `scene.xml` is Pollen\'s own `robot_allcollisions` MJCF, unchanged;',
      '- add the `course_*` and `room_*` geoms and the `live-terrain` height field (`terrain.bin`) from `scene.xml` to your task\'s scene;',
      '- start episodes from `state.json` `start` (qpos, qvel) and drive them with its recorded commands;',
      '- `job.json` says how the local trainer scores a run (falls, distance, command tracking) and where results go.',
      'A trained policy comes back as a release folder (`walk.onnx` and friends, same 61-in / 14-out convention): drop it in',
      '`public/policies/incoming/<name>/` and run `node tools/train/release.mjs rescan`, then make it active in the trainer.',
    ],
  },
  isaac: {
    title: 'Isaac Sim and Isaac Lab',
    start: [
      'Isaac Sim reads the scene with its MJCF importer: Isaac Utils > Workflows > MJCF Importer, open `<pack>/scene.xml`',
      '(it converts the robot and the boxes to USD). If the height field does not come through, import `terrain.obj` and',
      '`obstacles.obj` (Z up, metres, the same frame as the MJCF) as static colliders instead.',
      'Isaac Lab: make the imported USD the robot asset of a locomotion task; reset to `state.json` `start` and replay its',
      'commands. Joint order, standing pose and action scale are in `state.json` `control`.',
    ],
  },
  genesis: {
    title: 'Genesis',
    start: [
      '```python',
      'import genesis as gs',
      'gs.init(); scene = gs.Scene()',
      'duck = scene.add_entity(gs.morphs.MJCF(file="<pack>/scene.xml"))',
      'scene.build()',
      '```',
      'If the height field is not supported, add `terrain.obj` and `obstacles.obj` with `gs.morphs.Mesh(..., fixed=True)`.',
    ],
  },
  gym: {
    title: 'Gymnasium and Stable-Baselines3',
    start: [
      '```sh',
      'pip install -r python/requirements.txt',
      'python python/train_ppo.py . --steps 2000000 --envs 8 --name ppo-room',
      '```',
      '`python/duck_env.py` is a Gymnasium environment per test case, with the same control loop, observation, shoves and',
      'reward as the local trainer; `train_ppo.py` fine-tunes the shipped policy on them and writes a release folder.',
    ],
  },
  generic: {
    title: 'Any engine (meshes and CSV)',
    start: [
      'For engines without MJCF: `terrain.obj` and `obstacles.obj` are the room and the course as meshes (Z up, metres),',
      '`trajectory.csv` is the moment replayed with the shipped brain, one row per 20 ms control step: the command, the trunk',
      'pose, the 14 joint angles (names in the header) and the 14 joint targets the policy chose. `state.json` has the start',
      "state and the robot's control convention; `policies/*.onnx` run in any ONNX runtime.",
    ],
  },
};

/**
 * Builds the export. packs: ids (resolved with packPath), motionSets: dataset
 * files. Returns { id, dir, zipPath, bytes, packs, motionSets, target }.
 */
export async function exportBundle({ root, connectorDir, shippedDir, packIds, packPath, motionFiles = [], target = 'mujoco', notes = '' }) {
  const chosen = TARGETS[target] ? target : 'mujoco';
  const id = `duck-lab-export-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const dir = join(connectorDir, id);
  mkdirSync(dir, { recursive: true });
  const walkBytes = readFileSync(join(shippedDir, 'walk.onnx'));
  const baseHash = policyHash(walkBytes);
  const session = packIds.length ? await ort.InferenceSession.create(walkBytes) : null;
  const packs = [];
  for (const packId of packIds) {
    const loaded = loadPack(packPath(packId), root);
    const out = join(dir, packId);
    exportPack(loaded, out, shippedDir);
    writeFileSync(join(out, 'terrain.obj'), terrainObj(loaded));
    writeFileSync(join(out, 'obstacles.obj'), obstaclesObj(loaded.pack.mjcf));
    const run = await trajectory(loaded, session);
    writeFileSync(join(out, 'trajectory.csv'), run.csv);
    packs.push({ id: packId, reason: loaded.pack.reason, steps: run.steps, fell: run.fell });
  }
  if (packIds.length) writeFileSync(join(dir, 'job.json'), `${JSON.stringify(trainJob({ id, packs: packIds, baseHash, notes }), null, 2)}\n`);
  const motionSets = [];
  if (motionFiles.length) mkdirSync(join(dir, 'motion-sets'), { recursive: true });
  for (const file of motionFiles) {
    const set = JSON.parse(readFileSync(file, 'utf8'));
    const name = basename(file).replace(/\.dataset\.json$/, '');
    const obs = floats(set.obs);
    const act = floats(set.act);
    const steps = set.steps ?? obs.length / 61;
    writeFileSync(
      join(dir, 'motion-sets', `${name}.npz`),
      npz({
        obs: [obs, [steps, obs.length / steps]],
        act: [act, [steps, act.length / steps]],
        episode_lengths: [Int32Array.from(set.episodeLengths ?? []), [(set.episodeLengths ?? []).length]],
        success: [Uint8Array.from((set.successFlags ?? []).map((v) => (v ? 1 : 0))), [(set.successFlags ?? []).length]],
      }),
    );
    writeFileSync(
      join(dir, 'motion-sets', `${name}.json`),
      `${JSON.stringify({ version: set.version, at: set.at, motion: set.motion, control: set.control, episodes: set.episodes, successes: set.successes, steps }, null, 1)}\n`,
    );
    motionSets.push({ id: name, motion: set.motion?.name ?? '', episodes: set.episodes, steps });
  }
  mkdirSync(join(dir, 'python'), { recursive: true });
  for (const file of ['duck_env.py', 'train_ppo.py']) {
    if (existsSync(join(PYTHON_DIR, file))) copyFileSync(join(PYTHON_DIR, file), join(dir, 'python', file));
  }
  writeFileSync(join(dir, 'python', 'replay.py'), REPLAY_PY);
  writeFileSync(join(dir, 'python', 'requirements.txt'), 'mujoco>=3.1\nonnxruntime\nnumpy\ngymnasium\nstable-baselines3\ntorch\nonnx\n');
  writeFileSync(join(dir, 'START_HERE.md'), startHere(chosen, packs, motionSets));
  const archive = zip(directoryEntries(dir, id));
  const zipPath = join(connectorDir, `${id}.zip`);
  writeFileSync(zipPath, archive);
  return { id, dir, zipPath, bytes: archive.length, packs, motionSets, target: chosen };
}

const floats = (base64) => {
  const bytes = Buffer.from(base64 ?? '', 'base64');
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

/** The pack's height field as a triangle mesh (MuJoCo frame, Z up, metres). */
export function terrainObj(loaded) {
  const { pack, terrain } = loaded;
  const hf = pack.mjcf.match(/<hfield\b[^>]*\bname="live-terrain"[^>]*>/)?.[0];
  const geom = pack.mjcf.match(/<geom\b[^>]*\bname="terrain"[^>]*>/)?.[0];
  if (!terrain || !hf || !geom) return '# no terrain in this test case\n';
  const n = Number(attr(hf, 'nrow'));
  const m = Number(attr(hf, 'ncol'));
  const [rx, ry, zmax] = nums(attr(hf, 'size'));
  const [px, py, pz] = nums(attr(geom, 'pos') ?? '0 0 0');
  const lines = ['# Duck Lab XR: the sensed terrain (height field) as a mesh. MuJoCo frame: Z up, metres.', 'o terrain'];
  for (let r = 0; r < n; r++) {
    const y = py - ry + (2 * ry * r) / (n - 1);
    for (let c = 0; c < m; c++) {
      const x = px - rx + (2 * rx * c) / (m - 1);
      lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${(pz + terrain[r * m + c] * zmax).toFixed(4)}`);
    }
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < m - 1; c++) {
      const a = r * m + c + 1;
      const b = a + 1;
      const d = a + m;
      const e = d + 1;
      lines.push(`f ${a} ${b} ${e}`, `f ${a} ${e} ${d}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The course pieces and the scanned room (the MJCF's course_* and room_* geoms) as meshes. */
export function obstaclesObj(mjcf) {
  const lines = ['# Duck Lab XR: course pieces and scanned room colliders as meshes. MuJoCo frame: Z up, metres.'];
  let base = 1;
  for (const match of mjcf.matchAll(/<geom\b[^>]*\bname="((?:course|room)_\d+)"[^>]*\/>/g)) {
    const tag = match[0];
    const type = attr(tag, 'type') ?? 'sphere';
    const size = nums(attr(tag, 'size'));
    const pos = nums(attr(tag, 'pos') ?? '0 0 0');
    const [qw, qx, qy, qz] = nums(attr(tag, 'quat') ?? '1 0 0 0');
    const rotate = ([x, y, z]) => {
      // v' = q v q*, written out for a unit quaternion (w, x, y, z).
      const tx = 2 * (qy * z - qz * y);
      const ty = 2 * (qz * x - qx * z);
      const tz = 2 * (qx * y - qy * x);
      return [x + qw * tx + (qy * tz - qz * ty) + pos[0], y + qw * ty + (qz * tx - qx * tz) + pos[1], z + qw * tz + (qx * ty - qy * tx) + pos[2]];
    };
    const { verts, faces } = shape(type, size);
    lines.push(`o ${match[1]}_${type}`);
    for (const v of verts) lines.push(`v ${rotate(v).map((k) => k.toFixed(4)).join(' ')}`);
    for (const f of faces) lines.push(`f ${f.map((k) => k + base).join(' ')}`);
    base += verts.length;
  }
  return `${lines.join('\n')}\n`;
}

/** Local vertices and faces (0-based) of a MuJoCo box (half sizes), cylinder (radius, half height, along z) or sphere. */
function shape(type, size) {
  if (type === 'box') {
    const [hx, hy, hz] = size;
    const verts = [];
    for (const z of [-hz, hz]) for (const y of [-hy, hy]) for (const x of [-hx, hx]) verts.push([x, y, z]);
    const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    return { verts, faces };
  }
  if (type === 'cylinder' || type === 'capsule') {
    const [r, h] = size;
    const k = 24;
    const verts = [];
    for (const z of [-h, h]) for (let i = 0; i < k; i++) verts.push([r * Math.cos((2 * Math.PI * i) / k), r * Math.sin((2 * Math.PI * i) / k), z]);
    const faces = [];
    for (let i = 0; i < k; i++) faces.push([i, (i + 1) % k, k + ((i + 1) % k), k + i]);
    faces.push(Array.from({ length: k }, (_, i) => k - 1 - i), Array.from({ length: k }, (_, i) => k + i));
    return { verts, faces };
  }
  const [r] = size;
  const rings = 8;
  const segs = 12;
  const verts = [[0, 0, -r]];
  for (let j = 1; j < rings; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / rings;
    for (let i = 0; i < segs; i++) {
      const th = (2 * Math.PI * i) / segs;
      verts.push([r * Math.cos(phi) * Math.cos(th), r * Math.cos(phi) * Math.sin(th), r * Math.sin(phi)]);
    }
  }
  verts.push([0, 0, r]);
  const faces = [];
  const top = verts.length - 1;
  for (let i = 0; i < segs; i++) faces.push([0, 1 + ((i + 1) % segs), 1 + i]);
  for (let j = 0; j < rings - 2; j++) {
    for (let i = 0; i < segs; i++) {
      const a = 1 + j * segs + i;
      const b = 1 + j * segs + ((i + 1) % segs);
      faces.push([a, b, b + segs, a + segs]);
    }
  }
  const last = 1 + (rings - 2) * segs;
  for (let i = 0; i < segs; i++) faces.push([last + i, last + ((i + 1) % segs), top]);
  return { verts, faces };
}

/** The moment replayed with the shipped walking brain, as CSV (one row per 20 ms control step). */
async function trajectory(loaded, session) {
  const mj = await mujoco();
  const env = new PackEnv(mj, loaded);
  const ep = env.episode(1, { noise: false });
  const N = env.N;
  const obs = new Float32Array(61);
  const action = new Float32Array(N);
  const names = env.control.jointNames;
  const columns = (loaded.pack.stepColumns ?? ['t', 'vx', 'wz', 'neckPitch', 'headPitch', 'headYaw', 'headRoll', 'move']).slice(1);
  const header = ['step', 'time_s', ...columns.map((c) => `cmd_${c}`), 'trunk_x', 'trunk_y', 'trunk_z', 'trunk_qw', 'trunk_qx', 'trunk_qy', 'trunk_qz', ...names.map((n) => `q_${n}`), ...names.map((n) => `target_${n}`), 'fallen'];
  const rows = [header.join(',')];
  const dt = (env.control.ctrlDt ?? 0.02);
  const steps = env.steps.length;
  for (let t = 0; t < steps; t++) {
    env.observe(ep, obs, 0);
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', obs, [1, 61]) });
    action.set(out[session.outputNames[0]].data);
    const alive = env.act(ep, action);
    const q = ep.data.qpos;
    const row = [t, (t * dt).toFixed(3), ...env.steps[t].slice(1).map((v) => (typeof v === 'number' ? round(v) : v ?? ''))];
    for (let i = 0; i < 7; i++) row.push(round(q[env.freeAdr + i]));
    for (const adr of env.qposAdr) row.push(round(q[adr]));
    for (let i = 0; i < N; i++) row.push(round(action[i]));
    row.push(ep.fallen ? 1 : 0);
    rows.push(row.join(','));
    if (!alive) break;
  }
  const result = { csv: `${rows.join('\n')}\n`, steps: rows.length - 1, fell: ep.fallen };
  env.dispose(ep);
  return result;
}

const round = (v) => Math.round(v * 1e5) / 1e5;
function attr(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}
const nums = (s) => (s ?? '').trim().split(/\s+/).filter(Boolean).map(Number);

function startHere(target, packs, motionSets) {
  const t = TARGETS[target];
  const others = Object.entries(TARGETS).filter(([key]) => key !== target);
  return [
    '# Duck Lab XR export',
    '',
    `Test cases from your room${motionSets.length ? ' and motion sets' : ''}, ready for other simulators and trainers.`,
    'Made by the Duck Lab XR trainer (Bruna Worlds); the Python code is Apache-2.0, copyright 2026 BRUNA GOODS LLC.',
    'The robot model and walking policies are Pollen Robotics\' Microduck (meshes CC BY-NC-SA 4.0, policies Apache-2.0):',
    'see each `policies/ATTRIBUTION.md`.',
    '',
    `## ${t.title} (your choice)`,
    '',
    ...t.start,
    '',
    '## What is here',
    '',
    ...packs.map((p) => `- \`${p.id}/\`: test case (${p.reason}), ${p.steps} steps replayed${p.fell ? ', the shipped brain falls' : ''}`),
    ...motionSets.map((s) => `- \`motion-sets/${s.id}.npz\`: ${s.motion} motion set, ${s.episodes} episodes, ${s.steps} steps (obs N x 61, act N x 14)`),
    '- `job.json`: the training job (what to train, scoring, where results go)',
    '- `python/`: `duck_env.py` (Gymnasium), `train_ppo.py` (Stable-Baselines3), `replay.py`, `requirements.txt`',
    '',
    'In each test case folder: `scene.xml` + `assets/` + `terrain.bin` (MuJoCo), `state.json` (start state and the recorded',
    'commands, control convention), `policies/` (ONNX, 61 in, 14 out, 50 Hz), `terrain.obj` + `obstacles.obj` (meshes, Z up,',
    'metres), `trajectory.csv` (the moment replayed with the shipped brain).',
    '',
    '## Other targets',
    '',
    ...others.flatMap(([, o]) => [`### ${o.title}`, '', ...o.start, '']),
    'The Python scripts follow the tested Node trainer (tools/train in the Duck Lab XR repo) but were not run where they were',
    'written; if something differs, the Node trainer is the reference.',
    '',
  ].join('\n');
}

const REPLAY_PY = `# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
Replays a Duck Lab XR test case in MuJoCo with the shipped walking policy and
the recorded commands, and says whether the duck falls:

    pip install -r requirements.txt
    python replay.py ../<test-case-folder>

Uses duck_env.py (same folder) for the exact control loop and observation.
"""
import sys

import numpy as np
import onnxruntime as ort

from duck_env import DuckPackEnv

pack = sys.argv[1]
env = DuckPackEnv(pack, noise=False)
policy = ort.InferenceSession(f"{pack}/policies/walk.onnx")
name = policy.get_inputs()[0].name
obs, _ = env.reset(seed=0)
steps = 0
fell = False
while True:
    # The ONNX file normalises its own input: give it the raw observation (env.raw).
    action = policy.run(None, {name: np.asarray(env.raw, dtype=np.float32)[None, :]})[0][0]
    obs, reward, terminated, truncated, info = env.step(action)
    steps += 1
    if terminated or truncated:
        fell = bool(terminated)
        break
print(f"{steps} steps, {'fell' if fell else 'stayed up'}")
`;
