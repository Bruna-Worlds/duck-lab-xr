// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy releases: what a trainer hands back to the headset.
 *
 * A release is a folder under public/policies/incoming/<id>/ with the full
 * policy set (the trained walk.onnx plus the shipped files it did not
 * change) and manifest.json (duckdash.policyrelease.v1: who trained it, on
 * which packs, before/after numbers, file hashes). The folder's index.json
 * (duckdash.policies.v1) lists every release and names the active one; the
 * app polls it in development and offers the active release to the player.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bakePolicy, policyHash, verifyBaked } from './policy.mjs';

export const POLICY_FILES = ['walk.onnx', 'stand.onnx', 'sitstand.onnx', 'roll.onnx', 'kick-left.onnx', 'kick-right.onnx', 'peck.onnx'];

export function incomingDir(root) {
  return join(root, 'public', 'policies', 'incoming');
}

/** The index (creates an empty one in memory when missing). */
export function readIndex(root) {
  const file = join(incomingDir(root), 'index.json');
  if (!existsSync(file)) return { version: 'duckdash.policies.v1', active: null, releases: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeIndex(root, index) {
  mkdirSync(incomingDir(root), { recursive: true });
  writeFileSync(join(incomingDir(root), 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
}

/** Rebuilds the index from the release folders on disk, keeping the active choice. */
export function rescanIndex(root) {
  const dir = incomingDir(root);
  const previous = readIndex(root);
  const releases = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestFile = join(dir, entry.name, 'manifest.json');
      if (!existsSync(manifestFile)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
        releases.push(indexEntry(entry.name, manifest));
      } catch {
        // a half-written release: skip it
      }
    }
  }
  releases.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const active = releases.some((r) => r.id === previous.active) ? previous.active : null;
  const index = { version: 'duckdash.policies.v1', active, releases };
  writeIndex(root, index);
  return index;
}

function indexEntry(id, manifest) {
  return {
    id,
    name: manifest.name,
    createdAt: manifest.createdAt,
    trainer: manifest.trainer?.kind ?? 'unknown',
    baseHash: manifest.base?.walkHash ?? '',
    walkHash: manifest.files?.['walk.onnx']?.hash ?? '',
    packs: (manifest.trainedOn ?? []).length,
    fallRate: manifest.results?.trained?.fallRate ?? null,
    baselineFallRate: manifest.results?.baseline?.fallRate ?? null,
    note: manifest.note ?? '',
    hubRepo: manifest.hub?.repo ?? null,
    crossCheck: manifest.crossCheck?.table ?? null,
  };
}

/** Makes a release the one the headset offers (or none). */
export function setActive(root, id) {
  const index = rescanIndex(root);
  if (id !== null && !index.releases.some((r) => r.id === id)) throw new Error(`no release ${id}`);
  index.active = id;
  writeIndex(root, index);
  return index;
}

/**
 * Writes a release from a fine-tune: bakes the change into walk.onnx,
 * checks it with onnxruntime, copies the other policies, writes the
 * manifest and the index.
 */
export async function writeRelease({ root, name, baseDir, policyBytes, theta, summary, publish }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'release';
  const id = `${stamp}-${slug}`;
  const dir = join(incomingDir(root), id);
  mkdirSync(dir, { recursive: true });
  const baseWalkHash = policyHash(policyBytes);
  const baked = bakePolicy(policyBytes, theta, {
    duckdash_release: id,
    duckdash_base_walk_hash: baseWalkHash,
    duckdash_trainer: 'local-es-last-layer',
    duckdash_trained_on: summary.packs.join(';'),
  });
  const worst = await verifyBaked(policyBytes, baked, theta);
  if (!(worst < 1e-3)) throw new Error(`baked policy does not match the trained one (max diff ${worst})`);
  writeFileSync(join(dir, 'walk.onnx'), baked);
  const files = { 'walk.onnx': { hash: policyHash(baked), trained: true } };
  for (const file of POLICY_FILES) {
    if (file === 'walk.onnx') continue;
    const source = join(baseDir, file);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(dir, file));
    files[file] = { hash: policyHash(readFileSync(source)), trained: false };
  }
  if (existsSync(join(baseDir, 'ATTRIBUTION.md'))) copyFileSync(join(baseDir, 'ATTRIBUTION.md'), join(dir, 'ATTRIBUTION.md'));
  const manifest = {
    version: 'duckdash.policyrelease.v1',
    id,
    name,
    createdAt: new Date().toISOString(),
    trainer: {
      kind: 'local-es-last-layer',
      description:
        'Evolution strategies (antithetic, rank fitness, Adam) on the last layer of the walking policy, in MuJoCo on the scenario packs, with shoves and noise.',
      iterations: summary.iterations,
      pairs: summary.pairs,
      episodeSteps: summary.steps,
      bestIteration: summary.bestIteration,
      seconds: summary.seconds,
    },
    base: { walkHash: baseWalkHash },
    trainedOn: summary.packs,
    results: { baseline: strip(summary.baseline), trained: strip(summary.trained), flat: summary.flat },
    files,
    control: { obs: 61, actions: 14, hz: 50, convention: 'Pollen microduck_rl (see the scenario pack control block)' },
    verify: { maxOutputDifference: worst },
    note: 'Based on Pollen Robotics Microduck policies; see ATTRIBUTION.md.',
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  let index = rescanIndex(root);
  if (publish) index = setActive(root, id);
  return { id, dir, active: index.active === id, walkHash: files['walk.onnx'].hash };
}

function strip(metrics) {
  if (!metrics) return metrics;
  const { paths, ...rest } = metrics;
  return rest;
}
