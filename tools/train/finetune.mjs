// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Local fine-tune of the walking policy on scenario packs from the headset:
 * the room, terrain and moment where the duck struggled become training
 * environments in MuJoCo on this PC, and evolution strategies (antithetic
 * sampling, rank fitness, Adam) learn a change to the policy's last layer
 * that keeps the duck up and walking as commanded there, with shoves and
 * noise for robustness. CPU only, minutes, no Python.
 *
 *   node tools/train/finetune.mjs <pack> [<pack> ...] [--iterations 30] [--pairs 24]
 *        [--steps 400] [--workers 11] [--name room-tuned] [--randomize pollen|basic] [--publish] [--dry]
 *
 * It evaluates before and after on held-out seeds (fall rate, distance,
 * command tracking) plus plain floor (to catch regressions), and writes a
 * release (walk.onnx with the change baked in, the other policies, and a
 * manifest) to public/policies/incoming/<release>/ when the result is
 * better. --publish also makes it the active release the headset offers.
 *
 * Deeper training (PPO from scratch, MJX on a GPU, Isaac Lab) uses the same
 * packs through tools/train/connector.mjs.
 */
import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paramCount, readPolicy } from './lib/policy.mjs';
import { writeRelease } from './lib/release.mjs';
import { noiseVector, seedOf } from './lib/rng.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER_FILE = fileURLToPath(new URL('./lib/es-worker.mjs', import.meta.url));

export const DEFAULTS = {
  iterations: 30,
  pairs: 24,
  steps: 400,
  evalSeeds: 6,
  evalEvery: 5,
  sigma: 1,
  learningRate: 0.08,
  weightDecay: 0.005,
  /** Typical joint-target change of one noise sample (rad). */
  actionNoise: 0.03,
  biasNoise: 0.01,
  seed: 1,
  /** Domain randomisation: pollen (Pollen's and NVIDIA's MicroDuck recipe, lib/env.mjs) or basic (shoves only). */
  randomize: 'pollen',
  // Each worker loads its own MuJoCo and ONNX Runtime (a few hundred MB):
  // DUCKLAB_WORKERS caps them on a machine short of memory.
  workers: Math.max(1, Math.min(Number(process.env.DUCKLAB_WORKERS) || 11, cpus().length - 1)),
  policyDir: 'public/policies/microduck',
};

class Pool {
  constructor(count, init) {
    this.workers = [];
    this.pending = new Map();
    this.nextId = 1;
    this.ready = Promise.all(
      Array.from({ length: count }, () => {
        const worker = fork(WORKER_FILE, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        this.workers.push(worker);
        return new Promise((resolveReady, reject) => {
          worker.on('message', (msg) => {
            if (msg.type === 'ready') resolveReady(msg);
            else if (msg.type === 'done') {
              this.pending.get(msg.id)?.resolve(msg.results);
              this.pending.delete(msg.id);
            } else if (msg.type === 'error') {
              const waiter = this.pending.get(msg.id);
              if (waiter) {
                waiter.reject(new Error(msg.message));
                this.pending.delete(msg.id);
              } else reject(new Error(msg.message));
            }
          });
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code) reject(new Error(`trainer worker exited with code ${code}`));
          });
          worker.send({ type: 'init', ...init });
        });
      }),
    );
  }

  /** Spreads jobs over the workers and returns the results in job order. */
  async run(jobs, mean, scale, sigma) {
    const shares = this.workers.map(() => []);
    jobs.forEach((job, i) => shares[i % shares.length].push(job));
    const parts = await Promise.all(
      shares.map((share, w) => {
        if (!share.length) return [];
        const id = this.nextId++;
        return new Promise((resolveRun, reject) => {
          this.pending.set(id, { resolve: resolveRun, reject });
          this.workers[w].send({ type: 'run', id, mean, scale, sigma, jobs: share });
        });
      }),
    );
    const byKey = new Map(parts.flat().map((r) => [r.key, r]));
    return jobs.map((job) => byKey.get(job.key));
  }

  close() {
    for (const worker of this.workers) worker.kill();
  }
}

function summarize(results) {
  const n = results.length || 1;
  const sum = (f) => results.reduce((a, r) => a + f(r), 0);
  return {
    episodes: results.length,
    fallRate: sum((r) => (r.fallen ? 1 : 0)) / n,
    meanReturn: sum((r) => r.ret) / n,
    meanDistance: sum((r) => r.distance) / n,
    tracking: sum((r) => r.track) / n,
    meanSurvivalSteps: sum((r) => r.steps) / n,
  };
}

/** Centered ranks in [-0.5, 0.5]. */
function centeredRanks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(values.length);
  order.forEach(([, i], rank) => {
    out[i] = rank / (values.length - 1) - 0.5;
  });
  return out;
}

/**
 * Runs a fine-tune. `onEvent` receives { type: 'status' | 'iteration' | 'eval' | 'done', ... }.
 * Returns the summary (and writes a release when it improved, unless dry).
 */
export async function finetune(options, onEvent = () => {}) {
  const o = { ...DEFAULTS, ...options };
  const packs = o.packs.map((p) => resolve(p));
  if (!packs.length) throw new Error('no scenario packs given');
  const policyPath = resolve(root, o.policyDir, 'walk.onnx');
  const policyBytes = readFileSync(policyPath);
  const { layer } = readPolicy(policyBytes);
  const params = paramCount(layer);
  const started = Date.now();
  onEvent({ type: 'status', message: `starting ${o.workers} workers on ${packs.length} pack(s)` });
  if (!['pollen', 'basic'].includes(o.randomize)) throw new Error(`randomize: pollen or basic, not ${o.randomize}`);
  const pool = new Pool(o.workers, { root, packs, policy: policyPath, steps: o.steps, flat: true, randomize: o.randomize });
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  options.signal?.addEventListener?.('abort', stop);
  try {
    const ready = await pool.ready;
    const featureNorm = ready[0].featureNorm || 10;
    // Noise in normalised units (sigma 1): a sample moves joint targets by about actionNoise.
    const scale = new Float32Array(params);
    const nW = layer.outputs * layer.features;
    scale.fill(o.actionNoise / featureNorm, 0, nW);
    scale.fill(o.biasNoise, nW);
    const mean = new Float32Array(params);
    const zero = new Float32Array(params);
    onEvent({ type: 'status', message: `features ${featureNorm.toFixed(1)} (norm); ${params} trainable values` });

    const evalJobs = (tag, flat = false) => {
      const jobs = [];
      const packList = flat ? [0] : packs.map((_, i) => i);
      for (const p of packList) {
        for (let e = 0; e < o.evalSeeds; e++) {
          jobs.push({ key: `${tag}-${p}-${e}`, pack: p, flat, seed: seedOf(9001, p, e), sign: 0, record: e === 0 && !flat });
        }
      }
      return jobs;
    };
    const evaluate = async (x, tag) => {
      const results = await pool.run(evalJobs(tag), x, scale, 0);
      return { ...summarize(results), paths: results.filter((r) => r.path).map((r) => r.path) };
    };
    const baseline = await evaluate(zero, 'base');
    const baselineFlat = summarize(await pool.run(evalJobs('base-flat', true), zero, scale, 0));
    onEvent({ type: 'eval', iteration: 0, label: 'baseline', metrics: baseline, flat: baselineFlat });

    // Adam on the normalised parameters (ascent).
    const m1 = new Float32Array(params);
    const m2 = new Float32Array(params);
    const noise = new Float32Array(params);
    const grad = new Float32Array(params);
    const merit = (m) => m.meanReturn - m.fallRate;
    let best = { merit: merit(baseline), x: zero.slice(), metrics: baseline, iteration: 0 };
    for (let it = 1; it <= o.iterations && !stopped; it++) {
      const t0 = Date.now();
      const jobs = [];
      for (let k = 0; k < o.pairs; k++) {
        for (const sign of [1, -1]) {
          for (let p = 0; p < packs.length; p++) {
            jobs.push({ key: `${k}:${sign}:${p}`, pack: p, seed: seedOf(o.seed, it, p), noiseSeed: seedOf(o.seed, it, 7919, k), sign });
          }
        }
      }
      const results = await pool.run(jobs, mean, scale, o.sigma);
      const fitness = new Float32Array(o.pairs * 2);
      results.forEach((r, i) => {
        const candidate = Math.floor(i / packs.length);
        fitness[candidate] += r.ret / packs.length;
      });
      const ranks = centeredRanks(Array.from(fitness));
      grad.fill(0);
      for (let k = 0; k < o.pairs; k++) {
        const w = ranks[2 * k] - ranks[2 * k + 1];
        noiseVector(seedOf(o.seed, it, 7919, k), noise);
        for (let i = 0; i < params; i++) grad[i] += w * noise[i];
      }
      const b1 = 0.9;
      const b2 = 0.999;
      for (let i = 0; i < params; i++) {
        const g = grad[i] / (o.pairs * o.sigma) - o.weightDecay * mean[i];
        m1[i] = b1 * m1[i] + (1 - b1) * g;
        m2[i] = b2 * m2[i] + (1 - b2) * g * g;
        const mh = m1[i] / (1 - b1 ** it);
        const vh = m2[i] / (1 - b2 ** it);
        mean[i] += (o.learningRate * mh) / (Math.sqrt(vh) + 1e-8);
      }
      const avg = fitness.reduce((a, v) => a + v, 0) / fitness.length;
      const falls = results.filter((r) => r.fallen).length / results.length;
      onEvent({
        type: 'iteration',
        iteration: it,
        of: o.iterations,
        meanFitness: avg,
        bestFitness: Math.max(...fitness),
        fallRate: falls,
        episodes: results.length,
        ms: Date.now() - t0,
      });
      if (it % o.evalEvery === 0 || it === o.iterations) {
        const metrics = await evaluate(mean, `it${it}`);
        onEvent({ type: 'eval', iteration: it, label: `iteration ${it}`, metrics });
        if (merit(metrics) > best.merit) best = { merit: merit(metrics), x: mean.slice(), metrics, iteration: it };
      }
    }
    const trainedFlat = summarize(await pool.run(evalJobs('best-flat', true), best.x, scale, 0));
    const improved =
      best.iteration > 0 &&
      (best.metrics.fallRate < baseline.fallRate - 1e-6 || best.metrics.meanReturn > baseline.meanReturn + 0.02) &&
      best.metrics.fallRate <= baseline.fallRate + 1e-6 &&
      trainedFlat.fallRate <= baselineFlat.fallRate + 1e-6;
    const theta = new Float32Array(params);
    for (let i = 0; i < params; i++) theta[i] = scale[i] * best.x[i];
    const summary = {
      packs: packs.map((p) => p.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/')),
      iterations: o.iterations,
      pairs: o.pairs,
      steps: o.steps,
      randomize: o.randomize,
      bestIteration: best.iteration,
      baseline,
      trained: best.metrics,
      flat: { baseline: baselineFlat, trained: trainedFlat },
      improved,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      stopped,
    };
    let release = null;
    if (improved && !o.dry) {
      release = await writeRelease({
        root,
        name: o.name ?? 'room-tuned',
        baseDir: resolve(root, o.policyDir),
        policyBytes,
        theta,
        summary,
        publish: !!o.publish,
      });
    }
    onEvent({ type: 'done', summary, release });
    return { summary, release, theta };
  } finally {
    pool.close();
  }
}

// --- CLI -------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const packs = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) packs.push(a);
    else if (a === '--publish' || a === '--dry') options[a.slice(2)] = true;
    else options[a.slice(2)] = /^-?[\d.]+$/.test(args[i + 1]) ? Number(args[++i]) : args[++i];
  }
  if (!packs.length) {
    console.error('usage: node tools/train/finetune.mjs <pack.scenario.json> [...] [--iterations N] [--pairs N] [--steps N] [--workers N] [--name NAME] [--randomize pollen|basic] [--publish] [--dry]');
    process.exit(2);
  }
  const pct = (v) => `${(v * 100).toFixed(0)}%`;
  const line = (m) =>
    `falls ${pct(m.fallRate)}, return ${m.meanReturn.toFixed(3)}, distance ${m.meanDistance.toFixed(2)} m, tracking ${pct(m.tracking)}`;
  await finetune({ ...options, packs }, (e) => {
    if (e.type === 'status') console.log(e.message);
    else if (e.type === 'iteration')
      console.log(
        `it ${String(e.iteration).padStart(3)}/${e.of}  fitness ${e.meanFitness.toFixed(3)} (best ${e.bestFitness.toFixed(3)})  falls ${pct(e.fallRate)}  ${e.episodes} episodes in ${(e.ms / 1000).toFixed(1)} s`,
      );
    else if (e.type === 'eval') console.log(`eval ${e.label}: ${line(e.metrics)}${e.flat ? `; plain floor ${line(e.flat)}` : ''}`);
    else if (e.type === 'done') {
      const s = e.summary;
      console.log(`done in ${s.seconds} s: best at iteration ${s.bestIteration}; ${s.improved ? 'improved' : 'no improvement'}`);
      console.log(`  before: ${line(s.baseline)}`);
      console.log(`  after:  ${line(s.trained)}`);
      console.log(`  plain floor before: ${line(s.flat.baseline)}; after: ${line(s.flat.trained)}`);
      if (e.release) console.log(`release ${e.release.id} -> ${e.release.dir}${e.release.active ? ' (active)' : ''}`);
      console.log(JSON.stringify({ improved: s.improved, release: e.release?.id ?? null }));
    }
  });
}
