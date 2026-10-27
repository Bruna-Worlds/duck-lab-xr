// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Steps for the climbing playground: low things a duck meets on a real floor.
 * A 2 cm foam play mat and a 3 cm dog bed cushion (the edge the step-up brain
 * trains for). Both sit on y = 0, centred, the long side along +x; their
 * colliders are `walkable` so the autopilot plans across them instead of round.
 */
import { CircleGeometry, Group, Matrix4, Mesh } from '@iwsdk/core';
import { bevelBox } from './lib/hardsurface.js';
import { at, type ColoredPart, mergeColored, toyMaterial, withColliders } from './lib/kit.js';

export const PLAY_MAT_HEIGHT = 0.02;
export const DOG_BED_HEIGHT = 0.03;

const foam = toyMaterial(0xffffff, 0.85, 0, { vertexColors: true });
const fleece = toyMaterial(0xffffff, 0.95, 0, { vertexColors: true });

/** A slab with rounded corners seen from above: x by z, h tall, bottom on y = 0. */
function slab(x: number, z: number, h: number, bevel: number, corner: number): ReturnType<typeof bevelBox> {
  const g = bevelBox(x, z, h, bevel, corner, 6);
  g.rotateX(-Math.PI / 2);
  g.translate(0, h / 2, 0);
  return g;
}

function named(name: string, mesh: Mesh): Mesh {
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

/** Four interlocking foam tiles, 50 x 60 cm, 2 cm thick. */
function buildPlayMat(): Group {
  const root = new Group();
  root.name = 'PlayMat';
  const colors = [0xe94f4f, 0x3f8fd8, 0xf2c230, 0x45b36b];
  const tile = [0.248, 0.298];
  const parts: ColoredPart[] = [];
  let k = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push({ geometry: slab(tile[0], tile[1], PLAY_MAT_HEIGHT, 0.003, 0.004), matrix: at((sx * 0.25) / 2, 0, (sz * 0.3) / 2), color: colors[k++] });
    }
  }
  // The tiles' puzzle teeth along the seams, in the neighbour's colour.
  for (let i = -2; i <= 2; i++) {
    parts.push({ geometry: slab(0.03, 0.03, PLAY_MAT_HEIGHT - 0.001, 0.003, 0.012), matrix: at(0, 0, i * 0.055 + 0.025), color: colors[(i + 4) % 4] });
  }
  root.add(named('Tiles', new Mesh(mergeColored(parts), foam)));
  return withColliders(root, [{ type: 'box', half: [0.25, PLAY_MAT_HEIGHT / 2, 0.3], pos: [0, PLAY_MAT_HEIGHT / 2, 0], walkable: true }]);
}

/** A flat dog bed cushion, 60 x 45 cm, 3 cm at the edge, with a sleeping panel and a paw print. */
function buildDogBed(): Group {
  const root = new Group();
  root.name = 'DogBed';
  const top = DOG_BED_HEIGHT;
  const flat = (y: number, x = 0, z = 0) => new Matrix4().makeTranslation(x, y, z).multiply(new Matrix4().makeRotationX(-Math.PI / 2));
  const cushion: ColoredPart[] = [
    { geometry: slab(0.6, 0.45, top, 0.011, 0.09), color: 0x8a6a5c },
    // Piping round the top edge.
    { geometry: slab(0.585, 0.435, 0.004, 0.0015, 0.083), matrix: at(0, top - 0.006, 0), color: 0xe8dccb },
  ];
  root.add(named('Cushion', new Mesh(mergeColored(cushion), fleece)));
  const panel: ColoredPart[] = [{ geometry: slab(0.48, 0.33, 0.002, 0.0008, 0.06), matrix: at(0, top - 0.0005, 0), color: 0xd9c3a5 }];
  // A paw print on the panel: a pad and four toes.
  const paw = 0x8a6a5c;
  panel.push({ geometry: new CircleGeometry(0.03, 24), matrix: flat(top + 0.0016, 0.1, 0.06).multiply(new Matrix4().makeScale(1.15, 0.9, 1)), color: paw });
  for (const [dx, dz] of [[-0.035, -0.035], [-0.012, -0.05], [0.014, -0.05], [0.037, -0.035]] as const) {
    panel.push({ geometry: new CircleGeometry(0.012, 16), matrix: flat(top + 0.0016, 0.1 + dx, 0.06 + dz), color: paw });
  }
  const sleep = new Mesh(mergeColored(panel), fleece);
  sleep.name = 'Panel';
  sleep.receiveShadow = true;
  root.add(sleep);
  return withColliders(root, [{ type: 'box', half: [0.3, top / 2, 0.225], pos: [0, top / 2, 0], walkable: true }]);
}

export const coursePlayMat = buildPlayMat();
export const courseDogBed = buildDogBed();
