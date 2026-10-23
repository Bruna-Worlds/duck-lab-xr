// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Live terrain: what the headset's depth sensor sees on the floor becomes
 * solid ground for the duck. Every depth image is unprojected into the
 * stage frame and binned into a height map (one cell per 4 cm) that the sim
 * worker applies to a MuJoCo height field (see terrain-spec.ts). A ball
 * dropped in front of the duck, a shoe, your foot: the duck bumps into it,
 * falls over it or climbs on it. Cells the sensor can see again are
 * refreshed, so a picked-up object disappears; cells out of view keep their
 * last height. The room scan's global mesh seeds the map before the sensor
 * has looked around.
 *
 * Two depth sources: CPU depth (the emulator, and headsets that offer it)
 * is read directly; GPU depth (the Quest) is copied through a small render
 * pass and read back. Press H (or the lab panel button) to see the map as
 * translucent blocks.
 */
import {
  BoxGeometry,
  Color,
  createSystem,
  DepthSensingSystem,
  type Entity,
  FloatType,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
} from '@iwsdk/core';
import { BALL_OFFSET, BALL_RADIUS } from '../duck/duck-constants.js';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';
import type { PhysicsCollider } from '../duck/mjcf.js';
import {
  TERRAIN_CELL,
  TERRAIN_HEIGHT_CAP,
  TERRAIN_MIN_HEIGHT,
  TERRAIN_N,
  terrainCol,
  terrainElevation,
  terrainRow,
  terrainX,
  terrainY,
} from '../duck/terrain-spec.js';
import { RoomSystem } from './room-system.js';

const UPDATE_MS = 100; // 10 Hz is plenty for things on the floor
const MIN_DEPTH = 0.15;
const MAX_DEPTH = 3.5; // Quest depth gets noisy beyond this
const MAX_SAMPLES = 50000; // subsample bigger depth images
const SMOOTH = 0.5; // per update, towards the newly seen height
const DUCK_GUARD = 0.16; // never raise the ground under the duck
const BALL_GUARD = BALL_RADIUS + 0.05;
const MAX_BLOCKS = 4000; // debug view instances
const CELLS = TERRAIN_N * TERRAIN_N;
const WALK_UNDER = 0.22; // a scanned collider whose bottom is above this is walked under
const SPLAT = TERRAIN_CELL / 2; // sampling step when rasterising a collider

/** What both depth paths produce: a depth image in metres plus its geometry. */
interface DepthImage {
  width: number;
  height: number;
  /** width * height depths in metres, row-major, 0 = invalid. */
  metres: Float32Array;
  /** Normalised view coordinates -> normalised depth-buffer coordinates. */
  bufferFromView: Float32Array;
  /** The sensor's projection matrix (column-major). */
  projection: Float32Array;
  /** The sensor's pose in world space. */
  sensorToWorld: Matrix4;
}

interface DepthInfoLike {
  width: number;
  height: number;
  rawValueToMeters: number;
  normDepthBufferFromNormView: { matrix: Float32Array; inverse: { matrix: Float32Array } };
  projectionMatrix?: Float32Array;
  transform?: { matrix: Float32Array };
}
interface CpuDepthInfo extends DepthInfoLike {
  data: ArrayBuffer;
}
interface GpuDepthInfo extends DepthInfoLike {
  texture: WebGLTexture;
}

export class TerrainSystem extends createSystem({
  stages: { required: [DuckStage] },
}) {
  /** Heights in metres per cell (-1 = never seen), stage MuJoCo frame, from the depth sensor. */
  readonly heights = new Float32Array(CELLS).fill(-1);
  /** Heights from the room scan's colliders (walls, furniture), rasterised; 0 = nothing. */
  readonly scanHeights = new Float32Array(CELLS);
  scanCells = 0;
  private roomVersion = -1;
  /** True while a mixed-reality session feeds the map. */
  active = false;
  /** Stops depth updates (tests and debugging: the map keeps what it has). */
  frozen = false;
  /** For the lab panel. */
  summary = 'Terrain: off';
  raised = 0;
  private duck: DuckSystem | undefined;
  private room: RoomSystem | undefined;
  private depthSystem: DepthSensingSystem | undefined;
  private frameMax!: Float32Array;
  private lastUpdate = 0;
  private updateHz = 0;
  private usage: 'cpu' | 'gpu' | 'none' = 'none';
  private stageMatrix!: Matrix4;
  private stageInverse!: Matrix4;
  private viewToStage!: Matrix4;
  private refToWorld!: Matrix4;
  private viewMatrix!: Matrix4;
  private invProjection!: Matrix4;
  private v!: Vector3;
  private dirs: Float32Array | null = null;
  private pixelIndex: Int32Array | null = null;
  private dirsKey = '';
  private metres: Float32Array | null = null;
  private dirty = false;
  private lastSim: unknown = null;
  private seeded = false;
  private scanVersion = -1;
  // Debug blocks.
  private blocks: InstancedMesh | null = null;
  private blocksEntity: Entity | null = null;
  private blockMatrix!: Matrix4;
  private blockColor!: Color;
  private showBlocks = false;
  // GPU depth readback (asynchronous: the pixels arrive a frame or two later).
  private readTarget: WebGLRenderTarget | null = null;
  private readMaterial: ShaderMaterial | null = null;
  private readScene: Scene | null = null;
  private readCamera: OrthographicCamera | null = null;
  private readPixels: Float32Array | null = null;
  private gpuInFlight = false;
  private gpuResult: DepthImage | null = null;
  private gpuPose: Matrix4[] = [new Matrix4(), new Matrix4()];
  private gpuPoseIndex = 0;
  private gpuWarned = false;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.room = this.world.getSystem(RoomSystem);
    this.depthSystem = this.world.getSystem(DepthSensingSystem);
    this.frameMax = new Float32Array(CELLS).fill(-1);
    this.stageMatrix = new Matrix4().makeScale(0, 0, 0); // never equal to a real stage
    this.stageInverse = new Matrix4();
    this.viewToStage = new Matrix4();
    this.refToWorld = new Matrix4();
    this.viewMatrix = new Matrix4();
    this.invProjection = new Matrix4();
    this.v = new Vector3();
    this.blockMatrix = new Matrix4();
    this.blockColor = new Color();
    this.queries.stages.subscribe('disqualify', () => {
      this.blocks = null; // went with the stage
      this.blocksEntity = null;
    });
    this.cleanupFuncs.push(() => {
      this.readTarget?.dispose();
      this.readMaterial?.dispose();
    });
  }

  /** Marks the map changed (after writing heights directly, in tests). */
  touch(): void {
    this.dirty = true;
  }

  toggleBlocks(): void {
    this.showBlocks = !this.showBlocks;
    if (this.blocks) this.blocks.visible = this.showBlocks;
    if (this.showBlocks) this.dirty = true;
  }

  get blocksShown(): boolean {
    return this.showBlocks;
  }

  update(): void {
    if (this.input.keyboard.getKeyDown('KeyH')) this.toggleBlocks();
    const duck = this.duck;
    const sim = duck?.sim;
    const session = this.world.session;
    const mixedReality = !!session && session.environmentBlendMode !== 'opaque';
    const stageEntity = this.queries.stages.entities.values().next().value as Entity | undefined;
    const stage = stageEntity?.object3D;
    if (!sim?.ready || !stage) {
      return;
    }
    if (sim !== this.lastSim) {
      this.lastSim = sim; // a new sim starts flat: send the map again
      this.dirty = true;
    }
    stage.updateWorldMatrix(true, false);
    if (!stage.matrixWorld.equals(this.stageMatrix)) {
      // The course moved: the map is in the stage frame, so start over.
      this.stageMatrix.copy(stage.matrixWorld);
      this.stageInverse.copy(stage.matrixWorld).invert();
      this.heights.fill(-1);
      this.seeded = false;
      this.dirty = true;
    }
    if (!mixedReality) {
      if (this.active) {
        this.active = false;
        this.heights.fill(-1);
        this.scanHeights.fill(0);
        this.scanCells = 0;
        this.roomVersion = -1;
        this.dirty = true;
        this.summary = 'Terrain: off (not in mixed reality)';
      }
      this.flush(sim);
      return;
    }
    this.active = true;
    const now = performance.now();
    if (!this.seeded || this.scanVersion !== (this.room?.scanVersion ?? -1)) {
      this.seedFromScan();
    }
    if (this.room && this.roomVersion !== this.room.roomVersion) {
      this.roomVersion = this.room.roomVersion;
      this.rasterise(this.room.roomColliders);
    }
    if (!this.frozen && now - this.lastUpdate >= UPDATE_MS) {
      const image = this.readDepth(session);
      if (image) {
        this.updateHz = this.lastUpdate ? this.updateHz + 0.2 * (1000 / (now - this.lastUpdate) - this.updateHz) : 0;
        this.lastUpdate = now;
        this.merge(image);
        this.dirty = true;
      }
    }
    this.flush(sim);
    if (this.showBlocks) this.ensureBlocks(stageEntity!);
  }

  /** Sends the map to the sim when it changed and a buffer is free. */
  private flush(sim: NonNullable<DuckSystem['sim']>): void {
    if (!this.dirty) return;
    const buffer = sim.takeTerrainBuffer();
    if (!buffer) return;
    let raised = 0;
    let tallest = 0;
    const heights = this.heights;
    const scan = this.scanHeights;
    for (let i = 0; i < CELLS; i++) {
      const h = Math.max(heights[i], scan[i]);
      const e = h > 0 ? terrainElevation(h) : 0;
      buffer[i] = e;
      if (e > 0) {
        raised++;
        if (h > tallest) tallest = h;
      }
    }
    sim.setTerrain(buffer);
    this.dirty = false;
    this.raised = raised;
    if (this.active) {
      this.summary =
        `Terrain: ${this.usage} depth ${this.metres ? `${this.lastWidth}x${this.lastHeight}` : '-'} at ${this.updateHz.toFixed(1)} Hz, ` +
        `${raised} raised cells (${this.scanCells} from the scan), tallest ${tallest.toFixed(2)} m`;
    }
    if (this.blocks) this.layoutBlocks();
  }

  private lastWidth = 0;
  private lastHeight = 0;

  /** One depth image from whichever path the session offers. */
  private readDepth(session: XRSession): DepthImage | null {
    const frame = this.xrFrame;
    const refSpace = this.xrManager.getReferenceSpace();
    if (!frame || !refSpace) return null;
    const pose = frame.getViewerPose(refSpace);
    const view = pose?.views[0];
    if (!view) return null;
    const usage = (session as { depthUsage?: string }).depthUsage;
    const xrCamera = this.world.renderer.xr.getCamera();
    const eye = xrCamera.cameras[0] ?? xrCamera;
    // World pose of the XR reference space: the eye's world matrix is refToWorld * view.transform.
    this.viewMatrix.fromArray(view.transform.matrix);
    this.refToWorld.copy(eye.matrixWorld).multiply(this.viewMatrix.clone().invert());
    let info: DepthInfoLike | null = null;
    let metres: Float32Array | null = null;
    if (usage === 'gpu-optimized') {
      this.usage = 'gpu';
      return this.readGpuDepth(eye.matrixWorld);
    } else {
      const getter = frame as unknown as { getDepthInformation?: (view: XRView) => CpuDepthInfo | null | undefined };
      const cpu = getter.getDepthInformation?.(view);
      if (!cpu) return null;
      const format = (session as { depthDataFormat?: string }).depthDataFormat ?? 'float32';
      const count = cpu.width * cpu.height;
      if (!this.metres || this.metres.length !== count) this.metres = new Float32Array(count);
      metres = this.metres;
      const scale = cpu.rawValueToMeters;
      if (format === 'float32') {
        const raw = new Float32Array(cpu.data, 0, count);
        for (let i = 0; i < count; i++) metres[i] = raw[i] * scale;
      } else {
        const raw = new Uint16Array(cpu.data, 0, count);
        for (let i = 0; i < count; i++) metres[i] = raw[i] * scale;
      }
      info = cpu;
      this.usage = 'cpu';
    }
    this.lastWidth = info.width;
    this.lastHeight = info.height;
    const projection = info.projectionMatrix ?? view.projectionMatrix;
    const sensorToWorld = this.viewToStage; // reused as scratch for the sensor pose
    if (info.transform) {
      sensorToWorld.fromArray(info.transform.matrix).premultiply(this.refToWorld);
    } else {
      sensorToWorld.copy(eye.matrixWorld);
    }
    return {
      width: info.width,
      height: info.height,
      metres,
      bufferFromView: info.normDepthBufferFromNormView.matrix,
      projection,
      sensorToWorld,
    };
  }

  /**
   * GPU depth: copy the texture array's first layer into a small float
   * target and read it back without stalling (fence + pixel buffer). The
   * image that comes back carries the sensor pose it was captured with, and
   * is returned on a later call; one read is in flight at a time.
   */
  private readGpuDepth(eyeToWorld: Matrix4): DepthImage | null {
    if (this.gpuResult) {
      const result = this.gpuResult;
      this.gpuResult = null;
      return result;
    }
    if (this.gpuInFlight) return null;
    const depthSystem = this.depthSystem as unknown as
      | { getDepthTextureArray(): unknown; gpuDepthData: GpuDepthInfo[] }
      | undefined;
    const texture = depthSystem?.getDepthTextureArray();
    const info = depthSystem?.gpuDepthData?.[0];
    if (!texture || !info) return null;
    try {
      const renderer = this.world.renderer;
      if (!this.readMaterial) {
        this.readMaterial = new ShaderMaterial({
          name: 'DepthReadback',
          uniforms: { uDepth: { value: null }, uScale: { value: 1 } },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = vec4(position.xy, 0.0, 1.0);
            }`,
          fragmentShader: /* glsl */ `
            precision highp float;
            precision highp sampler2DArray;
            uniform sampler2DArray uDepth;
            uniform float uScale;
            varying vec2 vUv;
            void main() {
              float raw = texture(uDepth, vec3(vUv, 0.0)).r;
              gl_FragColor = vec4(raw * uScale, 0.0, 0.0, 1.0);
            }`,
          depthTest: false,
          depthWrite: false,
        });
        this.readScene = new Scene();
        this.readScene.add(new Mesh(new PlaneGeometry(2, 2), this.readMaterial));
        this.readCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
      }
      const width = Math.max(1, Math.round(info.width / 2));
      const height = Math.max(1, Math.round(info.height / 2));
      if (!this.readTarget || this.readTarget.width !== width || this.readTarget.height !== height) {
        this.readTarget?.dispose();
        this.readTarget = new WebGLRenderTarget(width, height, { format: RGBAFormat, type: FloatType, depthBuffer: false });
        this.readPixels = new Float32Array(width * height * 4);
        this.metres = new Float32Array(width * height);
      }
      this.readMaterial.uniforms.uDepth.value = texture;
      this.readMaterial.uniforms.uScale.value = info.rawValueToMeters;
      const xrEnabled = renderer.xr.enabled;
      const previous = renderer.getRenderTarget();
      renderer.xr.enabled = false;
      renderer.setRenderTarget(this.readTarget);
      renderer.render(this.readScene!, this.readCamera!);
      renderer.setRenderTarget(previous);
      renderer.xr.enabled = xrEnabled;
      // Everything the unprojection needs, as of this capture.
      const pose = this.gpuPose[this.gpuPoseIndex];
      this.gpuPoseIndex = 1 - this.gpuPoseIndex;
      if (info.transform) {
        pose.fromArray(info.transform.matrix).premultiply(this.refToWorld);
      } else {
        pose.copy(eyeToWorld);
      }
      const projection = info.projectionMatrix ?? this.world.renderer.xr.getCamera().cameras[0]?.projectionMatrix.toArray();
      const bufferFromView = info.normDepthBufferFromNormView.matrix;
      const target = this.readTarget;
      const pixels = this.readPixels!;
      const metres = this.metres!;
      this.gpuInFlight = true;
      this.lastWidth = width;
      this.lastHeight = height;
      void renderer
        .readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels)
        .then(() => {
          for (let i = 0; i < metres.length; i++) metres[i] = pixels[i * 4];
          this.gpuResult = {
            width,
            height,
            metres,
            bufferFromView,
            projection: projection instanceof Float32Array ? projection : new Float32Array(projection as ArrayLike<number>),
            sensorToWorld: pose,
          };
        })
        .catch((err: unknown) => this.warnGpu(err))
        .finally(() => {
          this.gpuInFlight = false;
        });
      return null;
    } catch (err) {
      this.warnGpu(err);
      return null;
    }
  }

  private warnGpu(err: unknown): void {
    if (!this.gpuWarned) {
      this.gpuWarned = true;
      console.warn('[terrain] GPU depth readback failed; the terrain stays as scanned', err);
    }
  }

  /** Per-pixel view-space ray directions at z = -1, for a sampled pixel grid. */
  private prepareDirs(image: DepthImage): void {
    const { width, height, projection: proj, bufferFromView } = image;
    const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)));
    const key = `${width}x${height}/${stride}|${proj[0]},${proj[5]},${proj[8]},${proj[9]}|${bufferFromView[0]},${bufferFromView[5]},${bufferFromView[12]},${bufferFromView[13]}`;
    if (key === this.dirsKey && this.dirs) return;
    this.dirsKey = key;
    this.invProjection.fromArray(proj).invert();
    const t = new Matrix4().fromArray(bufferFromView).invert().elements;
    const cols = Math.floor((width - stride / 2) / stride) + 1;
    const rows = Math.floor((height - stride / 2) / stride) + 1;
    const count = cols * rows;
    const dirs = new Float32Array(count * 2);
    const index = new Int32Array(count);
    const e = this.invProjection.elements;
    let k = 0;
    for (let j = 0; j < rows; j++) {
      const r = Math.min(height - 1, Math.floor(stride / 2) + j * stride);
      for (let i = 0; i < cols; i++) {
        const c = Math.min(width - 1, Math.floor(stride / 2) + i * stride);
        const bx = (c + 0.5) / width;
        const by = (r + 0.5) / height;
        // Depth-buffer coordinates -> normalised view coordinates (origin top left).
        const vx = t[0] * bx + t[4] * by + t[12];
        const vy = t[1] * bx + t[5] * by + t[13];
        const nx = 2 * vx - 1;
        const ny = 1 - 2 * vy;
        // Unproject the far-plane point and scale the ray to z = -1.
        const px = e[0] * nx + e[4] * ny + e[8] + e[12];
        const py = e[1] * nx + e[5] * ny + e[9] + e[13];
        const pz = e[2] * nx + e[6] * ny + e[10] + e[14];
        const pw = e[3] * nx + e[7] * ny + e[11] + e[15];
        const z = pz / pw;
        dirs[k * 2] = z < 0 ? px / pw / -z : 0;
        dirs[k * 2 + 1] = z < 0 ? py / pw / -z : 0;
        index[k] = r * width + c;
        k++;
      }
    }
    this.dirs = dirs;
    this.pixelIndex = index;
  }

  /** Bins one depth image into the map. */
  private merge(image: DepthImage): void {
    this.prepareDirs(image);
    const dirs = this.dirs!;
    const index = this.pixelIndex!;
    const metres = image.metres;
    const m = this.viewToStage.multiplyMatrices(this.stageInverse, image.sensorToWorld).elements;
    const frameMax = this.frameMax;
    for (let k = 0; k < index.length; k++) {
      const z = metres[index[k]];
      if (!(z > MIN_DEPTH && z < MAX_DEPTH)) continue;
      const px = dirs[k * 2] * z;
      const py = dirs[k * 2 + 1] * z;
      const pz = -z;
      const sy = m[1] * px + m[5] * py + m[9] * pz + m[13];
      if (sy > TERRAIN_HEIGHT_CAP) continue; // walls, hands held high: not floor stuff
      const sx = m[0] * px + m[4] * py + m[8] * pz + m[12];
      const sz = m[2] * px + m[6] * py + m[10] * pz + m[14];
      const col = terrainCol(sx);
      const row = terrainRow(-sz);
      if (col < 0 || row < 0) continue;
      const i = row * TERRAIN_N + col;
      const h = sy < 0 ? 0 : sy;
      if (h > frameMax[i]) frameMax[i] = h;
    }
    // Merge the cells seen this time; never raise the ground under the duck or the ball.
    const duck = this.duck!;
    const pose = duck.pose;
    const guard = duck.hasPose;
    const dx = pose[0];
    const dy = pose[1];
    const bx = pose[BALL_OFFSET];
    const by = pose[BALL_OFFSET + 1];
    const heights = this.heights;
    for (let i = 0; i < CELLS; i++) {
      const seen = frameMax[i];
      if (seen < 0) continue;
      frameMax[i] = -1;
      const target = seen < TERRAIN_MIN_HEIGHT ? 0 : seen;
      const current = heights[i];
      if (guard && target > current) {
        const cx = terrainX(i % TERRAIN_N);
        const cy = terrainY(Math.floor(i / TERRAIN_N));
        if (Math.hypot(cx - dx, cy - dy) < DUCK_GUARD || Math.hypot(cx - bx, cy - by) < BALL_GUARD) continue;
      }
      heights[i] = current < 0 ? target : current + SMOOTH * (target - current);
    }
  }

  /**
   * The scan's colliders (walls, furniture, table legs) as terrain: each box
   * or cylinder is splatted onto the cells under it at its top height
   * (capped), unless the duck can walk under it. Walls become 55 cm ridges,
   * which is all a 25 cm duck needs.
   */
  private rasterise(colliders: PhysicsCollider[]): void {
    const scan = this.scanHeights;
    scan.fill(0);
    let cells = 0;
    const mark = (x: number, y: number, h: number) => {
      const col = terrainCol(x);
      const row = terrainRow(y);
      if (col < 0 || row < 0) return;
      const i = row * TERRAIN_N + col;
      if (h > scan[i]) {
        if (scan[i] === 0) cells++;
        scan[i] = h;
      }
    };
    for (const c of colliders) {
      const [px, py, pz] = c.pos;
      const [qw, qx, qy, qz] = c.quat;
      if (c.type === 'sphere') continue;
      // Half extents along the collider's own axes (cylinder: radius, radius, half height).
      const hx = c.size[0];
      const hy = c.type === 'box' ? c.size[1] : c.size[0];
      const hz = c.type === 'box' ? c.size[2] : c.size[1];
      // Rotation matrix columns from the quaternion.
      const r00 = 1 - 2 * (qy * qy + qz * qz);
      const r10 = 2 * (qx * qy + qw * qz);
      const r20 = 2 * (qx * qz - qw * qy);
      const r01 = 2 * (qx * qy - qw * qz);
      const r11 = 1 - 2 * (qx * qx + qz * qz);
      const r21 = 2 * (qy * qz + qw * qx);
      const r02 = 2 * (qx * qz + qw * qy);
      const r12 = 2 * (qy * qz - qw * qx);
      const r22 = 1 - 2 * (qx * qx + qy * qy);
      const reachZ = Math.abs(r20) * hx + Math.abs(r21) * hy + Math.abs(r22) * hz;
      const top = pz + reachZ;
      const bottom = pz - reachZ;
      if (bottom > WALK_UNDER || top < TERRAIN_MIN_HEIGHT) continue;
      const height = Math.min(top, TERRAIN_HEIGHT_CAP);
      // Walk the collider's own x/y/z grid and drop every sample onto the floor map.
      const nx = Math.max(1, Math.ceil((2 * hx) / SPLAT));
      const ny = Math.max(1, Math.ceil((2 * hy) / SPLAT));
      const nz = Math.max(1, Math.ceil((2 * hz) / SPLAT));
      for (let i = 0; i <= nx; i++) {
        const lx = -hx + (2 * hx * i) / nx;
        for (let j = 0; j <= ny; j++) {
          const ly = -hy + (2 * hy * j) / ny;
          if (c.type === 'cylinder' && lx * lx + ly * ly > hx * hx) continue;
          for (let k = 0; k <= nz; k++) {
            const lz = -hz + (2 * hz * k) / nz;
            mark(px + r00 * lx + r01 * ly + r02 * lz, py + r10 * lx + r11 * ly + r12 * lz, height);
            if (Math.abs(r20) < 1e-3 && Math.abs(r21) < 1e-3) break; // upright: one z sample covers the footprint
          }
        }
      }
    }
    this.scanCells = cells;
    this.dirty = true;
  }

  /** The room scan's global mesh gives the map a start before the sensor has looked around. */
  private seedFromScan(): void {
    this.seeded = true;
    this.scanVersion = this.room?.scanVersion ?? -1;
    const mesh = this.room?.globalMesh();
    const position = mesh?.geometry.getAttribute('position');
    if (!mesh || !position) return;
    mesh.updateWorldMatrix(true, false);
    const m = this.viewToStage.multiplyMatrices(this.stageInverse, mesh.matrixWorld);
    const heights = this.heights;
    let cells = 0;
    for (let i = 0; i < position.count; i++) {
      this.v.fromBufferAttribute(position, i).applyMatrix4(m);
      const h = this.v.y;
      if (h < TERRAIN_MIN_HEIGHT || h > TERRAIN_HEIGHT_CAP) continue;
      const col = terrainCol(this.v.x);
      const row = terrainRow(-this.v.z);
      if (col < 0 || row < 0) continue;
      const k = row * TERRAIN_N + col;
      if (heights[k] < h) {
        heights[k] = h;
        cells++;
      }
    }
    if (cells) {
      this.dirty = true;
      console.info(`[terrain] seeded ${cells} cells from the room scan (${position.count} vertices)`);
    }
  }

  /** The block mesh for the duck cam (built on demand; stays hidden unless toggled). */
  blocksForCam(stage: Entity): InstancedMesh | null {
    if (!this.active) return null;
    if (!this.blocks) {
      this.ensureBlocks(stage);
      if (this.blocks) (this.blocks as InstancedMesh).visible = this.showBlocks;
    }
    return this.blocks;
  }

  private ensureBlocks(stage: Entity): void {
    if (this.blocks) return;
    const mesh = new InstancedMesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false }),
      MAX_BLOCKS,
    );
    mesh.name = 'terrain-blocks';
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.visible = this.showBlocks;
    this.blocks = mesh;
    this.blocksEntity = this.world.createTransformEntity(mesh, { parent: stage });
    this.layoutBlocks();
  }

  /** One translucent block per raised cell, coloured by height (mint low, sky blue high). */
  private layoutBlocks(): void {
    const blocks = this.blocks;
    if (!blocks) return;
    const heights = this.heights;
    const scan = this.scanHeights;
    let n = 0;
    for (let i = 0; i < CELLS && n < MAX_BLOCKS; i++) {
      const h = Math.max(heights[i], scan[i]);
      if (h < TERRAIN_MIN_HEIGHT) continue;
      const x = terrainX(i % TERRAIN_N);
      const y = terrainY(Math.floor(i / TERRAIN_N));
      this.blockMatrix.makeScale(TERRAIN_CELL * 0.9, h, TERRAIN_CELL * 0.9);
      this.blockMatrix.setPosition(x, h / 2, -y);
      blocks.setMatrixAt(n, this.blockMatrix);
      // Mint for low steps, sky blue for walls: the HUD's palette, not a warning red.
      const t = Math.min(1, h / TERRAIN_HEIGHT_CAP);
      blocks.setColorAt(n, this.blockColor.setHSL(0.46 + 0.12 * t, 0.75, 0.62 - 0.12 * t));
      n++;
    }
    blocks.count = n;
    blocks.instanceMatrix.needsUpdate = true;
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  }
}
