// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How brains hold up across physics engines: each brain on each scenario pack,
 * replayed with the inputs the headset recorded, in
 *
 *   mujoco     MuJoCo (WebAssembly), as the headset runs it (replay.mjs)
 *   pollen     MuJoCo with the pollen domain randomisation (lib/env.mjs), several seeds
 *   newton     Newton's MuJoCo-Warp on the GPU, MuJoCo's contacts (tools/newton)
 *   newton-nc  Newton's MuJoCo-Warp with Newton's own collision pipeline, as NVIDIA trains MicroDuck
 *   physx      Isaac Sim 4.5's PhysX (tools/isaac/scenario; only when no Isaac Sim is running)
 *
 * and how far each walked, turned, and whether it tipped.
 *
 *   node tools/train/cross-check.mjs --packs <a.scenario.json,...> [--brains shipped,<release id>,...]
 *        [--engines mujoco,pollen,newton,newton-nc,physx] [--seeds 8] [--out artifacts/cross-check/<name>]
 *
 * Writes <out>/results.json and prints a table. Engines that are not set up here are left out
 * (Newton: tools/newton/README.md; Isaac Sim: tools/isaac/README.md).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-node';
import { mujoco, PackEnv } from './lib/env.mjs';
import { loadPack } from './lib/pack.mjs';
import { incomingDir } from './lib/release.mjs';
import { seedOf } from './lib/rng.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ENGINES = ['mujoco', 'pollen', 'newton', 'newton-nc', 'physx'];
export const NEWTON_PYTHON = join(root, 'tools', 'newton', '.venv', 'Scripts', 'python.exe');
const ISAAC = process.env.ISAAC_SIM_PATH ?? 'D:\\Omniverse\\isaac-sim-4.5.0';

/** A brain's policy folder: shipped, or a release in public/policies/incoming. */
export function brainDir(brain) {
  return brain === 'shipped' ? join(root, 'public', 'policies', 'microduck') : join(incomingDir(root), basename(brain));
}

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = /\.(bat|cmd)$/i.test(command) ? spawn('cmd.exe', ['/c', command, ...args], { cwd: root }) : spawn(command, args, { cwd: root });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 || options.anyCode ? done(out) : fail(new Error(`${basename(command)} exited ${code}: ${(err || out).trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

/** JSON lines a runner printed (one per brain). */
const jsonLines = (text) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));

/** Walked (m, sampled every half second), turned (deg) and first tip (s) from trunk rows [t, x, y, z, qw, qx, qy, qz, tipped]. */
export function trunkMetrics(rows, fellAt) {
  let walked = 0;
  const pts = rows.filter((_, i) => i % 25 === 0).concat([rows.at(-1)]);
  for (let i = 1; i < pts.length; i++) walked += Math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  let turned = 0;
  let prev = null;
  for (const r of rows) {
    const [w, x, y, z] = r.slice(4, 8);
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    if (prev !== null) {
      let d = yaw - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turned += d;
    }
    prev = yaw;
  }
  return { fellAt: fellAt ?? null, walkedM: +walked.toFixed(3), turnedDeg: Math.round((turned * 180) / Math.PI) };
}

async function mujocoReplay(packPath, folder, brain) {
  const trace = join(folder, `mujoco-trace-${brain}.json`);
  await run(process.execPath, [join(root, 'tools/train/replay.mjs'), packPath, '--policies', brainDir(brain), '--trace', trace, '--quiet']);
  const t = JSON.parse(readFileSync(trace, 'utf8'));
  return trunkMetrics(t.trunk, t.fellAt);
}

/** The pollen randomisation, `seeds` episodes over the pack's length (no fall recovery: an episode ends at a fall). */
async function pollenEpisodes(mj, loaded, brain, seeds) {
  const env = new PackEnv(mj, loaded, { randomize: 'pollen' });
  const session = await ort.InferenceSession.create(readFileSync(join(brainDir(brain), 'walk.onnx')));
  const obs = new Float32Array(61);
  const horizon = Math.min(900, env.steps.length);
  let falls = 0;
  let distance = 0;
  for (let s = 0; s < seeds; s++) {
    const ep = env.episode(seedOf(4242, s), { noise: true });
    while (ep.t < horizon) {
      env.observe(ep, obs, 0);
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', obs, [1, 61]) });
      if (!env.act(ep, Float32Array.from(out[session.outputNames[0]].data))) break;
    }
    if (ep.fallen) falls++;
    distance += env.distance(ep);
    env.dispose(ep);
  }
  return { fallRate: +(falls / seeds).toFixed(3), meanDistanceM: +(distance / seeds).toFixed(3), seeds };
}

export async function crossCheck(o, onEvent = () => {}) {
  const brains = o.brains ?? ['shipped'];
  const engines = (o.engines ?? ENGINES).filter((e) => {
    if (e.startsWith('newton') && !existsSync(NEWTON_PYTHON)) return onEvent({ type: 'skip', engine: e, why: 'Newton is not set up (tools/newton/README.md)' }), false;
    if (e === 'physx' && !existsSync(join(ISAAC, 'python.bat'))) return onEvent({ type: 'skip', engine: e, why: `no Isaac Sim at ${ISAAC}` }), false;
    return true;
  });
  const out = resolve(o.out ?? join(root, 'artifacts', 'cross-check', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)));
  mkdirSync(out, { recursive: true });
  const mj = await mujoco();
  const results = [];
  for (const packPath of o.packs.map((p) => resolve(p))) {
    const pack = basename(packPath).replace(/\.scenario\.json$/, '');
    const folder = join(out, 'packs', pack);
    mkdirSync(folder, { recursive: true });
    onEvent({ type: 'pack', pack });
    // The pack for the other engines, with MuJoCo's run of it by the shipped brain (start poses, ghost).
    await run(process.execPath, [join(root, 'tools/train/replay.mjs'), packPath, '--export', folder, '--trace', join(folder, 'mujoco-trace.json'), '--quiet']);
    const loaded = loadPack(packPath, root);
    const add = (engine, brain, metrics) => {
      const row = { pack, engine, brain, ...metrics };
      results.push(row);
      onEvent({ type: 'result', ...row });
    };
    for (const engine of engines) {
      try {
        if (engine === 'mujoco') for (const brain of brains) add(engine, brain, await mujocoReplay(packPath, folder, brain));
        else if (engine === 'pollen') for (const brain of brains) add(engine, brain, await pollenEpisodes(mj, loaded, brain, o.seeds ?? 8));
        else if (engine.startsWith('newton')) {
          const text = await run(NEWTON_PYTHON, [join(root, 'tools/newton/run_pack.py'), folder, '--contacts', engine === 'newton' ? 'mujoco' : 'newton',
            '--policies', brains.map(brainDir).join(','), '--labels', brains.join(','), '--out', `${engine}-trace.json`]);
          for (const s of jsonLines(text)) {
            const t = JSON.parse(readFileSync(join(folder, brains.length > 1 ? `${engine}-trace-${s.brain}.json` : `${engine}-trace.json`), 'utf8'));
            add(engine, s.brain, trunkMetrics(t.trunk, s.fellAt));
          }
        } else if (engine === 'physx') {
          const text = await run(join(ISAAC, 'python.bat'), [join(root, 'tools/isaac/scenario/run_pack.py'), folder, '--policies', brains.map(brainDir).join(','), '--labels', brains.join(',')]);
          for (const s of jsonLines(text)) {
            const t = JSON.parse(readFileSync(join(folder, brains.length > 1 ? `isaac-trace-${s.brain}.json` : 'isaac-trace.json'), 'utf8'));
            add(engine, s.brain, trunkMetrics(t.trunk, s.fellAt));
          }
        }
      } catch (err) {
        onEvent({ type: 'error', pack, engine, message: err.message });
      }
    }
  }
  // Per brain and engine: how many packs it tipped on, and how far it walked on average.
  const table = [];
  for (const brain of brains) {
    for (const engine of engines) {
      const rows = results.filter((r) => r.brain === brain && r.engine === engine);
      if (!rows.length) continue;
      table.push(
        engine === 'pollen'
          ? { brain, engine, packs: rows.length, falls: +(rows.reduce((a, r) => a + r.fallRate, 0) / rows.length).toFixed(3), walkedM: +(rows.reduce((a, r) => a + r.meanDistanceM, 0) / rows.length).toFixed(3) }
          : { brain, engine, packs: rows.length, falls: rows.filter((r) => r.fellAt !== null).length / rows.length, walkedM: +(rows.reduce((a, r) => a + r.walkedM, 0) / rows.length).toFixed(3) },
      );
    }
  }
  const report = { at: new Date().toISOString(), packs: o.packs.map((p) => basename(p)), brains, engines, seeds: o.seeds ?? 8, results, table };
  writeFileSync(join(out, 'results.json'), JSON.stringify(report, null, 1));
  return { out, ...report };
}

// --- CLI -------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const packs = (opt('packs') ?? '').split(',').filter(Boolean);
  if (!packs.length) {
    console.error('usage: node tools/train/cross-check.mjs --packs <a.scenario.json,...> [--brains shipped,<release>] [--engines mujoco,pollen,newton,newton-nc,physx] [--seeds 8] [--out <dir>]');
    process.exit(2);
  }
  const report = await crossCheck(
    {
      packs,
      brains: opt('brains')?.split(',').filter(Boolean),
      engines: opt('engines')?.split(',').filter(Boolean),
      seeds: opt('seeds') ? Number(opt('seeds')) : undefined,
      out: opt('out'),
    },
    (e) => {
      if (e.type === 'pack') console.log(`== ${e.pack}`);
      else if (e.type === 'result') console.log(`  ${e.engine.padEnd(9)} ${e.brain.padEnd(32)} ${e.fallRate !== undefined ? `falls ${(e.fallRate * 100).toFixed(0)}% of ${e.seeds}, ${e.meanDistanceM} m` : `${e.walkedM} m, ${e.turnedDeg} deg, ${e.fellAt === null ? 'stayed up' : `tipped at ${e.fellAt.toFixed(1)} s`}`}`);
      else if (e.type === 'skip') console.log(`(${e.engine} left out: ${e.why})`);
      else if (e.type === 'error') console.log(`  ${e.engine}: ERROR ${e.message}`);
    },
  );
  console.log(`\n| brain | engine | packs | falls | walked (m) |\n| --- | --- | --- | --- | --- |`);
  for (const r of report.table) console.log(`| ${r.brain} | ${r.engine} | ${r.packs} | ${(r.falls * 100).toFixed(0)}% | ${r.walkedM.toFixed(2)} |`);
  console.log(`\nwritten to ${join(report.out, 'results.json')}`);
}
