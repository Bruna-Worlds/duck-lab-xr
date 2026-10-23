// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The duck cam's vision view: the objects the duck can see, as labelled boxes
 * over its camera frame. The labels come from the simulation, so they are
 * exact. An object-ID pass draws every labelled object in its own flat colour
 * into a small target (everything else in black, so walls and furniture still
 * hide what is behind them); an async readback turns each object's visible
 * pixels into a 2D box; an overlay pass draws the boxes and name tags into
 * the feed. Each frame doubles as a labelled training image for a detector.
 *
 * Owned by DuckCamSystem, which calls collect() when the level or the room
 * scan changes and renderIds() + drawOverlay() after each feed frame.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  LinearSRGBColorSpace,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OrthographicCamera,
  type PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  type WebGLRenderer,
  WebGLRenderTarget,
} from '@iwsdk/core';

const ID_W = 128; // the ID pass runs at half the feed's size
const ID_H = 96;
const MAX_OBJECTS = 120; // labelled objects tracked (ids 1..120 in the red channel)
const MAX_BOXES = 16; // drawn per frame, biggest first
const MIN_PIXELS = 6; // smaller than this at 128x96 is noise
const THICK = 2; // box line width, feed pixels
const TAG_H = 12; // name tag height, feed pixels
const ROW_H = 16; // atlas row
const ATLAS_W = 128;

interface VisionClass {
  name: string;
  color: string;
}

/** What the duck can name, with the box colour: course pieces bright, room things cream. */
const CLASSES: VisionClass[] = [
  { name: 'ball', color: '#ff5c8a' },
  { name: 'books', color: '#ffcf3f' },
  { name: 'gate', color: '#6fb7ff' },
  { name: 'goal', color: '#3de0b8' },
  { name: 'crumb', color: '#ffd166' },
  { name: 'start', color: '#cdb4db' },
  { name: 'finish', color: '#cdb4db' },
  { name: 'shoe', color: '#ff7a45' },
  { name: 'cereal box', color: '#ff7a45' },
  { name: 'mug', color: '#ff7a45' },
  { name: 'toy', color: '#ff7a45' },
  { name: 'rubber duck', color: '#ffcf3f' },
  { name: 'bench', color: '#fff4dc' },
  { name: 'plant', color: '#7bd88f' },
  { name: 'rock', color: '#fff4dc' },
  { name: 'bucket', color: '#fff4dc' },
  { name: 'couch', color: '#fff4dc' },
  { name: 'table', color: '#fff4dc' },
  { name: 'chair', color: '#fff4dc' },
  { name: 'shelf', color: '#fff4dc' },
  { name: 'lamp', color: '#fff4dc' },
  { name: 'bed', color: '#fff4dc' },
  { name: 'screen', color: '#fff4dc' },
  { name: 'storage', color: '#fff4dc' },
  { name: 'object', color: '#fff4dc' },
];
const CLASS_INDEX = new Map(CLASSES.map((c, i) => [c.name, i]));

/** Scene object names (scene node ids, asset parts) to classes. */
const RULES: [RegExp, string][] = [
  [/^book-stack/, 'books'],
  [/^gate-/, 'gate'],
  [/^ball-/, 'ball'],
  [/^goal-/, 'goal'],
  [/^crumb-/, 'crumb'],
  [/^start-pad/, 'start'],
  [/^finish-pad/, 'finish'],
  [/^(boat-shoe|timberland-shoe|ugg-boot)/, 'shoe'],
  [/^cereal-box/, 'cereal box'],
  [/^mug/, 'mug'],
  [/^(spinosaurus|triceratops|blocks-wagon)/, 'toy'],
  [/^rubber-duck/, 'rubber duck'],
  [/^bench/, 'bench'],
  [/^(planter|plant|shrub)/, 'plant'],
  [/^(stone|rock)/, 'rock'],
  [/^bucket/, 'bucket'],
];
/** The room scan's furniture twins are named occluder:<semantic label>. */
const SCAN_PREFIX = 'occluder:';
const SCAN_CLASSES: Record<string, string> = {
  couch: 'couch',
  sofa: 'couch',
  table: 'table',
  desk: 'table',
  chair: 'chair',
  shelf: 'shelf',
  lamp: 'lamp',
  bed: 'bed',
  screen: 'screen',
  storage: 'storage',
  plant: 'plant',
};

function classOf(name: string): number {
  if (!name) return -1;
  if (name.startsWith(SCAN_PREFIX)) {
    return CLASS_INDEX.get(SCAN_CLASSES[name.slice(SCAN_PREFIX.length)] ?? 'object') ?? -1;
  }
  for (const [pattern, cls] of RULES) {
    if (pattern.test(name)) return CLASS_INDEX.get(cls) ?? -1;
  }
  return -1;
}

/** One labelled box, in feed pixels from the top-left corner. */
export interface VisionBox {
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixels: number;
}

export class DuckVision {
  /** The latest boxes (the first `count` are valid), biggest first. */
  readonly boxes: VisionBox[] = [];
  count = 0;
  /** "3 objects: gate, books, ball" for the robot panel. */
  summary = 'Looking...';
  /** Labelled objects found by the last collect(). */
  objectCount = 0;
  private readonly objects: Object3D[] = [];
  private readonly objectClass = new Int16Array(MAX_OBJECTS + 1);
  private readonly idTarget: WebGLRenderTarget;
  private readonly idMaterials: MeshBasicMaterial[] = [];
  private readonly black: MeshBasicMaterial;
  private readonly pixels = new Uint8Array(ID_W * ID_H * 4);
  private reading = false;
  private generation = 0;
  private readGeneration = 0;
  private readonly clearColor = new Color();
  private readonly minX = new Int16Array(MAX_OBJECTS + 1);
  private readonly minY = new Int16Array(MAX_OBJECTS + 1);
  private readonly maxX = new Int16Array(MAX_OBJECTS + 1);
  private readonly maxY = new Int16Array(MAX_OBJECTS + 1);
  private readonly counts = new Int32Array(MAX_OBJECTS + 1);
  private readonly order = new Int16Array(MAX_OBJECTS);
  /** GL-space boxes (y up) and classes for the overlay, parallel to `boxes`. */
  private readonly glBoxes = new Float32Array(MAX_BOXES * 4);
  private readonly boxClass = new Int16Array(MAX_BOXES);
  /** Tags placed this frame (x0, y0, x1, y1), to keep the next ones off them. */
  private readonly placed = new Float32Array(MAX_BOXES * 4);
  private readonly swapMeshes: Mesh[] = [];
  private readonly swapMaterials: (Material | Material[])[] = [];
  private readonly hiddenOthers: Object3D[] = [];
  private readonly stack: Object3D[] = [];
  private readonly overlay = new Scene();
  private readonly overlayCam: OrthographicCamera;
  private readonly boxGeometry = new BufferGeometry();
  private readonly boxPositions: BufferAttribute;
  private readonly boxColors: BufferAttribute;
  private readonly tagGeometry = new BufferGeometry();
  private readonly tagPositions: BufferAttribute;
  private readonly tagUvs: BufferAttribute;
  private readonly boxMaterial: MeshBasicMaterial;
  private readonly tagMaterial: MeshBasicMaterial;
  private readonly atlas: CanvasTexture;
  private readonly atlasH: number;
  private readonly classWidth: number[] = [];
  private readonly classColor: Color[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.idTarget = new WebGLRenderTarget(ID_W, ID_H, { depthBuffer: true, samples: 0 });
    this.idTarget.texture.name = 'duck-vision-ids';
    for (let id = 1; id <= MAX_OBJECTS; id++) {
      const material = new MeshBasicMaterial({ toneMapped: false, fog: false });
      material.color.setRGB(id / 255, 0, 0, LinearSRGBColorSpace);
      this.idMaterials.push(material);
    }
    this.black = new MeshBasicMaterial({ color: 0x000000, toneMapped: false, fog: false });
    for (let i = 0; i < MAX_BOXES; i++) this.boxes.push({ label: '', x0: 0, y0: 0, x1: 0, y1: 0, pixels: 0 });

    this.overlayCam = new OrthographicCamera(0, width, height, 0, -1, 1);
    this.boxPositions = new BufferAttribute(new Float32Array(MAX_BOXES * 24 * 3), 3).setUsage(DynamicDrawUsage);
    this.boxColors = new BufferAttribute(new Float32Array(MAX_BOXES * 24 * 3), 3).setUsage(DynamicDrawUsage);
    this.boxGeometry.setAttribute('position', this.boxPositions);
    this.boxGeometry.setAttribute('color', this.boxColors);
    this.boxGeometry.setDrawRange(0, 0);
    this.tagPositions = new BufferAttribute(new Float32Array(MAX_BOXES * 6 * 3), 3).setUsage(DynamicDrawUsage);
    this.tagUvs = new BufferAttribute(new Float32Array(MAX_BOXES * 6 * 2), 2).setUsage(DynamicDrawUsage);
    this.tagGeometry.setAttribute('position', this.tagPositions);
    this.tagGeometry.setAttribute('uv', this.tagUvs);
    this.tagGeometry.setDrawRange(0, 0);

    // Name tags: one row per class, the class colour behind dark text.
    this.atlasH = CLASSES.length * ROW_H;
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_W;
    canvas.height = this.atlasH;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = 'bold 9px "Segoe UI", Arial, sans-serif';
      ctx.textBaseline = 'middle';
      CLASSES.forEach((cls, i) => {
        const text = cls.name.toUpperCase();
        const w = Math.min(ATLAS_W, Math.ceil(ctx.measureText(text).width) + 8);
        const y = i * ROW_H;
        ctx.fillStyle = cls.color;
        ctx.beginPath();
        ctx.roundRect(0, y, w, TAG_H, 3);
        ctx.fill();
        ctx.fillStyle = '#0f1020';
        ctx.fillText(text, 4, y + TAG_H / 2 + 0.5);
        this.classWidth.push(w);
      });
    }
    this.atlas = new CanvasTexture(canvas);
    this.atlas.colorSpace = SRGBColorSpace;
    this.atlas.generateMipmaps = false;
    for (const cls of CLASSES) this.classColor.push(new Color(cls.color));

    this.boxMaterial = new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.tagMaterial = new MeshBasicMaterial({ map: this.atlas, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const boxes = new Mesh(this.boxGeometry, this.boxMaterial);
    const tags = new Mesh(this.tagGeometry, this.tagMaterial);
    boxes.frustumCulled = false;
    tags.frustumCulled = false;
    tags.renderOrder = 1;
    this.overlay.add(boxes, tags);
  }

  /** Finds the objects worth labelling under `root` (not inside `skip`, the duck itself). */
  collect(root: Object3D, skip: Object3D | null): void {
    for (const object of this.objects) object.traverse(clearTag);
    this.objects.length = 0;
    const stack = this.stack;
    stack.length = 0;
    stack.push(root);
    while (stack.length > 0) {
      const object = stack.pop() as Object3D;
      if (object === skip) continue;
      const cls = classOf(object.name);
      if (cls >= 0 && this.objects.length < MAX_OBJECTS) {
        this.objects.push(object);
        const id = this.objects.length;
        this.objectClass[id] = cls;
        object.traverse((child) => {
          child.userData.visionId = id;
        });
        continue;
      }
      for (const child of object.children) stack.push(child);
    }
    this.objectCount = this.objects.length;
  }

  /**
   * Draws the object IDs as `camera` sees `scene` (call right after the feed
   * frame, with the same things hidden) and starts reading them back. Skipped
   * while the previous read is still on its way.
   */
  renderIds(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera): void {
    if (this.reading) return;
    this.swapMeshes.length = 0;
    this.swapMaterials.length = 0;
    this.hiddenOthers.length = 0;
    scene.traverseVisible(this.swap);
    // Background pixels must read as id 0: no sky picture, a black clear.
    const background = scene.background;
    scene.background = null;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.idTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    renderer.setClearColor(this.clearColor, clearAlpha);
    scene.background = background;
    for (let i = 0; i < this.swapMeshes.length; i++) this.swapMeshes[i].material = this.swapMaterials[i];
    for (const other of this.hiddenOthers) other.visible = true;
    this.reading = true;
    this.readGeneration = this.generation;
    renderer
      .readRenderTargetPixelsAsync(this.idTarget, 0, 0, ID_W, ID_H, this.pixels)
      .then(this.decode, this.readFailed);
  }

  /** Draws the latest boxes and name tags over the feed frame in `target`. */
  drawOverlay(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
    const positions = this.boxPositions.array as Float32Array;
    const colors = this.boxColors.array as Float32Array;
    const tagPositions = this.tagPositions.array as Float32Array;
    const uvs = this.tagUvs.array as Float32Array;
    let v = 0;
    let t = 0;
    let placed = 0;
    for (let i = 0; i < this.count; i++) {
      const x0 = this.glBoxes[i * 4];
      const y0 = this.glBoxes[i * 4 + 1];
      const x1 = this.glBoxes[i * 4 + 2];
      const y1 = this.glBoxes[i * 4 + 3];
      const cls = this.boxClass[i];
      const color = this.classColor[cls];
      v = quad(positions, colors, v, x0, y0, x1, y0 + THICK, color);
      v = quad(positions, colors, v, x0, y1 - THICK, x1, y1, color);
      v = quad(positions, colors, v, x0, y0, x0 + THICK, y1, color);
      v = quad(positions, colors, v, x1 - THICK, y0, x1, y1, color);
      // The tag goes on the box's top edge, else inside its top, under it or
      // inside its bottom: the first spot in the frame that no bigger box's
      // tag took. Crowded far-away boxes keep their outline without a tag.
      const w = this.classWidth[cls] ?? 40;
      const tx = Math.min(Math.max(0, x0), this.width - w);
      let ty = -1;
      for (let k = 0; k < 4 && ty < 0; k++) {
        const y = k === 0 ? y1 : k === 1 ? y1 - TAG_H : k === 2 ? y0 - TAG_H : y0;
        if (y < 0 || y + TAG_H > this.height) continue;
        if (!this.tagOverlaps(tx, y, w, placed)) ty = y;
      }
      if (ty < 0) continue;
      this.placed[placed * 4] = tx;
      this.placed[placed * 4 + 1] = ty;
      this.placed[placed * 4 + 2] = tx + w;
      this.placed[placed * 4 + 3] = ty + TAG_H;
      placed++;
      const v0 = 1 - (cls * ROW_H + TAG_H) / this.atlasH;
      const v1 = 1 - (cls * ROW_H) / this.atlasH;
      t = tag(tagPositions, uvs, t, tx, ty, tx + w, ty + TAG_H, 0, v0, w / ATLAS_W, v1);
    }
    this.boxGeometry.setDrawRange(0, v);
    this.tagGeometry.setDrawRange(0, t);
    this.boxPositions.needsUpdate = true;
    this.boxColors.needsUpdate = true;
    this.tagPositions.needsUpdate = true;
    this.tagUvs.needsUpdate = true;
    if (this.count === 0) return;
    const autoClear = renderer.autoClear;
    const previous = renderer.getRenderTarget();
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(this.overlay, this.overlayCam);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
  }

  /** Whether a tag at (x, y) of width w would cover one of the first `placed` tags (2 px apart). */
  private tagOverlaps(x: number, y: number, w: number, placed: number): boolean {
    for (let i = 0; i < placed; i++) {
      const p = i * 4;
      if (x < this.placed[p + 2] + 2 && x + w > this.placed[p] - 2 && y < this.placed[p + 3] + 1 && y + TAG_H > this.placed[p + 1] - 1) {
        return true;
      }
    }
    return false;
  }

  /** Forgets the boxes (the view was switched off); a read still on its way is dropped. */
  clear(): void {
    this.generation++;
    this.count = 0;
    this.summary = 'Looking...';
  }

  dispose(): void {
    this.idTarget.dispose();
    for (const material of this.idMaterials) material.dispose();
    this.black.dispose();
    this.boxGeometry.dispose();
    this.tagGeometry.dispose();
    this.boxMaterial.dispose();
    this.tagMaterial.dispose();
    this.atlas.dispose();
  }

  private swap = (object: Object3D): void => {
    const mesh = object as Mesh;
    if (mesh.isMesh) {
      // A mesh the feed does not draw (invisible material, like the room scan's
      // raycast mesh) must not block the view here either.
      // Unlabelled see-through things (a shadow catcher, glows, confetti) do
      // not hide what is behind them either.
      // Nor do unlabelled meshes whose own shader places them (a plain ID
      // material would draw them wrongly: a controller model in centimetres
      // filled the whole view).
      const id = mesh.userData.visionId as number | undefined;
      if (!drawn(mesh.material) || (!id && (seeThrough(mesh.material) || customShader(mesh.material)))) {
        mesh.visible = false;
        this.hiddenOthers.push(mesh);
        return;
      }
      this.swapMeshes.push(mesh);
      this.swapMaterials.push(mesh.material);
      mesh.material = id ? this.idMaterials[id - 1] : this.black;
      return;
    }
    const other = object as Object3D & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
    if (other.isLine || other.isPoints || other.isSprite) {
      other.visible = false; // their own colours would read as object ids
      this.hiddenOthers.push(other);
    }
  };

  private readFailed = (): void => {
    this.reading = false;
  };

  private decode = (): void => {
    this.reading = false;
    if (this.readGeneration !== this.generation) return; // cleared meanwhile
    const n = this.objects.length;
    const { minX, minY, maxX, maxY, counts, pixels } = this;
    minX.fill(ID_W, 0, n + 1);
    minY.fill(ID_H, 0, n + 1);
    maxX.fill(-1, 0, n + 1);
    maxY.fill(-1, 0, n + 1);
    counts.fill(0, 0, n + 1);
    for (let y = 0; y < ID_H; y++) {
      for (let x = 0; x < ID_W; x++) {
        const p = (y * ID_W + x) * 4;
        const id = pixels[p];
        if (id === 0 || id > n || pixels[p + 1] !== 0) continue;
        counts[id]++;
        if (x < minX[id]) minX[id] = x;
        if (x > maxX[id]) maxX[id] = x;
        if (y < minY[id]) minY[id] = y;
        if (y > maxY[id]) maxY[id] = y;
      }
    }
    // The biggest boxes first (insertion sort on at most MAX_OBJECTS ids).
    let found = 0;
    for (let id = 1; id <= n; id++) {
      if (counts[id] < MIN_PIXELS) continue;
      let j = found++;
      while (j > 0 && counts[this.order[j - 1]] < counts[id]) {
        this.order[j] = this.order[j - 1];
        j--;
      }
      this.order[j] = id;
    }
    const sx = this.width / ID_W;
    const sy = this.height / ID_H;
    this.count = Math.min(found, MAX_BOXES);
    for (let i = 0; i < this.count; i++) {
      const id = this.order[i];
      const cls = this.objectClass[id];
      const gx0 = minX[id] * sx;
      const gy0 = minY[id] * sy;
      const gx1 = (maxX[id] + 1) * sx;
      const gy1 = (maxY[id] + 1) * sy;
      this.glBoxes[i * 4] = gx0;
      this.glBoxes[i * 4 + 1] = gy0;
      this.glBoxes[i * 4 + 2] = gx1;
      this.glBoxes[i * 4 + 3] = gy1;
      this.boxClass[i] = cls;
      const box = this.boxes[i];
      box.label = CLASSES[cls].name;
      box.x0 = gx0;
      box.x1 = gx1;
      box.y0 = this.height - gy1; // top-left origin for readers
      box.y1 = this.height - gy0;
      box.pixels = counts[id];
    }
    this.summary = summarize(this.boxes, this.count);
  };
}

/** Whether three.js draws anything with this material (or any of these). */
function drawn(material: Material | Material[]): boolean {
  if (Array.isArray(material)) {
    for (const m of material) if (m.visible) return true;
    return false;
  }
  return material.visible;
}

/** Transparent (or shadow-only) materials: they let the view through. */
function seeThrough(material: Material | Material[]): boolean {
  if (Array.isArray(material)) {
    for (const m of material) if (!m.transparent && !(m as Material & { isShadowMaterial?: boolean }).isShadowMaterial) return false;
    return true;
  }
  return material.transparent || !!(material as Material & { isShadowMaterial?: boolean }).isShadowMaterial;
}

const DEFAULT_ON_BEFORE_COMPILE = MeshBasicMaterial.prototype.onBeforeCompile;

/** Shader materials, or built-in ones patched with onBeforeCompile. */
function customShader(material: Material | Material[]): boolean {
  const custom = (m: Material) =>
    !!(m as Material & { isShaderMaterial?: boolean }).isShaderMaterial || m.onBeforeCompile !== DEFAULT_ON_BEFORE_COMPILE;
  if (Array.isArray(material)) {
    for (const m of material) if (custom(m)) return true;
    return false;
  }
  return custom(material);
}

function clearTag(object: Object3D): void {
  delete object.userData.visionId;
}

/** Corner order of a quad's two triangles: 0 = (x0, y0), 1 = (x1, y0), 2 = (x1, y1), 3 = (x0, y1). */
const CORNERS = [0, 1, 2, 0, 2, 3];

/** Two triangles of one colour, GL pixel space; returns the next vertex index. */
function quad(p: Float32Array, c: Float32Array, v: number, x0: number, y0: number, x1: number, y1: number, color: Color): number {
  for (let k = 0; k < 6; k++) {
    const corner = CORNERS[k];
    const i = (v + k) * 3;
    p[i] = corner === 0 || corner === 3 ? x0 : x1;
    p[i + 1] = corner < 2 ? y0 : y1;
    p[i + 2] = 0;
    c[i] = color.r;
    c[i + 1] = color.g;
    c[i + 2] = color.b;
  }
  return v + 6;
}

/** A textured quad (u0..u1, v0..v1) for a name tag; returns the next vertex index. */
function tag(
  p: Float32Array,
  uv: Float32Array,
  v: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): number {
  for (let k = 0; k < 6; k++) {
    const corner = CORNERS[k];
    const left = corner === 0 || corner === 3;
    const bottom = corner < 2;
    const i = (v + k) * 3;
    p[i] = left ? x0 : x1;
    p[i + 1] = bottom ? y0 : y1;
    p[i + 2] = 0;
    uv[(v + k) * 2] = left ? u0 : u1;
    uv[(v + k) * 2 + 1] = bottom ? v0 : v1;
  }
  return v + 6;
}

function summarize(boxes: VisionBox[], count: number): string {
  if (count === 0) return 'Nothing labelled in view';
  const names: string[] = [];
  for (let i = 0; i < count && names.length < 3; i++) {
    if (!names.includes(boxes[i].label)) names.push(boxes[i].label);
  }
  return `${count} object${count === 1 ? '' : 's'}: ${names.join(', ')}`;
}
