// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Playgrounds: which course is loaded, switching between them, and the local
 * run records. A playground is a scene file under public/playgrounds/ whose
 * root carries the Playground component; the index lists the built-in ones.
 * Switching loads the file as the world's level: the course, the duck and
 * the HUD come back under the new level root while the sim worker restarts.
 * `?playground=<id>` in the address opens one directly.
 */
import { createSystem, type Entity } from '@iwsdk/core';
import { CoursePiece } from '../course/course-components.js';
import { CourseSystem } from '../course/course-system.js';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';
import { type CustomPlayground, decodeShare, loadCustoms, saveCustom, SHARE_PARAM } from './custom.js';
import { Playground } from './playground-components.js';
import { bestRun, recordRun, type RunRecord } from './records.js';
import { spawnPiece } from './spawn-pieces.js';

const START_PAD = 'course-start-pad';

export interface PlaygroundInfo {
  id: string;
  title: string;
  mode: 'mr' | 'vr' | 'both';
  par: number;
  /** One line for the HUD while the run is not started. */
  blurb: string;
  /** Asset credit the HUD shows for this playground, if any. */
  credits?: string;
}

export class PlaygroundSystem extends createSystem({
  playgrounds: { required: [Playground] },
  stages: { required: [DuckStage] },
  pieces: { required: [CoursePiece] },
}) {
  /** The built-in playgrounds, from public/playgrounds/index.json. */
  list: PlaygroundInfo[] = [];
  /** Player-made playgrounds from this browser's storage (and opened links). */
  customs: CustomPlayground[] = [];
  private pendingCustom: CustomPlayground | null = null;
  /** Id of the loaded playground ('' until a level with the component is up). */
  current = '';
  /** Id of the playground being loaded, or ''. */
  loading = '';
  error = '';
  /** The record just set by the last finished run, if it is a new best. */
  newBest: RunRecord | null = null;
  private duck: DuckSystem | undefined;
  private course: CourseSystem | undefined;
  private lastState = '';
  private requested = '';

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.course = this.world.getSystem(CourseSystem);
    const params = new URLSearchParams(location.search);
    this.requested = params.get('playground') ?? '';
    this.customs = loadCustoms();
    const shared = params.get(SHARE_PARAM);
    if (shared) {
      // A playground link: keep it and open it once the first level is up.
      void decodeShare(shared)
        .then((playground) => {
          saveCustom(playground);
          this.customs = loadCustoms();
          this.requested = playground.id;
          if (this.current) void this.load(playground.id);
        })
        .catch((err: unknown) => {
          this.error = `playground link: ${err instanceof Error ? err.message : String(err)}`;
          console.error('[playground]', this.error);
        });
    }
    const adopt = (entity: Entity) => {
      this.current = String(entity.getValue(Playground, 'id') ?? '');
      this.loading = '';
      this.newBest = null;
      if (this.pendingCustom) {
        this.loading = this.pendingCustom.id; // the pieces go on once the duck has its new stage (update)
        return;
      }
      if (this.requested && this.requested !== this.current) {
        const id = this.requested;
        this.requested = '';
        void this.load(id);
      }
    };
    for (const entity of this.queries.playgrounds.entities) {
      adopt(entity);
    }
    this.queries.playgrounds.subscribe('qualify', adopt);
    void fetch(`${import.meta.env.BASE_URL}scenes/playgrounds/index.json`)
      .then((res) =>
        res.ok ? (res.json() as Promise<PlaygroundInfo[]>) : Promise.reject(new Error(`HTTP ${res.status}`)),
      )
      .then((list) => {
        this.list = list;
      })
      .catch((err: unknown) => {
        this.error = `playground index: ${err instanceof Error ? err.message : String(err)}`;
        console.error('[playground]', this.error);
      });
  }

  /** Everything the picker offers: the built-ins, then the player's own. */
  get all(): PlaygroundInfo[] {
    return [
      ...this.list,
      ...this.customs.map((c) => ({
        id: c.id,
        title: c.title,
        mode: 'both' as const,
        par: c.par,
        blurb: `${c.pieces.length} pieces, made in the editor. Share it from the editor.`,
      })),
    ];
  }

  info(id = this.current): PlaygroundInfo | undefined {
    return this.all.find((p) => p.id === id);
  }

  best(id = this.current): RunRecord | null {
    return id ? bestRun(id) : null;
  }

  /** Storage changed (the editor saved): read the player's playgrounds again. */
  refreshCustoms(): void {
    this.customs = loadCustoms();
  }

  /** The editor saved the board under this id: that is what is loaded now. */
  adoptCustomId(id: string): void {
    this.current = id;
    this.newBest = null;
  }

  /** Load another playground, built-in or custom; no-op while one is loading. */
  async load(id: string): Promise<void> {
    if (this.loading || id === this.current) {
      return;
    }
    const custom = this.customs.find((c) => c.id === id);
    if (custom) {
      await this.loadCustom(custom);
      return;
    }
    await this.loadLevel(id);
  }

  private async loadLevel(id: string): Promise<void> {
    this.loading = id;
    this.error = '';
    try {
      await this.world.loadLevel(`${import.meta.env.BASE_URL}scenes/playgrounds/${id}.iwsdk.scene.json`);
    } catch (err: unknown) {
      this.error = `load ${id}: ${err instanceof Error ? err.message : String(err)}`;
      this.loading = '';
      this.pendingCustom = null;
      console.error('[playground]', this.error);
    }
  }

  /**
   * A custom playground: its base level (the room-only one) loads fresh,
   * then the pieces go on the stage and the duck's physics rebuilds.
   */
  private async loadCustom(custom: CustomPlayground): Promise<void> {
    this.pendingCustom = custom;
    await this.loadLevel(custom.base);
  }

  /**
   * Puts a pending custom playground's pieces on the duck's stage. Called
   * from update() once the new level's stage is the duck's: during a level
   * switch the old level's entities are still around for a frame, and the
   * queries would hand back the wrong stage.
   */
  private async spawnPending(stage: Entity): Promise<void> {
    const custom = this.pendingCustom;
    if (!custom) return;
    this.pendingCustom = null;
    this.loading = custom.id;
    for (const spec of custom.pieces) {
      if (spec.asset === START_PAD) continue; // the base level has one
      try {
        await spawnPiece(this.world, stage, spec);
      } catch (err: unknown) {
        console.warn(`[playground] piece ${spec.asset} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.current = custom.id;
    this.loading = '';
    this.course?.invalidateZones();
    this.duck?.rebuildCourse();
    console.info(`[playground] custom ${custom.id} "${custom.title}": ${custom.pieces.length} pieces`);
  }

  update(): void {
    if (this.pendingCustom && this.current === this.pendingCustom.base) {
      const stage = this.duck?.stageEntity;
      if (stage?.object3D && this.queries.stages.entities.size === 1) void this.spawnPending(stage);
    }
    if (import.meta.env.DEV && this.list.length > 1 && !this.loading) {
      const keys = this.input.keyboard;
      const step = keys.getKeyDown('BracketRight') ? 1 : keys.getKeyDown('BracketLeft') ? -1 : 0;
      if (step !== 0) {
        const all = this.all;
        const at = Math.max(0, all.findIndex((p) => p.id === this.current));
        void this.load(all[(at + step + all.length) % all.length].id);
      }
    }
    const course = this.course;
    if (!course) {
      return;
    }
    const state = course.state;
    if (state === 'finished' && this.lastState === 'running' && this.current) {
      const previous = bestRun(this.current);
      const record: RunRecord = {
        playground: this.current,
        score: course.score,
        time: course.elapsed,
        stars: course.stars,
        falls: course.falls,
        pack: this.duck?.packId ?? '',
        policyHash: this.duck?.policyHash ?? '',
        at: new Date().toISOString(),
      };
      recordRun(record);
      this.newBest =
        !previous || record.score > previous.score || (record.score === previous.score && record.time < previous.time)
          ? record
          : null;
    }
    this.lastState = state;
  }
}
