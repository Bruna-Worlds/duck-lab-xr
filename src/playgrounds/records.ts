// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Local run records: the per-playground leaderboard kept in the browser.
 * A record names the policy pack and the hash of the walking policy that
 * drove the duck, so entries made with different models stay comparable.
 */
const KEY = 'duckdash.records.v1';
const MAX_PER_PLAYGROUND = 20;

export interface RunRecord {
  playground: string;
  score: number;
  /** Seconds. */
  time: number;
  stars: number;
  falls: number;
  pack: string;
  policyHash: string;
  /** ISO date. */
  at: string;
}

function readAll(): RunRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RunRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: RunRecord[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // storage unavailable: records stay in memory for this page
  }
}

/** Higher score first, then faster time. */
export function better(a: RunRecord, b: RunRecord): number {
  return b.score - a.score || a.time - b.time;
}

export function recordRun(record: RunRecord): RunRecord[] {
  const all = readAll();
  all.push(record);
  const mine = all.filter((r) => r.playground === record.playground).sort(better).slice(0, MAX_PER_PLAYGROUND);
  const others = all.filter((r) => r.playground !== record.playground);
  writeAll([...others, ...mine]);
  return mine;
}

export function bestRun(playground: string): RunRecord | null {
  return readAll().filter((r) => r.playground === playground).sort(better)[0] ?? null;
}

export function runsFor(playground: string): RunRecord[] {
  return readAll().filter((r) => r.playground === playground).sort(better);
}

export function exportRecords(): string {
  return JSON.stringify(readAll(), null, 2);
}
