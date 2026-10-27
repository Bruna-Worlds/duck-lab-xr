// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Microduck's head distance sensor, a VL53L5CX: 8 x 8 zones over a
 * 45-degree square field of view, out to 4 m, at the robot model's `tof` site
 * (+x forward, +y left, +z up). Zone centres are equal angles apart, row 0 the
 * top of the frame and column 0 the sensor's left, as Pollen's simulated
 * sensor (microduck_rl sim/tof.py) and the real one's buffer have them.
 * Shared by the sim worker (which casts the rays) and the robot panel (which
 * draws the frame).
 */
export const TOF_ZONES = 8;
export const TOF_FOV_DEG = 45;
export const TOF_RANGE = 4;

/** Zone directions in the sensor frame, 3 numbers a zone, row by row. */
export function tofDirections(): Float64Array {
  const out = new Float64Array(TOF_ZONES * TOF_ZONES * 3);
  const half = ((TOF_FOV_DEG / 2) * Math.PI) / 180;
  const centre = (i: number) => -half + ((i + 0.5) * 2 * half) / TOF_ZONES;
  for (let row = 0; row < TOF_ZONES; row++) {
    const elevation = -centre(row);
    for (let col = 0; col < TOF_ZONES; col++) {
      const azimuth = -centre(col);
      const o = (row * TOF_ZONES + col) * 3;
      out[o] = Math.cos(elevation) * Math.cos(azimuth);
      out[o + 1] = Math.cos(elevation) * Math.sin(azimuth);
      out[o + 2] = Math.sin(elevation);
    }
  }
  return out;
}

/** Range noise of the real sensor (millimetres up close, about 2 cm at 4 m), standard deviation in metres. */
export const tofNoise = (metres: number): number => 0.003 + (0.02 * metres) / TOF_RANGE;
