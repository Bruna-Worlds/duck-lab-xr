// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck Lab XR: the course run. Watches the duck and the ball against the
 * course pieces under the duck stage, keeps time and score, and scores
 * combos the Tony Hawk way: events less than 2.5 s apart chain up, the
 * chain pays its points times its length, and a fall loses the chain.
 *
 * All positions are compared in the stage's MuJoCo frame (Z up), the same
 * frame as the sim's poses.
 */
import { createSystem, type Entity, Matrix4, type Object3D, Quaternion, Vector3 } from '@iwsdk/core';
import { playSound } from '../audio/duck-sounds.js';
import { FxSystem } from '../fx/fx-system.js';
import { BALL_OFFSET, type MoveName } from '../duck/duck-constants.js';
import { DuckStage } from '../duck/duck-stage.js';
import { DuckSystem } from '../duck/duck-system.js';
import type { SimEvent } from '../duck/sim-protocol.js';
import { CourseCrumb, CourseFinish, CourseGate, CourseGoal } from './course-components.js';

const COMBO_WINDOW_MS = 2500;
const MAX_MULTIPLIER = 8;
const CRUMB_RADIUS = 0.08;
const PECK_RADIUS = 0.16;
const PECK_BONUS = 150;
const BEAK_REACH = 0.1; // beak tip ahead of the trunk centre, m
const START_RADIUS = 0.05;
const BANNER_MS = 1500;
const TIME_BONUS_PER_S = 10;

const MOVE_POINTS: Record<MoveName, number> = {
  kickL: 50,
  kickR: 50,
  roll: 200,
  peck: 50,
  sit: 25,
  stand: 0,
  motion: 75, // a keyframe superpower (bow, wiggle)
};
const MOVE_LABEL: Record<MoveName, string> = {
  kickL: 'KICK',
  kickR: 'KICK',
  roll: 'ROLL',
  peck: 'PECK',
  sit: 'SIT',
  stand: 'STAND',
  motion: 'BOW',
};

export type RunState = 'ready' | 'running' | 'finished';

/** A watched piece, in the stage's MuJoCo frame. */
interface Zone {
  entity: Entity;
  x: number;
  y: number;
  /** Direction of the piece's local +x axis. */
  cos: number;
  sin: number;
  done: boolean;
  /** Gates: which side of the gate the duck was last on. */
  side: number;
  /** Crumbs: the animated bread and its glow ring. */
  bread?: Object3D;
  glow?: Object3D;
  phase: number;
}

export class CourseSystem extends createSystem({
  crumbs: { required: [CourseCrumb] },
  gates: { required: [CourseGate] },
  goals: { required: [CourseGoal] },
  finishes: { required: [CourseFinish] },
  stages: { required: [DuckStage] },
}) {
  state: RunState = 'ready';
  /** Seconds since the run started. */
  elapsed = 0;
  score = 0;
  /** Labels of the combo in progress, newest last. */
  comboNames: string[] = [];
  comboPoints = 0;
  comboCount = 0;
  bestCombo = 0;
  lastBank = 0;
  falls = 0;
  crumbsGot = 0;
  gatesGot = 0;
  goalsGot = 0;
  timeBonus = 0;
  stars = 0;
  /** Big feedback text ("GATE!", "BAIL!"), empty when none is showing. */
  banner = '';

  private duck: DuckSystem | undefined;
  private fx: FxSystem | undefined;
  private fxAt!: Vector3;
  private fxNormal!: Vector3;
  private crumbZones: Zone[] = [];
  private gateZones: Zone[] = [];
  private goalZones: Zone[] = [];
  private finishZone: Zone | null = null;

  /** A playground without a finish pad: free roam, no run clock. */
  get freeRoam(): boolean {
    return this.zonesBuilt && this.finishZone === null;
  }

  /** The pieces changed (editor): read them again and start the run over. */
  invalidateZones(): void {
    this.zonesBuilt = false;
    this.resetRun();
  }
  private zonesBuilt = false;
  private startX = 0;
  private startY = 0;
  private startedAt = 0;
  private comboLastAt = 0;
  private bannerUntil = 0;
  private relative!: Matrix4;
  private inverse!: Matrix4;
  private pos!: Vector3;
  private quat!: Quaternion;
  private scale!: Vector3;
  private axis!: Vector3;

  get crumbsTotal(): number {
    return this.crumbZones.length;
  }
  get gatesTotal(): number {
    return this.gateZones.length;
  }
  get goalsTotal(): number {
    return this.goalZones.length;
  }
  /** Par time of the finish, seconds. */
  get par(): number {
    const finish = this.finishZone?.entity;
    return finish ? (finish.getValue(CourseFinish, 'par') as number) : 60;
  }

  init(): void {
    this.relative = new Matrix4();
    this.inverse = new Matrix4();
    this.pos = new Vector3();
    this.quat = new Quaternion();
    this.scale = new Vector3();
    this.axis = new Vector3();
    this.fxAt = new Vector3();
    this.fxNormal = new Vector3();
    this.fx = this.world.getSystem(FxSystem);
    this.duck = this.world.getSystem(DuckSystem);
    this.queries.stages.subscribe('qualify', () => {
      this.zonesBuilt = false; // a new playground: read its pieces afresh
      this.resetRun();
    });
    const duck = this.duck;
    if (duck) {
      const onEvent = (event: SimEvent) => this.onSimEvent(event);
      const onRestart = () => this.resetRun();
      duck.simEvents.add(onEvent);
      duck.restartListeners.add(onRestart);
      this.cleanupFuncs.push(
        () => duck.simEvents.delete(onEvent),
        () => duck.restartListeners.delete(onRestart),
      );
    }
  }

  /** Restart button on the run panel. */
  restartRun(): void {
    this.duck?.restart(); // the duck calls back into resetRun()
  }

  update(): void {
    const duck = this.duck;
    const now = performance.now();
    if (this.banner && now > this.bannerUntil) {
      this.banner = '';
    }
    if (this.comboCount > 0 && now - this.comboLastAt > COMBO_WINDOW_MS) {
      this.bankCombo();
    }
    if (!duck?.hasPose) {
      return;
    }
    if (!this.zonesBuilt) {
      this.buildZones();
    }
    if (import.meta.env.DEV) {
      this.debugWarps(duck);
    }
    const p = duck.pose;
    const x = p[0];
    const y = p[1];
    this.animateCrumbs(now);

    if (this.state === 'ready') {
      if (this.freeRoam) {
        return; // no finish line: nothing to time
      }
      // The player's stick or the autopilot setting off both start the clock.
      const driving = duck.commanded || (duck.autopilot !== null && duck.autopilot.forward > 0.05);
      if (duck.sim?.mode !== 'walk' || !driving) {
        // Waking up, sitting, or idling on the pad: the start line follows the
        // duck, so the idle shuffle never starts the clock by itself.
        this.startX = x;
        this.startY = y;
        return;
      }
      if (Math.hypot(x - this.startX, y - this.startY) > START_RADIUS) {
        this.startRun();
      } else {
        return;
      }
    }
    if (this.state !== 'running') {
      return;
    }
    this.elapsed = (now - this.startedAt) / 1000;

    // Crumbs: walk over one, or peck it for a bonus.
    const yaw = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
    const pecking = duck.sim?.mode === 'peck';
    const beakX = x + Math.cos(yaw) * BEAK_REACH;
    const beakY = y + Math.sin(yaw) * BEAK_REACH;
    for (const crumb of this.crumbZones) {
      if (crumb.done) continue;
      const points = crumb.entity.getValue(CourseCrumb, 'points') as number;
      if (pecking && Math.hypot(beakX - crumb.x, beakY - crumb.y) < PECK_RADIUS) {
        this.collectCrumb(crumb);
        this.addEvent('PECK BONUS', points + PECK_BONUS);
        playSound('peck-bonus');
        this.pop(crumb.x, crumb.y, 0.04, `PECK +${points + PECK_BONUS}`, '#ffe08a');
        this.fx?.sparkle(this.fxAt, 0xffe08a, 26);
      } else if (Math.hypot(x - crumb.x, y - crumb.y) < CRUMB_RADIUS) {
        this.collectCrumb(crumb);
        this.addEvent('CRUMB', points);
        playSound('crumb');
        this.pop(crumb.x, crumb.y, 0.04, `+${points}`, '#ffd166');
        this.fx?.sparkle(this.fxAt, 0xffd166, 16);
      }
    }

    // Gates: crossing the gate line between the posts, either way.
    for (const gate of this.gateZones) {
      if (gate.done) continue;
      const dx = x - gate.x;
      const dy = y - gate.y;
      const along = gate.cos * dx + gate.sin * dy;
      const across = -gate.sin * dx + gate.cos * dy;
      const side = along >= 0 ? 1 : -1;
      const halfWidth = gate.entity.getValue(CourseGate, 'halfWidth') as number;
      if (side !== gate.side && Math.abs(across) < halfWidth) {
        gate.done = true;
        this.gatesGot++;
        const gatePoints = gate.entity.getValue(CourseGate, 'points') as number;
        this.addEvent('GATE', gatePoints);
        this.showBanner('GATE!');
        playSound('gate');
        this.pop(gate.x, gate.y, 0.2, `GATE +${gatePoints}`, '#4cc9f0');
        this.fx?.ring(this.fxAt, this.fxNormal.set(gate.cos, 0, -gate.sin), 0x4cc9f0);
        this.fx?.sparkle(this.fxAt.setY(0.32), 0x4cc9f0, 24);
      }
      gate.side = side;
    }

    // Goal: the ball inside the goal box.
    const bx = p[BALL_OFFSET];
    const by = p[BALL_OFFSET + 1];
    const bz = p[BALL_OFFSET + 2];
    for (const goal of this.goalZones) {
      if (goal.done) continue;
      const e = goal.entity;
      const dx = bx - goal.x;
      const dy = by - goal.y;
      const along = goal.cos * dx + goal.sin * dy;
      const across = -goal.sin * dx + goal.cos * dy;
      if (
        Math.abs(along) < (e.getValue(CourseGoal, 'halfDepth') as number) &&
        Math.abs(across) < (e.getValue(CourseGoal, 'halfWidth') as number) &&
        bz < (e.getValue(CourseGoal, 'height') as number)
      ) {
        goal.done = true;
        this.goalsGot++;
        const goalPoints = e.getValue(CourseGoal, 'points') as number;
        this.addEvent('GOAL', goalPoints);
        this.showBanner('GOAL!');
        playSound('goal');
        this.pop(goal.x, goal.y, 0.2, `GOAL! +${goalPoints}`, '#06d6a0', 0.08);
        this.fx?.burstConfetti(this.fxAt.setY(0.12), 90);
        duck.quack('happy');
      }
    }

    // Finish.
    const finish = this.finishZone;
    if (finish) {
      const radius = finish.entity.getValue(CourseFinish, 'radius') as number;
      if (Math.hypot(x - finish.x, y - finish.y) < radius) {
        this.finishRun();
      }
    }
  }

  /**
   * Development only: number keys warp the duck to checkpoints, so runs can
   * be tested without driving the whole course. 1 / 3 before gate 1 / 2,
   * 2 behind the ball lined up with the goal, 4 before the finish, 9 tips the
   * duck over (fall test).
   */
  private debugWarps(duck: DuckSystem): void {
    const sim = duck.sim;
    const keys = this.input.keyboard;
    if (!sim) return;
    const p = duck.pose;
    const before = (zone: Zone | null | undefined, back: number) => {
      if (zone) {
        sim.teleport(zone.x - zone.cos * back, zone.y - zone.sin * back, Math.atan2(zone.sin, zone.cos));
      }
    };
    if (keys.getKeyDown('Digit1')) before(this.gateZones[0], 0.2);
    if (keys.getKeyDown('Digit3')) before(this.gateZones[1], 0.2);
    if (keys.getKeyDown('Digit4')) before(this.finishZone, 0.3);
    const goal = this.goalZones[0];
    if (keys.getKeyDown('Digit2') && goal) {
      const bx = p[BALL_OFFSET];
      const by = p[BALL_OFFSET + 1];
      const len = Math.hypot(goal.x - bx, goal.y - by) || 1;
      const dx = (goal.x - bx) / len;
      const dy = (goal.y - by) / len;
      // The blind kick is a short tap: the foot moves about 6 cm forward and
      // the feet are 7 cm either side of the body. Put the ball at the left toe.
      sim.teleport(bx - dx * 0.085 + dy * 0.07, by - dy * 0.085 - dx * 0.07, Math.atan2(dy, dx));
    }
    if (keys.getKeyDown('Digit9')) {
      const yaw = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
      sim.teleport(p[0], p[1], yaw, Math.PI * 0.45);
    }
  }

  private startRun(): void {
    this.state = 'running';
    this.startedAt = performance.now();
    this.elapsed = 0;
    this.showBanner('GO!');
  }

  private finishRun(): void {
    this.bankCombo();
    this.state = 'finished';
    this.timeBonus = Math.round(Math.max(0, this.par - this.elapsed) * TIME_BONUS_PER_S);
    this.score += this.timeBonus;
    const allCrumbs = this.crumbsGot === this.crumbsTotal;
    const allGoals = this.goalsGot === this.goalsTotal;
    const halfCrumbs = this.crumbsGot * 2 >= this.crumbsTotal;
    this.stars = 1;
    if (allGoals && halfCrumbs) this.stars = 2;
    if (allGoals && allCrumbs && this.gatesGot === this.gatesTotal && this.elapsed <= this.par) {
      this.stars = 3;
    }
    this.showBanner('FINISH!');
    playSound('finish');
    const p = this.duck?.pose;
    if (p) {
      this.pop(p[0], p[1], 0.3, 'FINISH!', '#ffd166', 0.1);
      this.fx?.burstConfetti(this.fxAt.setY(0.25), 220, 1.8);
    }
    this.duck?.quack('happy');
    console.info(
      `[course] finished in ${this.elapsed.toFixed(1)} s: score ${this.score}, ${this.stars} stars, ` +
        `crumbs ${this.crumbsGot}/${this.crumbsTotal}, gates ${this.gatesGot}/${this.gatesTotal}, ` +
        `goal ${this.goalsGot}/${this.goalsTotal}, falls ${this.falls}, best combo ${this.bestCombo}`,
    );
  }

  private resetRun(): void {
    this.state = 'ready';
    this.elapsed = 0;
    this.score = 0;
    this.comboNames = [];
    this.comboPoints = 0;
    this.comboCount = 0;
    this.bestCombo = 0;
    this.lastBank = 0;
    this.falls = 0;
    this.crumbsGot = 0;
    this.gatesGot = 0;
    this.goalsGot = 0;
    this.timeBonus = 0;
    this.stars = 0;
    this.banner = '';
    this.zonesBuilt = false; // rebuild: the stage may have moved
    for (const crumb of this.crumbZones) {
      const object = crumb.entity.active ? crumb.entity.object3D : null; // the editor may have removed it
      if (object) object.visible = true;
    }
  }

  private collectCrumb(crumb: Zone): void {
    crumb.done = true;
    crumb.entity.object3D!.visible = false;
    this.crumbsGot++;
  }

  private onSimEvent(event: SimEvent): void {
    if (event.kind === 'fall' && this.state !== 'running') {
      const p = this.duck?.pose;
      if (p) {
        this.pop(p[0], p[1], 0.25, 'OOPS!', '#ef476f', 0.06);
        this.fx?.sparkle(this.fxAt.setY(0.04), 0x9aa4b2, 16, 0.4);
      }
      return;
    }
    if (this.state !== 'running' && !(this.state === 'ready' && event.kind === 'move-start')) {
      return;
    }
    if (event.kind === 'move-start' && this.state === 'ready') {
      // A trick from the start pad starts the clock; sitting down or the
      // wake-up stand does not.
      if (event.move !== 'sit' && event.move !== 'stand') this.startRun();
      return;
    }
    if (event.kind === 'move-end' && event.ok && event.move) {
      const points = MOVE_POINTS[event.move];
      if (points > 0) {
        this.addEvent(MOVE_LABEL[event.move], points);
        const p = this.duck?.pose;
        if (p) this.pop(p[0], p[1], 0.3, `${MOVE_LABEL[event.move]}!`, '#f4f1ea', 0.045);
      }
    } else if (event.kind === 'fall') {
      const p = this.duck?.pose;
      if (p) {
        this.pop(p[0], p[1], 0.25, 'BAIL!', '#ef476f', 0.07);
        this.fx?.sparkle(this.fxAt.setY(0.04), 0x9aa4b2, 20, 0.4);
      }
      this.falls++;
      if (this.comboCount > 0) {
        this.comboNames = [];
        this.comboPoints = 0;
        this.comboCount = 0;
      }
      this.showBanner('BAIL!');
    }
  }

  private addEvent(label: string, points: number): void {
    const now = performance.now();
    if (this.comboCount > 0 && now - this.comboLastAt > COMBO_WINDOW_MS) {
      this.bankCombo();
    }
    this.comboNames.push(label);
    if (this.comboNames.length > 5) this.comboNames.shift();
    this.comboPoints += points;
    this.comboCount++;
    this.comboLastAt = now;
    if (this.comboCount >= 2) {
      playSound('combo');
      const p = this.duck?.pose;
      if (p) this.pop(p[0], p[1], 0.38, `x${Math.min(this.comboCount, MAX_MULTIPLIER)} COMBO`, '#ff9f1c', 0.05);
    }
  }

  private bankCombo(): void {
    if (this.comboCount === 0) {
      return;
    }
    const total = this.comboPoints * Math.min(this.comboCount, MAX_MULTIPLIER);
    this.score += total;
    this.lastBank = total;
    this.bestCombo = Math.max(this.bestCombo, total);
    this.comboNames = [];
    this.comboPoints = 0;
    this.comboCount = 0;
  }

  /** Floating label at a MuJoCo-frame spot; leaves fxAt at that spot. */
  private pop(x: number, y: number, height: number, label: string, color: string, size = 0.06): void {
    this.fx?.toStage(x, y, height, this.fxAt);
    this.fx?.text(this.fxAt, label, color, size);
  }

  /** Crumbs bob, spin and pulse their glow until collected. */
  private animateCrumbs(now: number): void {
    const t = now / 1000;
    for (const crumb of this.crumbZones) {
      if (crumb.done) continue;
      if (crumb.bread) {
        crumb.bread.position.y = 0.017 + 0.006 * Math.sin(t * 3 + crumb.phase);
        crumb.bread.rotation.y = t * 1.4 + crumb.phase;
      }
      if (crumb.glow) {
        const pulse = 1 + 0.14 * Math.sin(t * 4 + crumb.phase);
        crumb.glow.scale.set(pulse, 1, pulse);
      }
    }
  }

  private showBanner(text: string): void {
    this.banner = text;
    this.bannerUntil = performance.now() + BANNER_MS;
  }

  /** Reads the watched pieces' positions relative to the stage. */
  private buildZones(): void {
    const stage = this.queries.stages.entities.values().next().value as Entity | undefined;
    const stageObject = stage?.object3D;
    if (!stageObject) {
      return;
    }
    stageObject.updateWorldMatrix(true, true);
    this.inverse.copy(stageObject.matrixWorld).invert();
    const toZone = (entity: Entity, previous: Zone[]): Zone | null => {
      const object = entity.object3D;
      if (!object) return null;
      this.relative.multiplyMatrices(this.inverse, object.matrixWorld);
      this.relative.decompose(this.pos, this.quat, this.scale);
      this.axis.set(1, 0, 0).applyQuaternion(this.quat);
      const ax = this.axis.x;
      const ay = -this.axis.z; // three -> MuJoCo: (x, -z, y)
      const len = Math.hypot(ax, ay) || 1;
      const old = previous.find((z) => z.entity === entity);
      return {
        entity,
        x: this.pos.x,
        y: -this.pos.z,
        cos: ax / len,
        sin: ay / len,
        done: old?.done ?? false,
        side: 0,
        bread: object.getObjectByName('Bread'),
        glow: object.getObjectByName('Glow'),
        phase: (this.pos.x * 7.1 + this.pos.z * 3.7) % (Math.PI * 2),
      };
    };
    const zones = (set: Set<Entity>, previous: Zone[]) =>
      [...set].map((e) => toZone(e, previous)).filter((z): z is Zone => z !== null);
    this.crumbZones = zones(this.queries.crumbs.entities, []);
    this.gateZones = zones(this.queries.gates.entities, []);
    this.goalZones = zones(this.queries.goals.entities, []);
    this.finishZone = zones(this.queries.finishes.entities, [])[0] ?? null;
    const p = this.duck?.pose;
    this.startX = p ? p[0] : 0;
    this.startY = p ? p[1] : 0;
    // Each gate starts on the side the duck is on.
    for (const gate of this.gateZones) {
      const along = gate.cos * (this.startX - gate.x) + gate.sin * (this.startY - gate.y);
      gate.side = along >= 0 ? 1 : -1;
    }
    this.zonesBuilt = true;
  }
}
