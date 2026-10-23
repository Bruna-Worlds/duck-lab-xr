// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Trainer worker process (forked by finetune.mjs; onnxruntime-node is not
 * safe in worker threads): owns a MuJoCo scene per scenario pack and a batched
 * copy of the walking policy, and runs batches of episodes side by side.
 * Each episode is one candidate policy (the shared mean plus or minus a
 * seeded noise vector) on one pack with seeded randomisation. The main
 * thread only sends seeds and receives scores, so workers never wait on
 * each other within a batch.
 *
 * Messages in:  { type: 'init', root, packs: [path], policy: path, steps, flat }
 *               { type: 'run', id, mean: Float32Array, scale: Float32Array, sigma, jobs: [...], record }
 * Messages out: { type: 'ready', featureNorm } | { type: 'done', id, results } | { type: 'error', message }
 */
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { mujoco, PackEnv } from './env.mjs';
import { loadPack } from './pack.mjs';
import { featureSession, paramCount } from './policy.mjs';
import { noiseVector } from './rng.mjs';

/** Messages to and from the parent process (structured clone keeps typed arrays). */
const port = {
  postMessage: (message) => process.send(message),
  on: (event, handler) => process.on(event, handler),
};

/** The learned change may move a joint target at most this far from the policy (rad). */
const MAX_DELTA = 0.3;

let envs = [];
let flatEnvs = [];
let policy = null;
let steps = 400;
let params = 0;

async function init(msg) {
  const mj = await mujoco();
  steps = msg.steps;
  const loaded = msg.packs.map((path) => loadPack(path, msg.root));
  envs = loaded.map((l) => new PackEnv(mj, l));
  flatEnvs = msg.flat ? loaded.slice(0, 1).map((l) => new PackEnv(mj, l, { flat: true })) : [];
  policy = await featureSession(readFileSync(msg.policy));
  params = paramCount(policy.layer);
  // Size of the features at the packs' start states, for the noise scale.
  const obs = new Float32Array(61 * envs.length);
  const eps = envs.map((env, i) => {
    const ep = env.episode(1, { noise: false });
    env.observe(ep, obs, i * 61);
    return ep;
  });
  const out = await policy.session.run({ [policy.input]: new ort.Tensor('float32', obs, [envs.length, 61]) });
  const h = out[policy.features].data;
  let norm = 0;
  for (let i = 0; i < envs.length; i++) {
    let s = 0;
    for (let k = 0; k < policy.layer.features; k++) s += h[i * policy.layer.features + k] ** 2;
    norm += Math.sqrt(s);
  }
  eps.forEach((ep, i) => envs[i].dispose(ep));
  port.postMessage({ type: 'ready', featureNorm: norm / envs.length, params });
}

/** Runs a batch of episodes in lockstep; returns one score record per job. */
async function run(msg) {
  const { mean, scale, sigma, jobs } = msg;
  const B = jobs.length;
  const F = policy.layer.features;
  const O = policy.layer.outputs;
  const nW = O * F;
  const noise = new Float32Array(params);
  const deltas = jobs.map((job) => {
    const delta = new Float32Array(params);
    if (job.sign !== 0) noiseVector(job.noiseSeed, noise);
    for (let i = 0; i < params; i++) {
      const x = mean[i] + (job.sign !== 0 ? job.sign * sigma * noise[i] : 0);
      delta[i] = scale[i] * x;
    }
    return delta;
  });
  const slots = jobs.map((job) => {
    const env = job.flat ? flatEnvs[0] : envs[job.pack];
    const ep = env.episode(job.seed, { noise: job.noise !== false });
    return { env, ep, horizon: Math.min(steps, job.steps ?? steps), done: false, path: job.record ? [] : null };
  });
  const obs = new Float32Array(B * 61);
  const action = new Float32Array(O);
  const tensorDims = [B, 61];
  let active = B;
  for (let t = 0; active > 0; t++) {
    for (let i = 0; i < B; i++) {
      const s = slots[i];
      if (!s.done) s.env.observe(s.ep, obs, i * 61);
    }
    const out = await policy.session.run({ [policy.input]: new ort.Tensor('float32', obs, tensorDims) });
    const base = out[policy.output].data;
    const h = out[policy.features].data;
    for (let i = 0; i < B; i++) {
      const s = slots[i];
      if (s.done) continue;
      const delta = deltas[i];
      for (let j = 0; j < O; j++) {
        let d = delta[nW + j];
        const row = j * F;
        const hi = i * F;
        for (let k = 0; k < F; k++) d += delta[row + k] * h[hi + k];
        if (d > MAX_DELTA) d = MAX_DELTA;
        else if (d < -MAX_DELTA) d = -MAX_DELTA;
        action[j] = base[i * O + j] + d;
      }
      const alive = s.env.act(s.ep, action);
      if (s.path && s.ep.t % 10 === 0) s.path.push(s.env.trunk(s.ep).map((v) => Math.round(v * 1000) / 1000));
      if (!alive || s.ep.t >= s.horizon) {
        s.done = true;
        active--;
      }
    }
  }
  const results = slots.map((s, i) => {
    const r = {
      key: jobs[i].key,
      ret: s.ep.ret / s.horizon,
      fallen: s.ep.fallen,
      fellAt: s.ep.fellAt,
      steps: s.ep.t,
      distance: s.env.distance(s.ep),
      track: s.ep.track / Math.max(1, s.ep.t),
      path: s.path,
    };
    s.env.dispose(s.ep);
    return r;
  });
  port.postMessage({ type: 'done', id: msg.id, results });
}

port.on('message', (msg) => {
  const task = msg.type === 'init' ? init(msg) : msg.type === 'run' ? run(msg) : null;
  task?.catch((err) => port.postMessage({ type: 'error', id: msg.id, message: err?.stack ?? String(err) }));
});
// The trainer went away: stop too.
process.on('disconnect', () => process.exit(0));
