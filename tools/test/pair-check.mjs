// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pairing check (development): a headset page and Duck Lab XR's trainer page,
 * each in its own browser profile like two devices, find each other in their
 * network's lobby and pair over WebRTC (trystero, public Nostr relays: needs the
 * internet). Then a scenario pack goes up to the trainer
 * engine, the engine's active brain comes down and runs, and after a reload
 * the headset reconnects by itself and is still on that brain.
 *
 *   node tools/test/pair-check.mjs
 *   TRAINER_SITE=https://duck-lab-xr.vercel.app/ node tools/test/pair-check.mjs
 *
 * TRAINER_SITE takes the trainer page from another copy of the site (the
 * deployed one, say); the headset page stays on the dev server, whose test
 * hooks the check reads. Needs the dev server (https://localhost:8081) and the trainer engine
 * (npm run lab, http://localhost:8790) with an active release. Leaves no
 * trace: the test pack is deleted and both profiles are thrown away.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const TRAINER_SITE = process.env.TRAINER_SITE ?? SITE;
const ENGINE = 'http://localhost:8790';
const SCENARIOS = 'artifacts/scenarios';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const engine = await (await fetch(`${ENGINE}/api/state`)).json();
const active = engine.releases.releases.find((r) => r.id === engine.releases.active);
if (!active) {
  console.log('FAIL the trainer engine has no active release to send (make one active in Duck Lab XR)');
  process.exit(1);
}
const packsBefore = new Set(readdirSync(SCENARIOS));

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (err) => errors.push(`${who}: ${err.message}`));
  page.on('console', (msg) => {
    // Trystero logs the data channel's close as an error when the other side leaves on purpose
    // (a reload, FORGET): "User-Initiated Abort, reason=Close called". Not a fault.
    const benign = /favicon|Failed to load resource|Trystero peer error: OperationError: User-Initiated Abort/;
    if (msg.type() === 'error' && !benign.test(msg.text())) errors.push(`${who}: ${msg.text().slice(0, 200)}`);
  });
};
try {
  // The computer: the trainer page from the website.
  const trainerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  // A site on the internet reaches the engine on this computer only once the player allows it
  // (the browser asks: "access other apps and services on this device"). This is that click.
  await trainerContext.grantPermissions(['local-network-access'], { origin: new URL(TRAINER_SITE).origin });
  const trainer = await trainerContext.newPage();
  watch(trainer, 'trainer');
  await trainer.goto(`${TRAINER_SITE}trainer/`, { waitUntil: 'load', timeout: 60000 });
  await trainer.waitForFunction(() => /^\d{3} \d{3}$/.test(document.getElementById('pair-code')?.textContent ?? ''), null, { timeout: 30000 });
  const code = (await trainer.textContent('#pair-code')).replace(' ', '');
  check('trainer page shows a pairing code', /^\d{6}$/.test(code), code);
  await trainer.waitForFunction(() => document.getElementById('chip-inbox')?.className.includes('on'), null, { timeout: 30000 });
  check('trainer page reaches the engine on this computer', true);

  // The headset: the app from the same website, as a headset's browser shows it (?landing).
  const headsetContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const headset = await headsetContext.newPage();
  watch(headset, 'headset');
  await headset.goto(`${SITE}?landing=1&demoReset=1`, { waitUntil: 'load', timeout: 60000 });
  await headset.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 90000 });
  await headset.waitForFunction((c) => globalThis.__duck.labLink.nearby.some((l) => l.code === c), code, { timeout: 20000 });
  const listed = await headset.evaluate(() => globalThis.__duck.labLink.nearby.map((l) => `${l.name} ${l.code}`));
  check('headset lists the trainer with its code', true, listed.join('; '));

  const index = await headset.evaluate((c) => globalThis.__duck.labLink.nearby.findIndex((l) => l.code === c), code);
  const t0 = Date.now();
  await headset.evaluate((i) => globalThis.__duck.labLink.pair(i), index);
  await headset.waitForFunction(() => globalThis.__duck.labLink.connected, null, { timeout: 30000 });
  check('headset connects to the trainer over WebRTC', true, `${Date.now() - t0} ms`);
  await trainer.waitForFunction(() => document.getElementById('chip-headset')?.className.includes('on'), null, { timeout: 15000 });
  check('trainer page shows the headset', true, await trainer.textContent('#chip-headset'));

  // A brain comes down: the engine's active release, offered on the headset.
  await headset.waitForFunction(
    (id) => globalThis.__duck.policyInbox.linked.some((r) => r.id === id) && globalThis.__duck.policyInbox.offer?.id === id,
    active.id,
    { timeout: 30000 },
  );
  const kept = await headset.evaluate(async (id) => {
    const cache = await caches.open('ducklab-brains');
    return (await cache.keys()).filter((r) => r.url.includes(encodeURIComponent(id))).length;
  }, active.id);
  check('active brain arrives over the link and is offered', kept === 7, `${active.name}: ${kept} files kept`);
  await headset.evaluate(() => globalThis.__duck.policyInbox.accept());
  await headset.waitForFunction((id) => globalThis.__duck.policyInbox.current?.id === id, active.id, { timeout: 30000 });
  const hash = await headset.evaluate(() => globalThis.__duck.duck.policyHash);
  check('the duck runs the brain from the link', hash === active.walkHash, `walk ${hash}, release ${active.walkHash}`);

  // A pack goes up.
  await headset.evaluate(() => globalThis.__duck.nav.runCourse());
  await wait(16000); // two snapshots' worth of walking
  await headset.evaluate(() => globalThis.__duck.scenario.capture('manual'));
  await headset.waitForFunction(() => /sent to|failed|nothing/.test(globalThis.__duck.scenario.summary), null, { timeout: 40000 });
  const summary = await headset.evaluate(() => globalThis.__duck.scenario.summary);
  const fresh = readdirSync(SCENARIOS).filter((f) => !packsBefore.has(f));
  check('scenario pack goes to the trainer over the link', /sent to Duck Lab XR/.test(summary) && fresh.length === 1, `${summary} | new: ${fresh.join(', ')}`);
  await trainer.waitForFunction((n) => document.querySelectorAll('#packs .pack').length >= n, engine.packs.length + 1, { timeout: 15000 });
  check('trainer page lists the new pack', true);

  // A new visit (without ?demoReset, which forgets the chosen brain): the
  // headset reconnects by itself and is still on the brain.
  await headset.goto(`${SITE}?landing=1`, { waitUntil: 'load', timeout: 60000 });
  await headset.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 90000 });
  const t1 = Date.now();
  await headset.waitForFunction(() => globalThis.__duck.labLink.connected, null, { timeout: 30000 });
  check('after a reload the headset reconnects by itself', true, `${Date.now() - t1} ms after the duck woke`);
  await headset.waitForFunction((id) => globalThis.__duck.policyInbox.current?.id === id, active.id, { timeout: 30000 });
  check('and keeps the chosen brain', (await headset.evaluate(() => globalThis.__duck.duck.policyHash)) === active.walkHash);

  // Unpair.
  await headset.evaluate(async () => {
    await globalThis.__duck.policyInbox.revert();
    globalThis.__duck.labLink.forget();
  });
  await trainer.waitForFunction(() => !document.getElementById('chip-headset')?.className.includes('on'), null, { timeout: 20000 });
  check('forget closes the link on both sides', true);
  for (const file of readdirSync(SCENARIOS).filter((f) => !packsBefore.has(f))) rmSync(join(SCENARIOS, file));
} catch (err) {
  check('pairing run', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
  for (const file of readdirSync(SCENARIOS).filter((f) => !packsBefore.has(f))) rmSync(join(SCENARIOS, file), { force: true });
}
check('no page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
console.log(JSON.stringify({ passed, failed: results.length - passed }));
process.exit(passed === results.length ? 0 : 1);
