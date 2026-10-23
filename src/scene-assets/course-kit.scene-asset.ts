// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck course kit (v2): toy-scale pieces for Duck Lab XR, sized for a 25 cm
 * robot duck. Every piece sits on y = 0 with +x along the course (the ball's
 * origin is its centre). Solid pieces carry physics colliders in
 * userData.colliders (src/course/collider-spec.ts); the duck system turns
 * them into MuJoCo geoms, so what you see is what the duck bumps into.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  Color,
  Curve,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from '@iwsdk/core';
import { alignSpan, bevelBox } from './lib/hardsurface.js';
import {
  at,
  type ColoredPart,
  mergeColored,
  proceduralTexture,
  toyMaterial,
  withColliders,
} from './lib/kit.js';

const WHITE = 0xf7f4ee;
const INK = 0x1f2329;
const GOLD = 0xd4a73a;
const colored = toyMaterial(0xffffff, 0.5, 0, { vertexColors: true });
const gold = new MeshStandardMaterial({ color: GOLD, roughness: 0.32, metalness: 0.75 });
const bulb = new MeshStandardMaterial({ color: 0xfff1c1, emissive: 0xffd27a, emissiveIntensity: 1.8, roughness: 0.3 });

function mesh(name: string, geometry: Mesh['geometry'], material: Mesh['material']): Mesh {
  const m = new Mesh(geometry, material);
  m.name = name;
  return m;
}

/** A Y-up primitive's matrix spanning a -> b (for merged tubes). */
function spanMatrix(a: Vector3, b: Vector3): Matrix4 {
  const probe = new Object3D();
  alignSpan(probe, a, b);
  probe.updateMatrix();
  return probe.matrix.clone();
}

/** A function curve for tubes (arches, bands). */
class FnCurve extends Curve<Vector3> {
  constructor(private readonly fn: (t: number, out: Vector3) => Vector3) {
    super();
  }
  override getPoint(t: number, target = new Vector3()): Vector3 {
    return this.fn(t, target);
  }
}

/** Striped vertical post from y0 to y1 (merged, vertex coloured). */
function stripedPost(radius: number, y0: number, y1: number, stripes: number, a: number, b: number): ColoredPart[] {
  const h = (y1 - y0) / stripes;
  const parts: ColoredPart[] = [];
  for (let i = 0; i < stripes; i++) {
    parts.push({ geometry: new CylinderGeometry(radius, radius, h, 16), matrix: at(0, y0 + h * (i + 0.5), 0), color: i % 2 === 0 ? a : b });
  }
  return parts;
}

// ---- Book stack -------------------------------------------------------------

/** Cream page edges with fine page lines (lines run along the pages). */
const pageEdges = proceduralTexture(64, 64, (_x, y, out) => {
  const line = y % 4 === 0 ? 0.82 : y % 4 === 1 ? 0.92 : 1;
  out[0] = 243 * line;
  out[1] = 234 * line;
  out[2] = 214 * line;
}, { repeat: [1, 3] });
const pagesMaterial = new MeshStandardMaterial({ map: pageEdges, roughness: 0.95 });

function book(name: string, w: number, d: number, cover: number, yaw: number, y: number, ribbon = false): Group {
  const t = 0.03;
  const board = 0.0035;
  const r = t / 2;
  const group = new Group();
  group.name = name;
  // Rounded spine along z on the -x side, boards top and bottom.
  const spine = new CylinderGeometry(r, r, d, 14, 1, true, Math.PI, Math.PI);
  const spineM = new Matrix4().makeTranslation(-w / 2 + r, r, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2));
  group.add(mesh('Cover', mergeColored([
    { geometry: bevelBox(w - r, board, d, 0.0012), matrix: at(r / 2, board / 2, 0), color: cover },
    { geometry: bevelBox(w - r, board, d, 0.0012), matrix: at(r / 2, t - board / 2, 0), color: cover },
    { geometry: spine, matrix: spineM, color: cover },
  ]), colored));
  // Two gold bands on the spine.
  group.add(mesh('Bands', mergeColored([-0.32, 0.32].map((f) => ({
    geometry: new CylinderGeometry(r + 0.0006, r + 0.0006, 0.006, 14, 1, true, Math.PI, Math.PI),
    matrix: new Matrix4().makeTranslation(-w / 2 + r, r, d * f).multiply(new Matrix4().makeRotationX(Math.PI / 2)),
    color: GOLD,
  }))), gold));
  const pages = mesh('Pages', new BoxGeometry(w - r - 0.004, t - 2 * board, d - 0.006), pagesMaterial);
  pages.position.set(r / 2 - 0.001, t / 2, 0);
  group.add(pages);
  if (ribbon) {
    const strip = mesh('Ribbon', new BoxGeometry(0.008, 0.0008, 0.045), toyMaterial(0xc1121f, 0.6));
    strip.position.set(w * 0.15, t + 0.0004, d / 2 + 0.012);
    group.add(strip);
  }
  group.position.y = y;
  group.rotation.y = yaw;
  return group;
}

function buildBookStack(): Group {
  const root = new Group();
  root.name = 'BookStack';
  root.add(book('Book1', 0.21, 0.145, 0xb5332e, 0, 0));
  root.add(book('Book2', 0.195, 0.135, 0x22766d, 0.1, 0.03));
  root.add(book('Book3', 0.18, 0.13, 0xe0a72f, -0.07, 0.06, true));
  root.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return withColliders(root, [{ type: 'box', half: [0.105, 0.045, 0.075], pos: [0, 0.045, 0] }]);
}

// ---- Arch gate ---------------------------------------------------------------

const GATE_HALF = 0.162; // post centres; inner opening 0.30 m
const POST_TOP = 0.3;

function buildGate(): Group {
  const root = new Group();
  root.name = 'Gate';
  for (const side of [-1, 1]) {
    const parts = stripedPost(0.012, 0.012, POST_TOP, 7, 0xe63946, WHITE);
    parts.push({ geometry: new CylinderGeometry(0.03, 0.036, 0.012, 24), matrix: at(0, 0.006, 0), color: INK });
    parts.push({ geometry: new CylinderGeometry(0.016, 0.016, 0.012, 16), matrix: at(0, POST_TOP, 0), color: GOLD });
    const post = mesh(side < 0 ? 'PostNear' : 'PostFar', mergeColored(parts), colored);
    post.position.z = side * GATE_HALF;
    root.add(post);
  }
  // Semicircular arch over the opening (in the gate's y-z plane).
  const arch = new FnCurve((t, out) => out.set(0, POST_TOP + GATE_HALF * Math.sin(Math.PI * t), -GATE_HALF * Math.cos(Math.PI * t)));
  root.add(mesh('Arch', new TubeGeometry(arch, 48, 0.011, 10, false), toyMaterial(0x3a86ff, 0.4)));
  // Warm string lights along the arch.
  const bulbs: ColoredPart[] = [];
  for (let i = 1; i < 10; i++) {
    const a = (Math.PI * i) / 10;
    const rr = GATE_HALF + 0.013;
    bulbs.push({ geometry: new SphereGeometry(0.0075, 10, 8), matrix: at(0, POST_TOP + rr * Math.sin(a), -rr * Math.cos(a)), color: 0xffffff });
  }
  root.add(mesh('Lights', mergeColored(bulbs), bulb));
  // Gold finial and a pennant pointing down the course.
  const finial = mesh('Finial', new SphereGeometry(0.014, 16, 12), gold);
  finial.position.set(0, POST_TOP + GATE_HALF + 0.022, 0);
  root.add(finial);
  const pennantShape = new Shape();
  pennantShape.moveTo(0, 0);
  pennantShape.quadraticCurveTo(0.04, 0.022, 0.085, 0.018);
  pennantShape.lineTo(0, 0.045);
  pennantShape.closePath();
  const pennant = new ExtrudeGeometry(pennantShape, { depth: 0.002, bevelEnabled: false });
  pennant.translate(0, 0, -0.001);
  const flag = mesh('Pennant', pennant, toyMaterial(0xffbe0b, 0.5));
  flag.position.set(0.004, POST_TOP + GATE_HALF + 0.03, 0);
  root.add(flag);
  root.traverse((o) => { o.castShadow = true; });
  return withColliders(root, [
    { type: 'cylinder', radius: 0.016, halfHeight: POST_TOP / 2, pos: [0, POST_TOP / 2, -GATE_HALF] },
    { type: 'cylinder', radius: 0.016, halfHeight: POST_TOP / 2, pos: [0, POST_TOP / 2, GATE_HALF] },
  ]);
}

// ---- Goal (mouth faces -x) -----------------------------------------------------

const GOAL_X = 0.06;
const GOAL_Z = 0.15;
const GOAL_H = 0.15;

/** White net strands on transparent: alpha-tested, so no sorting artefacts. */
const netTexture = proceduralTexture(64, 64, (x, y, out) => {
  const strand = x % 16 < 2 || y % 16 < 2;
  out[0] = out[1] = out[2] = 245;
  out[3] = strand ? 255 : 0;
});
const netMaterial = new MeshStandardMaterial({ map: netTexture, alphaTest: 0.5, side: DoubleSide, roughness: 0.8 });

/** A net panel w x h metres, with net cells about 1.6 cm across. */
function netPanel(w: number, h: number): PlaneGeometry {
  const plane = new PlaneGeometry(w, h);
  const uv = plane.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 0.064), uv.getY(i) * (h / 0.064));
  return plane;
}

function buildGoal(): Group {
  const root = new Group();
  root.name = 'Goal';
  const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const r = 0.008;
  const tube = (a: Vector3, b: Vector3, radius: number, color: number): ColoredPart => ({
    geometry: new CylinderGeometry(radius, radius, a.distanceTo(b), 12),
    matrix: spanMatrix(a, b),
    color,
  });
  const frame: ColoredPart[] = [];
  for (const side of [-1, 1]) {
    const posts = stripedPost(r, 0, GOAL_H, 5, WHITE, 0xe63946);
    for (const p of posts) p.matrix = new Matrix4().makeTranslation(-GOAL_X, 0, side * GOAL_Z).multiply(p.matrix!);
    frame.push(...posts);
    frame.push(tube(v(GOAL_X, 0, side * GOAL_Z), v(GOAL_X, GOAL_H, side * GOAL_Z), r * 0.8, 0xbcc6d0));
    frame.push(tube(v(-GOAL_X, GOAL_H, side * GOAL_Z), v(GOAL_X, GOAL_H, side * GOAL_Z), r * 0.8, 0xbcc6d0));
    frame.push(tube(v(-GOAL_X, r, side * GOAL_Z), v(GOAL_X, r, side * GOAL_Z), r * 0.8, 0xbcc6d0));
  }
  frame.push(tube(v(-GOAL_X, GOAL_H, -GOAL_Z), v(-GOAL_X, GOAL_H, GOAL_Z), r, WHITE));
  frame.push(tube(v(GOAL_X, GOAL_H, -GOAL_Z), v(GOAL_X, GOAL_H, GOAL_Z), r * 0.8, 0xbcc6d0));
  frame.push(tube(v(GOAL_X, r, -GOAL_Z), v(GOAL_X, r, GOAL_Z), r * 0.8, 0xbcc6d0));
  root.add(mesh('Frame', mergeColored(frame), colored));

  const net = new Group();
  net.name = 'Net';
  const back = mesh('Back', netPanel(2 * GOAL_Z, GOAL_H), netMaterial);
  back.position.set(GOAL_X, GOAL_H / 2, 0);
  back.rotation.y = -Math.PI / 2;
  const roof = mesh('Roof', netPanel(2 * GOAL_X, 2 * GOAL_Z), netMaterial);
  roof.position.set(0, GOAL_H, 0);
  roof.rotation.x = -Math.PI / 2;
  net.add(back, roof);
  for (const side of [-1, 1]) {
    const wall = mesh(side < 0 ? 'SideNear' : 'SideFar', netPanel(2 * GOAL_X, GOAL_H), netMaterial);
    wall.position.set(0, GOAL_H / 2, side * GOAL_Z);
    net.add(wall);
  }
  root.add(net);
  root.traverse((o) => { o.castShadow = true; });

  const wall = 0.006;
  return withColliders(root, [
    { type: 'cylinder', radius: 0.012, halfHeight: GOAL_H / 2, pos: [-GOAL_X, GOAL_H / 2, -GOAL_Z] },
    { type: 'cylinder', radius: 0.012, halfHeight: GOAL_H / 2, pos: [-GOAL_X, GOAL_H / 2, GOAL_Z] },
    { type: 'box', half: [wall, GOAL_H / 2, GOAL_Z + wall], pos: [GOAL_X + wall, GOAL_H / 2, 0] },
    { type: 'box', half: [GOAL_X + wall, GOAL_H / 2, wall], pos: [0, GOAL_H / 2, -GOAL_Z - wall] },
    { type: 'box', half: [GOAL_X + wall, GOAL_H / 2, wall], pos: [0, GOAL_H / 2, GOAL_Z + wall] },
    { type: 'box', half: [GOAL_X + wall, wall, GOAL_Z + wall], pos: [0, GOAL_H + wall, 0] },
  ]);
}

// ---- Start and finish ----------------------------------------------------------

const flat = (y: number, x = 0, z = 0) =>
  new Matrix4().makeTranslation(x, y, z).multiply(new Matrix4().makeRotationX(-Math.PI / 2));

function chevron(): Shape {
  const s = new Shape();
  s.moveTo(-0.016, 0.03);
  s.lineTo(0.004, 0.03);
  s.lineTo(0.028, 0);
  s.lineTo(0.004, -0.03);
  s.lineTo(-0.016, -0.03);
  s.lineTo(0.008, 0);
  s.closePath();
  return s;
}

function buildStartPad(): Group {
  const root = new Group();
  root.name = 'StartPad';
  const parts: ColoredPart[] = [
    { geometry: new CylinderGeometry(0.13, 0.132, 0.004, 48), matrix: at(0, 0.002, 0), color: 0x1f7a44 },
    { geometry: new CylinderGeometry(0.118, 0.118, 0.0016, 48), matrix: at(0, 0.0046, 0), color: 0x3ba55c },
    {
      geometry: new TorusGeometry(0.106, 0.0022, 6, 48),
      matrix: new Matrix4().makeTranslation(0, 0.0054, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)),
      color: WHITE,
    },
  ];
  for (const x of [-0.05, -0.012, 0.026]) {
    parts.push({ geometry: new ExtrudeGeometry(chevron(), { depth: 0.0012, bevelEnabled: false }), matrix: flat(0.0054, x), color: WHITE });
  }
  root.add(mesh('Pad', mergeColored(parts), colored));
  root.traverse((o) => { o.receiveShadow = true; });
  return root;
}

const FINISH_HALF = 0.2;
const FINISH_TOP = 0.4;

function buildFinishPad(): Group {
  const root = new Group();
  root.name = 'FinishPad';
  const rings = [0, 0.05, 0.095, 0.135];
  const sectors = 12;
  const cells: ColoredPart[] = [
    { geometry: new CylinderGeometry(0.142, 0.144, 0.004, 48), matrix: at(0, 0.002, 0), color: INK },
  ];
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let s = 0; s < sectors; s++) {
      const dt = (2 * Math.PI) / sectors;
      cells.push({
        geometry: new RingGeometry(rings[ring], rings[ring + 1], 4, 1, s * dt, dt),
        matrix: flat(0.0042),
        color: (ring + s) % 2 === 0 ? WHITE : INK,
      });
    }
  }
  root.add(mesh('Pad', mergeColored(cells), colored));

  // Finish arch: striped posts and a checkered banner across the top.
  const arch: ColoredPart[] = [];
  for (const side of [-1, 1]) {
    const posts = stripedPost(0.012, 0.01, FINISH_TOP, 8, INK, WHITE);
    for (const p of posts) p.matrix = new Matrix4().makeTranslation(0, 0, side * FINISH_HALF).multiply(p.matrix!);
    arch.push(...posts);
    arch.push({ geometry: new CylinderGeometry(0.03, 0.035, 0.01, 24), matrix: at(0, 0.005, side * FINISH_HALF), color: INK });
  }
  const cols = 20;
  const cell = (2 * FINISH_HALF) / cols;
  for (let c = 0; c < cols; c++) {
    for (let row = 0; row < 2; row++) {
      arch.push({
        geometry: new BoxGeometry(0.004, cell, cell),
        matrix: at(0, FINISH_TOP - 0.03 + row * cell, -FINISH_HALF + cell * (c + 0.5)),
        color: (c + row) % 2 === 0 ? WHITE : INK,
      });
    }
  }
  root.add(mesh('Arch', mergeColored(arch), colored));
  for (const side of [-1, 1]) {
    const cap = mesh(side < 0 ? 'CapNear' : 'CapFar', new SphereGeometry(0.016, 16, 12), gold);
    cap.position.set(0, FINISH_TOP + 0.012, side * FINISH_HALF);
    root.add(cap);
  }
  root.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return withColliders(root, [
    { type: 'cylinder', radius: 0.016, halfHeight: FINISH_TOP / 2, pos: [0, FINISH_TOP / 2, -FINISH_HALF] },
    { type: 'cylinder', radius: 0.016, halfHeight: FINISH_TOP / 2, pos: [0, FINISH_TOP / 2, FINISH_HALF] },
  ]);
}

// ---- Crumb and ball -------------------------------------------------------------

const glowTexture = proceduralTexture(64, 64, (x, y, out) => {
  const d = Math.hypot(x - 31.5, y - 31.5) / 32;
  const a = Math.max(0, 1 - d);
  out[0] = 255;
  out[1] = 214;
  out[2] = 102;
  out[3] = Math.round(255 * a * a);
});

function buildCrumb(): Group {
  const root = new Group();
  root.name = 'Crumb';
  // A torn bread cube: golden crust, a soft cream cut face toward +x.
  const geometry = bevelBox(0.026, 0.017, 0.021, 0.0045, 0.004, 3);
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const normals = nonIndexed.getAttribute('normal');
  const colors = new Float32Array(normals.count * 3);
  const crust = new Color(0xc9893a);
  const top = new Color(0xa8692a);
  const inside = new Color(0xf3dfb0);
  for (let i = 0; i < normals.count; i++) {
    const nx = normals.getX(i);
    const ny = normals.getY(i);
    const c = nx > 0.6 ? inside : ny > 0.6 ? top : crust;
    c.toArray(colors, i * 3);
  }
  nonIndexed.setAttribute('color', new BufferAttribute(colors, 3));
  const bread = mesh('Bread', nonIndexed, toyMaterial(0xffffff, 0.85, 0, { vertexColors: true, emissive: 0x4a2606, emissiveIntensity: 0.4 }));
  bread.position.y = 0.016;
  bread.rotation.z = 0.22;
  bread.castShadow = true;
  root.add(bread);
  const glow = new Group();
  glow.name = 'Glow';
  const halo = mesh('Halo', new PlaneGeometry(0.1, 0.1).rotateX(-Math.PI / 2), new MeshBasicMaterial({
    map: glowTexture,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  }));
  halo.position.y = 0.003;
  const ring = mesh('Ring', new RingGeometry(0.03, 0.033, 40).rotateX(-Math.PI / 2), toyMaterial(0xffd166, 0.4, 0, { emissive: 0xffc233, emissiveIntensity: 1.1 }));
  ring.position.y = 0.0035;
  glow.add(halo, ring);
  root.add(glow);
  return root;
}

function buildBall(): Group {
  const root = new Group();
  root.name = 'Ball';
  const sphere = new SphereGeometry(0.05, 36, 18).toNonIndexed();
  const pos = sphere.getAttribute('position');
  const gores = [0xe63946, WHITE, 0x3a86ff, WHITE, 0xffbe0b, WHITE];
  const colors = new Float32Array(pos.count * 3);
  const c = new Vector3();
  const corner = new Vector3();
  const tint = new Color();
  for (let t = 0; t < pos.count; t += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(corner.fromBufferAttribute(pos, t + k));
    c.divideScalar(3);
    const lat = Math.asin(Math.max(-1, Math.min(1, c.y / c.length())));
    const lon = Math.atan2(c.z, c.x);
    // Six coloured gores and white caps: rolling reads clearly.
    tint.set(Math.abs(lat) > 1.15 ? WHITE : gores[Math.floor(((lon + Math.PI) / (2 * Math.PI)) * 6) % 6]);
    for (let k = 0; k < 3; k++) tint.toArray(colors, (t + k) * 3);
  }
  const merged = mergeColored([{ geometry: sphere, color: WHITE }]);
  merged.getAttribute('color').array.set(colors);
  const shell = mesh('Shell', merged, new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0 }));
  shell.castShadow = true;
  root.add(shell);
  return root;
}

export const courseBookStack = buildBookStack();
export const courseGate = buildGate();
export const courseGoal = buildGoal();
export const courseStartPad = buildStartPad();
export const courseFinishPad = buildFinishPad();
export const courseCrumb = buildCrumb();
export const courseBall = buildBall();
