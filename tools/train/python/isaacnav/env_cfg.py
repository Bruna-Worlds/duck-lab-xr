# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""``Ducklab-Nav-Camera-MicroDuck``: the navigation brain in Isaac Lab 3, kit-less, on Newton.

NVIDIA's MicroDuck port of Pollen's walking recipe (``isaaclab_tasks.contrib.microduck``) supplies the
robot (its all-collisions USD, BAM servos), the physics settings, the walker's own observations and
randomisation. On top: a room per duck (a floor tile, four walls, up to eight heavy boxes; mdp.py),
the head's distance sensor as a Newton ray cast and the head camera through Newton's Warp renderer,
both at the head's own sensor frames (``tof`` and ``head_camera`` in the USD, as in Pollen's MJCF).

Observation groups:
- ``teacher``: exactly what ducknav's depth brain (mjlab) was trained on, 200 values;
- ``policy`` + ``camera``: the student's, the same 200 values with the distance sensor dark in 30% of
  episodes, plus the camera picture (3 x 36 x 64).
"""

from __future__ import annotations

import os

import isaaclab.envs.mdp as base_mdp
import isaaclab.sim as sim_utils
from isaaclab.assets import RigidObjectCfg, RigidObjectCollectionCfg
from isaaclab.envs import ManagerBasedRLEnvCfg
from isaaclab.managers import EventTermCfg as EventTerm
from isaaclab.managers import ObservationGroupCfg as ObsGroup
from isaaclab.managers import ObservationTermCfg as ObsTerm
from isaaclab.managers import RewardTermCfg as RewTerm
from isaaclab.managers import SceneEntityCfg
from isaaclab.managers import TerminationTermCfg as DoneTerm
from isaaclab.sensors import CameraCfg
from isaaclab.utils import configclass
from isaaclab_assets.robots.microduck import MICRODUCK_ALLCOLLISIONS_CFG
from isaaclab_newton.renderers import NewtonWarpRendererCfg
from isaaclab_newton.sensors.ray_caster import NewtonRaycastSensorCfg
from isaaclab_tasks.contrib.microduck.flat_env_cfg import MicroDuckSceneCfg, MicroDuckVelocityFlatEnvCfg

from isaacnav import mdp

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
WALKER = os.environ.get("DUCKLAB_WALKER", os.path.join(REPO, "public", "policies", "microduck", "walk.onnx"))

HEAD = "{ENV_REGEX_NS}/Robot/Geometry/trunk_base/neck/neck_pitch_1/yaw_roll_motion/jaw_soft"
# The USD's sensor frames on jaw_soft (Pollen's MJCF sites): +x forward, +y left, +z up when standing.
SITE_ROT = (0.0, 0.70710678, 0.0, 0.70710678)  # (x, y, z, w)
TOF_POS = (0.0135, 0.0224086, -0.0733)
# Pollen's head_camera site sits inside the lens housing; the picture starts 3.5 cm out along the view
# axis (the site's +x, the body's -z), past the shell, as the real lens looks through it.
CAMERA_POS = (0.0155, -9.13778e-05, -0.0733 - 0.035)
CAMERA_SIZE = (64, 36)  # 16:9 like the real head camera's stream; Pollen's MJCF camera is 45 degrees tall
CAMERA_FOCAL = 14.25  # mm on a 20.955 mm aperture: 72.7 degrees wide, 45 tall

NAV_DT = 0.1  # 10 Hz decisions
WALK_DT = 0.02  # the walker (and the env step): 50 Hz
REPEAT = round(NAV_DT / WALK_DT)  # walker steps per brain decision

LOW = MicroDuckVelocityFlatEnvCfg()


def _box(size, mass, color, name):
    return RigidObjectCfg(
        prim_path=f"{{ENV_REGEX_NS}}/Room/{name}",
        spawn=sim_utils.CuboidCfg(
            size=size,
            visual_material=sim_utils.PreviewSurfaceCfg(diffuse_color=color, roughness=0.8),
            rigid_props=sim_utils.UsdPhysicsRigidBodyCfg(),
            mass_props=sim_utils.MassCfg(mass=mass),
            collision_props=sim_utils.UsdPhysicsCollisionCfg(),
        ),
        init_state=RigidObjectCfg.InitialStateCfg(pos=(0.0, 0.0, -5.0)),
    )


ROOM_NAMES = (
    "floor",
    "wall_n",
    "wall_s",
    "wall_e",
    "wall_w",
    *(f"box_{i}" for i in range(len(mdp.BOXES))),
    # The test case's pieces (DUCKLAB_GROUND; mdp.py), after the random boxes.
    *(f"tc_{i}" for i in range(len(mdp.TC))),
)


def _room() -> RigidObjectCollectionCfg:
    objects = {"floor": _box((mdp.TILE, mdp.TILE, mdp.FLOOR), 400.0, (0.55, 0.45, 0.35), "floor")}
    for name, size in (("wall_n", mdp.WALL_NS), ("wall_s", mdp.WALL_NS), ("wall_e", mdp.WALL_EW), ("wall_w", mdp.WALL_EW)):
        objects[name] = _box(size, 300.0, (0.85, 0.85, 0.8), name)
    for i, (hx, hy, hz) in enumerate(mdp.BOXES):
        objects[f"box_{i}"] = _box((2 * hx, 2 * hy, 2 * hz), 60.0, (0.6, 0.3, 0.3), f"box_{i}")
    for i, (hx, hy, hz) in enumerate(mdp.TC):
        objects[f"tc_{i}"] = _box((2 * hx, 2 * hy, 2 * hz), 120.0, (0.45, 0.6, 0.8), f"tc_{i}")
    return RigidObjectCollectionCfg(rigid_objects=objects)


@configclass
class DuckNavSceneCfg(MicroDuckSceneCfg):
    robot = MICRODUCK_ALLCOLLISIONS_CFG.replace(prim_path="{ENV_REGEX_NS}/Robot")
    self_collision = None
    room = _room()
    tof = NewtonRaycastSensorCfg(
        prim_path=HEAD,
        offset=NewtonRaycastSensorCfg.OffsetCfg(pos=TOF_POS, rot=SITE_ROT),
        ray_alignment="base",
        pattern_cfg=mdp.TofPatternCfg(),
        max_distance=mdp.TOF_RANGE - mdp.TOF_START,
        update_period=WALK_DT,
        debug_vis=False,
    )
    head_cam = CameraCfg(
        prim_path=HEAD + "/head_cam",
        update_period=NAV_DT,
        width=CAMERA_SIZE[0],
        height=CAMERA_SIZE[1],
        data_types=["rgb"],
        # Without this the camera keeps its start-up pose: it stays where the duck spawned and films it walking off.
        update_latest_camera_pose=True,
        renderer_cfg=NewtonWarpRendererCfg(),
        spawn=sim_utils.PinholeCameraCfg(focal_length=CAMERA_FOCAL, horizontal_aperture=20.955, clipping_range=(0.02, 8.0)),
        offset=CameraCfg.OffsetCfg(pos=CAMERA_POS, rot=SITE_ROT, convention="world"),
    )


@configclass
class ActionsCfg:
    drive = mdp.TwistWalkerActionCfg(
        asset_name="robot",
        walker_path=WALKER,
        low_level_decimation=1,  # the env steps at the walker's rate
        low_level_actions=LOW.actions.joint_pos,
        low_level_observations=LOW.observations.policy,
    )


@configclass
class CommandsCfg:
    goal = mdp.NavGoalCommandCfg(asset_name="robot", debug_vis=True)


def _brain_terms(dropout: float) -> dict:
    return {
        "tof": ObsTerm(func=mdp.tof_frames, params={"sensor_name": "tof", "dropout": dropout}),
        "goal": ObsTerm(func=mdp.goal_obs, params={"command_name": "goal"}),
        "last_action": ObsTerm(func=mdp.last_action),
        "twist": ObsTerm(func=mdp.smoothed_twist),
        "yaw_rate": ObsTerm(func=mdp.yaw_rate),
    }


@configclass
class ObservationsCfg:
    @configclass
    class TeacherCfg(ObsGroup):
        tof = _brain_terms(0.0)["tof"]
        goal = _brain_terms(0.0)["goal"]
        last_action = _brain_terms(0.0)["last_action"]
        twist = _brain_terms(0.0)["twist"]
        yaw_rate = _brain_terms(0.0)["yaw_rate"]

        def __post_init__(self):
            self.enable_corruption = False
            self.concatenate_terms = True

    @configclass
    class PolicyCfg(ObsGroup):
        tof = _brain_terms(0.3)["tof"]
        goal = _brain_terms(0.3)["goal"]
        last_action = _brain_terms(0.3)["last_action"]
        twist = _brain_terms(0.3)["twist"]
        yaw_rate = _brain_terms(0.3)["yaw_rate"]

        def __post_init__(self):
            self.enable_corruption = False
            self.concatenate_terms = True

    @configclass
    class CameraGroupCfg(ObsGroup):
        rgb = ObsTerm(func=mdp.head_camera, params={"sensor_name": "head_cam", "noise": 0.02})

        def __post_init__(self):
            self.enable_corruption = False
            self.concatenate_terms = True

    teacher: TeacherCfg = TeacherCfg()
    policy: PolicyCfg = PolicyCfg()
    camera: CameraGroupCfg = CameraGroupCfg()


_ROBOT = SceneEntityCfg("robot")
_ROOM = SceneEntityCfg("room")


@configclass
class EventsCfg:
    # The walker's own randomisation (NVIDIA's MicroDuck events), minus its spawn.
    foot_friction = LOW.events.foot_friction
    encoder_bias = LOW.events.encoder_bias
    mass_inertia = LOW.events.mass_inertia
    reset_robot_joints = LOW.events.reset_robot_joints
    randomize_com = LOW.events.randomize_com
    randomize_head_com = LOW.events.randomize_head_com
    randomize_joint_friction = LOW.events.randomize_joint_friction
    randomize_armature = LOW.events.randomize_armature
    push_robot = LOW.events.push_robot
    # The room and its colours.
    room = EventTerm(func=mdp.place_room, mode="reset", params={"robot_cfg": _ROBOT, "room_cfg": _ROOM})
    room_colors = EventTerm(func=mdp.room_colors, mode="reset", params={"names": ROOM_NAMES})


# ducknav's rewards per brain step. Isaac Lab multiplies each term by the env step (0.02 s) and the
# env adds five of them: events (progress, arrival, falls) are weighted by 1 / WALK_DT, costs that
# hold for the whole brain step by 1 / NAV_DT.
_E = 1.0 / WALK_DT
_W = 1.0 / NAV_DT


@configclass
class RewardsCfg:
    progress = RewTerm(func=mdp.nav_progress, weight=10.0 * _E, params={"command_name": "goal"})
    reached = RewTerm(func=mdp.nav_reached, weight=5.0 * _E, params={"command_name": "goal"})
    bump = RewTerm(func=mdp.nav_bump, weight=-0.5 * _W, params={"robot_cfg": _ROBOT})
    close = RewTerm(func=mdp.nav_close, weight=-0.2 * _W, params={"sensor_name": "tof"})
    fell = RewTerm(func=base_mdp.is_terminated, weight=-10.0 * _E)
    action_rate = RewTerm(func=mdp.nav_action_rate, weight=-0.05 * _W)
    time = RewTerm(func=mdp.constant, weight=-0.01 * _W)


@configclass
class TerminationsCfg:
    time_out = DoneTerm(func=base_mdp.time_out, time_out=True)
    fell_over = LOW.terminations.fell_over
    nan_state = LOW.terminations.nan_state


@configclass
class DuckNavCameraEnvCfg(ManagerBasedRLEnvCfg):
    sim = LOW.sim
    scene: DuckNavSceneCfg = DuckNavSceneCfg(num_envs=256, env_spacing=mdp.TILE + 0.5)
    observations: ObservationsCfg = ObservationsCfg()
    actions: ActionsCfg = ActionsCfg()
    commands: CommandsCfg = CommandsCfg()
    rewards: RewardsCfg = RewardsCfg()
    terminations: TerminationsCfg = TerminationsCfg()
    events: EventsCfg = EventsCfg()
    nav_repeat: int = REPEAT

    def __post_init__(self):
        self.sim.dt = LOW.sim.dt
        self.decimation = round(WALK_DT / self.sim.dt)  # 4 physics steps: one walker step
        self.episode_length_s = 30.0
        self.sim.use_newton_actuators = True
        self.sim.render_interval = self.decimation
        self.sim.physics_material = self.scene.terrain.physics_material
        # Room bodies resting on the tile add contacts (about 140 per room, measured): far more than the
        # walking task's 16 per duck. Past the cap MJWarp drops contacts and bodies sink through the floor.
        # A test case's pieces (parked or in the room) rest on the tile too.
        self.sim.physics.solver_cfg.nconmax = 192 + 12 * len(mdp.TC)
        self.sim.physics.solver_cfg.njmax = 1024
        self.scene.contact_forces.update_period = self.sim.dt
        self.events.encoder_bias.params["action_name"] = "drive"
        self.sim.visualizer_cfgs = LOW.sim.visualizer_cfgs
        view = os.environ.get("DUCKLAB_VIEW")  # "eye x,y,z;look x,y,z" for the viewer (films)
        if view:
            from isaaclab.visualizers import VisualizerCfg

            eye, look = (tuple(float(v) for v in part.split(",")) for part in view.split(";"))
            self.sim.visualizer_cfgs = VisualizerCfg(eye=eye, lookat=look)

    def play_mode(self):
        super().play_mode()
        self.events.push_robot = None
