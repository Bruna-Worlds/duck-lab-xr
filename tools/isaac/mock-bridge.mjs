// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A stand-in for Isaac Sim's Duck Lab XR bridge (tools/isaac/exts), for
 * testing the game's Isaac Sim link without Isaac Sim. It speaks the same
 * WebSocket messages and records what arrives; there is no stream.
 *
 *   node tools/isaac/mock-bridge.mjs [port]      (default 8219)
 *   app: https://localhost:8081/?isaac=127.0.0.1:8219
 *   GET /log    what arrived (JSON), POST /reset to clear it
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8219);
/** Like Kit's web server (uvicorn 0.12 with the websockets default): longer messages close the socket (1009). */
const MAX_MESSAGE = 1024 * 1024;
const fresh = () => ({
  connections: 0,
  messages: {},
  tooBig: 0,
  parts: 0,
  scene: null,
  terrainUpdates: 0,
  duck: null,
  triangles: {},
  poses: 0,
  firstPoseAt: 0,
  lastPoseAt: 0,
  lastPose: null,
  ball: null,
  follow: null,
  ui: null,
  origin: null,
});
let log = fresh();

const server = createServer((req, res) => {
  if (req.url === '/log') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(log));
  } else if (req.url === '/reset' && req.method === 'POST') {
    log = fresh();
    res.writeHead(204).end();
  } else {
    res.writeHead(404).end();
  }
});

server.on('upgrade', (req, socket) => {
  if (!req.url?.startsWith('/ducklab/ws')) return socket.destroy();
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  log.connections++;
  log.origin = req.headers.origin ?? null;
  const send = (object) => socket.write(frame(Buffer.from(JSON.stringify(object))));
  send({ type: 'hello', bridge: 'stand-in', app: 'Stand-in bridge', appVersion: '0', stage: 'none' });
  let pending = Buffer.alloc(0);
  let parts = [];
  const slices = new Map();
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const f = parse(pending);
      if (!f) break;
      pending = pending.subarray(f.size);
      if (f.opcode === 8) return socket.end(frame(Buffer.alloc(0), 8));
      if (f.opcode === 9) socket.write(frame(f.payload, 10));
      if (f.opcode === 0 || f.opcode === 1 || f.opcode === 2) {
        parts.push(f);
        if (!f.fin) continue;
        const opcode = parts[0].opcode;
        const payload = Buffer.concat(parts.map((p) => p.payload));
        parts = [];
        if (payload.length > MAX_MESSAGE) {
          log.tooBig++;
          return socket.end(frame(Buffer.from([0x03, 0xf1]), 8)); // 1009: message too big
        }
        if (opcode === 2) pose(payload);
        else {
          let message = JSON.parse(payload.toString('utf8'));
          if (message.type === 'part') {
            log.parts++;
            const got = slices.get(message.id) ?? [];
            got[message.index] = message.data;
            slices.set(message.id, got);
            if (got.filter((s) => s !== undefined).length < message.count) continue;
            slices.delete(message.id);
            message = JSON.parse(got.join(''));
          }
          const reply = handle(message);
          if (reply) send(reply);
        }
      }
    }
  });
  socket.on('error', () => {});
});

function handle(message) {
  log.messages[message.type] = (log.messages[message.type] ?? 0) + 1;
  if (message.type === 'scene') {
    const t = message.terrain;
    log.scene = {
      statics: message.statics.length,
      kinds: count(message.statics.map((s) => s.kind)),
      names: message.statics.map((s) => s.name).filter(Boolean).slice(0, 40),
      terrain: t ? { rows: t.rows, cols: t.cols, half: t.half, elev: t.elev, raised: raised(t) } : null,
    };
    return { type: 'ack', of: 'scene', statics: message.statics.length };
  }
  if (message.type === 'terrain') {
    log.terrainUpdates++;
    if (log.scene && message.terrain) log.scene.terrain = { ...log.scene.terrain, raised: raised(message.terrain) };
    return { type: 'ack', of: 'terrain' };
  }
  if (message.type === 'duck') {
    log.duck = { bodies: message.bodies, ball: message.ball ?? null };
    log.triangles = {};
    return { type: 'ack', of: 'duck', bodies: message.bodies.length };
  }
  if (message.type === 'duck-body') {
    let triangles = 0;
    for (const part of message.meshes) triangles += Buffer.from(part.points, 'base64').length / 36;
    log.triangles[message.name] = triangles;
    return { type: 'ack', of: 'duck-body', name: message.name, triangles };
  }
  if (message.type === 'view') {
    log.ui = message.ui;
    return { type: 'ack', of: 'view', ui: message.ui };
  }
  if (message.type === 'camera') {
    log.follow = message.follow;
    return { type: 'ack', of: 'camera', follow: message.follow };
  }
  return { type: 'error', message: `unknown message type ${message.type}` };
}

function pose(payload) {
  const values = new Float32Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length));
  const now = Date.now();
  if (!log.firstPoseAt) log.firstPoseAt = now;
  log.lastPoseAt = now;
  log.poses++;
  const n = values.length / 7;
  log.lastPose = { bodies: n - 1, trunk: Array.from(values.subarray(0, 7)) };
  const ball = Array.from(values.subarray((n - 1) * 7));
  log.ball = Number.isNaN(ball[0]) ? null : ball;
}

function raised(t) {
  const h = new Float32Array(new Uint8Array(Buffer.from(t.heights, 'base64')).buffer);
  let n = 0;
  for (const v of h) if (v * t.elev > 0.004) n++;
  return n;
}

function count(list) {
  const out = {};
  for (const k of list) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** One WebSocket frame from the client (masked), or null until it is all here. */
function parse(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskAt = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
  return { fin, opcode, payload, size: offset + length };
}

/** One unmasked frame from the server. */
function frame(payload, opcode = 1) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(n)]);
  return Buffer.concat([head, payload]);
}

function bigLength(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

server.listen(port, '127.0.0.1', () => console.log(`stand-in Isaac Sim bridge on ws://127.0.0.1:${port}/ducklab/ws (GET /log)`));
