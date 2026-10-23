// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Autopilot: the duck finds its own way. A 5 cm occupancy grid over the
 * stage is filled from the course colliders and, in mixed reality, the
 * scanned furniture; A* plans a path; a driver turns the next waypoint into
 * the walking command the policy already takes. Behaviours: run the course
 * (through every piece in order to the finish) and come to the player.
 *
 * Keys: P runs the course, C comes to the player, any stick input or Escape
 * hands control back. The HUD's Auto button toggles the course run.
 */
import { createSystem, type Entity, Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import { CourseCrumb, CourseFinish, CourseGate, CourseGoal } from '../course/course-components.js';
import { gatherCourse } from '../course/course-physics.js';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';
import { TERRAIN_CELL, TERRAIN_MIN_HEIGHT, TERRAIN_N, terrainX, terrainY } from '../duck/terrain-spec.js';
import { RoomSystem } from '../room/room-system.js';
import { TerrainSystem } from '../room/terrain-system.js';

const CELL = 0.05; // metres
const CLIMBABLE = 0.1; // terrain lower than this the duck walks over (or stumbles on)
const DUCK_RADIUS = 0.12; // obstacles grow by this so the body clears them
const POST_RADIUS = 0.08; // thin posts (gates) grow less: the duck fits a 30 cm gate
const NEAR_COST = 1.5; // extra cost for cells next to an obstacle: paths keep their distance
const LOOKAHEAD = 0.28; // metres along the path: the point the duck steers for
const PASS_BEYOND = 0.1; // a gate counts once the duck is this far past it along the course
const ESCAPE_MS = 1500; // stuck: back out for this long before planning again
const REACH = 0.12; // a waypoint counts as reached inside this radius
const REPLAN_MS = 1500;
const MAX_TURN = 1; // command units, scaled by the duck system
const TURN_GAIN = 2; // turn command per radian off the aim point
const CRUISE = 0.85;
// The walking policy keeps stepping at any command from about this forward
// speed up; below it a turn (a right one above all) can stall the gait.
const WALK_MIN = 0.6;
const SHARP = 0.6; // rad off the aim point: slow down to WALK_MIN while turning at full rate
// A sharper corner is a pivot: backing up while turning, which both brains do
// tightly and to either side (a right turn while walking forward is weak in a
// brain fine-tuned on right-turn falls). Hysteresis keeps it from flickering.
const PIVOT_IN = 1.05; // rad off the aim point
const PIVOT_OUT = 0.45;
const PIVOT_BACK = -0.6; // forward command while pivoting
// Each gate is approached from in front, so the duck walks through it.
const APPROACH = 0.25; // metres before the gate
const APPROACH_REACH = 0.14;
// Neither brain reliably starts stepping from a standstill on a straight
// command; one that turns does. A stalled start gets a short turning kick.
const STALL_SPEED = 0.02; // m/s
const STALL_MS = 600;
const KICK_MS = 700;
const KICK_TURN = 0.8;
// Crumbs are a bonus: never turn back for one, nor go far out of the way.
const CRUMB_BEHIND = 1.75; // rad off the heading: left behind
const CRUMB_MISSED = 1.05; // rad off the heading when this close: missed, not circled
const CRUMB_CLOSE = 0.22; // metres
const CRUMB_DETOUR = 1.8; // a path this many times longer than the straight line: skipped
const CRUMB_STUCK_MS = 4000; // no progress towards a crumb for this long: skipped
const CRUMB_TURN = 1.75; // rad: a crumb that needs a turn this sharp to go on from is not worth it
const CRUMB_EXTRA = 0.3; // metres a crumb may add to the way to the next gate or the finish
const STUCK_MS = 8000; // no progress towards the target for this long
const STATUS_MS = 4000; // how long "finished" stays on the HUD
const PROGRESS = 0.08; // metres closer that counts as progress
const GRID_MS = 2000; // rebuild the map this often (the terrain changes live)
const WHISKER = 0.16; // metres ahead the duck must see clear floor to keep walking
const LOOK = 0.45; // how far the whiskers reach

export type NavTask = 'course' | 'player' | 'explore' | 'goto' | null;

interface Waypoint {
  x: number;
  y: number;
  through: boolean;
  reach: number;
  optional?: boolean;
  /** A point in front of a gate: reached once close, or once level with it. */
  approach?: boolean;
  /** Approach points move off obstacles once the map exists; crumbs are judged once. */
  settled?: boolean;
}
const VISIT_RADIUS = 0.3; // cells this close to the duck count as visited
const EXPLORE_MIN = 0.35; // the next unvisited spot must be at least this far

interface Grid {
  x0: number; // stage-local x of cell column 0
  y0: number; // stage-local y (MuJoCo frame: y = -z) of row 0
  cols: number;
  rows: number;
  /** Obstacles grown by the duck's radius, for planning. */
  blocked: Uint8Array;
  /** The obstacles themselves, ungrown: never planned through, even next to the start. */
  solid: Uint8Array;
  /**
   * Only what the depth sensor found, ungrown, for the whiskers: the planner
   * already threads course pieces closely, so the whiskers react just to
   * real things that appeared since the last plan.
   */
  sensed: Uint8Array;
}

export class NavSystem extends createSystem({
  stages: { required: [DuckStage] },
  crumbs: { required: [CourseCrumb] },
  gates: { required: [CourseGate] },
  goals: { required: [CourseGoal] },
  finishes: { required: [CourseFinish] },
}) {
  task: NavTask = null;
  /** For the HUD: what the autopilot is doing. */
  status = '';
  /** What the status says while the current task is going well. */
  private taskStatus = '';
  /** True while the autopilot has made no progress for a while (a scenario worth packing). */
  stuck = false;
  /** Whisker ranges (metres to the nearest blocked cell) ahead, left and right; for the HUD and tests. */
  readonly whiskers = new Float32Array([LOOK, LOOK, LOOK]);
  private bestDistance = Infinity;
  private progressAt = 0;
  private escapeUntil = 0;
  /** Explore: cells the duck has been near (same layout as the grid). */
  private visited: Uint8Array | null = null;
  private visitedCols = 0;
  private visitedX0 = 0;
  private visitedY0 = 0;
  /** Where the course pieces are, for the grid extent (free roam has none). */
  private wide = false;
  private duck: DuckSystem | undefined;
  private room: RoomSystem | undefined;
  private terrain: TerrainSystem | undefined;
  private grid: Grid | null = null;
  private gridBuiltAt = 0;
  /**
   * Course targets in order: `through` ones (gates) count only once passed,
   * not just approached; each has an approach point in front of it; optional
   * ones (crumbs) are skipped when they cannot be reached cleanly.
   */
  private waypoints: Waypoint[] = [];
  /** Whether the last plan reached its goal (otherwise it is a straight line there). */
  private planFound = false;
  private escapeTurn = 0.4;
  /** The planned path, straightened (the duck's position first, the target last). */
  private path: [number, number][] = [];
  /** The path segment the duck is on. */
  private pathIndex = 0;
  /** Length of the last plan, and of the straight line it replaces (for crumb detours). */
  private pathLength = 0;
  private straightLength = 0;
  private plannedAt = 0;
  /** The duck's speed over the ground (m/s, smoothed), from its pose. */
  private speed = 0;
  private lastX = 0;
  private lastY = 0;
  private lastAt = 0;
  private stalledSince = 0;
  private kickUntil = 0;
  private kickTurn = 0;
  private pivoting = false;
  /** When a finished task's status line goes (0: it stays). */
  private statusUntil = 0;
  private v!: Vector3;
  private q!: Quaternion;
  private inverse!: Matrix4;
  private target: [number, number] = [0, 0];

  /** The autopilot's current goal in the stage frame (MuJoCo x, y; metres), for the robot panel. */
  get targetX(): number {
    return this.target[0];
  }
  get targetY(): number {
    return this.target[1];
  }
  /** Course targets still ahead, and points on the planned path. */
  get waypointsLeft(): number {
    return this.waypoints.length;
  }
  get pathPoints(): number {
    return Math.max(0, this.path.length - this.pathIndex);
  }

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    this.room = this.world.getSystem(RoomSystem);
    this.terrain = this.world.getSystem(TerrainSystem);
    this.v = new Vector3();
    this.q = new Quaternion();
    this.inverse = new Matrix4();
    this.queries.stages.subscribe('qualify', () => this.stop());
    this.queries.stages.subscribe('disqualify', () => this.stop());
  }

  /** Walk the course: every piece in order, then the finish. */
  runCourse(): void {
    const stage = this.stage();
    if (!stage) return;
    const points: Waypoint[] = [];
    const add = (set: Set<Entity>, through: boolean) => {
      for (const entity of set) {
        const p = entity.object3D?.position;
        if (!p) continue;
        // Crumbs: walk over them when there is room; a crumb squeezed between pieces is skipped.
        points.push({ x: p.x, y: -p.z, through, reach: through ? REACH * 1.6 : 0.09, optional: !through });
        // A gate: line up in front of it first.
        if (through) points.push({ x: p.x - APPROACH, y: -p.z, through: false, reach: APPROACH_REACH, approach: true });
      }
    };
    add(this.queries.crumbs.entities, false);
    add(this.queries.gates.entities, true);
    // Goals are not visited: the ball has to be kicked in, and the goal's
    // own box would only be walked into.
    points.sort((a, b) => a.x - b.x);
    const finish = this.queries.finishes.entities.values().next().value as Entity | undefined;
    const fp = finish?.object3D?.position;
    this.waypoints = points;
    if (fp) this.waypoints.push({ x: fp.x, y: -fp.z, through: false, reach: 0.1 }); // stand on the pad
    this.task = 'course';
    this.path = [];
    this.status = this.taskStatus = 'Autopilot: running the course';
    this.duck?.restart();
  }

  /** Walk to where the player stands. */
  comeHere(): void {
    if (!this.stage()) return;
    this.task = 'player';
    this.path = [];
    this.status = this.taskStatus = 'Autopilot: coming to you';
  }

  /**
   * Roam: keep walking to the nearest floor the duck has not been to yet,
   * inside the room (walls and furniture are in the map), until there is
   * nothing left within reach.
   */
  explore(): void {
    if (!this.stage()) return;
    this.task = 'explore';
    this.wide = true;
    this.grid = null; // rebuild over the whole terrain area
    this.path = [];
    this.waypoints = [];
    this.status = this.taskStatus = 'Autopilot: exploring';
  }

  /** Walk to a spot in the stage's MuJoCo frame (x forward along the course, y to the left). */
  goTo(x: number, y: number, label = 'there'): void {
    if (!this.stage()) return;
    this.task = 'goto';
    this.wide = true;
    this.grid = null;
    this.path = [];
    this.waypoints = [{ x, y, through: false, reach: 0.12 }];
    this.status = this.taskStatus = `Autopilot: going ${label}`;
  }

  /**
   * Walk under the first scanned table or desk (its footprint centre, between
   * the legs). Returns false when the scan has none.
   */
  goUnderTable(): boolean {
    const stage = this.stage()?.object3D;
    const table = this.room?.roomColliders.find((c) => c.type === 'box' && c.pos[2] > 0.3 && c.size[2] < 0.05);
    if (!stage || !table) return false;
    this.goTo(table.pos[0], table.pos[1], 'under the table');
    return true;
  }

  /** Ends the task, saying how it ended for a few seconds. */
  private finish(status: string, now: number): void {
    this.stop();
    this.status = status;
    this.statusUntil = now + STATUS_MS;
  }

  stop(): void {
    if (this.task) this.status = '';
    this.statusUntil = 0;
    if (this.duck) this.duck.autopilotLook = null;
    this.task = null;
    this.path = [];
    this.waypoints = [];
    this.stuck = false;
    this.bestDistance = Infinity;
    if (this.wide) {
      this.wide = false;
      this.grid = null;
    }
    if (this.duck) this.duck.autopilot = null;
  }

  update(): void {
    const duck = this.duck;
    if (!this.room) this.room = this.world.getSystem(RoomSystem); // registered later than us, once
    if (!this.terrain) this.terrain = this.world.getSystem(TerrainSystem);
    const keys = this.input.keyboard;
    if (keys.getKeyDown('KeyP')) this.task === 'course' ? this.stop() : this.runCourse();
    if (keys.getKeyDown('KeyC')) this.task === 'player' ? this.stop() : this.comeHere();
    if (keys.getKeyDown('KeyE')) this.task === 'explore' ? this.stop() : this.explore();
    if (keys.getKeyDown('KeyG') && !this.goUnderTable()) this.status = 'Autopilot: no table in the scan';
    if (keys.getKeyDown('Escape')) this.stop();
    if (!this.task && this.statusUntil && performance.now() > this.statusUntil) {
      this.status = '';
      this.statusUntil = 0;
    }
    if (!this.task || !duck?.hasPose || !duck.sim) {
      return;
    }
    if (duck.commanded) {
      this.stop(); // the player took over
      return;
    }
    const now = performance.now();
    const stage = this.stage();
    if (!stage) return;
    if (!this.grid || now - this.gridBuiltAt > GRID_MS) {
      this.buildGrid(stage);
      this.gridBuiltAt = now;
    }
    const p = duck.pose;
    const x = p[0];
    const y = p[1];
    if (this.lastAt && now > this.lastAt) {
      const dt = (now - this.lastAt) / 1000;
      const v = Math.hypot(x - this.lastX, y - this.lastY) / dt;
      this.speed += (v - this.speed) * Math.min(1, dt / 0.4);
    }
    this.lastX = x;
    this.lastY = y;
    this.lastAt = now;
    if (this.task === 'explore') {
      this.markVisited(x, y);
      if (!this.waypoints.length || this.reachedExploreTarget(x, y)) {
        const next = this.nextUnvisited(x, y);
        if (!next) {
          this.finish('Autopilot: explored everything it can reach', now);
          return;
        }
        this.waypoints = [{ x: next[0], y: next[1], through: false, reach: 0.15 }];
        this.path = [];
        this.bestDistance = Infinity;
      }
    }
    // Current goal: next waypoint of the course, or the player.
    if (this.task === 'player') {
      this.player.head.getWorldPosition(this.v);
      stage.object3D!.updateWorldMatrix(true, false);
      this.inverse.copy(stage.object3D!.matrixWorld).invert();
      this.v.applyMatrix4(this.inverse);
      this.target[0] = this.v.x;
      this.target[1] = -this.v.z;
    } else {
      while (this.waypoints.length) {
        const w = this.waypoints[0];
        const reached = w.through
          ? x > w.x + 0.03 && Math.abs(w.y - y) < 0.3 // past the posts, between them (not around)
          : Math.hypot(w.x - x, w.y - y) < w.reach || (!!w.approach && x > w.x && Math.abs(w.y - y) < APPROACH_REACH);
        if (!reached) break;
        this.waypoints.shift();
        this.path = [];
        this.bestDistance = Infinity; // a new target: progress starts over
      }
      if (!this.waypoints.length) {
        this.finish(this.task === 'goto' ? 'Autopilot: arrived' : 'Autopilot: finished', now);
        return;
      }
      const w = this.waypoints[0];
      if (w.approach && !w.settled && this.grid) this.settleApproach(w);
      // Aim through a gate: a little past its centre, so the approach lines up.
      this.target[0] = w.through ? w.x + PASS_BEYOND : w.x;
      this.target[1] = w.y;
    }
    const distance = Math.hypot(this.target[0] - x, this.target[1] - y);
    // How far is left to walk: along the last plan when there is one (a detour
    // round an obstacle first leads away from the target), else as the crow flies.
    const remaining = this.planFound && this.path.length > 1 ? this.pathLength : distance;
    if (duck.sim.mode !== 'walk') {
      this.progressAt = now; // getting up or sitting is not being stuck
    }
    if (remaining < this.bestDistance - PROGRESS || this.bestDistance === Infinity) {
      this.bestDistance = remaining;
      this.progressAt = now;
      if (this.stuck) {
        this.stuck = false;
        this.status = this.taskStatus; // back on track
      }
    } else if (!this.stuck && now - this.progressAt > (this.task === 'course' && this.waypoints[0]?.optional ? CRUMB_STUCK_MS : STUCK_MS)) {
      // Wedged against something: back out, turning away from it, then plan again.
      this.escapeUntil = now + ESCAPE_MS;
      this.escapeTurn = this.blockedSide(x, y, this.headingOf(p)) > 0 ? -0.5 : 0.5;
      this.path = [];
      this.progressAt = now;
      if (this.task === 'course' && this.waypoints[0]?.optional) {
        this.skipWaypoint(); // a crumb is not worth being stuck for
      } else {
        this.stuck = true;
        this.status = 'Autopilot: stuck';
      }
    }
    if (now < this.escapeUntil) {
      duck.autopilot = { forward: -0.6, turn: this.escapeTurn };
      duck.autopilotLook = null;
      return;
    }
    if (this.task === 'player' && distance < 0.45) {
      duck.autopilot = { forward: 0, turn: 0 };
      duck.autopilotLook = null; // arrived: it looks at you again
      this.status = 'Autopilot: here!';
      return;
    }
    const yaw = this.headingOf(p);
    if (this.task === 'course' && this.waypoints[0]?.optional) {
      // A crumb behind the duck, or one it is about to walk past, is left: turning
      // back for a bonus is what made the autopilot circle.
      let off = Math.atan2(this.target[1] - y, this.target[0] - x) - yaw;
      off = Math.abs(Math.atan2(Math.sin(off), Math.cos(off)));
      if (off > CRUMB_BEHIND || (distance < CRUMB_CLOSE && off > CRUMB_MISSED)) {
        this.skipWaypoint();
        return;
      }
    }
    if (!this.path.length || now - this.plannedAt > REPLAN_MS) {
      const w0 = this.waypoints[0];
      if (this.task === 'course' && w0?.optional && !w0.settled) {
        w0.settled = true;
        if (!this.crumbOnTheWay(x, y)) {
          this.skipWaypoint();
          return;
        }
      }
      this.path = this.plan([x, y], this.target);
      this.pathIndex = 0;
      this.plannedAt = now;
      // No clean way to a crumb (squeezed between pieces), or a long way round to
      // it: skip it rather than walk straight at it or detour for it.
      if (this.task === 'course' && this.waypoints[0]?.optional && (!this.planFound || this.pathLength > CRUMB_DETOUR * this.straightLength + 0.1)) {
        this.skipWaypoint();
        return;
      }
    }
    // Pure pursuit on the straightened path: steer for the point LOOKAHEAD
    // along it, so corners become arcs and the duck never aims at a point
    // beside or behind itself.
    const aim = this.lookahead(x, y);
    let error = Math.atan2(aim[1] - y, aim[0] - x) - yaw;
    error = Math.atan2(Math.sin(error), Math.cos(error));
    let turn = Math.max(-MAX_TURN, Math.min(MAX_TURN, error * TURN_GAIN));
    // Full walking pace, a little slower round a sharp corner; never a crawl:
    // the policy stalls below WALK_MIN (a right turn above all).
    let forward = Math.abs(error) > SHARP ? WALK_MIN : CRUISE;
    // A sharp corner, or a target beside or behind: pivot towards it, backing
    // up while turning (never the long way round), unless something is behind.
    this.pivoting = Math.abs(error) > (this.pivoting ? PIVOT_OUT : PIVOT_IN);
    if (this.pivoting) {
      turn = error > 0 ? MAX_TURN : -MAX_TURN;
      forward = this.roomBehind(x, y, yaw) ? PIVOT_BACK : WALK_MIN;
    }
    // Whiskers: something sensed right in front (a ball just dropped there)
    // stops the walk and turns towards the freer side, before the plan catches up.
    // A turn on the spot only starts the gait to the left, so left wins ties.
    this.whiskers[0] = this.range(x, y, yaw);
    this.whiskers[1] = this.range(x, y, yaw + 0.6);
    this.whiskers[2] = this.range(x, y, yaw - 0.6);
    if (forward > 0 && this.whiskers[0] < WHISKER) {
      forward = 0;
      turn = this.whiskers[1] >= this.whiskers[2] * 0.7 ? MAX_TURN : -MAX_TURN;
      this.path = []; // replan around it next frame
    }
    // A stalled start (standing, asked to walk): a short turning kick gets it stepping.
    if (forward > 0 && this.speed < STALL_SPEED && duck.sim.mode === 'walk') {
      if (!this.stalledSince) this.stalledSince = now;
      else if (now - this.stalledSince > STALL_MS) {
        this.kickUntil = now + KICK_MS;
        this.kickTurn = turn < -0.2 ? -KICK_TURN : KICK_TURN;
        this.stalledSince = 0;
      }
    } else {
      this.stalledSince = 0;
    }
    if (now < this.kickUntil) {
      forward = CRUISE;
      turn = this.kickTurn;
    }
    duck.autopilot = { forward, turn };
    duck.autopilotLook = error;
  }

  /**
   * The point LOOKAHEAD metres along the path beyond the duck's nearest point
   * on it (the path's end, or the target, when less is left).
   */
  private lookahead(x: number, y: number): [number, number] {
    const path = this.path;
    if (path.length < 2) return path[0] ?? this.target;
    let best = this.pathIndex;
    let bestD = Infinity;
    let bestU = 0;
    for (let i = this.pathIndex; i < path.length - 1 && i < this.pathIndex + 4; i++) {
      const [ax, ay] = path[i];
      const dx = path[i + 1][0] - ax;
      const dy = path[i + 1][1] - ay;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
      const d = Math.hypot(ax + u * dx - x, ay + u * dy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
        bestU = u;
      }
    }
    this.pathIndex = best;
    let left = LOOKAHEAD;
    let px = path[best][0] + bestU * (path[best + 1][0] - path[best][0]);
    let py = path[best][1] + bestU * (path[best + 1][1] - path[best][1]);
    for (let i = best + 1; i < path.length; i++) {
      const step = Math.hypot(path[i][0] - px, path[i][1] - py);
      if (step >= left) {
        const k = left / step;
        return [px + (path[i][0] - px) * k, py + (path[i][1] - py) * k];
      }
      left -= step;
      px = path[i][0];
      py = path[i][1];
    }
    return path[path.length - 1];
  }

  /** The duck's heading in the stage frame, from its pose (x y z, then the quaternion w x y z). */
  private headingOf(p: ArrayLike<number>): number {
    return Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
  }

  /**
   * Whether the crumb ahead is on the way: reachable, no U-turn to go on from
   * it, and not much longer than walking straight on to the next gate or the
   * finish.
   */
  private crumbOnTheWay(x: number, y: number): boolean {
    const crumb = this.waypoints[0];
    const next = this.waypoints.find((w) => !w.optional);
    if (!next) return true;
    const onward: [number, number] = [next.through ? next.x + PASS_BEYOND : next.x, next.y];
    const there = this.plan([x, y], [crumb.x, crumb.y]);
    if (!this.planFound) return false;
    const a = this.pathLength;
    const on = this.plan([crumb.x, crumb.y], onward);
    if (!this.planFound) return false;
    const b = this.pathLength;
    this.plan([x, y], onward);
    const direct = this.planFound ? this.pathLength : Infinity;
    const from = there.length > 1 ? there[there.length - 2] : [x, y];
    const to = on.length > 1 ? on[1] : onward;
    const into = Math.atan2(crumb.y - from[1], crumb.x - from[0]);
    const out = Math.atan2(to[1] - crumb.y, to[0] - crumb.x);
    const bend = Math.abs(Math.atan2(Math.sin(out - into), Math.cos(out - into)));
    return bend < CRUMB_TURN && a + b < direct + CRUMB_EXTRA;
  }

  /** Moves a gate's approach point off any obstacle, to the nearest free cell in front of the gate. */
  private settleApproach(w: Waypoint): void {
    const grid = this.grid!;
    w.settled = true;
    const free = (px: number, py: number) => {
      const i = Math.floor((px - grid.x0) / CELL);
      const j = Math.floor((py - grid.y0) / CELL);
      return i >= 0 && j >= 0 && i < grid.cols && j < grid.rows && !grid.blocked[j * grid.cols + i];
    };
    if (free(w.x, w.y)) return;
    for (let r = CELL; r <= 0.2; r += CELL) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const px = w.x + Math.cos(a) * r;
        const py = w.y + Math.sin(a) * r;
        if (px <= w.x + 0.05 && free(px, py)) {
          w.x = px;
          w.y = py;
          return;
        }
      }
    }
  }

  /** Whether there is floor behind the duck to back into while it pivots. */
  private roomBehind(x: number, y: number, heading: number): boolean {
    const grid = this.grid;
    if (!grid) return true;
    for (const angle of [Math.PI, Math.PI - 0.5, Math.PI + 0.5]) {
      for (const d of [0.1, 0.17]) {
        const i = Math.floor((x + Math.cos(heading + angle) * d - grid.x0) / CELL);
        const j = Math.floor((y + Math.sin(heading + angle) * d - grid.y0) / CELL);
        if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows || grid.solid[j * grid.cols + i]) return false;
      }
    }
    return true;
  }

  /** Drop the course target ahead (an optional crumb) and head for the next one. */
  private skipWaypoint(): void {
    this.waypoints.shift();
    this.path = [];
    this.bestDistance = Infinity;
  }

  /**
   * Which side of the duck is more boxed in by solid things (course pieces,
   * furniture, sensed blocks): +1 its left, -1 its right, 0 neither.
   */
  private blockedSide(x: number, y: number, heading: number): number {
    const grid = this.grid;
    if (!grid) return 0;
    let side = 0;
    for (const sign of [1, -1]) {
      for (const angle of [0.5, 0.9, 1.3]) {
        for (const d of [0.12, 0.2]) {
          const i = Math.floor((x + Math.cos(heading + sign * angle) * d - grid.x0) / CELL);
          const j = Math.floor((y + Math.sin(heading + sign * angle) * d - grid.y0) / CELL);
          if (i >= 0 && j >= 0 && i < grid.cols && j < grid.rows && grid.solid[j * grid.cols + i]) side += sign;
        }
      }
    }
    return Math.sign(side);
  }

  /** Distance along a heading to the first blocked cell, up to LOOK. */
  private range(x: number, y: number, heading: number): number {
    const grid = this.grid;
    if (!grid) return LOOK;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    for (let d = CELL; d <= LOOK; d += CELL) {
      const i = Math.floor((x + c * d - grid.x0) / CELL);
      const j = Math.floor((y + s * d - grid.y0) / CELL);
      if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) return d;
      if (grid.sensed[j * grid.cols + i]) return d;
    }
    return LOOK;
  }

  private stage(): Entity | null {
    return (this.queries.stages.entities.values().next().value as Entity | undefined) ?? null;
  }

  /** Marks the cells around the duck as visited (explore). */
  private markVisited(x: number, y: number): void {
    const grid = this.grid;
    if (!grid) return;
    if (!this.visited || this.visited.length !== grid.cols * grid.rows || this.visitedX0 !== grid.x0 || this.visitedY0 !== grid.y0) {
      this.visited = new Uint8Array(grid.cols * grid.rows);
      this.visitedCols = grid.cols;
      this.visitedX0 = grid.x0;
      this.visitedY0 = grid.y0;
    }
    const r = Math.ceil(VISIT_RADIUS / CELL);
    const ci = Math.floor((x - grid.x0) / CELL);
    const cj = Math.floor((y - grid.y0) / CELL);
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) continue;
        if (Math.hypot(i - ci, j - cj) * CELL <= VISIT_RADIUS) this.visited[j * grid.cols + i] = 1;
      }
    }
  }

  private reachedExploreTarget(x: number, y: number): boolean {
    const w = this.waypoints[0];
    return Math.hypot(w.x - x, w.y - y) < w.reach;
  }

  /**
   * The nearest free cell (by walking distance) the duck has not visited:
   * a breadth-first search over free cells from the duck's cell.
   */
  private nextUnvisited(x: number, y: number): [number, number] | null {
    const grid = this.grid;
    const visited = this.visited;
    if (!grid || !visited) return null;
    const si = Math.max(0, Math.min(grid.cols - 1, Math.floor((x - grid.x0) / CELL)));
    const sj = Math.max(0, Math.min(grid.rows - 1, Math.floor((y - grid.y0) / CELL)));
    const seen = new Uint8Array(grid.cols * grid.rows);
    const queue: number[] = [sj * grid.cols + si];
    seen[queue[0]] = 1;
    let head = 0;
    while (head < queue.length) {
      const n = queue[head++];
      const ni = n % grid.cols;
      const nj = Math.floor(n / grid.cols);
      if (!visited[n] && Math.hypot((ni - si) * CELL, (nj - sj) * CELL) >= EXPLORE_MIN) {
        return [grid.x0 + (ni + 0.5) * CELL, grid.y0 + (nj + 0.5) * CELL];
      }
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ni + di;
          const j = nj + dj;
          if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) continue;
          const m = j * grid.cols + i;
          if (seen[m] || grid.blocked[m]) continue;
          seen[m] = 1;
          queue.push(m);
        }
      }
    }
    return null;
  }

  /** Rasterize the course colliders and the scanned furniture into the grid. */
  private buildGrid(stage: Entity): void {
    const object = stage.object3D!;
    const course = gatherCourse(object, null, object.parent); // the VR room and set dressing too
    let minX = -0.6;
    let maxX = 3.6;
    let minY = -1.2;
    let maxY = 1.2;
    for (const child of object.children) {
      if (child.position.y > 1) continue;
      minX = Math.min(minX, child.position.x - 0.6);
      maxX = Math.max(maxX, child.position.x + 0.6);
      minY = Math.min(minY, -child.position.z - 0.8);
      maxY = Math.max(maxY, -child.position.z + 0.8);
    }
    if (this.wide) {
      // Roaming: the whole terrain area (the room), not just the course.
      minX = Math.min(minX, terrainX(0));
      maxX = Math.max(maxX, terrainX(TERRAIN_N - 1));
      minY = Math.min(minY, terrainY(0));
      maxY = Math.max(maxY, terrainY(TERRAIN_N - 1));
    }
    const cols = Math.ceil((maxX - minX) / CELL);
    const rows = Math.ceil((maxY - minY) / CELL);
    const blocked = new Uint8Array(cols * rows);
    const solid = new Uint8Array(cols * rows);
    const sensed = new Uint8Array(cols * rows);
    const grid: Grid = { x0: minX, y0: minY, cols, rows, blocked, solid, sensed };
    const mark = (cx: number, cy: number, hx: number, hy: number, yaw: number, fromSensor = false) => {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const grow = Math.max(hx, hy) < 0.05 ? POST_RADIUS : DUCK_RADIUS;
      const reach = Math.hypot(hx, hy) + grow;
      const i0 = Math.max(0, Math.floor((cx - reach - minX) / CELL));
      const i1 = Math.min(cols - 1, Math.ceil((cx + reach - minX) / CELL));
      const j0 = Math.max(0, Math.floor((cy - reach - minY) / CELL));
      const j1 = Math.min(rows - 1, Math.ceil((cy + reach - minY) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = minX + (i + 0.5) * CELL - cx;
          const py = minY + (j + 0.5) * CELL - cy;
          const lx = px * c + py * s;
          const ly = -px * s + py * c;
          if (Math.abs(lx) <= hx + grow && Math.abs(ly) <= hy + grow) {
            blocked[j * cols + i] = 1;
            if (Math.abs(lx) <= hx + CELL / 2 && Math.abs(ly) <= hy + CELL / 2) {
              solid[j * cols + i] = 1;
              if (fromSensor) sensed[j * cols + i] = 1;
            }
          }
        }
      }
    };
    for (const collider of course.colliders) {
      const [px, py, pz] = collider.pos;
      const top = pz + (collider.type === 'box' ? collider.size[2] : collider.type === 'cylinder' ? collider.size[1] : collider.size[0]);
      const bottom = pz - (collider.type === 'box' ? collider.size[2] : collider.type === 'cylinder' ? collider.size[1] : collider.size[0]);
      if (bottom > 0.22) continue; // the duck walks under it
      if (top < 0.02) continue; // flat on the floor
      const [qw, qx, qy, qz] = collider.quat;
      const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
      if (collider.type === 'box') mark(px, py, collider.size[0], collider.size[1], yaw);
      else mark(px, py, collider.size[0], collider.size[0], 0);
    }
    // Scanned furniture (world-space boxes) into the stage frame.
    const boxes = this.room?.obstacleBoxes() ?? [];
    if (boxes.length) {
      object.updateWorldMatrix(true, false);
      this.inverse.copy(object.matrixWorld).invert();
      object.getWorldQuaternion(this.q);
      const stageYaw = Math.atan2(2 * (this.q.w * this.q.y + this.q.x * this.q.z), 1 - 2 * (this.q.y * this.q.y + this.q.z * this.q.z));
      for (const box of boxes) {
        this.v.set((box.minX + box.maxX) / 2, 0, (box.minZ + box.maxZ) / 2).applyMatrix4(this.inverse);
        mark(this.v.x, -this.v.z, (box.maxX - box.minX) / 2, (box.maxZ - box.minZ) / 2, stageYaw);
      }
    }
    // Things the depth sensor found on the floor that are too tall to climb.
    const terrain = this.terrain;
    if (terrain?.active) {
      const heights = terrain.heights;
      for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (h < Math.max(CLIMBABLE, TERRAIN_MIN_HEIGHT)) continue;
        mark(terrainX(i % TERRAIN_N), terrainY(Math.floor(i / TERRAIN_N)), TERRAIN_CELL / 2, TERRAIN_CELL / 2, 0, true);
      }
    }
    this.grid = grid;
  }

  /** A* over the grid; falls back to a straight line when there is no grid. */
  private plan(from: [number, number], to: [number, number]): [number, number][] {
    const grid = this.grid;
    if (!grid) return [to];
    const cell = (x: number, y: number): [number, number] => [
      Math.max(0, Math.min(grid.cols - 1, Math.floor((x - grid.x0) / CELL))),
      Math.max(0, Math.min(grid.rows - 1, Math.floor((y - grid.y0) / CELL))),
    ];
    const [si, sj] = cell(from[0], from[1]);
    const [gi, gj] = cell(to[0], to[1]);
    const index = (i: number, j: number) => j * grid.cols + i;
    const goal = index(gi, gj);
    const start = index(si, sj);
    const came = new Int32Array(grid.cols * grid.rows).fill(-1);
    const cost = new Float32Array(grid.cols * grid.rows).fill(Infinity);
    const open: number[] = [start];
    cost[start] = 0;
    const h = (n: number) => Math.hypot((n % grid.cols) - gi, Math.floor(n / grid.cols) - gj);
    let found = false;
    let steps = 0;
    while (open.length && steps++ < 40000) {
      let best = 0;
      for (let k = 1; k < open.length; k++) {
        if (cost[open[k]] + h(open[k]) < cost[open[best]] + h(open[best])) best = k;
      }
      const n = open.splice(best, 1)[0];
      if (n === goal) {
        found = true;
        break;
      }
      const ni = n % grid.cols;
      const nj = Math.floor(n / grid.cols);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ni + di;
          const j = nj + dj;
          if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) continue;
          const m = index(i, j);
          // Grown cells are off limits, except right around the start (the duck
          // may be touching something) and the goal cell; solid cells always are.
          if (grid.solid[m]) continue;
          if (grid.blocked[m] && m !== goal && (Math.abs(i - si) > 2 || Math.abs(j - sj) > 2)) continue;
          // Hugging an obstacle costs extra, so paths keep a cell of air where they can.
          let near = grid.blocked[m] ? NEAR_COST : 0;
          if (!near) {
            for (let dj2 = -1; dj2 <= 1 && !near; dj2++) {
              for (let di2 = -1; di2 <= 1; di2++) {
                const i2 = i + di2;
                const j2 = j + dj2;
                if (i2 >= 0 && j2 >= 0 && i2 < grid.cols && j2 < grid.rows && grid.blocked[index(i2, j2)]) {
                  near = NEAR_COST;
                  break;
                }
              }
            }
          }
          const step = cost[n] + Math.hypot(di, dj) + near;
          if (step < cost[m]) {
            cost[m] = step;
            came[m] = n;
            if (!open.includes(m)) open.push(m);
          }
        }
      }
    }
    this.planFound = found;
    this.straightLength = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (!found) {
      this.pathLength = this.straightLength;
      return [from, [to[0], to[1]]];
    }
    const cells: [number, number][] = [from];
    const back: [number, number][] = [];
    for (let n = goal; n !== -1 && n !== start; n = came[n]) {
      back.push([grid.x0 + ((n % grid.cols) + 0.5) * CELL, grid.y0 + (Math.floor(n / grid.cols) + 0.5) * CELL]);
    }
    for (let k = back.length - 1; k >= 0; k--) cells.push(back[k]);
    cells.push([to[0], to[1]]);
    // String pulling: from each corner, the farthest later point in plain sight.
    const out: [number, number][] = [cells[0]];
    for (let i = 0; i < cells.length - 1; ) {
      let j = cells.length - 1;
      while (j > i + 1 && !this.inSight(cells[i], cells[j], si, sj, gi, gj)) j--;
      out.push(cells[j]);
      i = j;
    }
    let length = 0;
    for (let k = 1; k < out.length; k++) length += Math.hypot(out[k][0] - out[k - 1][0], out[k][1] - out[k - 1][1]);
    this.pathLength = length;
    return out;
  }

  /**
   * Whether the straight line from a to b crosses no obstacle the planner
   * avoids (grown cells, except next to the start and at the goal, as in A*).
   */
  private inSight(a: [number, number], b: [number, number], si: number, sj: number, gi: number, gj: number): boolean {
    const grid = this.grid;
    if (!grid) return true;
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2));
    for (let k = 1; k < steps; k++) {
      const u = k / steps;
      const i = Math.floor((a[0] + (b[0] - a[0]) * u - grid.x0) / CELL);
      const j = Math.floor((a[1] + (b[1] - a[1]) * u - grid.y0) / CELL);
      if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) return false;
      const m = j * grid.cols + i;
      if (grid.solid[m]) return false;
      if (grid.blocked[m] && !(i === gi && j === gj) && (Math.abs(i - si) > 2 || Math.abs(j - sj) > 2)) return false;
    }
    return true;
  }
}
