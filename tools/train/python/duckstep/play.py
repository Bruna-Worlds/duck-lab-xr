# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Plays a step-up checkpoint in mjlab's viewer on terraces of one step height (for films and looks).

    cd ../trainers/microduck_rl
    DUCKSTEP_HEIGHT=0.02 uv run python <repo>/tools/train/python/duckstep/play.py \
        --checkpoint-file <run>/model_N.pt --viewer viser --num-envs 4

Everything after the script is mjlab's play command line. DUCKSTEP_HEIGHT (m) sets every terrace's
steps (default 0.02); the duck walks forward as in step-up training (train.py).
"""

from __future__ import annotations

import os
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import mjlab_microduck.tasks as pollen  # noqa: E402
from mjlab.tasks.registry import register_mjlab_task  # noqa: E402
from mjlab.terrains.terrain_generator import TerrainGeneratorCfg  # noqa: E402
from mjlab_microduck.tasks.microduck_velocity_env_cfg import MicroduckRlCfg  # noqa: E402

from duckstep import train  # noqa: E402  (registers Ducklab-StepUp-MicroDuck)
from duckstep.terrain import TerraceTerrainCfg  # noqa: E402

TASK = "Ducklab-StepUp-Show-MicroDuck"
HEIGHT = float(os.environ.get("DUCKSTEP_HEIGHT", "0.02"))


def make_show_cfg():
    if train.GROUND is not None:
        # The test case's ground at its own heights (DUCKLAB_GROUND), every patch a copy.
        cfg = train.make_ground_cfg(train.GROUND, play=True, scale=(1.0, 1.0))
        cfg.scene.terrain.terrain_generator.num_rows = 2
        cfg.scene.terrain.terrain_generator.num_cols = 2
        cfg.scene.terrain.terrain_generator.border_width = 4.0
        cfg.scene.terrain.terrain_generator.add_lights = True
        cfg.scene.terrain.terrain_generator.sub_terrains = {"ground": cfg.scene.terrain.terrain_generator.sub_terrains["ground"]}
        cfg.scene.terrain.terrain_generator.sub_terrains["ground"].proportion = 1.0
        cfg.scene.terrain.terrain_generator.sub_terrains["ground"].jitter = 0.0
        cfg.scene.terrain.terrain_generator.sub_terrains["ground"].jitter_yaw = 0.0
        return cfg
    cfg = train.make_cfg(play=True)
    cfg.scene.terrain.terrain_generator = TerrainGeneratorCfg(
        size=(4.0, 4.0),
        border_width=4.0,
        num_rows=2,
        num_cols=2,
        curriculum=False,
        sub_terrains={"terrace": TerraceTerrainCfg(proportion=1.0, step_height_range=(HEIGHT, HEIGHT))},
        add_lights=True,
    )
    twist = cfg.commands["twist"]
    twist.ranges.lin_vel_x = (0.2, 0.3)
    twist.ranges.lin_vel_y = (0.0, 0.0)
    twist.ranges.ang_vel_z = (-0.2, 0.2)
    twist.rel_standing_envs = 0.0
    if hasattr(twist, "rel_turn_in_place_envs"):
        twist.rel_turn_in_place_envs = 0.0
    return cfg


register_mjlab_task(task_id=TASK, env_cfg=make_show_cfg(), play_env_cfg=make_show_cfg(), rl_cfg=deepcopy(MicroduckRlCfg), runner_cls=pollen.MicroduckOnPolicyRunner)

if __name__ == "__main__":
    from mjlab.scripts.play import main
    from mjlab.tasks.velocity.mdp import velocity_command

    # The viewer's joystick sliders need every command range to reach 0.1 m/s each way; the show's
    # commands come from the env (forward only), so no sliders.
    velocity_command.UniformVelocityCommand.create_gui = lambda *_a, **_k: None

    sys.argv = [sys.argv[0], TASK, *sys.argv[1:]]
    sys.exit(main())
