// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The Isaac Sim link (src/link/isaac-link.ts) against the stand-in bridge
 * (tools/isaac/mock-bridge.mjs, started here when it is not running): the app
 * loads with ?isaac=127.0.0.1:8219 on the desktop page, and the check reads
 * what arrived. The stand-in has no stream, so the window must say so.
 * The app is put back on its plain address afterwards.
 *
 *   npx @iwsdk/cli browser run tools/test/isaac-link-check.mjs --timeout 100000
 */
import { spawn } from 'node:child_process';

const PORT = 8219;
const BRIDGE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLog = async () => (await fetch(`${BRIDGE}/log`)).json();

export default async function run({ page, frame }) {
  const target = frame ?? page;
  let mock = null;
  try {
    await fetch(`${BRIDGE}/log`);
  } catch {
    mock = spawn(process.execPath, ['tools/isaac/mock-bridge.mjs', String(PORT)], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        await fetch(`${BRIDGE}/log`);
        break;
      } catch {
        // not up yet
      }
    }
  }
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} - ${detail}`);
  };
  const home = new URL(target.url());
  home.search = '';
  home.hash = '';
  try {
    await fetch(`${BRIDGE}/reset`, { method: 'POST' });
    const url = new URL(home);
    url.searchParams.set('isaac', `127.0.0.1:${PORT}`);
    await target.goto(url.href, { waitUntil: 'load', timeout: 60000 });
    // Up: the duck stands and the first poses arrive.
    let log = null;
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      log = await readLog();
      if (log.poses > 10 && log.scene && log.duck) break;
    }
    const app = await target.evaluate(() => {
      const d = globalThis.__duck;
      const link = d.isaac;
      const panel = document.getElementById('duck-isaac');
      return {
        state: link?.state,
        bridge: link?.bridge?.app ?? null,
        triangles: d.duck.rig?.triangles ?? 0,
        panel: !!panel,
        frameSrc: panel?.querySelector('iframe')?.src ?? '',
        stateText: panel?.querySelector('.state')?.textContent ?? '',
      };
    });
    check('connects to the bridge', app.state === 'live' && app.bridge === 'Stand-in bridge' && log.connections === 1, `state ${app.state}, bridge ${app.bridge}, ${log.connections} connection(s), origin ${log.origin}`);
    const scene = log.scene;
    check(
      'sends the static scene and the terrain',
      !!scene && scene.statics >= 3 && scene.terrain?.rows === 201 && scene.terrain?.cols === 201,
      scene ? `${scene.statics} shapes ${JSON.stringify(scene.kinds)}, terrain ${scene.terrain?.rows} x ${scene.terrain?.cols} over +-${scene.terrain?.half} m (${scene.terrain?.raised} raised cells)` : 'no scene',
    );
    const sent = Object.values(log.triangles).reduce((a, b) => a + b, 0);
    check(
      "sends Pip's bodies with every triangle the page draws",
      (log.duck?.bodies.length ?? 0) >= 10 && Math.abs(sent - app.triangles) < 1,
      `${log.duck?.bodies.length} bodies (${log.duck?.bodies.slice(0, 3).join(', ')}...), ${sent} of ${app.triangles} triangles`,
    );
    // Rate, and the trunk where the page has it.
    const a = await readLog();
    await sleep(3000);
    const b = await readLog();
    const rate = (b.poses - a.poses) / ((b.lastPoseAt - a.lastPoseAt) / 1000);
    check('streams poses about 30 times a second', rate > 26 && rate < 34, `${rate.toFixed(1)} poses/s over ${((b.lastPoseAt - a.lastPoseAt) / 1000).toFixed(1)} s`);
    const now = await target.evaluate(() => Array.from(globalThis.__duck.duck.pose));
    const c = await readLog();
    const trunk = c.lastPose.trunk;
    const gap = Math.hypot(trunk[0] - now[0], trunk[1] - now[1], trunk[2] - now[2]);
    const qn = Math.hypot(trunk[3], trunk[4], trunk[5], trunk[6]);
    check('the trunk arrives where the page has it', gap < 0.03 && Math.abs(qn - 1) < 1e-3 && trunk[2] > 0.05 && trunk[2] < 0.4, `${(gap * 100).toFixed(2)} cm apart, height ${(trunk[2] * 100).toFixed(1)} cm, |q| ${qn.toFixed(4)}`);
    const BALL = 21; // BALL_OFFSET: 7 + 14 joints
    const hasBall = Math.hypot(now[BALL + 3], now[BALL + 4], now[BALL + 5], now[BALL + 6]) > 0.5;
    const ballGap = c.ball ? Math.hypot(c.ball[0] - now[BALL], c.ball[1] - now[BALL + 1], c.ball[2] - now[BALL + 2]) : null;
    check('the ball comes along when the course has one', hasBall ? ballGap !== null && ballGap < 0.03 : c.ball === null, hasBall ? `ball ${ballGap === null ? 'missing' : `${(ballGap * 100).toFixed(2)} cm apart`}` : 'no ball on this course, none sent');
    await target.evaluate(() => globalThis.__duck.isaac.setFollow(false));
    await sleep(400);
    const off = (await readLog()).follow;
    await target.evaluate(() => globalThis.__duck.isaac.setFollow(true));
    await sleep(400);
    const on = (await readLog()).follow;
    check('FOLLOW switches the viewport camera', off === false && on === true, `off -> ${off}, on -> ${on}`);
    const viewport = (await readLog()).ui;
    await target.evaluate(() => globalThis.__duck.isaac.setIsaacUi(true));
    await sleep(400);
    const panels = (await readLog()).ui;
    await target.evaluate(() => globalThis.__duck.isaac.setIsaacUi(false));
    check("Isaac Sim's own panels hide by default and ISAAC UI brings them back", viewport === false && panels === true, `on connect ui=${viewport}, ISAAC UI -> ${panels}`);
    const stream = await target.evaluate(() => {
      const f = document.querySelector('#duck-isaac iframe');
      return { stream: globalThis.__duck.isaac.stream, note: f?.contentDocument?.getElementById('note')?.textContent ?? '' };
    });
    check(
      'the window shows, and says there is no stream at the stand-in',
      app.panel && app.frameSrc.includes('isaac/player.html') && app.frameSrc.includes(`port=${PORT}`) && stream.stream === 'error' && /No Isaac Sim stream/.test(stream.note),
      `window ${app.panel}, stream ${stream.stream}: "${stream.note.slice(0, 60)}", state "${app.stateText}"`,
    );
  } finally {
    await target.goto(home.href, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    mock?.kill();
  }
  const passed = results.filter(Boolean).length;
  console.log(JSON.stringify({ passed, failed: results.length - passed }));
  return { passed, failed: results.length - passed };
}
