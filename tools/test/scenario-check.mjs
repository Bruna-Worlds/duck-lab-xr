// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Scenario pack check through the managed browser (run it with
 * `bash tools/test/mr.sh tools/test/scenario-check.mjs`): lets the autopilot
 * run the course long enough for the sim to keep a state snapshot, packs a
 * scenario by hand, and checks that the dev server's inbox got it. Replay
 * the pack afterwards with `node tools/train/replay.mjs <file>`.
 */
export default async function run({ page, frame }) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const target = frame ?? page;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };
  const read = () =>
    target.evaluate(() => {
      const d = globalThis.__duck;
      return {
        status: d.duck.status,
        mode: d.duck.sim ? d.duck.sim.mode : null,
        nav: d.nav.status,
        stuck: d.nav.stuck,
        scenario: d.scenario.summary,
        packs: d.scenario.packs,
        x: d.duck.hasPose ? d.duck.pose[0] : null,
      };
    });
  let s = await read();
  for (let i = 0; i < 30 && !/woke|ready/i.test(s.status); i++) {
    await wait(500);
    s = await read();
  }
  check('duck awake', /woke|ready/i.test(s.status), s.status);
  // Where the duck stands, in its stage's frame (x along the course, y to the left). The autopilot
  // goes round a piece it cannot pass (in Living Room Dash it skips the crumb wedged between the
  // book stacks and walks round the first stack), so count the distance walked, not where it ends.
  const spot = () =>
    target.evaluate(() => {
      const d = globalThis.__duck.duck;
      return d.hasPose ? [d.pose[0], d.pose[1]] : null;
    });
  await target.evaluate(() => globalThis.__duck.nav.runCourse());
  let walked = 0;
  let last = await spot();
  let maxX = last?.[0] ?? 0;
  for (let i = 0; i < 32; i++) {
    await wait(500); // 16 s in all: two snapshots' worth of walking
    const now = await spot();
    if (last && now) walked += Math.hypot(now[0] - last[0], now[1] - last[1]);
    if (now) maxX = Math.max(maxX, now[0]);
    last = now;
  }
  s = await read();
  check('autopilot walked', walked > 0.5, `${s.nav}; walked ${walked.toFixed(2)} m, furthest x ${maxX.toFixed(2)} ${s.mode}`);
  await target.evaluate(() => globalThis.__duck.scenario.capture('manual'));
  for (let i = 0; i < 20; i++) {
    await wait(500);
    s = await read();
    if (s.packs > 0 || /failed/.test(s.scenario)) break;
  }
  check('scenario packed to the inbox', s.packs > 0 && /artifacts\/scenarios\//.test(s.scenario), s.scenario);
  await target.evaluate(() => globalThis.__duck.nav.stop());
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  return results;
}
