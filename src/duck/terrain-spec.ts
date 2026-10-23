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
export const TERRAIN_HALF = 4; // metres from the centre to the edge
export const TERRAIN_CELL = (2 * TERRAIN_HALF) / (TERRAIN_N - 1); // 0.04 m
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
export const TERRAIN_HFIELD = 'live-terrain';
export const TERRAIN_GEOM = 'terrain';

/** Column for a stage-frame MuJoCo x, or -1 when outside the field. */
export function terrainCol(x: number): number {
  const c = Math.round((x - TERRAIN_CENTER_X + TERRAIN_HALF) / TERRAIN_CELL);
  return c >= 0 && c < TERRAIN_N ? c : -1;
}

/** Row for a stage-frame MuJoCo y (= -z in three.js), or -1 when outside. */
export function terrainRow(y: number): number {
  const r = Math.round((y - TERRAIN_CENTER_Y + TERRAIN_HALF) / TERRAIN_CELL);
  return r >= 0 && r < TERRAIN_N ? r : -1;
}

export const terrainX = (col: number): number => TERRAIN_CENTER_X - TERRAIN_HALF + col * TERRAIN_CELL;
export const terrainY = (row: number): number => TERRAIN_CENTER_Y - TERRAIN_HALF + row * TERRAIN_CELL;

/** Height in metres -> normalised hfield elevation. */
export function terrainElevation(height: number): number {
  if (height < TERRAIN_MIN_HEIGHT) return 0;
  return Math.min(1, (height + TERRAIN_SINK) / TERRAIN_ZMAX);
}
