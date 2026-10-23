// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Playground metadata, carried by the level root of every playground scene
 * (public/playgrounds/*.iwsdk.scene.json). The playground system reads it
 * to know what is loaded; the HUD shows title and par; records key on id.
 * System-free: the editor imports this through src/components.ts.
 */
import { createComponent, Types } from '@iwsdk/core';

export const Playground = createComponent('Playground', {
  id: { type: Types.String, default: '' },
  title: { type: Types.String, default: '' },
  /** 'mr' (passthrough only), 'vr' (needs its own set) or 'both'. */
  mode: { type: Types.String, default: 'both' },
  /** Par time in seconds, for the time bonus and the third star. */
  par: { type: Types.Float32, default: 45, min: 5, step: 1 },
  author: { type: Types.String, default: '' },
});
