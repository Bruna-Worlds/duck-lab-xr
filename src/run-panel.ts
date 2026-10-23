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
 * menu opens in front of the player with a left thumbstick click (Quest
 * keeps its menu button for the system) or the scoreboard's Menu chip. Text refreshes ten times a second and only
 * what changed is written.
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
import { touchControls } from './input/touch-controls.js';
import { readMenuMinimized, writeMenuMinimized } from './ui/menu-state.js';
import { keepPanelOnTop } from './ui/on-top.js';
import { headsetLanding } from './ui/page-mode.js';
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
/** Below this width the scoreboard spans the screen top and the menu opens on demand. */
const NARROW_SCREEN_PX = 720;
/**
 * Headset menu: off to the left and a little low, so the course in front
 * stays in view: distance from the eyes and drop below them (metres), how
 * far round to the left (radians), and its size (about 32 cm wide).
 */
const MENU_DISTANCE = 0.55;
const MENU_BELOW = 0.16;
const MENU_LEFT = (30 * Math.PI) / 180;
const MENU_SCALE = 0.08;
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
      ...Object.keys(PALETTE_BUTTONS),
      'ed-save',
      'ed-share',
      'ed-clear',
    ];
    for (const button of Object.keys(MOVE_NAMES)) {
      ids.push(`move-${button}`, `move-${button}-name`, `move-${button}-key`);
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
    }
    listen('xr-button', () => this.world.launchXR({ sessionMode: SessionMode.ImmersiveAR }));
    listen('vr-button', () => this.world.launchXR({ sessionMode: SessionMode.ImmersiveVR }));
    this.menuPlaced = false;
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
    // Shown on the landing page too: its text must first draw outside XR (IWSDK 1.1.0-rc.1
    // leaves textures first uploaded under the Quest's multiview blank).
    this.panelVisible(MOVES_NODE, !(this.flat && touchControls.shown));
    this.panelVisible(LAB_NODE, !(this.flat && this.landing)); // no room beside the landing menu
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
    const score = this.screenSpace(SCORE_NODE);
    if (score) {
      score.setValue(ScreenSpace, 'width', compact ? '94vw' : '27vw');
      score.setValue(ScreenSpace, 'height', compact ? '24%' : '32%');
      score.setValue(ScreenSpace, 'right', compact ? '3vw' : '20px');
      score.setValue(ScreenSpace, 'top', compact ? '8px' : '20px');
    }
    const menu = this.screenSpace(MENU_NODE);
    if (menu) {
      // Desktop: a roomy menu down the left; with the dev lab panel under it, a smaller box.
      const labUnder = !!this.screenSpace(LAB_NODE);
      let box = this.landing
        ? { width: '30vw', height: '74%', left: '3vw', top: '5%' }
        : compact
          ? { width: '94vw', height: '40%', left: '3vw', top: '27%' }
          : labUnder
            ? { width: '26vw', height: '46%', left: '20px', top: '20px' }
            : { width: '30vw', height: '68%', left: '20px', top: '20px' };
      if (this.desktopMenu && this.menuMinimized) {
        // Folded to its title bar: as wide as the unfolded menu is drawn, so the bar keeps its scale.
        const canvas = this.world.renderer.domElement;
        const W = canvas.clientWidth || window.innerWidth;
        const H = canvas.clientHeight || window.innerHeight;
        const boxW = (labUnder ? 0.26 : 0.3) * W;
        const boxH = (labUnder ? 0.46 : 0.68) * H;
        box = { ...box, width: `${Math.round(Math.min(boxW, (boxH * this.menuFull.w) / this.menuFull.h))}px` };
      }
      menu.setValue(ScreenSpace, 'width', box.width);
      menu.setValue(ScreenSpace, 'height', box.height);
      menu.setValue(ScreenSpace, 'left', box.left);
      menu.setValue(ScreenSpace, 'top', box.top);
    }
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
    if (!this.flat && this.menuOpen && !this.menuPlaced) this.placeMenu();

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
    // Shown on the landing page too: its text must first draw outside XR (IWSDK 1.1.0-rc.1
    // leaves textures first uploaded under the Quest's multiview blank).
    this.panelVisible(MOVES_NODE, !(this.flat && touchControls.shown));
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
    this.text('duck-mood', this.nav?.status || duck.status);
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

  /** Headset: the menu opens to the player's left, a little below the eyes, facing them. */
  private placeMenu(): void {
    let host: Object3D | undefined;
    try {
      host = this.world.requireSceneEntity(MENU_NODE).object3D;
    } catch {
      return;
    }
    if (!host) return;
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
    host.scale.setScalar(MENU_SCALE);
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
    this.menuPlaced = true;
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
