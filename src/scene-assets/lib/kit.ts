// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for the duck course kit and the toy room: toy-like
 * materials and a merger that bakes many small parts (checkers, planks, net
 * strands) into one vertex-coloured mesh, so a piece stays a few draw calls.
 * Deterministic and DOM-free: the asset manifest evaluates it in two realms.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Matrix4,
  MeshStandardMaterial,
  NoColorSpace,
  type Object3D,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import type { ColliderSpec } from '../../course/collider-spec.js';
import { COLLIDERS_KEY } from '../../course/collider-spec.js';

export function toyMaterial(
  color: number,
  roughness = 0.6,
  metalness = 0,
  options: { vertexColors?: boolean; emissive?: number; emissiveIntensity?: number } = {},
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness,
    metalness,
    vertexColors: options.vertexColors ?? false,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1,
  });
}

export interface ColoredPart {
  geometry: BufferGeometry;
  matrix?: Matrix4;
  color?: number;
}

const tmp = new Vector3();
const normalMatrix = new Matrix3();
const tint = new Color();

/** Merges parts into one non-indexed geometry with position, normal and colour. */
export function mergeColored(parts: ColoredPart[]): BufferGeometry {
  const sources = parts.map((part) => {
    const g = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    return { g, part };
  });
  const total = sources.reduce((sum, s) => sum + s.g.getAttribute('position').count, 0);
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let o = 0;
  for (const { g, part } of sources) {
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const m = part.matrix ?? new Matrix4();
    normalMatrix.getNormalMatrix(m);
    tint.set(part.color ?? 0xffffff);
    for (let i = 0; i < pos.count; i++, o++) {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(m).toArray(positions, o * 3);
      tmp.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize().toArray(normals, o * 3);
      tint.toArray(colors, o * 3);
    }
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(positions, 3));
  merged.setAttribute('normal', new BufferAttribute(normals, 3));
  merged.setAttribute('color', new BufferAttribute(colors, 3));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Attaches physics colliders (see collider-spec.ts) to a prototype root. */
export function withColliders<T extends Object3D>(root: T, colliders: ColliderSpec[]): T {
  root.userData[COLLIDERS_KEY] = colliders;
  return root;
}

export const at = (x: number, y: number, z: number): Matrix4 => new Matrix4().makeTranslation(x, y, z);

/**
 * A deterministic RGBA texture from a per-pixel function (no DOM, so it is
 * safe in the asset manifest). Sizes should be powers of two for mipmaps.
 */
export function proceduralTexture(
  width: number,
  height: number,
  pixel: (x: number, y: number, out: [number, number, number, number]) => void,
  options: { srgb?: boolean; repeat?: [number, number] } = {},
): DataTexture {
  const data = new Uint8Array(width * height * 4);
  const rgba: [number, number, number, number] = [0, 0, 0, 255];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba[3] = 255;
      pixel(x, y, rgba);
      const o = (y * width + x) * 4;
      data[o] = rgba[0];
      data[o + 1] = rgba[1];
      data[o + 2] = rgba[2];
      data[o + 3] = rgba[3];
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat);
  texture.colorSpace = options.srgb === false ? NoColorSpace : SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  if (options.repeat) texture.repeat.set(options.repeat[0], options.repeat[1]);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Smooth value noise in [0, 1) for procedural textures. */
export function valueNoise(seed: number): (x: number, y: number) => number {
  const hash = (ix: number, iy: number) => {
    let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = fade(x - ix);
    const fy = fade(y - iy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
