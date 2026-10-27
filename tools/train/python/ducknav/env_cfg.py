# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Pollen's MicroDuck walking environment, set up for navigation.

The robot, its servo model, its observations, randomisation and pushes are microduck_rl's own
(``make_microduck_velocity_env_cfg``), so the shipped walking policy runs exactly as it was trained.
What changes:

- the ground is a grid of walled rooms with obstacles (terrain.py), spawns at a room's centre;
- the twist command is no longer drawn at random: the navigation brain writes it (nav_env.py);
- the head and body pose commands stay at zero, so the head (and its sensor) looks ahead;
- two sensors: the head's VL53L5CX time-of-flight sensor (8x8 zones, 45 degrees, 4 m), as rays
  from a site at Pollen's ``tof`` frame, and a contact sensor for bumping into walls and obstacles.
"""

from __future__ import annotations

import math

import mujoco
import numpy as np
from mjlab.sensor import ContactMatch, ContactSensorCfg, ObjRef, RayCastSensorCfg
from mjlab.sensor.raycast_sensor import PinholeCameraPatternCfg
from mjlab.terrains.terrain_generator import TerrainGeneratorCfg
from mjlab_microduck.tasks.microduck_velocity_env_cfg import make_microduck_velocity_env_cfg

from ducknav.terrain import ObstacleRoomTerrainCfg

TOF_ZONES = 8
TOF_FOV_DEG = 45.0
TOF_RANGE = 4.0
# mjlab's pinhole puts its outer rays on the edge of the field of view; the sensor's zones are
# centred in theirs, so the outer rays go at 7/8 of the half-angle (each ray within 0.4 degrees
# of Pollen's equal-angle model in sim/tof.py).
TOF_PINHOLE_FOVY = 2.0 * TOF_FOV_DEG / 2.0 * (TOF_ZONES - 1) / TOF_ZONES

# Command curricula of the walking task: they would redraw the commands the navigation brain sets.
COMMAND_CURRICULA = ("standing_envs", "head_pose_range", "body_pose_range")


def _add_tof_camera_site(spec: mujoco.MjSpec) -> None:
    """A site at the head's ``tof`` frame, turned so its -z (a camera's forward) is the sensor's +x.

    Pollen's sensor frame: +x forward, +y left, +z up. A MuJoCo camera frame (right-handed): -z
    forward, +x right, +y up. So the camera's axes, in the sensor frame, are x = -y, y = z, z = -x.
    (mjlab's pinhole comment says +y down; its rays are built with +y up, so its row 0 looks down:
    nav_env.py flips the rows to put the top of the frame first, as the real sensor does.)
    """
    tof = spec.site("robot/tof")
    body = tof.parent
    r = np.array([[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])  # columns: camera axes in the sensor frame
    q_r = np.zeros(4)
    mujoco.mju_mat2Quat(q_r, r.flatten())
    q = np.zeros(4)
    mujoco.mju_mulQuat(q, np.array(tof.quat, dtype=float), q_r)
    body.add_site(name="robot/tof_cam", pos=list(tof.pos), quat=list(q), group=3)


def make_nav_env_cfg(num_envs: int = 1024, room: float = 4.0, rows: int = 8, cols: int = 8, episode_s: float = 30.0, seed: int | None = None):
    cfg = make_microduck_velocity_env_cfg(play=False, rough=False)
    cfg.scene.num_envs = num_envs
    cfg.episode_length_s = episode_s

    cfg.scene.terrain.terrain_type = "generator"
    cfg.scene.terrain.terrain_generator = TerrainGeneratorCfg(
        seed=seed,
        size=(room, room),
        border_width=1.0,
        num_rows=rows,
        num_cols=cols,
        curriculum=False,
        sub_terrains={"rooms": ObstacleRoomTerrainCfg(proportion=1.0, size=(room, room))},
        add_lights=False,
    )
    cfg.sim.nconmax = 60  # walls and obstacles add a few contacts to the walking task's 35

    previous = cfg.scene.spec_fn

    def spec_fn(spec: mujoco.MjSpec) -> None:
        if previous is not None:
            previous(spec)
        _add_tof_camera_site(spec)

    cfg.scene.spec_fn = spec_fn

    # Spawn at the room's centre (kept clear), facing anywhere.
    pose = cfg.events["reset_base"].params["pose_range"]
    pose["x"] = (-0.05, 0.05)
    pose["y"] = (-0.05, 0.05)
    pose["yaw"] = (-math.pi, math.pi)

    twist = cfg.commands["twist"]
    twist.resampling_time_range = (1.0e9, 1.0e9)
    for name in ("rel_standing_envs", "rel_heading_envs", "rel_world_envs", "rel_forward_envs", "rel_turn_in_place_envs", "init_velocity_prob"):
        if hasattr(twist, name):
            setattr(twist, name, 0.0)
    twist.heading_command = False
    if hasattr(twist.ranges, "heading"):
        twist.ranges.heading = None
    for name in ("head_pose", "body_pose"):
        pose_cmd = cfg.commands[name]
        pose_cmd.resampling_time_range = (1.0e9, 1.0e9)
        pose_cmd.ranges = tuple((0.0, 0.0) for _ in pose_cmd.ranges)
    for name in COMMAND_CURRICULA:
        cfg.curriculum.pop(name, None)
    # The navigation brain is scored in nav_env.py: the walking task's own rewards, the curricula
    # that weight them and its metrics only cost time on every control step.
    cfg.rewards = {}
    for name in [k for k, c in cfg.curriculum.items() if "reward_name" in (c.params or {})]:
        cfg.curriculum.pop(name)
    if hasattr(cfg, "metrics"):
        cfg.metrics = {}

    cfg.scene.sensors = tuple(cfg.scene.sensors) + (
        RayCastSensorCfg(
            name="tof",
            frame=ObjRef(type="site", name="tof_cam", entity="robot"),
            pattern=PinholeCameraPatternCfg(width=TOF_ZONES, height=TOF_ZONES, fovy=TOF_PINHOLE_FOVY),
            max_distance=TOF_RANGE,
            exclude_parent_body=True,
        ),
        ContactSensorCfg(
            name="bump",
            primary=ContactMatch(mode="subtree", pattern="trunk_base", entity="robot"),
            secondary=ContactMatch(mode="body", pattern="obstacles"),
            fields=("found",),
            reduce="none",
            num_slots=1,
        ),
    )
    return cfg
