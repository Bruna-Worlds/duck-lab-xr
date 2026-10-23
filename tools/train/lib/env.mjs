// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A scenario pack as a training environment: MuJoCo (WebAssembly) running
 * the pack's exact scene (robot, course, scanned room, terrain) with the
 * headset's control loop: 50 Hz policy, 4 physics steps of 5 ms, the same
 * 61-value observation and the recorded commands of the moment the duck
 * struggled. Many episodes run side by side on one compiled model.
 *
 * Episode randomisation (seeded): joint and velocity noise at the start,
 * a few sideways shoves on the trunk, and a little command noise.
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
      cmdScale: 1,
      noise: options.noise ?? true,
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
    if (ep.noise) {
      const qpos = d.qpos;
      const qvel = d.qvel;
      for (let j = 0; j < this.N; j++) {
        qpos[this.qposAdr[j]] += 0.03 * normal();
        qvel[this.dofAdr[j]] += 0.05 * normal();
      }
      // Two or three shoves of 0.1 s, 0.8-2.5 N sideways or forward.
      const shoves = 2 + Math.floor(random() * 2);
      for (let k = 0; k < shoves; k++) {
        const at = 40 + Math.floor(random() * Math.max(1, this.horizon(400) - 80));
        const angle = random() * Math.PI * 2;
        const force = 0.8 + random() * 1.7;
        ep.pushes.push({ at, until: at + 5, fx: force * Math.cos(angle), fy: force * Math.sin(angle) });
      }
      ep.cmdScale = 0.9 + random() * 0.2;
    }
    mj.mj_forward(this.model, d);
    ep.lastAction.set(s.lastAction);
    ep.prevAction.set(s.lastAction);
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
    const ctrl = d.ctrl;
    for (let j = 0; j < N; j++) ctrl[j] = this.defaultPose[j] + action[j];
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
    for (let s = 0; s < this.control.decimation; s++) mj.mj_step(this.model, d);
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
