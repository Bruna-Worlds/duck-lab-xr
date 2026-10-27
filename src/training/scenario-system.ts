// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Scenario packs: when the duck struggles, pack what it takes to reproduce
 * the moment in a desktop or cloud simulator (MuJoCo, MJX, Isaac Sim through
 * its MJCF importer) and train on it. A pack holds the exact scene the
 * headset simulated (robot, course, scanned walls and furniture, the live
 * terrain), a state from 10-20 s before the trouble, every input since, and
 * where the sim ended up, so a replay can be checked. tools/train/replay.mjs
 * replays and exports packs; trained policies come back through
 * ?policies=<folder>.
 *
 * Triggers: two falls within 20 s, the autopilot stuck for 8 s, or X / the
 * lab panel's "Pack scenario" button. A headset paired with Duck Lab XR's
 * trainer sends the pack to it over their link (src/link/lab-link-system.ts);
 * in development without the link it is posted to the dev server
 * (artifacts/scenarios/ on the PC, also from the headset); otherwise it is
 * kept for the trainer, downloaded, or kept in memory.
 */
import { createSystem } from '@iwsdk/core';
import {
  CMD_SIZE,
  CTRL_DT,
  DECIMATION,
  DEFAULT_POSE,
  HEAD_ALPHA,
  JOINT_NAMES,
  NUM_JOINTS,
  OBS_SIZE,
  POLICY_FILES,
  VEL_ANG,
  VEL_BACK,
  VEL_FWD,
} from '../duck/duck-constants.js';
import { DuckCamSystem, VISION_BACKDROP, VISION_FLOOR } from '../duck/duck-cam-system.js';
import { DuckSystem } from '../duck/duck-system.js';
import type { PhysicsCollider } from '../duck/mjcf.js';
import { NAV_CAMERA_HEIGHT, NAV_CAMERA_WIDTH, type SimEvent, type SimSnapshot, type SimState } from '../duck/sim-protocol.js';
import { LabLinkSystem } from '../link/lab-link-system.js';
import { TERRAIN_N } from '../duck/terrain-spec.js';
import { NavSystem } from '../nav/nav-system.js';
import { PlaygroundSystem } from '../playgrounds/playground-system.js';
import { RoomSystem } from '../room/room-system.js';
import { TerrainSystem } from '../room/terrain-system.js';

export type ScenarioReason = 'falls' | 'stuck' | 'manual';

const FALLS_WINDOW_MS = 20000;
const FALLS_NEEDED = 2;
const MIN_GAP_MS = 30000; // at most one automatic pack per half minute
const EVENT_KEEP = 40;
export const INBOX_PATH = '__duck/scenarios';

const numbers = (a: ArrayLike<number>): number[] => Array.from(a, (v) => Number(v.toFixed(6)));

function base64Float32(data: Float32Array): string {
  return base64Bytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function colliderJson(c: PhysicsCollider) {
  return {
    type: c.type,
    size: numbers(c.size),
    pos: numbers(c.pos),
    quat: numbers(c.quat),
    ...(c.walkable ? { walkable: true } : {}),
    ...(c.label ? { label: c.label } : {}),
  };
}

function stateJson(state: SimState) {
  return {
    time: state.time,
    qpos: numbers(state.qpos),
    qvel: numbers(state.qvel),
    lastAction: numbers(state.lastAction),
    twistSmooth: numbers(state.twistSmooth),
    headSmooth: numbers(state.headSmooth),
  };
}

export class ScenarioSystem extends createSystem({}) {
  /** For the lab panel. */
  summary = 'Scenario: none packed yet';
  packs = 0;
  private duck: DuckSystem | undefined;
  private nav: NavSystem | undefined;
  private room: RoomSystem | undefined;
  private terrain: TerrainSystem | undefined;
  private playgrounds: PlaygroundSystem | undefined;
  private fallTimes: number[] = [];
  private events: { t: number; kind: string; move?: string }[] = [];
  private lastAutoAt = -Infinity;
  private busy = false;
  private stuckPacked = false;
  /** Development, ?packAfter=<s>: walk the course and pack a test case that long after waking (headset runs). */
  private packAfterMs = 0;
  private packWalkAt = 0;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.nav = this.world.getSystem(NavSystem);
    this.room = this.world.getSystem(RoomSystem);
    this.terrain = this.world.getSystem(TerrainSystem);
    this.playgrounds = this.world.getSystem(PlaygroundSystem);
    if (import.meta.env.DEV) this.packAfterMs = (Number(new URLSearchParams(location.search).get('packAfter')) || 0) * 1000;
    const onEvent = (event: SimEvent) => this.onSimEvent(event);
    this.duck?.simEvents.add(onEvent);
    this.cleanupFuncs.push(() => this.duck?.simEvents.delete(onEvent));
  }

  update(): void {
    if (this.input.keyboard.getKeyDown('KeyX')) void this.capture('manual');
    if (this.packAfterMs > 0 && this.duck?.sim?.ready && this.duck.hasPose) {
      const now = performance.now();
      if (!this.packWalkAt) {
        this.packWalkAt = now;
        this.nav?.runCourse();
      } else if (now - this.packWalkAt > this.packAfterMs) {
        this.packAfterMs = 0;
        void this.capture('manual');
      }
    }
    const nav = this.nav;
    if (nav?.stuck && !this.stuckPacked) {
      this.stuckPacked = true;
      void this.captureAuto('stuck');
    } else if (!nav?.stuck) {
      this.stuckPacked = false;
    }
  }

  private onSimEvent(event: SimEvent): void {
    const now = performance.now();
    this.events.push({ t: now, kind: event.kind, ...(event.move ? { move: event.move } : {}) });
    if (this.events.length > EVENT_KEEP) this.events.shift();
    if (event.kind === 'reset') {
      this.fallTimes.length = 0;
      return;
    }
    if (event.kind !== 'fall') return;
    this.fallTimes.push(now);
    while (this.fallTimes.length && now - this.fallTimes[0] > FALLS_WINDOW_MS) this.fallTimes.shift();
    if (this.fallTimes.length >= FALLS_NEEDED) {
      this.fallTimes.length = 0;
      void this.captureAuto('falls');
    }
  }

  /**
   * Falls and getting stuck save test cases by themselves. Development: off
   * when localStorage 'ducklab.autoPacks' is '0' (film takes, where only the
   * moment the script saves should show up).
   */
  autoCapture = !(import.meta.env.DEV && readAutoPacksOff());

  private captureAuto(reason: ScenarioReason): Promise<void> {
    if (!this.autoCapture) return Promise.resolve();
    const now = performance.now();
    if (now - this.lastAutoAt < MIN_GAP_MS) return Promise.resolve();
    this.lastAutoAt = now;
    return this.capture(reason);
  }

  /** Builds a pack from the sim and delivers it. */
  async capture(reason: ScenarioReason): Promise<void> {
    const duck = this.duck;
    const sim = duck?.sim;
    if (!duck || !sim?.ready || this.busy) return;
    this.busy = true;
    this.summary = `Scenario: packing (${reason})...`;
    try {
      const snapshot = await sim.snapshot();
      if (snapshot.steps.length === 0) {
        // The sim keeps a state every 10 s of normal walking: nothing to replay yet.
        this.summary = 'Scenario: nothing recorded yet';
        duck.status = 'Walk a bit first: there is nothing to save as a test case yet.';
        return;
      }
      const pack = this.buildPack(reason, snapshot);
      const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${reason}`;
      const where = await this.deliver(name, pack);
      this.packs++;
      const seconds = (snapshot.steps.length * CTRL_DT).toFixed(0);
      this.summary = `Scenario: ${reason}, ${snapshot.steps.length} steps (${seconds} s) -> ${where}`;
      console.info(`[scenario] ${this.summary}`);
      // Tell the player: this moment is now a test case for the desktop simulator.
      const why = reason === 'falls' ? 'Two falls' : reason === 'stuck' ? 'Stuck' : 'This moment';
      const to = where.startsWith('sent to ')
        ? `${where.slice(8).replace(/ \(.*$/, '')} has it`
        : /artifacts\/scenarios\//.test(where)
          ? 'The trainer on your computer has it'
          : where.startsWith('kept for ')
            ? 'It goes to your computer when the trainer is open'
            : 'Saved for training';
      duck.status = `${why}: saved as a ${seconds} s test case. ${to}.`;
    } catch (err) {
      this.summary = `Scenario: failed (${err instanceof Error ? err.message : String(err)})`;
      console.error('[scenario]', err);
    } finally {
      this.busy = false;
    }
  }

  private buildPack(reason: ScenarioReason, snapshot: SimSnapshot) {
    const duck = this.duck!;
    const sim = duck.sim!;
    const pack = duck.pack;
    const meshFiles = Array.from(snapshot.xml.matchAll(/<mesh[^>]*\sfile="([^"]+)"/g), (m) => m[1]);
    const playgroundId = this.playgrounds?.current ?? '';
    const playground = this.playgrounds?.list.find((p) => p.id === playgroundId);
    const session = this.world.session;
    return {
      version: 'duckdash.scenario.v1',
      at: new Date().toISOString(),
      reason,
      playground: playgroundId ? { id: playgroundId, title: playground?.title ?? playgroundId } : null,
      policy: {
        hash: duck.policyHash,
        folderUrl: new URL(duck.policyBaseUrl, document.baseURI).href,
        files: POLICY_FILES,
      },
      duck: pack
        ? {
            packId: pack.id,
            localFolder: pack.folder,
            mjcfFile: pack.mjcfFile,
            meshFolder: pack.collisionMeshFolder,
            meshUrl: new URL(`${import.meta.env.BASE_URL}${pack.folder}/${pack.collisionMeshFolder}/`, document.baseURI).href,
            meshFiles,
          }
        : null,
      room: {
        mixedReality: !!session && session.environmentBlendMode !== 'opaque',
        state: this.room?.state ?? 'idle',
        colliders: this.room?.physicsSummary ?? '',
        terrain: this.terrain?.summary ?? '',
      },
      /** Who was steering and towards what (stage frame): a trainer rebuilds the moment around it. */
      nav: this.nav?.testCaseInfo() ?? null,
      /** Where the course stood in the room (world: its origin on the floor, the way it runs), to replay it there. */
      stage: this.stagePlacement(),
      /**
       * What was in the way, in the stage's MuJoCo frame (x along the course, y left, z up; MuJoCo sizes):
       * the course pieces as the sim has them (walkable: a step to climb), and in mixed reality the scan
       * as a camera sees it (walls, and furniture as solid boxes). The trainer page builds the training
       * ground from these (tools/train/lib/ground.mjs).
       */
      obstacles: {
        course: sim.colliders.course.map(colliderJson),
        room: (duck.stageEntity?.object3D ? this.room?.sceneVolumes(duck.stageEntity.object3D) ?? [] : []).map(colliderJson),
      },
      /**
       * What the camera brain saw (while it drove): its last pictures, one a second, oldest first. A trainer
       * paints the rebuilt room in their colours (tools/train/lib/ground.mjs).
       */
      camera: this.cameraPictures(),
      device: navigator.userAgent,
      /** The control convention the replay must follow (mirrors duck-constants.ts). */
      control: {
        jointNames: JOINT_NAMES,
        defaultPose: DEFAULT_POSE,
        numJoints: NUM_JOINTS,
        obsSize: OBS_SIZE,
        cmdSize: CMD_SIZE,
        ctrlDt: CTRL_DT,
        decimation: DECIMATION,
        twistAlpha: 0.14,
        headAlpha: HEAD_ALPHA,
        velocity: { forward: VEL_FWD, back: VEL_BACK, turn: VEL_ANG },
        gyroSensor: 'imu_ang_vel',
        freeJoint: 'trunk_base_freejoint',
        standKeyframe: 'STAND',
      },
      mjcf: snapshot.xml,
      terrain: snapshot.hfield
        ? { nrow: TERRAIN_N, ncol: TERRAIN_N, encoding: 'base64-float32', data: base64Float32(snapshot.hfield) }
        : null,
      start: stateJson(snapshot.start),
      steps: snapshot.steps.map((s) => [Number(s.t.toFixed(3)), s.vx, s.wz, ...s.head.map((h) => Number(h.toFixed(4))), s.move ?? '']),
      stepColumns: ['t', 'vx', 'wz', 'neckPitch', 'headPitch', 'headYaw', 'headRoll', 'move'],
      end: { ...stateJson(snapshot.end), mode: snapshot.mode, falls: snapshot.falls },
      events: this.events.map((e) => ({ ...e, t: Number(((e.t - performance.now()) / 1000).toFixed(2)) })),
      source: sim.sourceMjcf ? { mjcfBytes: sim.sourceMjcf.length } : null,
    };
  }

  private stagePlacement(): { origin: number[]; right: number[] } | null {
    const stage = this.duck?.stageEntity?.object3D;
    if (!stage) return null;
    stage.updateWorldMatrix(true, false);
    const e = stage.matrixWorld.elements;
    const len = Math.hypot(e[0], e[1], e[2]) || 1;
    return { origin: numbers([e[12], e[13], e[14]]), right: numbers([e[0] / len, e[1] / len, e[2] / len]) };
  }

  private cameraPictures(): {
    width: number;
    height: number;
    encoding: string;
    frames: string[];
    palette: { floor: number[]; backdrop: number[] };
  } | null {
    if (this.nav?.driver !== 'camera') return null;
    const pictures = this.world.getSystem(DuckCamSystem)?.recentBrainPictures() ?? [];
    if (!pictures.length) return null;
    const rgb = (hex: number) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map((v) => +v.toFixed(3));
    return {
      width: NAV_CAMERA_WIDTH,
      height: NAV_CAMERA_HEIGHT,
      encoding: 'base64-rgb8 (row 0 the top)',
      frames: pictures.map((p) => base64Bytes(p)),
      // The room model's own colours in these pictures (sRGB 0..1): its floor and what shows behind everything.
      palette: { floor: rgb(VISION_FLOOR), backdrop: rgb(VISION_BACKDROP) },
    };
  }

  /**
   * The paired trainer over the link when it is up; in development, the dev
   * server's inbox; kept for the trainer when paired; otherwise downloaded
   * (browser) or kept in memory.
   */
  private async deliver(name: string, pack: object): Promise<string> {
    const json = JSON.stringify(pack);
    const link = this.world.getSystem(LabLinkSystem);
    if (link?.connected) {
      try {
        return await link.sendPack(name, json);
      } catch {
        // the link dropped while sending: the other ways below
      }
    }
    if (import.meta.env.DEV) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}${INBOX_PATH}?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
        });
        if (res.ok) {
          const info = (await res.json()) as { file?: string };
          return info.file ?? 'dev server inbox';
        }
      } catch {
        // no inbox (production build served elsewhere): fall through
      }
    }
    if (link?.paired) return link.sendPack(name, json);
    (globalThis as { __duckLastScenario?: string }).__duckLastScenario = json;
    if (this.world.session) {
      return 'kept in memory (window.__duckLastScenario)';
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.scenario.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return `download ${a.download}`;
  }
}

function readAutoPacksOff(): boolean {
  try {
    return localStorage.getItem('ducklab.autoPacks') === '0';
  } catch {
    return false;
  }
}
