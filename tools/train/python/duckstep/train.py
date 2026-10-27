# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Registers ``Ducklab-StepUp-MicroDuck`` beside Pollen's tasks and runs mjlab's own ``train`` on it.

    cd ../trainers/microduck_rl
    uv run python <repo>/tools/train/python/duckstep/train.py --env.scene.num-envs 1024 --agent.max-iterations 1500 \
        --agent.resume True --agent.load-run <shipped warm-start run> --agent.load-checkpoint model_2999.pt \
        --agent.run-name stepup

Everything after the script is mjlab's train command line (resume, robots, rounds, learning rate).
The task is Pollen's rough walking task (``make_microduck_velocity_env_cfg(rough=True)``: its
contacts, solver settings, rewards and randomisation) on different ground: terraces whose steps
grow from 0.5 to 4 cm with the curriculum's rows (terrain.py), mixed with flat ground and Pollen's
1 cm bumpy grid. Runs and checkpoints go under logs/rsl_rl/velocity like Pollen's, so a run can
resume from the shipped brain's warm-start checkpoint (tools/train/python/onnx_to_rslrl.py), and
Pollen's runner exports each checkpoint's ONNX beside it.

Training video: mjlab's `--video True` (with `--video-length` and `--video-interval`, in env steps)
films one duck and its two nearest neighbours. With DUCKSTEP_VIDEO_ENVS=128 it films that many
(the duck it follows and the 127 nearest), at 1920 x 1080 from further back, so the clips show
the crowd training on the terraces (logs/rsl_rl/velocity/<run>/videos/train).
"""

from __future__ import annotations

import os
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mjlab_microduck.tasks as pollen  # noqa: E402  (registers Pollen's tasks and their runner)
from mjlab.managers import CurriculumTermCfg, RewardTermCfg  # noqa: E402
from mjlab.tasks.registry import register_mjlab_task  # noqa: E402
from mjlab.terrains import BoxFlatTerrainCfg, BoxRandomGridTerrainCfg  # noqa: E402
from mjlab.terrains.terrain_generator import TerrainGeneratorCfg  # noqa: E402
from mjlab_microduck.tasks.microduck_velocity_env_cfg import MicroduckRlCfg, make_microduck_velocity_env_cfg  # noqa: E402

from duckstep.mdp import climb_gain, terrace_levels, terrace_reach  # noqa: E402
from duckstep.terrain import TerraceTerrainCfg  # noqa: E402

TASK = "Ducklab-StepUp-MicroDuck"

# Pollen's walker swings its feet to 2 cm; a 3 cm ledge needs more. Run 1 kept 2 cm and learned
# nothing (with a curriculum that never let it near a real step). Run 2 asked for 4 cm at Pollen's
# weights, which are tiny (the swing cost is relative and times the 0.02 s step): the feet still
# peaked at 9 mm. Run 3 weighted both foot-lift terms like a real objective and paid for height:
# feet to 14 mm and 2 cm steps 2 of 8 after 750 rounds, but Pollen's random commands (backwards,
# sideways, standing) sent few episodes out across the rings. Run 4 (from run 3) walks forward and
# pays more for lift and height. This is a climbing skill; the shipped brain keeps every direction.
# Run 5 (from run 4, 500 more rounds) changed nothing: the curriculum promotes a duck only after three
# steps up without a fall, so most trained on terraces of about 1.2 cm and few ever met 2-3 cm. Run 6
# (from run 5) starts the terraces at 1.5 cm: the lowest row is already the height the shipped brain
# trips on, and level 2 is about 2 cm.
SWING_HEIGHT = 0.04
SWING_WEIGHT = -20.0
CLEARANCE = 0.035
CLEARANCE_WEIGHT = -15.0
CLIMB_WEIGHT = 40.0  # per metre of new height in an episode
AIR_TIME_MAX = 0.35
FORWARD = (0.05, 0.35)  # m/s
SIDEWAYS = (-0.08, 0.08)
TURN = (-0.6, 0.6)
STANDING = 0.03
STEPS = (0.015, 0.04)  # m: the terraces' step height, lowest row to highest
VIDEO_ENVS = int(os.environ.get("DUCKSTEP_VIDEO_ENVS", "0"))
VIDEO_DISTANCE = float(os.environ.get("DUCKSTEP_VIDEO_DISTANCE", "3.6"))
# film.py pins the camera to the first duck's starting patch (a reset can send that duck to another one).
FILM_LOOKAT = None


def make_cfg(play: bool = False):
    cfg = make_microduck_velocity_env_cfg(play=play, rough=True)
    cfg.scene.terrain.terrain_generator = TerrainGeneratorCfg(
        size=(4.0, 4.0),
        border_width=10.0,
        num_rows=5 if play else 10,
        num_cols=3,
        curriculum=not play,
        sub_terrains={
            "terrace": TerraceTerrainCfg(proportion=0.6, step_height_range=STEPS),
            "flat": BoxFlatTerrainCfg(proportion=0.2),
            # Pollen's cobbles: 0.45 m cells must not divide the 4 m patch evenly (0.45 x 8 = 3.6).
            "grid": BoxRandomGridTerrainCfg(proportion=0.2, grid_width=0.45, grid_height_range=(0.0, 0.01), platform_width=1.0),
        },
        add_lights=False,
    )
    if not play:
        # Levels by climbing, not by distance (mdp.py).
        cfg.rewards["terrace_reach"] = RewardTermCfg(func=terrace_reach, weight=1e-6)
        cfg.curriculum["terrain_levels"] = CurriculumTermCfg(func=terrace_levels, params={"command_name": "twist"})
    cfg.rewards["foot_swing_height"].params["target_height"] = SWING_HEIGHT
    cfg.rewards["foot_swing_height"].weight = SWING_WEIGHT
    cfg.rewards["foot_clearance"].params["target_height"] = CLEARANCE
    cfg.rewards["foot_clearance"].weight = CLEARANCE_WEIGHT
    if not play:
        cfg.rewards["climb"] = RewardTermCfg(func=climb_gain, weight=CLIMB_WEIGHT)
    cfg.rewards["air_time"].params["threshold_max"] = AIR_TIME_MAX
    twist = cfg.commands["twist"]
    twist.ranges.lin_vel_x, twist.ranges.lin_vel_y, twist.ranges.ang_vel_z = FORWARD, SIDEWAYS, TURN
    twist.rel_standing_envs = STANDING
    cfg.curriculum.pop("standing_envs", None)
    if VIDEO_ENVS > 0 and not play:
        from mjlab.viewer.viewer_config import ViewerConfig

        cfg.viewer = ViewerConfig(
            origin_type=ViewerConfig.OriginType.WORLD,
            distance=VIDEO_DISTANCE,
            elevation=-30.0,
            azimuth=135.0,
            max_extra_envs=VIDEO_ENVS - 1,
            width=1920,
            height=1080,
        )
    return cfg


def _roomy_renderer():
    """mujoco.Renderer keeps 10,000 geoms by default: a crowd of ducks and the terraces need more.
    The camera looks at the filmed duck's patch (its env origin), not the duck, so it holds still
    on the terraces while the crowd there walks, and moves only when that duck changes patch."""
    import mujoco
    from mjlab.viewer.offscreen_renderer import OffscreenRenderer

    update = OffscreenRenderer.update

    def update_on_patch(self, data, debug_vis_callback=None, camera=None):
        origin = FILM_LOOKAT if FILM_LOOKAT is not None else self._scene.env_origins[int(self._cfg.env_idx)].cpu().numpy()
        self._cam.type = mujoco.mjtCamera.mjCAMERA_FREE
        self._cam.lookat[:] = origin
        self._cam.distance = self._cfg.distance
        self._cam.elevation = self._cfg.elevation
        self._cam.azimuth = self._cfg.azimuth
        return update(self, data, debug_vis_callback, camera)

    OffscreenRenderer.update = update_on_patch

    def initialize(self):
        if self._renderer is not None:
            raise RuntimeError("Renderer is already initialized.")
        self._renderer = mujoco.Renderer(model=self._model, height=self._cfg.height, width=self._cfg.width, max_geom=60000)

    OffscreenRenderer.initialize = initialize


register_mjlab_task(
    task_id=TASK,
    env_cfg=make_cfg(),
    play_env_cfg=make_cfg(play=True),
    rl_cfg=deepcopy(MicroduckRlCfg),
    runner_cls=pollen.MicroduckOnPolicyRunner,
)

if __name__ == "__main__":
    from mjlab.scripts.train import main

    if VIDEO_ENVS > 0:
        _roomy_renderer()
    sys.argv = [sys.argv[0], TASK, *sys.argv[1:]]
    sys.exit(main())
