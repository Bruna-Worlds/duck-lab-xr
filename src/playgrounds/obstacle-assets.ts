// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Scanned and downloaded models used as course obstacles. They carry no
 * hand-made colliders, so the physics derives one from each placed model's
 * bounds: a box, or legs (four posts at the corners, for a table the duck
 * walks under). Pure data; the course physics and the scene generator read it.
 */
import type { ColliderSpec } from '../course/collider-spec.js';

export interface ObstacleShape {
  kind: 'box' | 'legs';
  /** Scale on the bounds, so the duck brushes the visible edge, not air. */
  shrink?: number;
  /** Leg radius for 'legs'. */
  legRadius?: number;
}

export const OBSTACLE_ASSETS: Readonly<Record<string, ObstacleShape>> = {
  'scan-boat-shoe-tan': { kind: 'box', shrink: 0.85 },
  'scan-ugg-boot': { kind: 'box', shrink: 0.85 },
  'scan-timberland-shoe': { kind: 'box', shrink: 0.85 },
  'scan-spinosaurus': { kind: 'box', shrink: 0.6 },
  'scan-cereal-box': { kind: 'box', shrink: 0.95 },
  'scan-blocks-wagon': { kind: 'box', shrink: 0.9 },
  'scan-mug-blue': { kind: 'box', shrink: 0.9 },
  'scan-triceratops': { kind: 'box', shrink: 0.6 },
  'ph-picnic-table': { kind: 'legs', legRadius: 0.05 },
  'ph-planter-box': { kind: 'box', shrink: 0.95 },
  'ph-potted-plant': { kind: 'box', shrink: 0.7 },
  'ph-garden-gnome': { kind: 'box', shrink: 0.7 },
  'ph-watering-can': { kind: 'box', shrink: 0.8 },
  'ph-wooden-crate': { kind: 'box', shrink: 0.95 },
  'ph-rubber-duck': { kind: 'box', shrink: 0.8 },
  'ph-stone-01': { kind: 'box', shrink: 0.8 },
  'ph-rock-07': { kind: 'box', shrink: 0.8 },
  'ph-bucket': { kind: 'box', shrink: 0.9 },
  'ph-football': { kind: 'box', shrink: 0.9 },
  'ph-bench': { kind: 'legs', legRadius: 0.04 }, // the duck walks under the seat
  'ph-shrub-02': { kind: 'box', shrink: 0.6 }, // the solid middle, not the outer leaves
};

/**
 * Big set pieces, where a box from the bounds would fill the whole play area:
 * hand-placed colliders in the model's own frame.
 */
export const SET_COLLIDERS: Readonly<Record<string, readonly ColliderSpec[]>> = {
  // The backyard's fence: a 12.2 m square, 1.1 m tall, round the lawn.
  'backyard-set': [
    { type: 'box', half: [6.15, 0.55, 0.05], pos: [0, 0.55, -6.1] },
    { type: 'box', half: [6.15, 0.55, 0.05], pos: [0, 0.55, 6.1] },
    { type: 'box', half: [0.05, 0.55, 6.15], pos: [-6.1, 0.55, 0] },
    { type: 'box', half: [0.05, 0.55, 6.15], pos: [6.1, 0.55, 0] },
  ],
};
