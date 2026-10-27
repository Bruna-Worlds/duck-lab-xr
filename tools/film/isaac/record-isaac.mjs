// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Isaac Sim film's take, in a browser of its own, on one clock:
 *   app    Duck Lab XR in an emulated mixed-reality session (1080 x 1000) with
 *          ?isaac, so it drives the Isaac Sim bridge (tools/isaac), filmed over
 *          the DevTools screencast
 *   isaac  Isaac Sim's WebRTC stream (1280 x 720). Isaac Sim streams to one
 *          viewer: with Isaac Sim 4.x that is the app's own player, which also
 *          carries the app's data up the same connection, and its incoming
 *          video is recorded as it arrives (MediaRecorder, isaac/stream.webm);
 *          with 2022.2 the app's window is left empty and the stream plays in a
 *          page of its own (public/isaac/player.html), screencast like the app
 * Shots, scripted in the app:
 *   walk    Pip walks the course; Isaac Sim's camera follows it
 *   room    the whole room, from the seat in the app, from above in Isaac Sim
 *   editor  Isaac Sim's own panels (ISAAC UI): the real editor, the stage tree
 * Frames go to artifacts/video/isaac/take/{app,isaac}/ with frames.json
 * (timestamps), marks.json and info.json; compose-isaac.mjs makes the film.
 *
 *   node tools/film/isaac/record-isaac.mjs
 *
 * Needs the dev server (https://localhost:8081) and Isaac Sim with the bridge
 * (tools/isaac/start-isaac-sim.ps1). Its browser profile is thrown away.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const ISAAC = process.env.ISAAC ?? '127.0.0.1:8211';
const OUT = 'artifacts/video/isaac/take';
const APP = { w: 1080, h: 1000 };
const STREAM = { w: 1280, h: 720 };
const FOVY = 62; // degrees, vertical: a film lens, not the headset's 90
const SHOTS = [
  { name: 'walk', seconds: 13 },
  { name: 'room', seconds: 9 },
  { name: 'editor', seconds: 6 },
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In the app: the film camera, a loop that places the emulated headset every frame. */
function stage() {
  const d = globalThis.__duck;
  const device = globalThis.IWER_DEVICE;
  device.controlMode = 'programmatic';
  for (const layer of [device.devui?.devUIContainer, device.devui?.inputLayer]) if (layer?.style) layer.style.display = 'none';
  for (const el of document.body.children) if (el.shadowRoot) el.style.display = 'none';
  for (const id of ['duck-views', 'duck-controls', 'duck-isaac']) document.getElementById(id)?.style.setProperty('display', 'none');
  device.controllers.left.connected = false;
  device.controllers.right.connected = false;
  const V = d.duck.rig.trunk.position.constructor;
  d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
  const M = d.world.camera.matrix.constructor;
  const Q = d.world.camera.quaternion.constructor;
  const duck = new V();
  const eye = new V();
  const look = new V();
  const along = new V();
  const side = new V();
  const up = new V(0, 1, 0);
  const m = new M();
  const q = new Q();
  const film = { shot: 'walk', smooth: null, hide: [] };
  globalThis.__film = film;
  for (const node of ['run-panel', 'moves-panel', 'menu-panel']) {
    try {
      film.hide.push(d.world.requireSceneEntity(node).object3D);
    } catch {
      // not in this level
    }
  }
  const tick = () => {
    requestAnimationFrame(tick);
    for (const o of film.hide) if (o) o.visible = false;
    const vacuum = device.sem?.sceneEnvironment?.root?.getObjectByName?.('robot');
    if (vacuum) vacuum.visible = false; // in neither the scan nor depth: out of the film
    const robot = d.robotPanel.hostEntity?.object3D;
    if (robot) robot.visible = false;
    const trunk = d.duck.rig?.trunk;
    const stageObject = d.duck.stageEntity?.object3D;
    if (!trunk || !stageObject) return;
    trunk.getWorldPosition(duck);
    stageObject.updateWorldMatrix(true, false);
    along.set(1, 0, 0).transformDirection(stageObject.matrixWorld);
    side.set(0, 0, -1).transformDirection(stageObject.matrixWorld);
    if (film.shot === 'room') {
      // The seat of the earlier films: the room, the course and Pip in one view.
      eye.set(-0.35, 1.5, -0.4);
      look.set(2.12, 0.55, -0.9);
    } else {
      eye.copy(duck).addScaledVector(side, 0.85).addScaledVector(along, 0.3);
      eye.y = 0.5;
      look.copy(duck).addScaledVector(along, 0.12);
      look.y = 0.1;
    }
    if (!film.smooth) film.smooth = { eye: eye.clone(), look: look.clone() };
    film.smooth.eye.lerp(eye, 0.1);
    film.smooth.look.lerp(look, 0.14);
    m.lookAt(film.smooth.eye, film.smooth.look, up);
    q.setFromRotationMatrix(m);
    device.position.set(film.smooth.eye.x, film.smooth.eye.y, film.smooth.eye.z);
    device.quaternion.set(q.x, q.y, q.z, q.w);
  };
  requestAnimationFrame(tick);
}

/** In the app: the cameras (the film's and Isaac Sim's) for one shot. */
async function startShot(name) {
  const d = globalThis.__duck;
  const film = globalThis.__film;
  film.shot = name;
  film.smooth = null; // a cut, not a glide
  if (name === 'walk') {
    d.isaac.setIsaacUi(false);
    d.isaac.setFollow(true);
    d.nav.runCourse();
  } else if (name === 'room') {
    // Isaac Sim from above the course and Pip (the stage's MuJoCo frame).
    const s = await d.duck.sim.scene();
    const xs = [];
    const ys = [];
    for (const shape of s.shapes) if (shape.kind !== 'plane') { xs.push(shape.pos[0]); ys.push(shape.pos[1]); }
    xs.push(d.duck.pose[0]);
    ys.push(d.duck.pose[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2);
    d.isaac.lookAt([cx - span * 0.55, cy - span * 0.75, span * 0.95], [cx, cy, 0]);
  } else if (name === 'editor') {
    d.isaac.setFollow(true);
    d.isaac.setIsaacUi(true);
  }
}

// Isaac Sim 4.x's stream (NVIDIA's library) carries the app's data: the app's own player must stay.
const bridge = await (await fetch(`http://${ISAAC}/ducklab/status`)).json();
const OVER_CHANNEL = bridge.stream === 'library';
console.log(`Isaac Sim's stream: ${bridge.stream} (Kit ${bridge.kit})`);
rmSync(OUT, { recursive: true, force: true });
for (const take of ['app', 'isaac']) mkdirSync(join(OUT, take, 'frames'), { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 1 });
  const app = await context.newPage();
  await app.setViewportSize({ width: APP.w, height: APP.h });
  app.on('pageerror', (e) => errors.push(`app: ${e.message}`));
  const chunks = [];
  if (OVER_CHANNEL) {
    // The recorder in the app's player hands its video over in chunks.
    await app.exposeFunction('__filmChunk', (b64) => {
      chunks.push(Buffer.from(b64, 'base64'));
    });
  } else {
    // 2022.2: the app's own Isaac window stays empty (Isaac Sim streams to one viewer: the other page).
    await app.route('**/isaac/player.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>off</title>' }));
  }
  await app.goto(`${SITE}?isaac=${ISAAC}&demoReset=1`, { waitUntil: 'load', timeout: 60000 });
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.IWER_DEVICE?.sessionOffered === true, null, { timeout: 90000 });
  await app.evaluate((fovy) => {
    const device = globalThis.IWER_DEVICE;
    device.fovy = (fovy * Math.PI) / 180;
    device.grantOfferedSession();
  }, FOVY);
  await app.waitForFunction(() => !!globalThis.__duck.world.session && ['placed', 'tight'].includes(globalThis.__duck.room.state), null, { timeout: 60000 });
  await app.waitForFunction(() => globalThis.__duck.isaac.state === 'live' && globalThis.__duck.isaac.framesSent > 30, null, { timeout: 90000 });
  const link = await app.evaluate(() => ({ transport: globalThis.__duck.isaac.transport, hello: globalThis.__duck.isaac.bridge, triangles: globalThis.__duck.duck.rig.triangles }));
  console.log(`linked to ${link.hello.app} ${link.hello.appVersion} over the ${link.transport}`);
  // Pip's meshes take a while over the data channel, and RTX a while more to draw them.
  for (let i = 0; i < 90; i++) {
    const now = await (await fetch(`http://${ISAAC}/ducklab/status`)).json();
    if (now.triangles >= link.triangles) break;
    await wait(1000);
  }
  for (let i = 0; i < 12; i++) {
    const view = await fetch(`http://${ISAAC}/ducklab/capture`);
    if (view.ok && (await view.arrayBuffer()).byteLength > 150000) break;
    await wait(3000);
  }
  await wait(2500);
  await app.evaluate(stage);
  // Wake Pip (a fresh visit starts it sitting): a held W, as a player would.
  await app.keyboard.down('KeyW');
  await wait(1500);
  await app.keyboard.up('KeyW');
  await wait(3000); // the moved course reaches Isaac Sim with the next scene check

  // Isaac Sim's stream: the app's own player (4.x), or a page of its own (2022.2).
  let isaac = null;
  const player = OVER_CHANNEL ? app.frames().find((frame) => frame.url().includes('isaac/player.html')) : null;
  if (OVER_CHANNEL) {
    if (!player) throw new Error("the app's Isaac Sim player is not there");
    await player.waitForFunction(() => {
      const v = document.getElementById('remote-video');
      return v && v.videoWidth > 0 && v.srcObject;
    }, null, { timeout: 60000 });
  } else {
    isaac = await context.newPage();
    await isaac.setViewportSize({ width: STREAM.w, height: STREAM.h });
    isaac.on('pageerror', (e) => errors.push(`isaac: ${e.message}`));
    const [host, port] = ISAAC.split(':');
    await isaac.goto(`${SITE}isaac/player.html?server=${host}&port=${port ?? 8211}`, { waitUntil: 'load', timeout: 60000 });
    await isaac.waitForFunction(() => {
      const v = document.getElementById('remote-video');
      return v && v.videoWidth > 0 && v.currentTime > 1;
    }, null, { timeout: 60000 });
  }

  // Film both.
  let recStart = 0;
  if (OVER_CHANNEL) {
    // The stream's video as it arrives, from the very connection that carries the app's data up.
    recStart = await player.evaluate(() => {
      const v = document.getElementById('remote-video');
      const video = new MediaStream(v.srcObject.getVideoTracks());
      const rec = new MediaRecorder(video, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 16e6 });
      const pending = [];
      rec.ondataavailable = (e) => {
        pending.push(
          e.data.arrayBuffer().then((buffer) => {
            const bytes = new Uint8Array(buffer);
            let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return globalThis.__filmChunk(btoa(text));
          }),
        );
      };
      globalThis.__filmStop = () =>
        new Promise((resolve) => {
          rec.onstop = () => setTimeout(() => Promise.all(pending).then(resolve), 300);
          rec.stop();
        });
      rec.start(1000);
      return Date.now() / 1000;
    });
  }
  const takes = {};
  for (const [name, page, size] of [['app', app, APP], ['isaac', isaac, STREAM]]) {
    if (!page) continue;
    const cdp = await context.newCDPSession(page);
    const frames = [];
    let count = 0;
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = `f${String(count++).padStart(6, '0')}.jpg`;
      writeFileSync(join(OUT, name, 'frames', file), Buffer.from(data, 'base64'));
      frames.push({ file, t: metadata.timestamp });
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    takes[name] = { cdp, frames };
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: size.w, maxHeight: size.h, everyNthFrame: 1 });
  }
  const marks = [];
  const mark = async (name) => {
    marks.push({ name, t: await app.evaluate(() => Date.now() / 1000) });
    console.log(`shot ${name}`);
  };
  await wait(800);
  for (const shot of SHOTS) {
    await app.evaluate(startShot, shot.name);
    await mark(shot.name);
    await wait(shot.seconds * 1000);
  }
  await mark('end');
  for (const take of Object.values(takes)) await take.cdp.send('Page.stopScreencast');
  if (OVER_CHANNEL) {
    await player.evaluate(() => globalThis.__filmStop());
    writeFileSync(join(OUT, 'isaac', 'stream.webm'), Buffer.concat(chunks));
    console.log(`isaac: ${(Buffer.concat(chunks).length / 1e6).toFixed(1)} MB of the stream's video, recorded in the app's player`);
  }
  writeFileSync(
    join(OUT, 'info.json'),
    JSON.stringify({ isaac: `${link.hello.app} ${link.hello.appVersion}`, version: link.hello.appVersion, transport: link.transport, stream: OVER_CHANNEL ? 'webm' : 'frames', recStart }, null, 1),
  );
  await app.evaluate(() => {
    const d = globalThis.__duck;
    d.isaac.setIsaacUi(false);
    d.isaac.setFollow(true);
    d.nav.stop?.();
  });
  for (const [name, take] of Object.entries(takes)) {
    writeFileSync(join(OUT, name, 'frames.json'), JSON.stringify(take.frames));
    const span = take.frames.length > 1 ? take.frames[take.frames.length - 1].t - take.frames[0].t : 0;
    console.log(`${name}: ${take.frames.length} frames over ${span.toFixed(1)} s (${(take.frames.length / Math.max(span, 1e-3)).toFixed(1)} fps)`);
  }
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
} finally {
  await browser.close();
}
console.log(`errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
