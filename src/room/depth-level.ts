// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How much the headset's live depth shapes the duck's terrain (menu: ROOM
 * DEPTH; docs/microduck/DEPTH.md). The room scan's walls and furniture are
 * solid at every level.
 *  - off: the depth sensor is not used (the scan, and its room mesh, only);
 *  - raw: the first version: every depth point, the highest per 4 cm cell;
 *  - filtered: phase 1: smeared edges and noise filtered out, 4 cm cells;
 *  - fine: phase 2: filtered, 3 cm cells (over +-3 m instead of +-4 m), and
 *    what only the depth sensor knows (a dog bed, a cushion) is soft.
 * The choice is remembered in this browser.
 */
export type DepthLevel = 'off' | 'raw' | 'filtered' | 'fine';
export const DEPTH_LEVELS: readonly DepthLevel[] = ['off', 'raw', 'filtered', 'fine'];

export interface DepthLevelSpec {
  /** Menu chip text. */
  label: string;
  /** Live depth feeds the terrain. */
  live: boolean;
  /** The phase 1 filters (else the original rule and readback). */
  filtered: boolean;
  /** Metres from the terrain's centre to its edge: 4 gives 4 cm cells, 3 gives 3 cm. */
  half: number;
  /** The depth layer is soft. */
  soft: boolean;
}

export const DEPTH_LEVEL_SPEC: Record<DepthLevel, DepthLevelSpec> = {
  off: { label: 'Off', live: false, filtered: true, half: 4, soft: false },
  raw: { label: 'Raw', live: true, filtered: false, half: 4, soft: false },
  filtered: { label: 'Filtered', live: true, filtered: true, half: 4, soft: false },
  fine: { label: 'Fine', live: true, filtered: true, half: 3, soft: true },
};

export const DEFAULT_DEPTH_LEVEL: DepthLevel = 'filtered';
const STORAGE_KEY = 'ducklab.depthLevel';

/** The level this browser last chose (the default when none, or storage is blocked). */
export function loadDepthLevel(): DepthLevel {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as DepthLevel | null;
    if (stored && DEPTH_LEVELS.includes(stored)) return stored;
  } catch {
    // Storage blocked: the default it is.
  }
  return DEFAULT_DEPTH_LEVEL;
}

export function saveDepthLevel(level: DepthLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
}
