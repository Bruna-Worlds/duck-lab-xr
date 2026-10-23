// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The REAL DUCK link against the mock rendezvous (tools/test/mock-central.mjs
 * on port 8799): link, mirror the walk at a polite rate, mirror moves as the
 * duck's skills, read telemetry, flash a brain from a Hub repo, unlink.
 *
 *   node tools/test/mock-central.mjs &
 *   npx @iwsdk/cli browser run tools/test/real-duck-check.mjs --timeout 100000
 */
import { existsSync, readFileSync } from 'node:fs';

const MOCK = process.env.MOCK_CENTRAL ?? 'http://localhost:8799';
const INDEX = 'public/policies/incoming/index.json';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
const mockLog = async () => (await fetch(`${MOCK}/log`)).json();

export default async function run({ page, frame }) {
  const app = frame ?? page;
  await fetch(`${MOCK}/reset`, { method: 'POST' });
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  // Point the link at the mock and give it a (fake) token, as the LINK prompt would.
  const linked = await app.evaluate(async (central) => {
    const d = globalThis.__duck;
    const Link = d.realDuck.link.constructor;
    d.realDuck.link = new Link(central);
    sessionStorage.setItem('duckdash.hfToken', 'hf_test_token');
    await d.realDuck.connect();
    return { state: d.realDuck.link.state, status: d.realDuck.link.status, battery: d.realDuck.link.battery };
  }, MOCK);
  check('links to the duck on the account', linked.state === 'connected', `${linked.status}, battery ${linked.battery}%`);

  // Mirror: walk with the autopilot's command for 3 s.
  await fetch(`${MOCK}/reset`, { method: 'POST' });
  await app.evaluate(() => {
    const d = globalThis.__duck;
    d.realDuck.mirror = true;
    d.duck.autopilot = { forward: 1, turn: 0.4 };
  });
  await page.waitForTimeout(3000);
  await app.evaluate(() => {
    globalThis.__duck.duck.autopilot = null;
  });
  await page.waitForTimeout(800);
  let entries = await mockLog();
  const moves = entries.filter((e) => e.method === 'robot.move');
  const span = moves.length > 1 ? (moves[moves.length - 1].t - moves[0].t) / 1000 : 0;
  const rate = span > 0 ? (moves.length - 1) / span : 0;
  const maxVx = Math.max(0, ...moves.map((m) => m.params.vx));
  check('mirrors the walk at a polite rate', moves.length >= 5 && rate <= 6, `${moves.length} robot.move in ${span.toFixed(1)} s (${rate.toFixed(1)}/s), vx up to ${maxVx.toFixed(2)} m/s`);
  check('stops when the stick is let go', entries.some((e) => e.method === 'robot.stop'), entries.filter((e) => e.method === 'robot.stop').length + ' robot.stop');

  // Moves become the duck's skills.
  await fetch(`${MOCK}/reset`, { method: 'POST' });
  for (const move of ['kick', 'roll']) {
    await app.evaluate((m) => globalThis.__duck.duck.fireMove(m), move);
    await page.waitForTimeout(3500);
  }
  entries = await mockLog();
  const skills = entries.filter((e) => e.method === 'robot.do').map((e) => e.params.skill);
  check('moves become skills', skills.some((s) => s?.startsWith('kick_')) && skills.includes('roulade'), skills.join(', ') || 'none');

  // Telemetry arrives.
  const telemetry = await app.evaluate(() => {
    const t = globalThis.__duck.realDuck.link.telemetry;
    return t ? { joints: t.joints.length, gyro: t.gyro.length } : null;
  });
  check('reads the duck state', !!telemetry && telemetry.joints === 15, JSON.stringify(telemetry));

  // Flash: the running brain (a release published to a Hub repo) goes to the duck.
  await fetch(`${MOCK}/reset`, { method: 'POST' });
  const flash = await app.evaluate(async () => {
    const d = globalThis.__duck;
    d.policyInbox.current = { id: 'test-release', name: 'room-tuned', hubRepo: 'someone/duckdash-room-tuned', createdAt: '', trainer: '', baseHash: '', walkHash: '', packs: 1, fallRate: 0, baselineFallRate: 0 };
    await d.realDuck.flashBrain();
    const note = d.realDuck.note;
    d.policyInbox.current = null;
    return note;
  });
  entries = await mockLog();
  const methods = entries.map((e) => e.method);
  const fetched = entries.find((e) => e.method === 'policy.fetch');
  check(
    'flashes the brain from its Hub repo',
    methods.includes('policy.fetch') && methods.includes('robot.loadPolicy') && fetched?.params.repo === 'someone/duckdash-room-tuned',
    `${methods.join(' > ')} | ${flash}`,
  );

  // A brain published to the Hub after the player accepted it: the next index
  // poll brings its repo. The browser is handed an edited copy of the index
  // from disk (no file changes, no request to the dev server).
  const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : null;
  const target = index?.releases?.[0]?.id ?? null;
  if (target) {
    const LATE = 'someone/microduck-duckdash-late';
    for (const release of index.releases) if (release.id === target) release.hubRepo = LATE;
    const body = JSON.stringify(index);
    const route = (r) => r.fulfill({ status: 200, contentType: 'application/json', body });
    await page.route('**/policies/incoming/index.json', route);
    let repo = null;
    try {
      await app.evaluate((id) => {
        const inbox = globalThis.__duck.policyInbox;
        globalThis.__savedCurrent = inbox.current;
        inbox.current = { ...(inbox.releases.find((r) => r.id === id) ?? { id }), hubRepo: null };
      }, target);
      for (let i = 0; i < 24 && repo !== LATE; i++) {
        await page.waitForTimeout(500);
        repo = await app.evaluate(() => globalThis.__duck.policyInbox.current?.hubRepo ?? null);
      }
    } finally {
      await page.unroute('**/policies/incoming/index.json', route);
      await app.evaluate(() => {
        globalThis.__duck.policyInbox.current = globalThis.__savedCurrent ?? null;
        delete globalThis.__savedCurrent;
      });
    }
    check('a brain published after it was accepted can be flashed', repo === LATE, repo ?? 'no repo after 12 s');
  }

  await app.evaluate(() => globalThis.__duck.realDuck.forget());
  await page.waitForTimeout(500);
  entries = await mockLog();
  check('unlinks cleanly', entries.some((e) => e.method === 'endSession'), entries.map((e) => e.method).slice(-3).join(' > '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
