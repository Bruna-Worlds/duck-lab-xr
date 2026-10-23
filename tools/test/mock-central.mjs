// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for Pollen's robot rendezvous with one simulated Microduck on
 * it, for testing the game's REAL DUCK link without hardware. It speaks the
 * same messages (see src/robot/rendezvous.ts and microduck-link.ts) and
 * records everything the game sends.
 *
 *   node tools/test/mock-central.mjs [port]      (default 8799)
 *   app: https://localhost:8081/?duckCentral=http://localhost:8799
 *   GET /log    what the duck received (JSON), POST /reset to clear it
 *
 * For a test against Pollen's real daemons, run their scripts/duck-sim
 * signed in to your account and leave ?duckCentral out.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8799);
const SKILLS = new Set(['kick_left', 'kick_right', 'roulade', 'ground_pick', 'sit_toggle']);
const log = [];
const streams = new Set();
let session = null;
let subscription = null;

function emit(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(line);
}

function reply(id, result) {
  if (id === undefined) return;
  emit({ type: 'peer', sessionId: session, rpc: { jsonrpc: '2.0', id, result } });
}

function handleRpc(rpc) {
  const { id, method, params = {} } = rpc;
  log.push({ t: Date.now(), method, params });
  switch (method) {
    case 'robot.subscribe': {
      clearInterval(subscription);
      const hz = Math.min(10, Math.max(1, Number(params.hz) || 4));
      let phase = 0;
      subscription = setInterval(() => {
        phase += 0.3;
        emit({
          type: 'peer',
          sessionId: session,
          rpc: {
            jsonrpc: '2.0',
            method: 'robot.state',
            params: {
              joints: Array.from({ length: 15 }, (_, j) => Math.sin(phase + j) * 0.1),
              targets: Array.from({ length: 15 }, (_, j) => Math.sin(phase + j + 0.2) * 0.1),
              imu: { gyro: [0.01, -0.02, 0.0], quat: [1, 0, 0, 0] },
              safety: { fallen: false, gravity: [0, 0, -1], picked_up: false },
              move: { requested: [0, 0, 0], applied: [0, 0, 0], limited_by: '' },
            },
          },
        });
      }, 1000 / hz);
      return reply(id, { accepted: true });
    }
    case 'robot.health':
      return reply(id, { battery: { volts: 7.9, percent: 82 } });
    case 'robot.move':
      return reply(id, { accepted: true });
    case 'robot.stop':
      return reply(id, { accepted: true });
    case 'robot.do':
      return reply(id, SKILLS.has(params.skill) ? { accepted: true } : { accepted: false, reason: `unknown skill ${params.skill}` });
    case 'policy.fetch':
      return reply(id, { accepted: true, path: `/data/policies/${String(params.repo).replace(/[^\w.-]+/g, '_')}/policy.onnx` });
    case 'robot.loadPolicy':
    case 'robot.setSkill':
      return reply(id, { accepted: true });
    case 'robot.policies':
      return reply(id, { homed: true, change_error: null, skills: [...SKILLS] });
    default:
      return reply(id, { accepted: false, reason: `unknown method ${method}` });
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/log') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(log));
  if (url.pathname === '/reset' && req.method === 'POST') {
    log.length = 0;
    return res.writeHead(200).end('{}');
  }
  if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return res.writeHead(401).end('{"error":"no token"}');
  if (url.pathname === '/api/robot-status') {
    return res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify([{ peerId: 'mock-duck-1', online: true, meta: { kind: 'microduck', name: 'Mock Duck', simulated: true } }]));
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': hello\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    if (message.type === 'startSession') {
      session = `session-${Date.now()}`;
      log.push({ t: Date.now(), method: 'startSession', params: { peerId: message.peerId } });
      emit({ type: 'sessionStarted', sessionId: session, peerId: message.peerId });
    } else if (message.type === 'endSession') {
      clearInterval(subscription);
      log.push({ t: Date.now(), method: 'endSession', params: {} });
      session = null;
    } else if (message.type === 'peer' && message.rpc) {
      handleRpc(message.rpc);
    }
    return;
  }
  res.writeHead(404).end('{}');
});
server.listen(port, '127.0.0.1', () => console.log(`mock central on http://localhost:${port}`));
