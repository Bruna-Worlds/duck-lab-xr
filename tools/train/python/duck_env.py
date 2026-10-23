# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
A Duck Lab XR scenario pack (exported by Duck Lab XR's Connect button or
`node tools/train/replay.mjs <pack> --export <dir>`) as a Gymnasium
environment, with the same control loop, observation, randomisation and
reward as the local trainer (tools/train/lib/env.mjs):

- 50 Hz policy, 4 MuJoCo steps of 5 ms per control step;
- observation (61): gyro 3, projected gravity 3, joint positions minus the
  standing pose 14, joint velocities 14, last action 14, command 13
  (twist 3, head 4, body pose 6), normalised with the policy's own
  normaliser (taken from its ONNX file);
- action (14): joint targets as offsets from the standing pose;
- episode: the pack's start state with noise, the recorded commands, two or
  three shoves on the trunk; it ends on a fall (tipped past 60 degrees or
  trunk on the floor for 5 steps) or at the horizon.

Not run on the machine this was written on (no Python there); the Node
trainer it mirrors is tested.
"""
import json
import math
import os

import gymnasium as gym
import mujoco
import numpy as np

FALL_GZ = -0.5
FALL_HEIGHT = 0.02
FALL_STEPS = 5


class DuckPackEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, pack_dir, horizon=900, normalizer=None, noise=True, flat=False, seed=0):
        xml = open(os.path.join(pack_dir, "scene.xml"), encoding="utf-8").read()
        if flat:
            import re

            xml = re.sub(r'<geom\b[^>]*\bname="course_\d+"[^>]*/>', "", xml)
            xml = xml.replace('file="terrain.bin"', 'nrow="2" ncol="2"')
        cwd = os.getcwd()
        os.chdir(pack_dir)  # meshdir and terrain.bin are relative to the scene
        try:
            self.model = mujoco.MjModel.from_xml_string(xml)
        finally:
            os.chdir(cwd)
        self.data = mujoco.MjData(self.model)
        with open(os.path.join(pack_dir, "state.json"), encoding="utf-8") as f:
            self.state = json.load(f)
        c = self.state["control"]
        self.c = c
        self.steps = self.state["steps"]
        self.horizon = min(horizon, len(self.steps))
        self.default = np.array(c["defaultPose"], np.float32)
        m = self.model
        joint = lambda name: mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, name)
        self.qpos_adr = np.array([m.jnt_qposadr[joint(n)] for n in c["jointNames"]])
        self.dof_adr = np.array([m.jnt_dofadr[joint(n)] for n in c["jointNames"]])
        free = joint(c["freeJoint"])
        self.free = m.jnt_qposadr[free]
        self.free_dof = m.jnt_dofadr[free]
        self.gyro = m.sensor_adr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_SENSOR, c["gyroSensor"])]
        self.trunk = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "trunk_base")
        if normalizer is None:
            normalizer = (np.zeros(61, np.float32), np.ones(61, np.float32))
        self.mean, self.std = normalizer
        self.observation_space = gym.spaces.Box(-np.inf, np.inf, (61,), np.float32)
        self.action_space = gym.spaces.Box(-2.0, 2.0, (14,), np.float32)
        self.noise = noise
        self.rng = np.random.default_rng(seed)
        self.raw = np.zeros(61, np.float32)

    # -- episode --------------------------------------------------------------
    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        s = self.state["start"]
        d = self.data
        mujoco.mj_resetData(self.model, d)
        d.qpos[:] = s["qpos"]
        d.qvel[:] = s["qvel"]
        self.pushes = []
        self.cmd_scale = 1.0
        if self.noise:
            d.qpos[self.qpos_adr] += 0.03 * self.rng.standard_normal(14)
            d.qvel[self.dof_adr] += 0.05 * self.rng.standard_normal(14)
            for _ in range(2 + int(self.rng.integers(0, 2))):
                at = 40 + int(self.rng.integers(0, max(1, self.horizon - 80)))
                angle = self.rng.uniform(0, 2 * math.pi)
                force = self.rng.uniform(0.8, 2.5)
                self.pushes.append((at, at + 5, force * math.cos(angle), force * math.sin(angle)))
            self.cmd_scale = self.rng.uniform(0.9, 1.1)
        mujoco.mj_forward(self.model, d)
        self.last_action = np.array(s["lastAction"], np.float32)
        self.prev_action = self.last_action.copy()
        self.twist = np.array(s["twistSmooth"], np.float32)
        self.head = np.array(s["headSmooth"], np.float32)
        self.t = 0
        self.tipped = 0
        self.start_xy = d.qpos[self.free : self.free + 2].copy()
        return self._observe(), {}

    def _observe(self):
        c = self.c
        step = self.steps[min(self.t, len(self.steps) - 1)]
        vx, wz = step[1] * self.cmd_scale, step[2] * self.cmd_scale
        self.twist[0] += c["twistAlpha"] * (vx - self.twist[0])
        self.twist[2] += c["twistAlpha"] * (wz - self.twist[2])
        self.head += c["headAlpha"] * (np.array(step[3:7], np.float32) - self.head)
        d = self.data
        q, v = d.qpos, d.qvel
        o = self.raw
        o[0:3] = d.sensordata[self.gyro : self.gyro + 3]
        w, x, y, z = q[self.free + 3 : self.free + 7]
        o[3] = -2 * (x * z - w * y)
        o[4] = -2 * (y * z + w * x)
        o[5] = -(1 - 2 * (x * x + y * y))
        o[6:20] = q[self.qpos_adr] - self.default
        o[20:34] = v[self.dof_adr]
        o[34:48] = self.last_action
        o[48:61] = 0
        o[48:51] = self.twist
        o[51:55] = self.head
        return ((o - self.mean) / self.std).astype(np.float32)

    def step(self, action):
        action = np.asarray(action, np.float32)
        d = self.data
        self.prev_action = self.last_action
        self.last_action = action.copy()
        d.ctrl[:14] = self.default + action
        pushing = False
        for at, until, fx, fy in self.pushes:
            if at <= self.t < until:
                d.xfrc_applied[self.trunk, 0:2] = (fx, fy)
                pushing = True
        for _ in range(self.c["decimation"]):
            mujoco.mj_step(self.model, d)
        if pushing:
            d.xfrc_applied[self.trunk, 0:2] = 0
        self.t += 1
        q, v = d.qpos, d.qvel
        w, x, y, z = q[self.free + 3 : self.free + 7]
        gz = -(1 - 2 * (x * x + y * y))
        tipped = gz > FALL_GZ or q[self.free + 2] < FALL_HEIGHT
        self.tipped = self.tipped + 1 if tipped else 0
        if self.tipped >= FALL_STEPS:
            return self._observe(), -50.0, True, False, {"fell": True}
        yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
        fv = self.free_dof
        forward = math.cos(yaw) * v[fv] + math.sin(yaw) * v[fv + 1]
        track_v = math.exp(-((forward - self.twist[0]) ** 2) / 0.01)
        track_w = math.exp(-((v[fv + 5] - self.twist[2]) ** 2) / 0.25)
        rate = float(np.sum((action - self.prev_action) ** 2))
        wobble = v[fv + 3] ** 2 + v[fv + 4] ** 2
        reward = 1 + track_v + 0.5 * track_w - 0.5 * rate - 0.02 * wobble
        truncated = self.t >= self.horizon
        info = {"fell": False}
        if truncated:
            info["distance"] = float(np.hypot(*(q[self.free : self.free + 2] - self.start_xy)))
        return self._observe(), float(reward), False, truncated, info
