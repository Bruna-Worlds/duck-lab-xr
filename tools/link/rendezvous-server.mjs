// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing rendezvous for Duck Lab XR: how a headset finds the trainer page on
 * the same network, and how the two swap WebRTC offers. After that the data
 * (scenario packs up, trained brains down) goes straight between them over a
 * WebRTC data channel; this server only carries a few small messages per
 * connection and keeps nothing on disk.
 *
 * Plain HTTP and JSON with polling, so the same API can run as a dev-server
 * middleware (vite.config.ts mounts it at /__duck/pair) or as a small hosted
 * function next to the website.
 *
 *   POST /lab    {lab, name}         -> {code}          a trainer page is open (it repeats this every 15 s)
 *   POST /bye    {lab}               -> {}              it closed (sent as a beacon)
 *   GET  /labs                       -> {labs: [{lab, name, code}]}   trainer pages on this network
 *   POST /code   {code}              -> {lab, name}     a typed pairing code to its trainer page
 *   POST /send   {to, from, data}    -> {}              one message for one peer
 *   GET  /inbox?id=<id>&wait=<ms>    -> {messages: [{from, data}]}   waits up to `wait` ms for messages
 *
 * "This network" is whatever `groupBy(req)` says: the dev server treats every
 * visitor as one network; a hosted version groups visitors by public address
 * (a home router gives the headset and the computer the same one).
 */

const LAB_TTL_MS = 45_000;
const MESSAGE_TTL_MS = 60_000;
const MAX_WAIT_MS = 20_000;
const MAX_BODY = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^\d{6}$/;

export function createRendezvous({ groupBy = () => 'lan' } = {}) {
  /** lab id -> { name, code, network, seen } */
  const labs = new Map();
  /** code -> lab id */
  const codes = new Map();
  /** peer id -> { messages: [{from, data, at}], waiters: Set<() => void>, seen } */
  const inboxes = new Map();

  const sweep = () => {
    const now = Date.now();
    for (const [id, lab] of labs) {
      if (now - lab.seen > LAB_TTL_MS) {
        labs.delete(id);
        codes.delete(lab.code);
      }
    }
    for (const [id, box] of inboxes) {
      box.messages = box.messages.filter((m) => now - m.at < MESSAGE_TTL_MS);
      if (!box.messages.length && !box.waiters.size && now - box.seen > MESSAGE_TTL_MS) inboxes.delete(id);
    }
  };
  const timer = setInterval(sweep, 10_000);
  timer.unref?.();

  const inbox = (id) => {
    let box = inboxes.get(id);
    if (!box) {
      box = { messages: [], waiters: new Set(), seen: Date.now() };
      inboxes.set(id, box);
    }
    return box;
  };

  const newCode = () => {
    for (let tries = 0; tries < 50; tries++) {
      const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
      if (!codes.has(code)) return code;
    }
    throw Object.assign(new Error('no free pairing code'), { status: 503 });
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(Object.assign(new Error('not JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });

  const send = (res, status, data) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(data));
  };

  const fail = (status, message) => Object.assign(new Error(message), { status });
  const cleanName = (name) => String(name ?? '').replace(/[^\w .,:'()-]/g, '').slice(0, 60) || 'Duck Lab XR';

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://rendezvous');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const network = groupBy(req);

    if (path === '/lab' && req.method === 'POST') {
      const body = await readJson(req);
      if (!ID.test(String(body.lab ?? ''))) throw fail(400, 'bad lab id');
      const known = labs.get(body.lab);
      const code = known?.code ?? newCode();
      labs.set(body.lab, { name: cleanName(body.name), code, network, seen: Date.now() });
      codes.set(code, body.lab);
      return send(res, 200, { code, ttl: LAB_TTL_MS });
    }
    if (path === '/bye' && req.method === 'POST') {
      const body = await readJson(req);
      const lab = labs.get(String(body.lab ?? ''));
      if (lab && lab.network === network) {
        labs.delete(body.lab);
        codes.delete(lab.code);
      }
      return send(res, 200, {});
    }
    if (path === '/labs' && req.method === 'GET') {
      const now = Date.now();
      const list = [...labs.entries()]
        .filter(([, lab]) => lab.network === network && now - lab.seen < LAB_TTL_MS)
        .sort((a, b) => b[1].seen - a[1].seen)
        .map(([lab, info]) => ({ lab, name: info.name, code: info.code }));
      return send(res, 200, { labs: list });
    }
    if (path === '/code' && req.method === 'POST') {
      const body = await readJson(req);
      const code = String(body.code ?? '').replace(/\D/g, '');
      if (!CODE.test(code)) throw fail(400, 'a pairing code has 6 digits');
      const lab = codes.get(code);
      const info = lab ? labs.get(lab) : undefined;
      if (!lab || !info) throw fail(404, 'no Duck Lab XR with that code is open');
      return send(res, 200, { lab, name: info.name, code });
    }
    if (path === '/send' && req.method === 'POST') {
      const body = await readJson(req);
      if (!ID.test(String(body.to ?? '')) || !ID.test(String(body.from ?? ''))) throw fail(400, 'bad peer id');
      const box = inbox(body.to);
      box.messages.push({ from: body.from, data: body.data ?? null, at: Date.now() });
      if (box.messages.length > 32) box.messages.splice(0, box.messages.length - 32);
      for (const wake of box.waiters) wake();
      return send(res, 200, {});
    }
    if (path === '/inbox' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!ID.test(id)) throw fail(400, 'bad peer id');
      const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number(url.searchParams.get('wait')) || 0));
      const box = inbox(id);
      box.seen = Date.now();
      if (!box.messages.length && wait > 0) {
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timeout);
            box.waiters.delete(done);
            resolve();
          };
          const timeout = setTimeout(done, wait);
          box.waiters.add(done);
          req.on('close', done);
        });
      }
      const messages = box.messages.map(({ from, data }) => ({ from, data }));
      box.messages = [];
      box.seen = Date.now();
      if (res.writableEnded || res.destroyed) return;
      return send(res, 200, { messages });
    }
    throw fail(404, 'not found');
  }

  return {
    /** Node/connect handler; `req.url` is relative to where it is mounted. */
    handle(req, res) {
      route(req, res).catch((err) => {
        if (!res.writableEnded && !res.destroyed) send(res, err.status ?? 500, { error: err.message ?? String(err) });
      });
    },
    close() {
      clearInterval(timer);
    },
  };
}
