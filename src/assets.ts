/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright 2026 BRUNA GOODS LLC
 *
 * Begun from the IWSDK starter template, licensed under the MIT license found
 * in LICENSES/MIT-IWSDK.txt. BRUNA GOODS LLC's changes are licensed under the
 * Apache License 2.0 (LICENSE).
 */

import { AssetType, defineAssets } from '@iwsdk/core';
import {
  courseBall,
  courseBookStack,
  courseCrumb,
  courseFinishPad,
  courseGate,
  courseGoal,
  courseStartPad,
} from './scene-assets/course-kit.scene-asset.js';
import { courseDogBed, coursePlayMat } from './scene-assets/step-kit.scene-asset.js';
import { toyRoom } from './scene-assets/toy-room.scene-asset.js';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  // One named mesh per duck part. The duck system assembles them into a rig
  // from the pack's kinematics.json; placing this asset alone shows loose parts.
  'microduck-pollen-meshes': {
    url: publicAssetUrl('asset-packs/pollen-microduck/microduck.glb'),
    type: AssetType.GLTF,
    name: 'Microduck parts (Pollen Robotics, CC BY-NC-SA 4.0)',
    priority: 'background',
  },
  // The same parts decimated to 30% of their triangles (tools/decimate_glb.py).
  'microduck-pollen-meshes-lite': {
    url: publicAssetUrl('asset-packs/pollen-microduck/microduck-lite.glb'),
    type: AssetType.GLTF,
    name: 'Microduck parts, lite (Pollen Robotics, CC BY-NC-SA 4.0)',
    priority: 'lazy',
  },
  // Duck Lab XR course kit (src/scene-assets/course-kit.scene-asset.ts).
  'course-book-stack': courseBookStack,
  'course-gate': courseGate,
  'course-goal': courseGoal,
  'course-start-pad': courseStartPad,
  'course-finish-pad': courseFinishPad,
  'course-crumb': courseCrumb,
  'course-ball': courseBall,
  // Steps to climb (src/scene-assets/step-kit.scene-asset.ts).
  'course-play-mat': coursePlayMat,
  'course-dog-bed': courseDogBed,
  'toy-room': toyRoom,
  // Playground obstacles: real household objects scanned by Google Research
  // (CC BY 4.0, tools/assets/blender_jobs.py converted them).
  'scan-boat-shoe-tan': {
    url: publicAssetUrl('models/scanned/boat-shoe-tan.glb'),
    type: AssetType.GLTF,
    name: 'Boat shoe (tan) (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  'scan-ugg-boot': {
    url: publicAssetUrl('models/scanned/ugg-boot.glb'),
    type: AssetType.GLTF,
    name: 'Tall boot (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  'scan-timberland-shoe': {
    url: publicAssetUrl('models/scanned/timberland-shoe.glb'),
    type: AssetType.GLTF,
    name: 'Boat shoe (brown) (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  'scan-spinosaurus': {
    url: publicAssetUrl('models/scanned/spinosaurus.glb'),
    type: AssetType.GLTF,
    name: 'Spinosaurus toy (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  'scan-cereal-box': {
    url: publicAssetUrl('models/scanned/cereal-box.glb'),
    type: AssetType.GLTF,
    name: 'Cereal box (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  'scan-blocks-wagon': {
    url: publicAssetUrl('models/scanned/blocks-wagon.glb'),
    type: AssetType.GLTF,
    name: 'ABC blocks wagon (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  'scan-mug-blue': {
    url: publicAssetUrl('models/scanned/mug-blue.glb'),
    type: AssetType.GLTF,
    name: 'Blue mug (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  'scan-triceratops': {
    url: publicAssetUrl('models/scanned/triceratops.glb'),
    type: AssetType.GLTF,
    name: 'Triceratops toy (Google Scanned Objects, CC BY 4.0)',
    priority: 'lazy',
  },
  // Backyard set: Poly Haven models (CC0) and a lawn with a fence built from
  // Poly Haven textures (tools/assets/blender_jobs.py).
  'ph-picnic-table': {
    url: publicAssetUrl('models/polyhaven/wooden_picnic_table/wooden_picnic_table_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Picnic table (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-planter-box': {
    url: publicAssetUrl('models/polyhaven/planter_box_01/planter_box_01_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Planter box (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-potted-plant': {
    url: publicAssetUrl('models/polyhaven/potted_plant_02/potted_plant_02_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Potted plant (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-garden-gnome': {
    url: publicAssetUrl('models/polyhaven/garden_gnome/garden_gnome_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Garden gnome (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-watering-can': {
    url: publicAssetUrl('models/polyhaven/watering_can_metal_01/watering_can_metal_01_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Watering can (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-wooden-crate': {
    url: publicAssetUrl('models/polyhaven/wooden_crate_01/wooden_crate_01_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Wooden crate (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-rubber-duck': {
    url: publicAssetUrl('models/polyhaven/rubber_duck_toy/rubber_duck_toy_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Rubber duck toy (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-stone-01': {
    url: publicAssetUrl('models/polyhaven/stone_01/stone_01_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Stone (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-rock-07': {
    url: publicAssetUrl('models/polyhaven/rock_07/rock_07_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Rock (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-shrub-02': {
    url: publicAssetUrl('models/polyhaven/shrub_02/shrub_02_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Shrub (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-grass-clump': {
    url: publicAssetUrl('models/polyhaven/grass_medium_01/grass_medium_01_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Grass clump (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-football': {
    url: publicAssetUrl('models/polyhaven/football/football_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Football (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-bucket': {
    url: publicAssetUrl('models/polyhaven/wooden_bucket_01/wooden_bucket_01_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Wooden bucket (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'ph-bench': {
    url: publicAssetUrl('models/polyhaven/painted_wooden_bench/painted_wooden_bench_1k.gltf'),
    type: AssetType.GLTF,
    name: 'Painted bench (Poly Haven, CC0)',
    priority: 'lazy',
  },
  'backyard-set': {
    url: publicAssetUrl('models/backyard/backyard-set.glb'),
    type: AssetType.GLTF,
    name: 'Backyard lawn and fence (Poly Haven textures, CC0)',
    priority: 'lazy',
  },
  'run-panel': {
    url: publicAssetUrl('ui/run.uikitml'),
    type: AssetType.UIKitML,
    name: 'Duck Lab XR Scoreboard',
  },
  'lab-panel': {
    url: publicAssetUrl('ui/lab.uikitml'),
    type: AssetType.UIKitML,
    name: 'Microduck Lab Panel',
  },
  'menu-panel': {
    url: publicAssetUrl('ui/menu.uikitml'),
    type: AssetType.UIKitML,
    name: 'Duck Lab XR Menu',
  },
  'moves-panel': {
    url: publicAssetUrl('ui/moves.uikitml'),
    type: AssetType.UIKitML,
    name: 'Duck Lab XR Move Bar',
  },
  'robot-panel': {
    url: publicAssetUrl('ui/robot.uikitml'),
    type: AssetType.UIKitML,
    name: 'Pip Cam (robot panel)',
  },
});
