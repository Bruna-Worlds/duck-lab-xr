// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Publishing a trained brain (a release folder) to the Hugging Face Hub, so
 * a real Microduck can download it. The duck installs single policies from
 * Hub model repos (`policy.fetch {repo}`): exactly one file named
 * policy.onnx, plus an optional manifest.json (pollen-robotics/microduck
 * docs/policy-manifest.md: every field is optional, and the duck refuses only
 * a claim that is present and wrong, such as obs_len, action_len, model_api
 * or robot.model). Pollen's naming convention is <user>/microduck-<name>.
 *
 * Only ever run on the player's request with the player's own token (Duck
 * Lab: Publish to Hub). `hubUrl` and `fetch` can be replaced for tests.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRepo, uploadFiles, whoAmI } from '@huggingface/hub';

const SOURCE = 'Hugging Face Space pollen-robotics/microduck-simulator (commit ad9d41a7, app/public/policies/BEST_alpha_walking.onnx)';

/** The duck's policy manifest (schema_version 2) for a walking gait. */
export function duckManifest(release) {
  const r = release.results ?? {};
  return {
    schema_version: 2,
    model_api: 1,
    obs_len: 61,
    action_len: 14,
    robot: { model: 'microduck', control_hz: 50 },
    name: release.name,
    description: `Duck Lab XR brain ${release.name}: Pollen's walking policy fine-tuned in simulation on scenes from a player's room.`,
    kind: 'perpetual',
    slot: 'walk',
    entry_pose: 'standing',
    training: {
      run: release.id,
      checkpoint: release.files?.['walk.onnx']?.hash ?? '',
      exported: release.createdAt,
    },
    eval: {
      fall_rate_before: r.baseline?.fallRate ?? null,
      fall_rate_after: r.trained?.fallRate ?? null,
      flat_fall_rate_before: r.flat?.baseline?.fallRate ?? null,
      flat_fall_rate_after: r.flat?.trained?.fallRate ?? null,
      packs: (release.trainedOn ?? []).length,
    },
  };
}

/** The repo's README: what it is, how it was trained, and Pollen's attribution. */
export function modelCard(release, repo) {
  const r = release.results ?? {};
  const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '?');
  return `---
license: apache-2.0
library_name: onnx
tags:
  - robotics
  - microduck
  - reinforcement-learning
  - onnx
---

# ${release.name}: a Duck Lab XR brain for the Microduck

A walking policy for Pollen Robotics' Microduck, fine-tuned by Duck Lab XR (Duck
Dash's desktop trainer) on scenario packs: moments where the duck fell or got
stuck in a player's room, replayed in MuJoCo with noise and shoves.

- Input \`obs\` [1, 61], output \`actions\` [1, 14], 50 Hz: the same convention
  as Pollen's policies (the duck owns joint order, gains and standing pose).
- Trainer: ${release.trainer?.kind ?? '?'}, ${release.trainer?.iterations ?? '?'} iterations, on ${(release.trainedOn ?? []).length} scenario pack(s).
- Falls on held-out runs of those scenes: ${pct(r.baseline?.fallRate)} before, ${pct(r.trained?.fallRate)} after.
  On a plain floor: ${pct(r.flat?.baseline?.fallRate)} before, ${pct(r.flat?.trained?.fallRate)} after.

**Trained in simulation only.** Try it on a simulated duck first (Pollen's
duck-sim), then on the real duck with room to fall safely.

Install from Duck Lab XR (menu, REAL DUCK, FLASH BRAIN), or on any linked duck:
\`policy.fetch {"repo": "${repo}"}\`, then \`robot.loadPolicy {"slot": "walk", "path": <path it returns>}\`.

## Attribution

Derived from Pollen Robotics' Microduck walking policy, trained with
[microduck_rl](https://github.com/pollen-robotics/microduck_rl) (Apache-2.0,
copyright Pollen Robotics). Source file: ${SOURCE}.
Changes: the weights of the output layer were fine-tuned by Duck Lab XR.
This policy is released under Apache-2.0.
`;
}

/** The repo a release goes to when none is given: <user>/microduck-duckdash-<name>. */
export function defaultRepo(user, release) {
  const slug = String(release.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brain';
  return `${user}/microduck-duckdash-${slug}`;
}

/**
 * Creates (or reuses) a public model repo and uploads policy.onnx (the
 * release's walk.onnx), manifest.json, README.md and ATTRIBUTION.md. Writes
 * the repo into the release's manifest.json. Returns { repo, url, commit }.
 */
export async function publishRelease({ releaseDir, token, repo, hubUrl, fetch: fetchImpl }) {
  const manifestPath = join(releaseDir, 'manifest.json');
  const release = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const options = { accessToken: token, ...(hubUrl ? { hubUrl } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  const name = repo || defaultRepo((await whoAmI(options)).name, release);
  if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`not a repo name: ${name}`);
  try {
    await createRepo({ repo: { type: 'model', name }, private: false, license: 'apache-2.0', ...options });
  } catch (err) {
    // 409: the repo exists already (a new version of the same brain)
    if (err?.statusCode !== 409) throw err;
  }
  const blob = (data, type) => new Blob([data], { type });
  const files = [
    { path: 'policy.onnx', content: blob(readFileSync(join(releaseDir, 'walk.onnx')), 'application/octet-stream') },
    { path: 'manifest.json', content: blob(`${JSON.stringify(duckManifest(release), null, 2)}\n`, 'application/json') },
    { path: 'README.md', content: blob(modelCard(release, name), 'text/markdown') },
  ];
  if (existsSync(join(releaseDir, 'ATTRIBUTION.md'))) {
    files.push({ path: 'ATTRIBUTION.md', content: blob(readFileSync(join(releaseDir, 'ATTRIBUTION.md')), 'text/markdown') });
  }
  const out = await uploadFiles({ repo: { type: 'model', name }, files, commitTitle: `Duck Lab XR brain ${release.name}`, ...options });
  const url = `${hubUrl ?? 'https://huggingface.co'}/${name}`;
  release.hub = { repo: name, url, commit: out?.commit?.oid ?? null, publishedAt: new Date().toISOString() };
  writeFileSync(manifestPath, `${JSON.stringify(release, null, 2)}\n`);
  return { repo: name, url, commit: release.hub.commit };
}
