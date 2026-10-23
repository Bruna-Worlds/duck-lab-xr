// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes artifacts/video/uuids.json: the Object3D UUIDs of the robot panel's
 * handles and buttons, the menu's chips, the duck and the scoreboard, read
 * from the live scene of the headset page in artifacts/video/rt.json (its
 * runtimeTarget). UIKit elements carry their ids as names.
 *
 *   node tools/test/headset-uuids.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const rt = JSON.parse(readFileSync('artifacts/video/rt.json', 'utf8'));
const cli = (...args) => {
  const out = execFileSync('node', ['node_modules/@iwsdk/cli/bin/iwsdk.js', ...args, '--raw'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out);
  return j.data?.result ?? j.result ?? j;
};
const hierarchy = (parentId, maxDepth) =>
  cli('scene', 'runtime-hierarchy', '--input-json', JSON.stringify({ ...(parentId ? { parentId } : {}), maxDepth, runtimeTarget: rt }));
const ids = {};
const collect = (node, pattern) => {
  if (!node || typeof node !== 'object') return;
  if (node.name && pattern.test(node.name) && !ids[node.name]) ids[node.name] = node.uuid;
  for (const child of node.children ?? []) collect(child, pattern);
};
collect(hierarchy(null, 6), /^(Robot Panel|Menu Panel|Scoreboard|robot-panel-bar|robot-panel-resizer|trunk_base)$/);
for (const host of ['Robot Panel', 'Menu Panel']) {
  if (ids[host]) collect(hierarchy(ids[host], 12), /^(rp-|pg-|menu-close)/);
}
const out = { ...ids, bar: ids['robot-panel-bar'], grip: ids['robot-panel-resizer'], duck: ids.trunk_base, score: ids.Scoreboard };
writeFileSync('artifacts/video/uuids.json', JSON.stringify(out, null, 1));
console.log(`UUIDS ${Object.keys(out).length}: ${['bar', 'grip', 'duck', 'rp-pin', 'rp-more', 'rp-less', 'rp-offer-try', 'pg-3'].map((k) => `${k}:${out[k] ? 'ok' : 'missing'}`).join(' ')}`);
