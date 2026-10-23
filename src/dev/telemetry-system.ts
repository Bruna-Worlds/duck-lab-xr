// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Development only (with ?lab in the URL): posts the lab panel's numbers to
 * the dev server every few seconds, so a headset run can be watched from the
 * PC without a command bridge. The dev server writes them to
 * artifacts/telemetry/<name>.json (latest) and <name>.jsonl (history); see
 * vite.config.ts. Nothing personal is sent: frame times, sim stats, the
 * session's depth mode, room and terrain summaries, the last console errors.
 */
import { createSystem, type UIKitMLAsset, Vector3 } from '@iwsdk/core';
import { DuckCamSystem } from '../duck/duck-cam-system.js';
import { RobotPanelSystem } from '../ui/robot-panel-system.js';
import { DuckSystem } from '../duck/duck-system.js';
import { NavSystem } from '../nav/nav-system.js';
import { RoomSystem } from '../room/room-system.js';
import { TerrainSystem } from '../room/terrain-system.js';
import { LabLinkSystem } from '../link/lab-link-system.js';
import { PolicyInboxSystem } from '../training/policy-inbox-system.js';
import { ScenarioSystem } from '../training/scenario-system.js';
import type { SystemProfiler } from './system-profiler.js';

const PERIOD_MS = 4000;

export class TelemetrySystem extends createSystem({}) {
  private duck: DuckSystem | undefined;
  private room: RoomSystem | undefined;
  private terrain: TerrainSystem | undefined;
  private nav: NavSystem | undefined;
  private scenario: ScenarioSystem | undefined;
  private cam: DuckCamSystem | undefined;
  private robotPanel: RobotPanelSystem | undefined;
  private link: LabLinkSystem | undefined;
  private inbox: PolicyInboxSystem | undefined;
  private lastSent = 0;
  private name = 'browser';
  private failed = false;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.room = this.world.getSystem(RoomSystem);
    this.terrain = this.world.getSystem(TerrainSystem);
    this.nav = this.world.getSystem(NavSystem);
    this.scenario = this.world.getSystem(ScenarioSystem);
    this.cam = this.world.getSystem(DuckCamSystem);
    this.robotPanel = this.world.getSystem(RobotPanelSystem);
    this.link = this.world.getSystem(LabLinkSystem);
    this.inbox = this.world.getSystem(PolicyInboxSystem);
    const ua = navigator.userAgent;
    this.name = /OculusBrowser|Quest/i.test(ua) ? 'headset' : /Android|iPhone/i.test(ua) ? 'phone' : 'browser';
  }

  private readonly spot = new Vector3();

  /** Page positions (CSS px) of the menu buttons a headset test taps: the first PAIR, FORGET, ENTER MR. */
  private menuSpots(): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    const asset = this.world.getSceneObject<UIKitMLAsset>('menu-panel');
    if (!asset?.document?.visible) return out;
    const canvas = this.world.renderer.domElement;
    for (const id of ['lab-0', 'lab-forget', 'xr-button']) {
      const element = asset.getElementById(id);
      if (!element) continue;
      element.getWorldPosition(this.spot).project(this.world.camera);
      out[id] = [Math.round(((this.spot.x + 1) / 2) * canvas.clientWidth), Math.round(((1 - this.spot.y) / 2) * canvas.clientHeight)];
    }
    return out;
  }

  update(): void {
    const now = performance.now();
    if (this.failed || now - this.lastSent < PERIOD_MS) return;
    this.lastSent = now;
    const duck = this.duck;
    const session = this.world.session as (XRSession & { depthUsage?: string; depthDataFormat?: string; enabledFeatures?: string[] }) | null;
    const stats = duck?.sim?.stats;
    const profiler = (globalThis as { __duckProfiler?: SystemProfiler }).__duckProfiler;
    const body = {
      at: new Date().toISOString(),
      uptimeS: Math.round(now / 1000),
      name: this.name,
      fps: duck ? Number(duck.fps.toFixed(1)) : null,
      frameMs: duck ? Number(duck.frameMs.toFixed(2)) : null,
      frameMaxMs: duck ? Number(duck.frameMaxMs.toFixed(2)) : null,
      status: duck?.status ?? '',
      session: session
        ? {
            blend: session.environmentBlendMode,
            depthUsage: session.depthUsage ?? null,
            depthFormat: session.depthDataFormat ?? null,
            features: session.enabledFeatures ?? [],
          }
        : null,
      sim: stats
        ? {
            policyHz: Number(stats.policyHz.toFixed(1)),
            inferMs: Number(stats.inferMs.toFixed(2)),
            physicsMs: Number(stats.physicsMs.toFixed(2)),
            busy: Number(stats.busy.toFixed(2)),
            falls: stats.falls,
            mode: stats.mode,
          }
        : null,
      room: this.room ? { state: this.room.state, colliders: this.room.physicsSummary, scan: this.room.scan, debug: this.room.debug } : null,
      terrain: this.terrain ? { summary: this.terrain.summary, active: this.terrain.active, raised: this.terrain.raised } : null,
      nav: this.nav ? { status: this.nav.status, stuck: this.nav.stuck, whiskers: Array.from(this.nav.whiskers, (v) => Number(v.toFixed(2))) } : null,
      cam: this.cam ? { shown: this.cam.shown, feedWanted: this.cam.feedWanted, frames: this.cam.frames } : null,
      panel: this.robotPanel
        ? { size: this.robotPanel.size, pinned: this.robotPanel.pinned, scale: Number(this.robotPanel.panelScale.toFixed(2)) }
        : null,
      brain: this.duck?.policyHash ?? '',
      link: this.link
        ? {
            phase: this.link.phase,
            trainer: this.link.connected ? this.link.trainerName : null,
            paired: this.link.paired?.name ?? null,
            nearby: this.link.nearby.map((l) => l.code),
            packsSent: this.link.packsSent,
            kept: this.link.keptPacks,
            note: this.link.note,
          }
        : null,
      brains: this.inbox
        ? { offer: this.inbox.offer?.name ?? null, current: this.inbox.current?.name ?? null, linked: this.inbox.linked.map((r) => r.id) }
        : null,
      scenario: this.scenario?.summary ?? '',
      profile: profiler ? profiler.report(6) : '',
      errors: (globalThis as { __duckErrors?: string[] }).__duckErrors ?? [],
      // Where the menu's buttons are on the page (CSS px), so a headset test can tap them.
      page: { w: window.innerWidth, h: window.innerHeight, spots: this.menuSpots() },
      draws: this.world.renderer.info.render.calls,
      triangles: this.world.renderer.info.render.triangles,
    };
    fetch(`${import.meta.env.BASE_URL}__duck/telemetry?name=${this.name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {
      this.failed = true; // no inbox here (a production build): stay quiet
    });
  }
}
