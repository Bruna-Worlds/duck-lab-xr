// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The navigation brain's inputs, exactly as it was trained
 * (tools/train/python/ducknav/nav_env.py): ten times a second it sees the head
 * sensor's last three frames, where the goal is, what it asked for last and
 * what the walker is following, and answers with a twist (forward m/s, turn
 * rad/s) that the sim smooths like the stick for the walking policy.
 *
 * Inputs (200): 3 frames of 64 zones, newest first, distance / 4 m (nothing in
 * range = 1); goal distance / 4 m (at most 1), sin and cos of its bearing off
 * the heading (left positive); the brain's last raw output (-1..1, two); the
 * smoothed twist (forward m/s, turn rad/s); the gyro's yaw rate.
 */
import { TOF_RANGE, TOF_ZONES } from './tof.js';

export const NAV_FRAMES = 3;
/** Walking-policy control steps per brain step (50 Hz to 10 Hz). */
export const NAV_EVERY = 5;
export const NAV_VX_FORWARD = 0.25;
export const NAV_VX_BACK = 0.1;
export const NAV_WZ_MAX = 1;
const ZONES = TOF_ZONES * TOF_ZONES;
export const NAV_OBS = NAV_FRAMES * ZONES + 3 + 2 + 2 + 1;

export class NavBrainInput {
  readonly obs = new Float32Array(NAV_OBS);
  private readonly frames = new Float32Array(NAV_FRAMES * ZONES);
  private filled = false;
  private readonly raw = new Float32Array(2);

  reset(): void {
    this.filled = false;
    this.raw.fill(0);
  }

  /** A new sensor frame (metres, nothing in range = TOF_RANGE). */
  push(zones: Float32Array): void {
    const f = this.frames;
    if (!this.filled) {
      for (let k = 0; k < NAV_FRAMES; k++) for (let i = 0; i < ZONES; i++) f[k * ZONES + i] = zones[i] / TOF_RANGE;
      this.filled = true;
      return;
    }
    f.copyWithin(ZONES, 0, (NAV_FRAMES - 1) * ZONES);
    for (let i = 0; i < ZONES; i++) f[i] = zones[i] / TOF_RANGE;
  }

  /** The brain's next input; `bearing` in radians off the heading, left positive. */
  build(goalDistance: number, bearing: number, twistForward: number, twistTurn: number, yawRate: number): Float32Array {
    const o = this.obs;
    o.set(this.frames, 0);
    let i = this.frames.length;
    o[i++] = Math.min(1, goalDistance / TOF_RANGE);
    o[i++] = Math.sin(bearing);
    o[i++] = Math.cos(bearing);
    o[i++] = this.raw[0];
    o[i++] = this.raw[1];
    o[i++] = twistForward;
    o[i++] = twistTurn;
    o[i] = yawRate;
    return o;
  }

  /** Remembers the brain's answer as the raw action it trained with (its output, unscaled). */
  answered(forward: number, turn: number): void {
    this.raw[0] = Math.max(-1, Math.min(1, forward >= 0 ? forward / NAV_VX_FORWARD : forward / NAV_VX_BACK));
    this.raw[1] = Math.max(-1, Math.min(1, turn / NAV_WZ_MAX));
  }
}
