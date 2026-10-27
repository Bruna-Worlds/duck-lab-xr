# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""The navigation task's pieces for Isaac Lab 3 (Newton): the same brain contract as ducknav (mjlab).

- ``TwistWalkerAction``: the brain's two numbers become a twist (forward m/s, turn rad/s), smoothed at
  50 Hz like Duck Lab XR's stick, and the frozen shipped walking policy (walk.onnx, 61 -> 14) follows it
  on its own observations (NVIDIA's MicroDuck port of Pollen's recipe: the same 61-wide contract).
- ``place_room``: every episode a walled room of a new size, 3 to 8 heavy boxes in new places and
  yaws, the duck near the middle facing anywhere. Colours change with ``randomize_visual_shape``.
- ``NavGoalCommand``: goals 0.8 to 2.6 m away, clear of the boxes, half of them with something in the
  straight line to them; a new goal follows each one reached.
- ``tof_frames``: the head's VL53L5CX (8 x 8 equal-angle zones over 45 degrees, row 0 the top, column 0
  the sensor's left, 4 m, range noise), the newest three frames first, as ducknav's teacher saw it.
- ``head_camera``: the head camera's colour picture, with a new brightness, contrast and tint per
  episode and noise per frame, channels first for rsl_rl's CNN.
"""

from __future__ import annotations

import math
from dataclasses import MISSING

import torch
from isaaclab.managers import (
    ActionTerm,
    ActionTermCfg,
    CommandTerm,
    CommandTermCfg,
    ManagerTermBase,
    ObservationGroupCfg,
    ObservationManager,
    SceneEntityCfg,
)
from isaaclab.sensors.ray_caster.patterns import PatternBaseCfg
from isaaclab.utils import configclass, instantiate

from ducknav.walker import Walker

# The brain contract (tools/train/python/ducknav/nav_env.py and src/duck/nav-brain.ts).
TWIST_ALPHA = 0.14
VX_FORWARD = 0.25
VX_BACK = 0.1
WZ_MAX = 1.0
# NVIDIA's Newton port walks the shipped walker at about half its command (0.13 m/s for 0.25, 0.21 for
# 0.4; measured with probe_walker.py) where Pollen's mjlab, the app and the real duck follow it. The
# walker is asked for this much more forward speed, capped at its trained 0.4 m/s, so a brain decision
# moves the duck about as fast as it did where the brain learned; the brain still sees its own twist.
WALKER_GAIN_VX = 1.6
WALKER_MAX_VX = 0.4
TOF_RANGE = 4.0
TOF_FRAMES = 3
TOF_ZONES = 8
TOF_FOV_DEG = 45.0
TOF_START = 0.04  # rays start 4 cm out: Newton's ray cast has no self-exclusion, and the head is right there
GOAL_RADIUS = 0.2
GOAL_MIN, GOAL_MAX = 0.8, 2.6
GOAL_CLEARANCE = 0.22
ROOM_MARGIN = 0.3
BLOCKED_SHARE = 0.5
CLOSE = 0.12
BUMP = 0.1  # m from the root to a box's footprint counts as touching it

# The room: a floor tile (its colour is the floor's), four walls, then the boxes. The walls meet without
# crossing (overlapping heavy bodies are shoved apart and open gaps the camera sees through): north and
# south span the room, east and west stand just past their ends and cover them.
FLOOR = 0.02  # tile thickness: the tile rests on the ground plane, its top is the floor
TILE = 6.0
HALF = 2.3  # wall centre lines; the room inside is 4.52 m square
WALL_T = 0.08
WALL_H = 0.4
WALL_NS = (2 * HALF, WALL_T, WALL_H)
WALL_EW = (2 * HALF + 2 * WALL_T + 0.004, WALL_T, WALL_H)
EW_AT = HALF + WALL_T / 2 + 0.001 + WALL_T / 2
INSIDE = HALF - WALL_T / 2
BOXES = (  # half sizes (x, y, z) of the box slots: toys, crates, a bench, a sofa, posts
    (0.075, 0.075, 0.075),
    (0.1, 0.1, 0.12),
    (0.2, 0.15, 0.15),
    (0.2, 0.15, 0.15),
    (0.45, 0.17, 0.22),
    (0.55, 0.3, 0.22),
    (0.04, 0.04, 0.25),
    (0.04, 0.04, 0.25),
    (0.6, 0.04, 0.2),  # partitions
    (0.45, 0.04, 0.2),
)
PARK = (-1.3, 0.0, 1.3)  # along each outside strip, for boxes not in this episode's room
ACTIVE = (3, 8)
SPAWN_CLEAR = 0.45


def yaw_of(quat_xyzw: torch.Tensor) -> torch.Tensor:
    x, y, z, w = quat_xyzw.unbind(-1)
    return torch.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def yaw_quat(yaw: torch.Tensor) -> torch.Tensor:
    """(x, y, z, w) for a turn about +z."""
    half = yaw / 2
    zero = torch.zeros_like(half)
    return torch.stack([zero, zero, torch.sin(half), torch.cos(half)], dim=-1)


# --- the room ---------------------------------------------------------------------------------------


def room_state(env) -> dict:
    """Per-env layout shared by the event, the goal command, the rewards and the observations."""
    if not hasattr(env, "nav_room"):
        B, N = env.num_envs, len(BOXES)
        env.nav_room = {
            "half": torch.full((B,), INSIDE, device=env.device),
            # x, y, yaw, half x, half y per box slot, world frame; parked boxes sit outside the walls.
            "boxes": torch.zeros(B, N, 5, device=env.device),
            "active": torch.zeros(B, N, dtype=torch.bool, device=env.device),
        }
    return env.nav_room


def clearance(points: torch.Tensor, boxes: torch.Tensor, active: torch.Tensor) -> torch.Tensor:
    """Distance from points [B, K, 2] to the nearest active box footprint, boxes [B, N, 5] (0 inside)."""
    c = boxes[:, None, :, :2]
    cos, sin = torch.cos(boxes[:, None, :, 2]), torch.sin(boxes[:, None, :, 2])
    d = points[:, :, None, :] - c
    qx = (d[..., 0] * cos + d[..., 1] * sin).abs() - boxes[:, None, :, 3]
    qy = (-d[..., 0] * sin + d[..., 1] * cos).abs() - boxes[:, None, :, 4]
    out = torch.stack([qx.clamp(min=0), qy.clamp(min=0)], dim=-1).norm(dim=-1)
    out = torch.where(active[:, None, :], out, torch.full_like(out, 1e3))
    return out.min(dim=-1).values


def place_room(env, env_ids: torch.Tensor | None, robot_cfg: SceneEntityCfg, room_cfg: SceneEntityCfg) -> None:
    """A new room for each env: walls at a new size, boxes in new places, the duck near the middle."""
    dev = env.device
    if env_ids is None or isinstance(env_ids, slice):
        env_ids = torch.arange(env.num_envs, device=dev)[env_ids if isinstance(env_ids, slice) else slice(None)]
    env_ids = torch.as_tensor(env_ids, device=dev, dtype=torch.long)
    n = env_ids.numel()
    if n == 0:
        return
    state = room_state(env)
    robot = env.scene[robot_cfg.name]
    room = env.scene[room_cfg.name]
    origin = env.scene.env_origins[env_ids]
    half = torch.full((n,), INSIDE, device=dev)

    # The duck: near the middle, any heading, standing on the tile.
    spawn = origin[:, :2] + (torch.rand(n, 2, device=dev) * 2 - 1) * 0.3
    yaw = (torch.rand(n, device=dev) * 2 - 1) * math.pi
    z0 = robot.cfg.init_state.pos[2]
    pose = torch.cat([spawn, torch.full((n, 1), z0 + FLOOR, device=dev), yaw_quat(yaw)], dim=-1)
    robot.write_root_pose_to_sim_index(root_pose=pose, env_ids=env_ids)
    robot.write_root_velocity_to_sim_index(root_velocity=torch.zeros(n, 6, device=dev), env_ids=env_ids)

    # The tile and the walls.
    N = len(BOXES)
    poses = torch.zeros(n, 5 + N, 7, device=dev)
    poses[..., 6] = 1.0
    poses[:, 0, :2] = origin[:, :2]
    poses[:, 0, 2] = FLOOR / 2
    for i, (sx, sy, along) in enumerate(((0, 1, 0.0), (0, -1, 0.0), (1, 0, math.pi / 2), (-1, 0, math.pi / 2))):
        poses[:, 1 + i, 0] = origin[:, 0] + sx * (HALF if i < 2 else EW_AT)
        poses[:, 1 + i, 1] = origin[:, 1] + sy * (HALF if i < 2 else EW_AT)
        poses[:, 1 + i, 2] = FLOOR + WALL_H / 2 + 0.0005
        poses[:, 1 + i, 3:] = yaw_quat(torch.full((n,), along, device=dev))

    # The boxes: each active one tries 16 spots in the room, clear of the duck and of earlier boxes.
    count = torch.randint(ACTIVE[0], ACTIVE[1] + 1, (n,), device=dev)
    rank = torch.rand(n, N, device=dev).argsort(dim=1).argsort(dim=1)
    active = rank < count[:, None]
    boxes = torch.zeros(n, N, 5, device=dev)
    placed = torch.zeros(n, N, dtype=torch.bool, device=dev)
    rows = torch.arange(n, device=dev)
    K = 16
    for j, (hx, hy, hz) in enumerate(BOXES):
        r = math.hypot(hx, hy)
        lim = (half - r - 0.05).clamp(min=0.1)
        cand = origin[:, None, :2] + (torch.rand(n, K, 2, device=dev) * 2 - 1) * lim[:, None, None]
        cyaw = (torch.rand(n, K, device=dev) * 2 - 1) * math.pi
        ok = (cand - spawn[:, None, :]).norm(dim=-1) > SPAWN_CLEAR + r
        if j:
            prev_r = (boxes[:, :j, 3] ** 2 + boxes[:, :j, 4] ** 2).sqrt()
            gap = (cand[:, :, None, :] - boxes[:, None, :j, :2]).norm(dim=-1) - prev_r[:, None, :] - r
            ok &= ((gap > 0.12) | ~placed[:, None, :j]).all(dim=-1)
        found = ok.any(dim=1)
        pick = ok.float().argmax(dim=1)
        use = active[:, j] & found
        at = cand[rows, pick]
        ya = cyaw[rows, pick]
        # Parked: in the strip between the walls and the tile's edge, the long side along it.
        side, slot = j % 4, PARK[j // 4]
        out = (EW_AT + WALL_T / 2 + TILE / 2) / 2 + 0.02
        if side < 2:
            park = torch.stack([origin[:, 0] + slot, origin[:, 1] + out * (1 if side == 0 else -1)], dim=-1)
            park_yaw = 0.0
        else:
            park = torch.stack([origin[:, 0] + out * (1 if side == 2 else -1), origin[:, 1] + slot], dim=-1)
            park_yaw = math.pi / 2
        at = torch.where(use[:, None], at, park)
        ya = torch.where(use, ya, torch.full_like(ya, park_yaw))
        boxes[:, j] = torch.stack([at[:, 0], at[:, 1], ya, torch.full_like(ya, hx), torch.full_like(ya, hy)], dim=-1)
        placed[:, j] = use
        poses[:, 5 + j, :2] = at
        poses[:, 5 + j, 2] = FLOOR + hz + 0.001
        poses[:, 5 + j, 3:] = yaw_quat(ya)
    state["boxes"][env_ids] = boxes
    state["active"][env_ids] = placed
    room.write_body_pose_to_sim_index(body_poses=poses, env_ids=env_ids)
    room.write_body_velocity_to_sim_index(body_velocities=torch.zeros(n, 5 + N, 6, device=dev), env_ids=env_ids)


# --- the walker under the brain ---------------------------------------------------------------------


class TwistWalkerAction(ActionTerm):
    cfg: "TwistWalkerActionCfg"

    def __init__(self, cfg: "TwistWalkerActionCfg", env):
        super().__init__(cfg, env)
        B, dev = self.num_envs, self.device
        self.robot = env.scene[cfg.asset_name]
        self.walker = Walker(cfg.walker_path).to(dev)
        self._raw = torch.zeros(B, 2, device=dev)
        self.clipped = torch.zeros(B, 2, device=dev)  # this step's action: the brain's lastAction input
        self.previous = torch.zeros(B, 2, device=dev)  # the step before, for the action-rate cost
        self.target = torch.zeros(B, 2, device=dev)
        self.twist = torch.zeros(B, 2, device=dev)  # smoothed (forward, turn)
        self._command = torch.zeros(B, 3, device=dev)  # (vx, vy, wz) as the walker reads it
        self._head = torch.zeros(B, 4, device=dev)
        self._body = torch.zeros(B, 6, device=dev)
        self.walker_obs = torch.zeros(B, self.walker.obs_size, device=dev)
        self._low_term: ActionTerm = instantiate(cfg.low_level_actions, env)
        self.low_actions = torch.zeros(B, self._low_term.action_dim, device=dev)

        # The walker's own observations, built on first use (NVIDIA's encoder-bias term looks this action up
        # by name through the action manager, which does not exist while its terms are being made).
        obs = cfg.low_level_observations
        obs.joint_pos.params["action_name"] = cfg.term_name
        obs.actions.func = lambda _env: self.low_actions
        obs.actions.params = {}
        obs.velocity_commands.func = lambda _env: self._command
        obs.velocity_commands.params = {}
        obs.head_pose_commands.func = lambda _env: self._head
        obs.head_pose_commands.params = {}
        obs.body_pose_commands.func = lambda _env: self._body
        obs.body_pose_commands.params = {}
        self._low_obs_cfg = obs
        self._low_obs: ObservationManager | None = None
        self._counter = 0

    @property
    def encoder_bias(self) -> torch.Tensor:
        """The walker's joint-encoder calibration error (NVIDIA's randomize_encoder_bias writes it)."""
        return self._low_term.encoder_bias

    @property
    def action_dim(self) -> int:
        return 2

    @property
    def raw_actions(self) -> torch.Tensor:
        return self._raw

    @property
    def processed_actions(self) -> torch.Tensor:
        return self.target

    def process_actions(self, actions: torch.Tensor) -> None:
        self.previous[:] = self.clipped
        self._raw[:] = actions
        self.clipped[:] = actions.clamp(-1.0, 1.0)
        a = self.clipped
        self.target[:, 0] = torch.where(a[:, 0] >= 0, a[:, 0] * VX_FORWARD, a[:, 0] * VX_BACK)
        self.target[:, 1] = a[:, 1] * WZ_MAX

    def apply_actions(self) -> None:
        if self._counter % self.cfg.low_level_decimation == 0:
            self.twist += TWIST_ALPHA * (self.target - self.twist)
            self._command[:, 0] = (self.twist[:, 0] * WALKER_GAIN_VX).clamp(-WALKER_MAX_VX, WALKER_MAX_VX)
            self._command[:, 2] = self.twist[:, 1]
            if self._low_obs is None:
                self._low_obs = ObservationManager({"walker": self._low_obs_cfg}, self._env)
            obs = self._low_obs.compute_group("walker")
            self.walker_obs[:] = obs
            self.low_actions[:] = self.walker(obs)
            self._low_term.process_actions(self.low_actions)
            self._counter = 0
        self._low_term.apply_actions()
        self._counter += 1

    def reset(self, env_ids=None) -> None:
        ids = slice(None) if env_ids is None else env_ids
        for t in (self._raw, self.clipped, self.previous, self.target, self.twist, self._command, self.low_actions, self.walker_obs):
            t[ids] = 0.0
        self._low_term.reset(env_ids)
        if self._low_obs is not None:
            self._low_obs.reset(env_ids)


@configclass
class TwistWalkerActionCfg(ActionTermCfg):
    class_type: type = TwistWalkerAction
    asset_name: str = "robot"
    term_name: str = "drive"
    walker_path: str = MISSING
    low_level_decimation: int = 4
    low_level_actions: ActionTermCfg = MISSING
    low_level_observations: ObservationGroupCfg = MISSING


# --- goals ------------------------------------------------------------------------------------------


class NavGoalCommand(CommandTerm):
    """A goal point on the floor; the command is its (x, y) in the world. Drawn at reset and after each arrival."""

    cfg: "NavGoalCommandCfg"

    def __init__(self, cfg: "NavGoalCommandCfg", env):
        super().__init__(cfg, env)
        self.robot = env.scene[cfg.asset_name]
        self.goal = torch.zeros(self.num_envs, 2, device=self.device)
        self.metrics["reached"] = torch.zeros(self.num_envs, device=self.device)
        self.metrics["blocked"] = torch.zeros(self.num_envs, device=self.device)
        self.version = torch.zeros(self.num_envs, dtype=torch.long, device=self.device)

    @property
    def command(self) -> torch.Tensor:
        return self.goal

    def distance(self) -> torch.Tensor:
        return (self.goal - self.robot.data.root_pos_w.torch[:, :2]).norm(dim=-1)

    def _update_metrics(self) -> None:
        pass

    def _resample_command(self, env_ids) -> None:
        ids = torch.arange(self.num_envs, device=self.device)[env_ids] if isinstance(env_ids, slice) else torch.as_tensor(env_ids, device=self.device)
        n = ids.numel()
        if n == 0:
            return
        state = room_state(self._env)
        origin = self._env.scene.env_origins[ids, :2]
        here = self.robot.data.root_pos_w.torch[ids, :2]
        boxes, active = state["boxes"][ids], state["active"][ids]
        K = 24
        half = (state["half"][ids] - ROOM_MARGIN)[:, None, None]
        cand = origin[:, None, :] + (torch.rand(n, K, 2, device=self.device) * 2 - 1) * half
        dist = (cand - here[:, None, :]).norm(dim=-1)
        ok = (dist > GOAL_MIN) & (dist < GOAL_MAX) & (clearance(cand, boxes, active) > GOAL_CLEARANCE)
        # Something in the straight line: the clearance along it, sampled, dips below a duck's half width.
        steps = torch.linspace(0.15, 0.85, 8, device=self.device)
        line = here[:, None, None, :] + (cand - here[:, None, :])[:, :, None, :] * steps[None, None, :, None]
        blocked = clearance(line.reshape(n, K * 8, 2), boxes, active).reshape(n, K, 8).min(dim=-1).values < 0.08
        want = torch.rand(n, 1, device=self.device) < BLOCKED_SHARE
        score = torch.where(ok, 1.0 + torch.rand_like(dist) + 2.0 * (blocked == want).float(), clearance(cand, boxes, active) / 10.0)
        pick = score.argmax(dim=1)
        rows = torch.arange(n, device=self.device)
        self.goal[ids] = cand[rows, pick]
        self.metrics["blocked"][ids] = blocked[rows, pick].float()
        self.version[ids] += 1

    def _update_command(self) -> None:
        # Arrivals were rewarded this step (rewards run before commands); the next goal follows.
        reached = (self.distance() < GOAL_RADIUS).nonzero(as_tuple=False).flatten()
        if reached.numel():
            self.metrics["reached"][reached] += 1.0
            self._resample(reached)

    def _set_debug_vis_impl(self, debug_vis: bool) -> None:
        if debug_vis and not hasattr(self, "_marker"):
            from isaaclab.markers import VisualizationMarkers
            from isaaclab.markers.config import FRAME_MARKER_CFG

            cfg = FRAME_MARKER_CFG.replace(prim_path="/Visuals/NavGoal")
            cfg.markers["frame"].scale = (0.15, 0.15, 0.15)
            self._marker = VisualizationMarkers(cfg)
        if hasattr(self, "_marker"):
            self._marker.set_visibility(debug_vis)

    def _debug_vis_callback(self, event) -> None:
        if not self.robot.is_initialized or not hasattr(self, "_marker"):
            return
        at = torch.cat([self.goal, torch.full((self.num_envs, 1), FLOOR + 0.05, device=self.device)], dim=-1)
        self._marker.visualize(translations=at)


@configclass
class NavGoalCommandCfg(CommandTermCfg):
    class_type: type = NavGoalCommand
    asset_name: str = "robot"
    resampling_time_range: tuple[float, float] = (1.0e9, 1.0e9)


# --- the head's sensors -----------------------------------------------------------------------------


def tof_pattern(cfg: "TofPatternCfg", device: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Pollen's sim/tof.py zones: equal angles, row 0 the top, column 0 the left; +x forward, +y left, +z up."""
    half = math.radians(cfg.fov_deg) / 2
    edges = torch.linspace(-half, half, cfg.zones + 1)
    centres = (edges[:-1] + edges[1:]) / 2
    el = (-centres)[:, None].expand(cfg.zones, cfg.zones)
    az = (-centres)[None, :].expand(cfg.zones, cfg.zones)
    dirs = torch.stack([torch.cos(el) * torch.cos(az), torch.cos(el) * torch.sin(az), torch.sin(el)], dim=-1).reshape(-1, 3)
    return (dirs * cfg.start).to(device), dirs.to(device)


@configclass
class TofPatternCfg(PatternBaseCfg):
    func: object = tof_pattern
    zones: int = TOF_ZONES
    fov_deg: float = TOF_FOV_DEG
    start: float = TOF_START


def tof_distances(env, sensor_name: str = "tof") -> torch.Tensor:
    """One noiseless frame in metres [B, 64], misses as the full range."""
    d = env.scene.sensors[sensor_name].data.ray_distances.torch.reshape(env.num_envs, -1) + TOF_START
    return torch.where(torch.isfinite(d), d, torch.full_like(d, TOF_RANGE)).clamp(max=TOF_RANGE)


class tof_frames(ManagerTermBase):
    """The newest TOF_FRAMES frames first, distance / 4 m, with the sensor's range noise. ``dropout`` is
    the share of episodes in which the sensor reads nothing (all misses), so a student must use its camera."""

    def __init__(self, cfg, env):
        super().__init__(cfg, env)
        self.frames = torch.ones(env.num_envs, TOF_FRAMES, TOF_ZONES * TOF_ZONES, device=env.device)
        self.fresh = torch.ones(env.num_envs, dtype=torch.bool, device=env.device)
        self.blind = torch.zeros(env.num_envs, dtype=torch.bool, device=env.device)
        self.dropout = float(cfg.params.get("dropout", 0.0))

    def reset(self, env_ids=None) -> None:
        ids = slice(None) if env_ids is None else env_ids
        self.fresh[ids] = True
        if self.dropout > 0:
            n = self.blind[ids].numel()
            self.blind[ids] = torch.rand(n, device=self.blind.device) < self.dropout

    def __call__(self, env, sensor_name: str = "tof", dropout: float = 0.0) -> torch.Tensor:
        d = tof_distances(env, sensor_name)
        sigma = 0.003 + 0.02 * d / TOF_RANGE
        d = (d + sigma * torch.randn_like(d)).clamp(0.0, TOF_RANGE) / TOF_RANGE
        d = torch.where(self.blind[:, None], torch.ones_like(d), d)
        self.frames = torch.roll(self.frames, 1, dims=1)
        self.frames[:, 0] = d
        self.frames = torch.where(self.fresh[:, None, None], d[:, None, :].expand_as(self.frames), self.frames)
        self.fresh[:] = False
        return self.frames.flatten(1)


def goal_obs(env, command_name: str = "goal") -> torch.Tensor:
    """Distance / 4 m (max 1), sin and cos of the bearing from the heading (left positive)."""
    term: NavGoalCommand = env.command_manager.get_term(command_name)
    robot = term.robot
    delta = term.goal - robot.data.root_pos_w.torch[:, :2]
    bearing = torch.atan2(delta[:, 1], delta[:, 0]) - yaw_of(robot.data.root_quat_w.torch)
    dist = delta.norm(dim=-1)
    return torch.stack([(dist / TOF_RANGE).clamp(max=1.0), torch.sin(bearing), torch.cos(bearing)], dim=-1)


def _walker_term(env) -> TwistWalkerAction:
    return env.action_manager.get_term("drive")


def last_action(env) -> torch.Tensor:
    return _walker_term(env).clipped


def smoothed_twist(env) -> torch.Tensor:
    return _walker_term(env).twist


def yaw_rate(env) -> torch.Tensor:
    """The gyro's z as the walking policy sees it (its observation 2)."""
    return _walker_term(env).walker_obs[:, 2:3]


class head_camera(ManagerTermBase):
    """The head camera's picture [B, 3, H, W] in 0..1, a new brightness, contrast and tint each episode,
    noise each frame: a camera that changes with the room's light, not one exact renderer."""

    def __init__(self, cfg, env):
        super().__init__(cfg, env)
        B = env.num_envs
        self.gain = torch.ones(B, 1, 1, 1, device=env.device)
        self.tint = torch.ones(B, 3, 1, 1, device=env.device)
        self.contrast = torch.ones(B, 1, 1, 1, device=env.device)
        self.reset()

    def reset(self, env_ids=None) -> None:
        ids = slice(None) if env_ids is None else env_ids
        n = self.gain[ids].shape[0]
        dev = self.gain.device
        self.gain[ids] = torch.empty(n, 1, 1, 1, device=dev).uniform_(0.6, 1.4)
        self.contrast[ids] = torch.empty(n, 1, 1, 1, device=dev).uniform_(0.7, 1.3)
        self.tint[ids] = torch.empty(n, 3, 1, 1, device=dev).uniform_(0.85, 1.15)

    def __call__(self, env, sensor_name: str = "head_cam", noise: float = 0.02) -> torch.Tensor:
        rgb = env.scene.sensors[sensor_name].data.output["rgb"].torch[..., :3]
        x = rgb.permute(0, 3, 1, 2).float() / 255.0
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) * self.contrast + mean
        x = x * self.gain * self.tint
        return (x + noise * torch.randn_like(x)).clamp(0.0, 1.0)


# --- rewards ----------------------------------------------------------------------------------------


class nav_progress(ManagerTermBase):
    """Metres closer to the goal this step (0 on the step a new goal appears)."""

    def __init__(self, cfg, env):
        super().__init__(cfg, env)
        self.prev = torch.zeros(env.num_envs, device=env.device)
        self.version = torch.full((env.num_envs,), -1, dtype=torch.long, device=env.device)

    def reset(self, env_ids=None) -> None:
        self.version[slice(None) if env_ids is None else env_ids] = -1

    def __call__(self, env, command_name: str = "goal") -> torch.Tensor:
        term: NavGoalCommand = env.command_manager.get_term(command_name)
        dist = term.distance()
        same = term.version == self.version
        out = torch.where(same, self.prev - dist, torch.zeros_like(dist))
        self.prev = dist
        self.version = term.version.clone()
        return out


def nav_reached(env, command_name: str = "goal") -> torch.Tensor:
    return (env.command_manager.get_term(command_name).distance() < GOAL_RADIUS).float()


def nav_bump(env, robot_cfg: SceneEntityCfg) -> torch.Tensor:
    state = room_state(env)
    here = env.scene[robot_cfg.name].data.root_pos_w.torch[:, None, :2]
    return (clearance(here, state["boxes"], state["active"])[:, 0] < BUMP).float()


def nav_close(env, sensor_name: str = "tof") -> torch.Tensor:
    return (tof_distances(env, sensor_name).min(dim=-1).values < CLOSE).float()


def nav_action_rate(env) -> torch.Tensor:
    t = _walker_term(env)
    return (t.clipped - t.previous).square().sum(dim=-1)


def constant(env) -> torch.Tensor:
    return torch.ones(env.num_envs, device=env.device)


class room_colors(ManagerTermBase):
    """New colours for each room's floor, walls and boxes, written straight into Newton's shape colours
    (Isaac Lab's randomize_visual_shape addresses articulation links and reaches only a collection's first body)."""

    def __init__(self, cfg, env):
        super().__init__(cfg, env)
        import warp as wp

        model = env.sim.backend_manager.get_model()
        names = list(cfg.params["names"])
        where = {label: i for i, label in enumerate(model.body_label)}
        shape_body = wp.to_torch(model.shape_body).long()
        rows = []
        for e in range(env.num_envs):
            row = []
            for name in names:
                body = where.get(f"/World/envs/env_{e}/Room/{name}")
                if body is None:
                    raise KeyError(f"no Newton body /World/envs/env_{e}/Room/{name}")
                row.append(int((shape_body == body).nonzero()[0, 0]))
            rows.append(row)
        self.shapes = torch.tensor(rows, device=env.device)
        self.colors = wp.to_torch(model.shape_color)
        self.low, self.high = cfg.params.get("low", 0.08), cfg.params.get("high", 0.92)

    def __call__(self, env, env_ids, names, low: float = 0.08, high: float = 0.92) -> None:
        ids = torch.arange(env.num_envs, device=env.device) if env_ids is None or isinstance(env_ids, slice) else env_ids.long()
        shapes = self.shapes[ids]
        self.colors[shapes.flatten()] = torch.empty(shapes.numel(), 3, device=env.device).uniform_(low, high)
