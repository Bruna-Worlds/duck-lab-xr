// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainer connector end to end, with a stand-in outside trainer
 * (tools/test/fake-trainer.mjs) registered the way yours would be: a trainer
 * engine of its own on port 8792 lists it, trains with it on one pack (the
 * pack exported, job.json, progress lines), makes its walk.onnx a release and
 * cross-checks it in the quick engines; the check then removes what it made.
 *
 *   node tools/test/trainer-connector-check.mjs [pack id]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { incomingDir, rescanIndex } from '../train/lib/release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK = process.argv[2] ?? '2026-10-22T07-36-31-manual';
const PORT = 8792;
const base = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body) => {
  const res = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};

const temp = mkdtempSync(join(tmpdir(), 'ducklab-trainers-'));
const registry = join(temp, 'trainers.json');
writeFileSync(registry, JSON.stringify([{ id: 'stand-in', title: 'Stand-in trainer', about: 'A test.', cwd: '.', command: ['node', 'tools/test/fake-trainer.mjs'] }]));
const server = spawn(process.execPath, [join(root, 'tools/lab/server.mjs'), '--port', String(PORT)], { cwd: root, env: { ...process.env, DUCKLAB_TRAINERS: registry }, stdio: 'ignore' });
let release = null;
let jobId = null;
try {
  for (let i = 0; i < 60; i++) {
    try {
      await api('/api/state');
      break;
    } catch {
      await wait(500);
    }
  }
  const { trainers, engines } = await api('/api/trainers');
  const ids = Object.fromEntries(trainers.map((t) => [t.id, t]));
  check('trainers listed', !!ids.es && !!ids['microduck-rl'] && !!ids.isaaclab && !!ids['stand-in'], trainers.map((t) => `${t.id}${t.ready ? '' : ' (not set up)'}`).join(', '));
  check('the stand-in is ready, the outside ones say how to set up', ids['stand-in'].ready && (ids['microduck-rl'].ready || !!ids['microduck-rl'].install), `engines ${engines.join(', ')}`);
  const job = await api('/api/train', { trainer: 'stand-in', packs: [PACK], envs: 64, iterations: 3, name: 'connector-check' });
  jobId = job.id;
  let done = null;
  for (let i = 0; i < 600 && !done; i++) {
    const s = await api('/api/state');
    const j = s.jobs.find((x) => x.id === job.id);
    if (j && j.state !== 'running') done = j;
    else await wait(1000);
  }
  check('the job finished', done?.state === 'done', done?.error ?? done?.state ?? 'timed out');
  const events = done?.events ?? [];
  check('progress from its output', events.filter((e) => e.type === 'progress').length === 3, `${events.filter((e) => e.type === 'log').length} lines`);
  release = done?.result?.release;
  check('a release from its walk.onnx', !!release && existsSync(join(incomingDir(root), release.id, 'walk.onnx')), release?.id);
  const manifest = release ? JSON.parse(readFileSync(join(incomingDir(root), release.id, 'manifest.json'), 'utf8')) : {};
  check('manifest names the trainer and its numbers', manifest.trainer?.kind === 'stand-in' && manifest.results?.trained?.note?.startsWith('stand-in'), manifest.trainer?.kind);
  check('the policy contract was checked', manifest.control?.checked?.standing?.length === 14);
  const table = manifest.crossCheck?.table ?? [];
  check('cross-checked against the shipped brain', table.some((r) => r.brain === 'shipped') && table.some((r) => r.brain === release?.id), table.map((r) => `${r.engine}/${r.brain === 'shipped' ? 'shipped' : 'new'} ${(r.falls * 100).toFixed(0)}%`).join(', '));
  const same = table.filter((r) => r.engine === 'mujoco');
  check('same brain, same MuJoCo result', same.length === 2 && same[0].falls === same[1].falls && same[0].walkedM === same[1].walkedM, 'the stand-in returns the shipped policy');
} catch (err) {
  check('ran to the end', false, err.message);
} finally {
  server.kill();
  if (release) rmSync(join(incomingDir(root), release.id), { recursive: true, force: true });
  if (release) rmSync(join(root, 'artifacts', 'cross-check', release.id), { recursive: true, force: true });
  if (jobId) rmSync(join(root, 'artifacts', 'jobs', jobId), { recursive: true, force: true });
  rescanIndex(root);
  rmSync(temp, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
