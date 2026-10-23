// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Switches nodes between VR and mixed reality. VrOnly nodes (the toy room)
 * show in VR and in the browser; MrOnly nodes (the shadow catcher on the real
 * floor) show only in mixed reality, i.e. an XR session whose environment
 * blend mode is not "opaque". What shows is what is solid: after a switch the
 * duck's physics is rebuilt (the toy room's walls and furniture leave it in
 * mixed reality, where the room scan takes over).
 */
import { createSystem, type Entity } from '@iwsdk/core';
import { DuckSystem } from '../duck/duck-system.js';
import { MrOnly, VrOnly } from './course-components.js';

export class VrOnlySystem extends createSystem({
  vrOnly: { required: [VrOnly] },
  mrOnly: { required: [MrOnly] },
}) {
  private mixedReality = false;
  /** Something was shown or hidden: rebuild the duck's course on the next frame. */
  private changed = false;

  init(): void {
    this.queries.vrOnly.subscribe('qualify', (entity: Entity) => {
      entity.object3D!.visible = !this.mixedReality;
      this.changed = true;
    });
    this.queries.mrOnly.subscribe('qualify', (entity: Entity) => {
      entity.object3D!.visible = this.mixedReality;
      this.changed = true;
    });
  }

  update(): void {
    const session = this.world.session;
    const mixedReality = !!session && session.environmentBlendMode !== 'opaque';
    if (this.changed) {
      this.changed = false;
      this.world.getSystem(DuckSystem)?.rebuildCourse();
    }
    if (mixedReality === this.mixedReality) {
      return;
    }
    this.mixedReality = mixedReality;
    this.changed = true;
    for (const entity of this.queries.vrOnly.entities) {
      entity.object3D!.visible = !mixedReality;
    }
    for (const entity of this.queries.mrOnly.entities) {
      entity.object3D!.visible = mixedReality;
    }
  }
}
