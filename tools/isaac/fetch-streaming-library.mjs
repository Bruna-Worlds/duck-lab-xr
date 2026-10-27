// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0
//
// Downloads NVIDIA's WebRTC streaming library (@nvidia/omniverse-webrtc-streaming-library)
// from NVIDIA's public npm registry into tools/isaac/vendor/, for Isaac Sim 4.x+: those
// no longer serve a browser player of their own. The bridge extension serves the
// library to public/isaac/player.html from there.
//
//   node tools/isaac/fetch-streaming-library.mjs [version]
//
// The library is NVIDIA's and licensed by NVIDIA (vendor/.../LICENSE.txt): it is
// fetched onto this computer for local use only. tools/isaac/vendor/ is git-ignored;
// never commit, bundle or deploy it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const NAME = '@nvidia/omniverse-webrtc-streaming-library';
const REGISTRY = 'https://edge.urm.nvidia.com/artifactory/api/npm/omniverse-client-npm/';
const VERSION = process.argv[2] || '4.4.2'; // the one tested with Isaac Sim 4.5
const KEEP = ['package/dist/index.js', 'package/LICENSE.txt', 'package/package.json'];
const out = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'omniverse-webrtc-streaming-library');

async function get(url, as) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

// The files of a tar archive (ustar: 512-byte headers, names up to 255 characters).
function* untar(tar) {
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) return;
    const text = (from, length) => header.toString('utf8', from, from + length).replace(/\0.*$/s, '');
    const prefix = text(345, 155);
    const name = (prefix ? `${prefix}/` : '') + text(0, 100);
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    at += 512;
    if (type === '0') yield { name, data: tar.subarray(at, at + size) };
    at += Math.ceil(size / 512) * 512;
  }
}

const meta = await get(REGISTRY + NAME.replace('/', '%2f'), 'json');
const release = meta.versions?.[VERSION];
if (!release) throw new Error(`${NAME} has no version ${VERSION} (newest: ${meta['dist-tags']?.latest})`);
const tgz = await get(release.dist.tarball);
const [algorithm, expected] = (release.dist.integrity || '').split('-');
if (algorithm && createHash(algorithm).update(tgz).digest('base64') !== expected) {
  throw new Error(`the download does not match the registry's ${algorithm} checksum`);
}
mkdirSync(out, { recursive: true });
const found = [];
for (const file of untar(gunzipSync(tgz))) {
  if (!KEEP.includes(file.name)) continue;
  writeFileSync(join(out, file.name.slice('package/'.length).replace('dist/', '')), file.data);
  found.push(file.name);
}
if (!found.includes('package/dist/index.js')) throw new Error('the package has no dist/index.js');
console.log(`${NAME} ${VERSION} -> ${out}`);
console.log('NVIDIA licenses this library (LICENSE.txt there): keep it on this computer; never commit or deploy it.');
