// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Folded panels on the 2D page, kept for the next visit: the desktop menu
 * (its minimize button, or M; the scoreboard's MENU chip brings it back) and
 * the scoreboard (its minimize button; the chevron unfolds it).
 */
const MINIMIZED_KEY = 'ducklab.menuMinimized';
const SCORE_MINIMIZED_KEY = 'ducklab.scoreMinimized';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // storage blocked: this visit only
  }
}

export const readMenuMinimized = (): boolean => readFlag(MINIMIZED_KEY);
export const writeMenuMinimized = (minimized: boolean): void => writeFlag(MINIMIZED_KEY, minimized);
export const readScoreMinimized = (): boolean => readFlag(SCORE_MINIMIZED_KEY);
export const writeScoreMinimized = (minimized: boolean): void => writeFlag(SCORE_MINIMIZED_KEY, minimized);

/**
 * Headset: how far the open menu reaches out from the scoreboard's right edge
 * (metres, its gap included), 0 while it is closed. Pip cam, docked on the
 * same side, stands beyond it (robot-panel-system.ts) so the two never cover
 * each other. Written by RunPanelSystem every frame, before Pip cam's system reads it.
 */
export const headsetMenu = { span: 0 };
