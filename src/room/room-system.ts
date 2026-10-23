// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Room awareness in mixed reality. The Quest's room scan reaches the page as
 * WebXR detected planes (floor, walls, table tops) and meshes (furniture
 * boxes). This system uses them twice:
 *
 *  - placement: shortly after a mixed-reality session starts, the course is
 *    moved to a clear patch of the real floor in front of the player, inside
 *    the floor outline and away from scanned furniture. Without a scan the
 *    course keeps its default spot and the HUD says so; the right grip still
 *    places it by hand;
 *  - occlusion: every bounded furniture mesh gets an invisible depth-only
 *    twin, so the duck disappears behind a real couch or under a real table
 *    instead of being drawn on top of it;
 *  - the duck's view: its camera cannot film the passthrough, so it draws the
 *    room as the duck knows it: furniture as soft blue volumes, and walls,
 *    doors, windows and table tops as slabs built from the scanned planes.
 *    These are drawn only into the duck cam (setCamView).
 *
 * Both only apply while the session blends with passthrough; in VR the toy
 * room is the world and the scan is ignored.
 */
import {
  BoxGeometry,
  createSystem,
  type Entity,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Vector3,
  XRMesh as XRMeshComponent,
  XRPlane as XRPlaneComponent,
} from '@iwsdk/core';
import type { ColliderSpec } from '../course/collider-spec.js';
import { colliderFromSpec } from '../course/course-physics.js';
import type { PhysicsCollider } from '../duck/mjcf.js';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';

/** Default course footprint in stage-local metres (measured from the pieces once a stage exists). */
const DEFAULT_COURSE_X: [number, number] = [-0.3, 2.75];
const DEFAULT_COURSE_Z: [number, number] = [-0.5, 0.5];
const PIECE_MARGIN = 0.35; // around the outermost piece centres
const MARGIN = 0.12; // clearance from walls and furniture
const PLAYER_CLEARANCE = 0.75; // the course never comes closer than this to the player
const SETTLE_MS = 900; // let the rest of the scan arrive after the floor shows up
const GIVE_UP_MS = 5000; // no floor by then: no scan on this headset
const DISTANCES = [1.5, 1.8, 2.1, 1.25, 2.4, 2.7, 1.0];
const YAWS_DEG = [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180];
const SIDE_OFFSETS = [0, -0.5, 0.5, -1.0, 1.0, -1.5, 1.5]; // metres along the player's right
const SAMPLES_X = 14;
const SAMPLES_Z = 5;
const ROOM_SIZE = 2.5; // a bounded mesh wider than this both ways is the room, not furniture
const TIGHT_MAX = 6; // blocked samples still called a clean placement
// Physics: the scan as colliders in the duck's sim.
const WALL_THICKNESS = 0.06;
const SLAB = 0.05; // table tops and other horizontal surfaces
const LEG_RADIUS = 0.03;
const WALK_UNDER = 0.35; // a table this tall gets legs instead of a solid box
const HANGING = 0.6; // furniture whose bottom is above this hangs over the duck
// The duck cam's room model: which scanned planes are drawn how.
const DOOR_LABELS = new Set(['door', 'door frame']);
const WINDOW_LABELS = new Set(['window', 'window frame']);
const WALL_LABELS = new Set(['wall', 'wall face', '']);
const PROUD = 0.01; // doors, windows and wall art stand this far out of their wall
const ROOM_PUSH_MS = 800; // debounce for sending colliders to the sim
const UNDER_LABELS = new Set(['table', 'desk']);
/** Cylinder quaternions (x, y, z, w) taking the spec's y axis onto local x / y / z. */
const AXIS_QUAT: [number, number, number, number][] = [
  [0, 0, -Math.SQRT1_2, Math.SQRT1_2],
  [0, 0, 0, 1],
  [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
];
/** Labels the Quest gives to scanned things that stand on the floor. */
const STRUCTURE = new Set([
  'floor',
  'ceiling',
  'wall',
  'wall face',
  'door',
  'window',
  'window frame',
  'door frame',
  'global mesh',
]);

export type RoomState = 'idle' | 'scanning' | 'placed' | 'tight' | 'no-space' | 'no-scan';

export class RoomSystem extends createSystem({
  planes: { required: [XRPlaneComponent] },
  meshes: { required: [XRMeshComponent] },
  stages: { required: [DuckStage] },
}) {
  /** For the HUD. */
  state: RoomState = 'idle';
  /** Last placement diagnostics, for the lab panel: the search result and the scan. */
  debug = '';
  scan = '';
  /** Bumps whenever a plane or mesh appears or goes away. */
  scanVersion = 0;
  /** The scan as colliders in the stage frame (the terrain system rasterises them); bumps roomVersion. */
  roomColliders: PhysicsCollider[] = [];
  roomVersion = 0;
  /** What the sim got as colliders, for the HUD ("3 walls, 2 furniture"). */
  physicsSummary = '';
  private pushedVersion = -1;
  private pushedStage!: Matrix4;
  private pushedMr = false;
  private lastPushAt = 0;
  private stageInverse!: Matrix4;
  private relative!: Matrix4;
  private column!: Vector3;
  private duck: DuckSystem | undefined;
  private mixedReality = false;
  private sessionStart = 0;
  private floorSeenAt = 0;
  private placed = false;
  private occluderMaterial!: MeshBasicMaterial;
  /** What the duck cam draws the scanned furniture with. */
  private camMaterial!: MeshLambertMaterial;
  private occluders = new Map<Entity, Mesh>();
  /** Scanned planes as slabs for the duck cam, with the plane's lastChangedTime they were built from. */
  private planeTwins = new Map<Entity, { mesh: Mesh; changed: number | undefined; soft: boolean }>();
  private camModel!: Group;
  private wallMaterial!: MeshStandardMaterial;
  private doorMaterial!: MeshStandardMaterial;
  private windowMaterial!: MeshStandardMaterial;
  /** Furniture and surfaces in the duck cam's vision view: solid, like a camera would see them. */
  private solidMaterial!: MeshStandardMaterial;
  private occluderRoot!: Group;
  private head!: Vector3;
  private forward!: Vector3;
  private right!: Vector3;
  private point!: Vector3;
  private origin!: Vector3;
  private corner!: Vector3;
  private readonly wallN = new Vector3();
  private readonly wallC = new Vector3();
  private inverse!: Matrix4;
  private rootInverse!: Matrix4;
  private q!: Quaternion;
  private boxes: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  private labels: string[] = [];
  private blockedByPlayer = 0;
  private blockedByBox = 0;
  private blockedOutside = 0;
  private referenceSpace: XRReferenceSpace | null = null;
  private courseX: [number, number] = DEFAULT_COURSE_X;
  private courseZ: [number, number] = DEFAULT_COURSE_Z;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    // The HUD the duck system puts beyond the course stays inside the scanned room.
    if (this.duck) this.duck.keepInside = (point, from) => this.keepInside(point, from);
    this.head = new Vector3();
    this.forward = new Vector3();
    this.right = new Vector3();
    this.point = new Vector3();
    this.origin = new Vector3();
    this.corner = new Vector3();
    this.inverse = new Matrix4();
    this.rootInverse = new Matrix4();
    this.pushedStage = new Matrix4().makeScale(0, 0, 0);
    this.stageInverse = new Matrix4();
    this.relative = new Matrix4();
    this.column = new Vector3();
    this.q = new Quaternion();
    const bump = () => {
      this.scanVersion++;
    };
    this.cleanupFuncs.push(
      this.queries.planes.subscribe('qualify', bump),
      this.queries.planes.subscribe('disqualify', (entity) => {
        bump();
        this.dropPlaneTwin(entity);
      }),
      this.queries.meshes.subscribe('qualify', bump),
    );
    // Depth only: writes depth, draws nothing, and goes before everything else.
    this.occluderMaterial = new MeshBasicMaterial({ colorWrite: false });
    // The duck cam's view of the scan: soft, solid sky-blue volumes (the duck's room model).
    this.camMaterial = new MeshLambertMaterial({
      color: 0x6fb7ff,
      emissive: 0x16224a,
      transparent: true,
      opacity: 0.55,
    });
    // Walls in a warm off-white, doors in wood, windows glowing pale sky: the
    // duck's room model, lit by the scene's image lighting like the course.
    this.wallMaterial = new MeshStandardMaterial({ color: 0xf1e8d6, roughness: 0.95, metalness: 0 });
    this.doorMaterial = new MeshStandardMaterial({ color: 0xc8915a, roughness: 0.8, metalness: 0 });
    this.windowMaterial = new MeshStandardMaterial({ color: 0xc8ecff, emissive: 0x5a86a8, roughness: 0.4, metalness: 0 });
    this.solidMaterial = new MeshStandardMaterial({ color: 0x8d8f9c, roughness: 0.85, metalness: 0 });
    this.occluderRoot = new Group();
    this.occluderRoot.name = 'room-occluders';
    this.world.createTransformEntity(this.occluderRoot, { persistent: true }); // outlives playground switches
    this.camModel = new Group();
    this.camModel.name = 'room-cam-model';
    this.camModel.visible = false; // only while the duck cam renders
    this.occluderRoot.add(this.camModel);
    this.queries.stages.subscribe('qualify', () => {
      // A new playground: place it on the floor again.
      this.placed = false;
      this.floorSeenAt = 0;
      this.sessionStart = performance.now();
      if (this.mixedReality) this.state = 'scanning';
    });
    this.cleanupFuncs.push(
      this.queries.meshes.subscribe('disqualify', (entity) => {
        this.scanVersion++;
        this.dropOccluder(entity);
      }),
      () => {
        this.watchRecenter(null);
        for (const entity of [...this.occluders.keys()]) this.dropOccluder(entity);
        for (const entity of [...this.planeTwins.keys()]) this.dropPlaneTwin(entity);
        this.occluderMaterial.dispose();
        this.camMaterial.dispose();
        this.wallMaterial.dispose();
        this.doorMaterial.dispose();
        this.windowMaterial.dispose();
        this.solidMaterial.dispose();
      },
    );
  }

  update(): void {
    const session = this.world.session;
    const mixedReality = !!session && session.environmentBlendMode !== 'opaque';
    const now = performance.now();
    if (mixedReality !== this.mixedReality) {
      this.mixedReality = mixedReality;
      this.sessionStart = now;
      this.floorSeenAt = 0;
      this.placed = false;
      this.state = mixedReality ? 'scanning' : 'idle';
      this.watchRecenter(mixedReality ? this.xrManager.getReferenceSpace() : null);
      if (!mixedReality) {
        for (const entity of [...this.occluders.keys()]) this.dropOccluder(entity);
        for (const entity of [...this.planeTwins.keys()]) this.dropPlaneTwin(entity);
      }
    }
    if (!mixedReality) {
      if (this.pushedMr) {
        this.pushedMr = false;
        this.physicsSummary = '';
        this.roomColliders = []; // the toy room has no real walls
        this.roomVersion++;
      }
      return;
    }
    this.syncOccluders();
    this.syncPlaneTwins();
    this.maybePushRoom(now);
    if (this.placed) {
      return;
    }
    // Keep looking after giving up: a headset that has just restarted can
    // take a while to find its room again, and the scan then arrives late.
    const floor = this.findFloor();
    if (!floor) {
      if (this.state !== 'no-scan' && now - this.sessionStart > GIVE_UP_MS) {
        this.state = 'no-scan';
        console.info('[room] no floor plane yet: the course stays at its default spot until one arrives');
      }
      return;
    }
    if (this.floorSeenAt === 0) {
      this.floorSeenAt = now;
    }
    if (now - this.floorSeenAt < SETTLE_MS) {
      return;
    }
    this.placed = true;
    this.state = this.placeCourse(floor);
    console.info(`[room] course placement: ${this.state}`);
  }

  /** A recenter (long press on the Meta button) moves the player's origin: place the course again. */
  private watchRecenter(space: XRReferenceSpace | null): void {
    this.referenceSpace?.removeEventListener('reset', this.onRecenter);
    this.referenceSpace = space;
    space?.addEventListener('reset', this.onRecenter);
  }

  private onRecenter = (): void => {
    this.placed = false;
    this.floorSeenAt = 0;
    this.sessionStart = performance.now();
    this.state = 'scanning';
  };

  /** The floor plane entity, if the scan has one. */
  private findFloor(): Entity | null {
    for (const entity of this.queries.planes.entities) {
      const plane = entity.getValue(XRPlaneComponent, '_plane') as XRPlane | undefined;
      if (plane?.semanticLabel === 'floor' && entity.object3D) {
        return entity;
      }
    }
    return null;
  }

  /**
   * Try course spots in front of the player, nearest and straightest first,
   * and keep the one with the fewest blocked samples. A fully clear spot is
   * 'placed'; a partly blocked one is still used but reported as 'tight'.
   */
  private placeCourse(floor: Entity): RoomState {
    const duck = this.duck;
    const floorObject = floor.object3D;
    const plane = floor.getValue(XRPlaneComponent, '_plane') as XRPlane;
    const polygon = plane.polygon;
    if (!duck || !floorObject || polygon.length < 3) {
      return 'no-space';
    }
    floorObject.updateWorldMatrix(true, false);
    this.inverse.copy(floorObject.matrixWorld).invert();
    const floorY = this.corner.setFromMatrixPosition(floorObject.matrixWorld).y;
    this.measureCourse();
    const courseMid = (this.courseX[0] + this.courseX[1]) / 2;
    this.collectObstacles();
    this.player.head.getWorldPosition(this.head);
    this.player.head.getWorldQuaternion(this.q);
    this.forward.set(0, 0, -1).applyQuaternion(this.q);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-4) {
      this.forward.set(0, 0, -1);
    }
    this.forward.normalize();
    const r0x = -this.forward.z;
    const r0z = this.forward.x;
    let best = Infinity;
    let bestX = 0;
    let bestZ = 0;
    let bestRx = 1;
    let bestRz = 0;
    search: for (const distance of DISTANCES) {
      for (const side of SIDE_OFFSETS) {
        for (const yawDeg of YAWS_DEG) {
          const yaw = (yawDeg * Math.PI) / 180;
          const c = Math.cos(yaw);
          const s = Math.sin(yaw);
          // The course runs along the player's right, turned by `yaw`, centred
          // `distance` ahead and `side` to the right.
          this.right.set(r0x * c + r0z * s, 0, -r0x * s + r0z * c);
          this.point.copy(this.head).addScaledVector(this.forward, distance);
          this.point.x += r0x * side;
          this.point.z += r0z * side;
          this.point.y = floorY;
          this.origin.copy(this.point).addScaledVector(this.right, -courseMid);
          const bad = this.blockedSamples(polygon, best);
          if (bad < best) {
            best = bad;
            bestX = this.origin.x;
            bestZ = this.origin.z;
            bestRx = this.right.x;
            bestRz = this.right.z;
            if (bad === 0) {
              break search;
            }
          }
        }
      }
    }
    const total = (SAMPLES_X + 1) * (SAMPLES_Z + 1);
    let fx0 = Infinity;
    let fx1 = -Infinity;
    let fz0 = Infinity;
    let fz1 = -Infinity;
    for (const vertex of polygon) {
      this.corner.set(vertex.x, vertex.y, vertex.z).applyMatrix4(floorObject.matrixWorld);
      fx0 = Math.min(fx0, this.corner.x);
      fx1 = Math.max(fx1, this.corner.x);
      fz0 = Math.min(fz0, this.corner.z);
      fz1 = Math.max(fz1, this.corner.z);
    }
    this.origin.set(bestX, floorY, bestZ);
    this.right.set(bestRx, 0, bestRz);
    if (best !== Infinity) {
      this.blockedSamples(polygon, Infinity); // refresh the reason counts for the chosen spot
    }
    this.scan =
      `floor ${polygon.length} pts x ${fx0.toFixed(1)}..${fx1.toFixed(1)} z ${fz0.toFixed(1)}..${fz1.toFixed(1)} y ${floorY.toFixed(2)}; ` +
      `${this.boxes.length} obstacles: ${this.labels.join(' ')}`;
    this.debug =
      `head (${this.head.x.toFixed(1)}, ${this.head.z.toFixed(1)}) facing (${this.forward.x.toFixed(2)}, ${this.forward.z.toFixed(2)}); ` +
      `best ${best}/${total} blocked (player ${this.blockedByPlayer}, furniture ${this.blockedByBox}, outside ${this.blockedOutside}) ` +
      `origin (${bestX.toFixed(1)}, ${bestZ.toFixed(1)}) along (${bestRx.toFixed(2)}, ${bestRz.toFixed(2)})`;
    if (best === Infinity || best > total * 0.5) {
      return 'no-space';
    }
    duck.placeCourse(this.origin, this.right);
    return best <= TIGHT_MAX ? 'placed' : 'tight';
  }

  /** Blocked samples of the course rectangle at origin/right (stops at `limit`). */
  private blockedSamples(polygon: XRPlane['polygon'], limit: number): number {
    const perpX = -this.right.z;
    const perpZ = this.right.x;
    const spanX = this.courseX[1] - this.courseX[0] + 2 * MARGIN;
    const spanZ = this.courseZ[1] - this.courseZ[0] + 2 * MARGIN;
    let blocked = 0;
    this.blockedByPlayer = this.blockedByBox = this.blockedOutside = 0;
    for (let i = 0; i <= SAMPLES_X; i++) {
      const x = this.courseX[0] - MARGIN + (spanX * i) / SAMPLES_X;
      for (let j = 0; j <= SAMPLES_Z; j++) {
        const z = this.courseZ[0] - MARGIN + (spanZ * j) / SAMPLES_Z;
        const px = this.origin.x + this.right.x * x + perpX * z;
        const pz = this.origin.z + this.right.z * x + perpZ * z;
        const dx = px - this.head.x;
        const dz = pz - this.head.z;
        let bad = dx * dx + dz * dz < PLAYER_CLEARANCE * PLAYER_CLEARANCE;
        if (bad) {
          this.blockedByPlayer++;
        } else {
          for (const box of this.boxes) {
            if (px > box.minX && px < box.maxX && pz > box.minZ && pz < box.maxZ) {
              bad = true;
              this.blockedByBox++;
              break;
            }
          }
        }
        if (!bad) {
          this.corner.set(px, this.origin.y, pz).applyMatrix4(this.inverse);
          bad = !insidePolygon(polygon, this.corner.x, this.corner.z);
          if (bad) this.blockedOutside++;
        }
        if (bad && ++blocked >= limit) {
          return blocked;
        }
      }
    }
    return blocked;
  }

  /** True in a passthrough (mixed reality) session. */
  get isMixedReality(): boolean {
    return this.mixedReality;
  }

  /**
   * For the duck cam: draw the scan (furniture, walls, surfaces) instead of
   * depth-only occluders. `solid`: the vision view's camera-like look instead
   * of the motion view's soft blue volumes.
   */
  setCamView(on: boolean, solid = false): void {
    const soft = solid ? this.solidMaterial : this.camMaterial;
    const material = on ? soft : this.occluderMaterial;
    for (const twin of this.occluders.values()) {
      twin.material = material;
    }
    for (const twin of this.planeTwins.values()) {
      if (twin.soft) twin.mesh.material = soft;
    }
    this.camModel.visible = on;
  }

  /**
   * The nearest scanned wall within `max` metres of `point` (and in front of
   * or behind its extent, 10 cm of slack): the closest point on it into
   * `outPoint` and its normal into `outNormal`. False when none is that close.
   */
  nearestWall(point: Vector3, max: number, outPoint: Vector3, outNormal: Vector3): boolean {
    let best = max;
    let found = false;
    for (const entity of this.queries.planes.entities) {
      const plane = entity.getValue(XRPlaneComponent, '_plane') as XRPlane | undefined;
      const object = entity.object3D;
      if (!plane || !object || plane.orientation !== 'vertical' || plane.polygon.length < 3) continue;
      if (!WALL_LABELS.has(plane.semanticLabel ?? '')) continue;
      object.updateWorldMatrix(true, false);
      this.inverse.copy(object.matrixWorld).invert();
      const local = this.point.copy(point).applyMatrix4(this.inverse); // plane frame: y is the distance
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const vertex of plane.polygon) {
        x0 = Math.min(x0, vertex.x);
        x1 = Math.max(x1, vertex.x);
        z0 = Math.min(z0, vertex.z);
        z1 = Math.max(z1, vertex.z);
      }
      if (local.x < x0 - 0.1 || local.x > x1 + 0.1 || local.z < z0 - 0.1 || local.z > z1 + 0.1) continue;
      const distance = Math.abs(local.y);
      if (distance >= best) continue;
      best = distance;
      found = true;
      outPoint.set(local.x, 0, local.z).applyMatrix4(object.matrixWorld);
      outNormal.set(0, 1, 0).transformDirection(object.matrixWorld);
    }
    return found;
  }

  /**
   * Mixed reality: moves `point` back in front of any scanned wall that
   * stands between it and `from` (the course), leaving `margin`, so panels
   * placed beyond the course never end up outside the room.
   */
  keepInside(point: Vector3, from: Vector3, margin = 0.25): void {
    if (!this.mixedReality) return;
    for (const entity of this.queries.planes.entities) {
      const plane = entity.getValue(XRPlaneComponent, '_plane') as XRPlane | undefined;
      const object = entity.object3D;
      if (!plane || !object || plane.orientation !== 'vertical' || plane.polygon.length < 3) continue;
      if (!WALL_LABELS.has(plane.semanticLabel ?? '')) continue;
      object.updateWorldMatrix(true, false);
      this.wallN.set(0, 1, 0).transformDirection(object.matrixWorld);
      this.wallN.y = 0;
      if (this.wallN.lengthSq() < 1e-6) continue;
      this.wallN.normalize();
      this.wallC.setFromMatrixPosition(object.matrixWorld);
      // Inward: the side the course is on.
      let fromSide = this.point.copy(from).sub(this.wallC).dot(this.wallN);
      if (fromSide < 0) {
        this.wallN.negate();
        fromSide = -fromSide;
      }
      const pointSide = this.point.copy(point).sub(this.wallC).dot(this.wallN);
      if (pointSide >= margin || fromSide < margin) continue;
      // Only within the wall's extent (30 cm of slack).
      this.inverse.copy(object.matrixWorld).invert();
      this.point.copy(point).applyMatrix4(this.inverse);
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const vertex of plane.polygon) {
        x0 = Math.min(x0, vertex.x);
        x1 = Math.max(x1, vertex.x);
        z0 = Math.min(z0, vertex.z);
        z1 = Math.max(z1, vertex.z);
      }
      if (this.point.x < x0 - 0.3 || this.point.x > x1 + 0.3 || this.point.z < z0 - 0.3 || this.point.z > z1 + 0.3) continue;
      point.addScaledVector(this.wallN, margin - pointSide);
    }
  }

  /** The scan's global (room) mesh, if the headset provides one. */
  globalMesh(): Mesh | null {
    for (const entity of this.queries.meshes.entities) {
      const label = entity.getValue(XRMeshComponent, 'semanticLabel') as string;
      if (label === 'global mesh' && entity.object3D instanceof Mesh) {
        return entity.object3D;
      }
    }
    return null;
  }

  /** Recomputes the scan's colliders when the scan or the stage changed. */
  private maybePushRoom(now: number): void {
    const stageEntity = this.queries.stages.entities.values().next().value as Entity | undefined;
    const stage = stageEntity?.object3D;
    if (!stage) {
      return;
    }
    stage.updateWorldMatrix(true, false);
    const moved = !stage.matrixWorld.equals(this.pushedStage);
    const changed = this.scanVersion !== this.pushedVersion;
    if ((!moved && !changed && this.pushedMr) || now - this.lastPushAt < ROOM_PUSH_MS) {
      return;
    }
    this.pushedStage.copy(stage.matrixWorld);
    this.pushedVersion = this.scanVersion;
    this.pushedMr = true;
    this.lastPushAt = now;
    this.roomColliders = this.physicsColliders(stage);
    this.roomVersion++;
    console.info(`[room] colliders: ${this.roomColliders.length} (${this.physicsSummary})`);
  }

  /**
   * The scan as static colliders in the stage's MuJoCo frame: vertical
   * planes become thin wall slabs, horizontal surfaces (table tops, seats)
   * thin slabs at their height, and bounded furniture meshes solid boxes;
   * tables and desks get a top plus four legs so the duck can walk under.
   */
  physicsColliders(stage: Object3D): PhysicsCollider[] {
    const out: PhysicsCollider[] = [];
    let walls = 0;
    let furniture = 0;
    let surfaces = 0;
    stage.updateWorldMatrix(true, false);
    this.stageInverse.copy(stage.matrixWorld).invert();
    const push = (object: Object3D, spec: ColliderSpec) => {
      this.relative.multiplyMatrices(this.stageInverse, object.matrixWorld);
      out.push(colliderFromSpec(spec, this.relative));
    };
    for (const entity of this.queries.planes.entities) {
      const object = entity.object3D;
      const plane = entity.getValue(XRPlaneComponent, '_plane') as XRPlane | undefined;
      if (!object || !plane || plane.polygon.length < 3) continue;
      const label = plane.semanticLabel ?? '';
      if (label === 'floor' || label === 'ceiling') continue;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (const vertex of plane.polygon) {
        x0 = Math.min(x0, vertex.x);
        x1 = Math.max(x1, vertex.x);
        z0 = Math.min(z0, vertex.z);
        z1 = Math.max(z1, vertex.z);
      }
      object.updateWorldMatrix(true, false);
      if (plane.orientation === 'vertical') {
        walls++;
        push(object, {
          type: 'box',
          half: [(x1 - x0) / 2, WALL_THICKNESS / 2, (z1 - z0) / 2],
          pos: [(x0 + x1) / 2, -WALL_THICKNESS / 2, (z0 + z1) / 2],
        });
      } else {
        // A surface's height above the stage floor decides whether the duck cares.
        this.column.setFromMatrixPosition(object.matrixWorld).applyMatrix4(this.stageInverse);
        const sizeX = x1 - x0;
        const sizeZ = z1 - z0;
        if (this.column.y < 0.08 || this.column.y > 1.3 || (sizeX > ROOM_SIZE && sizeZ > ROOM_SIZE)) continue;
        surfaces++;
        push(object, {
          type: 'box',
          half: [sizeX / 2, SLAB / 2, sizeZ / 2],
          pos: [(x0 + x1) / 2, -SLAB / 2, (z0 + z1) / 2],
        });
      }
    }
    for (const entity of this.queries.meshes.entities) {
      const object = entity.object3D;
      const label = entity.getValue(XRMeshComponent, 'semanticLabel') as string;
      if (!object || STRUCTURE.has(label) || !entity.getValue(XRMeshComponent, 'isBounded3D')) continue;
      const min = entity.getVectorView(XRMeshComponent, 'min');
      const max = entity.getVectorView(XRMeshComponent, 'max');
      object.updateWorldMatrix(true, false);
      // Which local axis points up, and how big the thing is in the stage frame.
      let up = 1;
      let upDot = 0;
      let sx0 = Infinity;
      let sx1 = -Infinity;
      let sz0 = Infinity;
      let sz1 = -Infinity;
      let lowest = Infinity;
      for (let axis = 0; axis < 3; axis++) {
        this.column.setFromMatrixColumn(object.matrixWorld, axis).normalize();
        if (Math.abs(this.column.y) > Math.abs(upDot)) {
          up = axis;
          upDot = this.column.y;
        }
      }
      for (let k = 0; k < 8; k++) {
        this.column.set(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]);
        this.column.applyMatrix4(object.matrixWorld).applyMatrix4(this.stageInverse);
        sx0 = Math.min(sx0, this.column.x);
        sx1 = Math.max(sx1, this.column.x);
        sz0 = Math.min(sz0, this.column.z);
        sz1 = Math.max(sz1, this.column.z);
        lowest = Math.min(lowest, this.column.y);
      }
      if (lowest > HANGING || (sx1 - sx0 > ROOM_SIZE && sz1 - sz0 > ROOM_SIZE)) continue;
      furniture++;
      const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      if (UNDER_LABELS.has(label) && size[up] > WALK_UNDER) {
        const top = upDot > 0 ? max[up] - SLAB / 2 : min[up] + SLAB / 2;
        const half = [size[0] / 2, size[1] / 2, size[2] / 2];
        half[up] = SLAB / 2;
        const pos = [centre[0], centre[1], centre[2]];
        pos[up] = top;
        push(object, { type: 'box', half: [half[0], half[1], half[2]], pos: [pos[0], pos[1], pos[2]] });
        const [a, b] = [0, 1, 2].filter((axis) => axis !== up);
        for (const sa of [-1, 1]) {
          for (const sb of [-1, 1]) {
            const leg = [centre[0], centre[1], centre[2]];
            leg[a] += sa * (size[a] / 2 - LEG_RADIUS * 1.5);
            leg[b] += sb * (size[b] / 2 - LEG_RADIUS * 1.5);
            push(object, {
              type: 'cylinder',
              radius: LEG_RADIUS,
              halfHeight: size[up] / 2,
              pos: [leg[0], leg[1], leg[2]],
              quat: AXIS_QUAT[up],
            });
          }
        }
      } else {
        push(object, {
          type: 'box',
          half: [Math.max(0.02, size[0] / 2 - 0.02), Math.max(0.02, size[1] / 2 - 0.02), Math.max(0.02, size[2] / 2 - 0.02)],
          pos: [centre[0], centre[1], centre[2]],
        });
      }
    }
    this.physicsSummary = `${walls} wall${walls === 1 ? '' : 's'}, ${furniture + surfaces} furniture`;
    return out;
  }

  /** World-space footprints of the scanned furniture, as last collected (for the autopilot). */
  obstacleBoxes(): { minX: number; maxX: number; minZ: number; maxZ: number }[] {
    if (this.mixedReality) this.collectObstacles();
    return this.mixedReality ? this.boxes : [];
  }

  /** The course footprint from the stage's pieces (anything near the floor), with a margin. */
  private measureCourse(): void {
    const stage = this.queries.stages.entities.values().next().value as Entity | undefined;
    const object = stage?.object3D;
    if (!object) {
      return;
    }
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const child of object.children) {
      if (child.position.y > 1) continue; // the key light
      x0 = Math.min(x0, child.position.x);
      x1 = Math.max(x1, child.position.x);
      z0 = Math.min(z0, child.position.z);
      z1 = Math.max(z1, child.position.z);
    }
    if (x1 - x0 < 0.5) {
      this.courseX = DEFAULT_COURSE_X;
      this.courseZ = DEFAULT_COURSE_Z;
      return;
    }
    this.courseX = [x0 - PIECE_MARGIN, x1 + PIECE_MARGIN];
    this.courseZ = [Math.min(z0, -0.15) - PIECE_MARGIN, Math.max(z1, 0.15) + PIECE_MARGIN];
  }

  /** World-space footprints of scanned furniture, grown by the margin. */
  private collectObstacles(): void {
    this.boxes.length = 0;
    this.labels.length = 0;
    for (const entity of this.queries.meshes.entities) {
      const object = entity.object3D;
      const label = entity.getValue(XRMeshComponent, 'semanticLabel') as string;
      if (!object || STRUCTURE.has(label) || !entity.getValue(XRMeshComponent, 'isBounded3D')) {
        continue;
      }
      const min = entity.getVectorView(XRMeshComponent, 'min');
      const max = entity.getVectorView(XRMeshComponent, 'max');
      object.updateWorldMatrix(true, false);
      const box = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };
      let lowest = Infinity;
      for (let k = 0; k < 8; k++) {
        this.corner.set(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]);
        this.corner.applyMatrix4(object.matrixWorld);
        box.minX = Math.min(box.minX, this.corner.x);
        box.maxX = Math.max(box.maxX, this.corner.x);
        box.minZ = Math.min(box.minZ, this.corner.z);
        box.maxZ = Math.max(box.maxZ, this.corner.z);
        lowest = Math.min(lowest, this.corner.y);
      }
      const sizeX = box.maxX - box.minX;
      const sizeZ = box.maxZ - box.minZ;
      if (lowest > 0.6 || (sizeX > ROOM_SIZE && sizeZ > ROOM_SIZE)) {
        continue; // hangs above the duck (a wall screen, a lamp), or is the room itself
      }
      this.boxes.push(grow(box));
      this.labels.push(
        `${label || '?'}(${sizeX.toFixed(1)}x${sizeZ.toFixed(1)})@(${((box.minX + box.maxX) / 2).toFixed(1)},${((box.minZ + box.maxZ) / 2).toFixed(1)})`,
      );
    }
    for (const entity of this.queries.planes.entities) {
      const object = entity.object3D;
      const plane = entity.getValue(XRPlaneComponent, '_plane') as XRPlane | undefined;
      if (
        !object ||
        !plane ||
        plane.orientation !== 'horizontal' ||
        STRUCTURE.has(plane.semanticLabel ?? '')
      ) {
        continue;
      }
      object.updateWorldMatrix(true, false);
      const box = {
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };
      let height = 0;
      for (const vertex of plane.polygon) {
        this.corner.set(vertex.x, vertex.y, vertex.z).applyMatrix4(object.matrixWorld);
        box.minX = Math.min(box.minX, this.corner.x);
        box.maxX = Math.max(box.maxX, this.corner.x);
        box.minZ = Math.min(box.minZ, this.corner.z);
        box.maxZ = Math.max(box.maxZ, this.corner.z);
        height = this.corner.y;
      }
      const sizeX = box.maxX - box.minX;
      const sizeZ = box.maxZ - box.minZ;
      if (height > 1.3 || box.minX === Infinity || (sizeX > ROOM_SIZE && sizeZ > ROOM_SIZE)) {
        continue;
      }
      this.boxes.push(grow(box));
      this.labels.push(
        `${plane.semanticLabel || '?'}-top(${sizeX.toFixed(1)}x${sizeZ.toFixed(1)})@(${((box.minX + box.maxX) / 2).toFixed(1)},${((box.minZ + box.maxZ) / 2).toFixed(1)})`,
      );
    }
  }

  /** Keep a depth-only twin of every bounded furniture mesh in step with it. */
  private syncOccluders(): void {
    this.occluderRoot.updateWorldMatrix(true, false);
    this.rootInverse.copy(this.occluderRoot.matrixWorld).invert();
    for (const [entity, twin] of this.occluders) {
      if (!entity.active) {
        this.dropOccluder(entity, twin);
      }
    }
    for (const entity of this.queries.meshes.entities) {
      const source = entity.object3D;
      if (!(source instanceof Mesh)) {
        continue;
      }
      const label = entity.getValue(XRMeshComponent, 'semanticLabel') as string;
      if (label === 'global mesh' || !entity.getValue(XRMeshComponent, 'isBounded3D')) {
        continue;
      }
      let twin = this.occluders.get(entity);
      if (!twin) {
        twin = new Mesh(source.geometry, this.occluderMaterial);
        twin.name = `occluder:${label}`;
        twin.renderOrder = -10;
        twin.matrixAutoUpdate = false;
        this.occluderRoot.add(twin);
        this.occluders.set(entity, twin);
        console.info(`[room] occluder for ${label}`);
      } else if (twin.geometry !== source.geometry) {
        twin.geometry = source.geometry;
      }
      source.updateWorldMatrix(true, false);
      twin.matrix.copy(source.matrixWorld).premultiply(this.rootInverse);
    }
  }

  /** Keeps a slab per scanned plane (not the floor or ceiling) in step with the scan, for the duck cam. */
  private syncPlaneTwins(): void {
    for (const entity of this.planeTwins.keys()) {
      if (!entity.active) this.dropPlaneTwin(entity);
    }
    for (const entity of this.queries.planes.entities) {
      const source = entity.object3D;
      const plane = entity.getValue(XRPlaneComponent, '_plane') as XRPlane | undefined;
      if (!source || !plane || plane.polygon.length < 3) continue;
      const label = plane.semanticLabel ?? '';
      if (label === 'floor' || label === 'ceiling') continue;
      let twin = this.planeTwins.get(entity);
      if (!twin || twin.changed !== plane.lastChangedTime) {
        const geometry = planeSlab(plane, label);
        if (!geometry) continue;
        const material =
          plane.orientation !== 'vertical'
            ? this.camMaterial
            : DOOR_LABELS.has(label)
              ? this.doorMaterial
              : WINDOW_LABELS.has(label)
                ? this.windowMaterial
                : WALL_LABELS.has(label)
                  ? this.wallMaterial
                  : this.camMaterial;
        if (twin) {
          twin.mesh.geometry.dispose();
          twin.mesh.geometry = geometry;
          twin.mesh.material = material;
          twin.changed = plane.lastChangedTime;
          twin.soft = material === this.camMaterial;
        } else {
          const mesh = new Mesh(geometry, material);
          mesh.name = `cam-model:${label || plane.orientation}`;
          mesh.matrixAutoUpdate = false;
          this.camModel.add(mesh);
          twin = { mesh, changed: plane.lastChangedTime, soft: material === this.camMaterial };
          this.planeTwins.set(entity, twin);
        }
      }
      source.updateWorldMatrix(true, false);
      twin.mesh.matrix.copy(source.matrixWorld).premultiply(this.rootInverse);
    }
  }

  private dropPlaneTwin(entity: Entity): void {
    const twin = this.planeTwins.get(entity);
    if (!twin) return;
    twin.mesh.removeFromParent();
    twin.mesh.geometry.dispose();
    this.planeTwins.delete(entity);
  }

  private dropOccluder(entity: Entity, twin = this.occluders.get(entity)): void {
    if (twin) {
      twin.removeFromParent();
      this.occluders.delete(entity);
    }
  }
}

/**
 * A scanned plane as a thin slab in the plane's own frame (y is its normal,
 * pointing into the room): walls sit behind their surface, doors, windows and
 * wall art stand a centimetre out of it, table tops hang below theirs. Null
 * for slivers and for room-sized horizontal planes.
 */
function planeSlab(plane: XRPlane, label: string): BoxGeometry | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const vertex of plane.polygon) {
    x0 = Math.min(x0, vertex.x);
    x1 = Math.max(x1, vertex.x);
    z0 = Math.min(z0, vertex.z);
    z1 = Math.max(z1, vertex.z);
  }
  const sizeX = x1 - x0;
  const sizeZ = z1 - z0;
  if (!(sizeX > 0.02 && sizeZ > 0.02)) return null;
  let thickness = SLAB;
  let top = 0;
  if (plane.orientation === 'vertical') {
    const onWall = !WALL_LABELS.has(label);
    thickness = onWall ? WALL_THICKNESS + PROUD : WALL_THICKNESS;
    top = onWall ? PROUD : 0;
  } else if (sizeX > ROOM_SIZE && sizeZ > ROOM_SIZE) {
    return null;
  }
  const geometry = new BoxGeometry(sizeX, thickness, sizeZ);
  geometry.translate((x0 + x1) / 2, top - thickness / 2, (z0 + z1) / 2);
  return geometry;
}

function grow(box: { minX: number; maxX: number; minZ: number; maxZ: number }) {
  box.minX -= MARGIN;
  box.maxX += MARGIN;
  box.minZ -= MARGIN;
  box.maxZ += MARGIN;
  return box;
}

/** Ray-casting point-in-polygon on the plane's (x, z). */
function insidePolygon(polygon: ArrayLike<{ x: number; z: number }>, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
