// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Heights above the stage floor (metres) for the flat things that lie on it,
 * kept at least 2 mm apart. Closer than that, the depth buffer can't tell
 * which is on top from across the room (the headset's near plane is 1 mm),
 * and the two flicker through each other: z-fighting.
 */
export const FLOOR_LAYERS = {
  /** The toy room's rug under the course (VR and the 2D page). */
  rug: 0.004,
  /** The tops of the start and finish pads. */
  pad: 0.008,
  /** A crumb's glow ring; its soft halo lies 2 mm lower. */
  glow: 0.01,
  /** The soft contact shadow under Pip. */
  shadow: 0.012,
  /** The rings that show where the ball must be for a kick. */
  guide: 0.014,
} as const;
