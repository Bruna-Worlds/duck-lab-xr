// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The camera brain film (1920 x 1080, 30 fps): the whole loop for steering
 * round furniture, from real takes.
 *   fail/   the app (record-avoid.mjs TAKE=fail): the camera brain sent behind
 *           the coffee table gets stuck; the app saves the moment as a test
 *           case, with what Pip's camera saw
 *   page/   the trainer page (record-trainers.mjs TRAINER=isaaclab-nav-camera
 *           SEND=1): the test case in the inbox, the camera brain's trainer,
 *           the training ground the test case makes, the run live and as a
 *           time-lapse, the export, the drives in rebuilt rooms, the release
 *           sent to the headset
 *   isaac/  Isaac Lab's own viewer during that run (record-viewer.mjs - -):
 *           the robots in rooms rebuilt from the test case
 *   eyes/   what the training robots' cameras see (isaacnav/probe.py --frames
 *           in rebuilt rooms), beside what Pip's camera saw in the app
 *   release/  a pickup of the release card and Send to headset (record-release.mjs
 *           CLICK=1), when the page changed after the take
 *   try/    the app (TAKE=try): New brain ready, TRY IT by the controller's
 *           ray, the same drive on the new camera brain
 * plus a title, the drives' numbers on a card, an end card, captions in a band
 * below, Pip cam's DEPTH feed (the camera picture beside the 8 x 8 depth frame)
 * inset in the app shots, and a score written to this cut.
 *
 *   node tools/film/avoid/compose-avoid.mjs [takes dir] [out.mp4]
 *
 * Env: NAME (the release), ENVS, ROUNDS.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, BAND, composeKit, esc, H, PAGE } from '../compose-kit.mjs';

const TAKES = process.argv[2] ?? 'artifacts/video/avoid';
const OUTFILE = process.argv[3] ?? join(TAKES, 'duck-lab-camera-brain.mp4');
const NAME = process.env.NAME ?? 'camera-ground';
const ENVS = process.env.ENVS ?? '256';
const ROUNDS = process.env.ROUNDS ?? '300';
const kit = await composeKit({
  takes: TAKES,
  captions: {
    [`${ENVS} robots at once on the GPU, ${ROUNDS} rounds of practice`]: `${ENVS} ducks at once on the GPU, <b>${ROUNDS} more rounds</b> for the camera brain`,
  },
});
const { add, appPart, card, loadAppTake, loadPageTake, markAt, now, pagePart } = kit;

const fail = loadAppTake('fail');
const page = loadPageTake('page');
const isaac = loadPageTake('isaac');
const tryTake = loadAppTake('try');
if (!fail || !page || !tryTake) throw new Error('the film needs the fail, page and try takes');

const incoming = 'public/policies/incoming';
const release = (existsSync(incoming) ? readdirSync(incoming) : [])
  .filter((d) => existsSync(join(incoming, d, 'manifest.json')))
  .map((d) => JSON.parse(readFileSync(join(incoming, d, 'manifest.json'), 'utf8')))
  .filter((r) => r.name === NAME)
  .sort((p, q) => String(q.createdAt).localeCompare(String(p.createdAt)))[0];
// The cross-check's drives: in the app (the test case replayed) and in Isaac Lab's rebuilt rooms.
const drives = release?.crossCheck?.table?.filter((r) => r.tries) ?? [];
const pair = (engine) => {
  const list = drives.filter((r) => r.engine === engine);
  const after = list.find((r) => r.brain === release?.id);
  const before = list.find((r) => r.brain !== release?.id);
  return before && after ? { before, after } : null;
};
const inApp = pair('app');
const inIsaac = pair('isaaclab');

// Pip cam's DEPTH feed (256 x 192: the camera picture, left, beside the 8 x 8 depth frame) inset bottom left.
const INSET = { x: 36, y: H - BAND - 384 - 18, w: 512, h: 384 };

add(
  await card(
    'intro',
    `<div class="card">
      <div class="title">TEACHING THE CAMERA BRAIN<br><b>TO GET ROUND A TABLE</b></div>
      <div class="chips"><span class="chip on">STUCK IN THE APP</span><span class="arrow">&rarr;</span><span class="chip">TEST CASE</span><span class="arrow">&rarr;</span><span class="chip on">ITS ROOM, REBUILT</span><span class="arrow">&rarr;</span><span class="chip">${ENVS} DUCKS IN ISAAC LAB</span><span class="arrow">&rarr;</span><span class="chip on">CROSS-CHECK</span><span class="arrow">&rarr;</span><span class="chip">NEW BRAIN IN THE APP</span></div>
      <div class="sub">Every shot is a real take: the app, the trainer page and the training run on one RTX 3070.</div>
    </div>`,
    4.2,
    1.0,
    1.03,
  ),
  'gap',
  { kind: 'arrive', at: 0.3 },
);

// Stuck at the table, and the test case.
const packed = fail.marks.packed ?? fail.marks['drive-end'];
const says = fail.trace.find((s) => s.packs > 0)?.says ?? '';
const seconds = /(\d+) s test case/.exec(says)?.[1];
const failFrom = fail.marks.drive + 0.3;
add(
  await appPart(
    fail,
    failFrom,
    Math.min(fail.marks['drive-end'], packed + 3.5),
    'fail',
    2,
    [
      { t: failFrom, html: 'SENT BEHIND THE COFFEE TABLE, <b>THE CAMERA BRAIN DRIVES</b> (ITS PICTURE AND DEPTH, BOTTOM LEFT)' },
      { t: failFrom + 6, html: 'LEFT, RIGHT, BACK, LEFT AGAIN: <b>IT CANNOT PICK A WAY ROUND</b>' },
      { t: packed - 0.4, html: `STUCK: THE APP SAVES THE MOMENT${seconds ? ` (${seconds} S)` : ''} AS A TEST CASE, <b>WITH WHAT PIP'S CAMERA SAW</b>` },
    ],
    APP,
    null,
    INSET,
  ),
  'wear',
  { kind: 'quack', at: 0.4 },
);

// The trainer page: inbox, picker, the training ground, Train, the first rounds.
const t0 = Math.max(page.frames[0].t, page.captions[0].t - 1.0);
const lapseAt = markAt(page, '!lapse');
const liveAt = markAt(page, '!live');
add(await pagePart(page, t0, lapseAt, 'page-1', { label: PAGE, speed: 1.6 }), 'wear', { kind: 'try', at: 2 });

// Isaac Lab's own viewer, this run.
if (isaac) {
  const a = isaac.captions[0]?.t ?? isaac.frames[0].t;
  const b = Math.min(isaac.end, a + 14);
  add(
    await pagePart(isaac, a, b, 'isaac', {
      label: 'NVIDIA ISAAC LAB 3 <i>&middot;</i> ITS OWN VIEWER <i>&middot;</i> THIS RUN, LIVE',
      lead: `REAL TRAINING FRAMES: <b>${ENVS} DUCKS</b>, MOST IN A COPY OF THE TEST CASE'S ROOM: THE TABLE, THE COUCHES, PIP'S START AND GOAL`,
    }),
    'real',
    { kind: 'train', len: 10 },
  );
}

// What the training ducks see, beside what Pip saw.
const eyes = join(TAKES, 'eyes');
const appPics = existsSync(join(eyes, 'app.png')) ? 'app.png' : null;
const simPics = existsSync(join(eyes, 'isaac.png')) ? 'isaac.png' : null;
if (appPics && simPics) {
  const img = (f) => `data:image/png;base64,${readFileSync(join(eyes, f)).toString('base64')}`;
  add(
    await card(
      'eyes',
      `<div class="card">
        <div class="title" style="font-size:66px">THE REBUILT ROOMS ARE PAINTED <b>IN THE COLOURS PIP'S CAMERA SAW</b></div>
        <div class="sub" style="color:#ffcf3f">WHAT PIP'S CAMERA SAW IN THE APP</div>
        <img src="${img(appPics)}" style="width:1500px;image-rendering:pixelated;border-radius:12px">
        <div class="sub" style="color:#3de0b8">WHAT TRAINING DUCKS' CAMERAS SEE IN ISAAC LAB, IN ROOMS REBUILT FROM IT</div>
        <img src="${img(simPics)}" style="width:1500px;image-rendering:pixelated;border-radius:12px">
        <div class="small">It first learned in rooms of random colours; the app draws the room in its own. Painted, the same rebuilt rooms were harder for the old brain (48 to 41 of 64): colour matters some. Each episode still shifts brightness and tint.</div>
      </div>`,
      6.5,
      1.0,
      1.02,
    ),
    'real',
    { kind: 'card' },
  );
}
add(await pagePart(page, lapseAt, liveAt, 'lapse', { label: PAGE, clock: true }), 'real', { kind: 'brain' });
// Export, the drives, release, Send to headset. A pickup of the release card (record-release.mjs, release/), when
// there is one, takes over from the take's "!release" mark (the card's cross-check line was mislabelled in the take).
const pickup = loadPageTake('release');
const releaseAt = markAt(page, '!release');
const page2End = pickup && releaseAt ? releaseAt + 4 : page.end;
// The take's cross-check card showed the last walking table until the drives came in (the page now clears it):
// the film cuts from the start of the cross-check to the drives' table.
const checkAt = page.captions.find((m) => /both camera brains drive/i.test(m.text))?.t;
if (checkAt && releaseAt && checkAt < releaseAt) {
  add(await pagePart(page, liveAt, checkAt + 1.2, 'page-2', { label: PAGE, speed: 1.4 }), 'deploy', { kind: 'brain' });
  add(
    await pagePart(page, releaseAt - 0.3, page2End, 'page-2b', {
      speed: 0.45, // the take fast-forwards here; the table needs reading time
      label: PAGE,
      lead: `${Math.round((releaseAt - checkAt) / 60)} MINUTES LATER: ${
        inApp ? `<b>IN THE APP, ${inApp.before.reached} OF ${inApp.before.tries} TO ${inApp.after.reached} OF ${inApp.after.tries}.</b> ` : ''
      }${inIsaac ? `ISAAC LAB'S REBUILT ROOMS, ${inIsaac.before.reached} TO ${inIsaac.after.reached} OF ${inIsaac.after.tries}` : ''}`,
    }),
    'deploy',
  );
} else add(await pagePart(page, liveAt, page2End, 'page-2', { label: PAGE, speed: 1.4 }), 'deploy', { kind: 'brain' });
if (pickup && releaseAt) add(await pagePart(pickup, pickup.captions[0].t - 0.2, pickup.end, 'release', { label: PAGE }), 'deploy');

// The app: the offer, TRY IT, the same drive.
const pressed = tryTake.marks.pressed;
add(
  await appPart(tryTake, tryTake.marks.offer, pressed + 1.5, 'offer', 1, [
    { t: tryTake.marks.offer, html: `BACK IN THE APP: <b>NEW BRAIN READY</b> ON PIP CAM (${esc(release?.name ?? NAME)})` },
    { t: pressed - 0.8, html: 'TRY IT, WITH THE CONTROLLER: <b>THE NEW CAMERA BRAIN LOADS, AND DRIVES</b>' },
  ], APP, '1440:810:200:150'),
  'deploy',
  { kind: 'try', at: Math.max(0.2, pressed - tryTake.marks.offer) },
);
const driveFrom = tryTake.marks.drive + 0.3;
const arrived = tryTake.marks.arrived;
const driveEnd = tryTake.marks['drive-end'];
const stuckAt = tryTake.trace.find((s) => s.t > driveFrom && s.stuck)?.t;
const took = arrived ? (arrived - tryTake.marks.drive).toFixed(0) : null;
if (arrived) kit.hit(now() + (arrived - driveFrom) / 2, 'success');
add(
  await appPart(
    tryTake,
    driveFrom,
    driveEnd,
    'drive',
    2,
    [
      { t: driveFrom, html: 'THE SAME DRIVE ON THE NEW CAMERA BRAIN: <b>FROM THE SAME SPOT, TO THE SAME GOAL</b>' },
      ...(arrived
        ? [{ t: arrived - 1.5, html: `ROUND THE TABLE AND THERE <b>IN ${took} SECONDS</b>` }]
        : stuckAt
          ? [{ t: stuckAt - 0.5, html: 'STILL STUCK AT THE TABLE: <b>NOT THERE YET</b>' }]
          : []),
    ],
    APP,
    null,
    INSET,
  ),
  'catch',
);

// The drives' numbers.
if (inApp || inIsaac) {
  const cls = (p, r) => (r === p.after && p.after.reached > p.before.reached ? 'best' : r.reached === 0 ? 'none' : '');
  const rows = (where, p) =>
    p
      ? `<tr><td>${where}</td><td>${p.before.reached} / ${p.before.tries}</td><td class="${cls(p, p.after)}">${p.after.reached} / ${p.after.tries}</td></tr>`
      : '';
  add(
    await card(
      'drives',
      `<div class="card">
        <div class="title">THE TEST CASE, DRIVEN AGAIN: <b>GOT TO THE GOAL</b></div>
        <table>
          <tr><th>Where</th><th>The one that got stuck</th><th>New (${esc(release.name)})</th></tr>
          ${rows('In the app: its MuJoCo, its camera pictures', inApp)}
          ${rows('Isaac Lab: rooms rebuilt from it', inIsaac)}
        </table>
        <div class="small">In the app: the test case's drive from where it began to its goal, ${inApp?.after.tries ?? 0} tries each, as Pip cam draws the room.<br>In Isaac Lab on Newton: ${inIsaac?.after.tries ?? 0} rooms rebuilt from the test case (turned and nudged, in the colours Pip's camera saw), the same rooms for both brains.</div>
      </div>`,
      6.5,
      1.02,
      1.0,
    ),
    'catch',
    { kind: 'card' },
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
      <div class="small">github.com/Bruna-Worlds/duck-lab-xr<br><br>NVIDIA Isaac Lab and Newton by NVIDIA and their authors; the Microduck model and walking AI (c) Pollen Robotics and their authors (models CC BY-NC-SA 4.0). Duck Lab XR is not made or endorsed by NVIDIA or Pollen Robotics. Music: original, made for this film.<br>(c) 2026 BRUNA GOODS LLC. All rights reserved.</div>
    </div>`,
    5,
    1.0,
    1.035,
  ),
  'end',
  { kind: 'card' },
);
const dur = await kit.finish(OUTFILE);
console.log(`CAMERA FILM ${OUTFILE} (${dur.toFixed(1)} s)`);
