// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Isaac Sim link against a real Isaac Sim running the Duck Lab XR bridge
 * (tools/isaac): the app must already be open with ?isaac (on the desktop page,
 * or in mixed reality through tools/test/mr.sh). Reads the bridge's own
 * status and compares it with the app, and saves Isaac Sim's view to
 * artifacts/isaac-live.png. The data must go over the stream's data channel
 * when Isaac Sim has one (4.x), else over the WebSocket; TRANSPORT=socket or
 * =channel expects one (with the app opened with ?isaac-data= to match).
 *
 *   GOTO="https://localhost:8081/?isaac" npx @iwsdk/cli browser run tools/test/goto.mjs
 *   npx @iwsdk/cli browser run tools/test/isaac-live-check.mjs --timeout 100000
 *   bash tools/test/mr.sh tools/test/isaac-live-check.mjs      (mixed reality: the room and the terrain)
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const BRIDGE = process.env.ISAAC ?? 'http://127.0.0.1:8211';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const status = async () => (await fetch(`${BRIDGE}/ducklab/status`)).json();

export default async function run({ page, frame }) {
  const target = frame ?? page;
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} - ${detail}`);
  };
  // Up: the link is live and the first poses are in.
  let app = null;
  for (let i = 0; i < 60; i++) {
    app = await target.evaluate(() => {
      const d = globalThis.__duck;
      return d?.isaac ? { enabled: d.isaac.enabled, state: d.isaac.state, ready: !!d.duck.sim?.ready, sent: d.isaac.framesSent } : null;
    });
    if (app?.state === 'live' && app.sent > 30) break;
    await sleep(500);
  }
  if (!app?.enabled) throw new Error('the app is not open with ?isaac');
  // The scene goes over within its 2 s check; Pip's meshes take 10 to 20 s over 4.5's data channel.
  const drawn = await target.evaluate(() => globalThis.__duck.duck.rig?.triangles ?? 0);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (i >= 2 && (await status()).triangles >= drawn) break;
  }
  await sleep(4000); // and RTX loads the new meshes before the view is saved
  const scene = await target.evaluate(async () => {
    const d = globalThis.__duck;
    const s = await d.duck.sim.scene();
    let raised = 0;
    if (s.terrain) for (const h of s.terrain.heights) if (h * s.terrain.elev > 0.004) raised++;
    return {
      shapes: s.shapes.length,
      raised,
      triangles: d.duck.rig?.triangles ?? 0,
      immersive: d.world.visibilityState.peek() !== 'non-immersive',
      stream: d.isaac.stream,
      bridge: d.isaac.bridge,
      transport: d.isaac.transport,
    };
  });
  const a = await status();
  await sleep(3000);
  const b = await status();
  check('connected to Isaac Sim', a.connected && !!scene.bridge, `${scene.bridge?.app} ${scene.bridge?.appVersion}, bridge ${a.bridge}, ${b.connections} connection(s) so far`);
  check('every static shape is in the stage', b.statics === scene.shapes, `${b.statics} of ${scene.shapes} shapes under ${b.root}`);
  check("Pip's bodies and every triangle are in the stage", b.bodies >= 10 && b.triangles === scene.triangles, `${b.bodies} bodies, ${b.triangles} of ${scene.triangles} triangles`);
  const rate = (b.poses - a.poses) / 3;
  check('poses arrive about 30 times a second', rate > 24 && rate < 36 && b.lastPoseAgoMs !== null && b.lastPoseAgoMs < 200, `${rate.toFixed(1)} poses/s, the last ${b.lastPoseAgoMs} ms ago`);
  check(
    'the terrain is in the stage when it has raised cells',
    scene.raised === 0 ? b.terrainFaces === 0 : b.terrainFaces > 0,
    `${scene.raised} raised cells in the app, ${b.terrainFaces} terrain faces in Isaac Sim${scene.immersive ? ' (mixed reality)' : ''}`,
  );
  const transport = process.env.TRANSPORT ?? (b.stream === 'library' ? 'channel' : 'socket');
  check(
    `the data goes over the ${transport === 'channel' ? "stream's data channel" : 'WebSocket'}`,
    b.transport === transport && scene.transport === transport,
    `app ${scene.transport}, bridge ${b.transport}, Isaac Sim's stream: ${b.stream ?? 'none'} (Kit ${b.kit})`,
  );
  check('the stream plays in the ISAAC SIM window', scene.stream === 'playing', `stream ${scene.stream}`);
  // A freshly started Isaac Sim draws flat grey (about 70 KB) until RTX has loaded the new meshes: wait for a real view.
  let shot = null;
  let bytes = Buffer.alloc(0);
  for (let i = 0; i < 8; i++) {
    if (i) await sleep(5000);
    shot = await fetch(`${BRIDGE}/ducklab/capture`);
    bytes = Buffer.from(await shot.arrayBuffer());
    if (shot.ok && bytes.length > 150000) break;
  }
  mkdirSync('artifacts', { recursive: true });
  if (shot.ok) writeFileSync('artifacts/isaac-live.png', bytes);
  check("Isaac Sim's view saved", shot.ok && bytes.length > 150000, `artifacts/isaac-live.png, ${(bytes.length / 1024).toFixed(0)} KB (a blank view is about 70 KB)`);
  const passed = results.filter(Boolean).length;
  console.log(JSON.stringify({ passed, failed: results.length - passed }));
  return { passed, failed: results.length - passed };
}
