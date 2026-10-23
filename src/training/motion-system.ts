// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Motion superpowers and their training sets. A motion is a keyframe file
 * under public/motions/ (see motion.ts); the sim plays it open loop as a
 * move (the HUD's BOW chip, N; M for the wiggle). "Export" plays a motion
 * from hundreds of randomized standing starts on a copy of the sim and
 * records every step's observation and action: a behaviour-cloning set in
 * the policy's own convention, posted to the dev server (artifacts/
 * datasets/) or downloaded. tools/train/README.md says how to train on it.
 */
import { createSystem } from '@iwsdk/core';
import {
  CMD_SIZE,
  CTRL_DT,
  DECIMATION,
  DEFAULT_POSE,
  JOINT_NAMES,
  NUM_JOINTS,
  OBS_SIZE,
} from '../duck/duck-constants.js';
import { DuckSystem } from '../duck/duck-system.js';
import { base64Float32 } from './encode.js';
import { isMotion, type Motion, motionFrames } from './motion.js';

const MOTIONS = ['bow', 'wiggle'];
const INBOX_PATH = '__duck/datasets';
const DEFAULT_EPISODES = 200;

export class MotionSystem extends createSystem({}) {
  readonly motions = new Map<string, { motion: Motion; frames: Float32Array }>();
  status = 'Motions: loading...';
  exporting = false;
  private duck: DuckSystem | undefined;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    if (this.duck) this.duck.playMotionHook = (name) => this.playMotion(name);
    void Promise.all(
      MOTIONS.map(async (name) => {
        const res = await fetch(`${import.meta.env.BASE_URL}motions/${name}.json`);
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        const motion = (await res.json()) as unknown;
        if (!isMotion(motion)) throw new Error(`${name}: not a motion file`);
        this.motions.set(name, { motion, frames: motionFrames(motion) });
      }),
    )
      .then(() => {
        if (this.duck) this.duck.motionReady = true;
        this.status = `Motions: ${[...this.motions.keys()].join(', ')} (N bow, M wiggle, U export bow)`;
      })
      .catch((err: unknown) => {
        this.status = `Motions: ${err instanceof Error ? err.message : String(err)}`;
        console.error('[motion]', err);
      });
  }

  /** Plays a motion as a move; false when the sim or the file is not ready. */
  playMotion(name: string): boolean {
    const sim = this.duck?.sim;
    const entry = this.motions.get(name);
    if (!sim?.ready || !entry) return false;
    sim.playMotion(entry.frames, entry.motion.loop ?? false);
    return true;
  }

  update(): void {
    const keys = this.input.keyboard;
    if (keys.getKeyDown('KeyM')) this.playMotion('wiggle');
    if (keys.getKeyDown('KeyU')) void this.exportDataset('bow');
  }

  /** Builds and delivers a training set for a motion. */
  async exportDataset(name: string, episodes = DEFAULT_EPISODES): Promise<string | null> {
    const sim = this.duck?.sim;
    const entry = this.motions.get(name);
    if (!sim?.ready || !entry || this.exporting) return null;
    this.exporting = true;
    this.status = `Exporting ${name}: ${episodes} episodes...`;
    try {
      const result = await sim.exportMotion(entry.frames, episodes);
      let successes = 0;
      for (const s of result.successes) successes += s;
      const steps = result.obs.length / OBS_SIZE;
      const pack = {
        version: 'duckdash.dataset.v1',
        at: new Date().toISOString(),
        motion: entry.motion,
        control: {
          jointNames: JOINT_NAMES,
          defaultPose: DEFAULT_POSE,
          numJoints: NUM_JOINTS,
          obsSize: OBS_SIZE,
          cmdSize: CMD_SIZE,
          ctrlDt: CTRL_DT,
          decimation: DECIMATION,
          obsLayout: 'gyro 3, projected gravity 3, joint positions minus standing 14, joint velocities 14, last action 14, command 13 (zeros)',
          actLayout: 'joint target offsets from the standing pose, 14',
        },
        episodes,
        successes,
        steps,
        episodeLengths: Array.from(result.episodeLengths),
        successFlags: Array.from(result.successes),
        encoding: 'base64-float32, row-major',
        obs: base64Float32(result.obs),
        act: base64Float32(result.act),
        simWallMs: Math.round(result.wallMs),
      };
      const where = await this.deliver(name, pack);
      this.status = `Exported ${name}: ${steps} steps, ${successes}/${episodes} stood at the end, ${(result.wallMs / 1000).toFixed(1)} s -> ${where}`;
      console.info(`[motion] ${this.status}`);
      return where;
    } catch (err) {
      this.status = `Export failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error('[motion]', err);
      return null;
    } finally {
      this.exporting = false;
    }
  }

  private async deliver(name: string, pack: object): Promise<string> {
    const json = JSON.stringify(pack);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (import.meta.env.DEV) {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}${INBOX_PATH}?name=${encodeURIComponent(`${stamp}-${name}`)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
        });
        if (res.ok) {
          const info = (await res.json()) as { file?: string };
          return info.file ?? 'dev server inbox';
        }
      } catch {
        // no inbox: fall through
      }
    }
    if (this.world.session) {
      (globalThis as { __duckLastDataset?: string }).__duckLastDataset = json;
      return 'kept in memory (window.__duckLastDataset)';
    }
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stamp}-${name}.dataset.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return `download ${a.download}`;
  }
}
