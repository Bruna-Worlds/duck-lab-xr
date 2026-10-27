// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Collects the course under the duck stage into the sim's terms: every
 * `userData.colliders` entry becomes a static MuJoCo geom, and the ball
 * node's position becomes the ball's start. Everything is relative to the
 * stage, in MuJoCo's frame (Z up): three.js (x, y, z) is MuJoCo (x, -z, y).
 */
import { Matrix4, type Object3D, Quaternion, Vector3 , Box3, type Mesh } from '@iwsdk/core';
import { BALL_RADIUS } from '../duck/duck-constants.js';
import type { PhysicsCollider, PhysicsCourse } from '../duck/mjcf.js';
import { COLLIDERS_KEY, type ColliderSpec } from './collider-spec.js';
import { OBSTACLE_ASSETS, type ObstacleShape, SET_COLLIDERS } from '../playgrounds/obstacle-assets.js';

/** Turns three.js vectors into MuJoCo ones: a +90 degree turn about x. */
const TO_MUJOCO = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
const FROM_MUJOCO = TO_MUJOCO.clone().invert();

export function toMujocoPosition(v: Vector3): [number, number, number] {
  return [v.x, -v.z, v.y];
}

/** Writes a MuJoCo-frame position into a three.js vector. */
export function fromMujocoPosition(x: number, y: number, z: number, out: Vector3): Vector3 {
  return out.set(x, z, -y);
}

/**
 * q (three.js frame) -> the same rotation in MuJoCo's frame. Used for a
 * piece's frame, this also relabels its local axes the Z-up way: local
 * (x, y, z) in MuJoCo is the piece's (x, -z, y). So box sizes become
 * (half x, half z, half y), and a cylinder along the piece's y already runs
 * along MuJoCo's local z.
 */
export function toMujocoQuaternion(q: Quaternion, out: Quaternion): Quaternion {
  return out.copy(TO_MUJOCO).multiply(q).multiply(FROM_MUJOCO);
}

/** MuJoCo w, x, y, z -> the same rotation in three.js's frame. */
export function fromMujocoQuaternion(
  w: number,
  x: number,
  y: number,
  z: number,
  out: Quaternion,
): Quaternion {
  return out.set(x, y, z, w).premultiply(FROM_MUJOCO).multiply(TO_MUJOCO);
}

const toArray4 = (q: Quaternion): [number, number, number, number] => [q.w, q.x, q.y, q.z];

const specLocal = new Matrix4();
const specWorld = new Matrix4();
const specPos = new Vector3();
const specQuat = new Quaternion();
const specScale = new Vector3();
const specMjQuat = new Quaternion();

/**
 * One collider spec (in some object's local three.js frame) as a MuJoCo
 * collider in the stage frame; `relative` is stageInverse * objectWorld.
 */
export function colliderFromSpec(spec: ColliderSpec, relative: Matrix4): PhysicsCollider {
  specLocal.compose(
    specPos.fromArray(spec.pos ?? [0, 0, 0]),
    specQuat.fromArray(spec.quat ?? [0, 0, 0, 1]),
    specScale.set(1, 1, 1),
  );
  specWorld.multiplyMatrices(relative, specLocal).decompose(specPos, specQuat, specScale);
  toMujocoQuaternion(specQuat, specMjQuat);
  let size: number[];
  if (spec.type === 'box') {
    const half = spec.half ?? [0.05, 0.05, 0.05];
    size = [half[0] * specScale.x, half[2] * specScale.z, half[1] * specScale.y];
  } else if (spec.type === 'cylinder') {
    size = [
      (spec.radius ?? 0.05) * Math.max(specScale.x, specScale.z),
      (spec.halfHeight ?? 0.05) * specScale.y,
    ];
  } else {
    size = [(spec.radius ?? 0.05) * Math.max(specScale.x, specScale.y, specScale.z)];
  }
  return {
    type: spec.type,
    size,
    pos: toMujocoPosition(specPos),
    quat: toArray4(specMjQuat),
    friction: spec.friction,
    ...(spec.walkable ? { walkable: true } : {}),
  };
}

/**
 * Everything the duck and the ball bump into, in the stage's frame: the
 * course pieces under the stage, and, given the level's root, whatever else
 * in the level is solid and showing (the VR room's walls and furniture, a
 * playground's set dressing; the VR room is hidden in mixed reality, where the
 * room scan takes over).
 */
export function gatherCourse(stage: Object3D, ball: Object3D | null, level: Object3D | null = null): PhysicsCourse {
  stage.updateWorldMatrix(true, true);
  const stageInverse = new Matrix4().copy(stage.matrixWorld).invert();
  const relative = new Matrix4();
  const pos = new Vector3();
  const quat = new Quaternion();
  const scale = new Vector3();
  const colliders: PhysicsCollider[] = [];

  const collect = (object: Object3D) => {
    let specs = (object.userData[COLLIDERS_KEY] ?? SET_COLLIDERS[object.userData.iwsdkSceneAssetId as string]) as
      | ColliderSpec[]
      | undefined;
    const shape = OBSTACLE_ASSETS[object.userData.iwsdkSceneAssetId as string];
    if (!Array.isArray(specs) && shape) {
      specs = autoColliders(object, shape);
    }
    if (!Array.isArray(specs) || object === stage) {
      return;
    }
    relative.multiplyMatrices(stageInverse, object.matrixWorld);
    for (const spec of specs) {
      colliders.push(colliderFromSpec(spec, relative));
    }
  };
  stage.traverse(collect);
  if (level) {
    level.updateWorldMatrix(true, true);
    const underStage = (object: Object3D) => {
      for (let o: Object3D | null = object; o; o = o.parent) if (o === stage) return true;
      return false;
    };
    level.traverseVisible((object) => {
      if (!underStage(object)) collect(object);
    });
  }

  let ballStart: [number, number, number] | null = null;
  if (ball) {
    relative.multiplyMatrices(stageInverse, ball.matrixWorld).decompose(pos, quat, scale);
    const [x, y, z] = toMujocoPosition(pos);
    ballStart = [x, y, Math.max(z, BALL_RADIUS + 0.002)];
  }
  return { colliders, ball: ballStart };
}

/**
 * Colliders for a placed model that has none of its own: its bounds in its
 * own frame become a shrunk box, or four leg posts at the corners (a table
 * the duck walks under).
 */
export function autoColliders(object: Object3D, shape: ObstacleShape): ColliderSpec[] {
  object.updateWorldMatrix(true, true);
  const inverse = new Matrix4().copy(object.matrixWorld).invert();
  const bounds = new Box3();
  const childBox = new Box3();
  const toLocal = new Matrix4();
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    toLocal.multiplyMatrices(inverse, mesh.matrixWorld);
    childBox.copy(mesh.geometry.boundingBox).applyMatrix4(toLocal);
    bounds.union(childBox);
  });
  if (bounds.isEmpty()) return [];
  const size = new Vector3();
  const centre = new Vector3();
  bounds.getSize(size);
  bounds.getCenter(centre);
  if (shape.kind === 'legs') {
    const radius = shape.legRadius ?? 0.04;
    const specs: ColliderSpec[] = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        specs.push({
          type: 'cylinder',
          radius,
          halfHeight: size.y / 2,
          pos: [centre.x + sx * (size.x / 2 - radius * 1.5), centre.y, centre.z + sz * (size.z / 2 - radius * 1.5)],
        });
      }
    }
    return specs;
  }
  const shrink = shape.shrink ?? 0.9;
  return [
    {
      type: 'box',
      half: [(size.x / 2) * shrink, size.y / 2, (size.z / 2) * shrink],
      pos: [centre.x, centre.y, centre.z],
    },
  ];
}
