// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainers Duck Lab XR can hand its scenario packs to and take brains back
 * from. Whatever trains, the result is a walk.onnx with the walking policy's
 * contract (61 observations in, 14 joint targets out, 50 Hz; Pollen's
 * microduck_rl layout): the trainer page makes it a release (the shipped
 * policies it did not train beside it, a manifest) and cross-checks it in every
 * physics engine set up on this PC (cross-check.mjs) before offering it.
 *
 * Kinds:
 * - builtin: the local fine-tune (finetune.mjs: evolution strategies on the
 *   policy's last layer, MuJoCo on the CPU, the packs, the pollen randomisation).
 * - command: a trainer run as a command on this PC. It gets, as environment:
 *     DUCKLAB_JOB    the job (duckdash.trainjob.v1, tools/train/lib/export.mjs trainJob)
 *     DUCKLAB_PACKS  the exported packs (one folder each: scene.xml, assets/, state.json, policies/)
 *     DUCKLAB_OUT    where to write walk.onnx, and metrics.json if it has numbers
 *     DUCKLAB_ENVS, DUCKLAB_ITERATIONS   the settings picked on the page
 *   and its output lines show on the page (a line with "iteration N/M" moves the bar).
 *   Pollen's microduck_rl and Isaac Lab 3 are defined below; others come from
 *   artifacts/trainers.json (or DUCKLAB_TRAINERS): a list of
 *   { id, title, about, cwd, command: [program, ...args], output?: "path of the onnx it writes" },
 *   where {envs}, {iterations}, {job}, {packs} and {out} in the arguments are filled in.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { policyHash } from './policy.mjs';
import { incomingDir, POLICY_FILES, rescanIndex, setActive } from './release.mjs';

/** Outside trainers live beside the repository, never in it (their code and licences stay theirs). */
export const trainersHome = (root) => resolve(root, '..', 'trainers');

const ISAAC_TASK = 'IsaacContrib-Velocity-Flat-MicroDuck';
/** Step-up runs (tools/train/python/duckstep) live with Pollen's under logs/rsl_rl/velocity, named *stepup*. */
const stepUpCheckpoint = (cwd) =>
  newest(join(cwd, 'logs', 'rsl_rl', 'velocity'), (n, dir) => /^model_\d+\.pt$/.test(n) && /stepup/.test(basename(dir)));

/** True once a file exists and its size held between two looks (a writer has finished with it). */
const sizes = new Map();
function settled(path) {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  const same = size > 0 && sizes.get(path) === size;
  sizes.set(path, size);
  return same;
}

/** Newest file matching `test(name, folder)` under `dir` (a trainer's latest checkpoint or export). */
function newest(dir, test) {
  let best = null;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (test(e.name, d)) {
        const t = statSync(p).mtimeMs;
        if (!best || t > best.t) best = { p, t };
      }
    }
  };
  walk(dir);
  return best?.p ?? null;
}

export function trainers(root) {
  const home = trainersHome(root);
  const list = [
    {
      id: 'es',
      kind: 'builtin',
      title: 'Duck Lab fine-tune',
      about: "Evolution strategies on the walking policy's last layer, in MuJoCo on this PC's CPU, on the picked packs, with the pollen randomisation. Minutes.",
      ready: true,
    },
    {
      id: 'microduck-rl',
      kind: 'command',
      title: "Pollen's microduck_rl",
      about: "Pollen's own recipe: PPO from scratch in mjlab (MuJoCo-Warp on the GPU) with the BAM model of the XL330 servos and their randomisation, on flat ground. Hours (4096 robots fit in 8 GB). Trains on its own terrain, not the packs.",
      cwd: join(home, 'microduck_rl'),
      install: 'tools/train/README.md, "Other trainers": git clone pollen-robotics/microduck_rl into ../trainers, apply the Windows changes, uv sync',
      ready: existsSync(join(home, 'microduck_rl', '.venv')),
      env: { WANDB_MODE: 'offline' },
      steps: [
        ['uv', 'run', 'train', 'Mjlab-Velocity-Flat-MicroDuck', '--env.scene.num-envs', '{envs}', '--agent.max-iterations', '{iterations}'],
        // The newest checkpoint, exported with the observation normaliser baked in, straight into the job's output.
        ['uv', 'run', 'scripts/export.py', 'Mjlab-Velocity-Flat-MicroDuck', '--checkpoint-file', '{checkpoint}', '--onnx-file', '{out}/walk.onnx', '--num-envs', '1'],
      ],
      checkpoint: (t) => newest(join(t.cwd, 'logs'), (n) => /^model_\d+\.pt$/.test(n)),
      output: (t) => newest(join(t.cwd, 'logs'), (n) => n.endsWith('.onnx')),
    },
    {
      id: 'microduck-stepup',
      kind: 'command',
      title: "Pollen's microduck_rl: step-up",
      about: "Climbing (tools/train/python/duckstep): Pollen's rough task on terraces whose steps grow from 1.5 to 4 cm, continuing the newest step-up run, walking forward. About 2.5 s a round for 1024 robots; it films 128 of them for 8 s every 200 rounds (videos/train). Trains on its own terraces, not the packs: the packs are for the cross-check.",
      cwd: join(home, 'microduck_rl'),
      install: 'tools/train/README.md, section 10: set up microduck_rl, then a first step-up run from the shipped brain',
      ready: existsSync(join(home, 'microduck_rl', '.venv')) && !!stepUpCheckpoint(join(home, 'microduck_rl')),
      env: { WANDB_MODE: 'offline', DUCKSTEP_VIDEO_ENVS: '128' },
      // Before the first step: which run and checkpoint to continue.
      // DUCKLAB_STEPUP_FROM=<run folder>/<model_N.pt> (under logs/rsl_rl/velocity) picks another one, such as
      // the best on the step test rather than the newest.
      prepare: (t, values) => {
        const from = process.env.DUCKLAB_STEPUP_FROM;
        const checkpoint = from ? join(t.cwd, 'logs', 'rsl_rl', 'velocity', from) : stepUpCheckpoint(t.cwd);
        if (!checkpoint || !existsSync(checkpoint)) throw new Error(`no step-up checkpoint${from ? ` ${from}` : ''} to continue`);
        values.resumeRun = basename(dirname(checkpoint));
        values.resumeCheckpoint = basename(checkpoint);
      },
      steps: [
        [
          'uv', 'run', 'python', join(root, 'tools', 'train', 'python', 'duckstep', 'train.py'),
          '--env.scene.num-envs', '{envs}', '--agent.max-iterations', '{iterations}',
          '--agent.resume', 'True', '--agent.load-run', '{resumeRun}', '--agent.load-checkpoint', '{resumeCheckpoint}',
          '--agent.algorithm.learning-rate', '2e-4', '--agent.algorithm.entropy-coef', '0.004',
          '--agent.logger', 'tensorboard', '--agent.run-name', 'ducklab-stepup',
          '--video', 'True', '--video-length', '400', '--video-interval', '4800',
        ],
      ],
      // Pollen's runner exports each checkpoint as <run>.onnx beside it, the normaliser baked in.
      output: (t) => newest(join(t.cwd, 'logs', 'rsl_rl', 'velocity'), (n, dir) => n.endsWith('.onnx') && /stepup/.test(basename(dir))),
    },
    {
      id: 'isaaclab',
      kind: 'command',
      title: 'Isaac Lab 3 (Newton)',
      about: "NVIDIA's MicroDuck task (IsaacContrib-Velocity-Flat-MicroDuck): PPO in Isaac Lab without Isaac Sim, on Newton's MuJoCo-Warp with the BAM servos, on flat ground. Hours. Trains on its own terrain, not the packs.",
      cwd: join(home, 'IsaacLab'),
      install: 'tools/train/README.md, "Other trainers": Isaac Lab main, kit-less (uv sync)',
      ready: existsSync(join(home, 'IsaacLab', '.venv')),
      // Its banner is UTF-8: on a Windows set to another code page (GBK here) it stops at the first line without these.
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      steps: [
        ['uv', 'run', 'isaaclab', 'train', '--rl_library', 'rsl_rl', '--task', ISAAC_TASK, '--num_envs', '{envs}', '--max_iterations', '{iterations}'],
        // play exports exported/policy.onnx beside the checkpoint, then plays until stopped: stop it once the file is whole.
        {
          command: ['uv', 'run', 'isaaclab', 'play', '--rl_library', 'rsl_rl', '--task', ISAAC_TASK, '--num_envs', '1', '--checkpoint', '{checkpoint}'],
          until: (values) => settled(join(dirname(values.checkpoint), 'exported', 'policy.onnx')),
        },
        // PyTorch 2.11 writes the weights beside the graph (policy.onnx.data): the headset loads one file.
        ['uv', 'run', 'python', '-I', join(root, 'tools', 'train', 'python', 'onnx_single_file.py'), '{checkpoint}', '{out}/walk.onnx'],
      ],
      checkpoint: (t) => newest(join(t.cwd, 'logs', 'rsl_rl'), (n) => /^model_\d+\.pt$/.test(n)),
    },
  ];
  // Yours: artifacts/trainers.json (or DUCKLAB_TRAINERS).
  const custom = process.env.DUCKLAB_TRAINERS ?? join(root, 'artifacts', 'trainers.json');
  if (existsSync(custom)) {
    for (const t of JSON.parse(readFileSync(custom, 'utf8'))) {
      const cwd = resolve(root, t.cwd ?? '.');
      list.push({
        id: String(t.id),
        kind: 'command',
        title: t.title ?? t.id,
        about: t.about ?? 'Your trainer (artifacts/trainers.json).',
        cwd,
        ready: existsSync(cwd),
        env: t.env ?? {},
        steps: [t.command],
        output: t.output ? () => resolve(cwd, t.output) : null,
      });
    }
  }
  return list;
}

export const publicTrainer = ({ id, kind, title, about, ready, install }) => ({ id, kind, title, about, ready, install: ready ? undefined : install });

const fill = (args, values) => args.map((a) => String(a).replace(/\{(\w+)\}/g, (m, k) => (values[k] !== undefined ? String(values[k]) : m)));

/** Runs a command trainer to its end; resolves to the walk.onnx it made. */
export async function runCommandTrainer(trainer, values, onLine, signal) {
  const env = {
    ...process.env,
    ...(trainer.env ?? {}),
    DUCKLAB_JOB: values.job,
    DUCKLAB_PACKS: values.packs,
    DUCKLAB_OUT: values.out,
    DUCKLAB_ENVS: String(values.envs),
    DUCKLAB_ITERATIONS: String(values.iterations),
  };
  trainer.prepare?.(trainer, values);
  for (const entry of trainer.steps) {
    // A step is a command, or { command, until(values) }: a command that runs on after it has made what it was
    // run for (Isaac Lab's play exports the ONNX, then plays until stopped), stopped once until() says so.
    const step = Array.isArray(entry) ? entry : entry.command;
    const until = Array.isArray(entry) ? null : entry.until;
    if (step.some((a) => String(a).includes('{checkpoint}'))) values.checkpoint = trainer.checkpoint?.(trainer);
    const [program, ...args] = fill(step, values);
    onLine(`$ ${program} ${args.join(' ')}`);
    await new Promise((done, fail) => {
      const child = spawn(program, args, { cwd: trainer.cwd, env, shell: process.platform === 'win32' });
      // On Windows the command runs under a shell: stop the whole tree, or the trainer under it keeps the GPU.
      const kill = () =>
        process.platform === 'win32' && child.pid ? spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill();
      let finished = false;
      const watch = until
        ? setInterval(() => {
            if (finished || !until(values)) return;
            finished = true;
            onLine(`(${program} made what it was run for: stopped)`);
            kill();
          }, 2000)
        : null;
      signal?.addEventListener?.('abort', kill);
      let tail = '';
      const take = (d) => {
        tail += d;
        const lines = tail.split(/\r?\n/);
        tail = lines.pop();
        for (const l of lines) if (l.trim()) onLine(l);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', fail);
      child.on('close', (code) => {
        if (watch) clearInterval(watch);
        signal?.removeEventListener?.('abort', kill);
        if (tail.trim()) onLine(tail);
        if (signal?.aborted) fail(new Error('stopped'));
        else if (code === 0 || finished) done();
        else fail(new Error(`${program} exited with ${code}`));
      });
    });
  }
  const made = existsSync(join(values.out, 'walk.onnx')) ? join(values.out, 'walk.onnx') : trainer.output?.(trainer);
  if (!made || !existsSync(made)) throw new Error(`${trainer.title} finished without a walk.onnx (in ${values.out})`);
  return made;
}

/** A policy that keeps the walking contract: one input [n, 61], one output [n, 14], finite on a standing observation. */
export async function checkPolicy(path) {
  const session = await ort.InferenceSession.create(readFileSync(path));
  const obs = new Float32Array(61);
  obs[5] = -1; // upright: gravity straight down
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', obs, [1, 61]) });
  const action = out[session.outputNames[0]].data;
  if (action.length !== 14) throw new Error(`the policy answers ${action.length} values, not 14`);
  if (!Array.from(action).every(Number.isFinite)) throw new Error('the policy answers non-finite values');
  return { input: session.inputNames[0], output: session.outputNames[0], standing: Array.from(action, (v) => +v.toFixed(4)) };
}

/** Makes a trained walk.onnx from any trainer a release beside the shipped policies it did not train. */
export async function writeTrainedRelease({ root, name, walkPath, baseDir, trainer, packs, metrics, settings, publish }) {
  const contract = await checkPolicy(walkPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'release';
  const id = `${stamp}-${slug}`;
  const dir = join(incomingDir(root), id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(walkPath, join(dir, 'walk.onnx'));
  const files = { 'walk.onnx': { hash: policyHash(readFileSync(walkPath)), trained: true } };
  for (const file of POLICY_FILES) {
    if (file === 'walk.onnx' || !existsSync(join(baseDir, file))) continue;
    copyFileSync(join(baseDir, file), join(dir, file));
    files[file] = { hash: policyHash(readFileSync(join(baseDir, file))), trained: false };
  }
  if (existsSync(join(baseDir, 'ATTRIBUTION.md'))) copyFileSync(join(baseDir, 'ATTRIBUTION.md'), join(dir, 'ATTRIBUTION.md'));
  const manifest = {
    version: 'duckdash.policyrelease.v1',
    id,
    name,
    createdAt: new Date().toISOString(),
    trainer: { kind: trainer.id, description: `${trainer.title}: ${trainer.about}`, ...settings },
    base: { walkHash: policyHash(readFileSync(join(baseDir, 'walk.onnx'))) },
    trainedOn: packs,
    results: { trained: metrics ?? null },
    files,
    control: { obs: 61, actions: 14, hz: 50, convention: 'Pollen microduck_rl (see the scenario pack control block)', checked: contract },
    note: 'Walking policy from an outside trainer; the other policies are Pollen Robotics Microduck policies, see ATTRIBUTION.md.',
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  let index = rescanIndex(root);
  if (publish) index = setActive(root, id);
  return { id, dir, walkHash: files['walk.onnx'].hash, active: index.active === id };
}

/** Adds a cross-check's verdict to a release's manifest (the page shows it). */
export function recordCrossCheck(root, id, report) {
  const file = join(incomingDir(root), id, 'manifest.json');
  if (!existsSync(file)) return;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.crossCheck = { at: report.at, out: report.out, packs: report.packs, engines: report.engines, table: report.table };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
