// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Publishing a brain to the Hugging Face Hub, against a stand-in Hub
 * (tools/test/mock-hub.mjs): nothing is sent to huggingface.co.
 *
 * 1. The publisher on a copy of the newest release: default repo name, what
 *    the duck needs (one policy.onnx, a manifest it accepts), README and
 *    attribution, a second publish updating the same repo, bad tokens and
 *    other people's namespaces.
 * 2. Duck Lab XR's endpoint (a second Lab on port 8791 pointed at the stand-in):
 *    refuses other sites and bad input, publishes, and the release index then
 *    names the repo (what the game's FLASH BRAIN downloads). The release's
 *    manifest is put back afterwards.
 *
 *   node tools/test/hub-publish-check.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishRelease } from '../train/lib/hub.mjs';
import { incomingDir, readIndex, rescanIndex } from '../train/lib/release.mjs';
import { startMockHub } from './mock-hub.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HUB_PORT = 8798;
const LAB_PORT = 8791;
const TOKEN = 'hf_duckdash_test_token';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const release = readIndex(root).releases[0];
if (!release) {
  console.log('SKIP no release to publish (train one in Duck Lab XR first)');
  console.log(JSON.stringify({ passed: 0, failed: 0 }));
  process.exit(0);
}
const hub = await startMockHub(HUB_PORT);
const releaseDir = join(incomingDir(root), release.id);
const walk = readFileSync(join(releaseDir, 'walk.onnx'));

// --- 1. The publisher, on a copy of the release ---------------------------------------
const copy = mkdtempSync(join(tmpdir(), 'duckdash-hub-'));
cpSync(releaseDir, copy, { recursive: true });
try {
  const first = await publishRelease({ releaseDir: copy, token: TOKEN, hubUrl: hub.base });
  const repo = hub.repos.get(first.repo);
  const files = repo?.files ?? {};
  check('names the repo <user>/microduck-duckdash-<name>', first.repo === `tester/microduck-duckdash-${slug(release.name)}`, first.repo);
  check('creates a public Apache-2.0 model repo', repo?.type === 'model' && repo.visibility === 'public' && repo.license === 'apache-2.0');
  const onnx = Object.keys(files).filter((f) => f.endsWith('.onnx'));
  check(
    'uploads exactly one policy.onnx, the trained walk, through LFS',
    onnx.length === 1 && onnx[0] === 'policy.onnx' && files['policy.onnx'].lfs && files['policy.onnx'].sha256 === sha256(walk),
    `${onnx.join(', ')}, ${files['policy.onnx']?.size} bytes`,
  );
  const m = JSON.parse(files['manifest.json']?.text ?? '{}');
  check(
    'writes a manifest the duck accepts',
    m.schema_version === 2 && m.obs_len === 61 && m.action_len === 14 && m.model_api === 1 && m.robot?.model === 'microduck' && m.kind === 'perpetual' && m.slot === 'walk',
    JSON.stringify({ schema_version: m.schema_version, obs_len: m.obs_len, action_len: m.action_len, model_api: m.model_api, robot: m.robot, kind: m.kind, slot: m.slot }),
  );
  const readme = files['README.md']?.text ?? '';
  check('README with licence, Pollen attribution and install steps', /license: apache-2.0/.test(readme) && /Pollen Robotics/.test(readme) && /microduck_rl/.test(readme) && readme.includes(first.repo), `${readme.length} chars`);
  check('ships ATTRIBUTION.md', !!files['ATTRIBUTION.md']);
  const written = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')).hub;
  check('remembers the repo in the release', written?.repo === first.repo && !!written?.commit, JSON.stringify(written));
  const second = await publishRelease({ releaseDir: copy, token: TOKEN, repo: first.repo, hubUrl: hub.base });
  check('publishing again updates the same repo', second.repo === first.repo && repo.commits.length === 2, `${repo.commits.length} commits`);
  const failure = async (args) => publishRelease({ releaseDir: copy, hubUrl: hub.base, ...args }).then(() => '', (err) => err.message);
  const revoked = await failure({ token: 'hf_revoked_token' });
  check('a bad token fails with the Hub reason', /Invalid credentials/.test(revoked), revoked.slice(0, 70));
  const foreign = await failure({ token: TOKEN, repo: 'pollen-robotics/microduck-walk' });
  check('someone else namespace fails', /rights/.test(foreign), foreign.slice(0, 70));
} finally {
  rmSync(copy, { recursive: true, force: true });
}

// --- 2. Duck Lab XR's endpoint ----------------------------------------------------------------
function post(path, body, headers = {}) {
  return new Promise((done, fail) => {
    const data = JSON.stringify(body);
    const req = request(
      { host: '127.0.0.1', port: LAB_PORT, path, method: 'POST', headers: { host: `localhost:${LAB_PORT}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // not JSON
          }
          done({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', fail);
    req.end(data);
  });
}

const manifestPath = join(releaseDir, 'manifest.json');
const original = readFileSync(manifestPath);
const lab = spawn(process.execPath, [join(root, 'tools', 'lab', 'server.mjs'), '--port', String(LAB_PORT)], {
  cwd: root,
  env: { ...process.env, DUCKLAB_HUB_URL: hub.base },
  stdio: 'ignore',
});
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await wait(500);
    up = await fetch(`http://127.0.0.1:${LAB_PORT}/api/state`).then((r) => r.ok, () => false);
  }
  check('second Duck Lab XR starts', up);
  const path = `/api/releases/${encodeURIComponent(release.id)}/publish-hub`;
  const evil = await post(path, { token: TOKEN }, { origin: 'https://evil.example' });
  check('refuses another website', evil.status === 403, `${evil.status} ${evil.json?.error}`);
  const rebound = await post(path, { token: TOKEN }, { host: `evil.example:${LAB_PORT}` });
  check('refuses a rebound host name', rebound.status === 403, `${rebound.status} ${rebound.json?.error}`);
  const badToken = await post(path, { token: 'my password' }, { origin: `http://localhost:${LAB_PORT}` });
  check('asks for a real token', badToken.status === 400, `${badToken.status} ${badToken.json?.error}`);
  const noRelease = await post('/api/releases/nope/publish-hub', { token: TOKEN });
  check('unknown release is 404', noRelease.status === 404, `${noRelease.status} ${noRelease.json?.error}`);
  const ok = await post(path, { token: TOKEN, repo: '' }, { origin: `http://localhost:${LAB_PORT}` });
  const listed = ok.json?.releases?.releases?.find((r) => r.id === release.id);
  check('publishes from the Lab page', ok.status === 200 && ok.json?.repo === `tester/microduck-duckdash-${slug(release.name)}`, `${ok.status} ${ok.json?.repo ?? ok.json?.error}`);
  check('the release index names the repo for FLASH BRAIN', listed?.hubRepo === ok.json?.repo && readIndex(root).releases.find((r) => r.id === release.id)?.hubRepo === ok.json?.repo, listed?.hubRepo);
} finally {
  lab.kill();
  writeFileSync(manifestPath, original);
  rescanIndex(root);
  hub.server.close();
}
const restored = readIndex(root).releases.find((r) => r.id === release.id);
check('release put back as it was', restored?.hubRepo === null && readFileSync(manifestPath).equals(original));
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
process.exit(failed ? 1 : 0);
