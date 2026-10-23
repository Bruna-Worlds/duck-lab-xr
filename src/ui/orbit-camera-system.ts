// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The 2D page's camera: drag the room (mouse or one finger) to turn the view
 * around the spot it looks at on the floor (where iwsdk.config.json's camera
 * points, or a level's hero view when it has one); the mouse wheel or a
 * pinch moves in and out. A press on a screen panel is left alone, and so is
 * a click: the camera moves only once the pointer has travelled a few pixels.
 * In the course editor a press that picks up a piece drags the piece instead:
 * that is decided a couple of frames after the press, once the input systems
 * have marked the piece pressed (a touch has no hover to tell earlier). The touch stick is plain DOM
 * over the canvas, so its drags never get here. In a headset the tracked head
 * owns the camera; leaving XR puts the 2D view back.
 *
 * Walls never stand between this camera and the course: a part of a room
 * tagged with userData.cutaway (its inward normal and a point on its inner
 * face, see src/scene-assets/toy-room.scene-asset.ts) hides while the camera
 * is on its outer side. Furniture tagged { occluder: true } hides while it
 * stands on a line of sight from the camera to the course. Pip cam, inside
 * the room, still sees all of it (revealHidden).
 */
import { Box3, createSystem, Hovered, type Object3D, Pressed, Ray, Spherical, Vector3, VisibilityState } from '@iwsdk/core';
import { CoursePiece } from '../course/course-components.js';
import { EditorSystem } from '../editor/editor-system.js';

const DRAG_START_PX = 6;
const TURN_PER_PX = 0.0065; // radians per pixel dragged
const MIN_PHI = 0.2; // polar angle from straight up: looking steeply down at most...
const MAX_PHI = 1.45; // ...and at least a little down at the floor
const MIN_RADIUS = 0.45;
const MAX_RADIUS = 9;
/** The floor height the camera turns around (just above the floor, at the course). */
const FLOOR_Y = 0.05;
/** Portrait screens see less of the course across: start further out (up to this much). */
const MAX_PORTRAIT_ZOOM = 1.7;

interface HeroView {
  position: [number, number, number];
  target: [number, number, number];
}

interface Cutaway {
  object: Object3D;
  /** A wall: hidden while the camera is on the outer side of this inner face. */
  normal?: Vector3;
  point?: Vector3;
  /** Furniture: its world box, hidden while it stands between the camera and the course. */
  box?: Box3;
}

/** The floor around the spot the camera turns about, always part of what must stay in view (m). */
const SPOT_SIZE = new Vector3(1.6, 0.4, 1.6);

/** How often the scene is searched for cutaway parts (a level switch brings new ones). */
const CUTAWAY_SCAN_MS = 1500;

interface ScreenDocument extends Object3D {
  computedSize?: { width: number; height: number };
}

export class OrbitCameraSystem extends createSystem({
  hovered: { required: [CoursePiece, Hovered] },
  pressed: { required: [CoursePiece, Pressed] },
  pieces: { required: [CoursePiece] },
}) {
  private target!: Vector3;
  private offset!: Vector3;
  private point!: Vector3;
  private spherical!: Spherical;
  private hero: unknown = undefined;
  private ready = false;
  private dirty = false;
  private wasImmersive = false;
  /** The gesture in progress: where it started, its last point, the turn not yet applied. */
  private drag: { id: number; startX: number; startY: number; x: number; y: number; dx: number; dy: number; active: boolean; frames: number } | null = null;
  private editor: EditorSystem | undefined;
  private pinch: { distance: number; radius: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly cutaways = new Map<Object3D, Cutaway>();
  /** The cutaway parts hidden right now. */
  private readonly hidden: Object3D[] = [];
  private lastScan = -Infinity;
  private readonly worldPoint = new Vector3();
  private readonly worldNormal = new Vector3();
  private readonly eye = new Vector3();
  private readonly seen = new Set<Object3D>();
  /** What must stay in view: the course pieces and the floor round the spot, as a box... */
  private readonly courseBox = new Box3();
  private readonly pieceBox = new Box3();
  /** ...and the points the lines of sight go to: its middle and its four low corners. */
  private readonly sights = [new Vector3(), new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  private readonly ray = new Ray();
  private readonly sightDir = new Vector3();
  private readonly hit = new Vector3();

  init(): void {
    this.target = new Vector3();
    this.offset = new Vector3();
    this.point = new Vector3();
    this.spherical = new Spherical();
    const canvas = this.world.renderer.domElement;
    canvas.style.touchAction = 'none'; // a finger drag turns the camera instead of scrolling the page
    const onDown = (event: PointerEvent) => {
      if (!this.flat || (event.pointerType === 'mouse' && event.button !== 0)) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) {
        // Two fingers: a pinch, never a turn.
        this.drag = null;
        this.pinch = { distance: this.spread(), radius: this.spherical.radius };
        return;
      }
      if (this.pointers.size > 2 || this.overPanel(event.clientX, event.clientY)) return;
      if (this.editing && this.onPiece()) return; // a mouse over a piece in the editor: the editor's drag
      const x = event.clientX;
      const y = event.clientY;
      this.drag = { id: event.pointerId, startX: x, startY: y, x, y, dx: 0, dy: 0, active: false, frames: 0 };
    };
    const onMove = (event: PointerEvent) => {
      const known = this.pointers.get(event.pointerId);
      if (known) {
        known.x = event.clientX;
        known.y = event.clientY;
      }
      if (this.pinch && this.pointers.size >= 2) {
        const distance = this.spread();
        if (distance > 0) this.zoomTo((this.pinch.radius * this.pinch.distance) / distance);
        return;
      }
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.id) return;
      // Turned in update(), once the gesture is known not to be the editor's.
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= DRAG_START_PX) {
        drag.active = true;
        drag.dx = event.clientX - drag.startX;
        drag.dy = event.clientY - drag.startY;
      } else if (drag.active) {
        drag.dx += event.clientX - drag.x;
        drag.dy += event.clientY - drag.y;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
    };
    const onUp = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.drag?.id === event.pointerId) this.drag = null;
      if (this.pointers.size < 2) this.pinch = null;
    };
    const onWheel = (event: WheelEvent) => {
      // The editor turns a piece held under the pointer with the wheel.
      if (!this.flat || this.queries.pressed.entities.size > 0 || this.overPanel(event.clientX, event.clientY)) return;
      event.preventDefault();
      this.zoomTo(this.spherical.radius * Math.exp(event.deltaY * 0.0012));
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    this.cleanupFuncs.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
    });
  }

  update(): void {
    if (!this.flat) {
      this.wasImmersive = true;
      this.showAll(); // in a headset the player is in the room: every wall stands
      return;
    }
    // Start from the camera as the page placed it; a level with a hero view sets a new start.
    if (!this.ready) this.startFromCamera();
    const hero = this.camera.userData.iwsdkSceneHeroView as HeroView | undefined;
    if (hero !== this.hero) {
      this.hero = hero;
      if (hero) this.startFrom(hero.position, hero.target);
    }
    if (this.wasImmersive) {
      this.wasImmersive = false;
      this.dirty = true; // back from a headset session: the 2D view again
    }
    this.turn();
    if (this.ready && this.dirty) {
      this.dirty = false;
      this.offset.setFromSpherical(this.spherical);
      this.point.copy(this.target).add(this.offset);
      const parent = this.camera.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parent.worldToLocal(this.point);
      }
      this.camera.position.copy(this.point);
      this.camera.lookAt(this.target);
    }
    this.cutaway();
  }

  /** Applies the drag's turn, unless the press picked up a piece in the editor. */
  private turn(): void {
    const drag = this.drag;
    if (!drag) return;
    // Two frames after the press the input systems have marked a piece it picked up.
    if (drag.frames < 2) {
      drag.frames++;
      if (this.editing && this.queries.pressed.entities.size > 0) this.drag = null;
      return;
    }
    if (!drag.active || (drag.dx === 0 && drag.dy === 0)) return;
    this.spherical.theta -= drag.dx * TURN_PER_PX;
    this.spherical.phi = Math.min(MAX_PHI, Math.max(MIN_PHI, this.spherical.phi - drag.dy * TURN_PER_PX));
    drag.dx = 0;
    drag.dy = 0;
    this.dirty = true;
  }

  /** The course editor is on (its presses on pieces move pieces, not the camera). */
  private get editing(): boolean {
    this.editor ??= this.world.getSystem(EditorSystem);
    return this.editor?.editing ?? false;
  }

  /** Pip cam renders from inside the room: show the hidden walls for its render, then hide them again. */
  revealHidden(shown: boolean): void {
    for (const object of this.hidden) object.visible = shown;
  }

  /** Hides each tagged part while the camera is on its outer side. */
  private cutaway(): void {
    const now = performance.now();
    if (now - this.lastScan > CUTAWAY_SCAN_MS) {
      this.lastScan = now;
      this.scan();
    }
    if (this.cutaways.size === 0) return;
    this.camera.updateWorldMatrix(true, false);
    this.camera.getWorldPosition(this.eye);
    this.hidden.length = 0;
    for (const part of this.cutaways.values()) {
      const object = part.object;
      let inTheWay = false;
      if (part.box) {
        inTheWay = this.blocksSight(part.box);
      } else if (part.normal && part.point) {
        object.updateWorldMatrix(true, false);
        this.worldPoint.copy(part.point).applyMatrix4(object.matrixWorld);
        this.worldNormal.copy(part.normal).transformDirection(object.matrixWorld);
        inTheWay = this.worldPoint.sub(this.eye).negate().dot(this.worldNormal) < 0;
      }
      object.visible = !inTheWay;
      if (inTheWay) this.hidden.push(object);
    }
  }

  /** Whether a box stands on a line of sight from the camera to the course. */
  private blocksSight(box: Box3): boolean {
    for (const sight of this.sights) {
      this.sightDir.copy(sight).sub(this.eye);
      const reach = this.sightDir.length();
      if (reach < 1e-3) continue;
      this.ray.set(this.eye, this.sightDir.multiplyScalar(1 / reach));
      if (this.ray.intersectBox(box, this.hit) && this.hit.distanceTo(this.eye) < reach - 0.05) return true;
    }
    return false;
  }

  private showAll(): void {
    for (const object of this.hidden) object.visible = true;
    this.hidden.length = 0;
  }

  /** Finds the tagged parts in the scene (keeps those still there, adds new ones). */
  private scan(): void {
    this.seen.clear();
    this.scene.traverse((object) => {
      const tag = object.userData.cutaway as { normal?: number[]; point?: number[]; occluder?: boolean } | undefined;
      if (!tag) return;
      let part = this.cutaways.get(object);
      if (!part) {
        if (tag.occluder) part = { object, box: new Box3() };
        else if (tag.normal && tag.point) part = { object, normal: new Vector3().fromArray(tag.normal), point: new Vector3().fromArray(tag.point) };
        else return;
        this.cutaways.set(object, part);
      }
      this.seen.add(object);
      part.box?.setFromObject(object); // in the world, wherever the room stands now
    });
    for (const object of this.cutaways.keys()) if (!this.seen.has(object)) this.cutaways.delete(object);
    // What must stay in view: the course pieces, and the floor round the spot the camera turns about.
    this.courseBox.makeEmpty();
    for (const entity of this.queries.pieces.entities) {
      if (entity.object3D) this.courseBox.union(this.pieceBox.setFromObject(entity.object3D));
    }
    this.courseBox.union(this.pieceBox.setFromCenterAndSize(this.target, SPOT_SIZE));
    const { min, max } = this.courseBox;
    const low = Math.min(max.y, min.y + 0.12);
    this.courseBox.getCenter(this.sights[0]);
    this.sights[0].y = Math.min(this.sights[0].y, 0.3);
    this.sights[1].set(min.x, low, min.z);
    this.sights[2].set(max.x, low, min.z);
    this.sights[3].set(min.x, low, max.z);
    this.sights[4].set(max.x, low, max.z);
  }

  /** True on the 2D page (not in a headset session). */
  private get flat(): boolean {
    return this.world.visibilityState.peek() === VisibilityState.NonImmersive;
  }

  /** Around the spot the camera looks at on the floor (2 m ahead when it looks up). */
  private startFromCamera(): void {
    this.camera.updateWorldMatrix(true, false);
    const eye = this.camera.getWorldPosition(new Vector3());
    const ahead = this.camera.getWorldDirection(new Vector3());
    const reach = ahead.y < -0.05 ? Math.min(6, (FLOOR_Y - eye.y) / ahead.y) : 2;
    const spot = eye.clone().addScaledVector(ahead, reach);
    this.startFrom(eye.toArray(), spot.toArray());
  }

  private startFrom(eye: ArrayLike<number>, spot: ArrayLike<number>): void {
    this.target.set(spot[0], spot[1], spot[2]);
    this.offset.set(eye[0], eye[1], eye[2]).sub(this.target);
    this.spherical.setFromVector3(this.offset);
    const canvas = this.world.renderer.domElement;
    const aspect = (canvas.clientWidth || window.innerWidth) / (canvas.clientHeight || window.innerHeight);
    if (aspect < 1) this.spherical.radius *= Math.min(MAX_PORTRAIT_ZOOM, Math.max(1, Math.sqrt(1.3 / aspect)));
    this.spherical.phi = Math.min(MAX_PHI, Math.max(MIN_PHI, this.spherical.phi));
    this.spherical.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, this.spherical.radius));
    this.ready = true;
    this.dirty = true;
  }

  private zoomTo(radius: number): void {
    this.spherical.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, radius));
    this.dirty = true;
  }

  /** Distance between the first two fingers down. */
  private spread(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** A course piece (or anything else interactable) under the pointer or held. */
  private onPiece(): boolean {
    return this.queries.hovered.entities.size > 0 || this.queries.pressed.entities.size > 0;
  }

  /** Whether a screen point falls on a panel drawn in screen space (ScreenSpace, IWSDK). */
  private overPanel(clientX: number, clientY: number): boolean {
    const documents = (this.scene as { screenSpaceDescendants?: ScreenDocument[] }).screenSpaceDescendants;
    if (!documents) return false;
    const rect = this.world.renderer.domElement.getBoundingClientRect();
    const scaleY = this.camera.projectionMatrix.elements[5];
    if (!(rect.height > 0 && scaleY > 0)) return false;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (const document of documents) {
      const size = document.computedSize;
      const depth = -document.position.z;
      if (!document.visible || !size || !(depth > 0)) continue;
      const perPixel = (2 * depth) / scaleY / rect.height; // metres per pixel at the panel's depth
      const halfW = ((size.width / 100) * document.scale.x) / perPixel / 2;
      const halfH = ((size.height / 100) * document.scale.y) / perPixel / 2;
      const cx = rect.width / 2 + document.position.x / perPixel;
      const cy = rect.height / 2 - document.position.y / perPixel;
      if (Math.abs(x - cx) <= halfW && Math.abs(y - cy) <= halfH) return true;
    }
    return false;
  }
}
