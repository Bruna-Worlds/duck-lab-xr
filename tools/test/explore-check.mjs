// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Free roam on the emulator (run with `bash tools/test/mr.sh tools/test/explore-check.mjs`,
 * inside an emulated mixed-reality session): loads the room-only playground,
 * sends the duck exploring and checks that it keeps finding new floor, then
 * sends it under the scanned table.
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
        playground: d.playgrounds.current,
        status: d.duck.status,
        hasPose: d.duck.hasPose,
        x: d.duck.hasPose ? d.duck.pose[0] : null,
        y: d.duck.hasPose ? d.duck.pose[1] : null,
        nav: d.nav.status,
        task: d.nav.task,
        stuck: d.nav.stuck,
        freeRoam: d.course.freeRoam,
        falls: d.duck.sim && d.duck.sim.stats ? d.duck.sim.stats.falls : -1,
        colliders: d.room.roomColliders.length,
      };
    });
  await target.evaluate(() => globalThis.__duck.playgrounds.load('free-roam'));
  let s = await read();
  for (let i = 0; i < 60 && !(s.playground === 'free-roam' && /woke|ready/i.test(s.status) && s.hasPose); i++) {
    await wait(500);
    s = await read();
  }
  check('free roam loaded', s.playground === 'free-roam' && s.freeRoam, `${s.playground}, free roam ${s.freeRoam}, ${s.colliders} room colliders`);
  await wait(1500); // let the scan colliders and the terrain settle
  await target.evaluate(() => globalThis.__duck.nav.explore());
  const trail = [];
  let distance = 0;
  let last = await read();
  for (let i = 0; i < 12; i++) {
    await wait(2500);
    s = await read();
    if (last.x !== null && s.x !== null) distance += Math.hypot(s.x - last.x, s.y - last.y);
    trail.push(`(${s.x?.toFixed(2)},${s.y?.toFixed(2)})${s.stuck ? '!' : ''}`);
    last = s;
    if (s.task !== 'explore') break;
  }
  check('explore keeps moving', distance > 0.8, `${distance.toFixed(2)} m in ${trail.length * 2.5} s: ${trail.join(' ')}; ${s.nav}; falls ${s.falls}`);
  await target.evaluate(() => globalThis.__duck.nav.stop());
  const went = await target.evaluate(() => globalThis.__duck.nav.goUnderTable());
  await wait(1000);
  s = await read();
  check('go under the table', went === true && s.task === 'goto', `${s.nav}`);
  await target.evaluate(() => globalThis.__duck.nav.stop());
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  return results;
}
