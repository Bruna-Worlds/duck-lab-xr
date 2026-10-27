// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck Lab XR trainer: the computer side of Duck Lab XR's training loop, as a local web
 * app (no install beyond this repo's node_modules).
 *
 *   npm run lab            (or: node tools/lab/server.mjs [--port 8790] [--open])
 *   then open http://localhost:8790 (--open does it for you)
 *
 * - Inbox: scenario packs the headset sent (artifacts/scenarios, watched
 *   live) and motion datasets (artifacts/datasets).
 * - Scene: a top-down map of a pack (terrain, course pieces, start) and
 *   desktop replays in MuJoCo with the shipped or a trained policy.
 * - Train: the local fine-tune (tools/train/finetune.mjs) on the selected
 *   packs, or another trainer on this PC (tools/train/lib/trainers.mjs:
 *   Pollen's microduck_rl, Isaac Lab, yours), with live progress and a
 *   release; every new release is then cross-checked in the other physics
 *   engines set up here (tools/train/cross-check.mjs).
 * - Cross-check: brains on packs in MuJoCo, MuJoCo with the pollen
 *   randomisation, Newton and PhysX, side by side.
 * - Releases: trained policy sets in public/policies/incoming; making one
 *   active offers it to the headset (the app polls the index in dev).
 * - Connect: export packs plus a job description for external trainers
 *   (MJX, Isaac Lab, a cloud queue), see tools/train/README.md.
 * - Isaac Sim: a pack as a test case in the streaming Isaac Sim on this PC
 *   (tools/isaac, its bridge's /ducklab/testcase): Pip under PhysX beside
 *   MuJoCo's run of the same pack as an orange ghost, in the stream.
 *
 * Listens on 127.0.0.1 only. Pages it answers: its own (above) and the
 * trainer page of the Duck Lab XR website (<site>/trainer/: the public site
 * https://duck.bruna.world, or the dev server on this computer,
 * https://localhost:8081/trainer/ or this PC's address), which pairs with the
 * headset over WebRTC and passes packs and brains through here (POST
 * /api/inbox, GET /api/releases/<id>/files/<name>). Requests from any other
 * web page are refused. DUCKLAB_SITES adds origins (comma list).
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { finetune, DEFAULTS } from '../train/finetune.mjs';
import { mujoco, PackEnv } from '../train/lib/env.mjs';
import { exportBundle, TARGETS } from '../train/lib/bundle.mjs';
import { loadPack, summarizePack } from '../train/lib/pack.mjs';
import { policyHash } from '../train/lib/policy.mjs';
import { publishRelease } from '../train/lib/hub.mjs';
import { incomingDir, rescanIndex, setActive } from '../train/lib/release.mjs';
import { writeDuckVisuals } from '../isaac/scenario/duck-visuals.mjs';
import { crossCheck, ENGINES } from '../train/cross-check.mjs';
import { exportPack, trainJob } from '../train/lib/export.mjs';
import { publicTrainer, recordCrossCheck, runCommandTrainer, trainers, writeTrainedRelease } from '../train/lib/trainers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const uiDir = join(root, 'tools', 'lab', 'ui');
const scenarioDir = join(root, 'artifacts', 'scenarios');
const datasetDir = join(root, 'artifacts', 'datasets');
const connectorDir = join(root, 'artifacts', 'connector');
const shippedDir = join(root, 'public', 'policies', 'microduck');
const threeDir = join(root, 'node_modules', 'three');
const duckDir = join(root, 'public', 'asset-packs', 'pollen-microduck');
const isaacTestDir = join(root, 'artifacts', 'isaac-test');
const playerFile = join(root, 'public', 'isaac', 'player.html');
/** Kit's web server with the Duck Lab XR bridge: DUCKLAB_ISAAC, else 8211 (start-isaac-sim.ps1), else Isaac Sim 4.5's own 8011. */
const ISAAC_ADDRESSES = process.env.DUCKLAB_ISAAC ? [process.env.DUCKLAB_ISAAC] : ['127.0.0.1:8211', '127.0.0.1:8011'];
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8790;
// Tests only: a stand-in Hub on this machine (tools/test/hub-publish-check.mjs).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const hubUrl = (process.env.DUCKLAB_HUB_URL ?? '').startsWith('http://') && LOCAL_HOST.test(new URL(process.env.DUCKLAB_HUB_URL).host) ? process.env.DUCKLAB_HUB_URL : undefined;

/** The public Duck Lab XR website: its own address, and its Vercel address. */
const PUBLIC_SITES = ['https://duck.bruna.world', 'https://duck-lab-xr.vercel.app'];

/**
 * The Duck Lab XR website's origins: the public site, the dev server on 8081
 * (by name and by each of this PC's addresses), plus DUCKLAB_SITES.
 */
function siteOrigins() {
  const hosts = new Set(['localhost', '127.0.0.1']);
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) if (address.family === 'IPv4' || address.family === 4) hosts.add(address.address);
  }
  const origins = new Set(PUBLIC_SITES);
  for (const host of hosts) origins.add(`https://${host}:8081`);
  for (const extra of (process.env.DUCKLAB_SITES ?? '').split(',').map((o) => o.trim()).filter(Boolean)) origins.add(extra);
  return origins;
}
const SITE_ORIGINS = siteOrigins();

mkdirSync(scenarioDir, { recursive: true });
mkdirSync(datasetDir, { recursive: true });

// --- Live events (server-sent events) -----------------------------------------
const clients = new Set();
function broadcast(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}

// --- Inbox -------------------------------------------------------------------------
const summaryCache = new Map();
function packs() {
  const out = [];
  for (const file of readdirSync(scenarioDir)) {
    if (!file.endsWith('.scenario.json')) continue;
    const path = join(scenarioDir, file);
    const mtime = statSync(path).mtimeMs;
    const cached = summaryCache.get(path);
    if (cached && cached.mtime === mtime) {
      out.push(cached.summary);
      continue;
    }
    try {
      const summary = summarizePack(path);
      summaryCache.set(path, { mtime, summary });
      out.push(summary);
    } catch (err) {
      out.push({ id: file.replace(/\.scenario\.json$/, ''), file, error: String(err) });
    }
  }
  return out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

const datasetCache = new Map();
function datasets() {
  const out = [];
  for (const file of readdirSync(datasetDir)) {
    if (!file.endsWith('.dataset.json')) continue;
    const path = join(datasetDir, file);
    const mtime = statSync(path).mtimeMs;
    let summary = datasetCache.get(path)?.mtime === mtime ? datasetCache.get(path).summary : null;
    if (!summary) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8'));
        summary = {
          id: file.replace(/\.dataset\.json$/, ''),
          file,
          at: d.at ?? '',
          motion: d.motion?.name ?? d.motionName ?? basename(file).split('-').pop()?.replace('.dataset.json', ''),
          episodes: d.episodeLengths?.length ?? 0,
          steps: (d.episodeLengths ?? []).reduce((a, n) => a + n, 0),
          stood: (d.successFlags ?? []).filter(Boolean).length,
          bytes: statSync(path).size,
        };
      } catch (err) {
        summary = { id: file, file, error: String(err) };
      }
      datasetCache.set(path, { mtime, summary });
    }
    out.push(summary);
  }
  return out.sort((a, b) => String(b.file).localeCompare(String(a.file)));
}

function packPath(id) {
  const path = join(scenarioDir, `${basename(id)}.scenario.json`);
  if (!existsSync(path)) throw httpError(404, `no pack ${id}`);
  return path;
}

let inboxTimer = null;
watch(scenarioDir, () => {
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(() => broadcast('inbox', { packs: packs() }), 400);
});
watch(datasetDir, () => {
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(() => broadcast('inbox', { packs: packs(), datasets: datasets() }), 400);
});

// --- Scene map ---------------------------------------------------------------------
function attr(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}
const nums = (s) => (s ?? '').trim().split(/\s+/).filter(Boolean).map(Number);

function packMap(id) {
  const { pack } = { pack: JSON.parse(readFileSync(packPath(id), 'utf8')) };
  const pieces = [];
  for (const m of pack.mjcf.matchAll(/<geom\b[^>]*\bname="course_\d+"[^>]*\/>/g)) {
    const tag = m[0];
    pieces.push({
      type: attr(tag, 'type') ?? 'sphere',
      size: nums(attr(tag, 'size')),
      pos: nums(attr(tag, 'pos')),
      quat: nums(attr(tag, 'quat') ?? '1 0 0 0'),
    });
  }
  let terrain = null;
  if (pack.terrain) {
    // Max-pool 201 x 201 cells to 101 x 101 for the map.
    const bytes = Buffer.from(pack.terrain.data, 'base64');
    const full = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const n = pack.terrain.nrow;
    const m = Math.ceil(n / 2);
    const small = new Float32Array(m * m);
    let max = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = Math.floor(r / 2) * m + Math.floor(c / 2);
        const h = full[r * n + c];
        if (h > small[i]) small[i] = h;
        if (h > max) max = h;
      }
    }
    const hf = pack.mjcf.match(/<hfield name="live-terrain"[^>]*>/)?.[0] ?? '';
    const tgeom = pack.mjcf.match(/<geom\b[^>]*\bname="terrain"[^>]*\/>/)?.[0] ?? '';
    terrain = {
      size: m,
      max,
      data: Buffer.from(small.buffer).toString('base64'),
      hfieldSize: nums(attr(hf, 'size')),
      pos: nums(attr(tgeom, 'pos')),
    };
  }
  const q = pack.start.qpos;
  const yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
  return {
    id,
    reason: pack.reason,
    at: pack.at,
    playground: pack.playground?.title ?? '',
    start: { x: q[0], y: q[1], yaw },
    end: { x: pack.end.qpos[0], y: pack.end.qpos[1], mode: pack.end.mode },
    pieces,
    terrain,
    events: pack.events ?? [],
    room: pack.room ?? {},
    commands: pack.steps.filter((_, i) => i % 10 === 0).map((s) => [s[1], s[2]]),
  };
}

// --- Desktop replay ------------------------------------------------------------------
async function replay(id, releaseId) {
  const loaded = loadPack(packPath(id), root);
  const mj = await mujoco();
  const env = new PackEnv(mj, loaded);
  const folder = releaseId ? join(incomingDir(root), basename(releaseId)) : shippedDir;
  const bytes = readFileSync(join(folder, 'walk.onnx'));
  const session = await ort.InferenceSession.create(bytes);
  const ep = env.episode(1, { noise: false });
  const obs = new Float32Array(61);
  const action = new Float32Array(14);
  const path = [];
  // Poses for the 3D view at 25 Hz: trunk position and quaternion, then the 14 joint angles.
  const frames = [];
  const frame = () => {
    const q = ep.data.qpos;
    const f = [];
    for (let i = 0; i < 7; i++) f.push(Math.round(q[env.freeAdr + i] * 10000) / 10000);
    for (const a of env.qposAdr) f.push(Math.round(q[a] * 10000) / 10000);
    frames.push(f);
  };
  frame();
  const steps = env.steps.length;
  for (let t = 0; t < steps; t++) {
    env.observe(ep, obs, 0);
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', obs, [1, 61]) });
    action.set(out[session.outputNames[0]].data);
    const alive = env.act(ep, action);
    if (t % 2 === 1 || !alive) frame();
    if (t % 5 === 0 || !alive) {
      const [x, y, z] = env.trunk(ep);
      path.push([round(x), round(y), round(z)]);
    }
    if (!alive) {
      // Keep showing the fall for a second and a half.
      for (let k = 0; k < 75; k++) {
        for (let s = 0; s < env.control.decimation; s++) mj.mj_step(env.model, ep.data);
        if (k % 2 === 1) frame();
      }
      break;
    }
  }
  const result = {
    id,
    release: releaseId ?? null,
    walkHash: policyHash(bytes),
    steps: ep.t,
    of: steps,
    fell: ep.fallen,
    fellAt: ep.fellAt,
    distance: round(env.distance(ep)),
    tracking: round(ep.track / Math.max(1, ep.t)),
    path,
    frames,
  };
  env.dispose(ep);
  return result;
}
const round = (v) => Math.round(v * 1000) / 1000;

// --- Isaac Sim test cases ------------------------------------------------------------
let isaacAddress = null; // the address that answered last

/** A request to the bridge, wherever it answers; its JSON (error statuses carry JSON too). */
async function isaac(path, init = {}) {
  const order = isaacAddress ? [isaacAddress, ...ISAAC_ADDRESSES.filter((a) => a !== isaacAddress)] : ISAAC_ADDRESSES;
  for (const address of order) {
    let res;
    try {
      res = await fetch(`http://${address}${path}`, { ...init, signal: AbortSignal.timeout(init.timeout ?? 5000) });
    } catch {
      continue; // nothing there
    }
    isaacAddress = address;
    if (res.status === 404) throw httpError(502, `Isaac Sim at ${address} runs an older Duck Lab XR bridge without test cases: restart it`);
    return res.json();
  }
  throw httpError(503, `Isaac Sim is not answering on ${ISAAC_ADDRESSES.join(' or ')}: start it with tools/isaac/start-isaac-sim.ps1`);
}

function runNode(args) {
  return new Promise((done, fail) => {
    execFile(process.execPath, args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? fail(new Error(String(stderr || err.message).trim().split('\n').pop())) : done(stdout)));
  });
}

/**
 * A pack as a test case in Isaac Sim: exported with MuJoCo's run of it (replay.mjs --export
 * --trace, the brain it ran or a release), then built and run by the bridge.
 */
async function isaacRun(id, releaseId) {
  const pack = packPath(id);
  const folder = join(isaacTestDir, `${basename(id)}${releaseId ? `-${basename(releaseId)}` : ''}`);
  mkdirSync(folder, { recursive: true });
  const args = [join(root, 'tools', 'train', 'replay.mjs'), pack, '--export', folder, '--trace', join(folder, 'mujoco-trace.json'), '--quiet'];
  if (releaseId) args.push('--policies', join(incomingDir(root), basename(releaseId)));
  await runNode(args);
  writeDuckVisuals(folder); // Pip as the app draws him (servos and all), not the MJCF's collision shells
  const title = `${id}, ${releaseId ? `brain ${releaseId}` : 'shipped brain'}`;
  const reply = await isaac('/ducklab/testcase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder, title }) });
  if (!reply.ok) throw httpError(502, reply.error ?? 'Isaac Sim refused the test case');
  return { ok: true, folder, title, bridge: isaacAddress };
}

/** The bridge's test case, and whether a Duck Lab XR page holds its stream. */
async function isaacState() {
  try {
    const [status, testcase] = await Promise.all([isaac('/ducklab/status', { timeout: 2000 }), isaac('/ducklab/testcase', { timeout: 2000 })]);
    return { available: true, bridge: isaacAddress, stream: status.stream, appConnected: status.connected, testcase };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

// --- Training jobs -------------------------------------------------------------------
const jobs = new Map();
let jobCounter = 0;
/** The engines a new brain is checked in before it is offered (the quick ones; the page runs the rest). */
const GATE_ENGINES = ['mujoco', 'pollen', 'newton'];

function startJob(body) {
  if ([...jobs.values()].some((j) => j.state === 'running')) throw httpError(409, 'a training job is already running');
  const ids = Array.isArray(body.packs) ? body.packs : [];
  if (!ids.length) throw httpError(400, 'select at least one scenario pack');
  const paths = ids.map(packPath);
  const trainer = trainers(root).find((t) => t.id === (body.trainer ?? 'es'));
  if (!trainer) throw httpError(400, `no trainer ${body.trainer}`);
  if (!trainer.ready) throw httpError(400, `${trainer.title} is not set up on this PC: ${trainer.install ?? ''}`);
  const id = `job-${Date.now().toString(36)}-${++jobCounter}`;
  const controller = new AbortController();
  const builtin = trainer.kind === 'builtin';
  const job = {
    id,
    state: 'running',
    trainer: trainer.id,
    startedAt: new Date().toISOString(),
    options: builtin
      ? {
          iterations: clampInt(body.iterations, 1, 200, DEFAULTS.iterations),
          pairs: clampInt(body.pairs, 4, 64, DEFAULTS.pairs),
          steps: clampInt(body.steps, 100, 1500, 900),
          name: String(body.name || 'room-tuned').slice(0, 40),
          randomize: body.randomize === 'basic' ? 'basic' : 'pollen',
          publish: !!body.publish,
        }
      : {
          envs: clampInt(body.envs, 16, 8192, 2048),
          iterations: clampInt(body.iterations, 1, 50000, 1500),
          name: String(body.name || trainer.id).slice(0, 40),
          publish: false, // offered by hand, after the cross-check
        },
    packs: ids,
    events: [],
    controller,
  };
  jobs.set(id, job);
  let logLines = 0;
  const onEvent = (event) => {
    const e = { ...event, at: Date.now() };
    if (e.metrics?.paths) e.metrics = { ...e.metrics, paths: undefined };
    job.events.push(e);
    // Hours of a trainer's output: keep the newest lines (the page and /api/state carry them all).
    if (e.type === 'log' && ++logLines > 600) {
      let drop = 200;
      job.events = job.events.filter((x) => x.type !== 'log' || drop-- <= 0);
      logLines -= 200;
    }
    broadcast('job', { id, event: e });
  };
  const work = builtin
    ? finetune({ ...job.options, packs: paths, signal: controller.signal }, onEvent).then((result) => {
        job.result = { summary: result.summary, release: result.release };
        return result.release;
      })
    : runOutsideTrainer(job, trainer, paths, onEvent);
  work
    .then(async (release) => {
      if (release && !controller.signal.aborted) {
        broadcast('releases', rescanIndex(root));
        onEvent({ type: 'status', message: `cross-checking ${release.id} in the other engines` });
        try {
          const report = await crossCheck(
            { packs: paths, brains: ['shipped', release.id], engines: GATE_ENGINES, seeds: 6, out: join(root, 'artifacts', 'cross-check', release.id) },
            (e) => onEvent({ ...e, type: 'crosscheck', kind: e.type }),
          );
          recordCrossCheck(root, release.id, report);
          job.result.crossCheck = report.table;
        } catch (err) {
          onEvent({ type: 'status', message: `cross-check failed: ${err.message}` });
        }
      }
      job.state = 'done';
      broadcast('job', { id, state: 'done', result: job.result });
      broadcast('releases', rescanIndex(root));
    })
    .catch((err) => {
      job.state = 'failed';
      job.error = err?.message ?? String(err);
      broadcast('job', { id, state: 'failed', error: job.error });
    });
  return publicJob(job);
}

/**
 * A command trainer's output, as events. rsl_rl (microduck_rl, Isaac Lab) prints a
 * table of ~50 lines after each iteration ("Learning iteration N/M" ... "ETA: ..."):
 * that becomes one progress event, one metric event (mean reward, episode length,
 * seconds an iteration, for the chart) and one log line. Anything else is a log
 * line, and "iteration N/M" anywhere moves the progress.
 */
function trainerOutput(onEvent) {
  let block = null;
  // A resumed run counts on from its checkpoint (Learning iteration 6250/7749): show this run's own rounds.
  let base = null;
  const num = (v) => (Number.isFinite(v) ? +v.toFixed(2) : '?');
  const close = (eta = null) => {
    if (!block) return;
    const { iteration, of, reward, length, seconds } = block;
    onEvent({ type: 'metric', iteration, of, reward, length, seconds });
    onEvent({ type: 'log', line: `iteration ${iteration}/${of}: mean reward ${num(reward)}, episodes ${num(length)} steps, ${num(seconds)} s an iteration${eta ? `, ETA ${eta}` : ''}` });
    block = null;
  };
  return (raw) => {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const head = line.match(/Learning iteration\s+(\d+)\s*\/\s*(\d+)/i);
    if (head) {
      close();
      // Printed once the iteration is done, counting from 0.
      base ??= Number(head[1]);
      const of = Math.max(1, Number(head[2]) - base);
      block = { iteration: Math.min(of, Number(head[1]) + 1 - base), of, reward: NaN, length: NaN, seconds: NaN };
      onEvent({ type: 'progress', iteration: block.iteration, of: block.of });
      return;
    }
    if (block) {
      const kv = line.match(/^\s*([^:]+):\s*(-?[\d.]+(?:e[-+]?\d+)?)/i);
      if (kv) {
        const key = kv[1].trim();
        if (key === 'Mean reward') block.reward = Number(kv[2]);
        else if (key === 'Mean episode length') block.length = Number(kv[2]);
        else if (key === 'Iteration time') block.seconds = Number(kv[2]);
      }
      const eta = line.match(/^\s*ETA:\s*(\S+)/);
      if (eta) close(eta[1]);
      return;
    }
    // rsl_rl's rules between its tables (#### or ----) say nothing.
    if (/^\s*([#=-])\1{9,}\s*$/.test(line)) return;
    const m = line.match(/iteration\D{0,12}(\d+)\s*\/\s*(\d+)/i);
    if (m) onEvent({ type: 'progress', iteration: Number(m[1]), of: Number(m[2]) });
    onEvent({ type: 'log', line: line.slice(0, 400) });
  };
}

/** A command trainer (trainers.mjs) on the job's packs, exported for it; its walk.onnx becomes a release. */
async function runOutsideTrainer(job, trainer, paths, onEvent) {
  const dir = join(root, 'artifacts', 'jobs', job.id);
  const packsDir = join(dir, 'packs');
  const out = join(dir, 'out');
  mkdirSync(out, { recursive: true });
  for (const path of paths) exportPack(loadPack(path, root), join(packsDir, basename(path).replace(/\.scenario\.json$/, '')), shippedDir);
  const jobFile = join(dir, 'job.json');
  const baseHash = policyHash(readFileSync(join(shippedDir, 'walk.onnx')));
  writeFileSync(jobFile, `${JSON.stringify(trainJob({ id: job.id, packs: job.packs, baseHash, iterations: job.options.iterations, notes: `trainer ${trainer.id}` }), null, 2)}\n`);
  onEvent({ type: 'status', message: `${trainer.title}: ${job.packs.length} pack(s) exported to ${dir}` });
  const walk = await runCommandTrainer(
    trainer,
    { job: jobFile, packs: packsDir, out, envs: job.options.envs, iterations: job.options.iterations },
    trainerOutput(onEvent),
    job.controller.signal,
  );
  const metricsFile = join(out, 'metrics.json');
  const metrics = existsSync(metricsFile) ? JSON.parse(readFileSync(metricsFile, 'utf8')) : null;
  const release = await writeTrainedRelease({
    root,
    name: job.options.name,
    walkPath: walk,
    baseDir: shippedDir,
    trainer,
    packs: job.packs,
    metrics,
    settings: { envs: job.options.envs, iterations: job.options.iterations },
    publish: false,
  });
  job.result = { release, metrics };
  return release;
}

// --- Cross-check ----------------------------------------------------------------------------
let crossJob = null;
function startCrossCheck(body) {
  if (crossJob?.state === 'running') throw httpError(409, 'a cross-check is already running');
  const ids = Array.isArray(body.packs) ? body.packs : [];
  if (!ids.length) throw httpError(400, 'select at least one scenario pack');
  const brains = (Array.isArray(body.brains) && body.brains.length ? body.brains : ['shipped']).map((b) => basename(String(b)));
  const engines = (Array.isArray(body.engines) && body.engines.length ? body.engines : ENGINES).filter((e) => ENGINES.includes(e));
  const id = `check-${Date.now().toString(36)}`;
  crossJob = { id, state: 'running', packs: ids, brains, engines, rows: [], startedAt: new Date().toISOString() };
  broadcast('crosscheck', { id, state: 'running' });
  crossCheck({ packs: ids.map(packPath), brains, engines, seeds: clampInt(body.seeds, 1, 64, 8), out: join(root, 'artifacts', 'cross-check', id) }, (e) => {
    if (e.type === 'result') crossJob.rows.push(e);
    broadcast('crosscheck', { id, event: e });
  })
    .then((report) => {
      crossJob.state = 'done';
      crossJob.report = report;
      broadcast('crosscheck', { id, state: 'done', report });
    })
    .catch((err) => {
      crossJob.state = 'failed';
      crossJob.error = err.message;
      broadcast('crosscheck', { id, state: 'failed', error: err.message });
    });
  return crossJob;
}

/** The newest cross-check report on disk. */
function latestCrossCheck() {
  const dir = join(root, 'artifacts', 'cross-check');
  if (!existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'results.json');
    if (existsSync(file) && (!best || statSync(file).mtimeMs > best.t)) best = { file, t: statSync(file).mtimeMs };
  }
  return best ? JSON.parse(readFileSync(best.file, 'utf8')) : null;
}

function publicJob(job) {
  const { controller, ...rest } = job;
  return rest;
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// --- Connector export ------------------------------------------------------------------
/**
 * Export for any simulator (tools/train/lib/bundle.mjs): the ticked test
 * cases, and the motion sets when asked, as a folder and a .zip to download.
 */
async function exportForTrainer(body) {
  const ids = Array.isArray(body.packs) ? body.packs.map(String) : [];
  const motionIds = body.motions === true ? datasets().filter((d) => !d.error).map((d) => d.id) : [];
  if (!ids.length && !motionIds.length) throw httpError(400, 'tick at least one test case (or include the motion sets)');
  const motionFiles = motionIds.map((id) => join(datasetDir, `${basename(id)}.dataset.json`)).filter((path) => existsSync(path));
  ids.forEach(packPath); // 404 for an unknown test case before any work
  const result = await exportBundle({
    root,
    connectorDir,
    shippedDir,
    packIds: ids,
    packPath,
    motionFiles,
    target: String(body.target ?? 'mujoco'),
    notes: String(body.notes ?? ''),
  });
  return { ...result, zip: `/api/connector/${result.id}.zip`, title: TARGETS[result.target].title };
}

// --- Inbox upload ------------------------------------------------------------------------
function acceptPack(text) {
  let pack;
  try {
    pack = JSON.parse(text);
  } catch {
    throw httpError(400, 'not JSON');
  }
  if (pack?.version !== 'duckdash.scenario.v1') throw httpError(400, `not a scenario pack (${pack?.version})`);
  const stamp = String(pack.at ?? new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19);
  const reason = String(pack.reason ?? 'manual').replace(/[^a-z]/gi, '') || 'manual';
  const file = `${stamp}-${reason}.scenario.json`;
  writeFileSync(join(scenarioDir, file), text);
  return { file };
}

// --- HTTP ----------------------------------------------------------------------------------
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
};

/** Serves a file under `dir` (no escaping it); false when there is none. */
function serveFrom(dir, relative, res) {
  const file = resolve(dir, relative);
  if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Requests that carry a secret (a Hugging Face token) must come from the
 * Lab's own page or a local script: not from another site in the browser
 * (Origin) or through a rebound DNS name (Host).
 */
function fromLab(req) {
  const host = req.headers.host ?? '';
  if (!LOCAL_HOST.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}` || SITE_ORIGINS.has(origin);
}

/** Pages allowed to call the API: none named (scripts, same-origin GETs), this one, the website's trainer page. */
function allowedOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}` || SITE_ORIGINS.has(origin);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (!allowedOrigin(req)) throw httpError(403, 'not from a Duck Lab XR page on this computer');
    const origin = req.headers.origin;
    if (origin && SITE_ORIGINS.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type',
        // Chrome asks before a page on the network reaches this computer's own server.
        ...(req.headers['access-control-request-private-network'] ? { 'access-control-allow-private-network': 'true' } : {}),
      });
      res.end();
      return;
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        packs: packs(),
        datasets: datasets(),
        releases: rescanIndex(root),
        jobs: [...jobs.values()].map(publicJob),
        defaults: { ...DEFAULTS, steps: 900 },
        targets: Object.entries(TARGETS).map(([key, t]) => ({ key, title: t.title })),
        shippedHash: policyHash(readFileSync(join(shippedDir, 'walk.onnx'))),
      });
    }
    let m = p.match(/^\/api\/packs\/([^/]+)\/map$/);
    if (m && req.method === 'GET') return sendJson(res, 200, packMap(decodeURIComponent(m[1])));
    m = p.match(/^\/api\/packs\/([^/]+)\/replay$/);
    if (m && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, 200, await replay(decodeURIComponent(m[1]), body.release ?? null));
    }
    m = p.match(/^\/api\/packs\/([^/]+)\/isaac$/);
    if (m && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, 200, await isaacRun(decodeURIComponent(m[1]), body.release ?? null));
    }
    if (p === '/api/isaac' && req.method === 'GET') return sendJson(res, 200, await isaacState());
    if (p === '/api/isaac/again' && req.method === 'POST') return sendJson(res, 200, await isaac('/ducklab/testcase/again', { method: 'POST' }));
    if (p === '/api/isaac/stop' && req.method === 'POST') return sendJson(res, 200, await isaac('/ducklab/testcase/stop', { method: 'POST' }));
    if (p === '/isaac/player.html' && req.method === 'GET' && existsSync(playerFile)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      createReadStream(playerFile).pipe(res);
      return;
    }
    if (p === '/api/train' && req.method === 'POST') return sendJson(res, 200, startJob(JSON.parse(await readBody(req))));
    if (p === '/api/trainers' && req.method === 'GET') return sendJson(res, 200, { trainers: trainers(root).map(publicTrainer), engines: ENGINES });
    if (p === '/api/crosscheck' && req.method === 'POST') return sendJson(res, 200, startCrossCheck(JSON.parse((await readBody(req)) || '{}')));
    if (p === '/api/crosscheck' && req.method === 'GET') return sendJson(res, 200, { job: crossJob, latest: latestCrossCheck() });
    m = p.match(/^\/api\/jobs\/([^/]+)\/stop$/);
    if (m && req.method === 'POST') {
      const job = jobs.get(m[1]);
      if (!job) throw httpError(404, 'no such job');
      job.controller.abort();
      return sendJson(res, 200, { stopping: true });
    }
    m = p.match(/^\/api\/releases\/([^/]+)\/activate$/);
    if (m && req.method === 'POST') {
      const index = setActive(root, decodeURIComponent(m[1]));
      broadcast('releases', index);
      return sendJson(res, 200, index);
    }
    m = p.match(/^\/api\/releases\/([^/]+)\/publish-hub$/);
    if (m && req.method === 'POST') {
      if (!fromLab(req)) throw httpError(403, 'publish from the Duck Lab XR page');
      const id = decodeURIComponent(m[1]);
      if (!rescanIndex(root).releases.some((r) => r.id === id)) throw httpError(404, `no release ${id}`);
      const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
      const token = String(body.token ?? '').trim();
      if (!/^hf_\w{8,}$/.test(token)) throw httpError(400, 'paste a Hugging Face access token (hf_...) with write access');
      const repo = String(body.repo ?? '').trim();
      if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw httpError(400, 'the repo is <your-name>/<repo-name>');
      const published = await publishRelease({ releaseDir: join(incomingDir(root), id), token, repo: repo || undefined, hubUrl });
      const index = rescanIndex(root);
      broadcast('releases', index);
      return sendJson(res, 200, { ...published, releases: index });
    }
    m = p.match(/^\/api\/releases\/([^/]+)\/files\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const name = basename(decodeURIComponent(m[2]));
      if (!/\.(onnx|json)$/.test(name)) throw httpError(404, 'not a brain file');
      if (serveFrom(join(incomingDir(root), basename(decodeURIComponent(m[1]))), name, res)) return;
      throw httpError(404, 'no such file');
    }
    if (p === '/api/releases/deactivate' && req.method === 'POST') {
      const index = setActive(root, null);
      broadcast('releases', index);
      return sendJson(res, 200, index);
    }
    if (p === '/api/connector/export' && req.method === 'POST') return sendJson(res, 200, await exportForTrainer(JSON.parse(await readBody(req))));
    m = p.match(/^\/api\/connector\/(duck-lab-export-[\w-]+)\.zip$/);
    if (m && req.method === 'GET') {
      const file = join(connectorDir, `${m[1]}.zip`);
      if (!existsSync(file)) throw httpError(404, 'no such export');
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${m[1]}.zip"`, 'content-length': statSync(file).size });
      createReadStream(file).pipe(res);
      return;
    }
    if (p === '/api/inbox' && req.method === 'POST') return sendJson(res, 200, acceptPack(await readBody(req)));
    if (p.startsWith('/vendor/three/') && serveFrom(threeDir, decodeURIComponent(p.slice('/vendor/three/'.length)), res)) return;
    if (p.startsWith('/duck/') && /^\/duck\/(microduck\.glb|kinematics\.json|ATTRIBUTION\.md)$/.test(p) && serveFrom(duckDir, p.slice('/duck/'.length), res)) return;
    if (p.startsWith('/fonts/')) {
      const file = join(root, 'public', 'fonts', basename(p));
      if (existsSync(file)) {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        createReadStream(file).pipe(res);
        return;
      }
    }
    if (req.method === 'GET') {
      const file = join(uiDir, p === '/' ? 'index.html' : basename(p));
      if (existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        createReadStream(file).pipe(res);
        return;
      }
    }
    throw httpError(404, 'not found');
  } catch (err) {
    sendJson(res, err.status ?? 500, { error: err.message ?? String(err) });
  }
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`Duck Lab XR on ${url}  (inbox: ${scenarioDir})`);
  if (args.includes('--open')) {
    const opener = process.platform === 'win32' ? `start "" ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(opener);
  }
});
