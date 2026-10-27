// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The camera brain in the app itself: a test case's drive replayed, in an
 * emulated mixed-reality session (IWER's sunlit living room) of its own, with
 * Pip cam rendering the brain's pictures as on a headset. The course stands
 * where it stood (the pack's stage), Pip starts where the test case starts and
 * is sent to the goal it had. Without PACK: the camera film's drive (from the
 * open side of the real coffee table to a spot behind it, record-avoid.mjs).
 * Each brain gets TRIES drives of up to LIMIT seconds: it got there, or not
 * (how often the autopilot called it stuck, and falls). Test cases are not
 * saved meanwhile.
 *
 *   node tools/test/camera-drive-check.mjs [shipped|offer|<release id> ...]
 *
 * shipped: the shipped camera brain; offer: the release the trainer offers;
 * a release id: that release (a camera brain release, tried as TRY IT does).
 * Env: SITE, PACK (a .scenario.json), TRIES (4), LIMIT (45), OUT (results JSON).
 * Prints a RESULT line per brain and {"passed","failed"}.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const TRIES = Number(process.env.TRIES ?? 4);
const LIMIT = Number(process.env.LIMIT ?? 45);
const BRAINS = process.argv.slice(2).length ? process.argv.slice(2) : ['shipped', 'offer'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The drive to replay: the course's placement (world), Pip's start (stage x, y, yaw) and goal (stage). */
function theDrive() {
  if (!process.env.PACK) return { stage: null, start: null, goal: null, film: true };
  const pack = JSON.parse(readFileSync(process.env.PACK, 'utf8'));
  if (!pack.nav?.goal) throw new Error(`${process.env.PACK} has no goal (saved before test cases recorded the autopilot's goal)`);
  // From where the drive began (the autopilot's task start), else from the state the pack starts with.
  if (Array.isArray(pack.nav.from)) return { stage: pack.stage ?? null, start: pack.nav.from, goal: pack.nav.goal, film: false };
  const q = pack.start.qpos;
  const [w, x, y, z] = q.slice(3, 7);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { stage: pack.stage ?? null, start: [q[0], q[1], yaw], goal: pack.nav.goal, film: false };
}
const DRIVE = theDrive();

/** In the page: the course where it stood (the camera film's placement when the pack does not say). */
function placeCourse(stage) {
  const d = globalThis.__duck;
  const V = d.duck.rig.trunk.position.constructor;
  if (stage) d.duck.placeCourse(new V(...stage.origin), new V(...stage.right));
  else d.duck.placeCourse(new V(1.5, 0, 0.21), new V(0, 0, -1));
  d.nav.setDriver('camera');
  if (!d.cam.visible) d.cam.toggle();
}

/** In the page: Pip to the start; returns the start and the goal (stage frame). */
function toStart(drive) {
  const d = globalThis.__duck;
  d.nav.stop?.();
  let start = drive.start;
  let goal = drive.goal;
  if (drive.film) {
    const stageObject = d.duck.stageEntity.object3D;
    stageObject.updateWorldMatrix(true, false);
    const V = d.duck.rig.trunk.position.constructor;
    const toStage = (x, z) => {
      const p = stageObject.worldToLocal(new V(x, 0, z));
      return [p.x, -p.z];
    };
    const [sx, sy] = toStage(1.05, -1.95);
    const facing = new V(-1, 0, 0).transformDirection(stageObject.matrixWorld.clone().invert());
    start = [sx, sy, Math.atan2(-facing.z, facing.x)];
    goal = toStage(-0.95, -1.95);
  }
  d.duck.sim.teleport(start[0], start[1], start[2]);
  return { start, goal };
}

const results = [];
let failed = 0;
for (const brain of BRAINS) {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
    await context.addInitScript(() => localStorage.setItem('ducklab.autoPacks', '0'));
    const page = await context.newPage();
    await page.goto(`${SITE}?demoReset=1`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && globalThis.IWER_DEVICE?.sessionOffered === true, null, { timeout: 180000, polling: 500 });
    await page.evaluate(() => globalThis.IWER_DEVICE.grantOfferedSession());
    await page.waitForFunction(() => !!globalThis.__duck.world.session && ['placed', 'tight'].includes(globalThis.__duck.room.state), null, { timeout: 120000, polling: 500 });
    await wait(2000);
    let name = 'shipped camera brain';
    if (brain !== 'shipped') {
      // The offered release, or one by id (the inbox lists the trainer's releases).
      await page.waitForFunction((id) => (id === 'offer' ? !!globalThis.__duck.policyInbox.offer : globalThis.__duck.policyInbox.releases.some((r) => r.id === id)), brain, { timeout: 60000, polling: 500 });
      name = await page.evaluate(async (id) => {
        const inbox = globalThis.__duck.policyInbox;
        const release = id === 'offer' ? inbox.offer : inbox.releases.find((r) => r.id === id);
        await inbox.accept(release, false);
        return release.name;
      }, brain);
    }
    await page.evaluate(placeCourse, DRIVE.stage);
    await page.keyboard.down('KeyW');
    await wait(1200);
    await page.keyboard.up('KeyW');
    await wait(2500);
    const tries = [];
    for (let i = 0; i < TRIES; i++) {
      const { start, goal } = await page.evaluate(toStart, DRIVE);
      // The pose catches up with a teleport a moment later: go only once Pip stands at the start.
      await page.waitForFunction((s) => Math.hypot(globalThis.__duck.duck.pose[0] - s[0], globalThis.__duck.duck.pose[1] - s[1]) < 0.12, start, { timeout: 10000, polling: 100 });
      await wait(800);
      await page.evaluate((g) => globalThis.__duck.nav.goTo(g[0], g[1], 'to the test case goal'), goal);
      const f0 = await page.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0);
      const t0 = Date.now();
      let stuckSeen = 0;
      let wasStuck = false;
      let arrived = null;
      while (Date.now() - t0 < LIMIT * 1000) {
        await wait(500);
        const s = await page.evaluate(() => ({ task: globalThis.__duck.nav.task, status: globalThis.__duck.nav.status, stuck: globalThis.__duck.nav.stuck }));
        if (s.stuck && !wasStuck) stuckSeen++;
        wasStuck = s.stuck;
        if (!s.task) {
          arrived = /arrived/i.test(s.status) ? (Date.now() - t0) / 1000 : null;
          break;
        }
      }
      const falls = (await page.evaluate(() => globalThis.__duck.duck.sim?.stats?.falls ?? 0)) - f0;
      tries.push({ arrived, stuck: stuckSeen, falls });
      console.log(`  ${name} try ${i + 1}: ${arrived ? `there in ${arrived.toFixed(0)} s` : `not there after ${LIMIT} s`}, called stuck ${stuckSeen}x, falls ${falls}`);
      await page.evaluate(() => globalThis.__duck.nav.stop());
      await wait(1500);
    }
    const reached = tries.filter((t) => t.arrived).length;
    const row = {
      brain,
      name,
      tries: TRIES,
      reached,
      stuck: tries.filter((t) => !t.arrived).length,
      falls: tries.reduce((a, t) => a + t.falls, 0),
      seconds: reached ? +(tries.filter((t) => t.arrived).reduce((a, t) => a + t.arrived, 0) / reached).toFixed(1) : null,
    };
    results.push(row);
    console.log(`RESULT ${JSON.stringify(row)}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${brain}: ${err.message}`);
  } finally {
    await browser.close();
  }
}
if (process.env.OUT) writeFileSync(process.env.OUT, `${JSON.stringify({ engine: 'app', pack: process.env.PACK ?? null, results }, null, 1)}\n`);
console.log(JSON.stringify({ passed: results.length, failed }));
