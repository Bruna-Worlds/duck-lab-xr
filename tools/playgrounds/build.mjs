// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates the built-in playground scenes from the definitions below:
 *   public/scenes/playgrounds/<id>.iwsdk.scene.json   one IWSDK scene per playground
 *   public/scenes/playgrounds/index.json              what the HUD picker lists
 *   public/scenes/main.iwsdk.scene.json        the default playground
 * Pieces are stage-local: the course runs along +x from the start pad, z is
 * across. Usage: node tools/playgrounds/build.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';

const KEY_LIGHT = {
  id: 'key-light',
  name: 'Key Light',
  transform: { position: [-0.15, 3.1, 1.35], rotationDeg: [-66.47, -22.49, -41.3] },
  components: {
    'com.iwsdk.components.DirectionalLight': {
      color: [1, 0.95, 0.88, 1],
      intensity: 2.2,
      castShadow: true,
      shadowMapSize: '1024',
      shadowBias: -0.0004,
      shadowNormalBias: 0.01,
      shadowRadius: 3,
      shadowCameraNear: 0.5,
      shadowCameraFar: 8,
      shadowCameraSize: 3.6,
    },
  },
};

const PANELS = [
  {
    id: 'run-panel',
    name: 'Run Panel',
    content: { type: 'asset', asset: 'run-panel' },
    transform: { position: [0, 1.0, -2.1], rotationDeg: [-15, 0, 0], scale: 0.2 },
    components: { RayInteractable: {}, ScreenSpace: { top: '20px', right: '20px', width: '30vw', height: '46%' } },
  },
  {
    id: 'lab-panel',
    name: 'Lab Panel',
    content: { type: 'asset', asset: 'lab-panel' },
    transform: { position: [-1.75, 1.3, -0.7], rotationDeg: [0, 68, 0], scale: 0.18 },
    components: { RayInteractable: {}, ScreenSpace: { top: '20px', left: '20px', width: '28vw', height: '62%' } },
  },
];

const INDOOR_SKY = {
  'com.iwsdk.components.DomeGradient': {
    sky: [0.56, 0.68, 0.8, 1],
    equator: [0.82, 0.83, 0.8, 1],
    ground: [0.42, 0.4, 0.37, 1],
    intensity: 1,
  },
  'com.iwsdk.components.IBLGradient': {
    sky: [0.6902, 0.749, 0.7843, 1],
    equator: [0.6584, 0.7084, 0.7913, 1],
    ground: [0.807, 0.7758, 0.7454, 1],
    intensity: 0.75,
  },
};

const PARK_SKY = {
  'com.iwsdk.components.DomeTexture': { src: '/env/ballawley_park_1k.hdr', intensity: 1 },
  'com.iwsdk.components.IBLTexture': { src: '/env/ballawley_park_1k.hdr', intensity: 0.9 },
};

/** A course piece: [asset, x, z, yawDeg?, components?, extra?] */
const piece = (asset, x, z, yaw = 0, components = undefined, extra = {}) => ({ asset, x, z, yaw, components, ...extra });
const crumb = (x, z) => piece('course-crumb', x, z, 0, { CourseCrumb: { points: 100 } });
const gate = (x, z, yaw = 0) => piece('course-gate', x, z, yaw, { CourseGate: { halfWidth: 0.14, points: 200 } });
const goal = (x, z, yaw = 0) =>
  piece('course-goal', x, z, yaw, { CourseGoal: { halfDepth: 0.06, halfWidth: 0.14, height: 0.15, points: 500 } });
const ball = (x, z) => piece('course-ball', x, z, 0, { CourseBall: {} }, { y: 0.05 });
const finish = (x, z, par) => piece('course-finish-pad', x, z, 0, { CourseFinish: { radius: 0.14, par } });
const start = (x = 0, z = 0) => piece('course-start-pad', x, z);
/** A scanned or downloaded model with no colliders of its own (the physics derives them). */
const prop = (asset, x, z, yaw = 0) => piece(asset, x, z, yaw);

const PLAYGROUNDS = [
  {
    id: 'living-room-dash',
    title: 'Living Room Dash',
    mode: 'both',
    par: 45,
    blurb: 'Weave the books, pass the gates, kick the ball in the goal, reach the flag.',
    stage: [-1.2, 0, -1.3],
    sky: INDOOR_SKY,
    set: [{ id: 'toy-room', asset: 'toy-room', position: [0, 0, 0], receiveShadow: true }],
    pieces: [
      start(),
      crumb(0.28, 0),
      piece('course-book-stack', 0.46, -0.12, 10),
      crumb(0.6, 0.1),
      piece('course-book-stack', 0.76, 0.14, -15),
      crumb(0.9, -0.08),
      gate(1.06, 0),
      crumb(1.22, 0),
      ball(1.42, -0.1),
      goal(1.82, -0.14),
      crumb(1.6, 0.2),
      gate(2.06, 0.24),
      crumb(2.22, 0.22),
      finish(2.42, 0.2, 45),
    ],
  },
  {
    id: 'sneaker-alley',
    title: 'Sneaker Alley',
    mode: 'both',
    par: 55,
    blurb: 'Slalom the shoes, dodge the dinosaurs, score past the cereal box.',
    credits: 'Shoes and toys: Google Scanned Objects (CC BY 4.0)',
    stage: [-1.5, 0, -1.3],
    sky: INDOOR_SKY,
    set: [{ id: 'toy-room', asset: 'toy-room', position: [0, 0, 0], receiveShadow: true }],
    pieces: [
      start(),
      crumb(0.25, 0.05),
      prop('scan-boat-shoe-tan', 0.45, -0.16, 70),
      prop('scan-timberland-shoe', 0.74, 0.17, -60),
      crumb(0.6, -0.1),
      prop('scan-ugg-boot', 1.02, -0.24, 20),
      crumb(0.96, 0.14),
      gate(1.3, 0.02),
      prop('scan-triceratops', 1.55, -0.2, -30),
      crumb(1.5, 0.1),
      ball(1.78, 0),
      goal(2.18, -0.05),
      prop('scan-cereal-box', 2.05, 0.3, 15),
      prop('scan-mug-blue', 2.36, 0.26, 0),
      prop('scan-spinosaurus', 2.5, -0.24, 160),
      crumb(2.45, 0.02),
      prop('scan-blocks-wagon', 2.72, 0.2, -20),
      gate(2.86, -0.02),
      crumb(3.02, 0.1),
      finish(3.2, 0.03, 55),
    ],
  },
  {
    id: 'backyard',
    title: 'Backyard',
    mode: 'vr',
    par: 60,
    blurb: 'Under the picnic table, past the gnome, score by the crate, meet the rubber duck.',
    credits: 'Backyard models and textures: Poly Haven (CC0)',
    stage: [-1.5, 0, -1.6],
    sky: PARK_SKY,
    light: { intensity: 2.6, color: [1, 0.96, 0.9, 1] },
    set: [
      { id: 'backyard-set', asset: 'backyard-set', position: [0, 0, 0], receiveShadow: true },
      { id: 'bench', asset: 'ph-bench', position: [1.5, 0, -4.2], rotationDeg: [0, 180, 0] },
      { id: 'planter', asset: 'ph-planter-box', position: [-3.6, 0, -2.4], rotationDeg: [0, 15, 0] },
      { id: 'plant', asset: 'ph-potted-plant', position: [-2.6, 0, 0.9] },
      { id: 'shrub', asset: 'ph-shrub-02', position: [4.6, 0, -3.8] },
      { id: 'stone', asset: 'ph-stone-01', position: [-4.4, 0, 1.6] },
      { id: 'rock', asset: 'ph-rock-07', position: [3.8, 0, -5.0], rotationDeg: [0, 40, 0] },
      { id: 'bucket', asset: 'ph-bucket', position: [-2.4, 0, -3.4] },
      { id: 'grass', asset: 'ph-grass-clump', position: [2.8, 0, 1.8] },
    ],
    pieces: [
      start(),
      crumb(0.3, 0.05),
      prop('ph-picnic-table', 1.0, 0, 90),
      crumb(0.95, 0),
      gate(1.62, 0.05),
      prop('ph-garden-gnome', 1.86, -0.32, 20),
      prop('ph-watering-can', 1.9, 0.32, -30),
      crumb(2.02, 0.08),
      ball(2.28, 0),
      goal(2.68, -0.04),
      prop('ph-wooden-crate', 2.5, 0.38, 10),
      prop('ph-football', 2.78, 0.3, 0),
      prop('ph-rubber-duck', 3.0, -0.3, 200),
      gate(3.08, 0),
      crumb(3.24, 0.1),
      finish(3.42, 0.02, 60),
    ],
  },
  {
    id: 'free-roam',
    title: 'Your Room',
    mode: 'mr',
    par: 600, // no clock in free roam; the scene schema rejects 0
    blurb: 'No course: your room is the playground. Walls and furniture are solid, the floor is sensed live. Explore sends the duck roaming.',
    stage: [-1.2, 0, -1.3],
    sky: INDOOR_SKY,
    set: [{ id: 'toy-room', asset: 'toy-room', position: [0, 0, 0], receiveShadow: true }],
    pieces: [start()],
  },
];

function sceneFor(p) {
  const children = p.pieces.map((piece, i) => {
    const id = `${piece.asset.replace(/^course-|^scan-|^ph-/, '')}-${i + 1}`;
    const node = {
      id,
      name: id,
      content: { type: 'asset', asset: piece.asset, castShadow: !/crumb|pad/.test(piece.asset), receiveShadow: true },
      transform: { position: [piece.x, piece.y ?? 0, piece.z] },
    };
    if (piece.yaw) node.transform.rotationDeg = [0, piece.yaw, 0];
    node.components = { ...(piece.components ?? {}), CoursePiece: {}, RayInteractable: {} }; // the editor finds and grabs pieces by these
    return node;
  });
  const light = structuredClone(KEY_LIGHT);
  if (p.light) Object.assign(light.components['com.iwsdk.components.DirectionalLight'], p.light);
  children.push(light);
  const set = p.set.map((s) => ({
    id: s.id,
    name: s.id,
    content: { type: 'asset', asset: s.asset, castShadow: false, receiveShadow: s.receiveShadow ?? false },
    transform: { position: s.position, ...(s.rotationDeg ? { rotationDeg: s.rotationDeg } : {}) },
    components: { VrOnly: {} },
  }));
  return {
    version: 'iwsdk.scene.v1',
    units: 'meters',
    environment: { toneMapping: 'aces', exposure: 1.0, shadows: true, shadowMapType: 'pcf' },
    components: {
      ...p.sky,
      Playground: { id: p.id, title: p.title, mode: p.mode, par: p.par, author: 'Duck Lab XR' },
    },
    resources: {},
    authoring: {
      views: [
        {
          id: 'hero',
          role: 'hero',
          projection: 'perspective',
          position: [p.stage[0] + 1.3, 1.25, p.stage[2] + 1.9],
          target: [p.stage[0] + 1.5, 0.05, p.stage[2]],
          fov: 55,
        },
      ],
    },
    nodes: [
      ...set,
      {
        id: 'duck-stage',
        name: 'Duck Stage',
        transform: { position: p.stage },
        components: { DuckStage: {} },
        children,
      },
      ...PANELS,
    ],
  };
}

await mkdir('public/scenes/playgrounds', { recursive: true });
const index = [];
for (const p of PLAYGROUNDS) {
  const scene = sceneFor(p);
  const json = JSON.stringify(scene, null, 2) + '\n';
  await writeFile(`public/scenes/playgrounds/${p.id}.iwsdk.scene.json`, json);
  if (p.id === 'living-room-dash') await writeFile('public/scenes/main.iwsdk.scene.json', json);
  index.push({ id: p.id, title: p.title, mode: p.mode, par: p.par, blurb: p.blurb, ...(p.credits ? { credits: p.credits } : {}) });
  console.log(`${p.id}: ${scene.nodes.length} top-level nodes, ${p.pieces.length} pieces`);
}
await writeFile('public/scenes/playgrounds/index.json', JSON.stringify(index, null, 2) + '\n');
console.log(`index: ${index.map((p) => p.id).join(', ')}`);
