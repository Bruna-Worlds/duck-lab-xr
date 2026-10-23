// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The VR toy room around Duck Lab XR (v2): a closed, cosy living room at real
 * scale. Plank floor with wood grain (its top is the sim floor, y = 0), a
 * patterned rug under the course, wainscoted walls, a curtained window, a
 * ceiling light, and furniture along the walls. It is never part of the
 * course, but it is solid: its walls and furniture carry colliders (the duck
 * bumps into them in VR), and the scene marks it VrOnly so mixed reality
 * shows the real room instead (hidden, it is left out of the physics). Origin at the floor centre (the player's start);
 * the course area x -1.4..1.5, z -1.7..-0.8 and the player area stay clear.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
} from '@iwsdk/core';
import { bevelBox, makeRandom } from './lib/hardsurface.js';
import { COLLIDERS_KEY, type ColliderSpec } from '../course/collider-spec.js';
import { at, type ColoredPart, mergeColored, proceduralTexture, toyMaterial, valueNoise } from './lib/kit.js';

const HALF = 3; // the room is 6 m square
const WALL_H = 2.7;
const PLANK = 0.15;
const random = makeRandom(23);
const noise = valueNoise(5);

// ---- Textures ------------------------------------------------------------------

/** Warm wood grain; grain lines run along u (the plank length). */
const grain = proceduralTexture(256, 256, (x, y, out) => {
  const warp = noise(x * 0.02, y * 0.15) * 6;
  const rings = 0.5 + 0.5 * Math.sin(y * 0.55 + warp);
  const fine = noise(x * 0.4, y * 1.5);
  const v = 0.78 + 0.14 * rings * rings + 0.08 * fine;
  out[0] = 255 * v;
  out[1] = 238 * v;
  out[2] = 220 * v;
});

/** Rug: rust border bands around a navy field with a cream diamond lattice. */
const RUG_W = 3.1;
const RUG_D = 1.25;
const rugTexture = proceduralTexture(512, 256, (x, y, out) => {
  const u = x / 512;
  const v = y / 256;
  const edge = Math.min(u * RUG_W, (1 - u) * RUG_W, v * RUG_D, (1 - v) * RUG_D); // metres to the rug edge
  let c: [number, number, number];
  if (edge < 0.05) c = [214, 196, 160];
  else if (edge < 0.11) c = [176, 82, 52];
  else if (edge < 0.13) c = [228, 210, 172];
  else {
    const du = Math.abs(((u * RUG_W * 5) % 1) - 0.5);
    const dv = Math.abs(((v * RUG_D * 5) % 1) - 0.5);
    const diamond = du + dv;
    c = diamond < 0.12 ? [232, 196, 120] : diamond > 0.47 ? [64, 116, 128] : [38, 58, 92];
  }
  const fuzz = 0.92 + 0.08 * noise(x * 0.7, y * 0.7);
  out[0] = c[0] * fuzz;
  out[1] = c[1] * fuzz;
  out[2] = c[2] * fuzz;
});

/** Window sky: blue at the top fading to warm haze at the horizon. */
const skyTexture = proceduralTexture(4, 64, (_x, y, out) => {
  const t = y / 63;
  out[0] = 255 * (0.98 - 0.45 * t);
  out[1] = 255 * (0.92 - 0.2 * t);
  out[2] = 255 * (0.85 + 0.1 * t);
});

/** Abstract art for the picture frames: soft colour blocks and a sun. */
function artTexture(seed: number): ReturnType<typeof proceduralTexture> {
  const n = valueNoise(seed);
  const palette = [[239, 71, 111], [255, 209, 102], [6, 214, 160], [17, 138, 178], [242, 233, 216]];
  return proceduralTexture(128, 128, (x, y, out) => {
    const band = Math.floor((y / 128) * 4 + n(x * 0.03, y * 0.03) * 1.2);
    let c = palette[(band + seed) % palette.length];
    if (Math.hypot(x - 84, y - 92) < 18) c = palette[(seed + 1) % palette.length];
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
  });
}

// ---- Floor -------------------------------------------------------------------------

/** One quad per plank (the top face), with per-plank tone and grain offset. */
function plankFloor(): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const tones = [[0.78, 0.55, 0.34], [0.72, 0.5, 0.31], [0.82, 0.59, 0.37], [0.75, 0.52, 0.33]];
  const gap = 0.0015;
  for (let row = 0; row < Math.round((2 * HALF) / PLANK); row++) {
    const z0 = -HALF + row * PLANK + gap;
    const z1 = z0 + PLANK - 2 * gap;
    let x = -HALF + (row % 3) * -0.4;
    while (x < HALF) {
      const length = 0.9 + random() * 1.3;
      const x0 = Math.max(-HALF, x) + gap;
      const x1 = Math.min(HALF, x + length) - gap;
      if (x1 > x0) {
        const tone = tones[Math.floor(random() * tones.length)];
        const ou = random();
        const ov = random();
        // Counter-clockwise from above, so the planks face up.
        const quad = [[x0, z0], [x1, z1], [x1, z0], [x0, z0], [x0, z1], [x1, z1]];
        for (const [qx, qz] of quad) {
          positions.push(qx, 0, qz);
          uvs.push(ou + (qx - x0) * 0.6, ov + ((qz - z0) / PLANK) * 0.35);
          colors.push(tone[0], tone[1], tone[2]);
        }
      }
      x += length;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  g.computeVertexNormals();
  return g;
}

// ---- Walls, ceiling, window ------------------------------------------------------

const WAINSCOT = 0.92;
const WALL_COLOR = 0xe9dcc3;
const TRIM = 0xf6f2ea;

/** Wall shell, wainscoting with raised panels, chair rail, base and crown trim. */
function walls(): BufferGeometry {
  const parts: ColoredPart[] = [];
  const wall = (cx: number, cz: number, alongX: boolean) => {
    const w = alongX ? 2 * HALF : 0.1;
    const d = alongX ? 0.1 : 2 * HALF;
    parts.push({ geometry: bevelBox(w, WALL_H, d, 0.002), matrix: at(cx, WALL_H / 2, cz), color: WALL_COLOR });
    // Inward offset for trim on this wall's room-facing side.
    const ix = alongX ? 0 : -Math.sign(cx);
    const iz = alongX ? -Math.sign(cz) : 0;
    const face = (depth: number) => [cx + ix * (0.05 + depth / 2), cz + iz * (0.05 + depth / 2)] as const;
    const span = 2 * HALF - 0.02;
    const box = (h: number, depth: number, y: number, color: number) => {
      const [fx, fz] = face(depth);
      parts.push({ geometry: bevelBox(alongX ? span : depth, h, alongX ? depth : span, 0.002), matrix: at(fx, y, fz), color });
    };
    box(WAINSCOT, 0.012, WAINSCOT / 2, TRIM); // wainscot board
    box(0.035, 0.03, WAINSCOT, TRIM); // chair rail
    box(0.11, 0.024, 0.055, 0xffffff); // baseboard
    box(0.07, 0.05, WALL_H - 0.035, TRIM); // crown
    // Raised panel moldings on the wainscot.
    const panels = 7;
    const pw = span / panels;
    for (let i = 0; i < panels; i++) {
      const o = -span / 2 + pw * (i + 0.5);
      const [fx, fz] = face(0.026);
      parts.push({
        geometry: bevelBox(alongX ? pw - 0.12 : 0.008, WAINSCOT - 0.3, alongX ? 0.008 : pw - 0.12, 0.003),
        matrix: at(fx + (alongX ? o : 0), WAINSCOT / 2 + 0.03, fz + (alongX ? 0 : o)),
        color: 0xfdfbf6,
      });
    }
  };
  wall(0, -HALF - 0.05, true);
  wall(0, HALF + 0.05, true);
  wall(-HALF - 0.05, 0, false);
  wall(HALF + 0.05, 0, false);
  return mergeColored(parts);
}

const WINDOW_X = 0.6;
const WINDOW_Y = 1.6;
const WINDOW_W = 1.5;
const WINDOW_H = 1.15;

function windowFrame(): BufferGeometry {
  const z = -HALF + 0.02;
  const t = 0.07;
  return mergeColored([
    { geometry: bevelBox(WINDOW_W + 2 * t, t, 0.08, 0.004), matrix: at(WINDOW_X, WINDOW_Y + WINDOW_H / 2 + t / 2, z), color: 0xffffff },
    { geometry: bevelBox(WINDOW_W + 2 * t + 0.08, 0.05, 0.14, 0.004), matrix: at(WINDOW_X, WINDOW_Y - WINDOW_H / 2 - 0.025, z + 0.03), color: 0xffffff },
    { geometry: bevelBox(t, WINDOW_H, 0.08, 0.004), matrix: at(WINDOW_X - WINDOW_W / 2 - t / 2, WINDOW_Y, z), color: 0xffffff },
    { geometry: bevelBox(t, WINDOW_H, 0.08, 0.004), matrix: at(WINDOW_X + WINDOW_W / 2 + t / 2, WINDOW_Y, z), color: 0xffffff },
    { geometry: bevelBox(0.035, WINDOW_H, 0.05, 0.003), matrix: at(WINDOW_X, WINDOW_Y, z + 0.005), color: 0xffffff },
    { geometry: bevelBox(WINDOW_W, 0.035, 0.05, 0.003), matrix: at(WINDOW_X, WINDOW_Y + 0.1, z + 0.005), color: 0xffffff },
  ]);
}

/** A curtain panel with soft folds (sine-displaced plane), hanging from y=top. */
function curtain(width: number, height: number): PlaneGeometry {
  const plane = new PlaneGeometry(width, height, 24, 8);
  const pos = plane.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const flare = 1 + 0.6 * (0.5 - y / height); // folds widen toward the hem
    pos.setZ(i, 0.025 * flare * Math.sin((x / width) * Math.PI * 7));
  }
  plane.translate(0, -height / 2, 0);
  plane.computeVertexNormals();
  return plane;
}

// ---- Furniture -----------------------------------------------------------------

const rotY = (x: number, y: number, z: number, yaw: number): Matrix4 =>
  new Matrix4().makeRotationY(yaw).setPosition(x, y, z);

/** A two-seat sofa facing +x (its back at local -x), origin at floor centre. */
function sofa(parts: ColoredPart[], x: number, z: number, yaw: number): void {
  const fabric = 0x4f7f8c;
  const dark = 0x3b6572;
  const wood = 0x6b4a2b;
  const place = (geometry: BufferGeometry, lx: number, ly: number, lz: number, color: number) => {
    const local = at(lx, ly, lz);
    parts.push({ geometry, matrix: rotY(x, 0, z, yaw).multiply(local), color });
  };
  place(bevelBox(0.8, 0.22, 1.6, 0.03), 0.05, 0.22, 0, dark); // base
  place(bevelBox(0.25, 0.5, 1.6, 0.04), -0.3, 0.58, 0, fabric); // backrest
  place(bevelBox(0.7, 0.3, 0.2, 0.04), 0.05, 0.47, -0.7, fabric); // arm
  place(bevelBox(0.7, 0.3, 0.2, 0.04), 0.05, 0.47, 0.7, fabric); // arm
  place(bevelBox(0.62, 0.14, 0.58, 0.05), 0.1, 0.4, -0.3, fabric); // seat cushions
  place(bevelBox(0.62, 0.14, 0.58, 0.05), 0.1, 0.4, 0.3, fabric);
  place(bevelBox(0.3, 0.3, 0.3, 0.06), 0.05, 0.6, -0.3, 0xe8a24a); // throw pillows
  place(bevelBox(0.3, 0.3, 0.3, 0.06), 0.05, 0.6, 0.3, 0xd9574c);
  for (const [lx, lz] of [[-0.3, -0.7], [0.35, -0.7], [-0.3, 0.7], [0.35, 0.7]]) {
    place(new CylinderGeometry(0.03, 0.025, 0.12, 8), lx, 0.06, lz, wood); // feet
  }
}

/** A bookshelf against a wall, facing +x, filled with random coloured books. */
function bookshelf(parts: ColoredPart[], x: number, z: number, yaw: number): void {
  const wood = 0x8a5a33;
  const w = 0.32; // depth along local x
  const span = 1.1; // along local z
  const h = 1.9;
  const base = rotY(x, 0, z, yaw);
  const place = (geometry: BufferGeometry, lx: number, ly: number, lz: number, color: number) =>
    parts.push({ geometry, matrix: base.clone().multiply(at(lx, ly, lz)), color });
  place(bevelBox(w, h, 0.03, 0.003), 0, h / 2, -span / 2, wood); // sides
  place(bevelBox(w, h, 0.03, 0.003), 0, h / 2, span / 2, wood);
  place(bevelBox(0.02, h, span, 0.002), -w / 2 + 0.01, h / 2, 0, 0x6e4526); // back panel
  place(bevelBox(w, 0.04, span, 0.003), 0, h - 0.02, 0, wood); // top
  const shelves = [0.06, 0.5, 0.94, 1.38];
  for (const y of shelves) {
    place(bevelBox(w, 0.03, span, 0.003), 0, y, 0, wood);
    // Books: a run of spines with gaps, leaning slightly at the end of a run.
    let lz = -span / 2 + 0.05;
    const palette = [0xd9574c, 0x3a7ca5, 0xe8a24a, 0x5b8c5a, 0xf2e9d8, 0x7b4b94, 0x2f3e46];
    while (lz < span / 2 - 0.08) {
      const thickness = 0.02 + random() * 0.03;
      const height = 0.18 + random() * 0.14;
      const color = palette[Math.floor(random() * palette.length)];
      place(bevelBox(0.2 + random() * 0.05, height, thickness, 0.002), 0.02, y + 0.015 + height / 2, lz + thickness / 2, color);
      lz += thickness + (random() < 0.12 ? 0.06 : 0.002);
    }
  }
  // A plant pot and a toy duck figurine on the top shelf.
  place(new CylinderGeometry(0.06, 0.045, 0.1, 10), 0, h + 0.05, -0.3, 0xc9733f);
  place(new SphereGeometry(0.09, 10, 8), 0, h + 0.16, -0.3, 0x4f9a4a);
}

/** A floor lamp: base, pole and a drum shade. */
function floorLamp(parts: ColoredPart[], x: number, z: number): void {
  parts.push({ geometry: new CylinderGeometry(0.14, 0.16, 0.025, 16), matrix: at(x, 0.0125, z), color: 0x2b2b2b });
  parts.push({ geometry: new CylinderGeometry(0.012, 0.012, 1.5, 8), matrix: at(x, 0.77, z), color: 0xd4af37 });
  parts.push({ geometry: new CylinderGeometry(0.17, 0.2, 0.3, 20, 1, true), matrix: at(x, 1.62, z), color: 0xf6e7c8 });
}

/** A potted plant: terracotta pot with a few leaf blobs. */
function plant(parts: ColoredPart[], x: number, z: number): void {
  parts.push({ geometry: new CylinderGeometry(0.17, 0.13, 0.3, 14), matrix: at(x, 0.15, z), color: 0xc9733f });
  parts.push({ geometry: new CylinderGeometry(0.19, 0.17, 0.05, 14), matrix: at(x, 0.3, z), color: 0xb86536 });
  const leaves = 7;
  for (let i = 0; i < leaves; i++) {
    const a = (i / leaves) * Math.PI * 2;
    const r = 0.12 + random() * 0.08;
    parts.push({
      geometry: new SphereGeometry(0.1 + random() * 0.05, 8, 6),
      matrix: at(x + Math.cos(a) * r, 0.5 + random() * 0.25, z + Math.sin(a) * r),
      color: i % 2 ? 0x3f8a3f : 0x5aa64f,
    });
  }
  parts.push({ geometry: new SphereGeometry(0.13, 8, 6), matrix: at(x, 0.78, z), color: 0x4c9a45 });
}

/** A toy chest with lid, plus a few oversized blocks beside it. */
function toyChest(parts: ColoredPart[], x: number, z: number): void {
  parts.push({ geometry: bevelBox(0.5, 0.4, 0.9, 0.01), matrix: at(x, 0.2, z), color: 0xd9574c });
  parts.push({ geometry: bevelBox(0.54, 0.06, 0.94, 0.012), matrix: at(x, 0.43, z), color: 0xb84036 });
  parts.push({ geometry: bevelBox(0.5, 0.03, 0.06, 0.004), matrix: at(x + 0.26, 0.2, z), color: 0xffd166 });
  const blocks: [number, number, number, number, number][] = [
    [x + 0.5, 0.11, z - 0.55, 0.22, 0x3a7ca5],
    [x + 0.5, 0.33, z - 0.55, 0.22, 0xe8a24a],
    [x + 0.3, 0.09, z + 0.62, 0.18, 0x5b8c5a],
  ];
  for (const [bx, by, bz, size, color] of blocks) {
    parts.push({ geometry: bevelBox(size, size, size, 0.015), matrix: rotY(bx, by, bz, random() * 0.6), color });
  }
}

/** A small side table next to the sofa. */
function sideTable(parts: ColoredPart[], x: number, z: number): void {
  parts.push({ geometry: new CylinderGeometry(0.22, 0.22, 0.03, 18), matrix: at(x, 0.5, z), color: 0x8a5a33 });
  parts.push({ geometry: new CylinderGeometry(0.03, 0.03, 0.48, 10), matrix: at(x, 0.25, z), color: 0x6b4a2b });
  parts.push({ geometry: new CylinderGeometry(0.16, 0.18, 0.02, 18), matrix: at(x, 0.01, z), color: 0x6b4a2b });
  parts.push({ geometry: new CylinderGeometry(0.045, 0.04, 0.09, 12), matrix: at(x + 0.05, 0.56, z - 0.05), color: 0xf2e9d8 }); // mug
}

function furniture(): BufferGeometry {
  const parts: ColoredPart[] = [];
  sofa(parts, HALF - 0.55, -0.2, Math.PI); // right wall, facing the room
  sideTable(parts, HALF - 0.45, -1.3);
  bookshelf(parts, -HALF + 0.2, -1.5, 0); // left wall, facing the room
  floorLamp(parts, HALF - 0.45, -2.5);
  plant(parts, -HALF + 0.45, -2.55);
  toyChest(parts, -HALF + 0.33, 1.2);
  return mergeColored(parts);
}

// ---- Assembly --------------------------------------------------------------------

function pictureFrame(seed: number, width: number, height: number): Group {
  const frame = new Group();
  frame.name = `Picture${seed}`;
  const border = new Mesh(bevelBox(width + 0.08, height + 0.08, 0.03, 0.004), toyMaterial(0x3b2a1a, 0.5));
  border.position.z = -0.015;
  const art = new Mesh(
    new PlaneGeometry(width, height),
    new MeshStandardMaterial({ map: artTexture(seed), roughness: 0.9 }),
  );
  art.position.z = 0.001;
  frame.add(border, art);
  return frame;
}

function buildToyRoom(): Group {
  const room = new Group();
  room.name = 'ToyRoom';

  const floor = new Mesh(
    plankFloor(),
    new MeshStandardMaterial({ map: grain, vertexColors: true, roughness: 0.55, metalness: 0.02 }),
  );
  floor.name = 'Floor';
  floor.receiveShadow = true;
  const floorBase = new Mesh(new PlaneGeometry(2 * HALF, 2 * HALF).rotateX(-Math.PI / 2), toyMaterial(0x2a1c10, 1));
  floorBase.name = 'FloorBase';
  floorBase.position.y = -0.003;

  const rug = new Mesh(
    new PlaneGeometry(RUG_W, RUG_D, 1, 1).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ map: rugTexture, roughness: 0.95 }),
  );
  rug.name = 'Rug';
  rug.position.set(0.05, 0.004, -1.3);
  rug.receiveShadow = true;

  const shell = new Mesh(walls(), toyMaterial(0xffffff, 0.85, 0, { vertexColors: true }));
  shell.name = 'Walls';
  shell.receiveShadow = true;

  const ceiling = new Mesh(new PlaneGeometry(2 * HALF, 2 * HALF).rotateX(Math.PI / 2), toyMaterial(0xf7f3ea, 0.95));
  ceiling.name = 'Ceiling';
  ceiling.position.y = WALL_H;
  const lampShade = new Mesh(
    new CylinderGeometry(0.26, 0.3, 0.09, 24),
    toyMaterial(0xfff4dc, 0.6, 0, { emissive: 0xffe9c4, emissiveIntensity: 0.9 }),
  );
  lampShade.name = 'CeilingLight';
  lampShade.position.set(0, WALL_H - 0.07, -0.9);
  const lampRim = new Mesh(new CylinderGeometry(0.31, 0.31, 0.03, 24), toyMaterial(0xd4af37, 0.35, 0.6));
  lampRim.position.set(0, WALL_H - 0.025, -0.9);

  const frameGeometry = new Mesh(windowFrame(), toyMaterial(0xffffff, 0.6, 0, { vertexColors: true }));
  frameGeometry.name = 'WindowFrame';
  const sky = new Mesh(
    new PlaneGeometry(WINDOW_W, WINDOW_H),
    new MeshStandardMaterial({ map: skyTexture, roughness: 1, emissive: 0xffffff, emissiveMap: skyTexture, emissiveIntensity: 0.55 }),
  );
  sky.name = 'Sky';
  sky.position.set(WINDOW_X, WINDOW_Y, -HALF - 0.03);
  const curtainMaterial = new MeshStandardMaterial({ color: 0xc96a4a, roughness: 0.9, side: DoubleSide });
  const curtains = new Group();
  curtains.name = 'Curtains';
  for (const side of [-1, 1]) {
    const panel = new Mesh(curtain(0.55, WINDOW_H + 0.6), curtainMaterial);
    panel.position.set(WINDOW_X + side * (WINDOW_W / 2 + 0.2), WINDOW_Y + WINDOW_H / 2 + 0.22, -HALF + 0.14);
    curtains.add(panel);
  }
  const rod = new Mesh(new CylinderGeometry(0.014, 0.014, WINDOW_W + 1.1, 10).rotateZ(Math.PI / 2), toyMaterial(0xd4af37, 0.35, 0.6));
  rod.position.set(WINDOW_X, WINDOW_Y + WINDOW_H / 2 + 0.24, -HALF + 0.14);
  curtains.add(rod);

  const pieces = new Mesh(furniture(), toyMaterial(0xffffff, 0.75, 0, { vertexColors: true }));
  pieces.name = 'Furniture';
  pieces.receiveShadow = true;

  const art = new Group();
  art.name = 'Pictures';
  const leftWall = pictureFrame(1, 0.6, 0.45);
  leftWall.position.set(-HALF + 0.045, 1.55, -0.2);
  leftWall.rotation.y = Math.PI / 2;
  const backWall = pictureFrame(3, 0.5, 0.7);
  backWall.position.set(2.1, 1.6, -HALF + 0.045);
  const frontWall = pictureFrame(4, 0.9, 0.5);
  frontWall.position.set(-0.6, 1.6, HALF - 0.045);
  frontWall.rotation.y = Math.PI;
  art.add(leftWall, backWall, frontWall);

  room.add(floorBase, floor, rug, shell, ceiling, lampShade, lampRim, frameGeometry, sky, curtains, pieces, art);
  room.traverse((object) => {
    object.castShadow = false;
  });
  room.userData[COLLIDERS_KEY] = ROOM_COLLIDERS;
  return room;
}

/** What the duck bumps into, in the room's frame (see furniture() for where each piece stands). */
const ROOM_COLLIDERS: ColliderSpec[] = [
  // Walls: inner faces (with the trim) about 2.95 m from the centre.
  { type: 'box', half: [3.1, 1.35, 0.08], pos: [0, 1.35, -HALF - 0.03] },
  { type: 'box', half: [3.1, 1.35, 0.08], pos: [0, 1.35, HALF + 0.03] },
  { type: 'box', half: [0.08, 1.35, 3.1], pos: [-HALF - 0.03, 1.35, 0] },
  { type: 'box', half: [0.08, 1.35, 3.1], pos: [HALF + 0.03, 1.35, 0] },
  { type: 'box', half: [0.44, 0.42, 0.8], pos: [HALF - 0.56, 0.42, -0.2] }, // sofa
  { type: 'cylinder', radius: 0.2, halfHeight: 0.27, pos: [HALF - 0.45, 0.27, -1.3] }, // side table
  { type: 'box', half: [0.17, 0.95, 0.56], pos: [-HALF + 0.2, 0.95, -1.5] }, // bookshelf
  { type: 'cylinder', radius: 0.15, halfHeight: 0.85, pos: [HALF - 0.45, 0.85, -2.5] }, // floor lamp
  { type: 'cylinder', radius: 0.2, halfHeight: 0.45, pos: [-HALF + 0.45, 0.45, -2.55] }, // plant
  { type: 'box', half: [0.27, 0.23, 0.47], pos: [-HALF + 0.33, 0.23, 1.2] }, // toy chest
  { type: 'box', half: [0.13, 0.22, 0.13], pos: [-HALF + 0.83, 0.22, 0.65] }, // two stacked blocks
  { type: 'box', half: [0.11, 0.09, 0.11], pos: [-HALF + 0.63, 0.09, 1.82] }, // a block
];

export const toyRoom = buildToyRoom();
