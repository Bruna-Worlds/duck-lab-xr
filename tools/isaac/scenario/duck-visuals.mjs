// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pip as the app draws him, for Isaac Sim's test cases: every part of Pollen's
 * MicroDuck model (public/asset-packs/pollen-microduck/microduck.glb: shells,
 * XL330 servos, bearings, boards) placed on its body as kinematics.json says,
 * in that body's own frame, with its colour. The pack's MJCF
 * (robot_allcollisions.xml) only has the collision shells; pack_physx.py
 * dresses the PhysX Pip and MuJoCo's ghost with these instead.
 *
 *   node tools/isaac/scenario/duck-visuals.mjs <export folder>   -> <folder>/visuals.json
 *
 * visuals.json: { bodies: { <body>: [ { mesh, color, points, indices, normals } ] } }, with
 * points (float32 xyz), indices (uint32 triangles) and normals (float32 xyz per triangle
 * corner, creased at 30 degrees as the app does) as base64.
 * The meshes are Pollen Robotics', CC BY-NC-SA 4.0 (the pack's ATTRIBUTION.md).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DUCK_PACK = join(root, 'public', 'asset-packs', 'pollen-microduck');
const CREASE = Math.cos((30 * Math.PI) / 180);

/** The GLB's meshes by file name: positions and triangle indices. */
function readGlb(file) {
  const b = readFileSync(file);
  const jsonLength = b.readUInt32LE(12);
  const gltf = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8;
  const view = (accessorIndex) => {
    const a = gltf.accessors[accessorIndex];
    const v = gltf.bufferViews[a.bufferView];
    const offset = binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const size = { VEC3: 3, SCALAR: 1 }[a.type];
    const count = a.count * size;
    const bytes = b.buffer.slice(b.byteOffset + offset, b.byteOffset + offset + count * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2));
    if (a.componentType === 5126) return new Float32Array(bytes);
    if (a.componentType === 5125) return new Uint32Array(bytes);
    if (a.componentType === 5123) return Uint32Array.from(new Uint16Array(bytes));
    throw new Error(`unsupported accessor type ${a.componentType}`);
  };
  const meshes = new Map();
  for (const node of gltf.nodes) {
    if (node.mesh === undefined) continue;
    const name = node.extras?.meshFile ?? node.name; // glTF node names lose their dots
    const primitive = gltf.meshes[node.mesh].primitives[0];
    meshes.set(name, { points: view(primitive.attributes.POSITION), indices: view(primitive.indices) });
  }
  return meshes;
}

/**
 * The triangles worth drawing and their normals per corner: the faces round a corner's point
 * that bend less than 30 degrees. Zero-area triangles (CAD slivers, two thirds of these meshes)
 * go: their normals would be zero, which the renderer turns into NaN and whole black frames.
 */
function creasedNormals(points, all) {
  const kept = [];
  for (let f = 0; f < all.length; f += 3) {
    const [a, b, c] = [all[f], all[f + 1], all[f + 2]];
    const ux = points[b * 3] - points[a * 3], uy = points[b * 3 + 1] - points[a * 3 + 1], uz = points[b * 3 + 2] - points[a * 3 + 2];
    const vx = points[c * 3] - points[a * 3], vy = points[c * 3 + 1] - points[a * 3 + 1], vz = points[c * 3 + 2] - points[a * 3 + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) > 1e-12) kept.push(a, b, c);
  }
  const indices = Uint32Array.from(kept);
  const faces = indices.length / 3;
  const area = new Float64Array(faces * 3);
  const unit = new Float64Array(faces * 3);
  // Corners at the same place share a key (STL exports repeat points).
  const key = (i) => `${Math.round(points[i * 3] * 1e6)},${Math.round(points[i * 3 + 1] * 1e6)},${Math.round(points[i * 3 + 2] * 1e6)}`;
  const around = new Map();
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]];
    const ux = points[b * 3] - points[a * 3], uy = points[b * 3 + 1] - points[a * 3 + 1], uz = points[b * 3 + 2] - points[a * 3 + 2];
    const vx = points[c * 3] - points[a * 3], vy = points[c * 3 + 1] - points[a * 3 + 1], vz = points[c * 3 + 2] - points[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    area.set([nx, ny, nz], f * 3);
    unit.set([nx / len, ny / len, nz / len], f * 3);
    for (const v of [a, b, c]) {
      const k = key(v);
      if (!around.has(k)) around.set(k, []);
      around.get(k).push(f);
    }
  }
  const normals = new Float32Array(faces * 9);
  for (let f = 0; f < faces; f++) {
    for (let corner = 0; corner < 3; corner++) {
      let x = 0, y = 0, z = 0;
      for (const g of around.get(key(indices[f * 3 + corner]))) {
        if (unit[g * 3] * unit[f * 3] + unit[g * 3 + 1] * unit[f * 3 + 1] + unit[g * 3 + 2] * unit[f * 3 + 2] < CREASE) continue;
        x += area[g * 3];
        y += area[g * 3 + 1];
        z += area[g * 3 + 2];
      }
      const len = Math.hypot(x, y, z);
      // The face itself is always in its own sum, and has an area: the sum is not zero, but be sure.
      if (len > 1e-20 && Number.isFinite(len)) normals.set([x / len, y / len, z / len], f * 9 + corner * 3);
      else normals.set([unit[f * 3], unit[f * 3 + 1], unit[f * 3 + 2]], f * 9 + corner * 3);
    }
  }
  return { indices, normals };
}

function rotate(q, x, y, z) {
  const [w, qx, qy, qz] = q;
  // v + 2w (q x v) + 2 q x (q x v)
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + w * tx + (qy * tz - qz * ty), y + w * ty + (qz * tx - qx * tz), z + w * tz + (qx * ty - qy * tx)];
}

const base64 = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64');

/** Writes <folder>/visuals.json from the asset pack; returns how many parts and triangles. */
export function writeDuckVisuals(folder, pack = DUCK_PACK) {
  const kinematics = JSON.parse(readFileSync(join(pack, 'kinematics.json'), 'utf8'));
  const meshes = readGlb(join(pack, 'microduck.glb'));
  const normalsOf = new Map();
  const bodies = {};
  let parts = 0;
  let triangles = 0;
  for (const body of kinematics.bodies) {
    const list = [];
    for (const geom of body.geoms) {
      if ((geom.type && geom.type !== 'mesh') || !meshes.has(geom.mesh)) continue;
      const source = meshes.get(geom.mesh);
      if (!normalsOf.has(geom.mesh)) normalsOf.set(geom.mesh, creasedNormals(source.points, source.indices));
      const q = geom.quat ?? [1, 0, 0, 0];
      const t = geom.pos ?? [0, 0, 0];
      const points = new Float32Array(source.points.length);
      for (let i = 0; i < points.length; i += 3) {
        const [x, y, z] = rotate(q, source.points[i], source.points[i + 1], source.points[i + 2]);
        points.set([x + t[0], y + t[1], z + t[2]], i);
      }
      const shaded = normalsOf.get(geom.mesh);
      const n0 = shaded.normals;
      const normals = new Float32Array(n0.length);
      for (let i = 0; i < n0.length; i += 3) normals.set(rotate(q, n0[i], n0[i + 1], n0[i + 2]), i);
      list.push({ mesh: geom.mesh, color: (geom.color ?? [0.8, 0.8, 0.8, 1]).slice(0, 3), points: base64(points), indices: base64(shaded.indices), normals: base64(normals) });
      parts++;
      triangles += shaded.indices.length / 3;
    }
    if (list.length) bodies[body.name] = list;
  }
  writeFileSync(join(folder, 'visuals.json'), JSON.stringify({ source: 'pollen-microduck microduck.glb + kinematics.json (CC BY-NC-SA 4.0, Pollen Robotics)', bodies }));
  return { bodies: Object.keys(bodies).length, parts, triangles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: node tools/isaac/scenario/duck-visuals.mjs <export folder>');
    process.exit(2);
  }
  const r = writeDuckVisuals(folder);
  console.log(`wrote ${join(folder, 'visuals.json')}: ${r.parts} parts on ${r.bodies} bodies, ${r.triangles} triangles`);
}
