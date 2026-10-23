// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck Lab XR HUD, split over three panels that every playground places:
 *   - scoreboard (run-panel): run state, time, score, pickups, combo, result,
 *   - menu (menu-panel): playground picker, course editor palette, toggles
 *     (Auto, Cam, Edit), Restart and, on the 2D page, Enter MR / Enter VR,
 *   - move bar (moves-panel): the duck's mood and its five moves.
 * The robot panel (camera feed and telemetry) has its own system.
 *
 * On the 2D page the panels sit in the screen corners (ScreenSpace); phones
 * get a full-width scoreboard and open the menu from it. In a headset the
 * scoreboard and move bar stand beyond the course (see DuckSystem) and the
 * menu opens beside them, on their right, with a left thumbstick click
 * (Quest keeps its menu button for the system) or the scoreboard's Menu
 * chip. Text refreshes ten times a second and only what changed is written.
 */
import {
  createSystem,
  type Entity,
  InputComponent,
  Matrix4,
  type Object3D,
  Quaternion,
  ScreenSpace,
  SessionMode,
  type UIKit,
  UIKitMLAsset,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { CourseSystem } from './course/course-system.js';
import { DuckSystem, type MoveButton } from './duck/duck-system.js';
import { DuckCamSystem } from './duck/duck-cam-system.js';
import { EditorSystem } from './editor/editor-system.js';
import { STICK_RIGHT_PX, STICK_ZONE_PX, touchControls } from './input/touch-controls.js';
import { headsetMenu, readMenuMinimized, readScoreMinimized, writeMenuMinimized, writeScoreMinimized } from './ui/menu-state.js';
import { keepPanelOnTop } from './ui/on-top.js';
import { headsetLanding } from './ui/page-mode.js';
import { PHONE_CAM_HEIGHT, PHONE_EDGE_PX } from './ui/robot-panel-system.js';
import { NavSystem } from './nav/nav-system.js';
import { PlaygroundSystem } from './playgrounds/playground-system.js';
import { RoomSystem, type RoomState } from './room/room-system.js';

const SCORE_NODE = 'run-panel';
const MENU_NODE = 'menu-panel';
const MOVES_NODE = 'moves-panel';
const LAB_NODE = 'lab-panel'; // dev only (?lab), owned by src/panel.ts
const PANELS = [SCORE_NODE, MENU_NODE, MOVES_NODE];
const REFRESH_MS = 100;
const MAX_MULTIPLIER = 8;
const CHIPS = 6;
/** Palette chip id -> manifest asset it adds (see spawn-pieces.ts). */
const PALETTE_BUTTONS: Record<string, string> = {
  'ed-crumb': 'course-crumb',
  'ed-gate': 'course-gate',
  'ed-books': 'course-book-stack',
  'ed-ball': 'course-ball',
  'ed-goal': 'course-goal',
  'ed-finish': 'course-finish-pad',
  'ed-shoe': 'scan-boat-shoe-tan',
  'ed-dino': 'scan-triceratops',
};
/** The open-source repository, linked from the scoreboard. */
const REPO_URL = 'https://github.com/Bruna-Worlds/duck-lab-xr';
/** Below this width the scoreboard spans the screen top and the menu opens on demand. */
const NARROW_SCREEN_PX = 720;
/**
 * Headset menu: it hangs beside the scoreboard, on its right as the player
 * sees it, in the same plane and centred on the scoreboard and the move bar
 * under it, so it covers neither (the god-simulator hangs its panels side by
 * side the same way). The gap to the wider of the two (metres), and its size:
 * about 68 cm wide, a little under the scoreboard's 0.2 at the same distance.
 */
const MENU_GAP = 0.05;
const MENU_SCALE = 0.15;
/**
 * Without a scoreboard it opens in front of the player instead, off to the
 * left and a little low: distance from the eyes and drop below them (metres),
 * how far round to the left (radians), and its size (about 32 cm wide).
 */
const MENU_DISTANCE = 0.55;
const MENU_BELOW = 0.16;
const MENU_LEFT = (30 * Math.PI) / 180;
const MENU_NEAR_SCALE = 0.08;
/** The menu card's width, and its title bar and padding around the body, in panel units (menu.uikitml). */
const MENU_CARD_UNITS = 450;
const MENU_CHROME_UNITS = 80;
/** Headset: space between the scoreboard and the move bar under it (metres). */
const MOVES_GAP = 0.03;

type Text = UIKit.Text;

// Palette shared with the UIKitML files: ink, cream and five candy accents.
const INK = '#0f1020';
const CREAM = '#fff4dc';
const YELLOW = '#ffcf3f';
const READY_COLOR: Record<MoveButton, string> = {
  kick: YELLOW,
  roll: '#6fb7ff',
  sit: '#3de0b8',
  peck: '#ff7a45',
  bow: '#cdb4db',
};
const ACTIVE_COLOR = '#ff5c8a';
const BUSY_COLOR = '#34365a';
const LOADING_COLOR = '#24253f';
const MOVE_TEXT_DIM = 'rgba(255, 244, 220, 0.55)';
const MOVE_NAMES: Record<MoveButton, string> = { kick: 'KICK', roll: 'ROLL', sit: 'SIT', peck: 'PECK', bow: 'BOW' };
/** The key shown on each move: keyboard on the 2D page, controller buttons in a headset. */
const MOVE_KEYS: Record<MoveButton, string> = { kick: 'J', roll: 'K', sit: 'L', peck: 'I', bow: 'N' };
const MOVE_BUTTONS_XR: Record<MoveButton, string> = { kick: 'A', roll: 'B', sit: 'X', peck: 'Y', bow: 'RS' };
const STATE_COLOR = { ready: '#6fb7ff', running: '#3de0b8', finished: YELLOW };
const STATE_LOADING_COLOR = '#cdb4db';
const CHIP_IDLE = 'rgba(255, 244, 220, 0.08)';
const TOGGLE_BORDER_IDLE = 'rgba(255, 244, 220, 0.25)';
const ROOM_TEXT: Record<RoomState, string> = {
  idle: '',
  scanning: 'Scanning your room...',
  placed: 'Placed on your floor',
  tight: 'Tight spot. Right grip: move the course',
  'no-space': 'No clear floor here. Right grip: place the course',
  'no-scan': 'No room scan. Right grip: place the course',
};
const HINT = 'Weave the books, pass the gates, kick the ball in the goal, reach the flag.';

const number = (n: number): string => Math.round(n).toLocaleString('en-US');
const clock = (s: number): string => {
  const minutes = Math.floor(s / 60);
  const seconds = s - minutes * 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds.toFixed(1)}`;
};

export class RunPanelSystem extends createSystem({}) {
  /** The menu panel is open (headset and phones; the desktop menu shows unless minimized). */
  menuOpen = false;
  /** Desktop: the menu folded to its title bar (its minimize button or M; the chevron, the title or M unfold it). */
  menuMinimized = readMenuMinimized();
  /** The unfolded menu's size in panel units (refreshed while it is unfolded), so the folded title bar keeps its scale. */
  private menuFull = { w: 450, h: 770 };
  /** 2D page: the scoreboard folded to its header (its minimize button; the chevron unfolds it). */
  scoreMinimized = readScoreMinimized();
  /** The unfolded scoreboard's size in panel units, so the folded header keeps its scale. */
  private scoreFull = { w: 470, h: 300 };
  /** The scoreboard's size as drawn now (folded or not), in panel units: the phone menu goes under it. */
  private scoreDrawn = { w: 0, h: 0 };
  /** The menu body's scrolling height last set (panel units; 0: no scrolling). */
  private menuScroll = -1;
  private texts = new Map<string, Text>();
  private shown = new Map<string, string>();
  private assets = new Map<string, UIKitMLAsset>();
  private lastRefresh = 0;
  private duck: DuckSystem | undefined;
  private course: CourseSystem | undefined;
  private room: RoomSystem | undefined;
  private playground: PlaygroundSystem | undefined;
  private nav: NavSystem | undefined;
  private cam: DuckCamSystem | undefined;
  private editor: EditorSystem | undefined;
  private unbind: (() => void)[] = [];
  private flat = true;
  private menuPlaced = false;
  private splashGone = false;
  private readonly v = new Vector3();
  private readonly head = new Vector3();
  private readonly forward = new Vector3();
  private readonly q = new Quaternion();
  private readonly parentQ = new Quaternion();
  private readonly m = new Matrix4();
  private static readonly UP = new Vector3(0, 1, 0);

  init(): void {
    this.checkXrSupport();
    this.duck = this.world.getSystem(DuckSystem);
    this.course = this.world.getSystem(CourseSystem);
    this.room = this.world.getSystem(RoomSystem);
    this.playground = this.world.getSystem(PlaygroundSystem);
    this.nav = this.world.getSystem(NavSystem);
    this.cam = this.world.getSystem(DuckCamSystem);
    this.editor = this.world.getSystem(EditorSystem);
    const onResize = () => this.layoutForScreen();
    window.addEventListener('resize', onResize);
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.flat = state === VisibilityState.NonImmersive;
        this.menuOpen = false;
        this.applyMode();
      }),
      this.world.activeLevel.subscribe(() => this.bind()),
      () => window.removeEventListener('resize', onResize),
      () => this.release(),
    );
  }

  /** Opens or closes the menu (headset and phones). */
  toggleMenu(open = !this.menuOpen): void {
    this.menuOpen = open;
    this.menuPlaced = false;
    this.applyMode();
  }

  /** Desktop: folds the menu to its title bar or unfolds it (remembered). */
  setMenuMinimized(minimized: boolean): void {
    this.menuMinimized = minimized;
    writeMenuMinimized(minimized);
    this.applyMode();
  }

  /** Phones: the menu body scrolls inside this height (panel units); 0 lets it grow (desktop). */
  private setMenuScroll(units: number): void {
    if (units === this.menuScroll) return;
    const body = this.texts.get('menu-body') as unknown as { setProperties(p: Record<string, unknown>): void } | undefined;
    if (!body) return;
    this.menuScroll = units;
    body.setProperties(units > 0 ? { maxHeight: units, overflow: 'scroll' } : { maxHeight: undefined, overflow: 'visible' });
  }

  /** 2D page: folds the scoreboard to its header or unfolds it (remembered). */
  setScoreMinimized(minimized: boolean): void {
    this.scoreMinimized = minimized;
    writeScoreMinimized(minimized);
    this.applyMode();
  }

  /** The 2D page of a phone or a desktop (not a headset's landing page, not in a headset). */
  private get page2d(): boolean {
    return this.flat && !this.landing;
  }

  /** A wide 2D page (not a headset's landing page, not a phone): the menu sits on the left. */
  private get desktopMenu(): boolean {
    return this.flat && !this.compact && !this.landing;
  }

  /** Find the level's panels and wire their controls (runs on every level change). */
  private bind(): void {
    this.release();
    this.texts.clear();
    this.shown.clear();
    this.assets.clear();
    for (const node of PANELS) {
      const asset = this.world.getSceneObject<UIKitMLAsset>(node);
      if (asset) {
        this.assets.set(node, asset);
        keepPanelOnTop(asset);
      }
    }
    if (this.assets.size === 0) return;
    const ids = [
      'run-state',
      'run-subtitle',
      'run-time',
      'run-score',
      'item-crumbs',
      'item-gates',
      'item-goal',
      'run-combo',
      'run-result',
      'menu-button',
      'menu-close',
      'menu-min',
      'menu-expand',
      'menu-body',
      'menu-title',
      'duck-mood',
      'auto-button',
      'cam-button',
      'edit-button',
      'editor-row',
      'ed-status',
      'xr-row',
      'run-github',
      'run-min',
      'run-expand',
      'run-body',
      'run-mood-row',
      'run-mood',
      'moves-label',
      'moves-row',
      ...Object.keys(PALETTE_BUTTONS),
      'ed-save',
      'ed-share',
      'ed-clear',
    ];
    for (const button of Object.keys(MOVE_NAMES)) {
      ids.push(`move-${button}`, `move-${button}-name`, `move-${button}-key`, `mv-${button}`);
    }
    for (let i = 0; i < CHIPS; i++) {
      ids.push(`pg-${i}`);
    }
    for (const id of ids) {
      const element = this.find(id);
      if (element) {
        element.name = id;
        this.texts.set(id, element);
      }
    }
    const listen = (id: string, handler: () => void) => {
      const element = this.find(id);
      if (!element) return;
      element.name = id;
      element.addEventListener('click', handler);
      this.unbind.push(() => element.removeEventListener('click', handler));
    };
    listen('restart-button', () => this.course?.restartRun());
    listen('auto-button', () => {
      const nav = this.nav;
      if (!nav) return;
      if (this.course?.freeRoam) {
        nav.task === 'explore' ? nav.stop() : nav.explore();
      } else {
        nav.task === 'course' ? nav.stop() : nav.runCourse();
      }
    });
    listen('cam-button', () => this.cam?.toggle());
    listen('edit-button', () => this.editor?.toggle());
    listen('menu-button', () => this.toggleMenu());
    listen('menu-close', () => this.toggleMenu(false));
    listen('menu-min', () => this.setMenuMinimized(true));
    listen('menu-expand', () => this.setMenuMinimized(false));
    listen('menu-title', () => {
      if (this.desktopMenu && this.menuMinimized) this.setMenuMinimized(false);
    });
    listen('run-github', () => window.open(REPO_URL, '_blank', 'noopener'));
    listen('run-min', () => this.setScoreMinimized(true));
    listen('run-expand', () => this.setScoreMinimized(false));
    for (const [id, asset] of Object.entries(PALETTE_BUTTONS)) {
      listen(id, () => void this.editor?.add(asset));
    }
    listen('ed-save', () => this.editor?.save());
    listen('ed-share', () => void this.editor?.share());
    listen('ed-clear', () => this.editor?.clear());
    for (let i = 0; i < CHIPS; i++) {
      listen(`pg-${i}`, () => {
        const info = this.playground?.all[i];
        if (!info) return;
        void this.playground?.load(info.id);
        // In a headset or on a phone the menu gets out of the way of the new course.
        if (!this.flat || this.narrow) this.toggleMenu(false);
      });
    }
    for (const button of Object.keys(MOVE_NAMES) as MoveButton[]) {
      listen(`move-${button}`, () => this.duck?.fireMove(button));
      listen(`mv-${button}`, () => this.duck?.fireMove(button));
    }
    listen('xr-button', () => this.world.launchXR({ sessionMode: SessionMode.ImmersiveAR }));
    listen('vr-button', () => this.world.launchXR({ sessionMode: SessionMode.ImmersiveVR }));
    this.menuPlaced = false;
    this.menuScroll = -1; // new elements: set the scrolling again
    this.scoreDrawn = { w: 0, h: 0 };
    this.applyMode();
  }

  private find(id: string): Text | null {
    for (const asset of this.assets.values()) {
      const element = asset.getElementById<Text>(id);
      if (element) return element;
    }
    return null;
  }

  private release(): void {
    for (const off of this.unbind) off();
    this.unbind = [];
  }

  private get narrow(): boolean {
    return window.innerWidth < NARROW_SCREEN_PX;
  }

  /**
   * Which immersive sessions this browser can open (unknown counts as no).
   * A desktop without a headset has neither; phones and tablets are treated as
   * having neither too: their AR is not the headset experience this is made for.
   * A PC with a tethered headset has VR; the dev emulator has both.
   */
  private xrSupport = { ar: false, vr: false };

  private checkXrSupport(): void {
    const xr = navigator.xr;
    if (!xr) return;
    const handheld = !headsetLanding() && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
    if (handheld) return;
    void Promise.all([
      xr.isSessionSupported('immersive-ar').catch(() => false),
      xr.isSessionSupported('immersive-vr').catch(() => false),
    ]).then(([ar, vr]) => {
      this.xrSupport = { ar, vr };
      this.applyMode();
    });
  }

  /** A headset's own browser: the 2D page is a landing page with a large menu (see page-mode.ts). */
  private readonly landing = headsetLanding();

  /** Phones, and tablets with the touch controls: the compact layout that keeps clear of them. */
  private get compact(): boolean {
    return !this.landing && (this.narrow || touchControls.shown);
  }

  /** What shows where for the current mode: 2D page (wide or narrow) or headset. */
  private applyMode(): void {
    const xr = !this.flat;
    const narrow = this.flat && this.compact;
    const desktop = this.desktopMenu;
    const folded = desktop && this.menuMinimized;
    const menuShown = desktop || (this.flat && !narrow) || this.menuOpen;
    this.panelVisible(MENU_NODE, menuShown);
    // The move bar is the headset's: the 2D page has the moves on the menu. It is shown on the
    // landing page too: its text must first draw outside XR (IWSDK 1.1.0-rc.1 leaves textures
    // first uploaded under the Quest's multiview blank).
    const page2d = this.page2d;
    this.panelVisible(MOVES_NODE, !page2d);
    this.panelVisible(LAB_NODE, !(this.flat && this.landing)); // no room beside the landing menu
    this.display('moves-label', page2d);
    this.display('moves-row', page2d);
    this.display('run-github', this.flat); // a link cannot open from inside a headset session
    const scoreFolded = page2d && this.scoreMinimized;
    this.display('run-min', page2d && !scoreFolded);
    this.display('run-expand', scoreFolded);
    this.display('run-body', !scoreFolded);
    this.display('run-mood-row', page2d);
    this.display('menu-button', xr || narrow);
    this.display('menu-close', xr || narrow);
    this.display('menu-min', desktop && !folded);
    this.display('menu-expand', folded);
    this.display('menu-body', !folded);
    // Enter MR / Enter VR only where this browser can open that session.
    const { ar, vr } = this.xrSupport;
    this.display('xr-row', this.flat && this.world.xrEnabled && (ar || vr));
    this.display('xr-button', ar);
    this.display('vr-button', vr);
    for (const button of Object.keys(MOVE_NAMES) as MoveButton[]) {
      this.text(`move-${button}-key`, xr ? MOVE_BUTTONS_XR[button] : MOVE_KEYS[button]);
    }
    this.layoutForScreen();
  }

  private panelVisible(node: string, visible: boolean): void {
    const asset = this.assets.get(node) ?? this.world.getSceneObject<UIKitMLAsset>(node);
    if (asset && asset.document.visible !== visible) asset.document.visible = visible;
  }

  private screenSpace(node: string): Entity | null {
    try {
      const entity = this.world.requireSceneEntity(node);
      return entity.hasComponent(ScreenSpace) ? entity : null;
    } catch {
      return null;
    }
  }

  /**
   * The 2D page. Desktop: the four corners (menu top left over the dev lab
   * panel, scoreboard top right over the robot panel, move bar bottom middle),
   * none touching. Phones and touch tablets: a full-width scoreboard and a
   * centred menu, clear of the touch controls. A headset's landing page: a
   * large menu down the left, Enter MR / Enter VR at its top.
   */
  private layoutForScreen(): void {
    const compact = this.compact;
    const canvas = this.world.renderer.domElement;
    const W = canvas.clientWidth || window.innerWidth;
    const H = canvas.clientHeight || window.innerHeight;
    const portrait = compact && W <= H;
    // Scoreboard: across the top of a phone held upright, the top right corner otherwise.
    // Folded to its header it keeps the width it is drawn at unfolded, so the header keeps
    // its scale. Phone sizes are worked out from the canvas: a phone browser's 100vh (what
    // percentages resolve against) reaches under its toolbars.
    const scoreBox = portrait ? { w: 0.94, h: 0.24, top: 8 } : compact ? { w: 0.3, h: 0.36, top: 8 } : { w: 0.27, h: 0.32, top: 20 };
    const scoreW = Math.min(scoreBox.w * W, (scoreBox.h * H * this.scoreFull.w) / this.scoreFull.h);
    const scoreFolded = this.page2d && this.scoreMinimized;
    const score = this.screenSpace(SCORE_NODE);
    if (score) {
      score.setValue(ScreenSpace, 'width', scoreFolded ? `${Math.round(scoreW)}px` : `${Math.round(scoreBox.w * W)}px`);
      score.setValue(ScreenSpace, 'height', `${Math.round(scoreBox.h * H)}px`);
      score.setValue(ScreenSpace, 'right', compact ? '3vw' : '20px');
      score.setValue(ScreenSpace, 'top', `${scoreBox.top}px`);
    }
    // Where the scoreboard ends as drawn now (folded or not), for the phone menu under it.
    const drawn = this.scoreDrawn;
    const scoreBottom = scoreBox.top + (drawn.w > 0 ? (scoreW * drawn.h) / drawn.w : (scoreW * this.scoreFull.h) / this.scoreFull.w);
    let scroll = 0; // the menu body's height in panel units when it has to scroll (phones), 0: no scrolling
    const menu = this.screenSpace(MENU_NODE);
    if (menu) {
      // Desktop: a roomy menu down the left; with the dev lab panel under it, a smaller box.
      const labUnder = !!this.screenSpace(LAB_NODE);
      let box = this.landing
        ? { width: '30vw', height: '74%', left: '3vw', top: '5%' }
        : labUnder
          ? { width: '26vw', height: '46%', left: '20px', top: '20px' }
          : { width: '30vw', height: '68%', left: '20px', top: '20px' };
      if (compact) {
        // Phones: the full width between the scoreboard and the stick or Pip cam (held upright),
        // or right of the stick (on its side), drawn at a readable scale: what does not fit scrolls.
        const camTop = H - PHONE_EDGE_PX - PHONE_CAM_HEIGHT * H;
        const stickTop = H - STICK_ZONE_PX;
        const top = portrait ? Math.round(scoreBottom + 10) : 8;
        const left = portrait ? Math.round(0.03 * W) : STICK_RIGHT_PX;
        const right = portrait ? Math.round(0.97 * W) : Math.round(W - 0.03 * W - Math.max(scoreW, (PHONE_CAM_HEIGHT * H * 3) / 4) - 12);
        const bottom = portrait ? Math.min(camTop, stickTop) - 10 : H - 8;
        const width = Math.max(120, right - left);
        const height = Math.max(120, bottom - top);
        box = { width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px` };
        const perUnit = Math.min(width / MENU_CARD_UNITS, 1); // px per panel unit when drawn full width
        scroll = Math.max(160, Math.floor(height / perUnit - MENU_CHROME_UNITS));
      } else if (this.desktopMenu && this.menuMinimized) {
        // Folded to its title bar: as wide as the unfolded menu is drawn, so the bar keeps its scale.
        const boxW = (labUnder ? 0.26 : 0.3) * W;
        const boxH = (labUnder ? 0.46 : 0.68) * H;
        box = { ...box, width: `${Math.round(Math.min(boxW, (boxH * this.menuFull.w) / this.menuFull.h))}px` };
      }
      menu.setValue(ScreenSpace, 'width', box.width);
      menu.setValue(ScreenSpace, 'height', box.height);
      menu.setValue(ScreenSpace, 'left', box.left);
      menu.setValue(ScreenSpace, 'top', box.top);
    }
    this.setMenuScroll(scroll);
    // The dev lab panel fills the rest of the left side under the menu, 20 px clear of it.
    const lab = this.screenSpace(LAB_NODE);
    if (lab && !compact && !this.landing) {
      lab.setValue(ScreenSpace, 'width', '24vw');
      lab.setValue(ScreenSpace, 'height', 'calc(54% - 60px)');
      lab.setValue(ScreenSpace, 'left', '20px');
      lab.setValue(ScreenSpace, 'bottom', '20px');
    }
  }

  update(): void {
    // Headset: a left thumbstick click (or a menu button, where a controller has one) opens and closes the menu.
    const left = this.input.xr.gamepads.left;
    if (!this.flat && (left?.getButtonDown(InputComponent.Thumbstick) || left?.getButtonDown(InputComponent.Menu))) {
      this.toggleMenu();
    }
    if (this.input.keyboard.getKeyDown('KeyM')) {
      if (this.desktopMenu) this.setMenuMinimized(!this.menuMinimized);
      else this.toggleMenu();
    }
    headsetMenu.span = 0; // placeMenuBeside sets it while the menu hangs beside the scoreboard
    if (!this.flat && this.menuOpen) this.placeMenu(); // beside the scoreboard, wherever the course has moved it

    const duck = this.duck;
    const course = this.course;
    const now = performance.now();
    if (!duck || !course || now - this.lastRefresh < REFRESH_MS) {
      return;
    }
    this.lastRefresh = now;
    // The page splash (index.html) fades once the duck stands (or after 20 s, to show any error).
    if (!this.splashGone && (duck.hasPose || now > 20000)) {
      this.splashGone = true;
      const splash = document.getElementById('splash');
      splash?.classList.add('done');
      setTimeout(() => splash?.remove(), 700);
    }
    // The headset's move bar (and the landing page's: see applyMode); the 2D page has the moves on the menu.
    this.panelVisible(MOVES_NODE, !this.page2d);
    if (!this.flat) this.stackMoves();

    const playground = this.playground;
    const info = playground?.info();
    const loading = playground?.loading ? playground.info(playground.loading) : undefined;
    const state = course.state;
    const stars = '*'.repeat(course.stars);
    const freeRoam = course.freeRoam;
    const stateText = loading
      ? `Loading ${loading.title}...`
      : freeRoam
        ? 'Free roam'
        : state === 'ready'
          ? 'Walk to start'
          : state === 'running'
            ? 'GO!'
            : `FINISHED ${stars}`;
    this.text('run-state', stateText);
    this.text('auto-button', freeRoam ? 'Explore' : 'Auto');
    this.style('run-state', loading ? STATE_LOADING_COLOR : STATE_COLOR[state]);
    const room = this.room;
    const roomText = room
      ? room.state === 'placed' && room.physicsSummary
        ? `${ROOM_TEXT.placed}. Solid: ${room.physicsSummary}`
        : ROOM_TEXT[room.state]
      : '';
    this.text(
      'run-subtitle',
      roomText || (info ? (info.par >= 600 ? info.title : `${info.title} | par ${info.par.toFixed(0)} s`) : 'Living room course'),
    );
    this.text('run-time', clock(course.elapsed));
    this.text('run-score', number(course.score));
    if (course.comboCount > 0) {
      const multiplier = Math.min(course.comboCount, MAX_MULTIPLIER);
      const total = number(course.comboPoints * multiplier);
      this.text('run-combo', `${course.comboNames.join(' + ')}  x${multiplier} = ${total}`);
    } else if (course.lastBank > 0 && state === 'running') {
      this.text('run-combo', `Banked +${number(course.lastBank)}`);
    } else {
      this.text('run-combo', ' ');
    }
    this.text('item-crumbs', `Crumbs  ${course.crumbsGot}/${course.crumbsTotal}`);
    this.text('item-gates', `Gates  ${course.gatesGot}/${course.gatesTotal}`);
    this.text('item-goal', `Goal  ${course.goalsGot}/${course.goalsTotal}`);
    const best = playground?.best();
    if (state === 'finished') {
      const fresh = playground?.newBest ? 'NEW BEST! ' : '';
      this.text(
        'run-result',
        `${fresh}${course.stars} of 3 stars | time bonus +${number(course.timeBonus)} | ` +
          `best combo ${number(course.bestCombo)} | falls ${course.falls}`,
      );
    } else if (state === 'running') {
      this.text(
        'run-result',
        `Par ${course.par.toFixed(0)} s | best combo ${number(course.bestCombo)} | falls ${course.falls}`,
      );
    } else if (best) {
      this.text(
        'run-result',
        `Best here: ${number(best.score)} pts in ${clock(best.time)} | model ${best.policyHash || best.pack || '?'}`,
      );
    } else {
      this.text('run-result', info?.credits ? `${info.blurb} ${info.credits}.` : (info?.blurb ?? HINT));
    }
    const mood = this.nav?.status || duck.status;
    this.text('duck-mood', mood);
    this.text('run-mood', mood);
    this.toggle('auto-button', this.nav?.task === 'course' || this.nav?.task === 'explore');
    this.toggle('cam-button', this.cam?.shown ?? false);
    this.toggle('menu-button', this.menuOpen);
    if (this.desktopMenu && !this.menuMinimized) {
      const size = (this.assets.get(MENU_NODE)?.document as unknown as { computedSize?: { width: number; height: number } } | undefined)?.computedSize;
      if (size && size.width > 0 && size.height > 0) {
        this.menuFull.w = size.width;
        this.menuFull.h = size.height;
      }
    }
    if (this.page2d) {
      const size = (this.assets.get(SCORE_NODE)?.document as unknown as { computedSize?: { width: number; height: number } } | undefined)?.computedSize;
      if (size && size.width > 0 && size.height > 0 && (size.width !== this.scoreDrawn.w || size.height !== this.scoreDrawn.h)) {
        this.scoreDrawn = { w: size.width, h: size.height };
        if (!this.scoreMinimized) this.scoreFull = { w: size.width, h: size.height };
        this.layoutForScreen(); // folded or unfolded: the phone menu under it follows its height
      }
    }

    // Playground chips: title, a star when a record exists, the loaded one highlighted.
    // Until the list is known every chip keeps its "..." placeholder; after that an
    // unused chip is taken out of the layout instead of leaving an empty pill.
    const list = playground?.all ?? [];
    const known = (playground?.list.length ?? 0) > 0;
    for (let i = 0; i < CHIPS; i++) {
      const entry = known ? list[i] : undefined;
      const id = `pg-${i}`;
      if (!entry) {
        this.display(id, !known);
        continue;
      }
      this.display(id, true);
      const record = playground?.best(entry.id);
      this.text(id, `${record ? '* ' : ''}${entry.title}`);
      const active = entry.id === playground?.current;
      this.style(id, active ? YELLOW : CHIP_IDLE);
      this.color(id, active ? INK : CREAM);
    }

    // The editor: its palette row and status show only while editing.
    const editing = this.editor?.editing ?? false;
    this.display('editor-row', editing);
    this.display('ed-status', editing);
    if (editing) this.text('ed-status', this.editor?.status ?? '');
    this.toggle('edit-button', editing);

    const mode = duck.sim?.mode;
    const seated = mode === 'sitting' || mode === 'sitting-down';
    for (const button of Object.keys(MOVE_NAMES) as MoveButton[]) {
      const moveState = duck.moveState(button);
      const active =
        (button === 'kick' && mode === 'kick') ||
        (button === 'roll' && mode === 'roll') ||
        (button === 'peck' && mode === 'peck') ||
        (button === 'bow' && mode === 'motion') ||
        (button === 'sit' && (seated || mode === 'standing-up'));
      let color = LOADING_COLOR;
      if (active) color = ACTIVE_COLOR;
      else if (moveState === 'ready') color = READY_COLOR[button];
      else if (moveState === 'busy') color = BUSY_COLOR;
      this.style(`move-${button}`, color);
      this.color(`move-${button}-name`, active || moveState === 'ready' ? INK : MOVE_TEXT_DIM);
      let label = MOVE_NAMES[button];
      if (moveState === 'loading') label = 'WAIT';
      else if (button === 'sit' && seated) label = 'STAND';
      this.text(`move-${button}-name`, label);
      // The 2D page's copy on the menu, with its key on a desktop.
      this.style(`mv-${button}`, color);
      this.color(`mv-${button}`, active || moveState === 'ready' ? INK : MOVE_TEXT_DIM);
      this.text(`mv-${button}`, this.compact ? label : `${label} (${MOVE_KEYS[button]})`);
    }
  }

  /**
   * Headset: the move bar hangs just under the scoreboard, on the same slope,
   * whatever the scoreboard's height (its result line wraps to more lines
   * on some playgrounds), so the two never overlap.
   */
  private stackMoves(): void {
    const score = this.assets.get(SCORE_NODE)?.document.computedSize;
    const moves = this.assets.get(MOVES_NODE)?.document.computedSize;
    if (!score || !moves) return;
    let scoreHost: Object3D | undefined;
    let movesHost: Object3D | undefined;
    try {
      scoreHost = this.world.requireSceneEntity(SCORE_NODE).object3D;
      movesHost = this.world.requireSceneEntity(MOVES_NODE).object3D;
    } catch {
      return;
    }
    if (!scoreHost || !movesHost || scoreHost.parent !== movesHost.parent) return;
    const below = (score.height * 0.01 * scoreHost.scale.y) / 2 + MOVES_GAP + (moves.height * 0.01 * movesHost.scale.y) / 2;
    movesHost.quaternion.copy(scoreHost.quaternion);
    this.v.set(0, -below, 0).applyQuaternion(scoreHost.quaternion);
    movesHost.position.copy(scoreHost.position).add(this.v);
  }

  /** Headset: beside the scoreboard (see MENU_GAP), or, without one, in front of the player. */
  private placeMenu(): void {
    const menu = this.host(MENU_NODE);
    if (!menu) return;
    if (this.placeMenuBeside(menu)) return;
    if (this.menuPlaced) return;
    this.placeMenuInFront(menu);
    this.menuPlaced = true;
  }

  /** On the scoreboard's right, in its plane, centred on it and the move bar; false without a scoreboard. */
  private placeMenuBeside(menu: Object3D): boolean {
    const scoreHost = this.host(SCORE_NODE);
    const score = this.assets.get(SCORE_NODE)?.document.computedSize;
    const own = this.assets.get(MENU_NODE)?.document.computedSize;
    if (!scoreHost || !score || !own || !(score.width > 0) || !(own.width > 0)) return false;
    let half = (score.width * 0.01 * scoreHost.scale.x) / 2;
    let down = 0;
    const movesHost = this.host(MOVES_NODE);
    const moves = this.assets.get(MOVES_NODE)?.document;
    if (movesHost && moves?.visible && moves.computedSize && moves.computedSize.width > 0) {
      half = Math.max(half, (moves.computedSize.width * 0.01 * movesHost.scale.x) / 2);
      down = (MOVES_GAP + moves.computedSize.height * 0.01 * movesHost.scale.y) / 2;
    }
    menu.scale.setScalar(MENU_SCALE);
    const width = own.width * 0.01 * MENU_SCALE;
    const across = half + MENU_GAP + width / 2;
    headsetMenu.span = MENU_GAP + width;
    scoreHost.updateWorldMatrix(true, false);
    scoreHost.getWorldPosition(this.head);
    scoreHost.getWorldQuaternion(this.q);
    this.v.set(across, -down, 0).applyQuaternion(this.q).add(this.head);
    menu.position.copy(this.v);
    if (menu.parent) {
      menu.parent.updateWorldMatrix(true, false);
      menu.parent.worldToLocal(menu.position);
      menu.parent.getWorldQuaternion(this.parentQ).invert();
      menu.quaternion.copy(this.parentQ).multiply(this.q);
    } else {
      menu.quaternion.copy(this.q);
    }
    return true;
  }

  /** In front of the player, to the left and a little below the eyes, facing them. */
  private placeMenuInFront(host: Object3D): void {
    const head = this.player.head;
    head.getWorldPosition(this.head);
    // The head looks down its -Z (true for a camera and for a plain head object alike).
    this.forward.set(0, 0, -1).applyQuaternion(head.getWorldQuaternion(this.q));
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    this.forward.applyAxisAngle(RunPanelSystem.UP, MENU_LEFT); // + turns -Z towards -X: the player's left
    this.v.copy(this.head).addScaledVector(this.forward, MENU_DISTANCE);
    this.v.y -= MENU_BELOW;
    host.scale.setScalar(MENU_NEAR_SCALE);
    host.position.copy(this.v);
    if (host.parent) {
      host.parent.updateWorldMatrix(true, false);
      host.parent.worldToLocal(host.position);
    }
    // Face the eyes: +Z of the panel towards the head.
    this.m.lookAt(this.head, this.v, RunPanelSystem.UP);
    this.q.setFromRotationMatrix(this.m);
    if (host.parent) {
      host.parent.getWorldQuaternion(this.parentQ).invert();
      host.quaternion.copy(this.parentQ).multiply(this.q);
    } else {
      host.quaternion.copy(this.q);
    }
  }

  /** A panel's scene node object, if this level has it. */
  private host(node: string): Object3D | undefined {
    try {
      return this.world.requireSceneEntity(node).object3D ?? undefined;
    } catch {
      return undefined;
    }
  }

  private text(id: string, value: string): void {
    const element = this.texts.get(id);
    if (element && this.shown.get(id) !== value) {
      this.shown.set(id, value);
      element.setProperties({ text: value });
    }
  }

  /** Shows or hides an element (UIKit display). */
  private display(id: string, shown: boolean): void {
    const key = `${id}:display`;
    const value = shown ? 'flex' : 'none';
    const element = this.texts.get(id);
    if (element && this.shown.get(key) !== value) {
      this.shown.set(key, value);
      element.setProperties({ display: value });
    }
  }

  private style(id: string, backgroundColor: string): void {
    const key = `${id}:bg`;
    const element = this.texts.get(id);
    if (element && this.shown.get(key) !== backgroundColor) {
      this.shown.set(key, backgroundColor);
      element.setProperties({ backgroundColor });
    }
  }

  /** A toggle button: outlined cream when off, filled yellow with ink text when on. */
  private toggle(id: string, on: boolean): void {
    this.style(id, on ? YELLOW : CHIP_IDLE);
    this.color(id, on ? INK : CREAM);
    const key = `${id}:border`;
    const borderColor = on ? YELLOW : TOGGLE_BORDER_IDLE;
    const element = this.texts.get(id);
    if (element && this.shown.get(key) !== borderColor) {
      this.shown.set(key, borderColor);
      element.setProperties({ borderColor });
    }
  }

  private color(id: string, color: string): void {
    const key = `${id}:fg`;
    const element = this.texts.get(id);
    if (element && this.shown.get(key) !== color) {
      this.shown.set(key, color);
      element.setProperties({ color });
    }
  }
}
