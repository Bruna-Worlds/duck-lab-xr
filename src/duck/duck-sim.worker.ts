// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck sim worker. MuJoCo (WebAssembly) steps Pollen's Microduck model at
 * 200 Hz and onnxruntime-web runs Pollen's policies at 50 Hz: the same loop
 * as Pollen's microduck-simulator and microduck_rl's infer_policy.py.
 * It runs off the main thread so rendering keeps its frame budget.
 *
 * Observation (61): gyro 3, projected gravity 3, joint positions minus the
 * standing pose 14, joint velocities 14, last action 14, command 13
 * (twist 3, head offsets 4, body pose 6). Action (14): joint targets as
 * offsets from the standing pose.
 *
 * Moves follow Pollen's switching rules: one-shots (kick, roll, peck) start
 * from walking only and hand back to walking on their own; sitting holds a
 * stand under the sit/stand policy before sitting, and stands for 2 s before
 * walking again. A fall while walking goes to the get-up policy; a fall
 * during a move gets a short grace (longer for a roll), then the same.
 */
import loadMujoco from '@mujoco/mujoco';
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import {
  BALL_OFFSET,
  CMD_SIZE,
  CTRL_DT,
  DECIMATION,
  DEFAULT_POSE,
  type DuckMode,
  HEAD_ALPHA,
  JOINT_NAMES,
  KICK_STEPS,
  type MoveName,
  NUM_JOINTS,
  OBS_SIZE,
  PECK_END_PHASE,
  PECK_PERIOD_S,
  POLICY_FILES,
  type PolicyName,
  POSE_SIZE,
  POST_KICK_LOCK_STEPS,
  ROLL_MAX_STEPS,
  TEL,
  TELEMETRY_POLICIES,
  TELEMETRY_STRIDE,
  ROLL_MIN_STEPS,
  SIT_HANDOVER_STEPS,
  STAND_HANDBACK_STEPS,
  VEL_ANG,
  VEL_BACK,
  VEL_FWD,
} from './duck-constants.js';
import type {
  MainToWorker,
  SceneShape,
  SceneTerrain,
  SimEvent,
  SimExportRequest,
  SimInit,
  SimState,
  SimStep,
  SimTeleport,
  WorkerToMain,
} from './sim-protocol.js';
import { NAV_CAMERA_CHANNELS, NAV_CAMERA_HEIGHT, NAV_CAMERA_WIDTH } from './sim-protocol.js';
import { NAV_EVERY, NavBrainInput } from './nav-brain.js';
import { SCAN_GEOM, TERRAIN_GEOM, TERRAIN_HALF_MAX, TERRAIN_N, TERRAIN_SOFT } from './terrain-spec.js';
import { TOF_RANGE, TOF_ZONES, tofDirections, tofNoise } from './tof.js';

type Mujoco = Awaited<ReturnType<typeof loadMujoco>>;
type Model = InstanceType<Mujoco['MjModel']>;
type Data = InstanceType<Mujoco['MjData']>;

interface WorkerScope {
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  location: { href: string };
}
const scope = self as unknown as WorkerScope;

// Stick smoothing: Pollen's pad EMA (0.12 per 60 Hz frame) expressed at 50 Hz.
const TWIST_ALPHA = 0.14;
// Fall handling, mirroring the runtime's --fall-detect state machine.
const FALL_DEBOUNCE_STEPS = 10; // 0.2 s tipped before it counts as a fall
const FALL_SETTLE_STEPS = 15; // 0.3 s limp before the get-up policy starts
const RECOVER_UPRIGHT_STEPS = 50; // 1 s upright to count as recovered
const RECOVER_GIVEUP_STEPS = 300; // 6 s of trying, then reset
const MOVE_FALL_GRACE_STEPS = 50; // a move that floors the duck: 1 s grace
const ROLL_FALL_GRACE_STEPS = 250; // a roll lies tipped by design: 5 s
const BALL_LIMIT = 4; // m from the stage origin before the ball respawns
const STATS_PERIOD_MS = 500;
const MOVE_POLICIES: PolicyName[] = ['kickL', 'kickR', 'roll', 'peck'];
const INTRO_PREROLL_STEPS = 120; // 2.4 s of sitting before the first pose
// Scenario history: a state snapshot every 10 s (two kept) and every input since.
const SNAPSHOT_EVERY_STEPS = 500;
const HISTORY_MAX_STEPS = 1100;

// Self-driving (nav-brain.ts): the head's distance sensor and the navigation brain.
// The sensor sees geom groups 0-2 (room, course, terrain), not the duck's own (group 3),
// and not the head it sits in, as in training (mjlab's ray sensor).
const TOF_GEOM_GROUPS = [1, 1, 1, 0, 0, 0];
const tofLocal = tofDirections();
const tofZones = new Float32Array(TOF_ZONES * TOF_ZONES);
const tofPoint = [0, 0, 0];
const tofVec = [0, 0, 0];
const tofGeom = new Int32Array(1);
let tofSite = -1;
let tofBody = -1;
let depthWanted = false;
let driveGoal: [number, number] | null = null;
let navSession: ort.InferenceSession | null = null;
let navUrl = '';
let navTensor: ort.Tensor | null = null;
const navInput = new NavBrainInput();
// A camera brain (nav-camera.onnx) also reads the head camera's latest picture, sent by the main thread.
const navCamera = new Float32Array(NAV_CAMERA_CHANNELS * NAV_CAMERA_HEIGHT * NAV_CAMERA_WIDTH);
let navCameraTensor: ort.Tensor | null = null;
let navUsesCamera = false;
let navTick = 0;
let navForward = 0;
let navTurn = 0;

let mj: Mujoco | null = null;
let model: Model | null = null;
let data: Data | null = null;
const sessions: Partial<Record<PolicyName, ort.InferenceSession>> = {};
let obsTensor: ort.Tensor | null = null;

const obs = new Float32Array(OBS_SIZE);
const command = new Float32Array(CMD_SIZE);
const lastAction = new Float32Array(NUM_JOINTS);
const benchLastAction = new Float32Array(NUM_JOINTS);
const twistTarget = new Float32Array(3);
const twistSmooth = new Float32Array(3);
const headTarget = new Float32Array(4);
const headSmooth = new Float32Array(4);
const zeroCommand = new Float32Array(CMD_SIZE);
const qposAdr = new Int32Array(NUM_JOINTS);
const dofAdr = new Int32Array(NUM_JOINTS);
let freeAdr = 0;
let gyroAdr = 0;
let standKey = 0;
let ballQpos = -1;
let ballDof = -1;
const ballStart = new Float64Array(7);

/** Collision meshes and the hfield indices, kept for rebuilds. */
let meshBytes: (readonly [string, Uint8Array])[] = [];
let terrainGeom = -1; // the depth layer
let terrainHfield = -1;
let hfieldAdr = 0;
let scanGeom = -1; // the room scan's layer
let scanHfield = -1;
let scanAdr = 0;
/** The depth layer's compiled contact, put back when it is not soft. */
const hardSolref = new Float64Array(2);
const hardSolimp = new Float64Array(5);
let hardPriority = 0;
const TERRAIN_CELLS = TERRAIN_N * TERRAIN_N;
/** Last elevations applied (re-applied after a rebuild): the scan layer, then the depth layer. */
const terrainKeep = new Float32Array(2 * TERRAIN_CELLS);
let terrainSet = false;
/** The terrain's extent and feel (SimTerrainConfig); kept across resets and rebuilds. */
const terrainConfig: { half: number; soft: boolean; solref: readonly number[]; solimp: readonly number[] } = {
  half: TERRAIN_HALF_MAX,
  soft: false,
  solref: TERRAIN_SOFT.solref,
  solimp: TERRAIN_SOFT.solimp,
};

let currentXml = '';
const history: SimStep[] = [];
let olderSnapshot: SimState | null = null;
let newerSnapshot: SimState | null = null;
let stepsSinceSnapshot = 0;
let moveThisStep: MoveName | null = null;

let generation = 0;
let pendingReset = -1;
let pendingIntro = false;
let pendingBenchmark = 0;
let pendingTeleport: SimTeleport | null = null;
let pendingRebuild: string | null = null;
let pendingTerrain: Float32Array | null = null;
let pendingSnapshot = -1;
let pendingScene = -1;
const pendingMoves: MoveName[] = [];
let paused = false;
/** Worker reuse: a 'park' frees the duck's model between steps (in the loop); a later 'init' reboots. */
let parkRequested = false;
let parked = false;
let looping = false;
/** Where the loaded policy sessions and collision meshes came from: a reboot fetches only what changed. */
let loadedPolicyBase = '';
let loadedMeshKey = '';
let simTime = 0;

type Mode = 'walk' | 'kick' | 'roll' | 'sitstand' | 'peck' | 'motion';
let mode: Mode = 'walk';
// Keyframe motions (open loop, no policy): see SimPlayMotion.
let motionFrames: Float32Array | null = null;
let motionLoop = false;
let motionStep = 0;
let pendingMotion: { frames: Float32Array; loop: boolean } | null = null;
let pendingExport: SimExportRequest | null = null;
const TIPPED_END_STEPS = 25; // an export episode ends 0.5 s after a fall
let kickPolicy: PolicyName = 'kickL';
let moveSteps = 0;
let rollTipped = false;
let peckPhase = 0;
let sitFlag = 0;
let sitHandover = 0;
let standHandback = 0;
let postKickLock = 0;
let moveFallSteps = 0;
let currentMove: MoveName | null = null;

type Recovery = { phase: 'fallen' | 'getting-up'; steps: number; upright: number };
let recovery: Recovery | null = null;
let fallDebounce = 0;
let falls = 0;

// Robot telemetry (see SimTelemetry): sampled every control step while on.
const TELEMETRY_BATCH = 5; // 10 batches a second
let telemetryOn = false;
let telemetryBuf = new Float32Array(TELEMETRY_BATCH * TELEMETRY_STRIDE);
let telemetryCount = 0;
let accelAdr = -1;
const ankleBody = new Int32Array([-1, -1]);
const forceLimit = new Float32Array(NUM_JOINTS).fill(1);

let statsStart = 0;
let statsSteps = 0;
let statsInfer = 0;
let statsInferMax = 0;
let statsPhysics = 0;
let statsBusy = 0;

const wallNow = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const scalar = (v: unknown): number =>
  typeof v === 'number' ? v : Number((v as ArrayLike<number>)[0]);
const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;

function post(message: WorkerToMain, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

/** Which bytes drove the duck: a short hash per policy file, for run records. */
const policyHashes: Partial<Record<PolicyName, string>> = {};

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function event(kind: SimEvent['kind'], extra: Partial<SimEvent> = {}): void {
  post({ type: 'event', kind, ...extra });
}

/**
 * A policy file: brains that came over the headset link live in Cache Storage
 * (src/training/policy-inbox-system.ts) under a URL no server answers.
 */
async function fetchPolicy(url: string, init?: RequestInit): Promise<Response> {
  if (url.includes('/policies/linked/') && typeof caches !== 'undefined') {
    const kept = await caches.match(url);
    if (kept) return kept;
  }
  return fetch(url, init);
}

/** Loads one policy file into an inference session (and records its hash). */
async function createSession(baseUrl: string, name: PolicyName): Promise<{ session: ort.InferenceSession; hash: string }> {
  const res = await fetchPolicy(baseUrl + POLICY_FILES[name], { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`policy ${name}: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { session, hash: fnv1a(bytes) };
}

/**
 * Swaps the whole policy set for the files under `baseUrl` (a trained
 * release). Everything loads first; only then do the sessions change, so a
 * failed download leaves the duck on its old policies.
 */
async function swapPolicies(id: number, baseUrl: string): Promise<void> {
  const names = Object.keys(POLICY_FILES) as PolicyName[];
  try {
    const loaded = await Promise.all(names.map((name) => createSession(baseUrl, name)));
    const old: ort.InferenceSession[] = [];
    names.forEach((name, i) => {
      const previous = sessions[name];
      if (previous) old.push(previous);
      sessions[name] = loaded[i].session;
      policyHashes[name] = loaded[i].hash;
    });
    loadedPolicyBase = baseUrl;
    // lastAction carries over: it is the previous joint target either way.
    post({ type: 'policies-loaded', id, ok: true, policyHash: policyHashes.walk ?? '' });
    // A step may still be running on an old session: release them a little later.
    setTimeout(() => {
      for (const session of old) void session.release();
    }, 500);
  } catch (err) {
    post({ type: 'policies-loaded', id, ok: false, policyHash: policyHashes.walk ?? '', message: String(err) });
  }
}

const meshKey = (msg: SimInit): string => `${msg.meshBaseUrl}|${msg.meshFiles.join(',')}`;

async function fetchMeshes(msg: SimInit): Promise<(readonly [string, Uint8Array])[]> {
  return Promise.all(
    msg.meshFiles.map(async (file) => {
      const res = await fetch(msg.meshBaseUrl + file);
      if (!res.ok) {
        throw new Error(`collision mesh ${file}: HTTP ${res.status}`);
      }
      return [file, new Uint8Array(await res.arrayBuffer())] as const;
    }),
  );
}

/**
 * A new duck on a parked worker: MuJoCo and ONNX Runtime are already up, so
 * only the new level's model is compiled; meshes and policies are fetched
 * again only when they come from somewhere else.
 */
async function reboot(msg: SimInit): Promise<void> {
  const t0 = performance.now();
  while (!parked) {
    if (!looping && parkRequested) {
      parkRequested = false;
      parkNow();
    }
    await sleep(5); // the loop frees the old model between steps
  }
  const module = mj!;
  const key = meshKey(msg);
  if (key !== loadedMeshKey) {
    meshBytes = await fetchMeshes(msg);
    loadedMeshKey = key;
  }
  if (msg.policyBaseUrl !== loadedPolicyBase) {
    const names = Object.keys(POLICY_FILES) as PolicyName[];
    const loaded = await Promise.all(names.map((name) => createSession(msg.policyBaseUrl, name)));
    names.forEach((name, i) => {
      void sessions[name]?.release();
      sessions[name] = loaded[i].session;
      policyHashes[name] = loaded[i].hash;
    });
    loadedPolicyBase = msg.policyBaseUrl;
  }
  currentXml = msg.xml;
  const m = compileModel(msg.xml);
  const d = new module.MjData(m);
  bindModel(m, msg.hasBall);
  model = m;
  data = d;
  resetSim();
  if (ballQpos >= 0) {
    const qpos = d.qpos as Float64Array;
    for (let i = 0; i < 7; i++) ballStart[i] = qpos[ballQpos + i];
  }
  if (msg.intro) {
    await sitDown();
  }
  post({
    type: 'ready',
    bootMs: performance.now() - t0,
    nq: m.nq,
    nv: m.nv,
    nbody: m.nbody,
    ngeom: m.ngeom,
    policyHash: policyHashes.walk ?? '',
  });
  for (const name of MOVE_POLICIES) {
    if (sessions[name]) event('policy-loaded', { policy: name });
  }
  parked = false;
}

/** Frees the duck's model and clears its state; the engines and policy sessions stay. */
function parkNow(): void {
  if (model && data) endMove(false);
  pendingReset = -1;
  pendingIntro = false;
  pendingBenchmark = 0;
  pendingTeleport = null;
  pendingRebuild = null;
  pendingTerrain = null;
  pendingSnapshot = -1;
  pendingMoves.length = 0;
  pendingMotion = null;
  pendingExport = null;
  telemetryOn = false;
  telemetryCount = 0;
  paused = false;
  twistTarget.fill(0);
  twistSmooth.fill(0);
  headTarget.fill(0);
  headSmooth.fill(0);
  lastAction.fill(0);
  terrainSet = false;
  terrainKeep.fill(0);
  clearHistory();
  falls = 0;
  generation = 0;
  simTime = 0;
  mode = 'walk';
  recovery = null;
  fallDebounce = 0;
  motionFrames = null;
  data?.delete();
  model?.delete();
  data = null;
  model = null;
  parked = true;
  post({ type: 'parked' });
}

async function boot(msg: SimInit): Promise<void> {
  if (mj) {
    await reboot(msg); // a reused worker
    return;
  }
  const t0 = performance.now();
  const base = scope.location.href;
  ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, base).href };
  ort.env.wasm.numThreads = 1; // no SharedArrayBuffer without cross-origin isolation
  const mujocoUrl = new URL(mujocoWasmUrl, base).href;
  const loadPolicy = async (name: PolicyName) => {
    const res = await fetchPolicy(msg.policyBaseUrl + POLICY_FILES[name]);
    if (!res.ok) {
      throw new Error(`policy ${name}: HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    policyHashes[name] = fnv1a(bytes);
    return ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  };

  const [module, meshes, walk, stand, sitstand] = await Promise.all([
    loadMujoco({
      locateFile: (path: string) => (path.endsWith('.wasm') ? mujocoUrl : path),
    }),
    Promise.all(
      msg.meshFiles.map(async (file) => {
        const res = await fetch(msg.meshBaseUrl + file);
        if (!res.ok) {
          throw new Error(`collision mesh ${file}: HTTP ${res.status}`);
        }
        return [file, new Uint8Array(await res.arrayBuffer())] as const;
      }),
    ),
    loadPolicy('walk'),
    loadPolicy('stand'),
    loadPolicy('sitstand'), // needed at once for the wake-up intro
  ]);

  mj = module;
  meshBytes = meshes;
  loadedMeshKey = meshKey(msg);
  currentXml = msg.xml;
  const m = compileModel(msg.xml);
  const d = new module.MjData(m);
  bindModel(m, msg.hasBall);

  model = m;
  data = d;
  sessions.walk = walk;
  sessions.stand = stand;
  sessions.sitstand = sitstand;
  loadedPolicyBase = msg.policyBaseUrl;
  obsTensor = new ort.Tensor('float32', obs, [1, OBS_SIZE]);
  resetSim();
  if (ballQpos >= 0) {
    const qpos = d.qpos as Float64Array;
    for (let i = 0; i < 7; i++) ballStart[i] = qpos[ballQpos + i];
  }
  if (msg.intro) {
    await sitDown();
  }

  post({
    type: 'ready',
    bootMs: performance.now() - t0,
    nq: m.nq,
    nv: m.nv,
    nbody: m.nbody,
    ngeom: m.ngeom,
    policyHash: policyHashes.walk ?? '',
  });
  if (!looping) void loop();

  // The moves load after the duck can already walk.
  for (const name of MOVE_POLICIES) {
    try {
      sessions[name] = await loadPolicy(name);
      event('policy-loaded', { policy: name });
    } catch (err) {
      post({ type: 'error', message: `policy ${name} failed to load: ${String(err)}` });
    }
  }
}

/** Compiles MJCF with the pack's collision meshes in a virtual file system. */
function compileModel(xml: string): Model {
  const vfs = new mj!.MjVFS();
  for (const [file, bytes] of meshBytes) {
    vfs.addBuffer(`assets/${file}`, bytes); // the MJCF's meshdir is "assets"
  }
  try {
    return mj!.MjModel.from_xml_string(xml, vfs);
  } finally {
    vfs.delete();
  }
}

/** Looks up the addresses the loop needs; the same for every rebuild. */
function bindModel(m: Model, hasBall: boolean): void {
  const module = mj!;
  for (let j = 0; j < NUM_JOINTS; j++) {
    const joint = m.jnt(JOINT_NAMES[j]);
    qposAdr[j] = scalar(joint.qposadr);
    dofAdr[j] = scalar(joint.dofadr);
    joint.delete();
  }
  const free = m.jnt('trunk_base_freejoint');
  freeAdr = scalar(free.qposadr);
  free.delete();
  const gyro = m.sensor('imu_ang_vel');
  gyroAdr = scalar(gyro.adr);
  gyro.delete();
  // Telemetry extras; a model without them just reports zeros.
  accelAdr = -1;
  try {
    const accel = m.sensor('imu_accel');
    accelAdr = scalar(accel.adr);
    accel.delete();
  } catch {
    // no accelerometer in this model
  }
  ankleBody[0] = module.mj_name2id(m, module.mjtObj.mjOBJ_BODY.value, 'ankle_left');
  ankleBody[1] = module.mj_name2id(m, module.mjtObj.mjOBJ_BODY.value, 'ankle_right');
  const forceRange = m.actuator_forcerange as Float64Array;
  for (let j = 0; j < NUM_JOINTS; j++) {
    const limit = Math.max(Math.abs(forceRange[2 * j]), Math.abs(forceRange[2 * j + 1]));
    forceLimit[j] = limit > 0 ? limit : 1;
  }
  // The ball is bound when this model has one, whatever the caller thought:
  // a reused worker must not keep the last level's ball.
  ballQpos = -1;
  ballDof = -1;
  const ballJoint = module.mj_name2id(m, module.mjtObj.mjOBJ_JOINT.value, 'ball_freejoint');
  if (hasBall && ballJoint < 0) console.warn('[duck-sim] the model has no ball joint; playing without the ball');
  if (ballJoint >= 0) {
    const ball = m.jnt('ball_freejoint');
    ballQpos = scalar(ball.qposadr);
    ballDof = scalar(ball.dofadr);
    ball.delete();
  }
  tofSite = module.mj_name2id(m, module.mjtObj.mjOBJ_SITE.value, 'tof');
  tofBody = tofSite >= 0 ? (m.site_bodyid as Int32Array)[tofSite] : -1;
  standKey = module.mj_name2id(m, module.mjtObj.mjOBJ_KEY.value, 'STAND');
  if (standKey < 0) {
    throw new Error('MJCF has no STAND keyframe');
  }
  terrainGeom = module.mj_name2id(m, module.mjtObj.mjOBJ_GEOM.value, TERRAIN_GEOM);
  terrainHfield = -1;
  hfieldAdr = 0;
  if (terrainGeom >= 0) {
    terrainHfield = (m.geom_dataid as Int32Array)[terrainGeom];
    hfieldAdr = (m.hfield_adr as Int32Array)[terrainHfield];
    hardSolref.set((m.geom_solref as Float64Array).subarray(terrainGeom * 2, terrainGeom * 2 + 2));
    hardSolimp.set((m.geom_solimp as Float64Array).subarray(terrainGeom * 5, terrainGeom * 5 + 5));
    hardPriority = (m.geom_priority as Int32Array)[terrainGeom];
  }
  scanGeom = module.mj_name2id(m, module.mjtObj.mjOBJ_GEOM.value, SCAN_GEOM);
  scanHfield = -1;
  scanAdr = 0;
  if (scanGeom >= 0) {
    scanHfield = (m.geom_dataid as Int32Array)[scanGeom];
    scanAdr = (m.hfield_adr as Int32Array)[scanHfield];
  }
  applyTerrainConfig(m);
}

/**
 * Writes the kept elevations into the model: the scan layer and the depth
 * layer into their own height fields (both into the depth one if a model has
 * no scan field). The typed-array view is fetched fresh every time: views
 * detach whenever the WASM heap grows.
 */
function applyTerrain(m: Model): void {
  if (terrainGeom < 0 || !terrainSet) {
    return;
  }
  const field = m.hfield_data as Float32Array;
  if (scanGeom >= 0) {
    field.set(terrainKeep.subarray(0, TERRAIN_CELLS), scanAdr);
    field.set(terrainKeep.subarray(TERRAIN_CELLS), hfieldAdr);
  } else {
    field.set(combinedTerrain(), hfieldAdr);
  }
}

/** The higher of the two layers per cell: the whole terrain in one field. */
function combinedTerrain(): Float32Array {
  const out = new Float32Array(TERRAIN_CELLS);
  for (let i = 0; i < TERRAIN_CELLS; i++) out[i] = Math.max(terrainKeep[i], terrainKeep[TERRAIN_CELLS + i]);
  return out;
}

/**
 * Both height fields to the extent in use (MuJoCo reads an hfield's size at
 * every collision; the bounds compiled for the largest size still enclose
 * it), and the depth layer's contact soft or as compiled. A soft layer also
 * gets a higher priority, so its solref/solimp apply as they are instead of
 * being averaged with the duck's feet (MuJoCo mixes equal-priority geoms);
 * both use the default friction, which priority would otherwise pick.
 */
function applyTerrainConfig(m: Model): void {
  const size = m.hfield_size as Float64Array;
  for (const h of [terrainHfield, scanHfield]) {
    if (h < 0) continue;
    size[h * 4] = terrainConfig.half;
    size[h * 4 + 1] = terrainConfig.half;
  }
  if (terrainGeom >= 0) {
    const soft = terrainConfig.soft;
    (m.geom_solref as Float64Array).set(soft ? terrainConfig.solref : hardSolref, terrainGeom * 2);
    (m.geom_solimp as Float64Array).set(soft ? terrainConfig.solimp : hardSolimp, terrainGeom * 5);
    (m.geom_priority as Int32Array)[terrainGeom] = soft ? hardPriority + 1 : hardPriority;
  }
}

/** MuJoCo geom types the scene reports as shapes (mjtGeom); height fields go as the terrain. */
const SHAPE_KINDS: Record<number, SceneShape['kind']> = { 0: 'plane', 2: 'sphere', 3: 'capsule', 4: 'ellipsoid', 5: 'cylinder', 6: 'box' };
const GEOM_HFIELD = 1;
const NO_COLOUR = new Float32Array(4);

/**
 * The static scene for other simulators and viewers: every geom welded to
 * the world (not the duck, not the ball) as a posed shape, and the terrain.
 */
function postScene(id: number): void {
  const m = model!;
  const d = data!;
  const module = mj!;
  const types = m.geom_type as Int32Array;
  const bodyOf = m.geom_bodyid as Int32Array;
  const weld = m.body_weldid as Int32Array;
  const size = m.geom_size as Float64Array;
  const rgba = m.geom_rgba as Float32Array;
  const matOf = m.geom_matid as Int32Array;
  const matRgba = m.mat_rgba as Float32Array;
  const xpos = d.geom_xpos as Float64Array;
  const xmat = d.geom_xmat as Float64Array;
  const shapes: SceneShape[] = [];
  let skipped = 0;
  for (let g = 0; g < m.ngeom; g++) {
    if (weld[bodyOf[g]] !== 0) continue; // it moves: the duck or the ball
    const kind = SHAPE_KINDS[types[g]];
    if (!kind) {
      if (types[g] !== GEOM_HFIELD) skipped++;
      continue;
    }
    // A geom's own rgba wins unless it is MuJoCo's default; then its material's, if it has one.
    // With neither (the colliders, which nobody draws), alpha 0 says it has no colour of its own.
    const own = rgba.subarray(g * 4, g * 4 + 4);
    const mat = matOf[g];
    const isDefault = own[0] === 0.5 && own[1] === 0.5 && own[2] === 0.5 && own[3] === 1;
    const c = !isDefault ? own : mat >= 0 ? matRgba.subarray(mat * 4, mat * 4 + 4) : NO_COLOUR;
    shapes.push({
      kind,
      name: module.mj_id2name(m, module.mjtObj.mjOBJ_GEOM.value, g) || '',
      size: [size[g * 3], size[g * 3 + 1], size[g * 3 + 2]],
      pos: [xpos[g * 3], xpos[g * 3 + 1], xpos[g * 3 + 2]],
      quat: matToQuat(xmat, g * 9),
      rgba: [c[0], c[1], c[2], c[3]],
    });
  }
  const terrain = sceneTerrain(m, d);
  post({ type: 'scene', id, shapes, terrain, skipped }, terrain ? [terrain.heights.buffer] : []);
}

/** Both terrain layers as one field (the higher per cell), posed like the depth layer's geom. */
function sceneTerrain(m: Model, d: Data): SceneTerrain | null {
  if (terrainGeom < 0 || terrainHfield < 0) return null;
  const rows = (m.hfield_nrow as Int32Array)[terrainHfield];
  const cols = (m.hfield_ncol as Int32Array)[terrainHfield];
  const size = m.hfield_size as Float64Array;
  const field = m.hfield_data as Float32Array;
  const heights = field.slice(hfieldAdr, hfieldAdr + rows * cols);
  if (scanGeom >= 0) {
    for (let i = 0; i < heights.length; i++) heights[i] = Math.max(heights[i], field[scanAdr + i]);
  }
  const xpos = d.geom_xpos as Float64Array;
  const g = terrainGeom;
  return {
    half: size[terrainHfield * 4],
    elev: size[terrainHfield * 4 + 2],
    rows,
    cols,
    pos: [xpos[g * 3], xpos[g * 3 + 1], xpos[g * 3 + 2]],
    heights,
  };
}

/** A row-major 3 x 3 rotation (MuJoCo's xmat) as a quaternion w, x, y, z. */
function matToQuat(r: Float64Array, o: number): [number, number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = [r[o], r[o + 1], r[o + 2], r[o + 3], r[o + 4], r[o + 5], r[o + 6], r[o + 7], r[o + 8]];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
}

/** The current MJCF with the terrain fields at the size in use (desktop tools read it from there). */
function snapshotXml(): string {
  if (terrainConfig.half === TERRAIN_HALF_MAX) return currentXml;
  const half = String(Number(terrainConfig.half.toFixed(4)));
  return currentXml.replace(/(<hfield\b[^>]*\bsize=")([^"]*)(")/g, (_whole, open: string, size: string, close: string) => {
    const parts = size.trim().split(/\s+/);
    parts[0] = half;
    parts[1] = half;
    return `${open}${parts.join(' ')}${close}`;
  });
}

/**
 * Replaces the model with one compiled from `xml` (new static geoms, same
 * joints) and carries the state over, so the duck does not notice.
 */
function rebuild(xml: string): void {
  const module = mj!;
  const old = model!;
  const oldData = data!;
  const t0 = performance.now();
  const m = compileModel(xml);
  if (m.nq !== old.nq || m.nv !== old.nv || m.nu !== old.nu) {
    m.delete();
    post({ type: 'error', message: 'rebuild: the new model has a different state layout; kept the old one' });
    return;
  }
  const d = new module.MjData(m);
  (d.qpos as Float64Array).set(oldData.qpos as Float64Array);
  (d.qvel as Float64Array).set(oldData.qvel as Float64Array);
  (d.ctrl as Float64Array).set(oldData.ctrl as Float64Array);
  (d.qacc_warmstart as Float64Array).set(oldData.qacc_warmstart as Float64Array);
  d.time = oldData.time;
  bindModel(m, ballQpos >= 0);
  applyTerrain(m);
  module.mj_forward(m, d);
  model = m;
  data = d;
  currentXml = xml;
  clearHistory(); // the scene changed under the recorded inputs
  oldData.delete();
  old.delete();
  post({ type: 'rebuilt', ngeom: m.ngeom, ms: performance.now() - t0 });
}

function captureState(): SimState {
  const d = data!;
  return {
    time: simTime,
    qpos: Float64Array.from(d.qpos as Float64Array),
    qvel: Float64Array.from(d.qvel as Float64Array),
    lastAction: Float32Array.from(lastAction),
    twistSmooth: Float32Array.from(twistSmooth),
    headSmooth: Float32Array.from(headSmooth),
  };
}

function clearHistory(): void {
  history.length = 0;
  olderSnapshot = null;
  newerSnapshot = null;
  stepsSinceSnapshot = 0;
}

/** Keeps a state every 10 s while the duck walks normally, and the inputs since the older one. */
function recordStep(): void {
  if (++stepsSinceSnapshot >= SNAPSHOT_EVERY_STEPS && mode === 'walk' && !recovery && standHandback === 0 && postKickLock === 0) {
    stepsSinceSnapshot = 0;
    olderSnapshot = newerSnapshot;
    newerSnapshot = captureState();
    const keepFrom = (olderSnapshot ?? newerSnapshot).time;
    while (history.length > 0 && history[0].t < keepFrom) history.shift();
  }
  if (newerSnapshot) {
    history.push({
      t: simTime,
      vx: twistTarget[0],
      wz: twistTarget[2],
      head: [headTarget[0], headTarget[1], headTarget[2], headTarget[3]],
      move: moveThisStep,
    });
    if (history.length > HISTORY_MAX_STEPS) history.shift();
  }
  moveThisStep = null;
}

function postSnapshot(id: number): void {
  const start = olderSnapshot ?? newerSnapshot ?? captureState();
  post({
    type: 'snapshot',
    id,
    xml: snapshotXml(),
    hfield: terrainSet ? combinedTerrain() : null,
    start,
    steps: history.filter((step) => step.t >= start.time),
    end: captureState(),
    mode: reportedMode(),
    falls,
  });
}

function endMove(ok: boolean): void {
  if (currentMove) {
    event('move-end', { move: currentMove, ok });
    currentMove = null;
  }
}

function resetSim(): void {
  if (!mj || !model || !data) {
    return;
  }
  endMove(false);
  mj.mj_resetDataKeyframe(model, data, standKey);
  mj.mj_forward(model, data);
  clearHistory();
  lastAction.fill(0);
  twistSmooth.fill(0);
  headSmooth.fill(0);
  mode = 'walk';
  motionFrames = null;
  pendingMotion = null;
  sitFlag = 0;
  sitHandover = 0;
  standHandback = 0;
  postKickLock = 0;
  moveFallSteps = 0;
  recovery = null;
  fallDebounce = 0;
}

function teleport(t: SimTeleport): void {
  if (!mj || !model || !data) {
    return;
  }
  resetSim(); // also clears the scenario history: a teleport is not reproducible input
  const qpos = data.qpos as Float64Array;
  const qvel = data.qvel as Float64Array;
  // Heading about z, then a sideways tip about the duck's own x axis.
  const cy = Math.cos(t.yaw / 2);
  const sy = Math.sin(t.yaw / 2);
  const cr = Math.cos(t.tilt / 2);
  const sr = Math.sin(t.tilt / 2);
  qpos[freeAdr] = t.x;
  qpos[freeAdr + 1] = t.y;
  qpos[freeAdr + 2] = t.z ?? (t.tilt === 0 ? 0.12 : 0.08);
  qpos[freeAdr + 3] = cy * cr;
  qpos[freeAdr + 4] = cy * sr;
  qpos[freeAdr + 5] = sy * sr;
  qpos[freeAdr + 6] = sy * cr;
  for (let i = 0; i < 6; i++) qvel[i] = 0;
  mj.mj_forward(model, data);
}

/** Puts the duck on its hull and runs it until settled (the wake-up pose). */
async function sitDown(): Promise<void> {
  // Hold a stand under the sit/stand policy first, as the runtime does.
  mode = 'sitstand';
  sitFlag = 0;
  lastAction.fill(0);
  for (let k = 0; k < SIT_HANDOVER_STEPS; k++) {
    await controlStep();
  }
  sitFlag = 1;
  for (let k = 0; k < INTRO_PREROLL_STEPS; k++) {
    await controlStep();
  }
}

function respawnBall(): void {
  if (ballQpos < 0 || !mj || !model || !data) {
    return;
  }
  const qpos = data.qpos as Float64Array;
  const qvel = data.qvel as Float64Array;
  for (let i = 0; i < 7; i++) qpos[ballQpos + i] = ballStart[i];
  for (let i = 0; i < 6; i++) qvel[ballDof + i] = 0;
  mj.mj_forward(model, data);
}

/** World "down" seen from the trunk; z is -1 when the duck stands upright. */
function projectedGravity(qpos: Float64Array, out: Float32Array, offset: number): void {
  const w = qpos[freeAdr + 3];
  const x = qpos[freeAdr + 4];
  const y = qpos[freeAdr + 5];
  const z = qpos[freeAdr + 6];
  out[offset] = -2 * (x * z - w * y);
  out[offset + 1] = -2 * (y * z + w * x);
  out[offset + 2] = -(1 - 2 * (x * x + y * y));
}

const gravityScratch = new Float32Array(3);
function gravityZ(qpos: Float64Array): number {
  projectedGravity(qpos, gravityScratch, 0);
  return gravityScratch[2];
}

function buildObs(d: Data, action: Float32Array, cmd: Float32Array): void {
  const qpos = d.qpos as Float64Array;
  const qvel = d.qvel as Float64Array;
  const sensors = d.sensordata as Float64Array;
  obs[0] = sensors[gyroAdr];
  obs[1] = sensors[gyroAdr + 1];
  obs[2] = sensors[gyroAdr + 2];
  projectedGravity(qpos, obs, 3);
  for (let j = 0; j < NUM_JOINTS; j++) {
    obs[6 + j] = qpos[qposAdr[j]] - DEFAULT_POSE[j];
    obs[20 + j] = qvel[dofAdr[j]];
    obs[34 + j] = action[j];
  }
  obs.set(cmd, 48);
}

/** Runs a policy and writes joint targets. Returns inference time (ms). */
async function act(
  d: Data,
  session: ort.InferenceSession,
  action: Float32Array,
  cmd: Float32Array,
): Promise<number> {
  const t0 = performance.now();
  buildObs(d, action, cmd);
  const out = await session.run({ [session.inputNames[0]]: obsTensor! });
  const result = out[session.outputNames[0]].data as Float32Array;
  const ms = performance.now() - t0;
  for (let j = 0; j < NUM_JOINTS; j++) {
    if (!Number.isFinite(result[j])) {
      return ms; // never write NaN into ctrl; keep the previous targets
    }
  }
  action.set(result.subarray(0, NUM_JOINTS));
  const ctrl = d.ctrl as Float64Array;
  for (let j = 0; j < NUM_JOINTS; j++) {
    ctrl[j] = DEFAULT_POSE[j] + result[j];
  }
  return ms;
}

/**
 * One keyframe row added on top of the balancing policy's targets. The
 * standing pose is not statically stable (the policy balances it every
 * step), so a motion is an offset layered on the walker at zero command,
 * not a replacement for it.
 */
function applyMotionFrame(d: Data, frames: Float32Array, step: number): void {
  const ctrl = d.ctrl as Float64Array;
  const at = step * NUM_JOINTS;
  for (let j = 0; j < NUM_JOINTS; j++) {
    ctrl[j] += frames[at + j];
  }
}

/**
 * Plays a motion from randomized standing starts on a copy of the sim and
 * records (observation, action) pairs: the observation the balancing
 * policy saw and the total target offset applied (policy plus keyframe), a
 * behaviour-cloning set for a policy that does the motion on its own. Runs
 * flat out; the live duck waits.
 */
async function exportMotion(req: SimExportRequest): Promise<void> {
  const m = model!;
  const copy = new mj!.MjData(m, data!);
  const walk = sessions.walk!;
  const nFrames = req.frames.length / NUM_JOINTS;
  const maxSteps = req.episodes * nFrames;
  const obsOut = new Float32Array(maxSteps * OBS_SIZE);
  const actOut = new Float32Array(maxSteps * NUM_JOINTS);
  const lengths = new Int32Array(req.episodes);
  const successes = new Uint8Array(req.episodes);
  const t0 = performance.now();
  let steps = 0;
  for (let ep = 0; ep < req.episodes; ep++) {
    mj!.mj_resetDataKeyframe(m, copy, standKey);
    const qpos = copy.qpos as Float64Array;
    const qvel = copy.qvel as Float64Array;
    for (let j = 0; j < NUM_JOINTS; j++) {
      qpos[qposAdr[j]] += (Math.random() * 2 - 1) * req.poseNoise;
    }
    for (let k = 0; k < 2; k++) {
      qvel[k] += (Math.random() * 2 - 1) * req.pushNoise;
    }
    mj!.mj_forward(m, copy);
    benchLastAction.fill(0);
    let tippedSteps = 0;
    let length = 0;
    for (let i = 0; i < nFrames; i++) {
      await act(copy, walk, benchLastAction, zeroCommand); // builds obs for this step too
      obsOut.set(obs, steps * OBS_SIZE);
      applyMotionFrame(copy, req.frames, i);
      const ctrl = copy.ctrl as Float64Array;
      const at = steps * NUM_JOINTS;
      for (let j = 0; j < NUM_JOINTS; j++) {
        actOut[at + j] = ctrl[j] - DEFAULT_POSE[j];
      }
      stepPhysics(copy);
      steps++;
      length++;
      const tipped = gravityZ(qpos) > -0.5 || qpos[freeAdr + 2] < 0.02;
      if (tipped && ++tippedSteps >= TIPPED_END_STEPS) break;
      if (!tipped) tippedSteps = 0;
    }
    lengths[ep] = length;
    successes[ep] = gravityZ(qpos) < -0.85 && qpos[freeAdr + 2] > 0.08 ? 1 : 0;
  }
  copy.delete();
  const obsTrim = obsOut.slice(0, steps * OBS_SIZE);
  const actTrim = actOut.slice(0, steps * NUM_JOINTS);
  post(
    { type: 'export', id: req.id, obs: obsTrim, act: actTrim, episodeLengths: lengths, successes, wallMs: performance.now() - t0 },
    [obsTrim.buffer, actTrim.buffer, lengths.buffer, successes.buffer],
  );
}

function stepPhysics(d: Data): number {
  const t0 = performance.now();
  for (let s = 0; s < DECIMATION; s++) {
    mj!.mj_step(model!, d);
  }
  return performance.now() - t0;
}

/** The policy driving this step, and its command vector (13). */
function currentPolicy(): PolicyName | null {
  if (recovery) {
    return recovery.phase === 'getting-up' ? 'stand' : null;
  }
  switch (mode) {
    case 'kick':
      return kickPolicy;
    case 'roll':
      return 'roll';
    case 'peck':
      return 'peck';
    case 'sitstand':
      return 'sitstand';
    case 'motion':
      return 'walk'; // the walker balances at zero command; the keyframes ride on top
    default:
      return 'walk';
  }
}

function fillCommand(): void {
  command.fill(0);
  if (recovery) {
    return; // the get-up policy runs with an all-zero command
  }
  if (mode === 'peck') {
    // Phase clock in the velocity slots; head and body slots stay zero.
    const a = 2 * Math.PI * peckPhase;
    command[0] = Math.cos(a);
    command[1] = Math.sin(a);
    return;
  }
  if (mode === 'sitstand') {
    command[0] = sitFlag;
    return;
  }
  if (mode !== 'walk') {
    return; // kicks and rolls run with zero commands, as in the runtime
  }
  if (postKickLock === 0) {
    command[0] = twistSmooth[0];
    command[1] = twistSmooth[1];
    command[2] = twistSmooth[2];
  }
  // Head offsets only while walking: the walker is the policy the runtime
  // drives with head commands; the one-shots were trained without them.
  command[3] = headSmooth[0];
  command[4] = headSmooth[1];
  command[5] = headSmooth[2];
  command[6] = headSmooth[3];
}

/** A standard normal number (Box-Muller). */
function gaussian(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/** One frame of the head's distance sensor into tofZones (metres; TOF_RANGE when nothing is in range). */
function castTof(d: Data): void {
  const module = mj!;
  const m = model!;
  const xpos = d.site_xpos as Float64Array;
  const xmat = d.site_xmat as Float64Array;
  const p = tofSite * 3;
  const r = tofSite * 9;
  tofPoint[0] = xpos[p];
  tofPoint[1] = xpos[p + 1];
  tofPoint[2] = xpos[p + 2];
  for (let z = 0; z < tofZones.length; z++) {
    const lx = tofLocal[z * 3];
    const ly = tofLocal[z * 3 + 1];
    const lz = tofLocal[z * 3 + 2];
    tofVec[0] = xmat[r] * lx + xmat[r + 1] * ly + xmat[r + 2] * lz;
    tofVec[1] = xmat[r + 3] * lx + xmat[r + 4] * ly + xmat[r + 5] * lz;
    tofVec[2] = xmat[r + 6] * lx + xmat[r + 7] * ly + xmat[r + 8] * lz;
    const hit = module.mj_ray(m, d, tofPoint, tofVec, TOF_GEOM_GROUPS, true, tofBody, tofGeom, null);
    tofZones[z] = hit < 0 || hit > TOF_RANGE ? TOF_RANGE : Math.min(TOF_RANGE, Math.max(0, hit + tofNoise(hit) * gaussian()));
  }
}

/** Loads the navigation brain once (a new URL replaces it). */
async function loadNav(url: string): Promise<void> {
  navUrl = url;
  try {
    const res = await fetchPolicy(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    if (navUrl !== url) {
      void session.release();
      return;
    }
    const old = navSession;
    navSession = session;
    navTensor = new ort.Tensor('float32', navInput.obs, [1, navInput.obs.length]);
    navUsesCamera = session.inputNames.includes('camera');
    navCameraTensor = navUsesCamera ? new ort.Tensor('float32', navCamera, [1, NAV_CAMERA_CHANNELS, NAV_CAMERA_HEIGHT, NAV_CAMERA_WIDTH]) : null;
    navCamera.fill(0);
    navInput.reset();
    if (old) setTimeout(() => void old.release(), 500);
    post({ type: 'nav-loaded', ok: true, camera: navUsesCamera });
  } catch (err) {
    if (navUrl === url) navUrl = '';
    post({ type: 'nav-loaded', ok: false, message: `navigation brain: ${String(err)}` });
  }
}

/** Ten times a second while driving or asked for: a sensor frame, and the brain's next twist. */
async function senseAndDrive(d: Data): Promise<void> {
  castTof(d);
  const goal = driveGoal;
  const driving = !!goal && !!navSession && mode === 'walk' && !recovery;
  if (driving && goal && navSession && navTensor) {
    navInput.push(tofZones);
    const qpos = d.qpos as Float64Array;
    const x = qpos[freeAdr];
    const y = qpos[freeAdr + 1];
    const w = qpos[freeAdr + 3];
    const qx = qpos[freeAdr + 4];
    const qy = qpos[freeAdr + 5];
    const qz = qpos[freeAdr + 6];
    const yaw = Math.atan2(2 * (w * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
    const bearing = Math.atan2(goal[1] - y, goal[0] - x) - yaw;
    const sensors = d.sensordata as Float64Array;
    navInput.build(Math.hypot(goal[0] - x, goal[1] - y), bearing, twistSmooth[0], twistSmooth[2], sensors[gyroAdr + 2]);
    const session = navSession;
    const out = await session.run(navUsesCamera && navCameraTensor ? { obs: navTensor, camera: navCameraTensor } : { [session.inputNames[0]]: navTensor });
    const twist = out[session.outputNames[0]].data as Float32Array;
    if (driveGoal && Number.isFinite(twist[0]) && Number.isFinite(twist[1])) {
      navForward = clamp(twist[0], -VEL_BACK, VEL_FWD);
      navTurn = clamp(twist[1], -VEL_ANG, VEL_ANG);
      navInput.answered(navForward, navTurn);
      twistTarget[0] = navForward;
      twistTarget[1] = 0;
      twistTarget[2] = navTurn;
    }
  } else if (goal && navSession) {
    // Getting up, sitting or mid-move: the brain waits, and starts afresh after.
    navInput.reset();
    navForward = 0;
    navTurn = 0;
    twistTarget.fill(0);
  }
  post({ type: 'tof', zones: tofZones.slice(), driving, forward: driving ? navForward : 0, turn: driving ? navTurn : 0 });
}

async function controlStep(): Promise<void> {
  const d = data!;
  const stepStart = performance.now();
  recordStep();
  if ((driveGoal || depthWanted) && tofSite >= 0 && ++navTick >= NAV_EVERY) {
    navTick = 0;
    await senseAndDrive(d);
  }
  for (let k = 0; k < 3; k++) {
    twistSmooth[k] += TWIST_ALPHA * (twistTarget[k] - twistSmooth[k]);
  }
  for (let k = 0; k < 4; k++) {
    headSmooth[k] += HEAD_ALPHA * (headTarget[k] - headSmooth[k]);
  }
  let inferMs = 0;
  const policy = currentPolicy();
  const session = policy ? sessions[policy] : undefined;
  if (session) {
    fillCommand();
    inferMs = await act(d, session, lastAction, command);
    if (mode === 'motion' && motionFrames) {
      applyMotionFrame(d, motionFrames, motionStep);
    }
  }
  const physicsMs = stepPhysics(d);
  if (telemetryOn) sampleTelemetry(d, inferMs, session ? policy : null);
  simTime += CTRL_DT;
  advanceMoves(d);
  watchBall(d);

  statsSteps++;
  statsInfer += inferMs;
  statsInferMax = Math.max(statsInferMax, inferMs);
  statsPhysics += physicsMs;
  statsBusy += performance.now() - stepStart;
}

/** One telemetry record for this control step; posts a batch when full. */
function sampleTelemetry(d: Data, inferMs: number, policy: PolicyName | null): void {
  const out = telemetryBuf;
  const o = telemetryCount * TELEMETRY_STRIDE;
  const qpos = d.qpos as Float64Array;
  const qvel = d.qvel as Float64Array;
  const ctrl = d.ctrl as Float64Array;
  const sensors = d.sensordata as Float64Array;
  const force = d.actuator_force as Float64Array;
  out[o + TEL.gyro] = sensors[gyroAdr];
  out[o + TEL.gyro + 1] = sensors[gyroAdr + 1];
  out[o + TEL.gyro + 2] = sensors[gyroAdr + 2];
  projectedGravity(qpos, out, o + TEL.gravity);
  for (let k = 0; k < 3; k++) {
    out[o + TEL.accel + k] = accelAdr >= 0 ? sensors[accelAdr + k] : 0;
    out[o + TEL.cmd + k] = command[k];
  }
  for (let j = 0; j < NUM_JOINTS; j++) {
    out[o + TEL.q + j] = qpos[qposAdr[j]];
    out[o + TEL.target + j] = ctrl[j];
    out[o + TEL.qvel + j] = qvel[dofAdr[j]];
    out[o + TEL.force + j] = force[j] / forceLimit[j];
    out[o + TEL.action + j] = lastAction[j];
  }
  // Contact force on each foot: the force part of the body's external wrench.
  const ext = d.cfrc_ext as Float64Array;
  for (let f = 0; f < 2; f++) {
    const b = ankleBody[f];
    out[o + TEL.feet + f] = b >= 0 ? Math.hypot(ext[6 * b + 3], ext[6 * b + 4], ext[6 * b + 5]) : 0;
  }
  out[o + TEL.infer] = inferMs;
  out[o + TEL.policy] = policy ? TELEMETRY_POLICIES.indexOf(policy) : 0;
  telemetryCount++;
  if (telemetryCount === TELEMETRY_BATCH) {
    post({ type: 'telemetry', steps: telemetryCount, data: telemetryBuf }, [telemetryBuf.buffer]);
    telemetryBuf = new Float32Array(TELEMETRY_BATCH * TELEMETRY_STRIDE);
    telemetryCount = 0;
  }
}

function startRecovery(): void {
  falls++;
  fallDebounce = 0;
  moveFallSteps = 0;
  endMove(false);
  mode = 'walk';
  sitFlag = 0;
  sitHandover = 0;
  standHandback = 0;
  postKickLock = 0;
  recovery = { phase: 'fallen', steps: 0, upright: 0 };
  event('fall');
}

function advanceMoves(d: Data): void {
  const qpos = d.qpos as Float64Array;
  const height = qpos[freeAdr + 2];
  const gz = gravityZ(qpos);
  if (!Number.isFinite(height) || !Number.isFinite(gz)) {
    resetSim(); // solver blew up
    event('reset');
    return;
  }

  if (recovery) {
    recovery.steps++;
    if (recovery.phase === 'fallen') {
      if (recovery.steps >= FALL_SETTLE_STEPS) {
        recovery = { phase: 'getting-up', steps: 0, upright: 0 };
        lastAction.fill(0);
      }
    } else {
      recovery.upright = gz < -0.85 ? recovery.upright + 1 : 0;
      if (recovery.upright >= RECOVER_UPRIGHT_STEPS) {
        recovery = null;
        lastAction.fill(0);
        event('recovered');
      } else if (recovery.steps >= RECOVER_GIVEUP_STEPS) {
        resetSim();
        event('gave-up');
      }
    }
    return;
  }

  const tipped = gz > -0.5 || height < 0.02;
  if (mode === 'walk') {
    if (postKickLock > 0) postKickLock--;
    if (tipped && standHandback === 0) {
      if (++fallDebounce >= FALL_DEBOUNCE_STEPS) startRecovery();
    } else {
      fallDebounce = 0;
    }
    return;
  }

  // A move that floors the duck: grace, then the get-up policy.
  if (mode !== 'roll' && tipped) {
    if (++moveFallSteps >= MOVE_FALL_GRACE_STEPS) {
      startRecovery();
      return;
    }
  } else if (mode !== 'roll') {
    moveFallSteps = 0;
  }

  switch (mode) {
    case 'kick':
      if (++moveSteps >= KICK_STEPS) {
        mode = 'walk';
        postKickLock = POST_KICK_LOCK_STEPS; // lastAction is kept, as in the runtime
        endMove(true);
      }
      break;
    case 'motion':
      if (motionFrames && ++motionStep >= motionFrames.length / NUM_JOINTS) {
        if (motionLoop) {
          motionStep = 0;
        } else {
          mode = 'walk';
          motionFrames = null;
          lastAction.fill(0);
          endMove(true);
        }
      }
      break;
    case 'peck':
      peckPhase += CTRL_DT / PECK_PERIOD_S;
      if (peckPhase >= PECK_END_PHASE) {
        mode = 'walk';
        endMove(true);
      }
      break;
    case 'roll': {
      moveSteps++;
      if (gz > -0.3) rollTipped = true;
      const upright = gz < -0.85;
      const done = rollTipped && upright && moveSteps >= ROLL_MIN_STEPS;
      if (done || moveSteps >= Math.min(ROLL_MAX_STEPS, ROLL_FALL_GRACE_STEPS)) {
        mode = 'walk';
        lastAction.fill(0);
        if (upright) {
          endMove(true);
        } else {
          startRecovery(); // never hand a tipped duck to the walker
        }
      }
      break;
    }
    case 'sitstand':
      if (sitHandover > 0 && --sitHandover === 0) {
        sitFlag = 1;
        endMove(true); // the sit command is in; the policy lowers the duck
      }
      if (standHandback > 0 && --standHandback === 0) {
        mode = 'walk';
        lastAction.fill(0);
        endMove(true);
      }
      break;
  }
}

/** Applies queued move requests at a step boundary, with Pollen's guards. */
function applyMoves(): void {
  if (pendingMotion) {
    const request = pendingMotion;
    pendingMotion = null;
    if (mode === 'walk' && !recovery && standHandback === 0 && request.frames.length >= NUM_JOINTS) {
      mode = 'motion';
      motionFrames = request.frames;
      motionLoop = request.loop;
      motionStep = 0;
      moveFallSteps = 0;
      currentMove = 'motion';
      moveThisStep = 'motion';
      event('move-start', { move: 'motion' });
    } else {
      event('move-rejected', { move: 'motion' });
    }
  }
  while (pendingMoves.length > 0) {
    const move = pendingMoves.shift()!;
    const free = mode === 'walk' && !recovery && standHandback === 0;
    let ok = false;
    if (move === 'kickL' || move === 'kickR') {
      ok = free && !!sessions[move];
      if (ok) {
        mode = 'kick';
        kickPolicy = move;
        moveSteps = 0;
      }
    } else if (move === 'roll') {
      ok = free && !!sessions.roll;
      if (ok) {
        mode = 'roll';
        moveSteps = 0;
        rollTipped = false;
      }
    } else if (move === 'peck') {
      ok = free && !!sessions.peck;
      if (ok) {
        mode = 'peck';
        peckPhase = 0;
      }
    } else if (move === 'sit') {
      ok = free && postKickLock === 0 && !!sessions.sitstand;
      if (ok) {
        // Hold a stand under the sit/stand policy first, or the abrupt
        // policy switch knocks the duck over.
        mode = 'sitstand';
        sitFlag = 0;
        sitHandover = SIT_HANDOVER_STEPS;
        lastAction.fill(0);
      }
    } else if (move === 'stand') {
      ok = mode === 'sitstand' && !recovery && standHandback === 0;
      if (ok && sitFlag === 0) {
        // Still in the sit hand-over: cancel the sit and walk on.
        endMove(false);
        sitHandover = 0;
        mode = 'walk';
        lastAction.fill(0);
        continue;
      }
      if (ok) {
        sitFlag = 0;
        standHandback = STAND_HANDBACK_STEPS;
      }
    }
    if (ok) {
      moveFallSteps = 0;
      currentMove = move;
      moveThisStep = move;
      event('move-start', { move });
    } else {
      event('move-rejected', { move });
    }
  }
}

function watchBall(d: Data): void {
  if (ballQpos < 0) {
    return;
  }
  const qpos = d.qpos as Float64Array;
  const x = qpos[ballQpos];
  const y = qpos[ballQpos + 1];
  const z = qpos[ballQpos + 2];
  if (!Number.isFinite(x) || Math.hypot(x, y) > BALL_LIMIT || z < -0.5) {
    respawnBall();
  }
}

function reportedMode(): DuckMode {
  if (paused) return 'paused';
  if (recovery) return recovery.phase;
  if (mode === 'sitstand') {
    if (sitHandover > 0) return 'sitting-down';
    if (standHandback > 0) return 'standing-up';
    return 'sitting';
  }
  return mode;
}

function postPose(wallMs: number): void {
  const qpos = data!.qpos as Float64Array;
  const pose = new Float32Array(POSE_SIZE);
  for (let i = 0; i < 7; i++) {
    pose[i] = qpos[freeAdr + i];
  }
  for (let j = 0; j < NUM_JOINTS; j++) {
    pose[7 + j] = qpos[qposAdr[j]];
  }
  if (ballQpos >= 0) {
    for (let i = 0; i < 7; i++) pose[BALL_OFFSET + i] = qpos[ballQpos + i];
  } else {
    pose[BALL_OFFSET + 3] = 1;
  }
  post(
    { type: 'pose', generation, wallMs, simTime, pose, mode: reportedMode() },
    [pose.buffer],
  );
}

function postStats(now: number): void {
  const elapsed = now - statsStart;
  if (elapsed < STATS_PERIOD_MS) {
    return;
  }
  const steps = Math.max(statsSteps, 1);
  post({
    type: 'stats',
    policyHz: (statsSteps * 1000) / elapsed,
    inferMs: statsInfer / steps,
    inferMaxMs: statsInferMax,
    physicsMs: statsPhysics / steps,
    busy: statsBusy / elapsed,
    realtime: (statsSteps * CTRL_DT * 1000) / elapsed,
    falls,
    mode: reportedMode(),
  });
  statsStart = now;
  statsSteps = 0;
  statsInfer = 0;
  statsInferMax = 0;
  statsPhysics = 0;
  statsBusy = 0;
}

/**
 * Runs `steps` control steps flat out on a copy of the current state, so the
 * visible duck is untouched, and reports how much faster than real time the
 * sim (policy + physics) can go on this device.
 */
async function benchmark(steps: number): Promise<void> {
  const copy = new mj!.MjData(model!, data!);
  benchLastAction.set(lastAction);
  let inferMs = 0;
  let physicsMs = 0;
  const t0 = performance.now();
  for (let k = 0; k < steps; k++) {
    inferMs += await act(copy, sessions.walk!, benchLastAction, zeroCommand);
    physicsMs += stepPhysics(copy);
  }
  const wallMs = performance.now() - t0;
  copy.delete();
  post({
    type: 'benchmark',
    steps,
    wallMs,
    inferMs: inferMs / steps,
    physicsMs: physicsMs / steps,
    speedup: (steps * CTRL_DT * 1000) / wallMs,
  });
}

async function loop(): Promise<void> {
  looping = true;
  let next = performance.now();
  statsStart = next;
  try {
    for (;;) {
      if (parkRequested) {
        parkRequested = false;
        parkNow();
      }
      if (parked) {
        await sleep(20); // waiting for the next duck
        next = performance.now();
        continue;
      }
      if (pendingReset >= 0) {
        generation = pendingReset;
        pendingReset = -1;
        pendingMoves.length = 0;
        resetSim();
        respawnBall();
        if (pendingIntro) {
          pendingIntro = false;
          await sitDown();
          next = performance.now();
        }
        postPose(wallNow());
        event('reset');
      }
      if (pendingBenchmark > 0) {
        const steps = pendingBenchmark;
        pendingBenchmark = 0;
        await benchmark(steps);
        next = performance.now(); // don't try to catch up the benchmark time
        statsStart = next;
        statsSteps = statsInfer = statsInferMax = statsPhysics = statsBusy = 0;
      }
      if (pendingTeleport) {
        teleport(pendingTeleport);
        pendingTeleport = null;
      }
      if (pendingRebuild !== null) {
        const xml = pendingRebuild;
        pendingRebuild = null;
        rebuild(xml);
        next = performance.now(); // compiling took a while: don't catch up
      }
      if (pendingTerrain) {
        const buffer = pendingTerrain;
        pendingTerrain = null;
        terrainKeep.set(buffer);
        terrainSet = true;
        applyTerrain(model!);
        post({ type: 'terrain-done', data: buffer }, [buffer.buffer]);
      }
      if (pendingSnapshot >= 0) {
        const id = pendingSnapshot;
        pendingSnapshot = -1;
        postSnapshot(id);
      }
      if (pendingScene >= 0) {
        const id = pendingScene;
        pendingScene = -1;
        postScene(id);
      }
      if (pendingExport) {
        const req = pendingExport;
        pendingExport = null;
        await exportMotion(req);
        next = performance.now(); // the export took a while: don't catch up
        statsStart = next;
        statsSteps = statsInfer = statsInferMax = statsPhysics = statsBusy = 0;
      }
      if (!paused) {
        applyMoves();
        await controlStep();
        postPose(performance.timeOrigin + next);
      }
      next += CTRL_DT * 1000;
      const now = performance.now();
      postStats(now);
      const wait = next - now;
      if (wait > 0) {
        await sleep(wait);
      } else {
        next = now; // fell behind: drop the time instead of spiralling
      }
    }
  } catch (err) {
    looping = false;
    post({ type: 'error', message: `sim loop stopped: ${String(err)}` });
  }
}

scope.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      boot(msg).catch((err: unknown) => {
        post({ type: 'error', message: `sim boot failed: ${String(err)}` });
      });
      break;
    case 'command':
      // While the navigation brain drives, it sets the speed and turn; the head still listens.
      if (!(driveGoal && navSession)) {
        twistTarget[0] = clamp(msg.vx, -VEL_BACK, VEL_FWD);
        twistTarget[1] = 0; // the walking policy has no sideways command
        twistTarget[2] = clamp(msg.wz, -VEL_ANG, VEL_ANG);
      }
      for (let k = 0; k < 4; k++) {
        headTarget[k] = clamp(msg.head[k], -1.2, 1.2);
      }
      break;
    case 'move':
      if (pendingMoves.length < 4) pendingMoves.push(msg.move);
      break;
    case 'reset':
      pendingReset = msg.generation;
      pendingIntro = msg.intro === true;
      break;
    case 'teleport':
      pendingTeleport = msg;
      break;
    case 'pause':
      paused = msg.paused;
      break;
    case 'benchmark':
      pendingBenchmark = Math.max(1, Math.min(5000, Math.round(msg.steps)));
      break;
    case 'rebuild':
      pendingRebuild = msg.xml; // only the newest matters
      break;
    case 'terrain':
      if (pendingTerrain) {
        // Two in flight: hand the older one straight back.
        post({ type: 'terrain-done', data: pendingTerrain }, [pendingTerrain.buffer]);
      }
      pendingTerrain = msg.data;
      break;
    case 'terrain-config':
      terrainConfig.half = Math.min(TERRAIN_HALF_MAX, msg.half);
      terrainConfig.soft = msg.soft;
      terrainConfig.solref = msg.solref?.length === 2 ? msg.solref : TERRAIN_SOFT.solref;
      terrainConfig.solimp = msg.solimp?.length === 5 ? msg.solimp : TERRAIN_SOFT.solimp;
      if (model) applyTerrainConfig(model);
      break;
    case 'snapshot':
      pendingSnapshot = msg.id;
      break;
    case 'scene':
      pendingScene = msg.id;
      break;
    case 'play-motion':
      pendingMotion = { frames: msg.frames, loop: msg.loop };
      break;
    case 'export':
      pendingExport = msg;
      break;
    case 'telemetry':
      telemetryOn = msg.on;
      telemetryCount = 0;
      break;
    case 'policies':
      void swapPolicies(msg.id, msg.baseUrl);
      break;
    case 'park':
      parkRequested = true;
      break;
    case 'drive':
      if (msg.goal && msg.url && msg.url !== navUrl) void loadNav(msg.url);
      if (!msg.goal && driveGoal) {
        twistTarget.fill(0); // the stick's next command takes over
        navInput.reset();
      }
      driveGoal = msg.goal;
      break;
    case 'depth':
      depthWanted = msg.on;
      break;
    case 'camera-frame':
      if (msg.frame.length === navCamera.length) navCamera.set(msg.frame);
      break;
  }
};
