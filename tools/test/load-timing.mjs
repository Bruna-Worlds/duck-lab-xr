// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Times a playground switch inside the running session: from load() until the
 * duck stands (hasPose and an awake status), printing the duck's status and
 * the room state every half second. PLAYGROUND picks the target (default
 * free-roam).
 *
 *   PLAYGROUND=free-roam bash tools/test/mr.sh tools/test/load-timing.mjs 14
 */
export default async function run({ page, frame }) {
  const app = frame ?? page;
  const target = process.env.PLAYGROUND ?? 'free-roam';
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  const read = () =>
    app.evaluate(() => {
      const d = globalThis.__duck;
      return {
        pg: d.playgrounds.current,
        hasPose: d.duck.hasPose,
        status: d.duck.status,
        room: d.room.state,
        simReady: !!d.duck.sim?.ready,
        brain: d.policyInbox?.current?.name ?? '',
      };
    });
  // Start from another playground, settled.
  const from = process.env.FROM ?? 'living-room-dash';
  await app.evaluate((id) => globalThis.__duck.playgrounds.load(id), from);
  await app.waitForFunction(
    (id) => globalThis.__duck.playgrounds.current === id && globalThis.__duck.duck.hasPose,
    from,
    { timeout: 40000 },
  );
  await page.waitForTimeout(3000);
  if (process.env.TRY) {
    // As in the demo: back to the shipped brain, then TRY IT on the trained one just before switching.
    const swapped = await app.evaluate(async () => {
      const inbox = globalThis.__duck.policyInbox;
      await inbox.revert();
      const release = inbox.releases[0];
      if (!release) return 'no release';
      await inbox.accept(release);
      return inbox.current?.name ?? 'none';
    });
    console.log(`T-0 swapped to ${swapped}`);
    await page.waitForTimeout(Number(process.env.TRY) || 2000);
  }
  const start = Date.now();
  await app.evaluate((id) => globalThis.__duck.playgrounds.load(id), target);
  let last = '';
  let s = await read();
  while (Date.now() - start < 60000) {
    s = await read();
    const line = `${s.pg} pose=${s.hasPose} sim=${s.simReady} room=${s.room} brain=${s.brain || 'shipped'} | ${s.status}`;
    if (line !== last) {
      console.log(`T+${((Date.now() - start) / 1000).toFixed(1)}s ${line.replace(/"/g, "'")}`);
      last = line;
    }
    if (s.pg === target && s.hasPose && /woke|ready|walk/i.test(s.status)) break;
    await page.waitForTimeout(250);
  }
  console.log(`LOADED ${target} in ${((Date.now() - start) / 1000).toFixed(1)} s`);
}
