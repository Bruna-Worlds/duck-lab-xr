// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Course components. Course pieces are scene nodes under the duck stage, so
 * the whole course moves with the stage when the player places it on their
 * floor. Solid pieces need no component: their scene asset carries its
 * colliders (see collider-spec.ts). These components mark the pieces the run
 * logic watches.
 */
import { createComponent, Types } from '@iwsdk/core';

/** A bread crumb: walk over it, or peck it for a bigger bonus. */
export const CourseCrumb = createComponent('CourseCrumb', {
  points: { type: Types.Int32, default: 100, min: 0, step: 10 },
});

/** A gate the duck walks through (along the gate's local x axis). */
export const CourseGate = createComponent('CourseGate', {
  /** Half the opening between the posts, metres. */
  halfWidth: { type: Types.Float32, default: 0.14, min: 0.05, step: 0.01 },
  points: { type: Types.Int32, default: 200, min: 0, step: 10 },
});

/** A goal: the ball scores when it is inside this box (node's local frame). */
export const CourseGoal = createComponent('CourseGoal', {
  halfDepth: { type: Types.Float32, default: 0.07, min: 0.02, step: 0.01 },
  halfWidth: { type: Types.Float32, default: 0.14, min: 0.02, step: 0.01 },
  height: { type: Types.Float32, default: 0.14, min: 0.02, step: 0.01 },
  points: { type: Types.Int32, default: 500, min: 0, step: 10 },
});

/** The finish pad: the run ends when the duck reaches it. */
export const CourseFinish = createComponent('CourseFinish', {
  radius: { type: Types.Float32, default: 0.14, min: 0.05, step: 0.01 },
  /** Par time in seconds, for the time bonus and the third star. */
  par: { type: Types.Float32, default: 60, min: 5, step: 1 },
});

/** The kickable ball: its node sets the start position; the sim drives it. */
export const CourseBall = createComponent('CourseBall', {});

/** Every placed course piece (so the editor can find, move and save them). */
export const CoursePiece = createComponent('CoursePiece', {});

/** Shown in VR and in the browser; hidden in mixed reality (passthrough). */
export const VrOnly = createComponent('VrOnly', {});

/** Shown only in mixed reality, e.g. the shadow catcher on the real floor. */
export const MrOnly = createComponent('MrOnly', {});
