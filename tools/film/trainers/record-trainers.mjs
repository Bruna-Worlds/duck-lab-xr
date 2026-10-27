// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainers film's take: Duck Lab XR's trainer page in a browser of its
 * own, driving the whole flow with an outside trainer, for real:
 *   packs     tick the scenario packs to train on (the inbox)
 *   trainer   the Trainer picker: the built-in fine-tune, Isaac Lab 3, Pollen's microduck_rl
 *   settings  name, robots, iterations; Train
 *   start     the trainer starting and its first iterations, live
 *   lapse     the hours of training: one picture every LAPSE seconds
 *   export    the newest checkpoint exported, the release made, the cross-check filling, live
 *   release   the new release's card; the cursor rests on Send to headset (not clicked)
 * Like the stacked film's trainer take: frames with wall-clock times
 * (frames.json), marks.txt (captions; "!ff N" plays from there N times faster,
 * "!fit N" fits what follows, up to the next such mark, into N seconds; "!lapse"
 * to "!live" is the time-lapse; "!train" the click, "!end" the end) and focus.json
 * (which card to zoom on, in page pixels, over time); compose-trainers.mjs
 * makes the film. Its browser profile is thrown away; the job it starts is the
 * trainer page's, and goes on if this stops.
 *
 *   node tools/film/trainers/record-trainers.mjs [dir]
 *
 * Env: LAB (http://127.0.0.1:8790), TRAINER (microduck-rl), ENVS (4096),
 * ITERATIONS (3000), NAME (pollen-ppo-3000), PACKS (comma list), LAPSE (15 s),
 * SEND=1 (click Send to headset at the end, "!sent"). TRAINER=microduck-stepup
 * films the climbing task (tools/train/python/duckstep), TRAINER=isaaclab-nav-camera
 * the camera brain (tools/train/python/isaacnav), each with its own captions;
 * both train on the first ticked test case, and the take shows the training
 * ground it makes ("!ground").
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const dir = process.argv[2] ?? 'artifacts/video/trainers/take';
const LAB = process.env.LAB ?? 'http://127.0.0.1:8790';
const TRAINER = process.env.TRAINER ?? 'microduck-rl';
const ENVS = process.env.ENVS ?? '4096';
const ITERATIONS = process.env.ITERATIONS ?? '3000';
const NAME = process.env.NAME ?? 'pollen-ppo-3000';
const LAPSE = Number(process.env.LAPSE ?? 15);
const SEND = process.env.SEND === '1';
const SAY =
  TRAINER === 'microduck-stepup'
    ? {
        packs: 'The test case from the headset arrives: tick it',
        picker: "Pick a trainer: the built-in fine-tune, NVIDIA's Isaac Lab 3, Pollen's microduck_rl, or its climbing task",
        ground: 'The test case becomes the training ground: its mat and dog bed, where Pip started and the way it went',
        start: 'Climbing practice on copies of the test case: PPO in mjlab, continuing the brain that fell',
        lapse: 'Rounds of training on an RTX 3070: three in five patches are the test case, the rest earlier terraces and flat floor',
        done: 'Done: the newest checkpoint, its normaliser inside, 61 numbers in, 14 out',
        check: 'Before it goes anywhere: the test case replayed in three physics engines, old brain against new',
      }
    : TRAINER === 'isaaclab-nav-camera'
      ? {
          packs: 'The test case from the headset arrives: Pip stuck at the coffee table',
          picker: "Pick a trainer: NVIDIA's Isaac Lab 3 for the camera brain",
          ground: "The test case becomes the training ground: the table, the couches, Pip's start and goal, and what its camera saw",
          start: 'Isaac Lab 3 on Newton: the camera brain learns from the depth brain in rooms rebuilt from the test case',
          lapse: 'Rounds of training on an RTX 3070: 256 ducks, 7 rooms in 10 a copy of the test case',
          done: 'Done: the camera brain exported, picture and sensor in, a turn and a speed out',
          check: 'Before it goes anywhere: both camera brains drive in rooms rebuilt from the test case',
        }
      : {
        packs: 'Hard moments from the headset arrive as scenario packs: tick the ones to train on',
        picker: "Pick a trainer: the built-in fine-tune, NVIDIA's Isaac Lab 3, or Pollen's own microduck_rl",
        start: "Pollen's recipe starts: PPO on MuJoCo-Warp, with their servo model and randomisation",
        lapse: 'The hours of training, on an RTX 3070: the reward climbs as the ducks learn to walk',
        done: 'Done: the newest checkpoint is exported with its normaliser inside, 61 numbers in, 14 out',
        check: 'Before it goes anywhere: cross-checked against the shipped brain in three physics engines',
      };
// The six packs of the earlier cross-checks (tools/train/README.md section 8), so the numbers compare.
const PACKS = (
  process.env.PACKS ??
  '2026-10-22T07-53-10-falls,2026-10-22T07-43-01-stuck,2026-10-22T07-36-31-manual,2026-10-24T01-02-31-manual,2026-10-22T22-33-11-manual,2026-10-22T19-24-24-stuck'
).split(',');
const VIEW = { width: 1440, height: 810 };
// Drawn at twice the page size: the film zooms close onto single cards. (Chrome's own flag: with
// Playwright's deviceScaleFactor, headless screencast frames come at the page's size, 1440 x 810.)
const SCALE = 2;
rmSync(dir, { recursive: true, force: true });
mkdirSync(`${dir}/frames`, { recursive: true });

const now = () => Date.now() / 1000;
const marks = [];
const mark = (text) => {
  marks.push(`${now().toFixed(3)} ${text}`);
  console.log(`${new Date().toISOString().slice(11, 19)} MARK ${text}`);
};
const focus = [];
const frames = [];
let count = 0;
const save = () => {
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
  writeFileSync(`${dir}/marks.txt`, `${marks.join('\n')}\n`);
  writeFileSync(`${dir}/focus.json`, JSON.stringify({ view: VIEW, scale: SCALE, focus }));
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', `--force-device-scale-factor=${SCALE}`] });
const context = await browser.newContext({ viewport: VIEW });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);

/**
 * Zoom the film onto the card holding `selector`: its width, from its top (or `selector`'s own top
 * with card: false) down to its bottom (or `to`'s bottom), inside the view; padding in page px.
 */
async function zoom(selector, { pad = 14, card = true, to = null, h = null, ease } = {}) {
  const rect = selector
    ? await page.evaluate(
        ([sel, end, p, wholeCard, height]) => {
          const el = document.querySelector(sel);
          const box = el?.closest('.card') ?? el;
          if (!box) return null;
          const c = box.getBoundingClientRect();
          const top = wholeCard ? c.top : el.getBoundingClientRect().top;
          const b = end ? document.querySelector(end)?.getBoundingClientRect() : null;
          // A tall card (the inbox, the cross-check) shows only its top `height` px: closer in 16:9.
          const bottom = Math.min(innerHeight, height ? top + height : b ? b.bottom : c.bottom);
          const y = Math.max(0, top - p);
          return { x: c.left - p, y, w: c.width + 2 * p, h: Math.min(innerHeight, bottom + p) - y };
        },
        [selector, to, pad, card, h],
      )
    : null;
  focus.push({ t: now(), ...(rect ?? { x: 0, y: 0, w: VIEW.width, h: VIEW.height }), ...(ease ? { ease } : {}) });
}

/** Scroll the window so the card holding `selector` starts `top` px below the top of the view. */
async function scrollTo(selector, top = 12) {
  await page.evaluate(
    ([sel, t]) => {
      const card = document.querySelector(sel)?.closest('.card');
      if (card) window.scrollTo({ top: card.getBoundingClientRect().top + scrollY - t, behavior: 'smooth' });
    },
    [selector, top],
  );
  await wait(900);
}

/** The film's cursor glides to the middle of an element (the page has none of its own in a screencast). */
async function moveTo(selector, steps = 24) {
  let box = await page.locator(selector).first().boundingBox();
  if (!box) return null;
  // Out of the view (a taller card above it): bring it in first, or the click lands on nothing.
  if (box.y < 0 || box.y + box.height > VIEW.height) {
    await page.evaluate(([sel, h]) => {
      const el = document.querySelector(sel);
      window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - h * 0.6, behavior: 'smooth' });
    }, [selector, VIEW.height]);
    await wait(900);
    box = await page.locator(selector).first().boundingBox();
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
  return box;
}
const ripple = () => page.evaluate(() => globalThis.__filmRipple?.());

// One DevTools session for every frame (live and time-lapse alike: the same size, the same clock).
const cdp = await context.newCDPSession(page);
let keep = 'none'; // 'all' frames, 'one' (the next, for the time-lapse), or 'none'
let gotOne = null;
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  if (keep === 'none') return;
  const file = `f${String(count++).padStart(6, '0')}.jpg`;
  writeFileSync(`${dir}/frames/${file}`, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
  if (keep === 'one') {
    keep = 'none';
    gotOne?.();
  }
});
let casting = false;
async function screencast(on) {
  if (on && !casting) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 86, everyNthFrame: 2 });
  else if (!on && casting) await cdp.send('Page.stopScreencast');
  casting = on;
  keep = on ? 'all' : 'none';
}
/** One picture now, as a frame of the take (the time-lapse): the screencast, for one frame. */
async function still() {
  const got = new Promise((resolve) => (gotOne = resolve));
  keep = 'one';
  if (!casting) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 86, everyNthFrame: 2 });
  await Promise.race([got, wait(5000)]);
  if (!casting) await cdp.send('Page.stopScreencast');
  keep = casting ? 'all' : 'none';
}
const logText = () => page.evaluate(() => document.getElementById('train-log')?.textContent ?? '');

try {
  await page.goto(LAB, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.pack[data-id]').length > 0 && document.querySelectorAll('#t-trainer option').length > 1, null, { timeout: 60000 });
  await page.evaluate(() => {
    // A repainting pixel keeps screencast frames coming while the page is still.
    const style = document.createElement('style');
    style.textContent = `@keyframes duckFilmPulse { from { opacity: 0.98; } to { opacity: 1; } }
      body::after { content: ""; position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; background: #0f1020; animation: duckFilmPulse 0.1s infinite alternate; }
      #film-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none; transition: opacity 0.3s; }
      .film-ripple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #ffcf3f; z-index: 2147483646; pointer-events: none; animation: filmRipple 0.5s ease-out forwards; }
      @keyframes filmRipple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'film-cursor';
    cursor.innerHTML =
      '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.5 15 L18.5 15 Z" fill="#fff4dc" stroke="#0f1020" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    cursor.style.opacity = '0';
    document.body.appendChild(cursor);
    let x = 0;
    let y = 0;
    addEventListener('mousemove', (e) => {
      x = e.clientX;
      y = e.clientY;
      cursor.style.opacity = '1';
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    });
    globalThis.__filmRipple = () => {
      const r = document.createElement('div');
      r.className = 'film-ripple';
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 600);
    };
    addEventListener('mousedown', () => globalThis.__filmRipple());
    globalThis.__filmHideCursor = () => (cursor.style.opacity = '0');
    // Start clean: nothing ticked, the inbox at its top.
    for (const box of document.querySelectorAll('#packs input[data-check]:checked')) box.click();
    document.getElementById('packs').scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.mouse.move(VIEW.width * 0.55, VIEW.height * 0.6);
  await screencast(true);
  await zoom(null);
  await wait(1200);

  // --- packs: the headset's hard moments, ticked ---
  await scrollTo('#packs', 12);
  await zoom('#packs', { pad: 10, h: 470 });
  mark(SAY.packs);
  await wait(1400);
  for (const id of PACKS) {
    const item = `.pack[data-id="${id}"]`;
    if (!(await page.locator(item).count())) {
      console.log(`no pack ${id}: skipped`);
      continue;
    }
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const list = document.getElementById('packs');
      const top = el.offsetTop - list.offsetTop - 24;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - el.offsetHeight - 48) list.scrollTo({ top, behavior: 'smooth' });
    }, item);
    await wait(650);
    await moveTo(`${item} input[data-check]`, 14);
    await wait(120);
    await page.mouse.down();
    await page.mouse.up();
    await wait(380);
    // A click during the list's smooth scroll can land beside the box: tick it for sure.
    const tick = page.locator(`${item} input[data-check]`);
    if (!(await tick.isChecked())) await tick.check();
  }
  const ticked = await page.evaluate(() => document.querySelectorAll('#packs input[data-check]:checked').length);
  if (ticked !== PACKS.length) console.log(`only ${ticked} of ${PACKS.length} packs ticked`);
  mark('!ff 1');
  await wait(900);

  // --- trainer: the picker ---
  await scrollTo('#t-trainer', 12);
  await zoom('#t-trainer', { pad: 12, to: '#train' });
  mark(SAY.picker);
  await moveTo('#t-trainer');
  for (const id of ['es', 'isaaclab', TRAINER]) {
    await ripple();
    await page.selectOption('#t-trainer', id);
    // Cut points for the film: away to Isaac Lab's own viewer, back for the pick.
    if (id === 'isaaclab') mark('!isaaclab');
    if (id === TRAINER) mark('!picked');
    await wait(id === TRAINER ? 1600 : 2300);
  }

  // --- ground: the training ground the test case makes (trainers that train on it) ---
  if (SAY.ground && (await page.locator('#t-ground').isVisible())) {
    await page.mouse.move(VIEW.width * 0.95, VIEW.height * 0.5, { steps: 10 });
    await scrollTo('#t-ground', 12);
    await zoom('#t-ground', { pad: 10, card: false, to: '#t-ground' });
    mark('!ground');
    mark(SAY.ground);
    await wait(6500);
    // The settings and Train, below the ground: in the view.
    await page.evaluate(() => {
      const el = document.getElementById('t-outside');
      window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 190, behavior: 'smooth' });
    });
    await wait(900);
    await zoom('#t-outside', { pad: 12, card: false, to: '#train' });
  }

  // --- settings, then Train ---
  mark(`${Number(ENVS).toLocaleString('en-US')} robots at once on the GPU, ${Number(ITERATIONS).toLocaleString('en-US')} rounds of practice`);
  for (const [sel, value] of [
    ['#t-oname', NAME],
    ['#t-envs', ENVS],
    ['#t-oiterations', ITERATIONS],
  ]) {
    await moveTo(sel, 14);
    await page.mouse.down();
    await page.mouse.up();
    await page.fill(sel, '');
    await page.type(sel, value, { delay: 70 });
    await wait(250);
  }
  await wait(700);
  await moveTo('#train', 16);
  await wait(300);
  await page.mouse.down();
  await page.mouse.up();
  mark('!train');
  await wait(1500);

  // --- start: the trainer starts (outside code, in its own folder), the first iterations ---
  await page.mouse.move(VIEW.width * 0.62, VIEW.height * 0.92, { steps: 18 });
  await page.evaluate(() => globalThis.__filmHideCursor());
  // The chart and the newest log lines (newest on top), together in the view.
  await page.evaluate(() => {
    const chart = document.getElementById('chart');
    window.scrollTo({ top: chart.getBoundingClientRect().top + scrollY - 140, behavior: 'smooth' });
    document.getElementById('train-log').scrollTop = 0;
  });
  await wait(900);
  await zoom('#train', { pad: 10, card: false, to: '#train-log' });
  mark(SAY.start);
  // Live until a few iterations are in (the GPU code compiles first); the film fits it into a few seconds.
  const liveFrom = Date.now();
  mark('!fit 9');
  while (Date.now() - liveFrom < 240000) {
    const chip = (await page.textContent('#chip-trainer')) ?? '';
    const it = Number(/iteration (\d+)/i.exec(chip)?.[1] ?? 0);
    if (it >= 12) break;
    await wait(1000);
  }
  await zoom('#chart', { pad: 12, card: false, to: '#train-log' });
  await wait(6000);
  save();

  // --- lapse: the hours, a picture every LAPSE s, until the trainer exports ---
  await screencast(false);
  mark('!lapse');
  mark(SAY.lapse);
  let lastSave = Date.now();
  for (;;) {
    await still();
    const log = await logText();
    if (/export\.py|isaaclab play|onnx_single_file|cross-checking|drive_check|Trained: release|Training failed|Finished without/i.test(log)) break;
    if (Date.now() - lastSave > 60000) {
      save();
      lastSave = Date.now();
    }
    await wait(LAPSE * 1000);
  }
  mark('!live');

  // --- export: the brain leaves the trainer, becomes a release, is cross-checked ---
  await screencast(true);
  await zoom('#train-log', { pad: 12, card: false, to: '#train-log' });
  mark(SAY.done);
  mark('!fit 6');
  await page.waitForFunction(() => /cross-checking/i.test(document.getElementById('train-log')?.textContent ?? ''), null, { timeout: 900000 }).catch(() => {});
  await wait(1500);
  await scrollTo('#cc-run', 40);
  await zoom('#cc-run', { pad: 12, card: false, h: 300 });
  mark(SAY.check);
  mark('!fit 9');
  await page.waitForFunction(() => /Trained: release|Finished without|failed/i.test(document.getElementById('train-log')?.textContent ?? ''), null, { timeout: 1800000 }).catch(() => {});
  mark('!fit 8');
  await wait(2500);
  mark('!release'); // where a pickup of the release card (record-release.mjs) can take over
  await zoom('#cc-table', { pad: 8, card: false });
  await wait(4000);

  // --- release: its card, Send to headset within reach ---
  const card = page.locator('.release').first();
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy({ top: 120, behavior: 'smooth' }));
  await wait(900);
  const box = await card.boundingBox();
  if (box) focus.push({ t: now(), x: box.x - 10, y: box.y - 10, w: box.width + 20, h: box.height + 20 });
  mark('A release, beside the shipped brain: send it to the headset when the numbers say so');
  await wait(1200);
  const send = card.locator('[data-activate]');
  if (await send.count()) {
    const b = await send.boundingBox();
    if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 26 });
    if (SEND) {
      await wait(900);
      await page.mouse.down();
      await page.mouse.up();
      mark('!sent');
      console.log('sent to the headset');
    }
  }
  await wait(4500);
  mark('!end');
  await screencast(false);
} finally {
  save();
  await browser.close();
}
console.log(`REC ${count} frames -> ${dir}`);
