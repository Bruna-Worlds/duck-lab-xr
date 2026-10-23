// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Smoke tests through the IWSDK CLI, so a check is one command instead of a
 * dozen. Needs a running dev server with the managed browser (`npx @iwsdk/cli
 * dev up --open`).
 *
 *   node tools/test/smoke.mjs render     render every playground's hero view to artifacts/playgrounds/
 *   node tools/test/smoke.mjs runtime    reload the app, walk and kick in each playground, switch with ]
 *   node tools/test/smoke.mjs all
 *
 * Prints one line per check and a JSON summary; exits 1 when a check fails.
 */
import { exec } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(exec);
const results = [];

/** Quote one argument for the shell (cmd.exe on Windows, sh elsewhere). */
function quote(arg) {
  if (process.platform === 'win32') {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function cli(args, input) {
  const parts = ['npx', '@iwsdk/cli', ...args, '--raw'];
  if (input) parts.push('--input-json', quote(JSON.stringify(input)));
  const { stdout } = await run(parts.join(' '), { maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function playgrounds() {
  return JSON.parse(await readFile('public/scenes/playgrounds/index.json', 'utf8'));
}

async function render() {
  await mkdir('artifacts/playgrounds', { recursive: true });
  for (const p of await playgrounds()) {
    const out = `artifacts/playgrounds/${p.id}.png`;
    const res = await cli(
      ['scene', 'render-file', '--output-file', out],
      { path: `public/scenes/playgrounds/${p.id}.iwsdk.scene.json`, viewId: 'hero', width: 640, height: 400 },
    );
    const data = res.data ?? res;
    const result = data.result ?? data;
    const visible = result.visibleNodeIds?.length ?? result.visibleNodes?.length ?? 0;
    check(`render ${p.id}`, res.ok !== false && result.valid !== false, `visible ${visible}, ${out}${res.error ? ` ${res.error.message}` : ''}`);
  }
}

async function entityIndex(namePattern) {
  const res = await cli(['ecs', 'find'], { namePattern });
  const d = res.data?.result ?? res.data ?? res;
  const e = (d.entities ?? d.matches ?? [])[0];
  return e ? (e.entityIndex ?? e.index) : null;
}

/** The HUD is split over panels: the move bar carries the mood line, the scoreboard the rest. */
const PANEL_OF = { 'duck-mood': 'moves' };

async function hud(panels, ids) {
  const out = {};
  for (const id of ids) {
    const index = panels[PANEL_OF[id] ?? 'score'];
    const res = await cli(['ui', 'inspect'], { entityIndex: index, selector: `#${id}` });
    const d = res.data?.result ?? res.data ?? res;
    const e = (d.elements ?? d.matches ?? [])[0];
    out[id] = e ? (e.text ?? e.properties?.text ?? '') : null;
  }
  return out;
}

async function currentPlayground() {
  const res = await cli(['ecs', 'find'], { withComponents: ['Playground'] });
  const d = res.data?.result ?? res.data ?? res;
  const e = (d.entities ?? d.matches ?? [])[0];
  if (!e) return '';
  let q;
  try {
    q = await cli(['ecs', 'query'], { entityIndex: e.entityIndex ?? e.index });
  } catch {
    return ''; // the level switched between find and query: ask again
  }
  const comps = (q.data?.result ?? q.data ?? q).components ?? [];
  const pg = comps.find((c) => c.componentId === 'Playground');
  return pg?.values?.id ?? '';
}

async function waitFor(what, predicate, timeoutMs = 30000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await predicate();
    if (last) return last;
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function keys(steps) {
  const res = await cli(['browser', 'interact'], { steps, timeoutMs: 12000 });
  if (res.ok === false) throw new Error(`interact: ${res.error?.message}`);
}

async function runtime() {
  await cli(['browser', 'reload'], {});
  await sleep(3000);
  const list = await playgrounds();
  await mkdir('artifacts/playgrounds', { recursive: true });
  for (let i = 0; i < list.length; i++) {
    const expected = list[i].id;
    if (i > 0) {
      await keys([{ action: 'press', key: 'BracketRight' }]);
    }
    const id = await waitFor(`playground ${expected}`, async () => ((await currentPlayground()) === expected ? expected : null), 40000);
    const panel = {
      score: await waitFor('scoreboard', () => entityIndex('^Scoreboard$')),
      moves: await waitFor('move bar', () => entityIndex('^Moves Panel$')),
    };
    const awake = await waitFor(
      'duck awake',
      async () => {
        const h = await hud(panel, ['duck-mood', 'run-state']);
        return /woke|ready/i.test(h['duck-mood'] ?? '') && !/Loading/.test(h['run-state'] ?? '') ? h : null;
      },
      40000,
    );
    check(`load ${id}`, true, `${awake['run-state']} / ${awake['duck-mood']}`);
    // Walk forward three seconds, then kick.
    await keys([{ action: 'keyDown', key: 'KeyW' }, { action: 'wait', durationMs: 3000 }, { action: 'keyUp', key: 'KeyW' }]);
    await sleep(500);
    const walked = await hud(panel, ['run-state', 'run-time', 'run-score', 'item-crumbs']);
    // A room-only playground has no clock: walking is not a run there.
    const freeRoam = walked['run-state'] === 'Free roam';
    check(`walk ${id}`, walked['run-state'] === 'GO!' || freeRoam, `${walked['run-state']} ${walked['run-time']} score ${walked['run-score']} ${walked['item-crumbs']}`);
    await keys([{ action: 'press', key: 'KeyJ' }, { action: 'wait', durationMs: 1500 }]);
    const kicked = await hud(panel, ['run-combo', 'run-score', 'duck-mood']);
    check(`kick ${id}`, (kicked['run-combo'] ?? '').length > 1 || Number(String(kicked['run-score']).replace(/,/g, '')) > 0, `${kicked['run-combo']} / ${kicked['duck-mood']}`);
    const shot = `artifacts/playgrounds/runtime-${id}.png`;
    await cli(['browser', 'screenshot', '--output-file', shot], {});
    const logs = await cli(['browser', 'logs'], { count: 40 });
    const d = logs.data?.result ?? logs.data ?? logs;
    const entries = Array.isArray(d) ? d : (d.logs ?? d.entries ?? d.messages ?? []);
    // A request cut off by the reload above is not a fault: the hidden trainer frame keeps a live
    // connection to the trainer engine (src/ui/view-switch-system.ts), and a reload aborts it.
    const errors = entries
      .filter((l) => /error/i.test(String(l.level ?? l.type ?? '')))
      .map((l) => String(l.text ?? l.message ?? '').slice(0, 160))
      .filter((text) => !/net::ERR_ABORTED/.test(text));
    check(`console ${id}`, errors.length === 0, errors.slice(0, 3).join(' | '));
    // Restart so the next playground starts clean.
    await keys([{ action: 'press', key: 'KeyR' }]);
  }
}

const mode = process.argv[2] ?? 'all';
try {
  if (mode === 'render' || mode === 'all') await render();
  if (mode === 'runtime' || mode === 'all') await runtime();
} catch (err) {
  check('run', false, err instanceof Error ? err.message : String(err));
}
const failed = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
process.exit(failed ? 1 : 0);
