// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The 2D page's camera: drag the room (mouse or one finger) to turn the view
 * around the spot it looks at on the floor (where iwsdk.config.json's camera
 * points, or a level's hero view when it has one); the mouse wheel or a
 * pinch moves in and out. A press on a screen panel or on a course piece (the
 * editor drags those) is left alone, and so is a click: the camera moves only
 * once the pointer has travelled a few pixels. The touch stick is plain DOM
 * over the canvas, so its drags never get here. In a headset the tracked head
 * owns the camera; leaving XR puts the 2D view back.
 */
import { createSystem, Hovered, type Object3D, Pressed, Spherical, Vector3, VisibilityState } from '@iwsdk/core';
import { CoursePiece } from '../course/course-components.js';

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

interface ScreenDocument extends Object3D {
  computedSize?: { width: number; height: number };
}

export class OrbitCameraSystem extends createSystem({
  hovered: { required: [CoursePiece, Hovered] },
  pressed: { required: [CoursePiece, Pressed] },
}) {
  private target!: Vector3;
  private offset!: Vector3;
  private point!: Vector3;
  private spherical!: Spherical;
  private hero: unknown = undefined;
  private ready = false;
  private dirty = false;
  private wasImmersive = false;
  private drag: { id: number; x: number; y: number; active: boolean } | null = null;
  private pinch: { distance: number; radius: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();

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
      if (this.pointers.size > 2 || this.overPanel(event.clientX, event.clientY) || this.onPiece()) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false };
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
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.active) {
        // A piece picked up meanwhile (a touch has no hover first) keeps the drag for the editor.
        if (Math.hypot(dx, dy) < DRAG_START_PX) return;
        if (this.onPiece()) {
          this.drag = null;
          return;
        }
        drag.active = true;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.spherical.theta -= dx * TURN_PER_PX;
      this.spherical.phi = Math.min(MAX_PHI, Math.max(MIN_PHI, this.spherical.phi - dy * TURN_PER_PX));
      this.dirty = true;
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
    if (!this.ready || !this.dirty) return;
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
