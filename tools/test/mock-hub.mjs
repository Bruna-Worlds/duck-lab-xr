// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for the Hugging Face Hub, enough for @huggingface/hub's
 * whoAmI, createRepo and uploadFiles (preupload, LFS batch with the basic
 * transfer, PUT upload, NDJSON commit). Nothing leaves this machine. Used by
 * tools/test/hub-publish-check.mjs; also runnable on its own:
 *
 *   node tools/test/mock-hub.mjs [port]     (default 8798)
 *   GET /repos   what was published (files with sizes and sha256)
 *
 * Any token starting with hf_ works except hf_revoked_token (401).
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function startMockHub(port = 8798) {
  const base = `http://localhost:${port}`;
  const repos = new Map();
  const lfs = new Map();
  const log = [];
  const json = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    const p = url.pathname;
    log.push({ method: req.method, path: p });
    if (p === '/repos') return json(res, 200, Object.fromEntries(repos));
    if (p === '/log') return json(res, 200, log);
    const upload = p.match(/^\/lfs-upload\/([0-9a-f]{64})$/);
    if (upload && req.method === 'PUT') {
      const sha = createHash('sha256').update(body).digest('hex');
      if (sha !== upload[1]) return json(res, 400, { error: 'sha256 mismatch' });
      lfs.set(sha, body.length);
      return res.writeHead(200).end();
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!token.startsWith('hf_') || token === 'hf_revoked_token') return json(res, 401, { error: 'Invalid credentials in Authorization header' });
    if (p === '/api/whoami-v2') {
      return json(res, 200, { type: 'user', name: 'tester', auth: { accessToken: { displayName: 'test', role: 'write', createdAt: '2026-10-01T00:00:00.000Z' } } });
    }
    if (p === '/api/repos/create' && req.method === 'POST') {
      const q = JSON.parse(body.toString('utf8'));
      const name = `${q.organization}/${q.name}`;
      if (q.organization !== 'tester') return json(res, 403, { error: `You don't have the rights to create a model under the namespace "${q.organization}"` });
      if (repos.has(name)) return json(res, 409, { error: 'You already created this model repo', url: `${base}/${name}` });
      repos.set(name, { type: q.type, visibility: q.visibility, license: q.license, commits: [], files: {} });
      return json(res, 200, { url: `${base}/${name}`, id: `id-${repos.size}` });
    }
    const pre = p.match(/^\/api\/models\/([^/]+\/[^/]+)\/(preupload|commit)\/main$/);
    if (pre && req.method === 'POST') {
      const repo = repos.get(pre[1]);
      if (!repo) return json(res, 404, { error: 'Repository not found' });
      if (pre[2] === 'preupload') {
        const q = JSON.parse(body.toString('utf8'));
        return json(res, 200, { files: q.files.map((f) => ({ path: f.path, uploadMode: f.path.endsWith('.onnx') ? 'lfs' : 'regular', shouldIgnore: false })) });
      }
      const lines = body.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const header = lines.find((l) => l.key === 'header')?.value ?? {};
      for (const { key, value } of lines) {
        if (key === 'lfsFile') {
          if (lfs.get(value.oid) !== value.size) return json(res, 400, { error: `LFS object ${value.path} was not uploaded` });
          repo.files[value.path] = { lfs: true, size: value.size, sha256: value.oid };
        } else if (key === 'file') {
          const content = Buffer.from(value.content, value.encoding === 'base64' ? 'base64' : 'utf8');
          repo.files[value.path] = { lfs: false, size: content.length, text: content.toString('utf8') };
        }
      }
      const oid = createHash('sha1').update(body).digest('hex');
      repo.commits.push({ oid, summary: header.summary });
      return json(res, 200, { commitOid: oid, commitUrl: `${base}/${pre[1]}/commit/${oid}` });
    }
    const batch = p.match(/^\/([^/]+\/[^/]+)\.git\/info\/lfs\/objects\/batch$/);
    if (batch && req.method === 'POST') {
      if (!repos.has(batch[1])) return json(res, 404, { error: 'Repository not found' });
      const q = JSON.parse(body.toString('utf8'));
      return json(res, 200, {
        transfer: 'basic',
        objects: q.objects.map((o) => ({ oid: o.oid, size: o.size, authenticated: true, actions: { upload: { href: `${base}/lfs-upload/${o.oid}` } } })),
      });
    }
    return json(res, 404, { error: `mock hub: no route for ${req.method} ${p}` });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, base, repos, log })));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { base } = await startMockHub(Number(process.argv[2] ?? 8798));
  console.log(`mock hub on ${base}`);
}
