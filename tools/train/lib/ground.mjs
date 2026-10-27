// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The training ground a test case makes: the moment the headset saved, rebuilt
 * as the place a trainer copies across its robots. Where Pip started, which way
 * it was going (the autopilot's goal), where it went wrong (fell, or got
 * stuck), and what was in the way: the course pieces as the sim had them (a
 * play mat, a dog bed: walkable steps) and, in mixed reality, the room as the
 * camera saw it (walls, furniture as solid boxes).
 *
 * The ground's frame: x from Pip's start towards its goal, y to the left, z up,
 * metres (the stage's MuJoCo frame moved and turned). Its obstacles are those
 * near the way from the start to the goal.
 *
 * Purposes:
 * - 'step' (tools/train/python/duckstep, mjlab): climbing. The ground is copied
 *   onto every terrain patch; the curriculum scales the walkable steps' heights
 *   round the real ones.
 * - 'nav' (tools/train/python/isaacnav, Isaac Lab): steering. The ground's room
 *   is rebuilt in most training rooms; Pip starts where it did and is sent to
 *   the goal it had.
 *
 *   node tools/train/lib/ground.mjs <pack.scenario.json> [step|nav]   prints it
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GROUND_VERSION = 'ducklab.ground.v1';
const MARGIN = { step: 0.6, nav: 1.0 };
const MAX_OBSTACLES = { step: 16, nav: 12 };
/** Wider than this along a side: a wall or a long piece, cut to the ground's region. */
const LONG = 1.0;
/** Climbing: metres of floor before the first step (the Dog Bed's start pad is 0.5 m before its mat). */
const RUN_UP = 0.45;

const yawOfQuat = ([w, x, y, z]) => Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const round = (v, d = 4) => +v.toFixed(d);

/** A course piece's or scanned thing's name in words: course-play-mat -> play mat. */
export function obstacleName(label) {
  if (!label) return 'obstacle';
  return label.replace(/^course-/, '').replace(/[-_]+/g, ' ').trim() || 'obstacle';
}

/** The course colliders of a pack saved before test cases listed them: its MJCF's course_N geoms. */
function courseFromMjcf(xml) {
  const out = [];
  for (const m of String(xml ?? '').matchAll(/<geom\s+name="course_\d+"([^>]*)\/?>/g)) {
    const attr = (k) => m[1].match(new RegExp(`\\b${k}="([^"]+)"`))?.[1];
    const type = attr('type');
    if (type !== 'box' && type !== 'cylinder') continue;
    const nums = (v, n) => (v ?? '').trim().split(/\s+/).map(Number).slice(0, n);
    const size = nums(attr('size'), type === 'box' ? 3 : 2);
    const pos = nums(attr('pos') ?? '0 0 0', 3);
    const quat = attr('quat') ? nums(attr('quat'), 4) : [1, 0, 0, 0];
    // No walkable flag then: a low wide box is a step.
    const top = pos[2] + (type === 'box' ? size[2] : size[1]);
    const walkable = type === 'box' && top <= 0.06 && Math.min(size[0], size[1]) > 0.1;
    out.push({ type, size, pos, quat, ...(walkable ? { walkable: true } : {}) });
  }
  return out;
}

/** Half extents in the piece's own frame and its yaw (upright pieces; tilted ones by their rotated box). */
function footprint(c) {
  const [w, x, y, z] = c.quat ?? [1, 0, 0, 0];
  // Rotation matrix rows (MuJoCo quaternion w, x, y, z).
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
  const h = c.type === 'box' ? c.size.slice(0, 3) : [c.size[0], c.size[0], c.size[1]];
  // Which local axis points up: the others lie in the floor.
  const up = [0, 1, 2].reduce((best, k) => (Math.abs(r[2][k]) > Math.abs(r[2][best]) ? k : best), 2);
  const [a, b] = [0, 1, 2].filter((k) => k !== up);
  const hz = Math.abs(r[2][0]) * h[0] + Math.abs(r[2][1]) * h[1] + Math.abs(r[2][2]) * h[2];
  const yaw = Math.atan2(r[1][a], r[0][a]);
  const shape = c.type === 'cylinder' && up === 2 ? 'cylinder' : 'box';
  return { shape, half: [h[a], h[b], hz], yaw };
}

/** The pack's typical forward command (m/s) over its last 10 s of walking. */
function typicalSpeed(pack) {
  const rows = Array.isArray(pack.steps) ? pack.steps : [];
  const tEnd = rows.length ? rows[rows.length - 1][0] : 0;
  const vx = rows.filter((r) => r[0] > tEnd - 10 && r[1] > 0.05).map((r) => r[1]).sort((p, q) => p - q);
  return vx.length ? round(vx[Math.floor(vx.length / 2)], 3) : 0.2;
}

/**
 * The training ground of one pack (its parsed JSON). `name`: the pack's name;
 * `purpose`: 'step' or 'nav'.
 */
export function trainingGround(pack, { name = 'test case', purpose = 'step' } = {}) {
  const sq = pack.start?.qpos ?? [0, 0, 0, 1, 0, 0, 0];
  const eq = pack.end?.qpos ?? sq;
  const nav = pack.nav ?? null;
  // From where the autopilot's task began (the course's start pad, where a drive was sent from), else the state the
  // pack starts with (a stretch of history, 10 to 20 s before the trouble: it can start right at a step).
  const from = Array.isArray(nav?.from) ? nav.from : null;
  const start = from ? [from[0], from[1]] : [sq[0], sq[1]];
  const startYaw = from ? from[2] : yawOfQuat(sq.slice(3, 7));
  const trouble = [eq[0], eq[1]];
  const goal = Array.isArray(nav?.goal) ? nav.goal : null;
  const dist = (p) => Math.hypot(p[0] - start[0], p[1] - start[1]);
  // Which way: to the goal; else to where it went wrong; else the way it faced.
  const toward = goal && dist(goal) > 0.3 ? goal : dist(trouble) > 0.3 ? trouble : null;
  const heading = toward ? Math.atan2(toward[1] - start[1], toward[0] - start[0]) : startYaw;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const local = ([x, y]) => [(x - start[0]) * cos + (y - start[1]) * sin, -(x - start[0]) * sin + (y - start[1]) * cos];
  const g = goal ? local(goal) : null;
  const t = local(trouble);

  // The region the ground covers: the start, the trouble, the goal, with room round them.
  const margin = MARGIN[purpose] ?? 0.8;
  const xs = [0, t[0], ...(g ? [g[0]] : [])];
  const ys = [0, t[1], ...(g ? [g[1]] : [])];
  const region = [Math.min(...xs) - margin, Math.max(...xs) + margin, Math.min(...ys) - margin, Math.max(...ys) + margin];
  if (purpose === 'step') region[1] = Math.max(region[1], t[0] + 1.4); // on past the step to the far side

  const sources = [];
  const course = Array.isArray(pack.obstacles?.course) ? pack.obstacles.course : courseFromMjcf(pack.mjcf);
  for (const c of course) sources.push({ ...c, source: 'course' });
  for (const c of pack.obstacles?.room ?? []) sources.push({ ...c, source: 'room' });

  let obstacles = [];
  for (const c of sources) {
    if (c.type !== 'box' && c.type !== 'cylinder') continue;
    const f = footprint(c);
    const [x, y] = local([c.pos[0], c.pos[1]]);
    let yaw = wrap(f.yaw - heading);
    let [hx, hy] = f.half;
    const hz = f.half[2];
    let cx = x;
    let cy = y;
    // Footprint extents in the ground frame.
    const ex = Math.abs(Math.cos(yaw)) * hx + Math.abs(Math.sin(yaw)) * hy;
    const ey = Math.abs(Math.sin(yaw)) * hx + Math.abs(Math.cos(yaw)) * hy;
    if (cx + ex < region[0] || cx - ex > region[1] || cy + ey < region[2] || cy - ey > region[3]) continue;
    // A wall or a long piece: only the part along the region.
    if (f.shape === 'box' && Math.max(hx, hy) > LONG) {
      if (hy > hx) {
        [hx, hy] = [hy, hx];
        yaw = wrap(yaw + Math.PI / 2);
      }
      const ux = Math.cos(yaw);
      const uy = Math.sin(yaw);
      let lo = -hx;
      let hi = hx;
      for (const [u, c0, a0, a1] of [
        [ux, cx, region[0], region[1]],
        [uy, cy, region[2], region[3]],
      ]) {
        if (Math.abs(u) < 1e-6) continue;
        const ta = (a0 - c0) / u;
        const tb = (a1 - c0) / u;
        lo = Math.max(lo, Math.min(ta, tb));
        hi = Math.min(hi, Math.max(ta, tb));
      }
      if (hi - lo < 0.05) continue;
      const mid = (lo + hi) / 2;
      cx += ux * mid;
      cy += uy * mid;
      hx = (hi - lo) / 2;
    }
    const top = c.pos[2] + hz;
    obstacles.push({
      shape: f.shape,
      half: [round(hx), round(hy), round(hz)],
      pos: [round(cx), round(cy), round(c.pos[2])],
      yaw: round(yaw),
      top: round(top),
      label: obstacleName(c.label),
      ...(c.walkable ? { walkable: true } : {}),
      source: c.source,
    });
  }
  // The nearest to the way there first, then cut to what a trainer can hold.
  const along = (o) => {
    const end = g ?? t;
    const len2 = end[0] * end[0] + end[1] * end[1] || 1;
    const k = Math.max(0, Math.min(1, (o.pos[0] * end[0] + o.pos[1] * end[1]) / len2));
    return Math.hypot(o.pos[0] - k * end[0], o.pos[1] - k * end[1]) - Math.max(o.half[0], o.half[1]);
  };
  // Climbing: the room's furniture only where it is in the way (a shelf a metre off the course is not):
  // the nearest of its footprint's corners and edge middles to the way from the start to the goal.
  const offPath = (o) => {
    const end = g ?? t;
    const len2 = end[0] * end[0] + end[1] * end[1] || 1;
    const c = Math.cos(o.yaw);
    const s = Math.sin(o.yaw);
    let best = Infinity;
    for (const [u, v] of [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]) {
      const px = o.pos[0] + c * u * o.half[0] - s * v * o.half[1];
      const py = o.pos[1] + s * u * o.half[0] + c * v * o.half[1];
      const k = Math.max(0, Math.min(1, (px * end[0] + py * end[1]) / len2));
      best = Math.min(best, Math.hypot(px - k * end[0], py - k * end[1]));
    }
    return best;
  };
  if (purpose === 'step') obstacles = obstacles.filter((o) => o.source !== 'room' || offPath(o) < 0.35);
  obstacles.sort((p, q) => along(p) - along(q));
  obstacles = obstacles.slice(0, MAX_OBSTACLES[purpose] ?? 12);
  if (purpose === 'step') obstacles.sort((p, q) => p.pos[0] - q.pos[0]);

  function navStarts() {
    const list = [{ x: 0, y: 0, yaw: round(wrap(startYaw - heading)), share: 0.4, at: from ? 'drive start' : 'test case start' }];
    if (from) {
      const [x, y] = local([sq[0], sq[1]]);
      list.push({ x: round(x), y: round(y), yaw: round(wrap(yawOfQuat(sq.slice(3, 7)) - heading)), share: 0.3, at: 'test case start' });
    }
    if (pack.reason === 'stuck') {
      list.push({ x: round(t[0]), y: round(t[1]), yaw: round(wrap(yawOfQuat(eq.slice(3, 7)) - heading)), share: 0.3, at: 'stuck' });
    }
    const sum = list.reduce((a, s) => a + s.share, 0);
    return list.map((s) => ({ ...s, share: round(s.share / sum, 3) }));
  }

  // Climbing from a pack's own start (no task start): that can be right at a step, and ducks that always start
  // pressed against it learn to stand there. Start a run-up before the first step ahead instead.
  let runUp = 0;
  if (purpose === 'step' && !from) {
    const ahead = obstacles
      .filter((o) => o.walkable && Math.abs(o.pos[1]) < o.half[1] + 0.25)
      .map((o) => o.pos[0] - (Math.abs(Math.cos(o.yaw)) * o.half[0] + Math.abs(Math.sin(o.yaw)) * o.half[1]))
      .filter((edge) => edge > -0.05)
      .sort((p, q) => p - q)[0];
    if (ahead !== undefined && ahead < RUN_UP) {
      runUp = RUN_UP - ahead;
      for (const o of obstacles) o.pos[0] = round(o.pos[0] + runUp);
      if (g) g[0] += runUp;
      t[0] += runUp;
      region[1] += runUp;
      start[0] -= runUp * cos;
      start[1] -= runUp * sin;
    }
  }

  const ground = {
    version: GROUND_VERSION,
    purpose,
    pack: name,
    reason: pack.reason ?? 'manual',
    playground: pack.playground?.title ?? null,
    driver: nav?.driver ?? 'planner',
    /** The ground's frame in the stage's MuJoCo frame. */
    frame: { origin: start.map((v) => round(v)), heading: round(heading) },
    start: { x: 0, y: 0, yaw: round(wrap(startYaw - heading)) },
    goal: g ? g.map((v) => round(v)) : null,
    trouble: t.map((v) => round(v)),
    vx: typicalSpeed(pack),
    region: region.map((v) => round(v, 3)),
    obstacles,
    /** Metres the start was moved back for a run-up (climbing from a pack's own start), or 0. */
    runUp: round(runUp, 3),
    /**
     * Steering: where training ducks start, with their shares: where the drive began, where the test case's
     * history starts, and where Pip was stuck, facing as it was (practising the stuck moment itself teaches the
     * way out; the drive's start alone, where the old brain copes, taught little).
     */
    starts: purpose === 'nav' ? navStarts() : null,
    /** The colours the camera brain saw (its pictures in the test case), or null. */
    look: cameraLook(pack),
  };
  ground.summary = groundSummary(ground);
  return ground;
}

/** The camera brain's pictures in a pack: [{ width, height, rgb: Uint8Array }], oldest first. */
export function cameraPictures(pack) {
  const c = pack.camera;
  if (!c?.frames?.length) return [];
  return c.frames.map((b64) => ({ width: c.width, height: c.height, rgb: new Uint8Array(Buffer.from(b64, 'base64')) }));
}

/**
 * The colours of what the camera brain saw: its pictures' pixels in a few clusters (k-means), the floor
 * (the most common cluster along the bottom rows), the things in the room (the other clusters, by share)
 * and what the top rows show. sRGB, 0..1. A trainer paints the rebuilt room with these.
 */
export function cameraLook(pack, k = 5) {
  const pictures = cameraPictures(pack);
  if (!pictures.length) return null;
  const px = [];
  const rowOf = [];
  for (const p of pictures) {
    for (let i = 0; i < p.width * p.height; i += 2) {
      px.push([p.rgb[i * 3] / 255, p.rgb[i * 3 + 1] / 255, p.rgb[i * 3 + 2] / 255]);
      rowOf.push(Math.floor(i / p.width) / (p.height - 1));
    }
  }
  // Deterministic seeds: the first pixel, then each time the pixel farthest from the seeds so far.
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const centres = [px[0].slice()];
  while (centres.length < k) {
    let best = 0;
    let far = -1;
    for (let i = 0; i < px.length; i += 7) {
      const near = Math.min(...centres.map((c) => d2(px[i], c)));
      if (near > far) {
        far = near;
        best = i;
      }
    }
    if (far < 1e-4) break;
    centres.push(px[best].slice());
  }
  const label = new Int32Array(px.length);
  for (let round_ = 0; round_ < 12; round_++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = d2(px[i], centres[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      label[i] = best;
      const s = sum[best];
      s[0] += px[i][0];
      s[1] += px[i][1];
      s[2] += px[i][2];
      s[3]++;
    }
    for (let c = 0; c < centres.length; c++) if (sum[c][3]) centres[c] = sum[c].slice(0, 3).map((v) => v / sum[c][3]);
  }
  const share = centres.map(() => 0);
  const bottom = centres.map(() => 0);
  const top = centres.map(() => 0);
  for (let i = 0; i < px.length; i++) {
    share[label[i]]++;
    if (rowOf[i] > 0.8) bottom[label[i]]++;
    if (rowOf[i] < 0.15) top[label[i]]++;
  }
  const most = (counts) => counts.indexOf(Math.max(...counts));
  const colour = (c) => centres[c].map((v) => round(v, 3));
  // The app says which colours are its floor and backdrop (pack.camera.palette); else the bottom rows' commonest is the floor.
  const palette = pack.camera?.palette ?? null;
  const nearest = (rgb) => centres.reduce((b, c, i) => (d2(c, rgb) < d2(centres[b], rgb) ? i : b), 0);
  const floor = palette?.floor ? nearest(palette.floor) : most(bottom);
  const backdrop = palette?.backdrop && d2(centres[nearest(palette.backdrop)], palette.backdrop) < 0.01 ? nearest(palette.backdrop) : -1;
  const things = centres
    .map((_, c) => c)
    .filter((c) => c !== floor && c !== backdrop && share[c] / px.length > 0.03)
    .sort((a, b) => share[b] - share[a])
    .map((c) => ({ rgb: colour(c), share: round(share[c] / px.length, 3) }));
  return {
    floor: palette?.floor ? palette.floor.map((v) => round(v, 3)) : colour(floor),
    things,
    top: colour(most(top)),
    pictures: pictures.length,
  };
}

/** One line: what the ground holds ("2 cm play mat, 3 cm dog bed; it fell 1.3 m on"). */
export function groundSummary(ground) {
  const parts = ground.obstacles
    .filter((o) => o.walkable || o.source === 'room' || o.top > 0.06)
    .map((o) => (o.walkable ? `${Math.round(o.top * 100)} cm ${o.label}` : o.label));
  const counts = new Map();
  for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
  const things = [...counts].map(([p, n]) => (n > 1 ? `${n} x ${p}` : p)).join(', ') || 'open floor';
  const at = Math.hypot(ground.trouble[0], ground.trouble[1]);
  const what = ground.reason === 'falls' ? 'fell' : ground.reason === 'stuck' ? 'got stuck' : 'was saved';
  return `${things}; it ${what} ${at.toFixed(1)} m from its start${ground.goal ? `, its goal ${Math.hypot(...ground.goal).toFixed(1)} m away` : ''}`;
}

/** The ground of a pack file. */
export function groundOfFile(path, purpose = 'step') {
  const pack = JSON.parse(readFileSync(path, 'utf8'));
  return trainingGround(pack, { name: basename(path).replace(/\.scenario\.json$/, ''), purpose });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, purpose = 'step'] = process.argv.slice(2);
  if (!file) {
    console.error('node tools/train/lib/ground.mjs <pack.scenario.json> [step|nav]');
    process.exit(2);
  }
  console.log(JSON.stringify(groundOfFile(file, purpose), null, 2));
}
