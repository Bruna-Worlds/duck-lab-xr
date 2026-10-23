// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The social film's live shots: an emulated mixed-reality session in a
 * portrait browser of its own (1080 x 1920; the managed window is left alone),
 * with a film camera that follows Pip, and Pip scripted shot by shot:
 *   hook    low and close, Pip walking at the camera
 *   course  tracking from the side while the autopilot runs the course
 *   depth   the room as the duck feels it: the depth map's blocks on the real
 *           furniture, and Pip walking into the real coffee table
 *   fall    a stumble, close up
 * Frames stream over the DevTools screencast into artifacts/video/social/take/
 * (frames/ + frames.json with timestamps, marks.json with each shot's start).
 * compose-social.mjs makes the film.
 *
 *   node tools/film/social/record-social.mjs
 *
 * Needs the dev server (https://localhost:8081). Leaves no trace: its own
 * browser profile is thrown away.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const OUT = 'artifacts/video/social/take';
const W = 1080;
const H = 1920;
const FOVY = 64; // degrees, vertical: a film lens, not the headset's 90
const SHOTS = [
  { name: 'hook', seconds: 5 },
  { name: 'course', seconds: 9 },
  { name: 'depth', seconds: 6 },
  { name: 'fall', seconds: 5 },
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In the page: the film camera, a loop that places the emulated headset every frame. */
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
  d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
  const M = d.world.camera.matrix.constructor;
  const Q = d.world.camera.quaternion.constructor;
  const duck = new V();
  const eye = new V();
  const look = new V();
  const along = new V();
  const side = new V();
  const origin = new V();
  const up = new V(0, 1, 0);
  const m = new M();
  const q = new Q();
  const film = { shot: 'hook', smooth: null, hide: [] };
  globalThis.__film = film;
  // The HUD panels stay out of the shots.
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
    // The emulated room's robot vacuum is in neither its scan nor its depth: out of the film too.
    const vacuum = device.sem?.sceneEnvironment?.root?.getObjectByName?.('robot');
    if (vacuum) vacuum.visible = false;
    const robot = d.robotPanel.hostEntity?.object3D;
    if (robot) robot.visible = false;
    const trunk = d.duck.rig?.trunk;
    const stageObject = d.duck.stageEntity?.object3D;
    if (!trunk || !stageObject) return;
    trunk.getWorldPosition(duck);
    stageObject.updateWorldMatrix(true, false);
    stageObject.getWorldPosition(origin);
    along.set(1, 0, 0).transformDirection(stageObject.matrixWorld); // the way the course runs
    side.set(0, 0, -1).transformDirection(stageObject.matrixWorld); // the open side of the course (the room's middle)
    if (film.shot === 'hook') {
      eye.copy(duck).addScaledVector(along, 0.62).addScaledVector(side, 0.06);
      eye.y = 0.2;
      look.copy(duck);
      look.y = 0.14;
    } else if (film.shot === 'course') {
      eye.copy(duck).addScaledVector(side, 0.8).addScaledVector(along, 0.3);
      eye.y = 0.48;
      look.copy(duck).addScaledVector(along, 0.12);
      look.y = 0.1;
    } else if (film.shot === 'depth') {
      // From the side: Pip and the near edge of the real coffee table (world coordinates).
      eye.set(0.95, 0.55, -0.95);
      look.set(0.72, 0.13, -1.95);
    } else if (film.shot === 'fall') {
      eye.copy(duck).addScaledVector(side, 0.7).addScaledVector(along, 0.35);
      eye.y = 0.38;
      look.copy(duck);
      look.y = 0.07;
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

/** In the page: Pip and the camera for one shot. */
function startShot(name) {
  const d = globalThis.__duck;
  const film = globalThis.__film;
  film.shot = name;
  film.smooth = null; // a cut, not a glide
  d.duck.autopilot = null;
  d.nav.stop?.();
  if (name === 'hook') {
    d.duck.sim.teleport(0, 0, 0);
  } else if (name === 'course') {
    d.duck.sim.teleport(0, 0, 0);
    d.nav.runCourse();
  } else if (name === 'depth') {
    if (!d.terrain.blocksShown) d.terrain.toggleBlocks();
    // Facing the real coffee table (world x -0.58..0.58 at z -1.95), 0.45 m from its edge.
    const stageObject = d.duck.stageEntity.object3D;
    stageObject.updateWorldMatrix(true, false);
    const V = d.duck.rig.trunk.position.constructor;
    const at = stageObject.worldToLocal(new V(1.03, 0, -1.95));
    const inverse = stageObject.matrixWorld.clone().invert();
    const facing = new V(-1, 0, 0).transformDirection(inverse);
    d.duck.sim.teleport(at.x, -at.z, Math.atan2(-facing.z, facing.x));
  } else if (name === 'fall') {
    if (d.terrain.blocksShown) d.terrain.toggleBlocks();
    d.duck.sim.teleport(0.6, 0.32, 0.4, 0.9); // on open floor beside the course, clear of its pieces
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'frames'), { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}?demoReset=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.IWER_DEVICE?.sessionOffered === true, null, { timeout: 90000 });
  await page.evaluate((fovy) => {
    const device = globalThis.IWER_DEVICE;
    device.fovy = (fovy * Math.PI) / 180;
    device.grantOfferedSession();
  }, FOVY);
  await page.waitForFunction(() => !!globalThis.__duck.world.session && ['placed', 'tight'].includes(globalThis.__duck.room.state), null, { timeout: 60000 });
  await wait(2500);
  await page.evaluate(stage);
  await wait(2500);

  // Film: the screencast streams frames with their times; each shot sets up Pip and the camera.
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
    console.log(`shot ${name}`);
  };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  for (const shot of SHOTS) {
    await page.evaluate(startShot, shot.name);
    // Pip walks on a held W (real input: it also wakes a duck still sitting from its intro).
    const walking = shot.name === 'hook' || shot.name === 'depth';
    if (walking) {
      await wait(400);
      await page.keyboard.down('KeyW');
    }
    await mark(shot.name);
    if (process.env.DEBUG) {
      for (const at of [800, 2500]) {
        await wait(at === 800 ? 800 : 1700);
        const where = await page.evaluate(() => {
          const d = globalThis.__duck;
          const p = d.duck.rig?.trunk?.getWorldPosition(d.duck.rig.trunk.position.clone());
          const dev = globalThis.IWER_DEVICE.position;
          return { pose: Array.from(d.duck.pose.slice(0, 3)).map((v) => +v.toFixed(2)), trunk: p ? [p.x, p.y, p.z].map((v) => +v.toFixed(2)) : null, eye: [dev.x, dev.y, dev.z].map((v) => +v.toFixed(2)), mode: d.duck.sim.mode, task: d.nav.task, vacuum: !!globalThis.IWER_DEVICE.sem?.sceneEnvironment?.root };
        });
        console.log(`  ${shot.name} +${at} ms ${JSON.stringify(where)}`);
      }
    }
    if (shot.name === 'course') {
      await wait(3500);
      await page.keyboard.press('KeyJ'); // a kick on the way
      await wait(shot.seconds * 1000 - 3500);
    } else {
      await wait(shot.seconds * 1000);
    }
    if (walking) await page.keyboard.up('KeyW');
  }
  await page.keyboard.up('KeyW');
  await mark('end');
  await cdp.send('Page.stopScreencast');
  await page.evaluate(() => {
    globalThis.__duck.duck.autopilot = null;
  });
  writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames));
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  console.log(`frames ${frames.length} over ${span.toFixed(1)} s (${(frames.length / Math.max(span, 1e-3)).toFixed(1)} fps)`);
} finally {
  await browser.close();
}
console.log(`errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
