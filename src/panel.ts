// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Microduck Lab panel: XR entry buttons, duck controls, and the live Phase 0
 * numbers (display rate, duck AI cost, speed test). Text refreshes four
 * times a second and only when it changes.
 */
import {
  createSystem,
  SessionMode,
  type UIKit,
  UIKitMLAsset,
  VisibilityState,
} from '@iwsdk/core';
import { CameraTestSystem } from './camera/camera-test-system.js';
import { DuckSystem } from './duck/duck-system.js';
import { RoomSystem } from './room/room-system.js';
import { TerrainSystem } from './room/terrain-system.js';
import { keepPanelOnTop } from './ui/on-top.js';
import { MotionSystem } from './training/motion-system.js';
import { ScenarioSystem } from './training/scenario-system.js';
import type { SystemProfiler } from './dev/system-profiler.js';

const PANEL_NODE_ID = 'lab-panel';
const REFRESH_MS = 250;

type Text = UIKit.Text;

export class PanelSystem extends createSystem({}) {
  private texts: Record<'status' | 'display' | 'sim' | 'speed' | 'camera' | 'room' | 'scan' | 'terrain' | 'scenario' | 'motion' | 'profile' | 'errors', Text> | null = null;
  private lastProfile = 0;
  private room: RoomSystem | undefined;
  private terrain: TerrainSystem | undefined;
  private scenario: ScenarioSystem | undefined;
  private motion: MotionSystem | undefined;
  private cameraLabel: Text | null = null;
  private terrainLabel: Text | null = null;
  private shown = new Map<Text, string>();
  private lastRefresh = 0;
  private duck: DuckSystem | undefined;
  private cameraTest: CameraTestSystem | undefined;

  init(): void {
    // Every playground is its own level with its own lab panel node.
    this.cleanupFuncs.push(this.world.activeLevel.subscribe(() => this.bind()));
  }

  private bind(): void {
    this.texts = null;
    // The lab panel is a developer tool: shown only with ?lab=1 in the URL.
    if (!new URLSearchParams(window.location.search).has('lab')) {
      try {
        this.world.requireSceneEntity(PANEL_NODE_ID).dispose();
      } catch {
        // not in this scene
      }
      return;
    }
    const panel = this.world.getSceneObject<UIKitMLAsset>(PANEL_NODE_ID);
    if (panel == null) {
      console.warn(`[panel] scene node "${PANEL_NODE_ID}" not found`);
      return;
    }
    keepPanelOnTop(panel);
    this.duck = this.world.getSystem(DuckSystem);
    this.cameraTest = this.world.getSystem(CameraTestSystem);
    const text = (id: string) => panel.getElementById<Text>(id);
    const status = text('status-text');
    const display = text('display-text');
    const sim = text('sim-text');
    const speed = text('speed-text');
    const camera = text('camera-text');
    const room = text('room-text');
    const profile = text('profile-text');
    const scan = text('scan-text');
    const terrain = text('terrain-text');
    const scenario = text('scenario-text');
    const motion = text('motion-text');
    const errors = text('errors-text');
    this.room = this.world.getSystem(RoomSystem);
    this.terrain = this.world.getSystem(TerrainSystem);
    this.scenario = this.world.getSystem(ScenarioSystem);
    this.motion = this.world.getSystem(MotionSystem);
    this.cameraLabel = text('camera-label');
    this.terrainLabel = text('terrain-label');
    if (status && display && sim && speed && camera && room && profile && scan && terrain && scenario && motion && errors) {
      this.texts = { status, display, sim, speed, camera, room, profile, scan, terrain, scenario, motion, errors };
    }

    const xrButton = panel.getElementById('xr-button');
    const vrButton = panel.getElementById('vr-button');
    const exitButton = panel.getElementById('exit-button');
    const resetButton = panel.getElementById('reset-button');
    const speedButton = panel.getElementById('speed-button');
    const cameraButton = panel.getElementById('camera-button');
    const selfTestButton = panel.getElementById('selftest-button');
    const terrainButton = panel.getElementById('terrain-button');
    const scenarioButton = panel.getElementById('scenario-button');
    const exportButton = panel.getElementById('export-button');

    const listen = (element: typeof xrButton, handler: () => void) => {
      if (element == null) return;
      element.addEventListener('click', handler);
      this.cleanupFuncs.push(() => element.removeEventListener('click', handler));
    };
    listen(resetButton, () => this.duck?.restart());
    listen(terrainButton, () => this.terrain?.toggleBlocks());
    listen(scenarioButton, () => void this.scenario?.capture('manual'));
    listen(exportButton, () => void this.motion?.exportDataset('bow'));
    listen(speedButton, () => this.duck?.runSpeedTest());
    listen(cameraButton, () => void this.cameraTest?.toggleCamera());
    listen(selfTestButton, () => void this.cameraTest?.runSelfTest());

    if (!this.world.xrEnabled) {
      for (const button of [xrButton, vrButton, exitButton]) {
        button?.setProperties({ display: 'none' });
      }
      return;
    }
    listen(xrButton, () => this.world.launchXR({ sessionMode: SessionMode.ImmersiveAR }));
    listen(vrButton, () => this.world.launchXR({ sessionMode: SessionMode.ImmersiveVR }));
    listen(exitButton, () => this.world.exitXR());
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((visibilityState) => {
        const is2D = visibilityState === VisibilityState.NonImmersive;
        xrButton?.setProperties({ display: is2D ? 'flex' : 'none' });
        vrButton?.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton?.setProperties({ display: is2D ? 'none' : 'flex' });
      }),
    );
  }

  update(): void {
    const texts = this.texts;
    const duck = this.duck;
    const now = performance.now();
    if (!texts || !duck || now - this.lastRefresh < REFRESH_MS) {
      return;
    }
    this.lastRefresh = now;

    this.show(texts.status, duck.status);
    this.show(
      texts.display,
      duck.fps > 0
        ? `Display: ${duck.fps.toFixed(0)} fps, ${duck.frameMs.toFixed(1)} ms frames (worst ${duck.frameMaxMs.toFixed(1)})`
        : 'Display: measuring...',
    );
    const stats = duck.sim?.stats;
    this.show(
      texts.sim,
      stats
        ? `Duck AI: ${stats.policyHz.toFixed(0)} Hz, ${stats.inferMs.toFixed(2)} ms think, ${stats.physicsMs.toFixed(2)} ms physics, ${stats.falls} falls`
        : 'Duck AI: starting...',
    );
    const bench = duck.sim?.benchmark;
    this.show(
      texts.speed,
      bench
        ? `Speed test: ${bench.speedup.toFixed(1)}x real time (${bench.inferMs.toFixed(3)} + ${bench.physicsMs.toFixed(3)} ms per step)`
        : 'Speed test: not run yet',
    );
    const room = this.room;
    const profiler = (globalThis as { __duckProfiler?: SystemProfiler }).__duckProfiler;
    if (profiler && now - this.lastProfile > 2000) {
      this.lastProfile = now;
      this.show(texts.profile, profiler.report(6));
    }
    const boot = (globalThis as { __duckBootMs?: number }).__duckBootMs;
    const bootText = boot ? ` (boot ${(boot / 1000).toFixed(1)} s)` : '';
    this.show(texts.room, (room && room.state !== 'idle' ? `Room: ${room.state}. ${room.debug}` : 'Room: not in mixed reality') + bootText);
    this.show(texts.scan, room?.scan ? `Scan: ${room.scan}` : 'Scan: none');
    const roomPhysics = room?.physicsSummary ? ` | room colliders: ${room.physicsSummary}` : '';
    this.show(texts.terrain, `${this.terrain?.summary ?? 'Terrain: off'}${roomPhysics}`);
    if (this.terrainLabel) {
      this.show(this.terrainLabel, this.terrain?.blocksShown ? 'Hide terrain' : 'Show terrain');
    }
    this.show(texts.scenario, this.scenario?.summary ?? 'Scenario: off');
    this.show(texts.motion, this.motion?.status ?? 'Motions: off');
    const errors = (globalThis as { __duckErrors?: string[] }).__duckErrors;
    this.show(texts.errors, errors && errors.length ? `Errors: ${errors.slice(-2).join(' || ')}` : 'Errors: none');
    if (this.cameraTest) {
      this.show(texts.camera, this.cameraTest.summary);
      if (this.cameraLabel) {
        this.show(this.cameraLabel, this.cameraTest.running ? 'Stop camera' : 'Camera test');
      }
    }
  }

  private show(element: Text, value: string): void {
    if (this.shown.get(element) !== value) {
      this.shown.set(element, value);
      element.setProperties({ text: value });
    }
  }
}
