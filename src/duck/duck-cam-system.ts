// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck cam: what the duck sees. A small camera rides in the duck's head and
 * renders the scene a few times a second into a texture, which the robot
 * panel (src/ui/robot-panel-system.ts) shows. In mixed reality the real room
 * cannot be filmed, so the feed shows the room as the duck knows it: a floor
 * grid on a dark backdrop, the scanned walls, doors and windows as slabs, the
 * scanned furniture as soft blue volumes and the sensed terrain as blocks
 * (room model: src/room/room-system.ts).
 *
 * Two views (the robot panel's MOTION and VISION tabs):
 *  - motion: that world model, the room as the walking brain's physics knows it;
 *  - vision: what a camera would see (in mixed reality a solid room with a
 *    floor), with the objects in view labelled (src/duck/duck-vision.ts).
 * V or the menu's Cam button shows and hides the panel.
 */
import {
  BackSide,
  BufferGeometry,
  CircleGeometry,
  Color,
  createSystem,
  type Entity,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from '@iwsdk/core';
import { RoomSystem } from '../room/room-system.js';
import { TerrainSystem } from '../room/terrain-system.js';
import { DEFAULT_POSE } from './duck-constants.js';
import type { DuckRig } from './duck-rig.js';
import { DuckStage } from './duck-stage.js';
import { DuckSystem } from './duck-system.js';
import { DuckVision } from './duck-vision.js';

const RENDER_MS = 125; // 8 frames a second is plenty for a robot's-eye view
const WIDTH = 256;
const HEIGHT = 192;
/** The head link the camera rides in, by pack (Pollen's Microduck: yaw_roll_motion, after neck_pitch). */
const HEAD_NAMES = ['yaw_roll_motion', 'head', 'head_roll', 'head_yaw', 'head_pitch', 'neck_pitch', 'neck'];
/** Mixed reality backdrop and floor grid of the duck's room model. */
const MR_BACKDROP = 0x141529;
const GRID_HALF = 4; // metres either side of the stage origin
const GRID_STEP = 0.25;
const CAM_ONLY_LAYER = 5;
/** Vision view in mixed reality: a light room (ceiling-like backdrop) on a floor. */
const VISION_BACKDROP = 0xd8d2c8;
const VISION_FLOOR = 0xb49a7a;
const COLLECT_MS = 2000; // look for new labelled objects this often (and on level or scan changes)
const VIEW_KEY = 'duckdash.cam.view';

export type CamView = 'motion' | 'vision';

const readView = (): CamView => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'vision' ? 'vision' : 'motion';
  } catch {
    return 'motion';
  }
};

/** A floor grid (stage frame, y up), brighter every metre. */
function floorGrid(): LineSegments {
  const minor: number[] = [];
  const major: number[] = [];
  for (let k = -GRID_HALF / GRID_STEP; k <= GRID_HALF / GRID_STEP; k++) {
    const c = k * GRID_STEP;
    const into = k % 4 === 0 ? major : minor;
    into.push(c, 0.002, -GRID_HALF, c, 0.002, GRID_HALF, -GRID_HALF, 0.002, c, GRID_HALF, 0.002, c);
  }
  const positions = [...major, ...minor];
  const colors: number[] = [];
  const bright = new Color(0x6fb7ff);
  const faint = new Color(0x6fb7ff).multiplyScalar(0.45);
  for (let i = 0; i < positions.length / 3; i++) {
    const c = i < major.length / 3 ? bright : faint;
    colors.push(c.r, c.g, c.b);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const grid = new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 }));
  grid.name = 'duck-cam-grid';
  grid.visible = false;
  grid.frustumCulled = false;
  // Its own layer: only the duck cam draws it, and no pointer ray ever hits it.
  grid.layers.set(CAM_ONLY_LAYER);
  return grid;
}

export class DuckCamSystem extends createSystem({
  stages: { required: [DuckStage] },
}) {
  /** Player toggle for the robot panel (on by default). */
  shown = true;
  /** Set by the robot panel while its feed is on screen; nothing renders otherwise. */
  feedWanted = false;
  /** Frames rendered so far (for tests). */
  frames = 0;
  /** What the feed shows (robot panel tabs): the physics' world model, or a camera view with labels. */
  view: CamView = readView();
  /** The vision view's labelled boxes. */
  vision!: DuckVision;
  private duck: DuckSystem | undefined;
  private room: RoomSystem | undefined;
  private terrain: TerrainSystem | undefined;
  private eye!: PerspectiveCamera;
  private target!: WebGLRenderTarget;
  private rigRoot: Object3D | null = null;
  private head: Object3D | null = null;
  private lastRender = 0;
  private basis!: Matrix4;
  /** Objects that show the feed texture: hidden while rendering into it. */
  private readonly hidden = new Set<Object3D>();
  private grid!: LineSegments;
  /** Mixed reality backdrop: three.js clears to transparent in a passthrough session, so the feed draws its own. */
  private backdrop!: Mesh;
  private readonly clearColor = new Color();
  /** The environment's sky dome, hidden in the mixed reality feed (cached; re-found if replaced). */
  private sky: Object3D | null = null;
  /** The vision view's floor in mixed reality (the motion view draws a grid). */
  private floor!: Mesh;
  private visionDirty = true;
  /** The head camera is levelled once per duck (for tests). */
  eyeLevelled = false;
  private readonly q1 = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly offset = new Vector3();
  private readonly v1 = new Vector3();
  private readonly v2 = new Vector3();
  private lastCollect = 0;
  private collectedScan = -1;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.room = this.world.getSystem(RoomSystem);
    this.terrain = this.world.getSystem(TerrainSystem);
    this.basis = new Matrix4();
    this.eye = new PerspectiveCamera(75, WIDTH / HEIGHT, 0.015, 12);
    this.eye.name = 'duck-cam';
    this.eye.layers.enable(CAM_ONLY_LAYER);
    // Bodies live in the duck's MuJoCo frame: look along +x with +z up.
    this.basis.makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0));
    this.eye.quaternion.setFromRotationMatrix(this.basis);
    this.eye.position.set(0.08, 0, 0.13); // until the head is found: roughly the eyes
    this.target = new WebGLRenderTarget(WIDTH, HEIGHT, { depthBuffer: true });
    this.target.texture.colorSpace = SRGBColorSpace;
    this.target.texture.name = 'duck-cam-feed';
    this.grid = floorGrid();
    this.backdrop = new Mesh(
      new SphereGeometry(11, 24, 12),
      new MeshBasicMaterial({ color: MR_BACKDROP, side: BackSide, depthWrite: false, fog: false }),
    );
    this.backdrop.name = 'duck-cam-backdrop';
    this.backdrop.layers.set(CAM_ONLY_LAYER);
    this.backdrop.renderOrder = -1000;
    this.backdrop.frustumCulled = false;
    this.backdrop.visible = false;
    this.floor = new Mesh(
      new CircleGeometry(GRID_HALF + 2, 48),
      new MeshStandardMaterial({ color: VISION_FLOOR, roughness: 0.9, metalness: 0 }),
    );
    this.floor.name = 'duck-cam-floor';
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = 0.001;
    this.floor.layers.set(CAM_ONLY_LAYER);
    this.floor.visible = false;
    this.vision = new DuckVision(WIDTH, HEIGHT);
    this.cleanupFuncs.push(
      this.queries.stages.subscribe('qualify', () => {
        this.visionDirty = true; // a new level: new things to name
      }),
    );
    this.queries.stages.subscribe('disqualify', () => {
      this.rigRoot = null; // went with the stage
    });
    this.cleanupFuncs.push(() => {
      this.target.dispose();
      this.grid.geometry.dispose();
      (this.grid.material as LineBasicMaterial).dispose();
      this.backdrop.geometry.dispose();
      (this.backdrop.material as MeshBasicMaterial).dispose();
      this.floor.geometry.dispose();
      (this.floor.material as MeshStandardMaterial).dispose();
      this.vision.dispose();
    });
  }

  toggle(): void {
    this.shown = !this.shown;
  }

  /** Switches the feed between the motion and vision views (kept for next time). */
  setView(view: CamView): void {
    if (view === this.view) return;
    this.view = view;
    this.visionDirty = true;
    this.vision.clear();
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // storage blocked
    }
  }

  /** True while the robot panel is switched on. */
  get visible(): boolean {
    return this.shown;
  }

  /** The feed: a render target texture, updated a few times a second. */
  get texture(): Texture {
    return this.target.texture;
  }

  /** Keeps an object (a panel showing the feed) out of the feed's own renders. */
  hideDuringRender(object: Object3D, hide = true): void {
    if (hide) this.hidden.add(object);
    else this.hidden.delete(object);
  }

  update(): void {
    if (this.input.keyboard.getKeyDown('KeyV')) this.toggle();
    const duck = this.duck;
    const rig = duck?.rig;
    const stageEntity = this.queries.stages.entities.values().next().value as Entity | undefined;
    if (!duck?.hasPose || !rig || !stageEntity) {
      return;
    }
    if (this.rigRoot !== rig.root) {
      // A new duck: the camera rides in its head, so it pans, tilts and
      // rolls with the neck and head joints like a real head camera.
      this.rigRoot = rig.root;
      this.head = null;
      for (const name of HEAD_NAMES) {
        this.head = rig.root.getObjectByName(name) ?? null;
        if (this.head) break;
      }
      this.mountEye(rig.trunk);
      this.levelEye(rig);
      this.eyeLevelled = true;
      stageEntity.object3D?.add(this.grid, this.backdrop, this.floor); // the room model's floor and sky, in the stage frame
    }
    if (!this.shown || !this.feedWanted) return;
    const now = performance.now();
    if (now - this.lastRender < RENDER_MS) return;
    this.lastRender = now;
    this.render(rig.root, stageEntity);
  }

  /**
   * Puts the camera in the head: looking along the head's forward axis with
   * its up axis up, a few centimetres in front of the head's origin. The
   * head's axes are found by matching its principal axes to the trunk's
   * forward (+x) and up (+z) once (joint frames are axis-aligned, so the
   * current head pose does not bias the result). Without a head: on the
   * trunk, looking forward.
   */
  private mountEye(trunk: Object3D): void {
    const head = this.head;
    if (!head) {
      // The trunk's frame is the sim's: look along +x with +z up.
      this.basis.makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0));
      this.eye.quaternion.setFromRotationMatrix(this.basis);
      this.eye.position.set(0.08, 0, 0.13);
      trunk.add(this.eye);
      return;
    }
    trunk.updateWorldMatrix(true, true);
    const trunkQ = trunk.getWorldQuaternion(new Quaternion());
    const headQ = head.getWorldQuaternion(new Quaternion());
    const forward = new Vector3(1, 0, 0).applyQuaternion(trunkQ);
    const up = new Vector3(0, 0, 1).applyQuaternion(trunkQ);
    const axes = [
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(0, 0, 1),
      new Vector3(0, 0, -1),
    ];
    const best = (target: Vector3, not: Vector3 | null): Vector3 => {
      let pick = axes[0];
      let score = -Infinity;
      for (const axis of axes) {
        if (not && Math.abs(axis.dot(not)) > 0.5) continue;
        const s = axis.clone().applyQuaternion(headQ).dot(target);
        if (s > score) {
          score = s;
          pick = axis;
        }
      }
      return pick.clone();
    };
    const f = best(forward, null);
    const u = best(up, f);
    // Camera frame: x right (forward x up), y up, z back.
    this.basis.makeBasis(new Vector3().crossVectors(f, u), u, f.clone().negate());
    this.eye.quaternion.setFromRotationMatrix(this.basis);
    this.eye.position.copy(f).multiplyScalar(0.03).addScaledVector(u, 0.01);
    head.add(this.eye);
  }

  /**
   * Aims the head camera the way the head faces in the duck's default
   * standing pose: along the body's heading, 3 cm ahead of and 1 cm above the
   * head's origin. Worked out with the joints set to that pose for a moment,
   * so wherever the head looks right now does not matter; from then on the
   * camera, riding in the head, follows every head and neck movement.
   */
  private levelEye(rig: DuckRig): void {
    const head = this.head;
    if (!head) return;
    const trunk = rig.trunk;
    const saved = rig.joints.map((joint) => joint?.body.quaternion.clone() ?? null);
    const turn = new Quaternion();
    rig.joints.forEach((joint, j) => {
      if (!joint) return;
      joint.body.quaternion.copy(joint.rest).multiply(turn.setFromAxisAngle(joint.axis, DEFAULT_POSE[j] ?? 0));
    });
    trunk.updateWorldMatrix(true, true);
    const trunkQ = trunk.getWorldQuaternion(this.q1);
    const headQ = head.getWorldQuaternion(this.q2).invert();
    this.basis.makeBasis(this.offset.set(0, -1, 0), this.v1.set(0, 0, 1), this.v2.set(-1, 0, 0));
    this.eye.quaternion.setFromRotationMatrix(this.basis).premultiply(trunkQ).premultiply(headQ);
    head.getWorldPosition(this.v1);
    this.v1.add(this.offset.set(0.03, 0, 0.01).applyQuaternion(trunkQ));
    head.worldToLocal(this.v1);
    this.eye.position.copy(this.v1);
    rig.joints.forEach((joint, j) => {
      const q = saved[j];
      if (joint && q) joint.body.quaternion.copy(q);
    });
    trunk.updateWorldMatrix(true, true);
  }

  /** Vision view: names what the duck can see and draws the boxes over the frame just rendered. */
  private renderVision(renderer: WebGLRenderer, rigRoot: Object3D): void {
    const now = performance.now();
    const scan = this.room?.scanVersion ?? 0;
    if (this.visionDirty || scan !== this.collectedScan || now - this.lastCollect > COLLECT_MS) {
      this.visionDirty = false;
      this.collectedScan = scan;
      this.lastCollect = now;
      this.vision.collect(this.world.scene, rigRoot);
    }
    this.vision.renderIds(renderer, this.world.scene, this.eye);
    this.vision.drawOverlay(renderer, this.target);
  }

  /** One frame from the duck's eyes into the feed texture. */
  private render(rigRoot: Object3D, stage: Entity): void {
    const renderer = this.world.renderer;
    const blocks = this.terrain?.blocksForCam(stage) ?? null;
    const blocksWereVisible = blocks?.visible ?? false;
    if (blocks) blocks.visible = true;
    const visionView = this.view === 'vision';
    this.room?.setCamView(true, visionView);
    rigRoot.visible = false;
    // The 2D page's screen-space panels hang under the player's camera, the
    // player's rig carries the controllers and hands, and the robot panel
    // shows this very texture: keep them all out of the shot.
    const camera = this.world.camera;
    const cameraWasVisible = camera.visible;
    camera.visible = false;
    const player = this.world.player;
    const playerWasVisible = player.visible;
    player.visible = false;
    for (const object of this.hidden) object.userData.duckCamVisible = object.visible;
    for (const object of this.hidden) object.visible = false;
    // Mixed reality: the passthrough cannot be filmed, so draw the duck's room
    // model on a dark backdrop with a floor grid.
    const mixedReality = this.room?.isMixedReality ?? false;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    let skyWasVisible = false;
    if (mixedReality) {
      const backdropColor = visionView ? VISION_BACKDROP : MR_BACKDROP;
      renderer.setClearColor(backdropColor, 1);
      (this.backdrop.material as MeshBasicMaterial).color.setHex(backdropColor);
      this.grid.visible = !visionView;
      this.floor.visible = visionView;
      // Centred on the eye (the rig, and anything under it, is hidden for this render).
      this.eye.getWorldPosition(this.backdrop.position);
      this.backdrop.parent?.worldToLocal(this.backdrop.position);
      this.backdrop.visible = true;
      if (!this.sky?.parent) this.sky = this.world.scene.getObjectByName('Sky') ?? null;
      if (this.sky) {
        skyWasVisible = this.sky.visible;
        this.sky.visible = false;
      }
    }
    const xrEnabled = renderer.xr.enabled;
    const previousTarget = renderer.getRenderTarget();
    const shadowsAuto = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false; // reuse the frame's shadow maps
    renderer.setRenderTarget(this.target);
    renderer.render(this.world.scene, this.eye);
    if (visionView) this.renderVision(renderer, rigRoot);
    renderer.setRenderTarget(previousTarget);
    renderer.shadowMap.autoUpdate = shadowsAuto;
    renderer.xr.enabled = xrEnabled;
    if (mixedReality) {
      renderer.setClearColor(this.clearColor, clearAlpha);
      this.grid.visible = false;
      this.floor.visible = false;
      this.backdrop.visible = false;
      if (this.sky) this.sky.visible = skyWasVisible;
    }
    for (const object of this.hidden) object.visible = object.userData.duckCamVisible !== false;
    camera.visible = cameraWasVisible;
    player.visible = playerWasVisible;
    rigRoot.visible = true;
    this.room?.setCamView(false);
    if (blocks) blocks.visible = blocksWereVisible;
    this.frames++;
  }
}
