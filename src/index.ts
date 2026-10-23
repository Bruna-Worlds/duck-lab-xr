/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright 2026 BRUNA GOODS LLC
 *
 * Begun from the IWSDK starter template, licensed under the MIT license found
 * in LICENSES/MIT-IWSDK.txt. BRUNA GOODS LLC's changes are licensed under the
 * Apache License 2.0 (LICENSE).
 */

import { DepthSensingSystem, SessionMode, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { CameraTestSystem } from './camera/camera-test-system.js';
import { CourseSystem } from './course/course-system.js';
import { GroundingSystem } from './course/grounding-system.js';
import { VrOnlySystem } from './course/vr-only-system.js';
import { DuckCamSystem } from './duck/duck-cam-system.js';
import { DuckSystem } from './duck/duck-system.js';
import { EditorSystem } from './editor/editor-system.js';
import { FxSystem } from './fx/fx-system.js';
import { LabLinkSystem } from './link/lab-link-system.js';
import { NavSystem } from './nav/nav-system.js';
import { PanelSystem } from './panel.js';
import { PlaygroundSystem } from './playgrounds/playground-system.js';
import { RoomSystem } from './room/room-system.js';
import { TerrainSystem } from './room/terrain-system.js';
import { RunPanelSystem } from './run-panel.js';
import { RobotPanelSystem } from './ui/robot-panel-system.js';
import { OrbitCameraSystem } from './ui/orbit-camera-system.js';
import { keepPointerDotsOnTop } from './ui/on-top.js';
import { catchRendererTextures, flushDeferredUploads } from './render/deferred-uploads.js';
import { ViewSwitchSystem } from './ui/view-switch-system.js';
import { ControlsCardSystem } from './ui/controls-card-system.js';
import { PolicyInboxSystem } from './training/policy-inbox-system.js';
import { RealDuckSystem } from './robot/real-duck-system.js';
import { MotionSystem } from './training/motion-system.js';
import { ScenarioSystem } from './training/scenario-system.js';
import { SystemProfiler } from './dev/system-profiler.js';
import { tidyEmulatedRoom } from './dev/emulator-room.js';
import { TelemetrySystem } from './dev/telemetry-system.js';
import { headsetLanding } from './ui/page-mode.js';

/**
 * GPU depth first: the Quest offers only that, and asking the emulator for it
 * too means the emulator runs the Quest's code path. CPU depth stays as a
 * fallback for browsers that offer only that (the first supported entry wins).
 */
function preferEitherDepth(): void {
  const xr = navigator.xr as (XRSystem & { offerSession?: XRSystem['requestSession'] }) | undefined;
  if (!xr) return;
  type DepthInit = { usagePreference?: string[]; dataFormatPreference?: string[] };
  const widen = (init?: XRSessionInit) => {
    const depth = (init as { depthSensing?: DepthInit } | undefined)?.depthSensing;
    if (depth) {
      depth.usagePreference = ['gpu-optimized', 'cpu-optimized'];
      depth.dataFormatPreference = ['float32', 'luminance-alpha'];
    }
    return init;
  };
  const request = xr.requestSession.bind(xr);
  xr.requestSession = (mode, init) => request(mode, widen(init));
  if (xr.offerSession) {
    const offer = xr.offerSession.bind(xr);
    xr.offerSession = (mode, init) => offer(mode, widen(init));
  }
}

/**
 * Dev-only: a Quest tab paired through the CLI gets its immersive session
 * from the launch deep link, and the browser drops that grant unless the
 * page asks for the session within about five seconds. Tabs the browser
 * restores or reloads can never get a session, but they would still load
 * the whole app and slow down the tab that can. Leave them idle.
 */
// Dev-only: keep the last console errors where the lab panel can show them (no console on a headset).
if (import.meta.env.DEV && new URLSearchParams(location.search).has('lab')) {
  const errors: string[] = [];
  (globalThis as { __duckErrors?: string[] }).__duckErrors = errors;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ').slice(0, 180));
    if (errors.length > 5) errors.shift();
    originalError(...args);
  };
  window.addEventListener('error', (e) => errors.push(`uncaught: ${e.message}`.slice(0, 180)));
  window.addEventListener('unhandledrejection', (e) => errors.push(`rejection: ${String(e.reason)}`.slice(0, 180)));
}

const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
const staleHeadsetTab =
  import.meta.env.DEV &&
  new URLSearchParams(location.search).has('__iwsdk_headset') &&
  navigation != null &&
  navigation.type !== 'navigate';

// Development on a headset's browser: the newest app tab is the one under test. Restarting
// the browser brings back every earlier tab, each running the app (and talking to the dev
// server and the trainer as the headset): the newest tells the older ones to close.
// Which one is newest is the launch stamp in its address (&t=<seconds>, as test scripts and the
// CLI add): restored tabs load later but carry older stamps. The higher stamp stays.
if (import.meta.env.DEV && headsetLanding() && 'BroadcastChannel' in window) {
  const tabs = new BroadcastChannel('ducklab-dev-tabs');
  const stamp = Number(new URLSearchParams(location.search).get('t')) || 0;
  tabs.onmessage = (event: MessageEvent<{ stamp?: number }>) => {
    const other = Number(event.data?.stamp) || 0;
    if (other > stamp) {
      document.body.innerHTML = '<p style="font: 16px system-ui; padding: 24px">A newer Duck Lab XR tab took over.</p>';
      setTimeout(() => window.close(), 300);
    } else if (other < stamp) {
      tabs.postMessage({ stamp }); // tell the older tab
    }
  };
  tabs.postMessage({ stamp });
}

if (staleHeadsetTab) {
  document.body.innerHTML =
    '<p style="font: 16px system-ui; padding: 24px">Stale Duck Lab XR tab (restored or reloaded). Relaunch from the CLI.</p>';
  // A restored window steals focus from the launched tab and ends its session; try to go away.
  setTimeout(() => window.close(), 800);
} else {
  // Dev-only: ?mode=vr (or ar) overrides the configured session mode, so a
  // deep-link launch on the headset can open the VR toy room for testing.
  const params = new URLSearchParams(location.search);
  const modeOverride = import.meta.env.DEV ? params.get('mode') : null;
  // Launching straight into the granted session is for the headset (the CLI
  // deep link, store launches). It also disables the session offer, which the
  // emulator's "enter XR" needs, so the managed dev browser keeps the offer.
  const launchOnSessionGranted = !import.meta.env.DEV || params.has('__iwsdk_headset');
  const options = {
    ...projectOptions,
    xr: {
      ...(projectOptions.xr as Record<string, unknown>),
      launchOnSessionGranted,
      ...(modeOverride === 'vr' || modeOverride === 'ar'
        ? { sessionMode: modeOverride === 'vr' ? 'immersive-vr' : 'immersive-ar' }
        : {}),
    },
  } as typeof projectOptions;
  preferEitherDepth();
  const takeTextures = catchRendererTextures(); // World.create builds the renderer: see src/render/deferred-uploads.ts
  World.create(document.getElementById('scene-container') as HTMLDivElement, options).then((world) => {
    const textures = takeTextures();
    if (textures) flushDeferredUploads(world.renderer, textures);
    else console.warn('[render] renderer textures not caught: in a headset, new textures may never upload');
    (globalThis as { __duckBootMs?: number }).__duckBootMs = performance.now();
    if (import.meta.env.DEV && params.has('tapToEnter')) {
      // Headset testing without a hand on the controllers: the first tap on the
      // page (an ADB tap counts as a user gesture) enters mixed reality, or VR
      // with ?tapToEnter=vr (a VR session from the deep link ends at once on the
      // Quest). Over Wi-Fi the dev build can boot after the deep link's session
      // grant expires. (A click: for touch, browsers grant the gesture on release.)
      const sessionMode = params.get('tapToEnter') === 'vr' ? SessionMode.ImmersiveVR : SessionMode.ImmersiveAR;
      window.addEventListener('click', () => void world.launchXR({ sessionMode }), { once: true, capture: true });
    }
    world.registerSystem(DepthSensingSystem, {
      configData: { enableDepthTexture: true, enableOcclusion: true, useFloat32: true, blurRadius: 20 },
    });
    world.registerSystem(DuckSystem);
    world.registerSystem(FxSystem);
    world.registerSystem(GroundingSystem);
    world.registerSystem(CourseSystem);
    world.registerSystem(PlaygroundSystem);
    // Systems look each other up in init(), so providers go before consumers:
    // the room and terrain before the autopilot, the autopilot before the cam.
    world.registerSystem(RoomSystem);
    world.registerSystem(TerrainSystem);
    world.registerSystem(NavSystem);
    world.registerSystem(ScenarioSystem);
    world.registerSystem(MotionSystem);
    world.registerSystem(DuckCamSystem);
    world.registerSystem(EditorSystem);
    world.registerSystem(VrOnlySystem);
    world.registerSystem(CameraTestSystem);
    world.registerSystem(PanelSystem);
    world.registerSystem(RunPanelSystem);
    world.registerSystem(PolicyInboxSystem);
    world.registerSystem(ViewSwitchSystem);
    world.registerSystem(ControlsCardSystem);
    world.registerSystem(OrbitCameraSystem);
    world.registerSystem(LabLinkSystem);
    world.registerSystem(RealDuckSystem);
    world.registerSystem(RobotPanelSystem);
    keepPointerDotsOnTop(world); // panels draw on top, so the ray's dot on them does too
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('lab')) {
      const profiler = new SystemProfiler(world);
      profiler.install();
      (globalThis as { __duckProfiler?: SystemProfiler }).__duckProfiler = profiler;
      world.registerSystem(TelemetrySystem); // the lab numbers, posted to the dev server
    }
    if (import.meta.env.DEV) {
      tidyEmulatedRoom();
      // For test scripts (tools/test): the world and the systems they inspect.
      (globalThis as { __duck?: unknown }).__duck = {
        world,
        duck: world.getSystem(DuckSystem),
        room: world.getSystem(RoomSystem),
        terrain: world.getSystem(TerrainSystem),
        nav: world.getSystem(NavSystem),
        course: world.getSystem(CourseSystem),
        playgrounds: world.getSystem(PlaygroundSystem),
        scenario: world.getSystem(ScenarioSystem),
        cam: world.getSystem(DuckCamSystem),
        editor: world.getSystem(EditorSystem),
        motion: world.getSystem(MotionSystem),
        hud: world.getSystem(RunPanelSystem),
        robotPanel: world.getSystem(RobotPanelSystem),
        policyInbox: world.getSystem(PolicyInboxSystem),
        realDuck: world.getSystem(RealDuckSystem),
        labLink: world.getSystem(LabLinkSystem),
        views: world.getSystem(ViewSwitchSystem),
        controls: world.getSystem(ControlsCardSystem),
        orbit: world.getSystem(OrbitCameraSystem),
        uploads: textures,
      };
    }
  });
}
