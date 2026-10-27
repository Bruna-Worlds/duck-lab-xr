// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The climbing film (1920 x 1080, 30 fps): the whole loop for one skill, from
 * real takes, the training ground made from the test case itself.
 *   fail/     the app (record-climb.mjs TAKE=fail, BRAIN=offer for a brain
 *             tried earlier): the brain in use falls on the Dog Bed's course
 *             and the app saves the moment as a test case
 *   page/     the trainer page (record-trainers.mjs TRAINER=microduck-stepup
 *             SEND=1): the test case in the inbox, the step-up trainer, the
 *             training ground the test case makes, the run live and as a
 *             time-lapse, the export, the cross-check, the release sent to the
 *             headset
 *   videos    mjlab's own training video of that run (128 of the ducks on
 *             copies of the test case; duckstep/train.py, DUCKSTEP_VIDEO_ENVS),
 *             cut in at the start and the end of the time-lapse
 *   try/      the app (TAKE=try): New brain ready, TRY IT by the controller's
 *             ray, the same course on the new brain
 *   film-ground.mp4  the new brain on copies of the test case at their own
 *             heights, 32 ducks, real speed (duckstep/film.py with DUCKLAB_GROUND)
 * plus a title, the step test's numbers on a card (BENCH, step-bench.mjs
 * --json) and an end card, captions in a band below, and a score written to
 * this cut (tools/film/trailer/music.mjs).
 *
 *   node tools/film/climb/compose-climb.mjs [takes dir] [out.mp4]
 *
 * Env: RUN (the training run's folder, for its videos), BENCH (the step test
 * JSON; BENCH_NAMES maps its brains to column names), NAME (the release),
 * BEFORE (the brain that fell), ENVS, ROUNDS.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, composeKit, esc, PAGE } from '../compose-kit.mjs';

const TAKES = process.argv[2] ?? 'artifacts/video/climb2';
const OUTFILE = process.argv[3] ?? join(TAKES, 'duck-lab-climb.mp4');
const RUN = process.env.RUN ?? '';
const BENCH = process.env.BENCH ?? '';
const NAME = process.env.NAME ?? 'step-up-ground';
const BEFORE = process.env.BEFORE ?? 'step-up-6';
const ENVS = process.env.ENVS ?? '1,024';
const ROUNDS = process.env.ROUNDS ?? '1,000';
const CROWD_S = Number(process.env.CROWD_S ?? 8);
const kit = await composeKit({
  takes: TAKES,
  captions: {
    [`${ENVS} robots at once on the GPU, ${ROUNDS} rounds of practice`]: `${ENVS} ducks at once on the GPU, <b>${ROUNDS} more rounds</b> of climbing practice`,
    // Recorded before the terraces were rehearsed alongside: three in five patches are copies.
    'Rounds of training on an RTX 3070: every patch is the test case, the steps a little lower or taller':
      'Rounds of training on an RTX 3070: <b>three in five patches are the test case</b>, the rest earlier terraces and flat floor',
  },
});
const { add, appPart, card, clipPart, loadAppTake, loadPageTake, markAt, now, hit, pagePart } = kit;

const page = loadPageTake('page');
const fail = loadAppTake('fail');
const tryTake = loadAppTake('try');
if (!page || !fail || !tryTake) throw new Error('the film needs the fail, page and try takes');

const videos = RUN && existsSync(join(RUN, 'videos', 'train'))
  ? readdirSync(join(RUN, 'videos', 'train'))
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ file: join(RUN, 'videos', 'train', f), step: Number(/step-(\d+)/.exec(f)?.[1] ?? 0) }))
      .sort((p, q) => p.step - q.step)
  : [];
const STEPS_PER_ROUND = 24;
const incoming = 'public/policies/incoming';
const release = (existsSync(incoming) ? readdirSync(incoming) : [])
  .filter((d) => existsSync(join(incoming, d, 'manifest.json')))
  .map((d) => JSON.parse(readFileSync(join(incoming, d, 'manifest.json'), 'utf8')))
  .filter((r) => r.name === NAME)
  .sort((p, q) => String(q.createdAt).localeCompare(String(p.createdAt)))[0];
const bench = BENCH && existsSync(BENCH) ? JSON.parse(readFileSync(BENCH, 'utf8')) : null;

/** Where on the Dog Bed's course (stage x, m): the 2 cm mat 0.5 to 1.0, the 3 cm bed 1.42 to 2.02. */
const where = (x) => (x < 0.45 ? 'BEFORE THE MAT' : x < 1.0 ? 'ON THE 2 CM MAT' : x < 1.38 ? 'BEFORE THE DOG BED' : x < 1.5 ? "AT THE DOG BED'S EDGE" : 'ON THE DOG BED');
const fallsIn = (take, from) => take.trace.filter((s, i) => i > 0 && s.t > from && s.falls > take.trace[i - 1].falls);

add(
  await card(
    'intro',
    `<div class="card">
      <div class="title">TEACHING PIP TO CLIMB<br><b>ON ITS OWN TEST CASE</b></div>
      <div class="chips"><span class="chip on">A FALL IN THE APP</span><span class="arrow">&rarr;</span><span class="chip">TEST CASE</span><span class="arrow">&rarr;</span><span class="chip on">ITS GROUND, COPIED</span><span class="arrow">&rarr;</span><span class="chip">${ENVS} DUCKS TRAIN</span><span class="arrow">&rarr;</span><span class="chip on">CROSS-CHECK</span><span class="arrow">&rarr;</span><span class="chip">NEW BRAIN IN THE APP</span></div>
      <div class="sub">Every shot is a real take: the app, the trainer page and the training run on one RTX 3070.</div>
    </div>`,
    4.2,
    1.0,
    1.03,
  ),
  'gap',
  { kind: 'arrive', at: 0.3 },
);

// The falls, and the test case.
const failPacked = fail.marks.packed ?? fail.marks['course-end'];
const says = fail.trace.find((s) => s.packs > 0)?.says ?? '';
const seconds = /(\d+) s test case/.exec(says)?.[1];
const failFrom = fail.marks.course + 0.5;
const FAIL_SPEED = 2;
const falls = fallsIn(fail, failFrom);
for (const f of falls) hit(now() + (f.t - failFrom) / FAIL_SPEED, 'fall');
add(
  await appPart(fail, failFrom, Math.min(fail.marks['course-end'], failPacked + 3), 'fail', FAIL_SPEED, [
    { t: failFrom, html: `THE DOG BED COURSE: A 2 CM MAT, A 3 CM DOG BED. <b>PIP ON ${esc(BEFORE.toUpperCase())}</b>, THE BEST CLIMBER SO FAR` },
    ...falls.slice(0, 2).map((f, i) => ({ t: f.t - 0.6, html: `${i ? 'AND AGAIN' : 'A FALL'}: <b>${where(f.at[0])}</b>` })),
    { t: failPacked - 0.3, html: `TWO FALLS: THE APP SAVES THE MOMENT${seconds ? ` (${seconds} S)` : ''} AS A TEST CASE <b>AND SENDS IT TO THE PC</b>` },
  ], APP),
  'wear',
  { kind: 'quack', at: 0.4 },
);

// The trainer page: inbox, picker, the training ground, Train, the first rounds.
const t0 = Math.max(page.frames[0].t, page.captions[0].t - 1.0);
const lapseAt = markAt(page, '!lapse');
const liveAt = markAt(page, '!live');
add(await pagePart(page, t0, lapseAt, 'page-1', { label: PAGE, speed: 1.6 }), 'wear', { kind: 'try', at: 2 });

// mjlab's training video: early in the run, and late.
const roundOf = (v) => Math.round(v.step / STEPS_PER_ROUND);
const early = videos.find((v) => v.step > 0) ?? videos[0];
const late = videos.length > 2 ? videos[videos.length - 1] : null;
if (early) {
  add(
    await clipPart(early.file, 0.6, CROWD_S, 'crowd-1', [
      { at: 0, html: `REAL TRAINING FRAMES: <b>128 OF THE ${ENVS} DUCKS</b> ON COPIES OF THE TEST CASE, EARLIER TERRACES BEHIND (THEY WALK THROUGH EACH OTHER)` },
      { at: CROWD_S / 2, html: 'THE MAT AND THE DOG BED WHERE THEY WERE: <b>LOWER COPIES FIRST, TALLER ONCE A DUCK GETS PAST WHERE PIP FELL</b>' },
    ], `MJLAB'S OWN RENDERER <i>&middot;</i> THIS RUN, ROUND ${roundOf(early)} <i>&middot;</i> REAL TIME`),
    'real',
    { kind: 'train', len: CROWD_S },
  );
}
add(await pagePart(page, lapseAt, liveAt, 'lapse', { label: PAGE, clock: true }), 'real', { kind: 'brain' });
if (late) {
  add(
    await clipPart(late.file, 0.6, CROWD_S - 2, 'crowd-2', [{ at: 0, html: `ROUND ${roundOf(late)} OF ${ROUNDS}: <b>THE SAME CROWD ON THE SAME TEST CASE</b>` }], `MJLAB'S OWN RENDERER <i>&middot;</i> THIS RUN, ROUND ${roundOf(late)} <i>&middot;</i> REAL TIME`),
    'real',
  );
}
// Export, cross-check, release, Send to headset.
add(await pagePart(page, liveAt, page.end, 'page-2', { label: PAGE, speed: 1.4 }), 'deploy', { kind: 'brain' });

// The app: the offer, TRY IT, the same course.
const pressed = tryTake.marks.pressed;
add(
  await appPart(tryTake, tryTake.marks.offer, pressed + 1.5, 'offer', 1, [
    { t: tryTake.marks.offer, html: `BACK IN THE APP: <b>NEW BRAIN READY</b> ON PIP CAM (${esc(release?.name ?? NAME)})` },
    { t: pressed - 0.8, html: 'TRY IT, WITH THE CONTROLLER: <b>THE NEW BRAIN LOADS WHILE PIP STANDS THERE</b>' },
  ], APP, '1440:810:200:150'),
  'deploy',
  { kind: 'try', at: Math.max(0.2, pressed - tryTake.marks.offer) },
);
add(
  await appPart(tryTake, tryTake.marks['offer-end'] - 2.4, tryTake.marks['offer-end'], 'loaded', 1, [
    { t: tryTake.marks['offer-end'] - 2.4, html: `A FEW SECONDS LATER: <b>BRAIN: ${esc((release?.name ?? NAME).toUpperCase())}</b>, WITH A REVERT BUTTON` },
  ], APP, '1600:900:120:180'),
  'deploy',
  { kind: 'success', at: 0.2 },
);
const climbFrom = tryTake.marks.course + 0.4;
const tryEnd = tryTake.marks['course-end'];
const run = tryTake.trace.filter((s) => s.t >= tryTake.marks.course);
const z0 = run[0].at[2];
const onMat = run.find((s) => s.at[0] > 0.5 && s.at[0] < 1.0 && s.at[2] - z0 > 0.015)?.t;
const onBed = run.find((s) => s.at[0] > 1.5 && s.at[2] - z0 > 0.022)?.t;
const tryFalls = fallsIn(tryTake, climbFrom);
const finishedAt = run.find((s) => /finished/i.test(s.status ?? ''))?.t;
const SPEED = 1.5;
if (onMat) hit(now() + (onMat - climbFrom) / SPEED, 'success');
if (onBed) hit(now() + (onBed - climbFrom) / SPEED, 'success');
for (const f of tryFalls) hit(now() + (f.t - climbFrom) / SPEED, 'fall');
const caps = [
  { t: climbFrom, html: `THE SAME COURSE ON THE NEW BRAIN: <b>WHERE ${esc(BEFORE.toUpperCase())} FELL TWICE</b>` },
  ...(onMat ? [{ t: onMat - 0.4, html: 'UP THE 2 CM MAT' }] : []),
  ...(onBed ? [{ t: onBed - 0.4, html: `AND UP THE 3 CM DOG BED${tryFalls.length ? '' : ': <b>NO FALLS</b>'}` }] : []),
  ...tryFalls.slice(0, 2).map((f) => ({ t: f.t - 0.5, html: `A FALL: <b>${where(f.at[0])}</b>` })),
  ...(finishedAt ? [{ t: finishedAt - 0.4, html: `ON TO THE FINISH${tryFalls.length ? `, WITH ${tryFalls.length} FALL${tryFalls.length > 1 ? 'S' : ''}` : ''}` }] : []),
].sort((p, q) => p.t - q.t);
add(await appPart(tryTake, climbFrom, tryEnd, 'climb', SPEED, caps, APP), 'catch');

// The course in the app, several runs each (APP_RUNS: tools/test/dog-bed-check.mjs results).
const appRuns = existsSync(join(TAKES, 'app-runs.json')) ? JSON.parse(readFileSync(join(TAKES, 'app-runs.json'), 'utf8')) : null;
if (appRuns) {
  const got = (list) => list.filter((v) => v !== null);
  const span = (list) => (got(list).length ? `${Math.min(...got(list)).toFixed(0)}&ndash;${Math.max(...got(list)).toFixed(0)} s` : '');
  const [old, neu] = appRuns.brains;
  const row = (label, f) => `<tr><td>${label}</td><td>${f(old)}</td><td>${f(neu)}</td></tr>`;
  add(
    await card(
      'app-runs',
      `<div class="card">
        <div class="title">THE DOG BED COURSE IN THE APP: <b>${old.mat.length} RUNS EACH</b></div>
        <table>
          <tr><th></th><th>${esc(old.name)}</th><th>${esc(neu.name)}</th></tr>
          ${row('Onto the 2 cm mat', (b) => `${got(b.mat).length} / ${b.mat.length}, ${span(b.mat)}`)}
          ${row('Onto the 3 cm dog bed', (b) => `${got(b.bed).length} / ${b.bed.length}`)}
          ${row('Falls on the way', (b) => `${b.falls.reduce((x, y) => x + y, 0)}`)}
        </table>
        <div class="small">The autopilot runs the course for ${appRuns.seconds} s a run (tools/test/dog-bed-check.mjs). It learned its own course: quicker onto the mat, onto the dog bed every time, but more falls on the way.</div>
      </div>`,
      7,
      1.02,
      1.0,
    ),
    'catch',
    { kind: 'card' },
  );
}

// The step test.
if (bench) {
  const brains = [...new Set(bench.table.map((r) => r.brain))];
  const heights = [...new Set(bench.table.map((r) => r.heightCm))];
  const NAMES = JSON.parse(process.env.BENCH_NAMES ?? '{}');
  const cell = (brain, h) => {
    const r = bench.table.find((x) => x.brain === brain && x.heightCm === h);
    const best = Math.max(...brains.map((b) => bench.table.find((x) => x.brain === b && x.heightCm === h)?.up ?? 0));
    return `<td class="${r.up === 0 ? 'none' : r.up === best ? 'best' : ''}">${r.up} / ${r.seeds}</td>`;
  };
  add(
    await card(
      'bench',
      `<div class="card">
        <div class="title">HOW HIGH A STEP: <b>UP, OUT OF ${bench.table[0].seeds} TRIES</b></div>
        <table>
          <tr><th>Step</th>${brains.map((b) => `<th>${esc(NAMES[b] ?? b)}</th>`).join('')}</tr>
          ${heights.map((h) => `<tr><td>${h} cm</td>${brains.map((b) => cell(b, h)).join('')}</tr>`).join('')}
        </table>
        <div class="small">Our MuJoCo with Pollen's randomisation: a box step across the path, a steady ${bench.speed} m/s forward walk, a new seed each try.<br>Not the test case: a check that what it learned there carries over. It did not: trained on one test case, it lost part of its general climbing.</div>
      </div>`,
      7,
      1.02,
      1.0,
    ),
    'catch',
    { kind: 'card' },
  );
}
const groundFilm = join(TAKES, 'film-ground.mp4');
if (existsSync(groundFilm)) {
  add(
    await clipPart(groundFilm, 2, Number(process.env.FILM_S ?? 8), 'film-ground', [
      { at: 0, html: 'THE NEW BRAIN ON COPIES OF THE TEST CASE, <b>AT THEIR OWN HEIGHTS</b>: 32 DUCKS' },
    ], "MJLAB'S OWN RENDERER <i>&middot;</i> THE NEW BRAIN <i>&middot;</i> REAL TIME"),
    'real',
    { kind: 'arrive' },
  );
}
add(
  await card(
    'end',
    `<div class="card">
      <div class="sticker-shadow"><div class="sticker">DUCK LAB XR</div></div>
      <div class="title" style="font-size:64px">THE APP FINDS THE HARD MOMENT. <b>THE GPU PRACTISES IT.</b></div>
      <div class="url">duck.bruna.world</div>
      <div class="gh">OPEN SOURCE ON GITHUB</div>
      <div class="small">github.com/Bruna-Worlds/duck-lab-xr<br><br>microduck_rl, mjlab, the Microduck model and walking AI (c) Pollen Robotics and their authors (models CC BY-NC-SA 4.0). Duck Lab XR is not made or endorsed by Pollen Robotics. Music: original, made for this film.<br>(c) 2026 BRUNA GOODS LLC. All rights reserved.</div>
    </div>`,
    5,
    1.0,
    1.035,
  ),
  'end',
  { kind: 'card' },
);
const dur = await kit.finish(OUTFILE);
console.log(`CLIMB FILM ${OUTFILE} (${dur.toFixed(1)} s)`);
