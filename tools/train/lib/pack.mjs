// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Scenario packs (duckdash.scenario.v1, see src/training/scenario-system.ts):
 * reading one from disk with its collision meshes and terrain, and a short
 * summary for listings.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Reads a pack and everything needed to compile its scene on this machine. */
export function loadPack(path, root) {
  const pack = JSON.parse(readFileSync(path, 'utf8'));
  if (pack.version !== 'duckdash.scenario.v1') throw new Error(`${path}: not a scenario pack (${pack.version})`);
  if (!pack.duck) throw new Error(`${path}: the pack names no duck pack`);
  const meshDir = join(root, 'public', pack.duck.localFolder, pack.duck.meshFolder);
  const meshes = pack.duck.meshFiles.map((file) => [file, new Uint8Array(readFileSync(join(meshDir, file)))]);
  return { path, pack, meshes, terrain: pack.terrain ? decodeTerrain(pack.terrain) : null };
}

export function decodeTerrain(t) {
  if (t.encoding !== 'base64-float32') throw new Error(`unknown terrain encoding ${t.encoding}`);
  const bytes = Buffer.from(t.data, 'base64');
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** What a listing shows about a pack, without decoding its terrain. */
export function summarizePack(path) {
  const pack = JSON.parse(readFileSync(path, 'utf8'));
  const falls = (pack.events ?? []).filter((e) => e.kind === 'fall').length;
  const seconds = pack.steps?.length ? pack.steps.length * (pack.control?.ctrlDt ?? 0.02) : 0;
  const boxes = (pack.mjcf?.match(/type="box"/g) ?? []).length;
  return {
    id: basename(path).replace(/\.scenario\.json$/, ''),
    file: basename(path),
    bytes: statSync(path).size,
    at: pack.at,
    reason: pack.reason,
    kind: pack.reason === 'falls' ? 'locomotion' : pack.reason === 'stuck' ? 'navigation' : 'manual',
    playground: pack.playground?.title ?? '',
    mixedReality: !!pack.room?.mixedReality,
    room: pack.room?.colliders || '',
    terrain: pack.room?.terrain || '',
    policyHash: pack.policy?.hash ?? '',
    steps: pack.steps?.length ?? 0,
    seconds: Math.round(seconds * 10) / 10,
    falls,
    endMode: pack.end?.mode ?? '',
    boxes,
    device: (pack.device ?? '').slice(0, 80),
  };
}
