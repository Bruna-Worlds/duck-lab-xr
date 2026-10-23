// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Grounds the duck and the course. In mixed reality a shadow-only floor
 * under the course lets the key light's shadows fall on the real floor; in
 * both modes a soft contact shadow follows the duck, so it never looks
 * pasted on.
 */
import {
  CanvasTexture,
  createSystem,
  type Entity,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  ShadowMaterial,
} from '@iwsdk/core';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';
import { MrOnly } from './course-components.js';
import { FLOOR_LAYERS } from './floor-layers.js';

/** The catcher spans the course: 2.4 m long, with a margin all round. */
const CATCHER_SIZE: [number, number] = [3.4, 1.3];
const CATCHER_CENTRE: [number, number] = [1.22, 0]; // stage-local x, z
/** Dev check: ?catcher=solid draws the catcher as a grey plane (shadows show in any light); ?catcher=dark as plain transparent black. */
const CATCHER_MODE = import.meta.env.DEV ? new URLSearchParams(location.search).get('catcher') : null;
const BLOB_SIZE: [number, number] = [0.3, 0.22];
const BLOB_OPACITY = 0.5;

function blobTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.6)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

export class GroundingSystem extends createSystem({
  stages: { required: [DuckStage] },
}) {
  private blob: Mesh | null = null;
  private blobMaterial: MeshBasicMaterial | null = null;
  private duck: DuckSystem | undefined;
  private stageEntity: Entity | null = null;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    for (const stage of this.queries.stages.entities) {
      this.build(stage);
    }
    this.queries.stages.subscribe('qualify', (stage) => this.build(stage));
    this.queries.stages.subscribe('disqualify', (stage) => {
      // The level took the catcher and the blob with it; build again for the next stage.
      if (stage === this.stageEntity) {
        this.blob = null;
        this.blobMaterial = null;
        this.stageEntity = null;
      }
    });
  }

  update(): void {
    const duck = this.duck;
    const blob = this.blob;
    if (!duck || !blob || !this.blobMaterial) {
      return;
    }
    const visible = duck.hasPose && !!duck.rig?.root.visible;
    blob.visible = visible;
    if (!visible) {
      return;
    }
    const p = duck.pose;
    // MuJoCo (x, y) -> stage-local three (x, -y); heading about +Y.
    blob.position.set(p[0], FLOOR_LAYERS.shadow, -p[1]);
    blob.rotation.y = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
    // Fade as the trunk drops (a sit or a fall flattens the duck's footprint).
    const height = p[2];
    this.blobMaterial.opacity = BLOB_OPACITY * Math.min(1, Math.max(0.35, height / 0.11));
  }

  private build(stage: Entity): void {
    if (this.stageEntity === stage) {
      return;
    }
    this.stageEntity = stage;
    const catcher = new Mesh(
      new PlaneGeometry(CATCHER_SIZE[0], CATCHER_SIZE[1]).rotateX(-Math.PI / 2),
      CATCHER_MODE === 'solid'
        ? new MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 })
        : CATCHER_MODE === 'dark'
          ? new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 })
          : CATCHER_MODE === 'magenta'
            ? new ShadowMaterial({ color: 0xff00ff, opacity: 1 })
          : new ShadowMaterial({ opacity: 0.6 }),
    );
    catcher.name = 'shadow-catcher';
    catcher.receiveShadow = true;
    catcher.position.set(CATCHER_CENTRE[0], 0.0005, CATCHER_CENTRE[1]);
    const catcherEntity = this.world.createTransformEntity(catcher, { parent: stage });
    catcherEntity.addComponent(MrOnly);

    this.blobMaterial = new MeshBasicMaterial({
      map: blobTexture(),
      transparent: true,
      depthWrite: false,
      opacity: BLOB_OPACITY,
    });
    const blob = new Mesh(
      new PlaneGeometry(BLOB_SIZE[0], BLOB_SIZE[1]).rotateX(-Math.PI / 2),
      this.blobMaterial,
    );
    blob.name = 'duck-contact-shadow';
    blob.renderOrder = 1;
    blob.visible = false;
    this.world.createTransformEntity(blob, { parent: stage });
    this.blob = blob;
  }
}
