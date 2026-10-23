// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Splats a triangle mesh (the room scan's global mesh) onto the terrain's
 * height map. Every triangle is sampled at half a cell, so a surface fills
 * the cells under it; reading only the vertices would leave a thin spike at
 * each corner that the duck could walk between. Pure math, no three.js.
 */
import { TERRAIN_CELL, TERRAIN_HEIGHT_CAP, TERRAIN_MIN_HEIGHT, TERRAIN_N, terrainCol, terrainRow } from '../duck/terrain-spec.js';

const STEP = TERRAIN_CELL / 2;
const MAX_STEPS = 400; // 8 m at 2 cm: the whole field

/**
 * `positions`: x y z per vertex in the mesh's frame. `index`: three vertex
 * numbers per triangle (null: every three vertices make one). `toStage`: the
 * mesh frame to the stage frame (three.js axes, y up), column-major. Each
 * cell keeps the highest sample between TERRAIN_MIN_HEIGHT and
 * TERRAIN_HEIGHT_CAP. Returns how many cells went from flat or unseen to raised.
 */
export function rasteriseMeshHeights(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  toStage: ArrayLike<number>,
  heights: Float32Array,
): number {
  const m = toStage;
  const p = new Float64Array(9); // the triangle's corners in the stage frame
  const vertices = Math.floor(positions.length / 3);
  const count = index ? index.length - (index.length % 3) : vertices - (vertices % 3);
  let raised = 0;
  for (let t = 0; t < count; t += 3) {
    let low = Infinity;
    let high = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = (index ? index[t + k] : t + k) * 3;
      const x = positions[v];
      const y = positions[v + 1];
      const z = positions[v + 2];
      const sy = m[1] * x + m[5] * y + m[9] * z + m[13];
      p[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      p[k * 3 + 1] = sy;
      p[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (sy < low) low = sy;
      if (sy > high) high = sy;
    }
    // The floor, the ceiling and high shelves add nothing.
    if (high < TERRAIN_MIN_HEIGHT || low > TERRAIN_HEIGHT_CAP) continue;
    const edge = Math.max(
      Math.hypot(p[3] - p[0], p[4] - p[1], p[5] - p[2]),
      Math.hypot(p[6] - p[3], p[7] - p[4], p[8] - p[5]),
      Math.hypot(p[0] - p[6], p[1] - p[7], p[2] - p[8]),
    );
    const n = Math.min(MAX_STEPS, Math.max(1, Math.ceil(edge / STEP)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n;
        const w = j / n;
        const r = 1 - u - w;
        const y = r * p[1] + u * p[4] + w * p[7];
        if (y < TERRAIN_MIN_HEIGHT || y > TERRAIN_HEIGHT_CAP) continue;
        const col = terrainCol(r * p[0] + u * p[3] + w * p[6]);
        const row = terrainRow(-(r * p[2] + u * p[5] + w * p[8]));
        if (col < 0 || row < 0) continue;
        const cell = row * TERRAIN_N + col;
        if (heights[cell] < y) {
          if (heights[cell] < TERRAIN_MIN_HEIGHT) raised++;
          heights[cell] = y;
        }
      }
    }
  }
  return raised;
}
