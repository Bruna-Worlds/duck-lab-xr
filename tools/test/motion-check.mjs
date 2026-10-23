// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Motion superpowers on the desktop (`npx @iwsdk/cli browser run tools/test/motion-check.mjs`):
 * the bow plays as a move without a fall and scores, the wiggle too, and a
 * 40-episode training-set export lands in artifacts/datasets/ with the duck
 * still standing at the end of nearly every episode.
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
      const s = d.duck.sim;
      return {
        awake: d.duck.hasPose && /woke|ready/i.test(d.duck.status),
        mode: s ? s.mode : null,
        falls: s && s.stats ? s.stats.falls : -1,
        z: d.duck.hasPose ? d.duck.pose[2] : null,
        motions: Array.from(d.motion.motions.keys()),
        ready: d.duck.motionReady,
        score: d.course.score,
        status: d.motion.status,
      };
    });
  let s = await read();
  for (let i = 0; i < 40 && !(s.awake && s.ready); i++) {
    await wait(500);
    s = await read();
  }
  check('motions loaded', s.ready && s.motions.includes('bow') && s.motions.includes('wiggle'), s.motions.join(', '));
  const falls0 = s.falls;
  const score0 = s.score;
  await target.evaluate(() => globalThis.__duck.duck.fireMove('bow'));
  await wait(700);
  const mid = await read();
  await wait(2200);
  s = await read();
  // Points come only during a run, so the score is reported, not required.
  check('bow plays as a move', mid.mode === 'motion' && s.mode === 'walk' && s.falls === falls0, `mid ${mid.mode}, after ${s.mode}, falls ${falls0} -> ${s.falls}, score ${score0} -> ${s.score}`);
  await target.evaluate(() => globalThis.__duck.motion.playMotion('wiggle'));
  await wait(3000);
  s = await read();
  check('wiggle keeps the duck up', s.mode === 'walk' && s.falls === falls0 && s.z > 0.1, `after ${s.mode}, falls ${s.falls}, trunk ${s.z?.toFixed(3)}`);
  const where = await target.evaluate(() => globalThis.__duck.motion.exportDataset('bow', 40));
  s = await read();
  const m = /(\d+)\/(\d+) stood/.exec(s.status);
  const stood = m ? Number(m[1]) : -1;
  check('bow training set exported', typeof where === 'string' && /artifacts\/datasets\//.test(where) && stood >= 36, `${where}; ${s.status}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  return results;
}
