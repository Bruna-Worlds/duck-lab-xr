// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the renderable duck from a pack: one Group per MuJoCo body (from
 * kinematics.json), meshes from the pack's glTF, and per-joint rotations so
 * a sim pose can be applied without allocating.
 *
 * Port of Pollen's microduck-simulator duck.js, with two changes for Quest:
 * meshes are merged per body and material (about 30 draw calls instead of
 * 70), and hard-edged normals are rebuilt here because the glTF ships
 * positions only.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { JOINT_NAMES } from './duck-constants.js';
import type { DuckMaterialSpec, DuckPack } from './duck-pack.js';

export interface DuckKinematics {
  bodies: Array<{
    name: string;
    parent: string | null;
    pos: [number, number, number];
    quat: [number, number, number, number]; // w, x, y, z
    joint?: {
      name: string;
      type?: string;
      axis: [number, number, number];
    } | null;
    geoms: Array<{
      type?: string;
      mesh?: string;
      pos?: [number, number, number];
      quat?: [number, number, number, number];
    }>;
  }>;
}

interface RigJoint {
  body: Object3D;
  axis: Vector3;
  rest: Quaternion;
}

export interface DuckRig {
  /** Parentless, identity transform: hand it to createTransformEntity. */
  root: Group;
  /** Beak hinge: rotate `pivot` about `axis` to open the beak (see setDuckJaw). */
  jaw: { pivot: Group; axis: Vector3 } | null;
  /** The free-joint body; takes the sim's trunk pose in MuJoCo (Z-up) units. */
  trunk: Object3D;
  /** Hinges in JOINT_NAMES order; null if the pack lacks one. */
  joints: Array<RigJoint | null>;
  drawCalls: number;
  triangles: number;
}

/** Edges sharper than this keep separate normals (Pollen uses 36 degrees). */
const CREASE_ANGLE = Math.PI / 5;

// The beak has no joint in the MJCF: like Pollen's simulator, the two jaw
// meshes get their own pivot on the physical hinge. The hinge point was
// fitted on jaw.stl's axle holes (mesh-local coordinates), and the hinge
// axis is the robot's left-right axis.
const JAW_MESHES = new Set(['jaw.stl', 'jaw_soft.stl']);
const JAW_HINGE_LOCAL = new Vector3(0, 0.00004, 0.0075);
/** Beak opening (rad) at setDuckJaw(rig, 1). */
export const JAW_MAX_OPEN = 0.32;

export function buildDuckRig(kin: DuckKinematics, gltf: GLTF, pack: DuckPack): DuckRig {
  const sources = new Map<string, BufferGeometry>();
  gltf.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) {
      return;
    }
    // glTF node names lose their dots, so the file name lives in extras.
    const name = (mesh.userData.meshFile as string | undefined) ?? mesh.name;
    if (!sources.has(name)) {
      sources.set(name, mesh.geometry);
    }
  });

  const root = new Group();
  root.name = 'microduck';
  const zUp = new Group();
  zUp.name = 'mujoco-frame';
  zUp.rotation.x = -Math.PI / 2; // MuJoCo is Z-up, three.js is Y-up
  root.add(zUp);

  const bodies = new Map<string, Group>();
  for (const body of kin.bodies) {
    const group = new Group();
    group.name = body.name;
    group.position.fromArray(body.pos);
    group.quaternion.set(body.quat[1], body.quat[2], body.quat[3], body.quat[0]);
    bodies.set(body.name, group);
  }
  for (const body of kin.bodies) {
    const group = bodies.get(body.name)!;
    const parent = body.parent ? bodies.get(body.parent) : undefined;
    (parent ?? zUp).add(group);
  }
  const trunk = bodies.get('trunk_base');
  if (!trunk) {
    throw new Error(`pack ${pack.id}: kinematics has no trunk_base body`);
  }
  root.updateWorldMatrix(true, true); // rest pose, for the jaw hinge axis

  const joints: Array<RigJoint | null> = JOINT_NAMES.map(() => null);
  for (const body of kin.bodies) {
    const joint = body.joint;
    if (!joint || (joint.type && joint.type !== 'hinge')) {
      continue;
    }
    const index = (JOINT_NAMES as readonly string[]).indexOf(joint.name);
    if (index >= 0) {
      const group = bodies.get(body.name)!;
      joints[index] = {
        body: group,
        axis: new Vector3().fromArray(joint.axis).normalize(),
        rest: group.quaternion.clone(),
      };
    }
  }

  const materials = new Map<string, MeshStandardMaterial>();
  const materialFor = (spec: DuckMaterialSpec): MeshStandardMaterial => {
    const key = `${spec.color.join(',')}|${spec.roughness}|${spec.metalness}`;
    let material = materials.get(key);
    if (!material) {
      material = new MeshStandardMaterial({
        roughness: spec.roughness,
        metalness: spec.metalness,
      });
      material.color.setRGB(spec.color[0], spec.color[1], spec.color[2]);
      materials.set(key, material);
    }
    return material;
  };

  const creased = new Map<string, CreasedMesh>();
  const seen = new Set<string>();
  const missing = new Set<string>();
  let drawCalls = 0;
  let triangles = 0;
  const geomMatrix = new Matrix4();
  const geomPos = new Vector3();
  const geomQuat = new Quaternion();
  const unitScale = new Vector3(1, 1, 1);

  let jaw: DuckRig['jaw'] = null;
  for (const body of kin.bodies) {
    // One bucket per material inside this body; the beak's parts go apart.
    const buckets = new Map<MeshStandardMaterial, Array<{ mesh: CreasedMesh; matrix: Matrix4 }>>();
    const jawBuckets = new Map<MeshStandardMaterial, Array<{ mesh: CreasedMesh; matrix: Matrix4 }>>();
    let hingeMatrix: Matrix4 | null = null;
    for (const geom of body.geoms) {
      if ((geom.type && geom.type !== 'mesh') || !geom.mesh) {
        continue;
      }
      // The MJCF lists a few parts twice (visual + collision copies).
      const key = `${body.name}|${geom.mesh}|${geom.pos}|${geom.quat}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const source = sources.get(geom.mesh);
      if (!source) {
        missing.add(geom.mesh);
        continue;
      }
      let mesh = creased.get(geom.mesh);
      if (!mesh) {
        mesh = creasedTriangles(source, Math.cos(CREASE_ANGLE));
        creased.set(geom.mesh, mesh);
      }
      geomPos.fromArray(geom.pos ?? [0, 0, 0]);
      const q = geom.quat ?? [1, 0, 0, 0];
      geomQuat.set(q[1], q[2], q[3], q[0]);
      const matrix = new Matrix4().copy(geomMatrix.compose(geomPos, geomQuat, unitScale));
      const material = materialFor(pack.materials[geom.mesh] ?? pack.fallbackMaterial);
      const isJaw = JAW_MESHES.has(geom.mesh);
      if (geom.mesh === 'jaw.stl') {
        hingeMatrix = matrix;
      }
      const target = isJaw ? jawBuckets : buckets;
      let bucket = target.get(material);
      if (!bucket) {
        bucket = [];
        target.set(material, bucket);
      }
      bucket.push({ mesh, matrix });
    }
    const group = bodies.get(body.name)!;
    const addMerged = (parent: Object3D, map: typeof buckets) => {
      for (const [material, parts] of map) {
        const geometry = mergeParts(parts);
        const mesh = new Mesh(geometry, material);
        mesh.name = `${body.name}:${material.uuid.slice(0, 6)}`;
        mesh.castShadow = true;
        parent.add(mesh);
        drawCalls++;
        triangles += geometry.getAttribute('position').count / 3;
      }
    };
    addMerged(group, buckets);
    if (jawBuckets.size > 0) {
      // Pivot on the hinge, in the body's frame; jaw parts are re-centred on it.
      const hinge = JAW_HINGE_LOCAL.clone().applyMatrix4(hingeMatrix ?? new Matrix4());
      const recentre = new Matrix4().makeTranslation(-hinge.x, -hinge.y, -hinge.z);
      for (const parts of jawBuckets.values()) {
        for (const part of parts) {
          part.matrix = new Matrix4().multiplyMatrices(recentre, part.matrix);
        }
      }
      const pivot = new Group();
      pivot.name = 'jaw-pivot';
      pivot.position.copy(hinge);
      group.add(pivot);
      addMerged(pivot, jawBuckets);
      // Robot left-right axis: -Z of the rig root, expressed in this body.
      const bodyRest = group.getWorldQuaternion(new Quaternion()).invert();
      jaw = { pivot, axis: new Vector3(0, 0, -1).applyQuaternion(bodyRest).normalize() };
    }
  }
  if (missing.size > 0) {
    console.warn(`[duck] pack ${pack.id} is missing meshes: ${[...missing].join(', ')}`);
  }

  return { root, jaw, trunk, joints, drawCalls, triangles };
}

const jointTurn = new Quaternion();

/**
 * Applies one sim pose (see POSE_SIZE): trunk position xyz, trunk quaternion
 * wxyz, then joint angles. Allocation-free.
 */
export function poseDuckRig(rig: DuckRig, pose: ArrayLike<number>): void {
  rig.trunk.position.set(pose[0], pose[1], pose[2]);
  rig.trunk.quaternion.set(pose[4], pose[5], pose[6], pose[3]);
  for (let j = 0; j < rig.joints.length; j++) {
    const joint = rig.joints[j];
    if (joint) {
      jointTurn.setFromAxisAngle(joint.axis, pose[7 + j]);
      joint.body.quaternion.copy(joint.rest).multiply(jointTurn);
    }
  }
}

const jawTurn = new Quaternion();

/** Opens the beak: 0 = closed, 1 = fully open. Allocation-free. */
export function setDuckJaw(rig: DuckRig, open: number): void {
  if (rig.jaw) {
    const amount = Math.min(1, Math.max(0, open));
    rig.jaw.pivot.quaternion.copy(jawTurn.setFromAxisAngle(rig.jaw.axis, JAW_MAX_OPEN * amount));
  }
}

interface CreasedMesh {
  /** Non-indexed triangle soup: 9 floats per triangle. */
  positions: Float32Array;
  normals: Float32Array;
}

/**
 * Per-corner normals that average only the neighbouring faces within the
 * crease angle, so flat panels stay flat and curved shells stay smooth.
 */
function creasedTriangles(geometry: BufferGeometry, cosCrease: number): CreasedMesh {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const vertexCount = position.count;
  const cornerCount = index ? index.count : vertexCount;
  const triCount = Math.floor(cornerCount / 3);

  const xyz = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    xyz[v * 3] = position.getX(v);
    xyz[v * 3 + 1] = position.getY(v);
    xyz[v * 3 + 2] = position.getZ(v);
  }
  const corners = new Uint32Array(triCount * 3);
  for (let c = 0; c < triCount * 3; c++) {
    corners[c] = index ? index.getX(c) : c;
  }

  const faceNormals = new Float32Array(triCount * 3);
  for (let f = 0; f < triCount; f++) {
    const a = corners[f * 3] * 3;
    const b = corners[f * 3 + 1] * 3;
    const c = corners[f * 3 + 2] * 3;
    const ux = xyz[b] - xyz[a];
    const uy = xyz[b + 1] - xyz[a + 1];
    const uz = xyz[b + 2] - xyz[a + 2];
    const vx = xyz[c] - xyz[a];
    const vy = xyz[c + 1] - xyz[a + 1];
    const vz = xyz[c + 2] - xyz[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    faceNormals[f * 3] = nx / len;
    faceNormals[f * 3 + 1] = ny / len;
    faceNormals[f * 3 + 2] = nz / len;
  }

  // Faces around each vertex, in compressed rows.
  const start = new Uint32Array(vertexCount + 1);
  for (let c = 0; c < corners.length; c++) {
    start[corners[c] + 1]++;
  }
  for (let v = 0; v < vertexCount; v++) {
    start[v + 1] += start[v];
  }
  const fill = start.slice(0, vertexCount);
  const faces = new Uint32Array(corners.length);
  for (let c = 0; c < corners.length; c++) {
    faces[fill[corners[c]]++] = Math.floor(c / 3);
  }

  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  for (let f = 0; f < triCount; f++) {
    const fx = faceNormals[f * 3];
    const fy = faceNormals[f * 3 + 1];
    const fz = faceNormals[f * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const v = corners[f * 3 + k];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let i = start[v]; i < start[v + 1]; i++) {
        const g = faces[i] * 3;
        const gx = faceNormals[g];
        const gy = faceNormals[g + 1];
        const gz = faceNormals[g + 2];
        if (fx * gx + fy * gy + fz * gz >= cosCrease) {
          sx += gx;
          sy += gy;
          sz += gz;
        }
      }
      const len = Math.hypot(sx, sy, sz);
      const o = f * 9 + k * 3;
      positions[o] = xyz[v * 3];
      positions[o + 1] = xyz[v * 3 + 1];
      positions[o + 2] = xyz[v * 3 + 2];
      normals[o] = len > 0 ? sx / len : fx;
      normals[o + 1] = len > 0 ? sy / len : fy;
      normals[o + 2] = len > 0 ? sz / len : fz;
    }
  }
  return { positions, normals };
}

const tmpPoint = new Vector3();
const normalMatrix = new Matrix3();

function mergeParts(parts: Array<{ mesh: CreasedMesh; matrix: Matrix4 }>): BufferGeometry {
  let floats = 0;
  for (const part of parts) {
    floats += part.mesh.positions.length;
  }
  const positions = new Float32Array(floats);
  const normals = new Float32Array(floats);
  let o = 0;
  for (const { mesh, matrix } of parts) {
    normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      tmpPoint.fromArray(mesh.positions, i).applyMatrix4(matrix).toArray(positions, o + i);
      tmpPoint.fromArray(mesh.normals, i).applyMatrix3(normalMatrix).normalize().toArray(normals, o + i);
    }
    o += mesh.positions.length;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}
