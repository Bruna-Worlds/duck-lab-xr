// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Robot panel ("Pip cam"): the duck's camera feed and live state, in three
 * sizes: camera only, camera and status (default), and camera, status and
 * the technical details (policy output, IMU and feet, servos, autopilot).
 *
 * On the 2D page it is a picture-in-picture in the bottom-right corner
 * (ScreenSpace). In a headset it docks in the background, on the same
 * backdrop as the scoreboard and the move bar beyond the course: beside
 * them at a fixed distance, on the course's start side, bottom-aligned with
 * the move bar and turned as they are, so it never covers them or the duck
 * (the panel arrangement of the god-simulator project). A bar under it is
 * a drag handle: point at it and hold the trigger to move the panel; let go
 * and it stays there (pinned), turning to face the player. The pin button
 * sends it back to its slot, gliding. The grip at its lower right corner
 * resizes it: drag outwards to grow it, inwards to shrink it (the size is
 * kept for next time).
 */
import {
  CapsuleGeometry,
  createSystem,
  DistanceGrabbable,
  type Entity,
  Grabbed,
  Group,
  Hovered,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  type Object3D,
  Quaternion,
  RayInteractable,
  ScreenSpace,
  type Texture,
  type UIKit,
  UIKitMLAsset,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { DuckCamSystem } from '../duck/duck-cam-system.js';
import {
  DEFAULT_POSE,
  type DuckMode,
  NUM_JOINTS,
  POLICY_FILES,
  type PolicyName,
  TEL,
  TELEMETRY_POLICIES,
} from '../duck/duck-constants.js';
import { DuckSystem } from '../duck/duck-system.js';
import { TELEMETRY_WINDOW } from '../duck/sim-client.js';
import { NavSystem } from '../nav/nav-system.js';
import { RoomSystem } from '../room/room-system.js';
import { PolicyInboxSystem } from '../training/policy-inbox-system.js';
import { touchControls } from '../input/touch-controls.js';
import { headsetMenu } from './menu-state.js';
import { keepPanelOnTop, PANEL_RENDER_ORDER } from './on-top.js';
import { headsetLanding } from './page-mode.js';
import { RobotCharts } from './robot-charts.js';

const NODE = 'robot-panel';
export type RobotPanelSize = 'mini' | 'normal' | 'details';
const SIZE_KEY = 'duckdash.robotPanel.size';
const SCALE_KEY = 'duckdash.robotPanel.scale';
/** The motion view's line beside the tabs (the vision view shows what it labelled). */
const MOTION_NOTE = 'The room as its physics knows it';
/** Headset panel size limits, relative to the authored size (about 30 cm wide). */
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;
/** How far the corner grip sits outside the panel corner (metres, at scale 1). */
const CORNER_OUT = 0.012;
const TEXT_MS = 200;
const CHART_MS = 33; // one chart per tick, so each refreshes about ten times a second
/** Where the drag bar sits over the duck's trunk when there is no scoreboard to dock beside (metres). */
const BAR_ABOVE_TRUNK = 0.26;
/** Mixed reality: let go of the bar this close to a scanned wall and the panel sticks flat on it, this far out. */
const WALL_SNAP = 0.25;
const WALL_GAP = 0.02;
/** Docked: space between the panel and the scoreboard block, and the panel's size there (it is a few metres away). */
const DOCK_GAP = 0.08;
/** A wall pulling Pip cam's docked slot in by more than this (metres) sends it to the block's other side. */
const WALL_PULL = 0.05;
const DOCK_SCALE = 1.8;
const SCORE_NODE = 'run-panel';
const MOVES_NODE = 'moves-panel';
/** Gap between the bar and the panel's lower edge (metres). */
const PANEL_GAP = 0.018;
const FOLLOW_RATE = 5; // 1/s, how fast the panel catches up with the duck
/** Screen-space boxes per size (desktop, then phones). */
/** Phones: the camera panel's share of the visible height, and its gap to the screen edges (px). */
export const PHONE_CAM_HEIGHT = 0.28;
export const PHONE_EDGE_PX = 20;
const SCREEN: Record<RobotPanelSize, { width: string; height: string }> = {
  mini: { width: '15vw', height: '24%' },
  normal: { width: '19vw', height: '44%' },
  // Desktop details: as wide as the normal view is drawn (worked out in layoutForScreen),
  // as tall as the window allows; it may cover the scoreboard (drawn over it).
  details: { width: '24vw', height: 'calc(100% - 40px)' },
};
const NARROW_SCREEN_PX = 720;

const MODE_STYLE: Record<DuckMode, { text: string; color: string }> = {
  walk: { text: 'WALK', color: '#3de0b8' },
  kick: { text: 'KICK', color: '#ffcf3f' },
  roll: { text: 'ROLL', color: '#6fb7ff' },
  sitting: { text: 'SIT', color: '#cdb4db' },
  'sitting-down': { text: 'SIT', color: '#cdb4db' },
  'standing-up': { text: 'STAND', color: '#cdb4db' },
  peck: { text: 'PECK', color: '#ff7a45' },
  motion: { text: 'BOW', color: '#cdb4db' },
  fallen: { text: 'FALLEN', color: '#ff5c8a' },
  'getting-up': { text: 'GET UP', color: '#ff5c8a' },
  paused: { text: 'PAUSED', color: '#8a8aa3' },
};
const BRAIN: Record<DuckMode, string> = {
  walk: 'Walking policy',
  kick: 'Kick policy',
  roll: 'Roll policy',
  sitting: 'Sit and stand policy',
  'sitting-down': 'Sit and stand policy',
  'standing-up': 'Sit and stand policy',
  peck: 'Peck policy',
  motion: 'Walker plus bow keyframes',
  fallen: 'Fallen: waiting to get up',
  'getting-up': 'Get-up policy',
  paused: 'Paused',
};
const SERVO_LABELS = [
  'L hip yaw',
  'L hip roll',
  'L hip pitch',
  'L knee',
  'L ankle',
  'neck',
  'head pitch',
  'head yaw',
  'head roll',
  'R hip yaw',
  'R hip roll',
  'R hip pitch',
  'R knee',
  'R ankle',
];

type Text = UIKit.Text;

function loadScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY));
    if (Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE) return v;
  } catch {
    // storage blocked
  }
  return 1;
}

function loadSize(): RobotPanelSize {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    if (v === 'mini' || v === 'normal' || v === 'details') return v;
  } catch {
    // storage blocked
  }
  return 'normal';
}

export class RobotPanelSystem extends createSystem({}) {
  size: RobotPanelSize = 'normal';
  /** In a headset: true once the player has put the panel somewhere; false while it follows the duck. */
  pinned = false;
  /** In a headset: the panel size relative to its authored size (the corner grip changes it). */
  panelScale = 1;
  private duck: DuckSystem | undefined;
  private cam: DuckCamSystem | undefined;
  private nav: NavSystem | undefined;
  private inbox: PolicyInboxSystem | undefined;
  private room: RoomSystem | undefined;
  /** In mixed reality: stuck flat on a scanned wall (let go near one), facing the room. */
  onWall = false;
  private readonly wallPoint = new Vector3();
  private readonly wallNormal = new Vector3();
  private readonly wallQ = new Quaternion();
  private charts!: RobotCharts;
  private asset: UIKitMLAsset | null = null;
  private hostEntity: Entity | null = null;
  private readonly elements = new Map<string, Text>();
  private readonly written = new Map<string, string>();
  private unbind: (() => void)[] = [];
  private flat = true;
  private shown = false;
  private lastText = 0;
  private lastChart = 0;
  private chartTurn = 0;
  private placed = false;
  private wasGrabbed = false;
  private bar!: Group;
  private barMaterial!: MeshBasicMaterial;
  private barEntity: Entity | null = null;
  private resizer!: Group;
  private resizerMaterial!: MeshBasicMaterial;
  private resizerEntity: Entity | null = null;
  private wasResizing = false;
  /** The panel node's authored scale (UIKit units to metres), read on bind. */
  private baseHostScale = 0.1;
  /** Telemetry count each chart was last drawn at (actions, IMU, servos). */
  private readonly chartCounts = [-1, -1, -1];
  private visibilityKnown = false;
  /** The normal view's width / height (panel units), refreshed while it shows: the details view keeps its width. */
  private normalAspect = 0.756;
  private readonly v = new Vector3();
  private readonly headPos = new Vector3();
  private readonly barPos = new Vector3();
  private readonly up = new Vector3();
  private readonly right = new Vector3();
  private readonly gripPos = new Vector3();
  private readonly slotCenter = new Vector3();
  private readonly otherSlot = new Vector3();
  private readonly unpulled = new Vector3();
  private readonly slotRight = new Vector3();
  private readonly slotUp = new Vector3();
  private readonly slotScale = new Vector3();
  private readonly slotBar = new Vector3();
  private readonly slotQ = new Quaternion();
  /** Size factor eased between the docked size and the size near the player. */
  private placeScale = DOCK_SCALE;
  private readonly q = new Quaternion();
  private readonly parentQ = new Quaternion();
  private readonly m = new Matrix4();
  private static readonly UP = new Vector3(0, 1, 0);

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.cam = this.world.getSystem(DuckCamSystem);
    this.nav = this.world.getSystem(NavSystem);
    this.inbox = this.world.getSystem(PolicyInboxSystem);
    this.room = this.world.getSystem(RoomSystem);
    // Development: ?demoReset=1 starts from the default size (for repeatable demos).
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('demoReset')) {
      try {
        localStorage.removeItem(SIZE_KEY);
        localStorage.removeItem(SCALE_KEY);
      } catch {
        // storage blocked
      }
    }
    this.size = loadSize();
    this.panelScale = loadScale();
    this.charts = new RobotCharts(TELEMETRY_WINDOW);
    this.buildBar();
    this.buildResizer();
    const onResize = () => this.layoutForScreen();
    window.addEventListener('resize', onResize);
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.flat = state === VisibilityState.NonImmersive;
        this.placed = false;
        this.applySize();
      }),
      this.world.activeLevel.subscribe(() => this.bind()),
      () => window.removeEventListener('resize', onResize),
      () => this.release(),
      () => this.charts.dispose(),
    );
  }

  /** The drag handle: a pill under the panel with a larger invisible hit area. */
  private buildBar(): void {
    this.bar = new Group();
    this.bar.name = 'robot-panel-bar';
    // Like the panel, its handles are never hidden behind real furniture (see on-top.ts).
    this.barMaterial = new MeshBasicMaterial({ color: 0xfff4dc, transparent: true, opacity: 0.7, depthWrite: false, depthTest: false });
    const pill = new Mesh(new CapsuleGeometry(0.0065, 0.085, 4, 12).rotateZ(Math.PI / 2), this.barMaterial);
    pill.renderOrder = PANEL_RENDER_ORDER;
    pill.name = 'robot-panel-bar-pill';
    const hit = new Mesh(new CapsuleGeometry(0.025, 0.12, 2, 8).rotateZ(Math.PI / 2), new MeshBasicMaterial({ visible: false }));
    hit.name = 'robot-panel-bar-hit';
    this.bar.add(pill, hit);
    this.bar.visible = false;
    this.cam?.hideDuringRender(this.bar);
    this.cleanupFuncs.push(() => {
      pill.geometry.dispose();
      hit.geometry.dispose();
      this.barMaterial.dispose();
      (hit.material as MeshBasicMaterial).dispose();
    });
  }

  /** The resize grip: an L that hugs the panel's lower right corner, with a larger invisible hit area. */
  private buildResizer(): void {
    this.resizer = new Group();
    this.resizer.name = 'robot-panel-resizer';
    this.resizerMaterial = new MeshBasicMaterial({ color: 0xfff4dc, transparent: true, opacity: 0.6, depthWrite: false, depthTest: false });
    const arm = new CapsuleGeometry(0.0045, 0.026, 4, 10);
    const across = new Mesh(arm.clone().rotateZ(Math.PI / 2), this.resizerMaterial);
    across.renderOrder = PANEL_RENDER_ORDER;
    across.position.set(-0.015, 0, 0);
    const down = new Mesh(arm, this.resizerMaterial);
    down.renderOrder = PANEL_RENDER_ORDER;
    down.position.set(0, 0.015, 0);
    const hit = new Mesh(new CapsuleGeometry(0.022, 0.02, 2, 8), new MeshBasicMaterial({ visible: false }));
    hit.position.set(-0.008, 0.008, 0);
    hit.name = 'robot-panel-resizer-hit';
    this.resizer.add(across, down, hit);
    this.resizer.visible = false;
    this.cam?.hideDuringRender(this.resizer);
    this.cleanupFuncs.push(() => {
      arm.dispose();
      across.geometry.dispose();
      hit.geometry.dispose();
      this.resizerMaterial.dispose();
      (hit.material as MeshBasicMaterial).dispose();
    });
  }

  /** A persistent, ray-draggable handle entity (created the first time the panel shows in a headset). */
  private handleEntity(object: Object3D): Entity {
    const entity = this.world.createTransformEntity(object, { persistent: true });
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
      rotate: false,
      scale: false,
      translate: true,
      returnToOrigin: false,
    });
    return entity;
  }

  private ensureBarEntity(): Entity {
    this.barEntity ??= this.handleEntity(this.bar);
    return this.barEntity;
  }

  private ensureResizerEntity(): Entity {
    this.resizerEntity ??= this.handleEntity(this.resizer);
    return this.resizerEntity;
  }

  /** Sets the headset panel size (relative to the authored size) and keeps it for next time. */
  setPanelScale(scale: number): void {
    this.panelScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    try {
      localStorage.setItem(SCALE_KEY, this.panelScale.toFixed(3));
    } catch {
      // storage blocked
    }
  }

  setSize(size: RobotPanelSize): void {
    this.size = size;
    try {
      localStorage.setItem(SIZE_KEY, size);
    } catch {
      // storage blocked
    }
    this.applySize();
  }

  /** Back to its slot in the background, beside the scoreboard (a headset only). */
  follow(): void {
    this.pinned = false;
    this.onWall = false;
  }

  /**
   * Just let go of the bar: within WALL_SNAP of a scanned wall (mixed
   * reality), the panel sticks flat on the wall, upright, facing the room.
   */
  private stickToWall(): void {
    const room = this.room;
    if (!room?.isMixedReality) return;
    this.bar.getWorldPosition(this.barPos);
    if (!room.nearestWall(this.barPos, WALL_SNAP, this.wallPoint, this.wallNormal)) return;
    // Face the room (the player's side), upright.
    this.player.head.getWorldPosition(this.headPos);
    if (this.v.copy(this.headPos).sub(this.wallPoint).dot(this.wallNormal) < 0) this.wallNormal.negate();
    this.wallNormal.y = 0;
    if (this.wallNormal.lengthSq() < 1e-6) return;
    this.wallNormal.normalize();
    this.barPos.set(this.wallPoint.x, this.barPos.y, this.wallPoint.z).addScaledVector(this.wallNormal, WALL_GAP);
    this.setWorldPosition(this.bar, this.barPos);
    this.v.crossVectors(RobotPanelSystem.UP, this.wallNormal);
    this.m.makeBasis(this.v, RobotPanelSystem.UP, this.wallNormal);
    this.wallQ.setFromRotationMatrix(this.m);
    this.onWall = true;
  }

  /**
   * The docked slot for a panel this wide standing this far over its bar: the bar's world position (into
   * `out`) and the backdrop's orientation (into `quat`). False without a
   * scoreboard in this scene.
   */
  private dockSlot(width: number, gap: number, out: Vector3, quat: Quaternion): boolean {
    let scoreHost: Object3D | undefined;
    try {
      scoreHost = this.world.requireSceneEntity(SCORE_NODE).object3D;
    } catch {
      return false;
    }
    const score = this.world.getSceneObject<UIKitMLAsset>(SCORE_NODE)?.document.computedSize;
    if (!scoreHost || !score) return false;
    scoreHost.getWorldPosition(this.slotCenter);
    scoreHost.getWorldQuaternion(quat);
    scoreHost.getWorldScale(this.slotScale);
    this.slotRight.set(1, 0, 0).applyQuaternion(quat);
    this.slotUp.set(0, 1, 0).applyQuaternion(quat);
    // The block: scoreboard and move bar, measured along the backdrop.
    let half = (score.width * 0.01 * this.slotScale.x) / 2;
    let bottom = -(score.height * 0.01 * this.slotScale.y) / 2;
    try {
      const movesHost = this.world.requireSceneEntity(MOVES_NODE).object3D;
      const moves = this.world.getSceneObject<UIKitMLAsset>(MOVES_NODE)?.document.computedSize;
      if (movesHost && moves && movesHost.visible) {
        movesHost.getWorldPosition(this.v);
        movesHost.getWorldScale(this.slotScale);
        this.v.sub(this.slotCenter);
        half = Math.max(half, Math.abs(this.v.dot(this.slotRight)) + (moves.width * 0.01 * this.slotScale.x) / 2);
        bottom = Math.min(bottom, this.v.dot(this.slotUp) - (moves.height * 0.01 * this.slotScale.y) / 2);
      }
    } catch {
      // no move bar in this scene
    }
    // The course's start side: where the duck's stage stands relative to the block.
    let side = -1;
    const stage = this.duck?.stageEntity?.object3D;
    if (stage) {
      stage.getWorldPosition(this.v);
      side = this.v.sub(this.slotCenter).dot(this.slotRight) > 0 ? 1 : -1;
    }
    // In a scanned room a slot is never beyond a side wall. A wall that pulls the
    // start side's slot in (over the block, or over the open menu on its right)
    // sends the panel to the other side, if that has more room.
    this.sideSlot(side, half, width, gap, bottom, out);
    const pulled = this.pullInside(out);
    if (pulled > WALL_PULL) {
      this.sideSlot(-side, half, width, gap, bottom, this.otherSlot);
      if (this.pullInside(this.otherSlot) < pulled) out.copy(this.otherSlot);
    }
    return true;
  }

  /** The slot on one side of the block, bottom-aligned with it; on the right, beyond the open menu. */
  private sideSlot(side: number, half: number, width: number, gap: number, bottom: number, out: Vector3): void {
    const reach = half + (side > 0 ? headsetMenu.span : 0);
    out
      .copy(this.slotCenter)
      .addScaledVector(this.slotRight, side * (reach + DOCK_GAP + width / 2))
      .addScaledVector(this.slotUp, bottom - gap);
  }

  /** Moves a slot back inside the scanned room and returns how far it moved (metres). */
  private pullInside(slot: Vector3): number {
    if (!this.room) return 0;
    this.unpulled.copy(slot);
    this.room.keepInside(slot, this.slotCenter);
    return this.unpulled.distanceTo(slot);
  }

  /** Find this level's panel and wire it (runs on every level change). */
  private bind(): void {
    this.release();
    this.pinned = false;
    this.placed = false;
    const asset = this.world.getSceneObject<UIKitMLAsset>(NODE);
    if (!asset) return;
    let entity: Entity | null = null;
    try {
      entity = this.world.requireSceneEntity(NODE);
    } catch {
      return;
    }
    this.asset = asset;
    keepPanelOnTop(asset);
    // Over the scoreboard where the tall details view covers it.
    asset.document.rootElement?.setProperties({ renderOrder: PANEL_RENDER_ORDER + 1 });
    this.hostEntity = entity;
    this.baseHostScale = entity.object3D?.scale.x || 0.1;
    this.cam?.hideDuringRender(asset.document);
    const ids = [
      'rp-mode',
      'rp-pin',
      'rp-more',
      'rp-less',
      'rp-min',
      'rp-max',
      'rp-feed',
      'rp-tabs',
      'rp-view-motion',
      'rp-view-vision',
      'rp-view-note',
      'rp-status',
      'rp-drive',
      'rp-brain',
      'rp-details',
      'rp-policy',
      'rp-actions',
      'rp-imu-meta',
      'rp-imu',
      'rp-servo-meta',
      'rp-servos',
      'rp-nav-meta',
      'rp-nav',
      'rp-hint',
      'rp-offer',
      'rp-offer-note',
      'rp-offer-try',
      'rp-offer-later',
      'rp-brain-row',
      'rp-brain-name',
      'rp-revert',
    ];
    for (const id of ids) {
      const element = asset.getElementById<Text>(id);
      if (element) {
        element.name = id;
        this.elements.set(id, element);
      }
    }
    const listen = (id: string, handler: () => void) => {
      const element = this.elements.get(id);
      if (!element) return;
      element.addEventListener('click', handler);
      this.unbind.push(() => element.removeEventListener('click', handler));
    };
    listen('rp-more', () => this.setSize('details'));
    listen('rp-less', () => this.setSize('normal'));
    listen('rp-min', () => this.setSize('mini'));
    listen('rp-max', () => this.setSize('normal'));
    listen('rp-offer-try', () => void this.inbox?.accept());
    listen('rp-offer-later', () => this.inbox?.dismiss());
    listen('rp-revert', () => void this.inbox?.revert());
    listen('rp-view-motion', () => this.cam?.setView('motion'));
    listen('rp-view-vision', () => this.cam?.setView('vision'));
    listen('rp-pin', () => {
      if (this.pinned) this.follow();
      else this.pinned = true;
    });
    const image = (id: string, texture: Texture) => asset.getElementById<UIKit.Image>(id)?.setProperties({ src: texture });
    if (this.cam) image('rp-feed', this.cam.texture);
    image('rp-actions', this.charts.actions);
    image('rp-imu', this.charts.imu);
    image('rp-servos', this.charts.servos);
    this.visibilityKnown = false;
    this.chartCounts.fill(-1);
    this.applySize();
  }

  private release(): void {
    for (const off of this.unbind) off();
    this.unbind = [];
    if (this.asset) this.cam?.hideDuringRender(this.asset.document, false);
    this.asset = null;
    this.hostEntity = null;
    this.elements.clear();
    this.written.clear();
  }

  /** Shows the parts that belong to the current size and mode. */
  private applySize(): void {
    const size = this.size;
    const xr = !this.flat;
    // On the 2D page the small size folds the panel to its title bar (a new brain's offer stays);
    // in a headset it is a small picture.
    const folded = this.flat && size === 'mini';
    this.display('rp-tabs', !folded);
    this.display('rp-feed', !folded);
    this.display('rp-status', size !== 'mini');
    this.display('rp-details', size === 'details');
    this.display('rp-more', size === 'normal');
    this.display('rp-less', size === 'details');
    this.display('rp-min', size !== 'mini');
    this.display('rp-max', size === 'mini');
    this.display('rp-pin', xr && size !== 'mini');
    this.display('rp-hint', xr && size !== 'mini');
    this.layoutForScreen();
  }

  /**
   * The 2D page: the picture-in-picture box for this size. Phones and touch
   * tablets get a wider one under the scoreboard (clear of the touch controls);
   * on a desktop it stands in the bottom right corner, under the scoreboard.
   */
  private layoutForScreen(): void {
    const entity = this.hostEntity;
    if (!entity?.hasComponent(ScreenSpace)) return;
    const compact = !headsetLanding() && (window.innerWidth < NARROW_SCREEN_PX || touchControls.shown);
    const canvas = this.world.renderer.domElement;
    const W = canvas.clientWidth || window.innerWidth;
    const H = canvas.clientHeight || window.innerHeight;
    // IWSDK lays screen panels out in a 100vh box, but a phone browser's 100vh reaches under
    // its toolbars: measure from the canvas (the part of the page that shows) instead.
    const bottom = `calc(100vh - ${Math.round(H)}px + ${PHONE_EDGE_PX}px)`;
    if (compact) {
      // Phones: the bottom right corner (the stick has the bottom left, the menu opens above);
      // folded to its title bar it keeps the normal view's width; the details open upwards.
      const details = this.size === 'details';
      const folded = this.size === 'mini';
      const normalWidth = Math.round(Math.min(0.46 * W, PHONE_CAM_HEIGHT * H * this.normalAspect));
      entity.setValue(ScreenSpace, 'width', details ? '94vw' : folded ? `${normalWidth}px` : '46vw');
      entity.setValue(ScreenSpace, 'height', `${Math.round((details ? 0.62 : PHONE_CAM_HEIGHT) * H)}px`);
      entity.setValue(ScreenSpace, 'left', 'auto');
      entity.setValue(ScreenSpace, 'right', '3vw');
      entity.setValue(ScreenSpace, 'top', 'auto');
      entity.setValue(ScreenSpace, 'bottom', bottom);
      return;
    }
    const box = SCREEN[this.size];
    let width = box.width;
    if (this.size === 'details' || this.size === 'mini') {
      // Keep the normal view's width: the details are taller, the folded bar shorter.
      width = `${Math.round(Math.min(0.19 * W, 0.44 * H * this.normalAspect))}px`;
    }
    entity.setValue(ScreenSpace, 'width', width);
    entity.setValue(ScreenSpace, 'height', box.height);
    entity.setValue(ScreenSpace, 'left', 'auto');
    entity.setValue(ScreenSpace, 'right', '20px');
    entity.setValue(ScreenSpace, 'top', 'auto');
    entity.setValue(ScreenSpace, 'bottom', bottom);
  }

  update(delta: number): void {
    const duck = this.duck;
    const asset = this.asset;
    const cam = this.cam;
    const visible = !!asset && !!cam?.shown && !!duck?.hasPose;
    if (asset && (!this.visibilityKnown || visible !== this.shown)) {
      this.visibilityKnown = true;
      this.shown = visible;
      asset.document.visible = visible;
    }
    if (cam) cam.feedWanted = visible && !(this.flat && this.size === 'mini'); // folded: no picture to draw
    if (visible && this.size === 'normal' && asset) {
      const size = (asset.document as unknown as { computedSize?: { width: number; height: number } }).computedSize;
      if (size && size.width > 0 && size.height > 0) this.normalAspect = size.width / size.height;
    }
    const sim = duck?.sim ?? null;
    const wantTelemetry = visible && this.size === 'details';
    sim?.setTelemetry(wantTelemetry);
    this.placeInXr(visible, delta);
    if (!visible || !duck) return;

    const now = performance.now();
    if (wantTelemetry && sim && now - this.lastChart >= CHART_MS) {
      this.lastChart = now;
      const ring = sim.telemetry;
      if (ring.count === 0) {
        if (this.chartCounts[0] !== 0) this.charts.clear();
        this.chartCounts.fill(0);
      } else {
        // One chart per tick: the next one in turn that has not seen the newest data.
        for (let k = 0; k < 3; k++) {
          const chart = this.chartTurn++ % 3;
          if (this.chartCounts[chart] === ring.count) continue;
          this.chartCounts[chart] = ring.count;
          if (chart === 0) this.charts.drawActions(ring);
          else if (chart === 1) this.charts.drawImu(ring);
          else this.charts.drawServos(ring, DEFAULT_POSE);
          break;
        }
      }
    }
    if (now - this.lastText < TEXT_MS) return;
    this.lastText = now;
    this.writeStatus(duck, wantTelemetry);
  }

  /** Headset placement: over the duck or where the player put it, turned to the player. */
  private placeInXr(visible: boolean, delta: number): void {
    const host = this.hostEntity?.object3D;
    const showBar = visible && !this.flat && !!host;
    this.bar.visible = showBar;
    this.resizer.visible = showBar;
    (this.bar as Object3D & { pointerEvents?: string }).pointerEvents = showBar ? 'auto' : 'none';
    (this.resizer as Object3D & { pointerEvents?: string }).pointerEvents = showBar ? 'auto' : 'none';
    if (!showBar || !host) {
      if (this.duck) this.duck.triggerClaimed = false;
      return;
    }
    const barEntity = this.ensureBarEntity();
    const resizerEntity = this.ensureResizerEntity();
    const grabbed = barEntity.hasComponent(Grabbed);
    const resizing = resizerEntity.hasComponent(Grabbed);
    if (grabbed && !this.wasGrabbed) {
      this.pinned = true; // a drag pins it where it is let go
      this.onWall = false;
    }
    if (!grabbed && this.wasGrabbed) this.stickToWall(); // let go near a wall: flat on it
    this.wasGrabbed = grabbed;
    if (!resizing && this.wasResizing) this.setPanelScale(this.panelScale); // keep the new size
    this.wasResizing = resizing;
    if (this.duck) this.duck.triggerClaimed = grabbed || resizing;
    const hot = grabbed || barEntity.hasComponent(Hovered);
    this.barMaterial.color.setHex(hot ? 0xffcf3f : 0xfff4dc);
    this.barMaterial.opacity = hot ? 1 : 0.7;
    const gripHot = resizing || resizerEntity.hasComponent(Hovered);
    this.resizerMaterial.color.setHex(gripHot ? 0xffcf3f : 0xfff4dc);
    this.resizerMaterial.opacity = gripHot ? 1 : 0.6;
    const rig = this.duck?.rig;
    this.bar.getWorldPosition(this.barPos);
    const size = this.asset?.document.computedSize;
    const unitWidth = size ? size.width * 0.01 * this.baseHostScale : 0.3;
    const unitHeight = size ? size.height * 0.01 * this.baseHostScale : 0.3;
    // Docked in the background unless the player has put it somewhere.
    const docked = !grabbed && !this.pinned && this.dockSlot(0, 0, this.slotBar, this.slotQ);
    // Size: the player's factor times the docked size (a few metres away) or 1 near the player.
    this.placeScale += ((docked ? DOCK_SCALE : 1) - this.placeScale) * (this.placed ? 1 - Math.exp(-FOLLOW_RATE * delta) : 1);
    if (docked) {
      // Docked: turned as the backdrop is (the scoreboard and move bar), not to the head.
      this.q.copy(this.slotQ);
    } else if (this.onWall && !grabbed) {
      // On a wall: flat on it, facing the room.
      this.q.copy(this.wallQ);
    } else {
      // Pinned or held: +Z (the panel's face) towards the head.
      this.player.head.getWorldPosition(this.headPos);
      this.m.lookAt(this.headPos, this.barPos, RobotPanelSystem.UP);
      this.q.setFromRotationMatrix(this.m);
    }
    this.setWorldQuaternion(this.bar, this.q);
    this.up.set(0, 1, 0).applyQuaternion(this.q);
    this.right.set(1, 0, 0).applyQuaternion(this.q);
    // The corner grip, while held, sets the width (twice its sideways
    // distance from the centre of the bar); the height follows.
    if (resizing) {
      this.resizer.getWorldPosition(this.gripPos);
      const sideways = this.v.copy(this.gripPos).sub(this.barPos).dot(this.right);
      const width = 2 * Math.max(0.02, sideways - CORNER_OUT * this.panelScale * this.placeScale);
      this.panelScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, width / (unitWidth * this.placeScale)));
    }
    if (docked && !resizing) {
      // Glide to the slot beside the scoreboard (which moves with the course).
      this.dockSlot(unitWidth * this.placeScale * this.panelScale, PANEL_GAP * this.placeScale * this.panelScale, this.slotBar, this.slotQ);
      if (!this.placed) this.barPos.copy(this.slotBar);
      else this.barPos.lerp(this.slotBar, 1 - Math.exp(-FOLLOW_RATE * delta));
      this.setWorldPosition(this.bar, this.barPos);
    } else if (!grabbed && !this.pinned && !docked && rig) {
      // No scoreboard here: hover over the duck instead.
      rig.trunk.getWorldPosition(this.v);
      this.v.y += BAR_ABOVE_TRUNK;
      if (!this.placed) this.barPos.copy(this.v);
      else this.barPos.lerp(this.v, 1 - Math.exp(-FOLLOW_RATE * delta));
      this.setWorldPosition(this.bar, this.barPos);
    }
    this.placed = true;
    const k = this.panelScale * this.placeScale;
    host.scale.setScalar(this.baseHostScale * k);
    this.bar.scale.setScalar(k);
    // (k includes the docked size; the player's own factor alone is this.panelScale.)
    // The panel stands on the bar: centre = bar + up * (half height + gap).
    const halfHeight = (unitHeight * k) / 2;
    const gap = PANEL_GAP * k;
    this.v.copy(this.barPos).addScaledVector(this.up, halfHeight + gap);
    this.setWorldPosition(host, this.v);
    this.setWorldQuaternion(host, this.q);
    // The grip hugs the lower right corner, except while it is being dragged.
    this.resizer.scale.setScalar(Math.sqrt(k));
    this.setWorldQuaternion(this.resizer, this.q);
    if (!resizing) {
      this.v
        .copy(this.barPos)
        .addScaledVector(this.right, (unitWidth * k) / 2 + CORNER_OUT * k)
        .addScaledVector(this.up, gap - CORNER_OUT * k * 0.5);
      this.setWorldPosition(this.resizer, this.v);
    }
  }

  private setWorldPosition(object: Object3D, world: Vector3): void {
    object.position.copy(world);
    if (object.parent) {
      object.parent.updateWorldMatrix(true, false);
      object.parent.worldToLocal(object.position);
    }
  }

  private setWorldQuaternion(object: Object3D, world: Quaternion): void {
    if (object.parent) {
      object.parent.getWorldQuaternion(this.parentQ).invert();
      object.quaternion.copy(this.parentQ).multiply(world);
    } else {
      object.quaternion.copy(world);
    }
  }

  private writeStatus(duck: DuckSystem, details: boolean): void {
    const sim = duck.sim;
    const mode: DuckMode = sim?.mode ?? 'walk';
    const style = MODE_STYLE[mode] ?? MODE_STYLE.walk;
    this.text('rp-mode', style.text);
    this.background('rp-mode', style.color);
    // The feed's view tabs, and what the view shows.
    const vision = this.cam?.view === 'vision';
    this.tab('rp-view-motion', !vision);
    this.tab('rp-view-vision', vision);
    this.text('rp-view-note', vision ? (this.cam?.vision.summary ?? '') : MOTION_NOTE);
    this.background('rp-pin', this.pinned ? '#ffcf3f' : 'rgba(255, 244, 220, 0.08)');
    const nav = this.nav;
    const vx = duck.commandVx;
    const wz = duck.commandWz;
    let drive: string;
    if (nav?.task) drive = nav.status || 'Autopilot';
    else if (Math.abs(vx) > 0.005 || Math.abs(wz) > 0.02) {
      drive = `Stick: ${vx >= 0 ? 'forward' : 'back'} ${Math.abs(vx).toFixed(2)} m/s, turn ${wz.toFixed(1)} rad/s`;
    } else drive = 'Idle: move the stick or press Auto';
    this.text('rp-drive', drive);
    const stats = sim?.stats;
    const rate = stats ? ` | ${stats.policyHz.toFixed(0)} Hz | ${stats.inferMs.toFixed(2)} ms` : '';
    this.text('rp-brain', `${BRAIN[mode] ?? 'Walking policy'}${rate}`);
    // Trained policies from the desktop: the offer, and which brain is running.
    const inbox = this.inbox;
    const offer = inbox?.offer ?? null;
    this.display('rp-offer', !!offer);
    if (offer) {
      const pct = (v: number | null) => (v === null ? '?' : `${Math.round(v * 100)}%`);
      this.text(
        'rp-offer-note',
        inbox?.busy
          ? inbox.status
          : `${offer.name}: falls ${pct(offer.baselineFallRate)} to ${pct(offer.fallRate)} on ${offer.packs} of your scenes`,
      );
    }
    const current = inbox?.current ?? null;
    this.display('rp-brain-row', !!current && this.size !== 'mini');
    if (current) this.text('rp-brain-name', `Brain: ${current.name} (${current.walkHash})`);
    if (!details || !sim) return;

    const ring = sim.telemetry;
    const o = ring.offset(0);
    if (o >= 0) {
      const d = ring.data;
      const policy = TELEMETRY_POLICIES[Math.round(d[o + TEL.policy])] ?? 'none';
      const file = policy === 'none' ? 'no policy' : POLICY_FILES[policy as PolicyName];
      this.text('rp-policy', `${file} | 61 in, 14 out`);
      const gz = d[o + TEL.gravity + 2];
      const tilt = (Math.acos(Math.max(-1, Math.min(1, -gz))) * 180) / Math.PI;
      this.text(
        'rp-imu-meta',
        `tilt ${tilt.toFixed(0)} deg | feet ${d[o + TEL.feet].toFixed(1)} / ${d[o + TEL.feet + 1].toFixed(1)} N`,
      );
      let worst = 0;
      let worstJoint = 0;
      for (let j = 0; j < NUM_JOINTS; j++) {
        const t = Math.abs(d[o + TEL.force + j]);
        if (t > worst) {
          worst = t;
          worstJoint = j;
        }
      }
      this.text('rp-servo-meta', `peak torque ${(worst * 100).toFixed(0)}% ${SERVO_LABELS[worstJoint]}`);
    }
    if (nav?.task) {
      const p = duck.pose;
      const distance = Math.hypot(nav.targetX - p[0], nav.targetY - p[1]);
      const w = nav.whiskers;
      this.text('rp-nav-meta', nav.task === 'course' ? 'running the course' : nav.task);
      this.text(
        'rp-nav',
        `Next target ${distance.toFixed(2)} m away | ${nav.waypointsLeft} goals left | path ${nav.pathPoints} points | ` +
          `clear ahead ${w[0].toFixed(2)} m, left ${w[1].toFixed(2)} m, right ${w[2].toFixed(2)} m`,
      );
    } else {
      this.text('rp-nav-meta', 'off');
      this.text('rp-nav', 'Press Auto and the duck plans its own path: targets, waypoints and whiskers show here.');
    }
  }

  private text(id: string, value: string): void {
    const element = this.elements.get(id);
    if (element && this.written.get(id) !== value) {
      this.written.set(id, value);
      element.setProperties({ text: value });
    }
  }

  private background(id: string, value: string): void {
    const key = `${id}:bg`;
    const element = this.elements.get(id);
    if (element && this.written.get(key) !== value) {
      this.written.set(key, value);
      element.setProperties({ backgroundColor: value });
    }
  }

  /** A view tab: filled when on. */
  private tab(id: string, on: boolean): void {
    const key = `${id}:tab`;
    const value = on ? '1' : '0';
    const element = this.elements.get(id);
    if (!element || this.written.get(key) === value) return;
    this.written.set(key, value);
    element.setProperties({
      backgroundColor: on ? '#6fb7ff' : 'rgba(255, 244, 220, 0.08)',
      borderColor: on ? '#6fb7ff' : 'rgba(255, 244, 220, 0.22)',
      color: on ? '#0f1020' : '#fff4dc',
    });
  }

  private display(id: string, shown: boolean): void {
    const key = `${id}:display`;
    const value = shown ? 'flex' : 'none';
    const element = this.elements.get(id);
    if (element && this.written.get(key) !== value) {
      this.written.set(key, value);
      element.setProperties({ display: value });
    }
  }
}
