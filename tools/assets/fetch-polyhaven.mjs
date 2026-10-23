// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Downloads Poly Haven assets (CC0) for the playgrounds into public/:
 *   models  -> public/models/polyhaven/<id>/<id>_1k.gltf + textures + bin
 *   hdris   -> public/env/<id>_1k.hdr
 *   textures-> public/textures/polyhaven/<id>/<map>_1k.jpg
 * Usage: node tools/assets/fetch-polyhaven.mjs
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MODELS = [
  'wooden_picnic_table', 'planter_box_01', 'potted_plant_02', 'garden_gnome', 'watering_can_metal_01',
  'wooden_crate_01', 'rubber_duck_toy', 'stone_01', 'rock_07', 'shrub_02', 'tree_small_02',
  'grass_medium_01', 'football', 'wooden_bucket_01', 'painted_wooden_bench',
];
const HDRIS = ['ballawley_park'];
const TEXTURES = ['aerial_grass_rock', 'weathered_planks'];
const RES = '1k';

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
async function download(url, file) {
  try {
    if ((await stat(file)).size > 0) return 'kept';
  } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return 'new';
}

let total = 0;
for (const id of MODELS) {
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  const entry = files.gltf?.[RES]?.gltf;
  if (!entry) { console.log(`skip ${id}: no gltf ${RES}`); continue; }
  const dir = path.join('public/models/polyhaven', id);
  await download(entry.url, path.join(dir, path.basename(entry.url)));
  let bytes = entry.size;
  for (const [rel, inc] of Object.entries(entry.include ?? {})) {
    await download(inc.url, path.join(dir, rel));
    bytes += inc.size ?? 0;
  }
  total += bytes;
  console.log(`model ${id}: ${(bytes / 1e6).toFixed(1)} MB`);
}
for (const id of HDRIS) {
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  const entry = files.hdri?.[RES]?.hdr;
  if (!entry) { console.log(`skip hdri ${id}`); continue; }
  await download(entry.url, path.join('public/env', `${id}_${RES}.hdr`));
  total += entry.size;
  console.log(`hdri ${id}: ${(entry.size / 1e6).toFixed(1)} MB`);
}
for (const id of TEXTURES) {
  const files = await fetchJson(`https://api.polyhaven.com/files/${id}`);
  for (const map of ['Diffuse', 'nor_gl', 'Rough', 'AO']) {
    const entry = files[map]?.[RES]?.jpg;
    if (!entry) { console.log(`skip texture ${id} ${map}`); continue; }
    await download(entry.url, path.join('public/textures/polyhaven', id, `${map.toLowerCase()}_${RES}.jpg`));
    total += entry.size;
  }
  console.log(`texture ${id}`);
}
console.log(`total ${(total / 1e6).toFixed(1)} MB`);
