// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Messages between the main thread and the duck sim worker.
 * Kept free of DOM and three.js imports so both sides can load it.
 */
import type { DuckMode, MoveName, PolicyName } from './duck-constants.js';

export interface SimInit {
  type: 'init';
  /** MJCF text, already prepared by buildPhysicsMjcf (floor, course, ball). */
  xml: string;
  /** Absolute URL of the folder holding the collision meshes (ends in "/"). */
  meshBaseUrl: string;
  /** Mesh file names the MJCF references (looked up as assets/<name>). */
  meshFiles: string[];
  /** Absolute URL of the policy folder (ends in "/"). */
  policyBaseUrl: string;
  /** Whether the MJCF has the kickable ball (body "ball"). */
  hasBall: boolean;
  /** Start sitting (the wake-up intro): the game later sends a 'stand' move. */
  intro: boolean;
}

export interface SimCommand {
  type: 'command';
  /** Forward speed (m/s, negative walks back) and turn rate (rad/s, + is left). */
  vx: number;
  wz: number;
  /**
   * Head command slots [neck pitch, head pitch, head yaw, head roll] in the
   * runtime's units: + neck pitch looks up, + head pitch looks down,
   * + head yaw looks left, + head roll tilts right. Smoothed in the worker.
   */
  head: [number, number, number, number];
}

export interface SimMove {
  type: 'move';
  move: MoveName;
}

export interface SimReset {
  type: 'reset';
  /** Echoed back on every pose so the renderer can drop stale ones. */
  generation: number;
  /** Come back sitting, for a wake-up intro. */
  intro?: boolean;
}

/** Development only: put the duck somewhere (stage MuJoCo frame). */
export interface SimTeleport {
  type: 'teleport';
  x: number;
  y: number;
  /** Heading, radians (0 = along +x). */
  yaw: number;
  /** Tip over sideways, radians (to test falls). */
  tilt: number;
  /** Trunk height to drop from (default: standing on the floor). */
  z?: number;
}

export interface SimPause {
  type: 'pause';
  paused: boolean;
}

export interface SimBenchmark {
  type: 'benchmark';
  /** Control steps to run back to back (each is 20 ms of sim time). */
  steps: number;
}

/**
 * Swap the model for one compiled from new MJCF with the same joints (the
 * static room colliders changed). The duck's state carries over.
 */
export interface SimRebuild {
  type: 'rebuild';
  xml: string;
}

/**
 * New elevations for the live terrain, two layers of TERRAIN_N * TERRAIN_N
 * values in 0..1 (see terrain-spec.ts): first the room scan's (hard), then the
 * depth sensor's. The buffer is transferred and handed back in a
 * 'terrain-done' message.
 */
export interface SimTerrain {
  type: 'terrain';
  data: Float32Array;
}

/**
 * How the live terrain is laid out and felt: `half` metres from its centre to
 * its edge (TERRAIN_HALF_MAX at most; smaller means finer cells), and whether
 * the depth layer is soft (TERRAIN_SOFT) or as hard as everything else.
 */
export interface SimTerrainConfig {
  type: 'terrain-config';
  half: number;
  soft: boolean;
  /** The soft contact to use instead of TERRAIN_SOFT (tuning and tests). */
  solref?: readonly number[];
  solimp?: readonly number[];
}

/** Ask for the static scene as shapes (answered with a SimScene of the same id). */
export interface SimSceneRequest {
  type: 'scene';
  id: number;
}

/** Ask for a scenario snapshot (answered with a SimSnapshot of the same id). */
export interface SimSnapshotRequest {
  type: 'snapshot';
  id: number;
}

/**
 * Play a keyframe motion open loop: `frames` holds N x NUM_JOINTS joint
 * target offsets from the standing pose, one row per control step. Starts
 * from walking like the other moves and hands back when done.
 */
export interface SimPlayMotion {
  type: 'play-motion';
  frames: Float32Array;
  loop: boolean;
}

/**
 * Build a training set for a motion: play it from `episodes` randomized
 * standing starts on a copy of the sim and record every step's observation
 * (the policy's 61 values) with the applied action (the 14 offsets).
 */
export interface SimExportRequest {
  type: 'export';
  id: number;
  frames: Float32Array;
  episodes: number;
  /** Uniform joint-angle jitter at the start, radians. */
  poseNoise: number;
  /** Uniform trunk velocity jitter at the start, m/s. */
  pushNoise: number;
}

/**
 * Swaps in another policy set (same file names, e.g. a trained release)
 * while the duck keeps going; answered by SimPoliciesLoaded.
 */
export interface SimPolicies {
  type: 'policies';
  id: number;
  baseUrl: string;
}

/** Turns the robot telemetry stream (SimTelemetry) on or off. */
export interface SimTelemetryRequest {
  type: 'telemetry';
  on: boolean;
}

/**
 * The duck went away: free its model but keep MuJoCo, ONNX Runtime and the
 * policy sessions for the next duck (the worker is reused across playgrounds).
 */
export interface SimPark {
  type: 'park';
}

/** The worker has parked: every message after this one belongs to the next duck. */
export interface SimParked {
  type: 'parked';
}

/**
 * Self-driving: the navigation brain (nav-brain.ts) steers the walker towards
 * `goal` (stage frame, MuJoCo x and y, metres) from the head's distance
 * sensor, and the stick's speed and turn are ignored; `null` hands back.
 * `url` is the brain's ONNX file, loaded once.
 */
export interface SimDrive {
  type: 'drive';
  goal: [number, number] | null;
  url: string;
}

/** Whether the main thread wants the head sensor's frames (the robot panel's DEPTH view). */
export interface SimDepthRequest {
  type: 'depth';
  on: boolean;
}

/** One frame of the head's distance sensor (tof.ts), ten a second while driving or asked for. */
export interface SimTof {
  type: 'tof';
  /** 64 zones, row 0 the top, column 0 the sensor's left; metres, TOF_RANGE when nothing is in range. */
  zones: Float32Array;
  /** True while the navigation brain is steering. */
  driving: boolean;
  /** The brain's last twist (forward m/s, turn rad/s), zero when not driving. */
  forward: number;
  turn: number;
}

/**
 * The head camera's picture for a camera brain (nav-camera.onnx), ten a
 * second while it drives: RGB 0..1, channels first, row 0 the top
 * (NAV_CAMERA_CHANNELS x NAV_CAMERA_HEIGHT x NAV_CAMERA_WIDTH).
 */
export interface SimCameraFrame {
  type: 'camera-frame';
  frame: Float32Array;
}

/** The camera brain's input picture. */
export const NAV_CAMERA_WIDTH = 64;
export const NAV_CAMERA_HEIGHT = 36;
export const NAV_CAMERA_CHANNELS = 3;

/** The navigation brain loaded, or did not. */
export interface SimNavLoaded {
  type: 'nav-loaded';
  ok: boolean;
  /** True when the brain also takes the head camera's picture (SimCameraFrame). */
  camera?: boolean;
  message?: string;
}

export type MainToWorker =
  | SimPolicies
  | SimTelemetryRequest
  | SimInit
  | SimCommand
  | SimMove
  | SimReset
  | SimTeleport
  | SimPause
  | SimBenchmark
  | SimRebuild
  | SimTerrain
  | SimTerrainConfig
  | SimSnapshotRequest
  | SimSceneRequest
  | SimPlayMotion
  | SimExportRequest
  | SimPark
  | SimDrive
  | SimDepthRequest
  | SimCameraFrame;

export interface SimReady {
  type: 'ready';
  /** Milliseconds from init until the duck could walk. */
  bootMs: number;
  nq: number;
  nv: number;
  nbody: number;
  ngeom: number;
  /** Hash of the walking policy file (see duck-sim.worker.ts), for run records. */
  policyHash: string;
}

export interface SimPose {
  type: 'pose';
  generation: number;
  /**
   * Wall-clock time this pose belongs to, as performance.timeOrigin +
   * performance.now() (comparable across the worker and the page).
   */
  wallMs: number;
  /** Seconds of simulated time since boot. */
  simTime: number;
  /** POSE_SIZE floats, see duck-constants.ts. */
  pose: Float32Array;
  mode: DuckMode;
}

export interface SimStats {
  type: 'stats';
  /** Achieved control (policy) rate. */
  policyHz: number;
  /** Mean / worst policy inference time per control step (ms). */
  inferMs: number;
  inferMaxMs: number;
  /** Mean physics time per control step, 4 MuJoCo steps (ms). */
  physicsMs: number;
  /** Fraction of wall time the worker was busy (0..1). */
  busy: number;
  /** Simulated seconds per wall second while paced (1 = real time). */
  realtime: number;
  falls: number;
  mode: DuckMode;
}

export type SimEventKind =
  | 'fall'
  | 'recovered'
  | 'reset'
  | 'gave-up'
  | 'move-start'
  | 'move-end'
  | 'move-rejected'
  | 'policy-loaded';

export interface SimEvent {
  type: 'event';
  kind: SimEventKind;
  /** For move events. */
  move?: MoveName;
  /** For move-end: false when the move ended in a fall or a reset. */
  ok?: boolean;
  /** For policy-loaded. */
  policy?: PolicyName;
}

export interface SimBenchmarkResult {
  type: 'benchmark';
  steps: number;
  wallMs: number;
  inferMs: number;
  physicsMs: number;
  /** How many times faster than real time the sim ran flat out. */
  speedup: number;
}

export interface SimError {
  type: 'error';
  message: string;
}

/** The terrain buffer coming back for reuse. */
export interface SimTerrainDone {
  type: 'terrain-done';
  data: Float32Array;
}

export interface SimRebuilt {
  type: 'rebuilt';
  ngeom: number;
  /** Compile plus state copy, milliseconds. */
  ms: number;
}

/** A full sim state at one moment, enough to continue from. */
export interface SimState {
  /** Simulated seconds since boot. */
  time: number;
  qpos: Float64Array;
  qvel: Float64Array;
  /** The policy's last action and the smoothed commands at that moment. */
  lastAction: Float32Array;
  twistSmooth: Float32Array;
  headSmooth: Float32Array;
}

/** One control step's inputs, as the worker applied them. */
export interface SimStep {
  t: number;
  vx: number;
  wz: number;
  head: [number, number, number, number];
  /** A move that started on this step. */
  move: MoveName | null;
}

/**
 * Everything needed to reproduce the last stretch of simulation elsewhere:
 * the compiled scene, the live terrain, a state from 10-20 s ago and every
 * input since. See src/training/scenario-system.ts.
 */
export interface SimSnapshot {
  type: 'snapshot';
  id: number;
  /** The MJCF the current model was compiled from, with the terrain's size as in use. */
  xml: string;
  /**
   * The whole live terrain (TERRAIN_N * TERRAIN_N elevations: the higher of
   * the scan and depth layers per cell), or null if never set.
   */
  hfield: Float32Array | null;
  start: SimState;
  steps: SimStep[];
  /** Where the sim is now, to check a replay against. */
  end: SimState;
  mode: DuckMode;
  falls: number;
}

/** One static geom of the compiled model, posed in the duck stage's MuJoCo frame (Z up, metres). */
export interface SceneShape {
  kind: 'plane' | 'sphere' | 'capsule' | 'ellipsoid' | 'cylinder' | 'box';
  name: string;
  /** MuJoCo's geom_size: half extents for a box, radius and half length for a cylinder or capsule. */
  size: [number, number, number];
  pos: [number, number, number];
  /** w, x, y, z */
  quat: [number, number, number, number];
  /** The geom's colour (its material's when it has one); alpha 0 when it has neither (colliders nobody draws). */
  rgba: [number, number, number, number];
}

/** The live terrain as one height field: the higher of the scan and depth layers per cell. */
export interface SceneTerrain {
  /** Metres from the centre to the edge, both ways. */
  half: number;
  /** Metres at elevation 1. */
  elev: number;
  /** Rows run along y (the first at -half), columns along x. */
  rows: number;
  cols: number;
  pos: [number, number, number];
  /** rows * cols elevations in 0..1. */
  heights: Float32Array;
}

/**
 * The compiled model's static scene, for other simulators and viewers
 * (src/link/isaac-link.ts): every geom welded to the world (the floor, the
 * course, the room's colliders) except height fields, and the terrain.
 */
export interface SimScene {
  type: 'scene';
  id: number;
  shapes: SceneShape[];
  terrain: SceneTerrain | null;
  /** Static geoms of other kinds (meshes), not included. */
  skipped: number;
}

export interface SimExportResult {
  type: 'export';
  id: number;
  /** steps x OBS_SIZE and steps x NUM_JOINTS, episodes back to back. */
  obs: Float32Array;
  act: Float32Array;
  episodeLengths: Int32Array;
  /** 1 when the duck stood at the end of the episode. */
  successes: Uint8Array;
  wallMs: number;
}

/**
 * A batch of robot telemetry: `steps` records of TELEMETRY_STRIDE floats
 * (layout in duck-constants.ts TEL), oldest first, while the stream is on.
 */
export interface SimTelemetry {
  type: 'telemetry';
  steps: number;
  data: Float32Array;
}

/** A policy swap finished: on failure the old set keeps running. */
export interface SimPoliciesLoaded {
  type: 'policies-loaded';
  id: number;
  ok: boolean;
  /** Hash of the walking policy now in use. */
  policyHash: string;
  message?: string;
}

export type WorkerToMain =
  | SimPoliciesLoaded
  | SimTelemetry
  | SimReady
  | SimPose
  | SimStats
  | SimEvent
  | SimBenchmarkResult
  | SimError
  | SimTerrainDone
  | SimRebuilt
  | SimSnapshot
  | SimScene
  | SimExportResult
  | SimParked
  | SimTof
  | SimNavLoaded;
