// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Microduck's control contract, shared by the sim worker and the main
 * thread. Values come from Pollen's microduck-simulator (constants.js), which
 * matches microduck_rl's infer_policy.py.
 */

/** Actuator order used by the policies (and by the MJCF's actuator list). */
export const JOINT_NAMES = [
  'left_hip_yaw',
  'left_hip_roll',
  'left_hip_pitch',
  'left_knee',
  'left_ankle',
  'neck_pitch',
  'head_pitch',
  'head_yaw',
  'head_roll',
  'right_hip_yaw',
  'right_hip_roll',
  'right_hip_pitch',
  'right_knee',
  'right_ankle',
] as const;

/** Standing pose; policy actions are offsets from it. */
export const DEFAULT_POSE: readonly number[] = [
  0, -0.08726646259971647, -0.457924, -0.00494, 0.452984, 0.3490658503988659,
  0.3490658503988659, 0, 0, 0, 0.08726646259971647, 0.457924, 0.00494,
  -0.452984,
];

export const NUM_JOINTS = 14;
export const OBS_SIZE = 61;
export const CMD_SIZE = 13;

/** Physics step (200 Hz) and control decimation (policy at 50 Hz). */
export const TIMESTEP = 0.005;
export const DECIMATION = 4;
export const CTRL_DT = TIMESTEP * DECIMATION;

/** Twist limits from the official runtime's stick mapping. */
export const VEL_FWD = 0.25; // m/s
export const VEL_BACK = 0.2; // m/s
export const VEL_ANG = 1.0; // rad/s

/**
 * One pose sample sent from the sim to the renderer, all in the MuJoCo frame
 * (Z up) of the duck stage: trunk position xyz, trunk quaternion wxyz, the
 * 14 joint angles in JOINT_NAMES order, then the ball's position xyz and
 * quaternion wxyz.
 */
export const DUCK_POSE_SIZE = 7 + NUM_JOINTS;
export const BALL_OFFSET = DUCK_POSE_SIZE;
export const POSE_SIZE = DUCK_POSE_SIZE + 7;

/** Pollen's kickable ball (microduck-simulator constants.js). */
export const BALL_RADIUS = 0.05;

/** Policies the sim loads; walk and stand first, the moves in the background. */
export const POLICY_FILES = {
  walk: 'walk.onnx',
  stand: 'stand.onnx',
  sitstand: 'sitstand.onnx',
  roll: 'roll.onnx',
  kickL: 'kick-left.onnx',
  kickR: 'kick-right.onnx',
  peck: 'peck.onnx',
} as const;
export type PolicyName = keyof typeof POLICY_FILES;

/** One-click moves ("superpowers") the player can fire. */
export type MoveName = 'kickL' | 'kickR' | 'roll' | 'sit' | 'stand' | 'peck' | 'motion';

/** What the sim is doing, as reported to the game. */
export type DuckMode =
  | 'walk'
  | 'kick'
  | 'roll'
  | 'sitting'
  | 'sitting-down'
  | 'standing-up'
  | 'peck'
  | 'motion'
  | 'fallen'
  | 'getting-up'
  | 'paused';

/** Move timings, from Pollen's runtime (microduck-simulator game.js). */
export const KICK_STEPS = 25; // 0.5 s kick window
export const POST_KICK_LOCK_STEPS = 20; // 0.4 s of zero commands after a kick
export const ROLL_MIN_STEPS = 40; // a roll can't end before 0.8 s
export const ROLL_MAX_STEPS = 150; // official roll hard window, 3 s
export const SIT_HANDOVER_STEPS = 40; // hold a stand under sitstand for 0.8 s
export const STAND_HANDBACK_STEPS = 100; // stand up for 2 s before walking
export const PECK_PERIOD_S = 4.0; // ground pick phase clock period
export const PECK_END_PHASE = 0.7; // the gesture ends at 70% of the period

/** Head command limits (radians) and the runtime's head smoothing. */
export const HEAD_ALPHA = 0.2;

/**
 * Robot telemetry for the robot panel's details view: one record of
 * TELEMETRY_STRIDE floats per control step (50 Hz), sent in small batches
 * while the view is open. Offsets into one record:
 */
export const TEL = {
  gyro: 0, // 3, rad/s (trunk IMU)
  gravity: 3, // 3, projected gravity (z -1 upright)
  accel: 6, // 3, m/s^2 (trunk IMU)
  q: 9, // 14, joint angles (rad), JOINT_NAMES order
  target: 23, // 14, servo targets (rad)
  qvel: 37, // 14, joint speeds (rad/s)
  force: 51, // 14, servo torque as a fraction of its limit (-1..1)
  action: 65, // 14, raw policy output (offsets from the standing pose)
  cmd: 79, // 3, twist command fed to the policy (vx, vy, wz)
  feet: 82, // 2, contact force on the left and right foot (N)
  infer: 84, // 1, policy inference time (ms)
  policy: 85, // 1, index into TELEMETRY_POLICIES of the policy that drove the step
} as const;
export const TELEMETRY_STRIDE = 86;
/** Policies in telemetry order (the batch says which one drove it). */
export const TELEMETRY_POLICIES: readonly (PolicyName | 'none')[] = [
  'none',
  'walk',
  'stand',
  'sitstand',
  'roll',
  'kickL',
  'kickR',
  'peck',
];
