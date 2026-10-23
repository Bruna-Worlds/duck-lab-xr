// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How a course piece tells the physics what it is solid as. Scene-asset
 * prototypes put an array of these in `userData.colliders`, in the piece's
 * own frame (three.js, Y up, metres). The duck system turns them into static
 * MuJoCo geoms when the course loads, so the duck and the ball bump into
 * exactly what the player sees.
 *
 * Pure data: no three.js, DOM or World imports (scene assets import it).
 */
export interface ColliderSpec {
  type: 'box' | 'cylinder' | 'sphere';
  /** Box half extents along the piece's local x, y, z. */
  half?: [number, number, number];
  /** Cylinder (axis along local y) and sphere radius. */
  radius?: number;
  /** Cylinder half height along local y. */
  halfHeight?: number;
  /** Centre in the piece's frame. */
  pos?: [number, number, number];
  /** Orientation in the piece's frame, x y z w. */
  quat?: [number, number, number, number];
  /** Sliding friction; MuJoCo's default is 1. */
  friction?: number;
}

export const COLLIDERS_KEY = 'colliders';
