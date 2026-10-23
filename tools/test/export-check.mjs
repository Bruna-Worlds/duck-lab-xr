// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * "Export for any simulator" check: asks the trainer engine for a bundle of a
 * test case plus the motion sets, unpacks the .zip it serves, and checks what
 * is inside: the MuJoCo scene compiles (MuJoCo WebAssembly, with its meshes
 * and terrain.bin), the OBJ meshes and the trajectory CSV are well formed, the
 * .npz arrays have NumPy headers and the right sizes, START_HERE.md speaks to
 * the chosen target. Removes the export afterwards.
 *
 *   node tools/test/export-check.mjs [pack id]
 *
 * Needs the trainer engine (npm run lab, http://localhost:8790).
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import loadMujoco from '@mujoco/mujoco';

const ENGINE = 'http://localhost:8790';
const PACK = process.argv[2] ?? '2026-10-22T07-53-10-falls';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

/** Reads a zip into { name: Buffer } (deflate or stored). */
function unzip(buf) {
  const files = {};
  let end = buf.length - 22;
  while (end > 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const localName = buf.readUInt16LE(offset + 26);
    const localExtra = buf.readUInt16LE(offset + 28);
    const body = buf.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    files[name] = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    at += 46 + nameLen + extra + comment;
  }
  return files;
}

let exportDir = null;
let exportZip = null;
try {
  const res = await fetch(`${ENGINE}/api/connector/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packs: [PACK], target: 'isaac', motions: true }),
  });
  const r = await res.json();
  check('the engine builds the export', res.ok, res.ok ? `${r.id}, ${(r.bytes / 1048576).toFixed(1)} MB, ${r.packs.length} test case, ${r.motionSets.length} motion sets` : r.error);
  if (!res.ok) throw new Error(r.error);
  exportDir = r.dir;
  exportZip = r.zipPath;
  const zres = await fetch(`${ENGINE}${r.zip}`);
  const buf = Buffer.from(await zres.arrayBuffer());
  check('the .zip downloads as an attachment', zres.ok && /attachment/.test(zres.headers.get('content-disposition') ?? '') && buf.length === r.bytes, `${buf.length} bytes`);
  const files = unzip(buf);
  const names = Object.keys(files);
  const base = `${r.id}/${PACK}/`;
  const want = ['START_HERE.md', 'job.json', 'python/duck_env.py', 'python/train_ppo.py', 'python/replay.py', 'python/requirements.txt', `${PACK}/scene.xml`, `${PACK}/state.json`, `${PACK}/terrain.bin`, `${PACK}/terrain.obj`, `${PACK}/obstacles.obj`, `${PACK}/trajectory.csv`, `${PACK}/policies/walk.onnx`];
  const missing = want.filter((w) => !files[`${r.id}/${w}`]);
  check('it holds everything START_HERE.md lists', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${names.length} files`);
  const start = files[`${r.id}/START_HERE.md`].toString('utf8');
  check('START_HERE.md opens with the chosen target (Isaac)', /^## Isaac Sim and Isaac Lab \(your choice\)/m.test(start) && start.indexOf('Isaac Sim and Isaac Lab') < start.indexOf('MuJoCo, MJX'));

  // The MuJoCo scene compiles from the exported files alone.
  const mj = await loadMujoco();
  const vfs = new mj.MjVFS();
  for (const name of names) {
    if (name.startsWith(`${base}assets/`)) vfs.addBuffer(`assets/${name.slice(base.length + 7)}`, new Uint8Array(files[name]));
  }
  vfs.addBuffer('terrain.bin', new Uint8Array(files[`${base}terrain.bin`]));
  let model = null;
  try {
    model = mj.MjModel.from_xml_string(files[`${base}scene.xml`].toString('utf8'), vfs);
  } catch (err) {
    check('scene.xml compiles in MuJoCo with its meshes and terrain.bin', false, String(err).slice(0, 160));
  }
  if (model) {
    check('scene.xml compiles in MuJoCo with its meshes and terrain.bin', true, `${model.ngeom} geoms, nq ${model.nq}, height field ${model.nhfield}`);
    model.delete();
  }
  vfs.delete();

  const terrain = files[`${base}terrain.obj`].toString('utf8');
  const tv = (terrain.match(/^v /gm) ?? []).length;
  const tf = (terrain.match(/^f /gm) ?? []).length;
  check('terrain.obj: the height field as a mesh', tv === 201 * 201 && tf === 2 * 200 * 200, `${tv} vertices, ${tf} triangles`);
  const obstacles = files[`${base}obstacles.obj`].toString('utf8');
  const parts = (obstacles.match(/^o /gm) ?? []).length;
  const scene = files[`${base}scene.xml`].toString('utf8');
  const geoms = (scene.match(/name="(course|room)_\d+"/g) ?? []).length;
  const faceOk = obstacles.split('\n').filter((l) => l.startsWith('f ')).every((l) => l.split(' ').slice(1).every((k) => Number(k) >= 1 && Number(k) <= (obstacles.match(/^v /gm) ?? []).length));
  check('obstacles.obj: one mesh per course piece and room collider', parts === geoms && parts > 0 && faceOk, `${parts} meshes for ${geoms} geoms`);
  const csv = files[`${base}trajectory.csv`].toString('utf8').trim().split('\n');
  const header = csv[0].split(',');
  const widths = new Set(csv.map((row) => row.split(',').length));
  check('trajectory.csv: one row per control step, same width', csv.length > 50 && widths.size === 1 && header.includes('q_left_knee') && header.includes('target_left_knee'), `${csv.length - 1} rows x ${header.length} columns`);

  const npzName = names.find((n) => n.endsWith('.npz'));
  if (npzName) {
    const arrays = unzip(files[npzName]);
    const npy = arrays['obs.npy'];
    const ok = npy && npy.subarray(0, 6).toString('latin1') === '\x93NUMPY';
    const headerLen = npy.readUInt16LE(8);
    const dict = npy.toString('latin1', 10, 10 + headerLen);
    const shape = /'shape': \((\d+), (\d+)\)/.exec(dict);
    const sizeOk = shape && (npy.length - 10 - headerLen) === Number(shape[1]) * Number(shape[2]) * 4 && Number(shape[2]) === 61;
    check('motion sets: .npz with NumPy arrays (obs N x 61)', !!ok && !!sizeOk && (10 + headerLen) % 64 === 0, `${npzName.split('/').pop()}: obs ${shape?.[1]} x ${shape?.[2]}, arrays ${Object.keys(arrays).join(' ')}`);
  } else {
    check('motion sets: .npz with NumPy arrays (obs N x 61)', false, 'no .npz');
  }
} catch (err) {
  check('export run', false, String(err.message ?? err).split('\n')[0]);
} finally {
  if (exportDir) rmSync(exportDir, { recursive: true, force: true });
  if (exportZip) rmSync(exportZip, { force: true });
}
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
console.log(JSON.stringify({ passed, failed: results.length - passed }));
process.exit(passed === results.length ? 0 : 1);
