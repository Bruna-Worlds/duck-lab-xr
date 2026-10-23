// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The playground editor, in the headset and in the browser. With editing
 * on, every course piece can be dragged along the floor: point at it and
 * hold the trigger (or the mouse button), and it slides where the ray meets
 * the floor; the thumbstick (Q / E, or the wheel) turns it; B (Delete)
 * removes it. The palette on the HUD adds pieces in front of the player.
 * Each change rebuilds the duck's physics around it. Save keeps the board
 * in the browser as a custom playground; Share copies a link that holds
 * the whole board (see playgrounds/custom.ts).
 */
import {
  createSystem,
  type Entity,
  InputComponent,
  Matrix4,
  type Object3D,
  Plane,
  Pressed,
  Raycaster,
  Vector2,
  Vector3,
} from '@iwsdk/core';
import { CourseFinish, CoursePiece } from '../course/course-components.js';
import { CourseSystem } from '../course/course-system.js';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';
import { type CustomPlayground, customId, encodeShare, saveCustom, shareUrl } from '../playgrounds/custom.js';
import { PlaygroundSystem } from '../playgrounds/playground-system.js';
import { describePieces, PALETTE, spawnPiece } from '../playgrounds/spawn-pieces.js';

const APPLY_DELAY_MS = 600; // after the last change, before the physics rebuild
const LIMIT = 3.9; // metres from the stage origin a piece may go
const KEY_YAW = (15 * Math.PI) / 180;
const STICK_YAW_RATE = (120 * Math.PI) / 180; // per second at full deflection
const START_PAD = 'course-start-pad';
const BASE = 'free-roam';

export class EditorSystem extends createSystem({
  stages: { required: [DuckStage] },
  pieces: { required: [CoursePiece] },
  held: { required: [CoursePiece, Pressed] },
}) {
  editing = false;
  status = 'Editor off';
  private dirty = false;
  private applyAt = 0;
  private dragging: Entity | null = null;
  private duck: DuckSystem | undefined;
  private course: CourseSystem | undefined;
  private playgrounds: PlaygroundSystem | undefined;
  private raycaster!: Raycaster;
  private ndc!: Vector2;
  private plane!: Plane;
  private hit!: Vector3;
  private offset!: Vector3;
  private v!: Vector3;
  private normal!: Vector3;
  private origin!: Vector3;
  private direction!: Vector3;
  private stageInverse!: Matrix4;
  private pointerDown = false;
  private wheelYaw = 0;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.course = this.world.getSystem(CourseSystem);
    this.playgrounds = this.world.getSystem(PlaygroundSystem);
    this.raycaster = new Raycaster();
    this.ndc = new Vector2();
    this.plane = new Plane();
    this.hit = new Vector3();
    this.offset = new Vector3();
    this.v = new Vector3();
    this.normal = new Vector3();
    this.origin = new Vector3();
    this.direction = new Vector3();
    this.stageInverse = new Matrix4();
    this.queries.held.subscribe('qualify', (entity) => {
      if (this.editing) this.startDrag(entity);
    });
    this.queries.held.subscribe('disqualify', (entity) => {
      if (entity === this.dragging) this.endDrag();
    });
    this.queries.stages.subscribe('disqualify', () => {
      this.dragging = null;
      this.dirty = false;
    });
    const canvas = this.world.renderer.domElement;
    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    };
    const onDown = () => {
      this.pointerDown = true;
    };
    const onUp = () => {
      this.pointerDown = false;
    };
    const onWheel = (event: WheelEvent) => {
      if (this.editing && this.dragging) {
        this.wheelYaw += event.deltaY > 0 ? -KEY_YAW : KEY_YAW;
        event.preventDefault();
      }
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    this.cleanupFuncs.push(() => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
    });
  }

  toggle(): void {
    this.editing = !this.editing;
    if (!this.editing) {
      this.endDrag();
      if (this.dirty) this.apply();
      this.status = 'Editor off';
    } else {
      this.status = 'Editing: drag pieces along the floor; stick, Q/E or wheel turn; B/Delete removes';
    }
  }

  /** Pieces placed on the stage (for the HUD and tests). */
  get pieceCount(): number {
    return this.queries.pieces.entities.size;
  }

  /** Add a palette piece in front of the player. */
  async add(asset: string): Promise<Entity | null> {
    const stage = this.stage();
    const entry = PALETTE.find((p) => p.asset === asset);
    if (!stage?.object3D || !entry) return null;
    const spot = this.spotInFront(stage.object3D);
    const entity = await spawnPiece(this.world, stage, {
      asset,
      x: spot.x,
      z: spot.z,
      y: entry.y,
      comp: entry.comp ? structuredClone(entry.comp) : undefined,
    });
    if (!entity) {
      this.status = `${entry.label}: already on the board (one of each)`;
      return null;
    }
    this.status = `Added ${entry.label}. Drag it where you want it.`;
    this.touch();
    return entity;
  }

  /** Move a piece (stage-local metres); used by the drag and by tests. */
  moveTo(entity: Entity, x: number, z: number, yaw?: number): void {
    const object = entity.object3D;
    if (!object) return;
    object.position.x = Math.max(-LIMIT, Math.min(LIMIT, x));
    object.position.z = Math.max(-LIMIT, Math.min(LIMIT, z));
    if (yaw !== undefined) object.rotation.y = yaw;
    this.touch();
  }

  remove(entity: Entity): void {
    if (entity.object3D?.userData.iwsdkSceneAssetId === START_PAD) {
      this.status = 'The start pad stays.';
      return;
    }
    if (entity === this.dragging) this.dragging = null;
    entity.dispose();
    this.status = 'Removed.';
    this.touch();
  }

  /** Everything but the start pad goes. */
  clear(): void {
    for (const entity of [...this.queries.pieces.entities]) {
      if (entity.object3D?.userData.iwsdkSceneAssetId !== START_PAD) entity.dispose();
    }
    this.dragging = null;
    this.status = 'Cleared. Add pieces from the palette.';
    this.touch();
  }

  /** The board as a custom playground (not yet saved). */
  describe(title?: string): CustomPlayground {
    const pieces = describePieces(this.queries.pieces.entities).filter((p) => p.asset !== START_PAD);
    let par = 60;
    for (const entity of this.queries.pieces.entities) {
      if (entity.hasComponent(CourseFinish)) par = Number(entity.getValue(CourseFinish, 'par') ?? par);
    }
    const id = customId(pieces, BASE);
    return {
      version: 'duckdash.custom.v1',
      id,
      title: title ?? this.playgrounds?.info()?.title ?? `My playground ${id.slice(-4)}`,
      par,
      base: BASE,
      pieces,
      at: new Date().toISOString(),
    };
  }

  save(title?: string): CustomPlayground {
    const playground = this.describe(title);
    saveCustom(playground);
    this.playgrounds?.refreshCustoms();
    this.playgrounds?.adoptCustomId(playground.id);
    this.status = `Saved "${playground.title}" (${playground.pieces.length} pieces). It is in the picker.`;
    return playground;
  }

  /** Save and copy a link that carries the whole board. */
  async share(): Promise<string> {
    const playground = this.save();
    const url = shareUrl(await encodeShare(playground));
    try {
      await navigator.clipboard.writeText(url);
      this.status = `Link copied (${url.length} chars). Paste it anywhere.`;
    } catch {
      this.status = `Link: ${url}`;
    }
    console.info(`[editor] share ${url}`);
    return url;
  }

  update(delta: number): void {
    if (!this.editing) return;
    const keys = this.input.keyboard;
    const dragging = this.dragging;
    if (dragging?.object3D) {
      if (keys.getKeyDown('Delete') || keys.getKeyDown('Backspace')) {
        this.remove(dragging);
        return;
      }
      let yaw = this.wheelYaw;
      this.wheelYaw = 0;
      if (keys.getKeyDown('KeyQ')) yaw += KEY_YAW;
      if (keys.getKeyDown('KeyE')) yaw -= KEY_YAW;
      const right = this.input.xr.gamepads.right;
      const left = this.input.xr.gamepads.left;
      const stick = right?.getAxesValues(InputComponent.Thumbstick) ?? left?.getAxesValues(InputComponent.Thumbstick);
      if (stick && Math.abs(stick.x) > 0.2) yaw -= stick.x * STICK_YAW_RATE * delta;
      if (right?.getButtonDown(InputComponent.B_Button) || left?.getButtonDown(InputComponent.Y_Button)) {
        this.remove(dragging);
        return;
      }
      if (yaw !== 0) {
        dragging.object3D.rotation.y += yaw;
        this.touch();
      }
      this.drag(dragging);
    }
    if (this.dirty && performance.now() >= this.applyAt) this.apply();
  }

  private stage(): Entity | null {
    // The duck's stage is the current level's even while an old level lingers for a frame.
    return this.duck?.stageEntity ?? (this.queries.stages.entities.values().next().value as Entity | undefined) ?? null;
  }

  private touch(): void {
    this.dirty = true;
    this.applyAt = performance.now() + APPLY_DELAY_MS;
  }

  /** Pieces changed: the course reads them again and the sim rebuilds its colliders. */
  private apply(): void {
    this.dirty = false;
    this.course?.invalidateZones();
    this.duck?.rebuildCourse();
  }

  /** The ray that is doing the pointing: a controller holding its trigger, else the mouse. */
  private ray(): boolean {
    const xr = this.input.xr.gamepads;
    const space =
      (xr.right?.getButtonValue(InputComponent.Trigger) ?? 0) > 0.5
        ? this.player.raySpaces.right
        : (xr.left?.getButtonValue(InputComponent.Trigger) ?? 0) > 0.5
          ? this.player.raySpaces.left
          : null;
    if (space && this.world.session) {
      space.updateWorldMatrix(true, false);
      space.getWorldPosition(this.origin);
      this.direction.set(0, 0, -1).transformDirection(space.matrixWorld);
      return true;
    }
    if (!this.pointerDown) return false;
    this.raycaster.setFromCamera(this.ndc, this.world.camera);
    this.origin.copy(this.raycaster.ray.origin);
    this.direction.copy(this.raycaster.ray.direction);
    return true;
  }

  /** Where the pointing ray meets the stage floor, as a world point. */
  private floorHit(stage: Object3D): boolean {
    if (!this.ray()) return false;
    stage.updateWorldMatrix(true, false);
    this.normal.set(0, 1, 0).transformDirection(stage.matrixWorld);
    this.v.setFromMatrixPosition(stage.matrixWorld);
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.v);
    const denom = this.plane.normal.dot(this.direction);
    if (Math.abs(denom) < 1e-4) return false;
    const t = -(this.plane.normal.dot(this.origin) + this.plane.constant) / denom;
    if (t < 0) return false;
    this.hit.copy(this.origin).addScaledVector(this.direction, t);
    return true;
  }

  private startDrag(entity: Entity): void {
    const stage = this.stage()?.object3D;
    const object = entity.object3D;
    if (!stage || !object) return;
    this.dragging = entity;
    if (this.floorHit(stage)) {
      object.getWorldPosition(this.offset).sub(this.hit); // keep the grab point under the ray
      this.offset.y = 0;
    } else {
      this.offset.set(0, 0, 0);
    }
    this.status = `Holding ${String(object.userData.iwsdkSceneAssetId ?? 'piece').replace(/^(course|scan|ph)-/, '')}`;
  }

  private drag(entity: Entity): void {
    const stage = this.stage()?.object3D;
    const object = entity.object3D;
    if (!stage || !object || !this.floorHit(stage)) return;
    this.v.copy(this.hit).add(this.offset);
    this.stageInverse.copy(stage.matrixWorld).invert();
    this.v.applyMatrix4(this.stageInverse);
    this.moveTo(entity, this.v.x, this.v.z);
  }

  private endDrag(): void {
    if (this.dragging) this.status = 'Placed.';
    this.dragging = null;
  }

  /** A floor spot 0.8 m ahead of the player, in stage-local metres. */
  private spotInFront(stage: Object3D): { x: number; z: number } {
    this.player.head.getWorldPosition(this.origin);
    this.player.head.getWorldDirection(this.direction);
    this.direction.y = 0;
    if (this.direction.lengthSq() < 1e-4) this.direction.set(0, 0, -1);
    this.direction.normalize();
    // getWorldDirection gives +z; cameras look down -z.
    this.v.copy(this.origin).addScaledVector(this.direction, -0.8);
    stage.updateWorldMatrix(true, false);
    this.stageInverse.copy(stage.matrixWorld).invert();
    this.v.applyMatrix4(this.stageInverse);
    if (!Number.isFinite(this.v.x) || Math.abs(this.v.x) > LIMIT || Math.abs(this.v.z) > LIMIT) {
      return { x: 0.5, z: 0 };
    }
    return { x: this.v.x, z: this.v.z };
  }
}
