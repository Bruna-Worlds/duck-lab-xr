// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The climbing film's app takes: an emulated mixed-reality session (IWER's
 * sunlit living room) in a 1920 x 1080 browser of its own, the Dog Bed
 * playground (a 2 cm play mat, a 3 cm dog bed) placed on the floor, a film
 * camera low beside Pip.
 *   TAKE=fail  the brain in use runs the course; when it trips on the mat and
 *              the autopilot gives up, the app saves the moment as a test case
 *              (a scenario pack, posted to the dev server: artifacts/scenarios/)
 *   TAKE=try   the trainer page's new release is offered on Pip cam ("New brain
 *              ready"): the right controller's ray presses TRY IT, then Pip runs
 *              the course on the new brain
 * Writes artifacts/video/climb/<take>/: frames/ + frames.json (timestamps),
 * trace.json (Pip's place and height, falls, the autopilot's status and the
 * app's status line, five times a second) and marks.json.
 *
 *   node tools/film/climb/record-climb.mjs        (TAKE, SITE, RUN_S)
 *
 * Needs the dev server (https://localhost:8081). TAKE=fail wants no active
 * release (the shipped brain); TAKE=try wants one (Send to headset).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const TAKE = process.env.TAKE ?? 'fail';
const OUT = process.env.OUT ?? `artifacts/video/climb/${TAKE}`;
const RUN_S = Number(process.env.RUN_S ?? (TAKE === 'fail' ? 45 : 60));
const W = 1920;
const H = 1080;
const FOVY = 52;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In the page: the film camera (the emulated headset, placed every frame) and the trace. */
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
  const duck = new V();
  const eye = new V();
  const look = new V();
  const along = new V();
  const side = new V();
  const up = new V(0, 1, 0);
  const m = new M();
  const q = new Q();
  const film = { shot: 'course', smooth: null, hide: [], trace: [], panelEye: null, panelLook: null };
  globalThis.__film = film;
  for (const node of ['run-panel', 'moves-panel', 'menu-panel', 'lab-panel']) {
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
    if (robot) robot.visible = film.shot === 'offer';
    const trunk = d.duck.rig?.trunk;
    const stageObject = d.duck.stageEntity?.object3D;
    if (!trunk || !stageObject) return;
    trunk.getWorldPosition(duck);
    stageObject.updateWorldMatrix(true, false);
    along.set(1, 0, 0).transformDirection(stageObject.matrixWorld); // the way the course runs
    side.set(0, 0, -1).transformDirection(stageObject.matrixWorld); // the room's open side of it
    if (film.shot === 'offer' && film.panelEye) {
      eye.copy(film.panelEye);
      look.copy(film.panelLook);
    } else {
      // Low and close beside Pip, a little behind: the step's edge and the feet in view.
      eye.copy(duck).addScaledVector(side, 0.72).addScaledVector(along, -0.28);
      eye.y = 0.42;
      look.copy(duck).addScaledVector(along, 0.18);
      look.y = 0.06;
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
  // The trace, five times a second.
  setInterval(() => {
    film.trace.push({
      t: Date.now() / 1000,
      shot: film.shot,
      at: Array.from(d.duck.pose.slice(0, 3)),
      task: d.nav.task,
      status: d.nav.status,
      left: d.nav.waypoints?.length ?? 0,
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

/** In the page: the Dog Bed on the living room floor, Pip at the start. */
async function placeCourse() {
  const d = globalThis.__duck;
  if (d.playgrounds.current !== 'dog-bed') await d.playgrounds.load('dog-bed');
}

function setCourse() {
  const d = globalThis.__duck;
  const V = d.duck.rig.trunk.position.constructor;
  d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
}

function runCourse() {
  const d = globalThis.__duck;
  const film = globalThis.__film;
  film.shot = 'course';
  film.smooth = null;
  d.nav.stop?.();
  // No teleport: it would restart the history a test case is cut from (Pip stands on the start pad already).
  d.nav.runCourse();
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
  // The whole panel in view, a little above its middle (the offer is near its top).
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
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}?demoReset=1`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.IWER_DEVICE?.sessionOffered === true, null, { timeout: 180000, polling: 500 });
  await page.evaluate((fovy) => {
    const device = globalThis.IWER_DEVICE;
    device.fovy = (fovy * Math.PI) / 180;
    device.grantOfferedSession();
  }, FOVY);
  await page.waitForFunction(() => !!globalThis.__duck.world.session && ['placed', 'tight'].includes(globalThis.__duck.room.state), null, { timeout: 120000, polling: 500 });
  await wait(2000);
  await page.evaluate(placeCourse);
  await page.waitForFunction(() => {
    const d = globalThis.__duck;
    return d.playgrounds.current === 'dog-bed' && !d.playgrounds.loading && d.duck.hasPose && d.duck.sim?.ready;
  }, null, { timeout: 180000, polling: 500 });
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

  await page.evaluate(runCourse);
  await mark('course');
  const t0 = Date.now();
  let packedAt = 0;
  while (Date.now() - t0 < RUN_S * 1000) {
    await wait(500);
    const s = await page.evaluate(() => ({ run: globalThis.__duck.course.state, packs: globalThis.__duck.scenario.packs, says: globalThis.__duck.duck.status }));
    if (s.run === 'finished') {
      console.log(`  finished after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
  await mark('course-end');
  await cdp.send('Page.stopScreencast');
  const trace = await page.evaluate(() => globalThis.__film.trace);
  await page.evaluate(() => globalThis.__duck.nav.stop());
  writeFileSync(join(OUT, 'frames.json'), JSON.stringify(frames));
  writeFileSync(join(OUT, 'trace.json'), JSON.stringify(trace));
  writeFileSync(join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  const last = trace.at(-1);
  console.log(`frames ${frames.length} over ${span.toFixed(1)} s, falls ${(last?.falls ?? 0) - (trace[0]?.falls ?? 0)}, brain ${last?.brain ?? 'shipped'}, packs ${last?.packs}, ${last?.status}`);
} finally {
  await browser.close();
}
console.log(`errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
