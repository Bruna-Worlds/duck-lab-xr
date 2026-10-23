// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The desktop menu's folded state on the 2D page (its minimize button, or M;
 * the scoreboard's MENU chip brings it back), kept for the next visit.
 */
const MINIMIZED_KEY = 'ducklab.menuMinimized';

export function readMenuMinimized(): boolean {
  try {
    return localStorage.getItem(MINIMIZED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeMenuMinimized(minimized: boolean): void {
  try {
    if (minimized) localStorage.setItem(MINIMIZED_KEY, '1');
    else localStorage.removeItem(MINIMIZED_KEY);
  } catch {
    // storage blocked: this visit only
  }
}
