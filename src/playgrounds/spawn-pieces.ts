// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Puts course pieces on a stage at runtime, the way the level loader does
 * for authored scenes: a manifest asset under the stage, tagged with
 * CoursePiece and its course component, shadows on. Used by the editor's
 * palette and by custom playgrounds loaded from storage or a link.
 */
import { type Entity, Mesh, type Object3D, RayInteractable, type World } from '@iwsdk/core';
import { CourseBall, CourseCrumb, CourseFinish, CourseGate, CourseGoal, CoursePiece } from '../course/course-components.js';
import type { PieceSpec } from './custom.js';

/** What the palette offers, with the component each piece carries. */
export const PALETTE: { asset: string; label: string; comp?: PieceSpec['comp']; y?: number }[] = [
  { asset: 'course-crumb', label: 'Crumb', comp: { CourseCrumb: { points: 100 } } },
  { asset: 'course-gate', label: 'Gate', comp: { CourseGate: { halfWidth: 0.14, points: 200 } } },
  { asset: 'course-book-stack', label: 'Books' },
  { asset: 'course-ball', label: 'Ball', comp: { CourseBall: {} }, y: 0.05 },
  { asset: 'course-goal', label: 'Goal', comp: { CourseGoal: { halfDepth: 0.06, halfWidth: 0.14, height: 0.15, points: 500 } } },
  { asset: 'course-finish-pad', label: 'Finish', comp: { CourseFinish: { radius: 0.14, par: 60 } } },
  { asset: 'scan-boat-shoe-tan', label: 'Shoe' },
  { asset: 'scan-triceratops', label: 'Dino' },
];

const COMPONENTS = {
  CourseCrumb,
  CourseGate,
  CourseGoal,
  CourseFinish,
  CourseBall,
} as const;
type ComponentName = keyof typeof COMPONENTS;

/** Assets that must not be placed twice (shared glTF scenes); procedural pieces clone freely. */
const SINGLE_USE = /^(scan-|ph-)/;

export async function spawnPiece(world: World, stage: Entity, spec: PieceSpec): Promise<Entity | null> {
  if (SINGLE_USE.test(spec.asset) && stage.object3D) {
    let used = false;
    stage.object3D.traverse((o: Object3D) => {
      if (o.userData.iwsdkSceneAssetId === spec.asset) used = true;
    });
    if (used) return null;
  }
  const object = await world.assets.instantiate(spec.asset);
  object.userData.iwsdkSceneAssetId = spec.asset;
  object.name = spec.asset;
  const shadows = !/crumb|pad/.test(spec.asset);
  object.traverse((o: Object3D) => {
    if ((o as Mesh).isMesh) {
      o.castShadow = shadows;
      o.receiveShadow = true;
    }
  });
  object.position.set(spec.x, spec.y ?? 0, spec.z);
  object.rotation.set(0, ((spec.yaw ?? 0) * Math.PI) / 180, 0);
  const entity = world.createTransformEntity(object, { parent: stage });
  entity.addComponent(CoursePiece);
  entity.addComponent(RayInteractable);
  for (const [name, values] of Object.entries(spec.comp ?? {})) {
    const component = COMPONENTS[name as ComponentName];
    if (component) entity.addComponent(component, values);
  }
  return entity;
}

/** The pieces of a stage as specs (stage-local, degrees), for saving. */
export function describePieces(pieces: Iterable<Entity>): PieceSpec[] {
  const out: PieceSpec[] = [];
  for (const entity of pieces) {
    const object = entity.object3D;
    const asset = object?.userData.iwsdkSceneAssetId as string | undefined;
    if (!object || !asset) continue;
    const spec: PieceSpec = {
      asset,
      x: Math.round(object.position.x * 1000) / 1000,
      z: Math.round(object.position.z * 1000) / 1000,
    };
    if (object.position.y > 0.001) spec.y = Math.round(object.position.y * 1000) / 1000;
    const yaw = Math.round((object.rotation.y * 180) / Math.PI);
    if (yaw) spec.yaw = yaw;
    const comp: NonNullable<PieceSpec['comp']> = {};
    for (const [name, component] of Object.entries(COMPONENTS)) {
      if (!entity.hasComponent(component)) continue;
      const values: Record<string, number> = {};
      for (const field of Object.keys(component.schema as Record<string, unknown>)) {
        const value = entity.getValue(component, field as never);
        if (typeof value === 'number') values[field] = value;
      }
      comp[name] = values;
    }
    if (Object.keys(comp).length) spec.comp = comp;
    out.push(spec);
  }
  return out;
}
