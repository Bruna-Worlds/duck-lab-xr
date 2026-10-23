// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy releases on this PC (public/policies/incoming/): list them, rebuild
 * the index after an external trainer dropped a folder in, and choose the
 * one the headset is offered.
 *
 *   node tools/train/release.mjs list
 *   node tools/train/release.mjs rescan
 *   node tools/train/release.mjs activate <release-id>
 *   node tools/train/release.mjs deactivate
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rescanIndex, setActive } from './lib/release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [command = 'list', id] = process.argv.slice(2);
const pct = (v) => (v === null || v === undefined ? '?' : `${Math.round(v * 100)}%`);

let index;
if (command === 'activate') {
  if (!id) throw new Error('usage: node tools/train/release.mjs activate <release-id>');
  index = setActive(root, id);
} else if (command === 'deactivate') {
  index = setActive(root, null);
} else if (command === 'rescan' || command === 'list') {
  index = rescanIndex(root);
} else {
  console.error('usage: node tools/train/release.mjs list | rescan | activate <id> | deactivate');
  process.exit(2);
}
if (!index.releases.length) console.log('no releases yet (train one with tools/train/finetune.mjs or Duck Lab XR)');
for (const r of index.releases) {
  const mark = r.id === index.active ? '*' : ' ';
  console.log(`${mark} ${r.id}  ${r.name}  falls ${pct(r.baselineFallRate)} -> ${pct(r.fallRate)}  ${r.packs} pack(s)  walk ${r.walkHash}  (${r.trainer})`);
}
console.log(index.active ? `active: ${index.active} (the headset offers it)` : 'active: none (the headset runs the shipped policies)');
