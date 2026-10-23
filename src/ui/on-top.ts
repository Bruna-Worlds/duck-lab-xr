// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

import type { UIKitMLAsset } from '@iwsdk/core';

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
