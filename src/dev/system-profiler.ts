// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dev-only frame profiler. Wraps every registered system's update() and the
 * world update, keeps per-system averages and maxima over a window, and
 * formats the heaviest systems for the lab panel. Installed from index.ts
 * only when the page is opened with ?lab.
 */
import type { World } from '@iwsdk/core';

interface Sample {
  total: number;
  count: number;
  max: number;
}

export class SystemProfiler {
  private samples = new Map<string, Sample>();
  private frame: Sample = { total: 0, count: 0, max: 0 };

  constructor(private readonly world: World) {}

  install(): void {
    for (const system of this.world.getSystems()) {
      const name = system.constructor.name;
      if (this.samples.has(name)) {
        continue;
      }
      const sample: Sample = { total: 0, count: 0, max: 0 };
      this.samples.set(name, sample);
      const original = system.update.bind(system);
      system.update = (delta: number, time: number) => {
        const start = performance.now();
        original(delta, time);
        record(sample, performance.now() - start);
      };
    }
    const world = this.world as World & { update: (delta: number, time: number) => void };
    const originalUpdate = world.update.bind(world);
    world.update = (delta: number, time: number) => {
      const start = performance.now();
      originalUpdate(delta, time);
      record(this.frame, performance.now() - start);
    };
  }

  /** The heaviest systems over the window, average and max ms; resets the window. */
  report(top = 5): string {
    const frame = this.frame;
    const frameAvg = frame.count ? frame.total / frame.count : 0;
    const rows = [...this.samples.entries()]
      .filter(([, s]) => s.count > 0)
      .map(([name, s]) => ({ name: name.replace(/System$/, ''), avg: s.total / s.count, max: s.max }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, top)
      .map((r) => `${r.name} ${r.avg.toFixed(2)}/${r.max.toFixed(1)}`);
    const text = `ECS ${frameAvg.toFixed(2)} ms (max ${frame.max.toFixed(1)}): ${rows.join(', ')}`;
    for (const s of this.samples.values()) {
      s.total = s.count = s.max = 0;
    }
    frame.total = frame.count = frame.max = 0;
    return text;
  }
}

function record(sample: Sample, ms: number): void {
  sample.total += ms;
  sample.count++;
  if (ms > sample.max) sample.max = ms;
}
