/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright 2026 BRUNA GOODS LLC
 *
 * Begun from the IWSDK starter template, licensed under the MIT license found
 * in LICENSES/MIT-IWSDK.txt. BRUNA GOODS LLC's changes are licensed under the
 * Apache License 2.0 (LICENSE).
 */

import { defineComponents } from '@iwsdk/core';
import {
  CourseBall,
  CourseCrumb,
  CourseFinish,
  CourseGate,
  CourseGoal,
  CoursePiece,
  MrOnly,
  VrOnly,
} from './course/course-components.js';
import { DuckStage } from './duck/duck-stage.js';
import { Playground } from './playgrounds/playground-components.js';

export default defineComponents([
  DuckStage,
  CourseCrumb,
  CourseGate,
  CourseGoal,
  CourseFinish,
  CourseBall,
  CoursePiece,
  VrOnly,
  MrOnly,
  Playground,
]);
