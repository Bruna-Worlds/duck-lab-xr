// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

// Duck Lab XR 3D replay: the pack's scene (floor, sensed terrain, course pieces)
// and up to two ducks replaying MuJoCo poses (shipped brain tinted orange,
// trained brain in its own colours). Pollen's Microduck meshes come from the
// app's asset pack (microduck.glb + kinematics.json), CC BY-NC-SA 4.0.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const JOINTS = [
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
];
const FRAME_DT = 0.04; // the server sends a pose every second control step (25 Hz)

let duckAssets = null;
/** The duck's model: the engine serves it at /duck/, the website at its asset pack folder. */
const DUCK_DIR = window.DUCK_LAB_SITE?.duck ?? '/duck/';
async function loadDuckAssets() {
  duckAssets ??= (async () => {
    const [gltf, kin] = await Promise.all([
      new GLTFLoader().loadAsync(`${DUCK_DIR}microduck.glb`),
      fetch(`${DUCK_DIR}kinematics.json`).then((r) => r.json()),
    ]);
    const sources = new Map();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const name = o.userData.meshFile ?? o.name;
      if (!sources.has(name)) {
        const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        g.computeVertexNormals();
        sources.set(name, g);
      }
    });
    return { sources, kin };
  })();
  return duckAssets;
}

/** One duck: a body tree in MuJoCo's frame (z up), posed from qpos (trunk 7 + 14 joints). */
function buildDuck({ sources, kin }, tint) {
  const root = new THREE.Group();
  const bodies = new Map();
  for (const b of kin.bodies) {
    const g = new THREE.Group();
    g.position.fromArray(b.pos);
    g.quaternion.set(b.quat[1], b.quat[2], b.quat[3], b.quat[0]);
    bodies.set(b.name, g);
  }
  for (const b of kin.bodies) (b.parent ? bodies.get(b.parent) : root).add(bodies.get(b.name));
  const materials = new Map();
  const seen = new Set();
  for (const b of kin.bodies) {
    for (const geom of b.geoms) {
      if ((geom.type && geom.type !== 'mesh') || !geom.mesh) continue;
      const key = `${b.name}|${geom.mesh}|${geom.pos}|${geom.quat}`;
      const source = sources.get(geom.mesh);
      if (seen.has(key) || !source) continue;
      seen.add(key);
      const c = geom.color ?? [0.8, 0.8, 0.8, 1];
      const ckey = c.join(',');
      let material = materials.get(ckey);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
        material.color.setRGB(c[0], c[1], c[2]);
        if (tint) material.color.lerp(new THREE.Color(tint), 0.55);
        materials.set(ckey, material);
      }
      const mesh = new THREE.Mesh(source, material);
      mesh.position.fromArray(geom.pos ?? [0, 0, 0]);
      const q = geom.quat ?? [1, 0, 0, 0];
      mesh.quaternion.set(q[1], q[2], q[3], q[0]);
      mesh.castShadow = true;
      bodies.get(b.name).add(mesh);
    }
  }
  const joints = JOINTS.map((name) => {
    const b = kin.bodies.find((x) => x.joint?.name === name);
    if (!b) return null;
    const body = bodies.get(b.name);
    return { body, axis: new THREE.Vector3().fromArray(b.joint.axis).normalize(), rest: body.quaternion.clone() };
  });
  const trunk = bodies.get('trunk_base');
  const turn = new THREE.Quaternion();
  return {
    root,
    pose(f) {
      trunk.position.set(f[0], f[1], f[2]);
      trunk.quaternion.set(f[4], f[5], f[6], f[3]);
      joints.forEach((j, i) => {
        if (!j) return;
        turn.setFromAxisAngle(j.axis, f[7 + i]);
        j.body.quaternion.copy(j.rest).multiply(turn);
      });
    },
  };
}

export class ReplayViewer {
  constructor(canvas, onTime) {
    this.canvas = canvas;
    this.onTime = onTime;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0f1020');
    this.camera = new THREE.PerspectiveCamera(40, 4 / 3, 0.01, 50);
    this.camera.position.set(-0.9, 0.9, 1.2);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0.3, 0.1, 0);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#2a2b4a', 1.6));
    const sun = new THREE.DirectionalLight('#fff4dc', 2.4);
    sun.position.set(1.5, 3, 1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -3;
    sun.shadow.camera.right = 3;
    sun.shadow.camera.top = 3;
    sun.shadow.camera.bottom = -3;
    this.scene.add(sun);
    // MuJoCo is z-up; everything from the pack goes under this group.
    this.world = new THREE.Group();
    this.world.rotation.x = -Math.PI / 2;
    this.scene.add(this.world);
    this.stage = new THREE.Group();
    this.world.add(this.stage);
    this.ducks = { ship: null, rel: null };
    this.frames = { ship: null, rel: null };
    this.time = 0;
    this.playing = false;
    this.last = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The pack's scene from Duck Lab XR's map data. */
  setScene(map) {
    this.stage.clear();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ color: '#1c1d36', roughness: 0.95 }));
    floor.receiveShadow = true;
    this.stage.add(floor);
    const grid = new THREE.GridHelper(12, 48, '#6fb7ff', '#2a2b4a');
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0.001;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    this.stage.add(grid);
    const pieceMaterial = new THREE.MeshStandardMaterial({ color: '#fff4dc', roughness: 0.7 });
    for (const p of map.pieces) {
      let geometry;
      if (p.type === 'box') geometry = new THREE.BoxGeometry(2 * p.size[0], 2 * p.size[1], 2 * p.size[2]);
      else if (p.type === 'cylinder' || p.type === 'capsule') geometry = new THREE.CylinderGeometry(p.size[0], p.size[0], 2 * (p.size[1] ?? 0.05), 20).rotateX(Math.PI / 2);
      else geometry = new THREE.SphereGeometry(p.size[0] ?? 0.03, 16, 12);
      const mesh = new THREE.Mesh(geometry, pieceMaterial);
      mesh.position.fromArray(p.pos);
      const q = p.quat.length === 4 ? p.quat : [1, 0, 0, 0];
      mesh.quaternion.set(q[1], q[2], q[3], q[0]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.stage.add(mesh);
    }
    if (map.terrain && map.terrain.max > 0.005) {
      const t = map.terrain;
      const bytes = Uint8Array.from(atob(t.data), (c) => c.charCodeAt(0));
      const heights = new Float32Array(bytes.buffer);
      const [rx, ry] = t.hfieldSize;
      const [px, py] = t.pos.length ? t.pos : [0, 0];
      const geometry = new THREE.PlaneGeometry(2 * rx, 2 * ry, t.size - 1, t.size - 1);
      const pos = geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const c = i % t.size;
        const r = t.size - 1 - Math.floor(i / t.size); // plane rows run from +y down
        pos.setZ(i, Math.max(0, heights[r * t.size + c]) * (t.hfieldSize[2] ?? 0.6)); // normalised elevation to metres
      }
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#6fb7ff', transparent: true, opacity: 0.55, roughness: 0.9 }));
      mesh.position.set(px, py, (t.pos[2] ?? 0) + 0.002);
      mesh.receiveShadow = true;
      this.stage.add(mesh);
    }
    this.controls.target.set(map.start.x, 0.1, -map.start.y);
    this.camera.position.set(map.start.x - 0.9, 0.85, -map.start.y + 1.1);
  }

  /** Frames from a replay (21 numbers each); `which` is 'ship' or 'rel'. */
  async setReplay(which, frames) {
    const assets = await loadDuckAssets();
    if (!this.ducks[which]) {
      this.ducks[which] = buildDuck(assets, which === 'ship' ? '#ff7a45' : null);
      this.world.add(this.ducks[which].root);
    }
    this.frames[which] = frames;
    this.ducks[which].root.visible = !!frames?.length;
    this.time = 0;
    this.playing = true;
    this.applyTime();
  }

  get duration() {
    return Math.max(this.frames.ship?.length ?? 0, this.frames.rel?.length ?? 0) * FRAME_DT;
  }

  seek(t) {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.applyTime();
  }

  applyTime() {
    for (const which of ['ship', 'rel']) {
      const frames = this.frames[which];
      const duck = this.ducks[which];
      if (!frames?.length || !duck) continue;
      const i = Math.min(frames.length - 1, Math.floor(this.time / FRAME_DT));
      duck.pose(frames[i]);
    }
    this.onTime?.(this.time, this.duration);
  }

  tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.playing && this.duration > 0) {
      this.time += dt;
      if (this.time > this.duration + 1) this.time = 0;
      this.applyTime();
    }
    this.resize();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
