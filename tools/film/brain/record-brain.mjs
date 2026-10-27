// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The depth brain demo's live shots: an emulated mixed-reality session (IWER's
 * sunlit living room) in a 1920 x 1080 browser of its own, the autopilot's
 * driver set to the depth brain, a film camera that follows Pip, and Pip cam's
 * DEPTH feed (the head distance sensor's 8 x 8 frame) captured beside it.
 *   course   the autopilot runs the course, the brain steering round the pieces
 *   table    sent to a spot behind the real coffee table: it finds its way round
 * Writes artifacts/video/brain/take/: frames/ + frames.json (timestamps),
 * feed/ + feed.json, trace.json (the brain's twist, the nearest zone, Pip's
 * place, the autopilot's status, five times a second) and marks.json.
 * compose-brain.mjs makes the film.
 *
 *   node tools/film/brain/record-brain.mjs        (SITE, COURSE_S, TABLE_S, DRIVER)
 *
 * DRIVER: depth (default) or camera (the camera brain, nav-camera.onnx; take-camera/).
 *
 * Needs the dev server (https://localhost:8081) and public/policies/ducklab/nav.onnx.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const DRIVER = process.env.DRIVER ?? 'depth';
const OUT = process.env.TAKE ?? (DRIVER === 'depth' ? 'artifacts/video/brain/take' : `artifacts/video/brain/take-${DRIVER}`);
const W = 1920;
const H = 1080;
const FOVY = 56;
const COURSE_S = Number(process.env.COURSE_S ?? 75);
const TABLE_S = Number(process.env.TABLE_S ?? 40);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In the page: the film camera (the emulated headset, placed every frame), the feed grabber and the trace. */
function stage(driver) {
  const d = globalThis.__duck;
  const device = globalThis.IWER_DEVICE;
  device.controlMode = 'programmatic';
  for (const layer of [device.devui?.devUIContainer, device.devui?.inputLayer]) if (layer?.style) layer.style.display = 'none';
  for (const el of document.body.children) if (el.shadowRoot) el.style.display = 'none';
  for (const id of ['duck-views', 'duck-controls']) document.getElementById(id)?.style.setProperty('display', 'none');
  device.controllers.left.connected = false;
  device.controllers.right.connected = false;
  const V = d.duck.rig.trunk.position.constructor;
  d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
  d.nav.setDriver(driver);
  if (!d.cam.visible) d.cam.toggle();
  d.cam.setView('depth');
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
  const film = { shot: 'course', smooth: null, hide: [], trace: [] };
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
    if (vacuum) vacuum.visible = false;
    const robot = d.robotPanel.hostEntity?.object3D;
    if (robot) robot.visible = false; // its feed is filmed on its own, beside the picture
    d.cam.feedWanted = true;
    const trunk = d.duck.rig?.trunk;
    const stageObject = d.duck.stageEntity?.object3D;
    if (!trunk || !stageObject) return;
    trunk.getWorldPosition(duck);
    stageObject.updateWorldMatrix(true, false);
    along.set(1, 0, 0).transformDirection(stageObject.matrixWorld); // the way the course runs
    side.set(0, 0, -1).transformDirection(stageObject.matrixWorld); // the room's open side of it
    if (film.shot === 'course') {
      eye.copy(duck).addScaledVector(side, 1.05).addScaledVector(along, -0.35);
      eye.y = 0.75;
      look.copy(duck).addScaledVector(along, 0.25);
      look.y = 0.08;
    } else {
      // The coffee table (world x -0.58..0.58, z -2.25..-1.65) from above its open side, Pip and the way round in view.
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
      left: d.nav.waypoints?.length ?? 0,
      mode: d.duck.sim?.mode,
      falls: d.duck.sim?.stats?.falls ?? 0,
    });
  }, 200);
}

/** In the page: Pip and the camera for one shot. */
function startShot(name) {
  const d = globalThis.__duck;
  const film = globalThis.__film;
  film.shot = name;
  film.smooth = null; // a cut, not a glide
  d.nav.stop?.();
  const stageObject = d.duck.stageEntity.object3D;
  stageObject.updateWorldMatrix(true, false);
  const V = d.duck.rig.trunk.position.constructor;
  const toStage = (x, z) => {
    const p = stageObject.worldToLocal(new V(x, 0, z));
    return [p.x, -p.z];
  };
  if (name === 'course') {
    d.duck.sim.teleport(0, 0, 0);
    d.nav.runCourse();
  } else {
    // In front of the coffee table's +x side, facing it; the goal straight through it, on the far side.
    const [sx, sy] = toStage(1.05, -1.95);
    const inverse = stageObject.matrixWorld.clone().invert();
    const facing = new V(-1, 0, 0).transformDirection(inverse);
    d.duck.sim.teleport(sx, sy, Math.atan2(-facing.z, facing.x));
    const [gx, gy] = toStage(-0.95, -1.95);
    d.nav.goTo(gx, gy, 'behind the coffee table');
  }
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
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.IWER_DEVICE?.sessionOffered === true, null, { timeout: 120000 });
  await page.evaluate((fovy) => {
    const device = globalThis.IWER_DEVICE;
    device.fovy = (fovy * Math.PI) / 180;
    device.grantOfferedSession();
  }, FOVY);
  await page.waitForFunction(() => !!globalThis.__duck.world.session && ['placed', 'tight'].includes(globalThis.__duck.room.state), null, { timeout: 90000 });
  await wait(2500);
  await page.evaluate(stage, DRIVER);
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
    console.log(`${new Date().toISOString().slice(11, 19)} shot ${name}`);
  };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  for (const [name, seconds] of [
    ['course', COURSE_S],
    ['table', TABLE_S],
  ]) {
    await page.evaluate(startShot, name);
    await mark(name);
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      await wait(500);
      const s = await page.evaluate(() => ({ task: globalThis.__duck.nav.task, status: globalThis.__duck.nav.status }));
      if (!s.task) {
        console.log(`  ${name}: ${s.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        await wait(2000);
        break;
      }
    }
    await mark(`${name}-end`);
  }
  await cdp.send('Page.stopScreencast');
  const trace = await page.evaluate(() => globalThis.__film.trace);
  await page.evaluate(() => globalThis.__duck.nav.stop());
  writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames));
  writeFileSync(join(OUT, 'feed.json'), JSON.stringify(feed));
  writeFileSync(join(OUT, 'trace.json'), JSON.stringify(trace));
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  const driving = trace.filter((s) => s.driving).length;
  console.log(`frames ${frames.length} over ${span.toFixed(1)} s, feed ${feed.length}, trace ${trace.length} (${driving} driving), falls ${(trace.at(-1)?.falls ?? 0) - (trace[0]?.falls ?? 0)}`);
} finally {
  await browser.close();
}
console.log(`errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
