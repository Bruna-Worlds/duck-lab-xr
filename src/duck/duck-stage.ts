// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

import { createComponent } from '@iwsdk/core';

/**
 * Marks the scene node where the simulated duck lives. The node's position
 * and heading are the sim's origin: put it on the floor. The duck spawns
 * there facing the node's +X axis.
 */
export const DuckStage = createComponent('DuckStage', {});
