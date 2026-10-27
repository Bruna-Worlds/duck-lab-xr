// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The collision-avoidance film's app takes: an emulated mixed-reality session
 * (IWER's sunlit living room) in a 1920 x 1080 browser of its own, the
 * autopilot's driver set to the camera brain, Pip sent from the open side of
 * the real coffee table to a spot behind it, a film camera above the table's
 * open side, and Pip cam's DEPTH feed (the brain's camera picture beside the
 * 8 x 8 depth frame) captured beside it.
 *   TAKE=fail  the camera brain in use drives; when it gets stuck the app
 *              saves the moment as a test case (posted to the dev server:
 *              artifacts/scenarios/)
 *   TAKE=try   the trainer page's new camera brain is offered on Pip cam ("New
 *              brain ready"): the right controller's ray presses TRY IT, then
 *              the same drive on the new brain
 * Writes artifacts/video/avoid/<take>/: frames/ + frames.json, feed/ +
 * feed.json, trace.json (the brain's twist, the nearest zone, Pip's place,
 * the autopilot's status, the app's status line, five times a second) and
 * marks.json.
 *
 *   node tools/film/avoid/record-avoid.mjs        (TAKE, SITE, RUN_S)
 *
 * Needs the dev server (https://localhost:8081).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const TAKE = process.env.TAKE ?? 'fail';
const OUT = process.env.OUT ?? `artifacts/video/avoid/${TAKE}`;
const RUN_S = Number(process.env.RUN_S ?? (TAKE === 'fail' ? 50 : 60));
const W = 1920;
const H = 1080;
const FOVY = 56;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In the page: the film camera (the emulated headset, placed every frame), the feed grabber and the trace. */
function stage() {
  const d = globalThis.__duck;
  const device = globalThis.IWER_DEVICE;
  device.controlMode = 'programmatic';
  for (const layer of [device.devui?.devUIContainer, device.devui?.inputLayer]) if (layer?.style) layer.style.display = 'none';
  for (const el of document.body.children) if (el.shadowRoot) el.style.display = 'none';
  for (const id of ['duck-views', 'duck-controls']) document.getElementById(id)?.style.setProperty('display', 'none');
  device.controllers.left.connected = false;
  device.controllers.right.connected = false;
  const V = d.duck.rig.trunk.position.constructor;
  const M = d.world.camera.matrix.constructor;
  const Q = d.world.camera.quaternion.constructor;
  const eye = new V();
  const look = new V();
  const up = new V(0, 1, 0);
  const m = new M();
  const q = new Q();
  const film = { shot: 'table', smooth: null, hide: [], trace: [], panelEye: null, panelLook: null };
  globalThis.__film = film;
  for (const node of ['run-panel', 'moves-panel', 'menu-panel', 'lab-panel']) {
    try {
      film.hide.push(d.world.requireSceneEntity(node).object3D);
    } catch {
      // not in this level
    }
  }
  if (!d.cam.visible) d.cam.toggle();
  d.cam.setView('depth');
  const tick = () => {
    requestAnimationFrame(tick);
    for (const o of film.hide) if (o) o.visible = false;
    const vacuum = device.sem?.sceneEnvironment?.root?.getObjectByName?.('robot');
    if (vacuum) vacuum.visible = false;
    const robot = d.robotPanel.hostEntity?.object3D;
    if (robot) robot.visible = film.shot === 'offer'; // otherwise its feed is filmed on its own, beside the picture
    d.cam.feedWanted = true;
    if (film.shot === 'offer' && film.panelEye) {
      eye.copy(film.panelEye);
      look.copy(film.panelLook);
    } else {
      // The coffee table (world x -0.58..0.58, z -2.25..-1.65) from above its open side, Pip and the ways round in view.
      eye.set(0.25, 1.35, -0.55);
      look.set(0.1, 0.05, -1.9);
    }
    if (!film.smooth) film.smooth = { eye: eye.clone(), look: look.clone() };
    film.smooth.eye.lerp(eye, 0.06);
    film.smooth.look.lerp(look, 0.1);
    m.lookAt(film.smooth.eye, film.smooth.look, up);
    q.setFromRotationMatrix(m);
    device.position.set(film.smooth.eye.x, film.smooth.eye.y, film.smooth.eye.z);
    device.quaternion.set(q.x, q.y, q.z, q.w);
  };
  requestAnimationFrame(tick);

  // Pip cam's feed (8 frames a second), handed to the recorder as JPEGs.
  const canvas = document.createElement('canvas');
  let lastFrames = -1;
  setInterval(() => {
    const cam = d.cam;
    if (cam.frames === lastFrames) return;
    lastFrames = cam.frames;
    const target = cam.target;
    const w = target.width;
    const h = target.height;
    const px = new Uint8Array(w * h * 4);
    d.world.renderer.readRenderTargetPixels(target, 0, 0, w, h, px);
    // A read outside the render loop now and then comes back empty: keep the last good frame instead.
    let lit = 0;
    for (let i = 0; i < px.length; i += 4 * 97) lit += px[i] + px[i + 1] + px[i + 2];
    if (lit === 0) {
      lastFrames = -1;
      return;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    globalThis.__feedFrame(Date.now() / 1000, canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
  }, 60);
  // The trace, five times a second.
  setInterval(() => {
    const t = d.duck.sim?.tof;
    let nearest = null;
    if (t) {
      nearest = 99;
      for (const z of t.zones) nearest = Math.min(nearest, z);
    }
    film.trace.push({
      t: Date.now() / 1000,
      shot: film.shot,
      driving: !!t?.driving,
      forward: t?.forward ?? 0,
      turn: t?.turn ?? 0,
      nearest,
      at: Array.from(d.duck.pose.slice(0, 2)),
      task: d.nav.task,
      status: d.nav.status,
      stuck: d.nav.stuck,
      driver: d.nav.driver,
      mode: d.duck.sim?.mode,
      falls: d.duck.sim?.stats?.falls ?? 0,
      says: d.duck.status,
      packs: d.scenario.packs,
      scenario: d.scenario.summary,
      brain: d.policyInbox.current?.name ?? null,
      offer: d.policyInbox.offer?.name ?? null,
    });
  }, 200);
}

function setCourse() {
  const d = globalThis.__duck;
  const V = d.duck.rig.trunk.position.constructor;
  d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
  d.nav.setDriver('camera');
}

/** In the page: Pip in front of the coffee table's +x side, facing it; the goal straight through it, on the far side. */
function startDrive() {
  const d = globalThis.__duck;
  const film = globalThis.__film;
  film.shot = 'table';
  film.smooth = null;
  d.nav.stop?.();
  const stageObject = d.duck.stageEntity.object3D;
  stageObject.updateWorldMatrix(true, false);
  const V = d.duck.rig.trunk.position.constructor;
  const toStage = (x, z) => {
    const p = stageObject.worldToLocal(new V(x, 0, z));
    return [p.x, -p.z];
  };
  const [sx, sy] = toStage(1.05, -1.95);
  const inverse = stageObject.matrixWorld.clone().invert();
  const facing = new V(-1, 0, 0).transformDirection(inverse);
  d.duck.sim.teleport(sx, sy, Math.atan2(-facing.z, facing.x));
  const [gx, gy] = toStage(-0.95, -1.95);
  d.nav.goTo(gx, gy, 'behind the coffee table');
}

/** In the page: the camera in front of Pip cam's panel; where the TRY IT button is (world). */
function aimAtOffer() {
  const d = globalThis.__duck;
  const film = globalThis.__film;
  const panel = d.robotPanel.hostEntity.object3D;
  panel.updateWorldMatrix(true, true);
  const V = panel.position.constructor;
  const centre = panel.getWorldPosition(new V());
  const facing = new V(0, 0, 1).transformDirection(panel.matrixWorld);
  const button = d.world.getSceneObject('robot-panel')?.getElementById?.('rp-offer-try') ?? null;
  const target = button ? button.getWorldPosition(new V()) : centre.clone();
  film.panelLook = centre.clone().lerp(target, 0.3);
  film.panelEye = film.panelLook.clone().addScaledVector(facing, 0.95);
  film.panelEye.y += 0.04;
  film.shot = 'offer';
  film.smooth = null;
  return { target: target.toArray(), eye: film.panelEye.toArray() };
}

/** In the page: the right controller below and right of the eye, its ray on `target`. */
function pointAt(target) {
  const device = globalThis.IWER_DEVICE;
  const film = globalThis.__film;
  const d = globalThis.__duck;
  const V = d.duck.rig.trunk.position.constructor;
  const M = d.world.camera.matrix.constructor;
  const Q = d.world.camera.quaternion.constructor;
  const eye = film.panelEye;
  const t = new V(...target);
  const forward = t.clone().sub(eye).normalize();
  const right = new V().crossVectors(forward, new V(0, 1, 0)).normalize();
  const hand = eye.clone().addScaledVector(right, 0.16).add(new V(0, -0.2, 0)).addScaledVector(forward, 0.12);
  const m = new M().lookAt(hand, t, new V(0, 1, 0));
  const q = new Q().setFromRotationMatrix(m);
  const c = device.controllers.right;
  c.connected = true;
  c.position.set(hand.x, hand.y, hand.z);
  c.quaternion.set(q.x, q.y, q.z, q.w);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'frames'), { recursive: true });
mkdirSync(join(OUT, 'feed'), { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const feed = [];
  await page.exposeFunction('__feedFrame', (t, b64) => {
    const file = `g${String(feed.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(OUT, 'feed', file), Buffer.from(b64, 'base64'));
    feed.push({ file, t });
  });
  await page.goto(`${SITE}?demoReset=1`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.IWER_DEVICE?.sessionOffered === true, null, { timeout: 180000, polling: 500 });
  await page.evaluate((fovy) => {
    const device = globalThis.IWER_DEVICE;
    device.fovy = (fovy * Math.PI) / 180;
    device.grantOfferedSession();
  }, FOVY);
  await page.waitForFunction(() => !!globalThis.__duck.world.session && ['placed', 'tight'].includes(globalThis.__duck.room.state), null, { timeout: 120000, polling: 500 });
  await page.waitForFunction(() => globalThis.__duck.playgrounds.current === 'living-room-dash' && !globalThis.__duck.playgrounds.loading, null, { timeout: 120000, polling: 500 }).catch(async () => {
    await page.evaluate(() => globalThis.__duck.playgrounds.load('living-room-dash'));
  });
  await wait(2000);
  await page.evaluate(setCourse);
  await wait(1500);
  await page.evaluate(stage);
  // Wake Pip with a held W (real input), then let it settle.
  await page.keyboard.down('KeyW');
  await wait(1200);
  await page.keyboard.up('KeyW');
  await wait(2500);

  const cdp = await context.newCDPSession(page);
  const frames = [];
  let count = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = `f${String(count++).padStart(6, '0')}.jpg`;
    writeFileSync(join(OUT, 'frames', file), Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const marks = [];
  const mark = async (name) => {
    const t = await page.evaluate(() => Date.now() / 1000);
    marks.push({ name, t });
    console.log(`${new Date().toISOString().slice(11, 19)} ${name}`);
  };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });

  if (TAKE === 'try') {
    // The offer: wait for the release the trainer page sent, then press TRY IT with the controller's ray.
    await page.waitForFunction(() => !!globalThis.__duck.policyInbox.offer, null, { timeout: 60000, polling: 500 });
    const aim = await page.evaluate(aimAtOffer);
    await wait(600);
    await mark('offer');
    await wait(2200);
    await page.evaluate(pointAt, aim.target);
    await wait(1400);
    await page.evaluate(() => globalThis.IWER_DEVICE.controllers.right.updateButtonValue('trigger', 1));
    await wait(160);
    await page.evaluate(() => globalThis.IWER_DEVICE.controllers.right.updateButtonValue('trigger', 0));
    const pressed = await page
      .waitForFunction(() => globalThis.__duck.policyInbox.busy || !!globalThis.__duck.policyInbox.current, null, { timeout: 4000, polling: 100 })
      .then(() => true)
      .catch(() => false);
    if (!pressed) {
      console.log('  the ray did not reach TRY IT: accepting through the inbox instead');
      await page.evaluate(() => globalThis.__duck.policyInbox.accept());
    }
    await mark('pressed');
    await page.waitForFunction(() => !!globalThis.__duck.policyInbox.current && !globalThis.__duck.policyInbox.busy, null, { timeout: 60000, polling: 250 });
    await wait(2500);
    await mark('offer-end');
    await page.evaluate(() => {
      globalThis.IWER_DEVICE.controllers.right.connected = false;
    });
  }

  await page.evaluate(startDrive);
  await mark('drive');
  const t0 = Date.now();
  let packedAt = 0;
  while (Date.now() - t0 < RUN_S * 1000) {
    await wait(500);
    const s = await page.evaluate(() => ({ task: globalThis.__duck.nav.task, status: globalThis.__duck.nav.status, packs: globalThis.__duck.scenario.packs, says: globalThis.__duck.duck.status }));
    if (!s.task) {
      console.log(`  ${s.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      await mark('arrived');
      await wait(3000);
      break;
    }
    if (TAKE === 'fail' && s.packs > 0 && !packedAt) {
      packedAt = Date.now();
      await mark('packed');
      console.log(`  ${s.says}`);
    }
    if (packedAt && Date.now() - packedAt > 5000) break;
  }
  await mark('drive-end');
  await cdp.send('Page.stopScreencast');
  const trace = await page.evaluate(() => globalThis.__film.trace);
  await page.evaluate(() => globalThis.__duck.nav.stop());
  writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames));
  writeFileSync(join(OUT, 'feed.json'), JSON.stringify(feed));
  writeFileSync(join(OUT, 'trace.json'), JSON.stringify(trace));
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  const last = trace.at(-1);
  console.log(`frames ${frames.length} over ${span.toFixed(1)} s, feed ${feed.length}, falls ${(last?.falls ?? 0) - (trace[0]?.falls ?? 0)}, driver ${last?.driver}, brain ${last?.brain ?? 'shipped'}, packs ${last?.packs}, ${last?.status}`);
} finally {
  await browser.close();
}
console.log(`errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
