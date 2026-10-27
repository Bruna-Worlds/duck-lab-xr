# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""The navigation task as rsl_rl sees it: 10 Hz decisions over a 50 Hz frozen walker.

One navigation step: the brain's two numbers become a twist (forward speed, turn rate), smoothed
toward it at 50 Hz exactly as Duck Lab XR smooths the stick (``twistAlpha``), and the shipped
walking policy runs five control steps of Pollen's environment on its own observations. Then the
brain sees:

- the head's time-of-flight sensor, the last three frames (8x8 zones each, distance / 4 m, misses
  as 4 m, with the sensor's range-dependent noise);
- the goal: distance (/ 4 m, clipped) and bearing (sin, cos) in the robot's heading frame;
- its last action, the smoothed twist the walker is following, the gyro's yaw rate.

The critic also gets the true body velocity and the clearance to the nearest obstacle.

Reward: progress toward the goal, a bonus for reaching it (a new goal follows), a cost for every
control step spent touching a wall or obstacle, a small one for any sensor zone closer than 12 cm,
a large cost for falling, and small costs for jerky commands and time. Half the goals are drawn
where something stands in the straight line to them, so the brain practises detours.
"""

from __future__ import annotations

import math

import torch
from rsl_rl.env import VecEnv
from tensordict import TensorDict

DECIMATION = 5  # walker control steps per navigation step: 50 Hz -> 10 Hz
TWIST_ALPHA = 0.14  # Duck Lab XR's twist smoothing per 50 Hz step (control.twistAlpha)
VX_FORWARD = 0.25  # m/s, Duck Lab XR's stick: control.velocity.forward
VX_BACK = 0.1  # m/s, slower than the stick's 0.2 backwards: a navigator rarely needs it
WZ_MAX = 1.0  # rad/s, control.velocity.turn
TOF_RANGE = 4.0
TOF_FRAMES = 3
GOAL_RADIUS = 0.2
GOAL_MIN, GOAL_MAX = 0.8, 2.6  # m from the robot when a goal is drawn
GOAL_CLEARANCE = 0.22  # m between a goal and any obstacle's bounding circle
ROOM_MARGIN = 0.3  # m between a goal and the room's walls
BLOCKED_SHARE = 0.5  # goals drawn with something in the straight line to them
CLOSE = 0.12  # m: a sensor zone nearer than this counts as too close

REWARD = {
    "progress": 10.0,  # per metre closer
    "reached": 5.0,
    "bump": -0.5,  # per navigation step, times the share of its control steps in contact
    "close": -0.2,  # per navigation step with a sensor zone nearer than CLOSE
    "fell": -10.0,
    "action_rate": -0.05,
    "time": -0.01,
}


def _yaw(quat_wxyz: torch.Tensor) -> torch.Tensor:
    w, x, y, z = quat_wxyz.unbind(-1)
    return torch.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


class NavVecEnv(VecEnv):
    def __init__(self, env, walker: torch.nn.Module, room: float):
        self.env = env
        self.walker = walker.to(env.device)
        self.room = room
        self.num_envs = env.num_envs
        self.device = torch.device(env.device)
        self.num_actions = 2
        self.max_episode_length = int(env.max_episode_length) // DECIMATION
        self.cfg = env.cfg
        self.robot = env.scene["robot"]
        self.tof = env.scene.sensors["tof"]
        self.bump = env.scene.sensors["bump"]
        self.twist_term = env.command_manager.get_term("twist")
        self._read_obstacles()

        B = self.num_envs
        self.goal = torch.zeros(B, 2, device=self.device)
        self.prev_dist = torch.zeros(B, device=self.device)
        self.twist = torch.zeros(B, 2, device=self.device)  # smoothed (vx, wz)
        self.last_action = torch.zeros(B, 2, device=self.device)
        self.tof_frames = torch.ones(B, TOF_FRAMES, 64, device=self.device)
        self.goals_reached = torch.zeros(B, device=self.device)

        obs, _ = env.reset()
        self.walker_obs = obs["actor"]
        everyone = torch.arange(B, device=self.device)
        self._new_goals(everyone)
        self._sense()
        self.tof_frames[:] = self.tof_frames[:, :1]

    # --- obstacles and goals ------------------------------------------------------------------------

    def _read_obstacles(self) -> None:
        """Circles (x, y, r) covering every obstacle, from the compiled model: a long box gets a row of them."""
        import mujoco

        m = self.env.sim.mj_model
        rows = []
        for g in range(m.ngeom):
            name = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, g) or ""
            if not name.startswith("obstacle_"):
                continue
            x, y = (float(v) for v in m.geom_pos[g][:2])
            size = m.geom_size[g]
            if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_CYLINDER:
                rows.append((x, y, float(size[0])))
                continue
            w, _, _, qz = (float(v) for v in m.geom_quat[g])
            yaw = 2 * math.atan2(qz, w)
            hx, hy = float(size[0]), float(size[1])
            long_, short = (hx, hy) if hx >= hy else (hy, hx)
            ax, ay = (math.cos(yaw), math.sin(yaw)) if hx >= hy else (-math.sin(yaw), math.cos(yaw))
            k = max(1, math.ceil(long_ / max(short, 0.05)))
            for i in range(k):
                u = -long_ + (2 * i + 1) * long_ / k
                rows.append((x + ax * u, y + ay * u, math.hypot(long_ / k, short)))
        self.obstacles = torch.tensor(rows or [(1e6, 1e6, 0.0)], device=self.device)

    def _clearance(self, points: torch.Tensor) -> torch.Tensor:
        """Distance from points [..., 2] to the nearest obstacle's bounding circle."""
        d = torch.cdist(points.reshape(-1, 2), self.obstacles[:, :2]) - self.obstacles[:, 2]
        return d.min(dim=-1).values.reshape(points.shape[:-1])

    def _new_goals(self, ids: torch.Tensor) -> None:
        if ids.numel() == 0:
            return
        origin = self.env.scene.env_origins[ids, :2]
        here = self.robot.data.root_link_pos_w[ids, :2]
        k = 24
        half = self.room / 2 - ROOM_MARGIN
        cand = origin[:, None, :] + (torch.rand(ids.numel(), k, 2, device=self.device) * 2 - 1) * half
        dist = (cand - here[:, None, :]).norm(dim=-1)
        ok = (dist > GOAL_MIN) & (dist < GOAL_MAX) & (self._clearance(cand) > GOAL_CLEARANCE)
        # Something in the straight line: the clearance along it, sampled, dips below a duck's half width.
        steps = torch.linspace(0.15, 0.85, 8, device=self.device)
        line = here[:, None, None, :] + (cand - here[:, None, :])[:, :, None, :] * steps[None, None, :, None]
        blocked = self._clearance(line).min(dim=-1).values < 0.08
        want = torch.rand(ids.numel(), 1, device=self.device) < BLOCKED_SHARE
        # An acceptable candidate (a blocked one when this goal should be), else the clearest one.
        score = torch.where(ok, 1.0 + torch.rand_like(dist) + 2.0 * (blocked == want).float(), self._clearance(cand) / 10.0)
        pick = score.argmax(dim=1)
        self.goal[ids] = cand[torch.arange(ids.numel(), device=self.device), pick]
        self.prev_dist[ids] = (self.goal[ids] - here).norm(dim=-1)

    # --- sensing ------------------------------------------------------------------------------------

    def _sense(self) -> None:
        # mjlab's pinhole rows run bottom to top; the sensor's run top to bottom.
        d = self.tof.data.distances.reshape(-1, 8, 8).flip(1).reshape(-1, 64)
        d = torch.where(d < 0, torch.full_like(d, TOF_RANGE), d)
        sigma = 0.003 + 0.02 * d / TOF_RANGE
        d = (d + sigma * torch.randn_like(d)).clamp(0.0, TOF_RANGE)
        self.tof_frames = torch.roll(self.tof_frames, 1, dims=1)
        self.tof_frames[:, 0] = d / TOF_RANGE

    def _goal_obs(self) -> torch.Tensor:
        pos = self.robot.data.root_link_pos_w[:, :2]
        yaw = _yaw(self.robot.data.root_link_quat_w)
        delta = self.goal - pos
        bearing = torch.atan2(delta[:, 1], delta[:, 0]) - yaw
        dist = delta.norm(dim=-1)
        return torch.stack([(dist / TOF_RANGE).clamp(max=1.0), torch.sin(bearing), torch.cos(bearing)], dim=-1)

    def _observations(self) -> TensorDict:
        yaw_rate = self.walker_obs[:, 2:3]
        actor = torch.cat([self.tof_frames.flatten(1), self._goal_obs(), self.last_action, self.twist, yaw_rate], dim=-1)
        vel = self.robot.data.root_link_lin_vel_b[:, :2]
        clear = self._clearance(self.robot.data.root_link_pos_w[:, :2]).clamp(max=2.0)[:, None]
        critic = torch.cat([actor, vel, self.robot.data.root_link_ang_vel_b[:, 2:3], clear], dim=-1)
        return TensorDict({"actor": actor, "critic": critic}, batch_size=[self.num_envs])

    # --- VecEnv -------------------------------------------------------------------------------------

    @property
    def episode_length_buf(self) -> torch.Tensor:
        return self.env.episode_length_buf // DECIMATION

    @episode_length_buf.setter
    def episode_length_buf(self, value: torch.Tensor) -> None:
        self.env.episode_length_buf = value * DECIMATION

    def get_observations(self) -> TensorDict:
        return self._observations()

    def step(self, action: torch.Tensor):
        a = action.clamp(-1.0, 1.0)
        target = torch.stack([torch.where(a[:, 0] >= 0, a[:, 0] * VX_FORWARD, a[:, 0] * VX_BACK), a[:, 1] * WZ_MAX], dim=-1)
        B = self.num_envs
        fell = torch.zeros(B, dtype=torch.bool, device=self.device)
        timed_out = torch.zeros(B, dtype=torch.bool, device=self.device)
        restarted = torch.zeros(B, dtype=torch.bool, device=self.device)
        touching = torch.zeros(B, device=self.device)
        command = self.twist_term.vel_command_b
        for _ in range(DECIMATION):
            self.twist += TWIST_ALPHA * (target - self.twist)
            command[:, 0] = self.twist[:, 0]
            command[:, 1] = 0.0
            command[:, 2] = self.twist[:, 1]
            obs, _, terminated, truncated, _ = self.env.step(self.walker(self.walker_obs))
            self.walker_obs = obs["actor"]
            touching += (self.bump.data.found.reshape(B, -1) > 0).any(dim=-1).float()
            done = terminated | truncated
            if done.any():
                ids = done.nonzero(as_tuple=False).flatten()
                fell[ids] |= terminated[ids]
                timed_out[ids] |= truncated[ids] & ~terminated[ids]
                restarted[ids] = True
                self.twist[ids] = 0.0
                self.last_action[ids] = 0.0
                self._new_goals(ids)
        self._sense()

        here = self.robot.data.root_link_pos_w[:, :2]
        dist = (self.goal - here).norm(dim=-1)
        progress = torch.where(restarted, torch.zeros_like(dist), self.prev_dist - dist)
        reached = (dist < GOAL_RADIUS) & ~restarted
        bumped = touching / DECIMATION
        close = (self.tof_frames[:, 0].min(dim=-1).values * TOF_RANGE < CLOSE).float()
        rate = (a - self.last_action).square().sum(dim=-1)
        reward = (
            REWARD["progress"] * progress
            + REWARD["reached"] * reached.float()
            + REWARD["bump"] * bumped
            + REWARD["close"] * close
            + REWARD["fell"] * fell.float()
            + REWARD["action_rate"] * rate
            + REWARD["time"]
        )
        self.prev_dist = dist
        self.goals_reached += reached.float()
        self._new_goals(reached.nonzero(as_tuple=False).flatten())
        self.last_action = torch.where(restarted[:, None], self.last_action, a)

        dones = (fell | timed_out).long()
        extras = {
            "time_outs": timed_out & ~fell,
            "log": {
                "Nav/reached_per_step": reached.float().mean(),
                "Nav/bump_share": bumped.mean(),
                "Nav/close_share": close.mean(),
                "Nav/falls_per_step": fell.float().mean(),
                "Nav/progress_m": progress.mean(),
            },
        }
        return self._observations(), reward, dones, extras

    def close(self) -> None:
        self.env.close()
