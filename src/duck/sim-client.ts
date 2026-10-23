// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Main-thread side of the duck sim: starts the worker, forwards commands and
 * moves, and turns the 50 Hz pose stream into smooth per-frame poses.
 *
 * Every pose carries the wall-clock time it belongs to. The renderer draws
 * the duck a little in the past (see sample()) so there is always a newer
 * pose to interpolate towards, whatever the display rate (72/90/120 Hz).
 */
import {
  BALL_OFFSET,
  type DuckMode,
  type MoveName,
  NUM_JOINTS,
  type PolicyName,
  POSE_SIZE,
  TELEMETRY_STRIDE,
} from './duck-constants.js';
import { buildPhysicsMjcf, type PhysicsCollider, type PhysicsCourse } from './mjcf.js';
import type {
  MainToWorker,
  SimBenchmarkResult,
  SimEvent,
  SimExportResult,
  SimReady,
  SimSnapshot,
  SimStats,
  WorkerToMain,
} from './sim-protocol.js';
import { TERRAIN_N } from './terrain-spec.js';

export interface DuckSimUrls {
  mjcfUrl: string;
  /** Folder of collision meshes; must end with "/". */
  meshBaseUrl: string;
  /** Folder of policies; must end with "/". */
  policyBaseUrl: string;
}

/** Wall clock comparable between the page and the worker. */
export const wallNow = (): number => performance.timeOrigin + performance.now();

const RING = 16;
/** Gaps longer than this (a pause, a hitch) are not interpolated across. */
const MAX_INTERP_GAP_MS = 100;

const absolute = (url: string): string => new URL(url, document.baseURI).href;

/** Four seconds of control steps. */
export const TELEMETRY_WINDOW = 200;
const TELEMETRY_RING = TELEMETRY_WINDOW;

/** The newest robot telemetry records (layout: TEL in duck-constants.ts). */
export class TelemetryRing {
  readonly capacity = TELEMETRY_RING;
  readonly data = new Float32Array(TELEMETRY_RING * TELEMETRY_STRIDE);
  /** Records received so far; the newest sits at (count - 1) % capacity. */
  count = 0;

  push(batch: Float32Array, steps: number): void {
    for (let i = 0; i < steps; i++) {
      const slot = this.count % this.capacity;
      this.data.set(batch.subarray(i * TELEMETRY_STRIDE, (i + 1) * TELEMETRY_STRIDE), slot * TELEMETRY_STRIDE);
      this.count++;
    }
  }

  /** Start of the record `back` steps before the newest (0 is the newest), or -1. */
  offset(back: number): number {
    if (back < 0 || back >= Math.min(this.count, this.capacity)) return -1;
    return ((this.count - 1 - back) % this.capacity) * TELEMETRY_STRIDE;
  }

  clear(): void {
    this.count = 0;
  }
}

/**
 * The last duck's worker, parked (MuJoCo, ONNX Runtime and the policies still
 * loaded) for the next duck: switching playgrounds then only compiles the new
 * level's model instead of starting both engines again.
 */
let parkedWorker: Worker | null = null;

export class DuckSimClient {
  /** Sim workers started and reused so far (a playground switch should reuse). */
  static workersStarted = 0;
  static workersReused = 0;
  ready: SimReady | null = null;
  stats: SimStats | null = null;
  benchmark: SimBenchmarkResult | null = null;
  error: string | null = null;
  /** Mode of the newest pose received. */
  mode: DuckMode = 'walk';
  readonly loadedPolicies = new Set<PolicyName>();
  /** Robot telemetry, filled while setTelemetry(true) is on. */
  readonly telemetry = new TelemetryRing();
  private telemetryOn = false;
  onEvent: ((event: SimEvent) => void) | null = null;
  onBenchmark: ((result: SimBenchmarkResult) => void) | null = null;

  private readonly worker: Worker;
  /** A reused worker: the last duck's messages are dropped until it says it parked. */
  private awaitingPark = false;
  private readonly times = new Float64Array(RING);
  private readonly poses = new Float32Array(RING * POSE_SIZE);
  private newest = -1;
  private count = 0;
  private generation = 0;
  private paused = false;
  private readonly sent = new Float32Array(6);
  private sentAt = 0;
  private startResolve: (() => void) | null = null;
  private startReject: ((err: Error) => void) | null = null;
  /** The pack's MJCF and the course, kept so the model can be rebuilt with new room colliders. */
  private source: string | null = null;
  private course: PhysicsCourse = { colliders: [], ball: null };
  private room: PhysicsCollider[] = [];
  /** What the worker's model was built with. */
  private builtRoom: PhysicsCollider[] = [];
  private builtCourse: PhysicsCourse | null = null;
  /** Terrain buffers not currently with the worker (two in rotation). */
  private terrainFree: Float32Array[] = [new Float32Array(TERRAIN_N * TERRAIN_N), new Float32Array(TERRAIN_N * TERRAIN_N)];
  /** Rebuilds the worker reported (for the lab panel). */
  rebuilds = 0;
  rebuildMs = 0;
  private snapshotId = 0;
  private policySwapId = 0;
  private policyWaiters = new Map<number, { resolve: (hash: string) => void; reject: (err: Error) => void }>();
  private snapshotWaiters = new Map<number, (snapshot: SimSnapshot) => void>();
  private exportWaiters = new Map<number, (result: SimExportResult) => void>();
  /** The pack's MJCF as fetched, for scenario packs. */
  get sourceMjcf(): string | null {
    return this.source;
  }

  constructor() {
    if (parkedWorker) {
      this.worker = parkedWorker;
      parkedWorker = null;
      this.awaitingPark = true;
      DuckSimClient.workersReused++;
    } else {
      this.worker = new Worker(new URL('./duck-sim.worker.ts', import.meta.url), {
        type: 'module',
        name: 'duck-sim',
      });
      DuckSimClient.workersStarted++;
    }
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => this.receive(event.data);
    this.worker.onerror = (event: ErrorEvent) => {
      this.fail(`sim worker error: ${event.message}`);
    };
    this.sent.fill(Number.NaN);
  }

  /** Loads the physics model, course and policies; resolves once the duck stands. */
  async start(urls: DuckSimUrls, course: PhysicsCourse, room: PhysicsCollider[] = []): Promise<void> {
    const res = await fetch(urls.mjcfUrl);
    if (!res.ok) {
      throw new Error(`MJCF ${urls.mjcfUrl}: HTTP ${res.status}`);
    }
    this.source = await res.text();
    this.course = course;
    this.builtCourse = course;
    if (this.room.length === 0) this.room = room; // unless setRoom() came first
    this.builtRoom = this.room;
    const { xml, meshFiles } = buildPhysicsMjcf(this.source, course, this.room);
    const started = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.post({
      type: 'init',
      xml,
      meshFiles,
      meshBaseUrl: absolute(urls.meshBaseUrl),
      policyBaseUrl: absolute(urls.policyBaseUrl),
      hasBall: course.ball !== null,
      intro: true,
    });
    return started;
  }

  /**
   * Forward speed (m/s), turn rate (rad/s) and head command slots; sends only
   * on a change (or once a second).
   */
  setCommand(vx: number, wz: number, head: ArrayLike<number>): void {
    const now = performance.now();
    const s = this.sent;
    const changed =
      Math.abs(vx - s[0]) > 1e-3 ||
      Math.abs(wz - s[1]) > 1e-3 ||
      Math.abs(head[0] - s[2]) > 5e-3 ||
      Math.abs(head[1] - s[3]) > 5e-3 ||
      Math.abs(head[2] - s[4]) > 5e-3 ||
      Math.abs(head[3] - s[5]) > 5e-3;
    if (!changed && now - this.sentAt < 1000) {
      return;
    }
    s[0] = vx;
    s[1] = wz;
    s[2] = head[0];
    s[3] = head[1];
    s[4] = head[2];
    s[5] = head[3];
    this.sentAt = now;
    this.post({ type: 'command', vx, wz, head: [head[0], head[1], head[2], head[3]] });
  }

  /** Fires a move; the worker answers with move-start or move-rejected. */
  move(move: MoveName): void {
    this.post({ type: 'move', move });
  }

  /**
   * Puts the duck back at the start and respawns the ball. With `intro`, it
   * comes back sitting, ready for a wake-up.
   */
  reset(intro = false): void {
    this.generation++;
    this.count = 0;
    this.newest = -1;
    this.post({ type: 'reset', generation: this.generation, intro });
  }

  /** Development only: move the duck (stage MuJoCo frame, radians), optionally dropping it from height z. */
  teleport(x: number, y: number, yaw: number, tilt = 0, z?: number): void {
    this.post({ type: 'teleport', x, y, yaw, tilt, ...(z === undefined ? {} : { z }) });
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) {
      return;
    }
    this.paused = paused;
    this.post({ type: 'pause', paused });
  }

  runBenchmark(steps: number): void {
    this.post({ type: 'benchmark', steps });
  }

  /**
   * Replaces the static room colliders (walls, furniture) and rebuilds the
   * model around the running duck. Before start() finishes, the colliders
   * go into the initial model instead.
   */
  setRoom(room: PhysicsCollider[]): void {
    this.room = room;
    this.rebuildIfNeeded();
  }

  /**
   * Replaces the course colliders (the editor moved pieces) and rebuilds the
   * model around the duck. The ball must not come or go: that changes the
   * state layout, so the caller restarts the sim instead.
   */
  setCourse(course: PhysicsCourse): void {
    this.course = course;
    this.rebuildIfNeeded();
  }

  private rebuildIfNeeded(): void {
    if (!this.source || !this.ready || (this.room === this.builtRoom && this.course === this.builtCourse)) {
      return;
    }
    this.builtRoom = this.room;
    this.builtCourse = this.course;
    const { xml } = buildPhysicsMjcf(this.source, this.course, this.room);
    this.post({ type: 'rebuild', xml });
  }

  /** A terrain buffer to fill, or null while both are with the worker. */
  takeTerrainBuffer(): Float32Array | null {
    return this.terrainFree.pop() ?? null;
  }

  /** Sends elevations taken with takeTerrainBuffer(); the buffer comes back on its own. */
  setTerrain(data: Float32Array): void {
    this.worker.postMessage({ type: 'terrain', data } satisfies MainToWorker, [data.buffer]);
  }

  /** Plays a keyframe motion (N x NUM_JOINTS offsets at 50 Hz) as a move. */
  playMotion(frames: Float32Array, loop = false): void {
    this.worker.postMessage({ type: 'play-motion', frames, loop } satisfies MainToWorker);
  }

  /** Records a behaviour-cloning set for a motion; the live duck pauses meanwhile. */
  exportMotion(frames: Float32Array, episodes: number, poseNoise = 0.08, pushNoise = 0.15): Promise<SimExportResult> {
    const id = ++this.snapshotId;
    return new Promise((resolve) => {
      this.exportWaiters.set(id, resolve);
      this.worker.postMessage({ type: 'export', id, frames, episodes, poseNoise, pushNoise } satisfies MainToWorker);
    });
  }

  /** The scene, a recent state and the inputs since: a reproducible scenario. */
  snapshot(): Promise<SimSnapshot> {
    const id = ++this.snapshotId;
    return new Promise((resolve) => {
      this.snapshotWaiters.set(id, resolve);
      this.post({ type: 'snapshot', id });
    });
  }

  /**
   * Writes the pose for wall time `wallMs` into `out`, interpolating between
   * the two poses around it. Returns false until a pose of the current
   * generation has arrived.
   */
  sample(wallMs: number, out: Float32Array): boolean {
    if (this.count === 0) {
      return false;
    }
    // Walk back from the newest pose to the last one at or before wallMs.
    let a = this.newest;
    let steps = 1;
    while (steps < this.count && this.times[a] > wallMs) {
      a = (a + RING - 1) % RING;
      steps++;
    }
    const b = (a + 1) % RING;
    const hasNext = a !== this.newest;
    const ta = this.times[a];
    if (!hasNext || wallMs <= ta || this.times[b] - ta > MAX_INTERP_GAP_MS) {
      out.set(this.poses.subarray(a * POSE_SIZE, a * POSE_SIZE + POSE_SIZE));
      return true;
    }
    const t = Math.min(1, (wallMs - ta) / (this.times[b] - ta));
    const ia = a * POSE_SIZE;
    const ib = b * POSE_SIZE;
    this.lerp(ia, ib, 0, 3, t, out);
    this.nlerp(ia, ib, 3, t, out);
    this.lerp(ia, ib, 7, NUM_JOINTS, t, out);
    this.lerp(ia, ib, BALL_OFFSET, 3, t, out);
    this.nlerp(ia, ib, BALL_OFFSET + 3, t, out);
    return true;
  }

  /** Parks the worker for the next duck when this one booted fine; otherwise ends it. */
  dispose(): void {
    this.worker.onmessage = null;
    this.worker.onerror = null;
    if (!parkedWorker && this.ready && !this.error) {
      this.post({ type: 'park' });
      parkedWorker = this.worker;
    } else {
      this.worker.terminate();
    }
  }

  private lerp(ia: number, ib: number, at: number, n: number, t: number, out: Float32Array): void {
    const p = this.poses;
    for (let i = at; i < at + n; i++) {
      out[i] = p[ia + i] + (p[ib + i] - p[ia + i]) * t;
    }
  }

  /** Normalised lerp of a quaternion (fine for poses 20 ms apart). */
  private nlerp(ia: number, ib: number, at: number, t: number, out: Float32Array): void {
    const p = this.poses;
    let dot = 0;
    for (let i = at; i < at + 4; i++) {
      dot += p[ia + i] * p[ib + i];
    }
    const sign = dot < 0 ? -1 : 1;
    let len = 0;
    for (let i = at; i < at + 4; i++) {
      out[i] = p[ia + i] + (sign * p[ib + i] - p[ia + i]) * t;
      len += out[i] * out[i];
    }
    len = Math.sqrt(len) || 1;
    for (let i = at; i < at + 4; i++) {
      out[i] /= len;
    }
  }

  /**
   * Swaps in the policy set under `baseUrl` (same file names) while the duck
   * keeps going; resolves with the new walking policy's hash. On failure the
   * old policies stay in use and the promise rejects.
   */
  loadPolicies(baseUrl: string): Promise<string> {
    const id = ++this.policySwapId;
    const absoluteUrl = absolute(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    return new Promise((resolve, reject) => {
      this.policyWaiters.set(id, { resolve, reject });
      this.post({ type: 'policies', id, baseUrl: absoluteUrl });
    });
  }

  /** Starts or stops the robot telemetry stream (cheap; only the panel's details view needs it). */
  setTelemetry(on: boolean): void {
    if (on === this.telemetryOn) return;
    this.telemetryOn = on;
    if (!on) this.telemetry.clear();
    this.post({ type: 'telemetry', on });
  }

  private receive(msg: WorkerToMain): void {
    if (this.awaitingPark) {
      if (msg.type === 'parked') this.awaitingPark = false;
      return;
    }
    switch (msg.type) {
      case 'pose': {
        if (msg.generation !== this.generation) {
          return; // from before the last reset
        }
        this.newest = (this.newest + 1) % RING;
        this.count = Math.min(this.count + 1, RING);
        this.times[this.newest] = msg.wallMs;
        this.poses.set(msg.pose, this.newest * POSE_SIZE);
        this.mode = msg.mode;
        break;
      }
      case 'telemetry':
        this.telemetry.push(msg.data, msg.steps);
        break;
      case 'policies-loaded': {
        const waiter = this.policyWaiters.get(msg.id);
        this.policyWaiters.delete(msg.id);
        if (msg.ok && this.ready) this.ready = { ...this.ready, policyHash: msg.policyHash };
        if (msg.ok) waiter?.resolve(msg.policyHash);
        else waiter?.reject(new Error(msg.message ?? 'policy swap failed'));
        break;
      }
      case 'stats':
        this.stats = msg;
        break;
      case 'ready':
        this.ready = msg;
        this.loadedPolicies.add('walk');
        this.loadedPolicies.add('stand');
        this.loadedPolicies.add('sitstand');
        this.startResolve?.();
        this.startResolve = this.startReject = null;
        this.rebuildIfNeeded(); // room colliders that arrived while booting
        break;
      case 'event':
        if (msg.kind === 'policy-loaded' && msg.policy) {
          this.loadedPolicies.add(msg.policy);
        }
        this.onEvent?.(msg);
        break;
      case 'benchmark':
        this.benchmark = msg;
        this.onBenchmark?.(msg);
        break;
      case 'error':
        this.fail(msg.message);
        break;
      case 'terrain-done':
        if (this.terrainFree.length < 2) this.terrainFree.push(msg.data);
        break;
      case 'rebuilt':
        this.rebuilds++;
        this.rebuildMs = msg.ms;
        if (this.ready) this.ready.ngeom = msg.ngeom; // keep the live geom count
        break;
      case 'snapshot': {
        const waiter = this.snapshotWaiters.get(msg.id);
        this.snapshotWaiters.delete(msg.id);
        waiter?.(msg);
        break;
      }
      case 'export': {
        const waiter = this.exportWaiters.get(msg.id);
        this.exportWaiters.delete(msg.id);
        waiter?.(msg);
        break;
      }
    }
  }

  private fail(message: string): void {
    this.error = message;
    console.error(`[duck-sim] ${message}`);
    this.startReject?.(new Error(message));
    this.startResolve = this.startReject = null;
  }

  private post(msg: MainToWorker): void {
    this.worker.postMessage(msg);
  }
}
