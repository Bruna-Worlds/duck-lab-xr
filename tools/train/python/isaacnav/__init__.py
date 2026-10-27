# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Duck Lab's camera navigation brain in NVIDIA Isaac Lab 3 (kit-less, Newton), learning from the depth
brain trained in Pollen's mjlab (tools/train/python/ducknav). Run through launch.py, from Isaac Lab's
own environment:

    cd ../trainers/IsaacLab
    uv run python <repo>/tools/train/python/isaacnav/launch.py train --task Ducklab-Nav-Camera-MicroDuck \
        --rl_library rsl_rl --num_envs 256 --checkpoint <ducknav run>/model_549.pt [--viz viser]

See tools/train/README.md, section 10.
"""

import gymnasium as gym

TASK = "Ducklab-Nav-Camera-MicroDuck"

gym.register(
    id=TASK,
    entry_point="isaacnav.env:DuckNavEnv",
    disable_env_checker=True,
    kwargs={
        "env_cfg_entry_point": "isaacnav.env_cfg:DuckNavCameraEnvCfg",
        "rsl_rl_cfg_entry_point": "isaacnav.agents:DuckNavDistillCfg",
    },
)
