// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

import type { Material, Mesh, UIKitMLAsset, World } from '@iwsdk/core';

/**
 * Panels are never hidden by the real world. In mixed reality the room scan's
 * furniture writes depth (so the duck disappears behind the couch), and a
 * panel standing behind that furniture would be cut off. UI draws after
 * everything else and without the depth test instead; UIKit passes both
 * settings down to every element of the panel.
 */
export const PANEL_RENDER_ORDER = 1000;

export function keepPanelOnTop(asset: UIKitMLAsset | null | undefined): void {
  asset?.document?.rootElement?.setProperties({ depthTest: false, renderOrder: PANEL_RENDER_ORDER });
}

/**
 * The dot where a controller's ray meets a panel draws on top too. IWSDK draws
 * it after everything else but with the depth test, so wherever something that
 * writes depth stood between the eye and a panel (the scan's invisible
 * furniture in mixed reality, the toy room's in VR) the panel showed and its
 * dot did not. IWSDK keeps the dot private (MultiPointer.cursorVisual.cursor);
 * if a later version moves it, this does nothing.
 */
export function keepPointerDotsOnTop(world: World): void {
  for (const hand of ['left', 'right'] as const) {
    const pointer = world.input.xr.multiPointers[hand] as unknown as { cursorVisual?: { cursor?: Mesh } };
    const material = pointer.cursorVisual?.cursor?.material as Material | Material[] | undefined;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      m.depthTest = false;
      m.depthWrite = false;
    }
  }
}
