// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Game feedback effects, all pooled and allocation-free per frame: additive
 * sparkles, tumbling confetti, floating text ("+100", "GATE!") and ring
 * flashes. Effects live under the duck stage, so callers pass stage-local
 * three.js positions (see toStage() for MuJoCo-frame positions).
 */
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  createSystem,
  DoubleSide,
  DynamicDrawUsage,
  type Entity,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { DuckStage } from '../duck/duck-stage.js';

const SPARKS = 160;
const CONFETTI = 240;
const TEXTS = 10;
const RINGS = 3;
const CONFETTI_COLORS = [0xffd166, 0xef476f, 0x06d6a0, 0x118ab2, 0xff9f1c, 0xf4f1ea, 0x8e6bd9];

interface Particle {
  alive: boolean;
  age: number;
  life: number;
  pos: Vector3;
  vel: Vector3;
  size: number;
  spin: Vector3;
  rot: Quaternion;
}

interface FloatingText {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  life: number;
  base: Vector3;
  alive: boolean;
}

interface RingFlash {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  alive: boolean;
}

const makeParticle = (): Particle => ({
  alive: false,
  age: 0,
  life: 1,
  pos: new Vector3(),
  vel: new Vector3(),
  size: 0.01,
  spin: new Vector3(),
  rot: new Quaternion(),
});

function sparkTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class FxSystem extends createSystem({
  stages: { required: [DuckStage] },
}) {
  private root: Group | null = null;
  private stageEntity: Entity | null = null;
  private sparkMesh!: InstancedMesh;
  private confettiMesh!: InstancedMesh;
  private sparks: Particle[] = [];
  private confetti: Particle[] = [];
  private texts: FloatingText[] = [];
  private rings: RingFlash[] = [];
  private textures = new Map<string, { texture: CanvasTexture; aspect: number }>();
  private m!: Matrix4;
  private q!: Quaternion;
  private camQ!: Quaternion;
  private s!: Vector3;
  private v!: Vector3;
  private c!: Color;
  private gravity!: Vector3;

  init(): void {
    this.m = new Matrix4();
    this.q = new Quaternion();
    this.camQ = new Quaternion();
    this.s = new Vector3();
    this.v = new Vector3();
    this.c = new Color();
    this.gravity = new Vector3(0, -1.6, 0);
    for (const stage of this.queries.stages.entities) this.build(stage);
    this.queries.stages.subscribe('qualify', (stage) => this.build(stage));
    this.queries.stages.subscribe('disqualify', (stage) => {
      if (stage === this.stageEntity) this.reset();
    });
  }

  /** MuJoCo-frame (stage) position -> stage-local three.js position. */
  toStage(x: number, y: number, z: number, out: Vector3): Vector3 {
    return out.set(x, z, -y);
  }

  sparkle(at: Vector3, color: number, count = 18, speed = 0.6): void {
    for (let i = 0; i < count; i++) {
      const p = this.sparks.find((s) => !s.alive);
      if (!p) return;
      p.alive = true;
      p.age = 0;
      p.life = 0.45 + Math.random() * 0.35;
      p.pos.copy(at);
      p.vel.set(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      p.size = 0.018 + Math.random() * 0.018;
      const index = this.sparks.indexOf(p);
      this.sparkMesh.setColorAt(index, this.c.set(color));
    }
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;
  }

  burstConfetti(at: Vector3, count = 80, speed = 1.4): void {
    for (let i = 0; i < count; i++) {
      const p = this.confetti.find((s) => !s.alive);
      if (!p) return;
      p.alive = true;
      p.age = 0;
      p.life = 1.8 + Math.random() * 1.2;
      p.pos.copy(at);
      p.vel.set(Math.random() - 0.5, 1.2 + Math.random(), Math.random() - 0.5).normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.6));
      p.size = 0.014 + Math.random() * 0.012;
      p.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(6 + Math.random() * 8);
      p.rot.setFromAxisAngle(this.v.set(Math.random(), Math.random(), Math.random()).normalize(), Math.random() * 6);
      const index = this.confetti.indexOf(p);
      this.confettiMesh.setColorAt(index, this.c.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]));
    }
    if (this.confettiMesh.instanceColor) this.confettiMesh.instanceColor.needsUpdate = true;
  }

  /** Floating label that rises and fades. `height` is the label height in metres. */
  text(at: Vector3, label: string, color = '#ffd166', height = 0.06): void {
    const slot = this.texts.find((t) => !t.alive) ?? this.texts.reduce((a, b) => (a.age > b.age ? a : b));
    const { texture, aspect } = this.labelTexture(label, color);
    slot.material.map = texture;
    slot.material.needsUpdate = true;
    slot.mesh.scale.set(height * aspect, height, 1);
    slot.base.copy(at);
    slot.mesh.position.copy(at);
    slot.age = 0;
    slot.life = 1.3;
    slot.alive = true;
    slot.mesh.visible = true;
  }

  /** A ring that expands and fades, facing along `normal` (stage-local). */
  ring(at: Vector3, normal: Vector3, color = 0xffd166): void {
    const slot = this.rings.find((r) => !r.alive) ?? this.rings[0];
    slot.mesh.position.copy(at);
    slot.mesh.quaternion.setFromUnitVectors(this.v.set(0, 0, 1), normal);
    slot.material.color.set(color);
    slot.age = 0;
    slot.alive = true;
    slot.mesh.visible = true;
  }

  update(delta: number): void {
    if (!this.root) return;
    const dt = Math.min(delta, 0.05);
    // Billboards face the viewer: the camera's rotation in stage space.
    this.world.camera.getWorldQuaternion(this.camQ);
    this.root.parent?.getWorldQuaternion(this.q);
    this.camQ.premultiply(this.q.invert());

    let sparkAlive = false;
    for (let i = 0; i < SPARKS; i++) {
      const p = this.sparks[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        this.sparkMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        sparkAlive = true;
        continue;
      }
      p.vel.multiplyScalar(1 - 2.2 * dt);
      p.pos.addScaledVector(p.vel, dt);
      const t = p.age / p.life;
      const size = p.size * (t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8);
      this.sparkMesh.setMatrixAt(i, this.m.compose(p.pos, this.camQ, this.s.set(size, size, size)));
      sparkAlive = true;
    }
    if (sparkAlive) this.sparkMesh.instanceMatrix.needsUpdate = true;

    let confettiAlive = false;
    for (let i = 0; i < CONFETTI; i++) {
      const p = this.confetti[i];
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life || p.pos.y < 0.002) {
        p.alive = false;
        this.confettiMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        confettiAlive = true;
        continue;
      }
      p.vel.addScaledVector(this.gravity, dt * 0.35);
      p.vel.multiplyScalar(1 - 1.4 * dt); // paper drag: floaty
      p.pos.addScaledVector(p.vel, dt);
      this.q.setFromAxisAngle(this.v.copy(p.spin).normalize(), p.spin.length() * dt);
      p.rot.multiply(this.q);
      const fade = p.age > p.life - 0.4 ? (p.life - p.age) / 0.4 : 1;
      this.confettiMesh.setMatrixAt(i, this.m.compose(p.pos, p.rot, this.s.set(p.size * fade, p.size * 0.6 * fade, 1)));
      confettiAlive = true;
    }
    if (confettiAlive) this.confettiMesh.instanceMatrix.needsUpdate = true;

    for (const t of this.texts) {
      if (!t.alive) continue;
      t.age += dt;
      if (t.age >= t.life) {
        t.alive = false;
        t.mesh.visible = false;
        continue;
      }
      const k = t.age / t.life;
      t.mesh.position.set(t.base.x, t.base.y + 0.12 * Math.sqrt(k), t.base.z);
      t.mesh.quaternion.copy(this.camQ);
      t.material.opacity = k < 0.15 ? k / 0.15 : k > 0.7 ? (1 - k) / 0.3 : 1;
    }

    for (const r of this.rings) {
      if (!r.alive) continue;
      r.age += dt;
      const k = r.age / 0.6;
      if (k >= 1) {
        r.alive = false;
        r.mesh.visible = false;
        continue;
      }
      const scale = 0.6 + 1.2 * k;
      r.mesh.scale.set(scale, scale, scale);
      r.material.opacity = 0.9 * (1 - k);
    }
  }

  private labelTexture(label: string, color: string): { texture: CanvasTexture; aspect: number } {
    const key = `${label}|${color}`;
    const cached = this.textures.get(key);
    if (cached) return cached;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = '800 72px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(label).width) + 48;
    canvas.width = width;
    canvas.height = 112;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 14;
    ctx.strokeStyle = 'rgba(16,20,28,0.85)';
    ctx.strokeText(label, width / 2, 58);
    ctx.fillStyle = color;
    ctx.fillText(label, width / 2, 58);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const entry = { texture, aspect: width / canvas.height };
    this.textures.set(key, entry);
    return entry;
  }

  /** The level disposed the meshes; forget them so the next stage gets fresh ones. */
  private reset(): void {
    this.root = null;
    this.stageEntity = null;
    this.sparks.length = 0;
    this.confetti.length = 0;
    this.texts.length = 0;
    this.rings.length = 0;
  }

  private build(stage: Entity): void {
    if (this.stageEntity === stage) return;
    if (this.root) this.reset();
    this.stageEntity = stage;
    const root = new Group();
    root.name = 'fx';
    const quad = new PlaneGeometry(1, 1);

    const sparkMaterial = new MeshBasicMaterial({
      map: sparkTexture(),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.sparkMesh = new InstancedMesh(quad, sparkMaterial, SPARKS);
    this.sparkMesh.name = 'fx-sparks';
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.confettiMesh = new InstancedMesh(quad, new MeshBasicMaterial({ side: DoubleSide }), CONFETTI);
    this.confettiMesh.name = 'fx-confetti';
    this.confettiMesh.frustumCulled = false;
    this.confettiMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < SPARKS; i++) {
      this.sparks.push(makeParticle());
      this.sparkMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
      this.sparkMesh.setColorAt(i, this.c.set(0xffffff));
    }
    for (let i = 0; i < CONFETTI; i++) {
      this.confetti.push(makeParticle());
      this.confettiMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
      this.confettiMesh.setColorAt(i, this.c.set(0xffffff));
    }
    root.add(this.sparkMesh, this.confettiMesh);

    for (let i = 0; i < TEXTS; i++) {
      const material = new MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false });
      const mesh = new Mesh(quad, material);
      mesh.name = `fx-text-${i}`;
      mesh.renderOrder = 10;
      mesh.visible = false;
      root.add(mesh);
      this.texts.push({ mesh, material, age: 0, life: 1, base: new Vector3(), alive: false });
    }
    const ringGeometry = new RingGeometry(0.11, 0.135, 48);
    for (let i = 0; i < RINGS; i++) {
      const material = new MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(ringGeometry, material);
      mesh.name = `fx-ring-${i}`;
      mesh.visible = false;
      root.add(mesh);
      this.rings.push({ mesh, material, age: 0, alive: false });
    }
    this.world.createTransformEntity(root, { parent: stage });
    this.root = root;
  }
}
