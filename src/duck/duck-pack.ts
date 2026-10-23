// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck asset packs: everything that gives the simulated duck its body — the
 * visual meshes, the render rig, and the physics model with its collision
 * meshes. The sim and renderer only talk to this interface, so the site can
 * swap Pollen's CC BY-NC-SA meshes for its own art without touching them.
 *
 * Pure data: no three.js, DOM or World imports.
 */

/** Colours are linear-space RGB. */
export interface DuckMaterialSpec {
  color: readonly [number, number, number];
  roughness: number;
  metalness: number;
}

export interface DuckPack {
  id: string;
  name: string;
  /** Manifest id of the glTF that holds one named mesh per part. */
  meshesAssetId: string;
  /** Folder under public/ with the rig, the MJCF and collision meshes. */
  folder: string;
  kinematicsFile: string;
  mjcfFile: string;
  /** Sub-folder holding the meshes the MJCF collides with. */
  collisionMeshFolder: string;
  /** One-line credit the app must show wherever the duck appears. */
  credit: string;
  materials: Readonly<Record<string, DuckMaterialSpec>>;
  fallbackMaterial: DuckMaterialSpec;
}

// Pollen's "classic" colourway (microduck-simulator variants.js).
const AMBER_YELLOW: DuckMaterialSpec = { color: [1.0, 0.413, 0.007], roughness: 0.4, metalness: 0 };
const BRIGHT_ORANGE: DuckMaterialSpec = { color: [1.0, 0.144, 0.008], roughness: 0.45, metalness: 0 };
const CLEAN_YELLOW: DuckMaterialSpec = { color: [1.0, 0.608, 0.021], roughness: 0.4, metalness: 0 };
const CREAM: DuckMaterialSpec = { color: [0.888, 0.86, 0.798], roughness: 0.35, metalness: 0 };
const WARM_GRAY: DuckMaterialSpec = { color: [0.328, 0.312, 0.283], roughness: 0.35, metalness: 0 };
const DARK: DuckMaterialSpec = { color: [0.012, 0.012, 0.014], roughness: 0.55, metalness: 0.3 };
const GRAY: DuckMaterialSpec = { color: [0.256, 0.256, 0.279], roughness: 0.5, metalness: 0.35 };
const LENS: DuckMaterialSpec = { color: [0.01, 0.012, 0.02], roughness: 0.05, metalness: 0 };

export const POLLEN_MICRODUCK_PACK: DuckPack = {
  id: 'pollen-microduck',
  name: 'Microduck (Pollen Robotics)',
  meshesAssetId: 'microduck-pollen-meshes',
  folder: 'asset-packs/pollen-microduck',
  kinematicsFile: 'kinematics.json',
  mjcfFile: 'robot_allcollisions.xml',
  collisionMeshFolder: 'meshes',
  credit: 'Microduck model and walking AI © Pollen Robotics (meshes CC BY-NC-SA 4.0)',
  materials: {
    'top_head_shell.stl': CREAM,
    'bottom_head_shell.stl': BRIGHT_ORANGE,
    'face_part.stl': WARM_GRAY,
    'noenoeil.stl': AMBER_YELLOW,
    'lens.stl': LENS,
    'm12_lens_holder.stl': DARK,
    'soft_mouth_top.stl': AMBER_YELLOW,
    'jaw.stl': BRIGHT_ORANGE,
    'jaw_soft.stl': AMBER_YELLOW,
    'trunk_base.stl': CREAM,
    'left_shell.stl': CREAM,
    'right_shell.stl': CREAM,
    'upper_leg_left.stl': CREAM,
    'upper_leg_right.stl': CREAM,
    'hip_l.stl': GRAY,
    'foot_left.stl': BRIGHT_ORANGE,
    'foot_right.stl': BRIGHT_ORANGE,
    'ankle_left.stl': BRIGHT_ORANGE,
    'ankle_right.stl': BRIGHT_ORANGE,
    'sole_left.stl': CLEAN_YELLOW,
    'sole_right.stl': CLEAN_YELLOW,
    'xl330.stl': DARK,
    'leg.stl': GRAY,
    'seeed_bearing__configuration_default.stl': DARK,
    'yaw2roll.stl': DARK,
    'bearing_roll.stl': DARK,
    'neck.stl': GRAY,
    'np_f970.stl': DARK,
    'pcb__raspberry_pi_zero_2_w.stl': DARK,
    'elec_rpi_robot_hat_pcb.stl': DARK,
    'banana_pcb_locker.stl': DARK,
    'speaker.stl': DARK,
    'upper_leg_rigidity_plate.stl': GRAY,
    'yaw_roll_motion.stl': GRAY,
    'neck_pitch.stl': GRAY,
    'motor_support.stl': GRAY,
    'power_support.stl': GRAY,
    'seeed_bearing__configuration__22x16x4.stl': GRAY,
  },
  fallbackMaterial: GRAY,
};

/** Same duck with every part decimated to 30% of its triangles, for Quest tests. */
export const POLLEN_MICRODUCK_LITE_PACK: DuckPack = {
  ...POLLEN_MICRODUCK_PACK,
  id: 'pollen-microduck-lite',
  name: 'Microduck lite (Pollen Robotics)',
  meshesAssetId: 'microduck-pollen-meshes-lite',
};

/** Picks the pack from the page URL: ?duck=lite selects the decimated meshes. */
export function packFromUrl(search: string): DuckPack {
  return new URLSearchParams(search).get('duck') === 'lite'
    ? POLLEN_MICRODUCK_LITE_PACK
    : POLLEN_MICRODUCK_PACK;
}

/** Page-relative URL of a file inside a pack (works under any base path). */
export function packFileUrl(pack: DuckPack, file: string): string {
  return `${import.meta.env.BASE_URL}${pack.folder}/${file}`;
}
