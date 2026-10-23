// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Keyframe motions: the authoring format behind new "superpowers". A motion
 * is a few poses (joint target offsets from the standing pose, radians, by
 * joint name) at times, eased between; the sim plays it open loop through
 * the servos' position control, and the training export records what the
 * policy would have to produce to do the same. No DOM here.
 */
import { CTRL_DT, JOINT_NAMES, NUM_JOINTS } from '../duck/duck-constants.js';

export interface MotionKeyframe {
  /** Seconds from the start. */
  t: number;
  /** Joint target offsets (radians) by joint name; missing joints hold the standing pose. */
  pose: Partial<Record<(typeof JOINT_NAMES)[number], number>>;
}

export interface Motion {
  version: 'duckdash.motion.v1';
  name: string;
  /** What the HUD calls it. */
  title: string;
  keyframes: MotionKeyframe[];
  loop?: boolean;
  /** What counts as success in the training export (for now: standing at the end). */
  success?: 'upright-at-end';
}

/** Cosine ease between two keyframe poses. */
const ease = (u: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));

/** The motion as N x NUM_JOINTS offsets, one row per control step. */
export function motionFrames(motion: Motion): Float32Array {
  const keys = [...motion.keyframes].sort((a, b) => a.t - b.t);
  if (keys.length === 0) return new Float32Array(0);
  const duration = keys[keys.length - 1].t;
  const steps = Math.max(1, Math.round(duration / CTRL_DT) + 1);
  const frames = new Float32Array(steps * NUM_JOINTS);
  const poseAt = (key: MotionKeyframe, j: number): number => key.pose[JOINT_NAMES[j]] ?? 0;
  for (let i = 0; i < steps; i++) {
    const t = i * CTRL_DT;
    let k = 0;
    while (k < keys.length - 1 && keys[k + 1].t <= t) k++;
    const a = keys[k];
    const b = keys[Math.min(k + 1, keys.length - 1)];
    const span = b.t - a.t;
    const u = span > 0 ? ease((t - a.t) / span) : 1;
    for (let j = 0; j < NUM_JOINTS; j++) {
      frames[i * NUM_JOINTS + j] = poseAt(a, j) + (poseAt(b, j) - poseAt(a, j)) * u;
    }
  }
  return frames;
}

export function isMotion(value: unknown): value is Motion {
  const m = value as Motion;
  return !!m && m.version === 'duckdash.motion.v1' && typeof m.name === 'string' && Array.isArray(m.keyframes);
}
