// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The live terrain: a MuJoCo height field under the whole play area that the
 * depth sensor (and the room scan) fill in at runtime, so real things on the
 * floor are solid to the duck. Shared by the main thread (which fills it)
 * and the sim worker (which applies it). No DOM or three.js here.
 *
 * MuJoCo layout (verified against the WASM build): data[row * N + col],
 * column 0 at x = centre - HALF, row 0 at y = centre - HALF, in the stage's
 * MuJoCo frame (Z up). Elevation 0..1 maps to 0..ZMAX metres.
 */
export const TERRAIN_N = 201; // cells per side (odd: a cell sits on the centre)
/**
 * Metres from the centre to the edge as compiled: the largest the field gets.
 * At runtime the field can shrink (same 201 x 201 cells, so finer ones):
 * MuJoCo reads an hfield's size at every collision, and bounds computed for
 * the compiled size still enclose a smaller field. Both threads keep their
 * own copy of the scale; the terrain system sets it and tells the sim.
 */
export const TERRAIN_HALF_MAX = 4;
let half = TERRAIN_HALF_MAX;
let cell = (2 * half) / (TERRAIN_N - 1); // 0.04 m at the compiled size
/** Metres from the centre to the edge, as in use. */
export const terrainHalf = (): number => half;
/** Metres per cell, as in use: 4 cm at +-4 m, 3 cm at +-3 m. */
export const terrainCell = (): number => cell;
/** Rescales the field (TERRAIN_HALF_MAX at most); every cell keeps its index. */
export function setTerrainHalf(value: number): void {
  half = Math.min(TERRAIN_HALF_MAX, Math.max(0.5, value));
  cell = (2 * half) / (TERRAIN_N - 1);
}
export const TERRAIN_ZMAX = 0.6; // tallest thing the field can hold
export const TERRAIN_BASE = 0.05; // MuJoCo's solid base below the field
/** Field centre in the stage frame: the middle of a default course. */
export const TERRAIN_CENTER_X = 1.2;
export const TERRAIN_CENTER_Y = 0;
/**
 * The field sits this far below the floor so flat cells never touch the
 * duck's feet (the floor plane carries it); raised cells are lifted by the
 * same amount so their tops are at the true height.
 */
export const TERRAIN_SINK = 0.01;
/** Anything lower than this is floor noise. */
export const TERRAIN_MIN_HEIGHT = 0.025;
/** Depth points above this are not floor-level objects (walls, hands up high). */
export const TERRAIN_HEIGHT_CAP = 0.55;
/**
 * The live depth layer (whatever the depth sensor and the scan's global mesh
 * found): the hfield desktop tools know, and in scenario packs the whole
 * terrain. It can be made soft (TERRAIN_SOFT) for plush things.
 */
export const TERRAIN_HFIELD = 'live-terrain';
export const TERRAIN_GEOM = 'terrain';
/** The room scan's colliders (walls, furniture, legs), splatted: always hard. */
export const SCAN_HFIELD = 'scan-terrain';
export const SCAN_GEOM = 'scan-terrain';
/**
 * Contact for the soft depth layer (what only the depth sensor knows: a dog
 * bed, a cushion): the softest setting the shipped walking brain stays up on.
 * Measured in the emulator (tools/test/depth-level-check.mjs; 2026-10-23): the
 * duck sinks about 2.5 mm standing and 6-7 mm while stepping. Anything that
 * sinks it a centimetre (0.08 s or softer impedance) makes it fall, standing
 * or walking: the brain was trained on rigid floors. A plush-real softness
 * needs a brain trained on soft ground.
 */
export const TERRAIN_SOFT = { solref: [0.05, 1], solimp: [0.7, 0.9, 0.02, 0.5, 2] } as const;

/** Column for a stage-frame MuJoCo x, or -1 when outside the field. */
export function terrainCol(x: number): number {
  const c = Math.round((x - TERRAIN_CENTER_X + half) / cell);
  return c >= 0 && c < TERRAIN_N ? c : -1;
}

/** Row for a stage-frame MuJoCo y (= -z in three.js), or -1 when outside. */
export function terrainRow(y: number): number {
  const r = Math.round((y - TERRAIN_CENTER_Y + half) / cell);
  return r >= 0 && r < TERRAIN_N ? r : -1;
}

export const terrainX = (col: number): number => TERRAIN_CENTER_X - half + col * cell;
export const terrainY = (row: number): number => TERRAIN_CENTER_Y - half + row * cell;

/** Height in metres -> normalised hfield elevation. */
export function terrainElevation(height: number): number {
  if (height < TERRAIN_MIN_HEIGHT) return 0;
  return Math.min(1, (height + TERRAIN_SINK) / TERRAIN_ZMAX);
}
