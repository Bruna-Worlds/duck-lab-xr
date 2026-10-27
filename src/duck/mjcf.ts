// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns a pack's robot MJCF into a scene MuJoCo can compile in the worker
 * (workers have no DOMParser, so this runs on the main thread, once).
 * Mirrors Pollen's microduck-simulator: visual-only geoms are dropped (they
 * never collide, and every body has an explicit <inertial>), then a floor,
 * the 5 ms timestep and a STAND keyframe are added. Course pieces become
 * static geoms, and the ball becomes a free body after the robot so the
 * robot's free joint stays first in qpos.
 */
import { BALL_RADIUS, DEFAULT_POSE, JOINT_NAMES, TIMESTEP } from './duck-constants.js';
import {
  SCAN_GEOM,
  SCAN_HFIELD,
  TERRAIN_BASE,
  TERRAIN_CENTER_X,
  TERRAIN_CENTER_Y,
  TERRAIN_GEOM,
  TERRAIN_HALF_MAX,
  TERRAIN_HFIELD,
  TERRAIN_N,
  TERRAIN_SINK,
  TERRAIN_ZMAX,
} from './terrain-spec.js';

/** A static course collider in the stage's MuJoCo frame (Z up). */
export interface PhysicsCollider {
  type: 'box' | 'cylinder' | 'sphere';
  /** MuJoCo `size`: box half extents, cylinder [radius, half height], sphere [radius]. */
  size: number[];
  pos: [number, number, number];
  /** w, x, y, z */
  quat: [number, number, number, number];
  /** Sliding friction (MuJoCo default 1). */
  friction?: number;
  /** A step the duck may climb onto: solid to the sim, open to the autopilot's planner. */
  walkable?: boolean;
  /** What it belongs to (a course piece's asset id, a scanned thing's label), for test cases. */
  label?: string;
}

export interface PhysicsCourse {
  colliders: PhysicsCollider[];
  /** Ball start position in the stage's MuJoCo frame, or null for no ball. */
  ball: [number, number, number] | null;
}

export interface PhysicsMjcf {
  xml: string;
  /** Mesh files the remaining (collision) geoms reference. */
  meshFiles: string[];
}

/** Trunk height (m) of the STAND keyframe; the duck drops a few mm to the floor. */
const SPAWN_HEIGHT = 0.12;
const fmt = (v: number): string => (Math.abs(v) < 1e-9 ? '0' : v.toPrecision(6));

/**
 * @param source the pack's robot MJCF
 * @param course the course pieces and the ball
 * @param room static colliders from the real room (walls, furniture), stage frame
 * @param terrain whether to add the live height field (see terrain-spec.ts)
 */
export function buildPhysicsMjcf(
  source: string,
  course: PhysicsCourse = { colliders: [], ball: null },
  room: PhysicsCollider[] = [],
  terrain = true,
): PhysicsMjcf {
  const doc = new DOMParser().parseFromString(source, 'text/xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`MJCF parse error: ${parseError.textContent ?? ''}`);
  }
  const worldbody = doc.querySelector('worldbody');
  if (!worldbody) {
    throw new Error('MJCF has no <worldbody>');
  }

  for (const geom of Array.from(doc.querySelectorAll('geom[class="visual"]'))) {
    geom.remove();
  }
  const usedMeshes = new Set(
    Array.from(doc.querySelectorAll('geom[mesh]'), (g) => g.getAttribute('mesh')),
  );
  const meshFiles: string[] = [];
  for (const mesh of Array.from(doc.querySelectorAll('asset > mesh'))) {
    const file = mesh.getAttribute('file') ?? '';
    const name = mesh.getAttribute('name') ?? file.replace(/\.stl$/iu, '');
    if (usedMeshes.has(name)) {
      meshFiles.push(file);
    } else {
      mesh.remove();
    }
  }

  const element = (tag: string, attrs: Record<string, string>): Element => {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
    return el;
  };
  const root = doc.documentElement;
  root.appendChild(element('option', { timestep: String(TIMESTEP) }));
  worldbody.appendChild(
    element('geom', { name: 'floor', type: 'plane', size: '0 0 0.05', pos: '0 0 0' }),
  );

  const addStatic = (prefix: string, list: PhysicsCollider[]) => {
    list.forEach((c, i) => {
      const attrs: Record<string, string> = {
        name: `${prefix}_${i}`,
        type: c.type,
        size: c.size.map(fmt).join(' '),
        pos: c.pos.map(fmt).join(' '),
        quat: c.quat.map(fmt).join(' '),
      };
      if (c.friction !== undefined) {
        attrs.friction = `${fmt(c.friction)} 0.005 0.0001`;
      }
      worldbody.appendChild(element('geom', attrs));
    });
  };
  addStatic('course', course.colliders);
  addStatic('room', room);

  // The live terrain: two flat height fields raised at runtime, the depth
  // sensor's (which can be made soft) and the room scan's (always hard),
  // compiled at the largest extent so either can shrink to finer cells.
  if (terrain) {
    let asset = doc.querySelector('asset');
    if (!asset) {
      asset = element('asset', {});
      root.insertBefore(asset, worldbody);
    }
    for (const [hfield, geom] of [
      [TERRAIN_HFIELD, TERRAIN_GEOM],
      [SCAN_HFIELD, SCAN_GEOM],
    ]) {
      asset.appendChild(
        element('hfield', {
          name: hfield,
          nrow: String(TERRAIN_N),
          ncol: String(TERRAIN_N),
          size: `${TERRAIN_HALF_MAX} ${TERRAIN_HALF_MAX} ${TERRAIN_ZMAX} ${TERRAIN_BASE}`,
        }),
      );
      worldbody.appendChild(
        element('geom', {
          name: geom,
          type: 'hfield',
          hfield,
          pos: `${fmt(TERRAIN_CENTER_X)} ${fmt(TERRAIN_CENTER_Y)} ${fmt(-TERRAIN_SINK)}`,
        }),
      );
    }
  }

  // Pollen's beach-ball feel: light, bouncy (solref damping < 1), and the
  // rolling-friction terms (condim 6) bring it to rest.
  if (course.ball) {
    const ball = element('body', { name: 'ball', pos: course.ball.map(fmt).join(' ') });
    ball.appendChild(element('freejoint', { name: 'ball_freejoint' }));
    ball.appendChild(
      element('geom', {
        name: 'ball_geom',
        type: 'sphere',
        size: String(BALL_RADIUS),
        mass: '0.03',
        friction: '0.4 0.01 0.003',
        solref: '0.03 0.4',
        condim: '6',
      }),
    );
    worldbody.appendChild(ball);
  }

  // qpos covers every joint in document order: the duck's free joint, its 14
  // hinges (standing pose by name), then the ball's free joint.
  const poseByName = new Map<string, number>(
    JOINT_NAMES.map((name, i) => [name, DEFAULT_POSE[i]]),
  );
  const hinges = Array.from(
    doc.querySelectorAll('body > joint'),
    (joint) => poseByName.get(joint.getAttribute('name') ?? '') ?? 0,
  );
  const ballQpos = course.ball ? ` ${course.ball.map(fmt).join(' ')} 1 0 0 0` : '';
  const keyframe = element('keyframe', {});
  keyframe.appendChild(
    element('key', {
      name: 'STAND',
      qpos: `0 0 ${SPAWN_HEIGHT} 1 0 0 0 ${hinges.join(' ')}${ballQpos}`,
      ctrl: DEFAULT_POSE.join(' '),
    }),
  );
  root.appendChild(keyframe);

  return { xml: new XMLSerializer().serializeToString(doc), meshFiles };
}
