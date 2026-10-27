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
 * Two depth sources: GPU depth (the Quest, and the emulator, which is asked
 * for it so that it runs the Quest's code) is copied through a small render
 * pass and read back; CPU depth (browsers that offer only that) is read
 * directly. Press H (or the lab panel button) to see the map as translucent
 * blocks.
 *
 * Real depth is noisy and smears edges into in-between depths, which used to
 * lift soft surfaces (the duck hovered over a dog bed) and grow a ramp around
 * every object. So (docs/microduck/DEPTH.md, phase 1):
 *  - the readback pass reads exact texels, and where a 2 x 2 block holds a
 *    depth edge it keeps the near and the far surface apart (never their
 *    average), like IWSDK's MinMax depth preprocessing but with thresholds in
 *    centimetres, which floor-level edges need;
 *  - points on surfaces seen nearly edge-on are dropped: a smeared edge looks
 *    exactly like that;
 *  - a cell takes the mean of its points when they agree and its second-
 *    highest when they do not (an edge, a step), instead of the highest;
 *  - a cell rises only after a few updates in a row saw it higher, to the
 *    lowest of those sightings, and comes down quickly.
 * `probe()` runs depth images through all of this into a scratch map, with
 * any filter switched off for comparison (tools/test/depth-quality-check.mjs).
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
  type Texture,
  Vector3,
  WebGLRenderTarget,
} from '@iwsdk/core';
import { BALL_OFFSET, BALL_RADIUS } from '../duck/duck-constants.js';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';
import type { PhysicsCollider } from '../duck/mjcf.js';
import {
  setTerrainHalf,
  TERRAIN_HEIGHT_CAP,
  TERRAIN_MIN_HEIGHT,
  TERRAIN_N,
  terrainCell,
  terrainCol,
  terrainElevation,
  terrainHalf,
  terrainRow,
  terrainX,
  terrainY,
} from '../duck/terrain-spec.js';
import { DEPTH_LEVEL_SPEC, type DepthLevel, loadDepthLevel, saveDepthLevel } from './depth-level.js';
import { rasteriseMeshHeights } from './mesh-heights.js';
import { RoomSystem } from './room-system.js';

const UPDATE_MS = 100; // 10 Hz is plenty for things on the floor
const MIN_DEPTH = 0.15;
const MAX_DEPTH = 3.5; // Quest depth gets noisy beyond this
const MAX_SAMPLES = 50000; // subsample bigger depth images
const LEGACY_SMOOTH = 0.5; // the old rule: halfway towards the newly seen height
/**
 * Points on a surface turned further than this from the sensor are dropped:
 * a smeared step (15 cm smeared over three depth pixels from 2 m) tilts about
 * 70 degrees; real floor stays under 65 degrees until about 3.4 m away from a
 * standing person, as far as the depth is used (MAX_DEPTH).
 */
const COS_EDGE_ON = Math.cos((65 * Math.PI) / 180);
/** A far point (behind a depth edge in a readback block) must be this much further than the near one. */
const FAR_MIN = 0.02;
/** A cell whose points' heights spread less than this is flat: it takes their mean. */
const FLAT_SPREAD = 0.02;
/** Sightings within this of the stored height refine it gently; beyond, they need confidence. */
const BAND = 0.02;
const SMOOTH_IN = 0.3; // per update, within the band
const SMOOTH_DOWN = 0.7; // per update, when a cell is seen clearly lower (an object taken away)
const RISE_VOTES = 3; // updates in a row that must see a cell higher before it rises
const DUCK_GUARD = 0.16; // never raise the ground under the duck
const BALL_GUARD = BALL_RADIUS + 0.05;
const MAX_BLOCKS = 4000; // debug view instances
const BLOCK_RUN_TOLERANCE = 0.02; // cells in a row this close in height share a block
const CELLS = TERRAIN_N * TERRAIN_N;
const WALK_UNDER = 0.22; // a scanned collider whose bottom is above this is walked under
/**
 * GPU depth textures (the Quest, and the emulator when asked for GPU depth)
 * store rows bottom-up, as WebGL does: row 0 is the bottom of the view. As a
 * normalised-view -> depth-buffer transform (view y runs downwards) that is
 * y' = 1 - y. IWSDK's occlusion shaders read the texture the same way.
 */
const GPU_BUFFER_FROM_VIEW = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]);
/** Probe images come with row 0 at the top of the view: depth-buffer and view coordinates agree. */
const IDENTITY_BUFFER_FROM_VIEW = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The depth filters: all on in the app; `probe()` can switch any off to compare. */
export interface DepthFilters {
  /** Drop points on surfaces seen nearly edge-on (edges the sensor smeared). */
  edgeOn: boolean;
  /** A cell's height from its points' mean (flat) or second-highest (mixed), not the highest. */
  robust: boolean;
  /** Rise only after RISE_VOTES updates in a row agree; come down quickly. */
  confidence: boolean;
}
const ALL_FILTERS: DepthFilters = { edgeOn: true, robust: true, confidence: true };
/** The original rule (depth level "raw"). */
const NO_FILTERS: DepthFilters = { edgeOn: false, robust: false, confidence: false };

/** One update's points per cell, and each cell's rise in progress, beside the heights they feed. */
interface DepthMaps {
  heights: Float32Array;
  count: Uint16Array;
  sum: Float32Array;
  sumSq: Float32Array;
  top1: Float32Array;
  top2: Float32Array;
  votes: Uint8Array;
  /** The lowest height seen during a cell's current run of higher sightings. */
  pending: Float32Array;
}
const makeMaps = (heights: Float32Array): DepthMaps => ({
  heights,
  count: new Uint16Array(CELLS),
  sum: new Float32Array(CELLS),
  sumSq: new Float32Array(CELLS),
  top1: new Float32Array(CELLS),
  top2: new Float32Array(CELLS),
  votes: new Uint8Array(CELLS),
  pending: new Float32Array(CELLS),
});

/** A depth image for `probe()`: row 0 at the top, depths in metres along the view axis, 0 = none. */
export interface ProbeImage {
  width: number;
  height: number;
  metres: Float32Array;
  far?: Float32Array;
  /** The sensor's projection, column-major. */
  projection: ArrayLike<number>;
  /** The sensor's view frame -> the stage frame (three.js axes), column-major. */
  sensorToStage: ArrayLike<number>;
}

/** What both depth paths produce: a depth image in metres plus its geometry. */
interface DepthImage {
  width: number;
  height: number;
  /** width * height depths in metres, row-major, 0 = invalid. */
  metres: Float32Array;
  /**
   * GPU readback only: where a pixel's 2 x 2 block held a depth edge, the far
   * surface's depth (metres holds the near one); otherwise the same as metres.
   */
  far: Float32Array | null;
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
/** What the GPU path reads: the texture's size and scale, plus the Quest's near plane. */
type GpuDepthSource = DepthInfoLike & { depthNear?: number };

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
  private maps!: DepthMaps;
  private dirCols = 0;
  private dirRows = 0;
  private gpuFar: Float32Array | null = null;
  /** Points binned, and points dropped as edge-on, in the last update. */
  private kept = 0;
  private dropped = 0;
  /** The depth fidelity in use (menu: ROOM DEPTH; depth-level.ts). Change it with setLevel(). */
  level: DepthLevel = 'filtered';
  /** The sim that last got the terrain's extent and feel. */
  private configSim: unknown = null;
  /** Soft contact in place of TERRAIN_SOFT (tuning and tests); null: the default. */
  private softContact: { solref: readonly number[]; solimp: readonly number[] } | null = null;
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
  private gpuMetres: Float32Array | null = null;
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
    this.maps = makeMaps(this.heights);
    this.level = loadDepthLevel();
    setTerrainHalf(DEPTH_LEVEL_SPEC[this.level].half);
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

  /** Forgets every height, and every rise in progress. */
  private clearMap(): void {
    this.heights.fill(-1);
    this.maps.votes.fill(0);
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
    if (sim !== this.configSim) {
      this.configSim = sim;
      sim.setTerrainConfig(terrainHalf(), DEPTH_LEVEL_SPEC[this.level].soft, this.softContact);
    }
    stage.updateWorldMatrix(true, false);
    if (!stage.matrixWorld.equals(this.stageMatrix)) {
      // The course moved: the map is in the stage frame, so start over.
      this.stageMatrix.copy(stage.matrixWorld);
      this.stageInverse.copy(stage.matrixWorld).invert();
      this.clearMap();
      this.seeded = false;
      this.dirty = true;
    }
    if (!mixedReality) {
      if (this.active) {
        this.active = false;
        this.clearMap();
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
    if (!this.frozen && DEPTH_LEVEL_SPEC[this.level].live && now - this.lastUpdate >= UPDATE_MS) {
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
    // Two layers, each its own height field in the sim: the scan's (hard), then depth's.
    for (let i = 0; i < CELLS; i++) {
      const s = scan[i];
      const d = heights[i];
      buffer[i] = s > 0 ? terrainElevation(s) : 0;
      buffer[CELLS + i] = d > 0 ? terrainElevation(d) : 0;
      const h = Math.max(d, s);
      if (terrainElevation(h) > 0) {
        raised++;
        if (h > tallest) tallest = h;
      }
    }
    sim.setTerrain(buffer);
    this.dirty = false;
    this.raised = raised;
    if (this.active) {
      const spec = DEPTH_LEVEL_SPEC[this.level];
      const cm = Math.round(terrainCell() * 100);
      const depth = spec.live
        ? `${this.usage} depth ${this.lastWidth ? `${this.lastWidth}x${this.lastHeight}` : '-'} at ${this.updateHz.toFixed(1)} Hz, `
        : 'live depth not used, ';
      this.summary =
        `Terrain (${spec.label}, ${cm} cm${spec.soft ? ', soft' : ''}): ${depth}` +
        `${raised} raised cells (${this.scanCells} from the scan), tallest ${tallest.toFixed(2)} m` +
        (spec.live && spec.filtered
          ? `, ${this.kept + this.dropped ? Math.round((100 * this.dropped) / (this.kept + this.dropped)) : 0}% of points edge-on`
          : '');
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
    if (usage === 'gpu-optimized') {
      this.usage = 'gpu';
      const depthSystem = this.depthSystem as unknown as
        | { getDepthTextureArray(): Texture | undefined; gpuDepthData: GpuDepthInfo[] }
        | undefined;
      return this.readGpuDepth(depthSystem?.getDepthTextureArray(), depthSystem?.gpuDepthData?.[0], eye.matrixWorld);
    }
    const getter = frame as unknown as { getDepthInformation?: (view: XRView) => CpuDepthInfo | null | undefined };
    const cpu = getter.getDepthInformation?.(view);
    if (!cpu) return null;
    const format = (session as { depthDataFormat?: string }).depthDataFormat ?? 'float32';
    const count = cpu.width * cpu.height;
    if (!this.metres || this.metres.length !== count) this.metres = new Float32Array(count);
    const metres = this.metres;
    const scale = cpu.rawValueToMeters;
    if (format === 'float32') {
      const raw = new Float32Array(cpu.data, 0, count);
      for (let i = 0; i < count; i++) metres[i] = raw[i] * scale;
    } else {
      const raw = new Uint16Array(cpu.data, 0, count);
      for (let i = 0; i < count; i++) metres[i] = raw[i] * scale;
    }
    const info = cpu;
    this.usage = 'cpu';
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
      far: null,
      bufferFromView: info.normDepthBufferFromNormView.matrix,
      projection,
      sensorToWorld,
    };
  }

  /**
   * GPU depth: copy the texture array's first layer (the left eye) into a
   * small float target, converting to metres on the way, and read it back
   * without stalling (fence + pixel buffer). The texture holds depth-buffer
   * values with an infinite far plane, v = 1 - near / metres (0 = no reading),
   * in rows bottom-up. The image that comes back carries the sensor pose it
   * was captured with, and is returned on a later call; one read is in flight
   * at a time.
   */
  private readGpuDepth(texture: Texture | undefined, info: GpuDepthSource | undefined, eyeToWorld: Matrix4): DepthImage | null {
    if (this.gpuResult) {
      const result = this.gpuResult;
      this.gpuResult = null;
      return result;
    }
    if (this.gpuInFlight) return null;
    if (!texture || !info) return null;
    const near = info.depthNear;
    if (near === undefined || !(near > 0)) {
      this.warnGpu(new Error('GPU depth information without depthNear'));
      return null;
    }
    try {
      const renderer = this.world.renderer;
      if (!this.readMaterial) {
        this.readMaterial = new ShaderMaterial({
          name: 'DepthReadback',
          uniforms: { uDepth: { value: null }, uScale: { value: 1 }, uNear: { value: 0.1 }, uRaw: { value: false } },
          vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = vec4(position.xy, 0.0, 1.0);
            }`,
          // Each output pixel covers a 2 x 2 block of depth texels, read exactly
          // (texelFetch: a filtered lookup would average across edges). A block
          // whose depths agree gives their mean; one holding a depth edge gives
          // the near surface's mean in R and the far one's in G, and drops
          // whatever lies between. IWSDK's MinMax preprocessing splits blocks
          // the same way with ratios (15%); edges at floor level are shallower
          // than that, hence centimetres.
          fragmentShader: /* glsl */ `
            precision highp float;
            precision highp sampler2DArray;
            uniform sampler2DArray uDepth;
            uniform float uScale;
            uniform float uNear;
            uniform bool uRaw; // depth level "raw": the original lookup, filtered by the texture as it is
            varying vec2 vUv;
            float metresAt(ivec2 p, ivec2 size) {
              float raw = texelFetch(uDepth, ivec3(clamp(p, ivec2(0), size - 1), 0), 0).r;
              return raw > 0.0 && raw < 1.0 ? uScale * uNear / (1.0 - raw) : 0.0;
            }
            void main() {
              if (uRaw) {
                float raw = texture(uDepth, vec3(vUv, 0.0)).r;
                float metres = raw > 0.0 && raw < 1.0 ? uScale * uNear / (1.0 - raw) : 0.0;
                gl_FragColor = vec4(metres, metres, 1.0, 1.0);
                return;
              }
              ivec2 size = textureSize(uDepth, 0).xy;
              ivec2 base = ivec2(gl_FragCoord.xy) * 2;
              float d[4];
              d[0] = metresAt(base, size);
              d[1] = metresAt(base + ivec2(1, 0), size);
              d[2] = metresAt(base + ivec2(0, 1), size);
              d[3] = metresAt(base + ivec2(1, 1), size);
              float lo = 1e9;
              float hi = 0.0;
              float sum = 0.0;
              float n = 0.0;
              for (int i = 0; i < 4; i++) {
                if (d[i] > 0.0) {
                  lo = min(lo, d[i]);
                  hi = max(hi, d[i]);
                  sum += d[i];
                  n += 1.0;
                }
              }
              if (n == 0.0) {
                gl_FragColor = vec4(0.0);
                return;
              }
              float gap = 0.02 + 0.01 * lo; // what still counts as one surface
              if (hi - lo <= gap) {
                float mean = sum / n;
                gl_FragColor = vec4(mean, mean, n, 1.0);
                return;
              }
              float nearSum = 0.0;
              float nearN = 0.0;
              float farSum = 0.0;
              float farN = 0.0;
              for (int i = 0; i < 4; i++) {
                if (d[i] <= 0.0) continue;
                if (d[i] - lo <= gap) {
                  nearSum += d[i];
                  nearN += 1.0;
                } else if (hi - d[i] <= gap) {
                  farSum += d[i];
                  farN += 1.0;
                }
              }
              gl_FragColor = vec4(nearSum / nearN, farSum / farN, n, 0.0);
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
        this.gpuMetres = new Float32Array(width * height);
        this.gpuFar = new Float32Array(width * height);
      }
      this.readMaterial.uniforms.uDepth.value = texture;
      this.readMaterial.uniforms.uScale.value = info.rawValueToMeters;
      this.readMaterial.uniforms.uNear.value = near;
      this.readMaterial.uniforms.uRaw.value = !DEPTH_LEVEL_SPEC[this.level].filtered;
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
      const bufferFromView = GPU_BUFFER_FROM_VIEW;
      const target = this.readTarget;
      const pixels = this.readPixels!;
      const metres = this.gpuMetres!;
      const far = this.gpuFar!;
      this.gpuInFlight = true;
      this.lastWidth = width;
      this.lastHeight = height;
      void renderer
        .readRenderTargetPixelsAsync(target, 0, 0, width, height, pixels)
        .then(() => {
          for (let i = 0; i < metres.length; i++) {
            metres[i] = pixels[i * 4];
            far[i] = pixels[i * 4 + 1];
          }
          this.gpuResult = {
            width,
            height,
            metres,
            far,
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
    this.dirCols = cols;
    this.dirRows = rows;
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

  /** Bins one depth image into the map, through the filters of the depth level in use. */
  private merge(image: DepthImage): void {
    const m = this.viewToStage.multiplyMatrices(this.stageInverse, image.sensorToWorld).elements;
    const filters = DEPTH_LEVEL_SPEC[this.level].filtered ? ALL_FILTERS : NO_FILTERS;
    this.bin(image, m, this.maps, filters);
    this.commit(this.maps, filters, true);
  }

  /**
   * Switches the depth fidelity (menu: ROOM DEPTH), remembered in this
   * browser. The map starts over at the new cell size and rules: what the
   * depth sensor found is forgotten, the scan's mesh seeds it again, the
   * scan's colliders are redrawn, and the sim gets the new extent and feel.
   */
  setLevel(level: DepthLevel): void {
    if (level === this.level) return;
    const half = DEPTH_LEVEL_SPEC[level].half;
    this.level = level;
    saveDepthLevel(level);
    if (half !== terrainHalf()) setTerrainHalf(half);
    this.clearMap();
    this.seeded = false;
    this.roomVersion = -1;
    this.configSim = null;
    this.dirty = true;
  }

  /** Tuning and tests: the soft depth layer's contact (null: TERRAIN_SOFT), sent to the sim at once. */
  setSoftContact(contact: { solref: readonly number[]; solimp: readonly number[] } | null): void {
    this.softContact = contact;
    this.configSim = null;
  }

  /** Metres per cell, and from the centre to the edge, as in use (for tests and the lab panel). */
  get cell(): number {
    return terrainCell();
  }

  get half(): number {
    return terrainHalf();
  }

  /**
   * Adds one image's points to the cells' statistics (`m`: sensor view frame
   * -> stage frame). With `edgeOn`, a point goes in only if the surface it
   * lies on (its triangle with the right and lower neighbours, or with the
   * left and upper ones) faces the sensor within 75 degrees: a depth edge the
   * sensor smeared into in-between depths is a surface seen edge-on, and
   * binned it would grow a ramp around the object.
   */
  private bin(image: DepthImage, m: ArrayLike<number>, maps: DepthMaps, filters: DepthFilters): void {
    this.prepareDirs(image);
    const dirs = this.dirs!;
    const index = this.pixelIndex!;
    const near = image.metres;
    const far = image.far;
    let kept = 0;
    let dropped = 0;
    for (let k = 0; k < index.length; k++) {
      const z = near[index[k]];
      if (!(z > MIN_DEPTH && z < MAX_DEPTH)) continue;
      if (filters.edgeOn && this.edgeOn(k, z, near)) {
        dropped++;
        continue;
      }
      kept++;
      const dx = dirs[k * 2];
      const dy = dirs[k * 2 + 1];
      this.binPoint(dx * z, dy * z, -z, m, maps);
      if (far) {
        const zf = far[index[k]];
        if (zf > z + FAR_MIN && zf < MAX_DEPTH) this.binPoint(dx * zf, dy * zf, -zf, m, maps);
      }
    }
    this.kept = kept;
    this.dropped = dropped;
  }

  /**
   * Whether sampled pixel k (at depth z) lies on a surface seen nearly
   * edge-on from both of its neighbour triangles. With no triangle to judge
   * (neighbours outside the image or without depth) there is no evidence, so
   * it is not.
   */
  private edgeOn(k: number, z: number, near: Float32Array): boolean {
    const dirs = this.dirs!;
    const index = this.pixelIndex!;
    const cols = this.dirCols;
    const rows = this.dirRows;
    const i = k % cols;
    const j = (k - i) / cols;
    const ax = dirs[k * 2] * z;
    const ay = dirs[k * 2 + 1] * z;
    const az = -z;
    const reach = Math.sqrt(ax * ax + ay * ay + az * az);
    let judged = false;
    for (let s = 1; s >= -1; s -= 2) {
      if (i + s < 0 || i + s >= cols || j + s < 0 || j + s >= rows) continue;
      const kh = k + s;
      const kv = k + s * cols;
      const zh = near[index[kh]];
      const zv = near[index[kv]];
      if (!(zh > MIN_DEPTH && zh < MAX_DEPTH && zv > MIN_DEPTH && zv < MAX_DEPTH)) continue;
      const hx = dirs[kh * 2] * zh - ax;
      const hy = dirs[kh * 2 + 1] * zh - ay;
      const hz = z - zh;
      const vx = dirs[kv * 2] * zv - ax;
      const vy = dirs[kv * 2 + 1] * zv - ay;
      const vz = z - zv;
      const nx = hy * vz - hz * vy;
      const ny = hz * vx - hx * vz;
      const nz = hx * vy - hy * vx;
      const size = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (size === 0) continue;
      judged = true;
      if (Math.abs(nx * ax + ny * ay + nz * az) >= COS_EDGE_ON * size * reach) return false;
    }
    return judged;
  }

  /** One point (sensor view frame) into its cell's statistics for this update. */
  private binPoint(px: number, py: number, pz: number, m: ArrayLike<number>, maps: DepthMaps): void {
    const sy = m[1] * px + m[5] * py + m[9] * pz + m[13];
    if (sy > TERRAIN_HEIGHT_CAP) return; // walls, hands held high: not floor stuff
    const sx = m[0] * px + m[4] * py + m[8] * pz + m[12];
    const sz = m[2] * px + m[6] * py + m[10] * pz + m[14];
    const col = terrainCol(sx);
    const row = terrainRow(-sz);
    if (col < 0 || row < 0) return;
    const i = row * TERRAIN_N + col;
    const h = sy < 0 ? 0 : sy;
    const n = maps.count[i];
    if (n === 0xffff) return;
    maps.count[i] = n + 1;
    maps.sum[i] += h;
    maps.sumSq[i] += h * h;
    if (n === 0) {
      maps.top1[i] = h;
      maps.top2[i] = -1;
    } else if (h > maps.top1[i]) {
      maps.top2[i] = maps.top1[i];
      maps.top1[i] = h;
    } else if (h > maps.top2[i]) {
      maps.top2[i] = h;
    }
  }

  /**
   * Turns this update's points into heights, and clears them. With `robust`,
   * a cell whose points agree (spread under FLAT_SPREAD) takes their mean, so
   * noise no longer lifts flat surfaces, and a mixed cell (an edge, a step)
   * its second-highest point, so one stray point cannot. With `confidence`, a
   * sighting more than BAND above the stored height must repeat RISE_VOTES
   * updates in a row, and the cell rises to the lowest of them; one more than
   * BAND below brings it down quickly (an object taken away); within the band
   * it moves a little. Without them: the old rule (the highest point, halfway
   * there). `guard`: never raise the ground under the duck or the ball.
   */
  private commit(maps: DepthMaps, filters: DepthFilters, guard: boolean): void {
    const { heights, count, sum, sumSq, top1, top2, votes, pending } = maps;
    const pose = this.duck?.pose;
    const guarded = guard && !!this.duck?.hasPose && !!pose;
    const dx = guarded ? pose![0] : 0;
    const dy = guarded ? pose![1] : 0;
    const bx = guarded ? pose![BALL_OFFSET] : 0;
    const by = guarded ? pose![BALL_OFFSET + 1] : 0;
    for (let i = 0; i < CELLS; i++) {
      const n = count[i];
      if (n === 0) continue;
      count[i] = 0;
      let seen = top1[i];
      if (filters.robust) {
        const mean = sum[i] / n;
        const spread = Math.sqrt(Math.max(0, sumSq[i] / n - mean * mean));
        seen = spread <= FLAT_SPREAD || n < 3 ? mean : top2[i];
      }
      sum[i] = 0;
      sumSq[i] = 0;
      const target = seen < TERRAIN_MIN_HEIGHT ? 0 : seen;
      const current = heights[i];
      const rising = filters.confidence ? target > (current < 0 ? 0 : current) + BAND : target > current;
      if (rising && guarded) {
        const cx = terrainX(i % TERRAIN_N);
        const cy = terrainY(Math.floor(i / TERRAIN_N));
        if (Math.hypot(cx - dx, cy - dy) < DUCK_GUARD || Math.hypot(cx - bx, cy - by) < BALL_GUARD) continue;
      }
      if (!filters.confidence) {
        heights[i] = current < 0 ? target : current + LEGACY_SMOOTH * (target - current);
        continue;
      }
      if (rising) {
        pending[i] = votes[i] === 0 ? target : Math.min(pending[i], target);
        votes[i] += 1;
        if (votes[i] < RISE_VOTES) continue;
        heights[i] = pending[i];
        votes[i] = 0;
        continue;
      }
      votes[i] = 0;
      heights[i] = current < 0 ? target : current + (target < current - BAND ? SMOOTH_DOWN : SMOOTH_IN) * (target - current);
    }
  }

  /**
   * Test hook (tools/test/depth-quality-check.mjs): runs depth images, one
   * update each, through the same filters into a fresh map (the live map is
   * left alone) and returns it (metres per cell, -1 = never seen), with how
   * many points went in and how many were dropped as edge-on. Any filter can
   * be switched off to compare with the old rule.
   */
  probe(
    images: ProbeImage[],
    filters: Partial<DepthFilters> = {},
    half = terrainHalf(),
  ): { heights: Float32Array; kept: number; dropped: number; cell: number } {
    const before = terrainHalf();
    setTerrainHalf(half); // the cell size to bin at; put back below
    try {
      return this.probeAt(images, filters);
    } finally {
      setTerrainHalf(before);
    }
  }

  private probeAt(images: ProbeImage[], filters: Partial<DepthFilters>): { heights: Float32Array; kept: number; dropped: number; cell: number } {
    const maps = makeMaps(new Float32Array(CELLS).fill(-1));
    const use: DepthFilters = { ...ALL_FILTERS, ...filters };
    let kept = 0;
    let dropped = 0;
    for (const probe of images) {
      const image: DepthImage = {
        width: probe.width,
        height: probe.height,
        metres: probe.metres,
        far: probe.far ?? null,
        bufferFromView: IDENTITY_BUFFER_FROM_VIEW,
        projection: Float32Array.from(probe.projection),
        sensorToWorld: this.viewToStage, // not read: the pose comes as sensorToStage
      };
      this.bin(image, probe.sensorToStage, maps, use);
      kept += this.kept;
      dropped += this.dropped;
      this.commit(maps, use, false);
    }
    return { heights: maps.heights, kept, dropped, cell: terrainCell() };
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
      // Walk the collider's own x/y/z grid (half a cell apart) and drop every sample onto the floor map.
      const splat = terrainCell() / 2;
      const nx = Math.max(1, Math.ceil((2 * hx) / splat));
      const ny = Math.max(1, Math.ceil((2 * hy) / splat));
      const nz = Math.max(1, Math.ceil((2 * hz) / splat));
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

  /**
   * The room scan's global mesh gives the map a start before the sensor has
   * looked around: its triangles fill the cells under them (mesh-heights.ts).
   */
  private seedFromScan(): void {
    this.seeded = true;
    this.scanVersion = this.room?.scanVersion ?? -1;
    const mesh = this.room?.globalMesh();
    const position = mesh?.geometry.getAttribute('position');
    if (!mesh || !position) return;
    mesh.updateWorldMatrix(true, false);
    const m = this.viewToStage.multiplyMatrices(this.stageInverse, mesh.matrixWorld);
    // Plain x y z triples (copied when the attribute is interleaved or padded).
    let positions: ArrayLike<number> = position.array;
    const interleaved = (position as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute === true;
    if (interleaved || position.itemSize !== 3 || position.array.length !== position.count * 3) {
      const flat = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i++) {
        flat[i * 3] = position.getX(i);
        flat[i * 3 + 1] = position.getY(i);
        flat[i * 3 + 2] = position.getZ(i);
      }
      positions = flat;
    }
    const index = mesh.geometry.getIndex();
    const cells = rasteriseMeshHeights(positions, index ? index.array : null, m.elements, this.heights);
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

  /**
   * Translucent blocks over the raised cells, coloured by height (mint low,
   * sky blue high). Neighbouring cells in a row that stand about as high share
   * one block, so a whole room fits in MAX_BLOCKS.
   */
  private layoutBlocks(): void {
    const blocks = this.blocks;
    if (!blocks) return;
    const heights = this.heights;
    const scan = this.scanHeights;
    let n = 0;
    for (let row = 0; row < TERRAIN_N && n < MAX_BLOCKS; row++) {
      const base = row * TERRAIN_N;
      let col = 0;
      while (col < TERRAIN_N && n < MAX_BLOCKS) {
        const h = Math.max(heights[base + col], scan[base + col]);
        if (h < TERRAIN_MIN_HEIGHT) {
          col++;
          continue;
        }
        let end = col + 1;
        let top = h;
        while (end < TERRAIN_N) {
          const next = Math.max(heights[base + end], scan[base + end]);
          if (next < TERRAIN_MIN_HEIGHT || Math.abs(next - h) > BLOCK_RUN_TOLERANCE) break;
          if (next > top) top = next;
          end++;
        }
        this.blockMatrix.makeScale(terrainCell() * (end - col - 0.1), top, terrainCell() * 0.9);
        this.blockMatrix.setPosition((terrainX(col) + terrainX(end - 1)) / 2, top / 2, -terrainY(row));
        blocks.setMatrixAt(n, this.blockMatrix);
        // Mint for low steps, sky blue for walls: the HUD's palette, not a warning red.
        const t = Math.min(1, top / TERRAIN_HEIGHT_CAP);
        blocks.setColorAt(n, this.blockColor.setHSL(0.46 + 0.12 * t, 0.75, 0.62 - 0.12 * t));
        n++;
        col = end;
      }
    }
    blocks.count = n;
    blocks.instanceMatrix.needsUpdate = true;
    if (blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  }
}
