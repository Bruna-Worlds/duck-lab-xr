// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A scenario pack as a training environment: MuJoCo (WebAssembly) running
 * the pack's exact scene (robot, course, scanned room, terrain) with the
 * headset's control loop: 50 Hz policy, 4 physics steps of 5 ms, the same
 * 61-value observation and the recorded commands of the moment the duck
 * struggled. Many episodes run side by side on one compiled model.
 *
 * Episode randomisation (seeded): joint and velocity noise at the start and a
 * little command noise, then one of two profiles:
 *
 * - pollen (the default): the domain randomisation of Pollen's and NVIDIA's
 *   MicroDuck recipe (Isaac Lab's contrib/microduck flat_env_cfg.py and
 *   robots/microduck.py, after pollen-robotics/microduck_rl), as far as a
 *   MuJoCo position servo carries it. Per episode: foot friction 0.7-1.3,
 *   trunk mass x0.95-1.05, trunk and head centres of mass +-3 mm, joint
 *   friction and armature x0.9-1.1, encoder bias +-0.015 rad, battery 6.5-8.2 V
 *   (motor gain and torque scale with it, 7.4 V nominal), a servo command delay
 *   of 3-6 physics steps, and an IMU tilted up to 6 degrees, a step late or
 *   not. Per step: gyro noise +-0.03, gravity +-0.01, joint position +-0.001,
 *   joint velocity +-0.25 and a step late. Pushes: the trunk's velocity kicked
 *   by up to 0.3 m/s every 3-6 s.
 * - basic: the first recipe, two or three sideways shoves of 0.8-2.5 N.
 */
import loadMujoco from '@mujoco/mujoco';
import { gaussian, rng } from './rng.mjs';

let mujocoPromise = null;
/** One MuJoCo module per thread. */
export function mujoco() {
  mujocoPromise ??= loadMujoco();
  return mujocoPromise;
}

const scalar = (v) => (typeof v === 'number' ? v : Number(v[0]));

/** Fall rule of the headset: tipped past 60 degrees or trunk on the floor, for a few steps. */
const FALL_GZ = -0.5;
const FALL_HEIGHT = 0.02;
const FALL_STEPS = 5;

/** The pollen profile's ranges (Isaac Lab contrib/microduck, microduck_rl). */
export const POLLEN = {
  footFriction: [0.7, 1.3],
  trunkMass: [0.95, 1.05],
  com: 0.003,
  jointFriction: [0.9, 1.1],
  armature: [0.9, 1.1],
  encoderBias: 0.015,
  volts: [6.5, 8.2],
  nominalVolts: 7.4,
  delaySteps: [3, 6],
  imuTiltDeg: 6,
  gyroNoise: 0.03,
  gravityNoise: 0.01,
  jointPosNoise: 0.001,
  jointVelNoise: 0.25,
  pushSpeed: 0.3,
  pushEvery: [3, 6],
};
const FOOT_GEOMS = ['left_foot_collision', 'right_foot_collision'];
const HEAD_BODIES = ['neck', 'neck_pitch', 'yaw_roll_motion', 'jaw_soft'];
const uniform = (random, [a, b]) => a + random() * (b - a);

export class PackEnv {
  /**
   * @param mj MuJoCo module
   * @param loaded result of loadPack()
   * @param options { flat: drop the terrain (a regression check on plain floor) }
   */
  constructor(mj, loaded, options = {}) {
    this.mj = mj;
    this.loaded = loaded;
    const pack = loaded.pack;
    this.pack = pack;
    this.control = pack.control;
    this.flat = !!options.flat;
    const vfs = new mj.MjVFS();
    for (const [file, bytes] of loaded.meshes) vfs.addBuffer(`assets/${file}`, bytes);
    // Plain floor: the same duck and start, without the course pieces or the sensed room.
    const xml = this.flat ? pack.mjcf.replace(/<geom\b[^>]*\bname="course_\d+"[^>]*\/>/g, '') : pack.mjcf;
    this.model = mj.MjModel.from_xml_string(xml, vfs);
    vfs.delete();
    const m = this.model;
    const geom = mj.mj_name2id(m, mj.mjtObj.mjOBJ_GEOM.value, 'terrain');
    if (geom >= 0 && loaded.terrain && !this.flat) {
      const hfield = m.geom_dataid[geom];
      m.hfield_data.set(loaded.terrain, m.hfield_adr[hfield]);
    }
    const c = this.control;
    this.N = c.numJoints;
    this.qposAdr = c.jointNames.map((name) => {
      const j = m.jnt(name);
      const adr = scalar(j.qposadr);
      j.delete();
      return adr;
    });
    this.dofAdr = c.jointNames.map((name) => {
      const j = m.jnt(name);
      const adr = scalar(j.dofadr);
      j.delete();
      return adr;
    });
    const free = m.jnt(c.freeJoint);
    this.freeAdr = scalar(free.qposadr);
    this.freeDof = scalar(free.dofadr);
    free.delete();
    const gyro = m.sensor(c.gyroSensor);
    this.gyroAdr = scalar(gyro.adr);
    gyro.delete();
    this.trunkBody = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, 'trunk_base');
    this.steps = pack.steps;
    this.defaultPose = Float32Array.from(c.defaultPose);
    this.randomize = options.randomize ?? 'pollen';
    // What the pollen profile varies per episode, and the compiled values (episodes share the model).
    const id = (type, name) => mj.mj_name2id(m, mj.mjtObj[type].value, name);
    this.footGeoms = FOOT_GEOMS.map((n) => id('mjOBJ_GEOM', n)).filter((g) => g >= 0);
    this.comBodies = [this.trunkBody, ...HEAD_BODIES.map((n) => id('mjOBJ_BODY', n)).filter((b) => b >= 0)];
    this.actuators = c.jointNames.map((n) => id('mjOBJ_ACTUATOR', n));
    this.nGain = m.actuator_gainprm.length / Math.max(1, m.nu);
    this.nBias = m.actuator_biasprm.length / Math.max(1, m.nu);
    const t = this.trunkBody;
    this.base = {
      friction: this.footGeoms.map((g) => m.geom_friction[g * 3]),
      mass: m.body_mass[t],
      inertia: Array.from(m.body_inertia.subarray(t * 3, t * 3 + 3)),
      ipos: this.comBodies.map((b) => Array.from(m.body_ipos.subarray(b * 3, b * 3 + 3))),
      armature: this.dofAdr.map((d) => m.dof_armature[d]),
      frictionloss: this.dofAdr.map((d) => m.dof_frictionloss[d]),
      damping: this.dofAdr.map((d) => m.dof_damping[d]),
      gain: this.actuators.map((a) => (a >= 0 ? m.actuator_gainprm[a * this.nGain] : 0)),
      bias: this.actuators.map((a) => (a >= 0 ? m.actuator_biasprm[a * this.nBias + 1] : 0)),
      force: this.actuators.map((a) => (a >= 0 ? [m.actuator_forcerange[a * 2], m.actuator_forcerange[a * 2 + 1]] : [0, 0])),
    };
    this.applied = undefined; // the episode whose values the model holds (null: the compiled ones)
  }

  /** Puts an episode's randomised values into the shared model (the compiled ones when it has none). */
  applyModel(ep) {
    const p = ep.params ?? null;
    if (this.applied === p) return;
    this.applied = p;
    const m = this.model;
    const b = this.base;
    this.footGeoms.forEach((g, i) => (m.geom_friction[g * 3] = b.friction[i] * (p ? p.footFriction[i] : 1)));
    const t = this.trunkBody;
    const ms = p ? p.trunkMass : 1;
    m.body_mass[t] = b.mass * ms;
    for (let k = 0; k < 3; k++) m.body_inertia[t * 3 + k] = b.inertia[k] * ms;
    this.comBodies.forEach((body, i) => {
      for (let k = 0; k < 3; k++) m.body_ipos[body * 3 + k] = b.ipos[i][k] + (p ? p.com[i][k] : 0);
    });
    this.dofAdr.forEach((d, j) => {
      m.dof_armature[d] = b.armature[j] * (p ? p.armature[j] : 1);
      m.dof_frictionloss[d] = b.frictionloss[j] * (p ? p.jointFriction[j] : 1);
      m.dof_damping[d] = b.damping[j] * (p ? p.jointFriction[j] : 1);
    });
    // A servo's gain and torque grow with its supply voltage (BAM: torque ~ V x PWM).
    const v = p ? p.volts / POLLEN.nominalVolts : 1;
    this.actuators.forEach((a, j) => {
      if (a < 0) return;
      m.actuator_gainprm[a * this.nGain] = b.gain[j] * v;
      m.actuator_biasprm[a * this.nBias + 1] = b.bias[j] * v;
      m.actuator_forcerange[a * 2] = b.force[j][0] * v;
      m.actuator_forcerange[a * 2 + 1] = b.force[j][1] * v;
    });
  }

  /** The pollen profile's per-episode values. */
  sampleParams(random, normal) {
    const N = this.N;
    const each = (range) => Array.from({ length: N }, () => uniform(random, range));
    const c = POLLEN.com;
    // IMU tilt: a rotation of up to 6 degrees about a random axis.
    let ax = normal();
    let ay = normal();
    let az = normal();
    const len = Math.hypot(ax, ay, az) || 1;
    [ax, ay, az] = [ax / len, ay / len, az / len];
    const angle = random() * POLLEN.imuTiltDeg * (Math.PI / 180);
    const s = Math.sin(angle);
    const k = 1 - Math.cos(angle);
    const tilt = [
      1 - k * (ay * ay + az * az), -s * az + k * ax * ay, s * ay + k * ax * az,
      s * az + k * ax * ay, 1 - k * (ax * ax + az * az), -s * ax + k * ay * az,
      -s * ay + k * ax * az, s * ax + k * ay * az, 1 - k * (ax * ax + ay * ay),
    ];
    return {
      footFriction: this.footGeoms.map(() => uniform(random, POLLEN.footFriction)),
      trunkMass: uniform(random, POLLEN.trunkMass),
      com: this.comBodies.map(() => [0, 1, 2].map(() => uniform(random, [-c, c]))),
      armature: each(POLLEN.armature),
      jointFriction: each(POLLEN.jointFriction),
      encoderBias: each([-POLLEN.encoderBias, POLLEN.encoderBias]),
      volts: uniform(random, POLLEN.volts),
      delay: POLLEN.delaySteps[0] + Math.floor(random() * (POLLEN.delaySteps[1] - POLLEN.delaySteps[0] + 1)),
      tilt,
      imuLag: random() < 0.5 ? 0 : 1,
    };
  }

  /** A fresh episode slot (its own MjData), reset to the pack's start with seeded noise. */
  episode(seed, options = {}) {
    const mj = this.mj;
    const data = new mj.MjData(this.model);
    const ep = {
      data,
      seed,
      lastAction: new Float32Array(this.N),
      prevAction: new Float32Array(this.N),
      twist: new Float32Array(3),
      head: new Float32Array(4),
      command: new Float32Array(this.control.cmdSize),
      t: 0,
      tipped: 0,
      fallen: false,
      fellAt: -1,
      ret: 0,
      track: 0,
      start: [0, 0],
      pushes: [],
      kicks: [],
      cmdScale: 1,
      noise: options.noise ?? true,
      params: null, // the pollen profile's values for this episode
      obsRandom: null,
      ctrlHistory: [new Float64Array(this.N), new Float64Array(this.N), new Float64Array(this.N)], // now, 1 and 2 steps ago
      imuSeen: new Float32Array(6), // the IMU reading the policy got last step (for its lag)
      velSeen: new Float32Array(this.N), // joint velocities of last step (they reach the policy a step late)
    };
    this.reset(ep);
    return ep;
  }

  reset(ep) {
    const mj = this.mj;
    const s = this.pack.start;
    const d = ep.data;
    d.qpos.set(s.qpos);
    d.qvel.set(s.qvel);
    const random = rng(ep.seed);
    const normal = gaussian(random);
    ep.pushes.length = 0;
    ep.kicks.length = 0;
    if (ep.noise) {
      const qpos = d.qpos;
      const qvel = d.qvel;
      for (let j = 0; j < this.N; j++) {
        qpos[this.qposAdr[j]] += 0.03 * normal();
        qvel[this.dofAdr[j]] += 0.05 * normal();
      }
      if (this.randomize === 'basic') {
        // Two or three shoves of 0.1 s, 0.8-2.5 N sideways or forward.
        const shoves = 2 + Math.floor(random() * 2);
        for (let k = 0; k < shoves; k++) {
          const at = 40 + Math.floor(random() * Math.max(1, this.horizon(400) - 80));
          const angle = random() * Math.PI * 2;
          const force = 0.8 + random() * 1.7;
          ep.pushes.push({ at, until: at + 5, fx: force * Math.cos(angle), fy: force * Math.sin(angle) });
        }
      }
      ep.cmdScale = 0.9 + random() * 0.2;
      if (this.randomize === 'pollen') {
        ep.params = this.sampleParams(random, normal);
        // The trunk's velocity kicked by up to 0.3 m/s (x and y) every 3-6 s (50 control steps a second).
        const dt = this.control.ctrlDt ?? 0.02;
        for (let at = Math.round(uniform(random, POLLEN.pushEvery) / dt); at < 5000; at += Math.round(uniform(random, POLLEN.pushEvery) / dt)) {
          ep.kicks.push({ at, vx: uniform(random, [-POLLEN.pushSpeed, POLLEN.pushSpeed]), vy: uniform(random, [-POLLEN.pushSpeed, POLLEN.pushSpeed]) });
        }
        ep.obsRandom = rng((ep.seed * 2654435761) >>> 0 || 1);
      }
    }
    ep.params = ep.noise && this.randomize === 'pollen' ? ep.params : null;
    mj.mj_forward(this.model, d);
    ep.lastAction.set(s.lastAction);
    ep.prevAction.set(s.lastAction);
    for (const h of ep.ctrlHistory) for (let j = 0; j < this.N; j++) h[j] = this.defaultPose[j] + s.lastAction[j];
    ep.imuSeen.fill(0);
    ep.velSeen.fill(0);
    ep.twist.set(s.twistSmooth);
    ep.head.set(s.headSmooth);
    ep.t = 0;
    ep.tipped = 0;
    ep.fallen = false;
    ep.fellAt = -1;
    ep.ret = 0;
    ep.track = 0;
    ep.start = [d.qpos[this.freeAdr], d.qpos[this.freeAdr + 1]];
  }

  /** Steps available from the recording (episodes longer than that replay its last command). */
  horizon(max) {
    return Math.min(max, this.steps.length);
  }

  /** Writes the 61-value observation for this step into `obs` at `offset`, advancing the command smoothing. */
  observe(ep, obs, offset) {
    const c = this.control;
    const step = this.steps[Math.min(ep.t, this.steps.length - 1)];
    const vx = step[1] * ep.cmdScale;
    const wz = step[2] * ep.cmdScale;
    ep.twist[0] += c.twistAlpha * (vx - ep.twist[0]);
    ep.twist[2] += c.twistAlpha * (wz - ep.twist[2]);
    for (let i = 0; i < 4; i++) ep.head[i] += c.headAlpha * (step[3 + i] - ep.head[i]);
    const cmd = ep.command;
    cmd.fill(0);
    cmd[0] = ep.twist[0];
    cmd[1] = ep.twist[1];
    cmd[2] = ep.twist[2];
    for (let i = 0; i < 4; i++) cmd[3 + i] = ep.head[i];
    const d = ep.data;
    const qpos = d.qpos;
    const qvel = d.qvel;
    const sensors = d.sensordata;
    const N = this.N;
    obs[offset] = sensors[this.gyroAdr];
    obs[offset + 1] = sensors[this.gyroAdr + 1];
    obs[offset + 2] = sensors[this.gyroAdr + 2];
    const f = this.freeAdr;
    const w = qpos[f + 3];
    const x = qpos[f + 4];
    const y = qpos[f + 5];
    const z = qpos[f + 6];
    obs[offset + 3] = -2 * (x * z - w * y);
    obs[offset + 4] = -2 * (y * z + w * x);
    obs[offset + 5] = -(1 - 2 * (x * x + y * y));
    for (let j = 0; j < N; j++) {
      obs[offset + 6 + j] = qpos[this.qposAdr[j]] - this.defaultPose[j];
      obs[offset + 6 + N + j] = qvel[this.dofAdr[j]];
      obs[offset + 6 + 2 * N + j] = ep.lastAction[j];
    }
    for (let k = 0; k < cmd.length; k++) obs[offset + 6 + 3 * N + k] = cmd[k];
    if (ep.params) this.corrupt(ep, obs, offset);
  }

  /** The pollen profile's sensors: a tilted, maybe late, noisy IMU; biased encoders; late joint speeds. */
  corrupt(ep, obs, offset) {
    const p = ep.params;
    const r = ep.obsRandom;
    const u = (a) => (r() * 2 - 1) * a;
    const N = this.N;
    if (ep.t === 0) {
      for (let i = 0; i < 6; i++) ep.imuSeen[i] = obs[offset + i];
      for (let j = 0; j < N; j++) ep.velSeen[j] = obs[offset + 6 + N + j];
    }
    const g0 = p.imuLag ? ep.imuSeen[0] : obs[offset];
    const g1 = p.imuLag ? ep.imuSeen[1] : obs[offset + 1];
    const g2 = p.imuLag ? ep.imuSeen[2] : obs[offset + 2];
    const v0 = p.imuLag ? ep.imuSeen[3] : obs[offset + 3];
    const v1 = p.imuLag ? ep.imuSeen[4] : obs[offset + 4];
    const v2 = p.imuLag ? ep.imuSeen[5] : obs[offset + 5];
    for (let i = 0; i < 6; i++) ep.imuSeen[i] = obs[offset + i];
    const R = p.tilt;
    obs[offset] = R[0] * g0 + R[1] * g1 + R[2] * g2 + u(POLLEN.gyroNoise);
    obs[offset + 1] = R[3] * g0 + R[4] * g1 + R[5] * g2 + u(POLLEN.gyroNoise);
    obs[offset + 2] = R[6] * g0 + R[7] * g1 + R[8] * g2 + u(POLLEN.gyroNoise);
    obs[offset + 3] = R[0] * v0 + R[1] * v1 + R[2] * v2 + u(POLLEN.gravityNoise);
    obs[offset + 4] = R[3] * v0 + R[4] * v1 + R[5] * v2 + u(POLLEN.gravityNoise);
    obs[offset + 5] = R[6] * v0 + R[7] * v1 + R[8] * v2 + u(POLLEN.gravityNoise);
    for (let j = 0; j < N; j++) {
      obs[offset + 6 + j] += p.encoderBias[j] + u(POLLEN.jointPosNoise);
      const now = obs[offset + 6 + N + j];
      obs[offset + 6 + N + j] = ep.velSeen[j] + u(POLLEN.jointVelNoise);
      ep.velSeen[j] = now;
    }
  }

  /**
   * Applies joint targets (offsets from the standing pose), runs one control
   * step of physics and scores it. Returns false once the episode is over.
   */
  act(ep, action) {
    const mj = this.mj;
    const d = ep.data;
    const N = this.N;
    for (let j = 0; j < N; j++) if (!Number.isFinite(action[j])) action[j] = ep.lastAction[j];
    ep.prevAction.set(ep.lastAction);
    ep.lastAction.set(action);
    this.applyModel(ep);
    // Servo commands: now, one and two control steps ago (the pollen profile delays them).
    const history = ep.ctrlHistory;
    history.unshift(history.pop());
    for (let j = 0; j < N; j++) history[0][j] = this.defaultPose[j] + action[j];
    const ctrl = d.ctrl;
    const delay = ep.params ? ep.params.delay : 0;
    for (const k of ep.kicks) {
      if (k.at === ep.t) {
        d.qvel[this.freeDof] += k.vx;
        d.qvel[this.freeDof + 1] += k.vy;
      }
    }
    const xfrc = d.xfrc_applied;
    const b = this.trunkBody;
    let pushing = false;
    for (const p of ep.pushes) {
      if (ep.t >= p.at && ep.t < p.until) {
        xfrc[6 * b] = p.fx;
        xfrc[6 * b + 1] = p.fy;
        pushing = true;
      }
    }
    const decimation = this.control.decimation;
    for (let s = 0; s < decimation; s++) {
      // A command sent `delay` physics steps ago: from this control step, or one or two before.
      const back = Math.min(2, Math.max(0, Math.ceil((delay - s) / decimation)));
      const command = history[back];
      for (let j = 0; j < N; j++) ctrl[j] = command[j];
      mj.mj_step(this.model, d);
    }
    if (pushing) {
      xfrc[6 * b] = 0;
      xfrc[6 * b + 1] = 0;
    }
    ep.t++;
    // Score: stay up, follow the commanded walk, move smoothly.
    const qpos = d.qpos;
    const qvel = d.qvel;
    const f = this.freeAdr;
    const w = qpos[f + 3];
    const x = qpos[f + 4];
    const y = qpos[f + 5];
    const z = qpos[f + 6];
    const gz = -(1 - 2 * (x * x + y * y));
    const tipped = gz > FALL_GZ || qpos[f + 2] < FALL_HEIGHT;
    ep.tipped = tipped ? ep.tipped + 1 : 0;
    if (ep.tipped >= FALL_STEPS) {
      ep.fallen = true;
      ep.fellAt = ep.t;
      ep.ret -= 50;
      return false;
    }
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    const v = this.freeDof;
    const forward = Math.cos(yaw) * qvel[v] + Math.sin(yaw) * qvel[v + 1];
    const turn = qvel[v + 5];
    const ev = forward - ep.twist[0];
    const ew = turn - ep.twist[2];
    const trackV = Math.exp(-(ev * ev) / 0.01);
    const trackW = Math.exp(-(ew * ew) / 0.25);
    let rate = 0;
    for (let j = 0; j < N; j++) {
      const da = action[j] - ep.prevAction[j];
      rate += da * da;
    }
    const wobble = qvel[v + 3] * qvel[v + 3] + qvel[v + 4] * qvel[v + 4];
    ep.track += trackV;
    ep.ret += 1 + trackV + 0.5 * trackW - 0.5 * rate - 0.02 * wobble;
    return true;
  }

  /** Distance the trunk travelled over the floor since the start (m). */
  distance(ep) {
    const q = ep.data.qpos;
    return Math.hypot(q[this.freeAdr] - ep.start[0], q[this.freeAdr + 1] - ep.start[1]);
  }

  /** Trunk position (x, y, z), for trajectories. */
  trunk(ep) {
    const q = ep.data.qpos;
    return [q[this.freeAdr], q[this.freeAdr + 1], q[this.freeAdr + 2]];
  }

  dispose(ep) {
    ep.data.delete();
  }
}
