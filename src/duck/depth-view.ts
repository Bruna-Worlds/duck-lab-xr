// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The robot panel's DEPTH view: the head distance sensor's 8 x 8 zones
 * (tof.ts) drawn as a grid of squares into the feed, row 0 at the top and
 * column 0 the sensor's left, as the duck would see them: pink up close,
 * yellow, mint, blue further out, dark where nothing is in range. While the
 * camera brain drives, its camera picture (at its own 64 x 36 pixels) sits on
 * the left and the grid on the right: everything the brain sees.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from '@iwsdk/core';
import { TOF_RANGE, TOF_ZONES } from './tof.js';

/** Distance (m) to colour stops. */
const STOPS: [number, string][] = [
  [0.15, '#ff5c8a'],
  [0.5, '#ffcf3f'],
  [1.2, '#3de0b8'],
  [2.5, '#6fb7ff'],
  [TOF_RANGE - 0.01, '#2c3a7a'],
];
const NOTHING = '#1c1d36';
const BACKGROUND = '#0f1020';
const GAP = 2; // feed pixels between squares
const ZONES = TOF_ZONES * TOF_ZONES;

export class DepthView {
  private readonly scene = new Scene();
  private readonly camera: OrthographicCamera;
  private readonly positions: BufferAttribute;
  private readonly colors: BufferAttribute;
  private readonly stops = STOPS.map(([d, hex]) => [d, new Color(hex)] as const);
  private readonly nothing = new Color(NOTHING);
  private readonly background = new Color(BACKGROUND);
  private readonly color = new Color();
  /** Square positions: the grid alone, centred, or beside the camera picture. */
  private readonly alone: Float32Array;
  private readonly beside: Float32Array;
  private readonly picture: Mesh;
  private pictureShown = false;

  constructor(width: number, height: number) {
    this.camera = new OrthographicCamera(0, width, height, 0, -1, 1);
    const vertices = (ZONES + 1) * 6;
    this.positions = new BufferAttribute(new Float32Array(vertices * 3), 3);
    this.colors = new BufferAttribute(new Float32Array(vertices * 3), 3);
    this.colors.setUsage(DynamicDrawUsage);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('color', this.colors);
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false }));
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    // A full-feed backdrop, then the grid: a square as tall as the feed, centred.
    const p = this.positions.array as Float32Array;
    const v = quad(p, 0, 0, 0, width, height);
    const side = height - 8;
    const x0 = (width - side) / 2;
    const y0 = (height - side) / 2;
    gridQuads(p, v, x0, y0, side);
    this.alone = p.slice();
    // Beside the picture: the picture 16:9 on the left, the grid in what is left on the right.
    const pictureW = Math.round(width * 0.68);
    const pictureH = Math.round((pictureW * 9) / 16);
    const small = Math.min(width - pictureW - 12, height - 8);
    this.beside = p.slice();
    gridQuads(this.beside, 6, width - small - 4, (height - small) / 2, small);
    this.picture = new Mesh(new PlaneGeometry(pictureW, pictureH), new MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false }));
    this.picture.position.set(4 + pictureW / 2, height / 2, 0);
    this.picture.renderOrder = 1;
    this.picture.visible = false;
    this.picture.frustumCulled = false;
    this.scene.add(this.picture);
    this.paint(0, this.background);
  }

  /** Shows the camera brain's picture beside the grid (null: the grid alone). */
  setCamera(texture: Texture | null): void {
    const shown = texture !== null;
    const material = this.picture.material as MeshBasicMaterial;
    if (material.map !== texture) {
      material.map = texture;
      material.needsUpdate = true;
    }
    if (shown === this.pictureShown) return;
    this.pictureShown = shown;
    this.picture.visible = shown;
    (this.positions.array as Float32Array).set(shown ? this.beside : this.alone);
    this.positions.needsUpdate = true;
  }

  /** The squares' colours for a frame (metres; TOF_RANGE where nothing is in range). */
  update(zones: Float32Array): void {
    for (let z = 0; z < ZONES; z++) this.paint(z + 1, this.colourOf(zones[z]));
    this.colors.needsUpdate = true;
  }

  /** Draws the view into the feed (over whatever it held). */
  draw(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
  }

  private colourOf(metres: number): Color {
    if (!(metres < TOF_RANGE - 0.01)) return this.nothing;
    const stops = this.stops;
    if (metres <= stops[0][0]) return this.color.copy(stops[0][1]);
    for (let i = 1; i < stops.length; i++) {
      const [d1, c1] = stops[i];
      if (metres <= d1) {
        const [d0, c0] = stops[i - 1];
        return this.color.copy(c0).lerp(c1, (metres - d0) / (d1 - d0));
      }
    }
    return this.color.copy(stops[stops.length - 1][1]);
  }

  /** Sets one square's colour (index 0 is the backdrop). */
  private paint(square: number, color: Color): void {
    const c = this.colors.array as Float32Array;
    for (let k = 0; k < 6; k++) {
      const i = (square * 6 + k) * 3;
      c[i] = color.r;
      c[i + 1] = color.g;
      c[i + 2] = color.b;
    }
  }
}

/** The 8 x 8 squares filling a square of the given side from (x0, y0), row 0 at the top, from vertex v. */
function gridQuads(p: Float32Array, v: number, x0: number, y0: number, side: number): void {
  const cell = side / TOF_ZONES;
  for (let row = 0; row < TOF_ZONES; row++) {
    for (let col = 0; col < TOF_ZONES; col++) {
      const x = x0 + col * cell;
      const y = y0 + (TOF_ZONES - 1 - row) * cell; // row 0 at the top
      v = quad(p, v, x + GAP / 2, y + GAP / 2, x + cell - GAP / 2, y + cell - GAP / 2);
    }
  }
}

/** Two triangles from (x0, y0) to (x1, y1); returns the next vertex index. */
function quad(p: Float32Array, v: number, x0: number, y0: number, x1: number, y1: number): number {
  const corners = [x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1];
  for (let k = 0; k < 6; k++) {
    p[(v + k) * 3] = corners[k * 2];
    p[(v + k) * 3 + 1] = corners[k * 2 + 1];
    p[(v + k) * 3 + 2] = 0;
  }
  return v + 6;
}
