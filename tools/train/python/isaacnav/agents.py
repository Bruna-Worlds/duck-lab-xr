# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Runner settings: the camera brain learns from the depth brain (distillation, DAgger style: the
student drives, the teacher says what it would have done), then may go on with PPO."""

from __future__ import annotations

from isaaclab.utils import configclass
from isaaclab_rl.rsl_rl import RslRlCNNModelCfg, RslRlMLPModelCfg
from isaaclab_rl.rsl_rl.distillation_cfg import RslRlDistillationAlgorithmCfg, RslRlDistillationRunnerCfg

# ducknav's brain (tools/train/python/ducknav/train.py): 200 inputs, ELU 256-128-64, 2 outputs.
TEACHER = RslRlMLPModelCfg(
    hidden_dims=[256, 128, 64],
    activation="elu",
    obs_normalization=True,
    distribution_cfg=RslRlMLPModelCfg.GaussianDistributionCfg(init_std=0.6, std_type="scalar"),
)

# The camera brain: a small CNN on the 64 x 36 picture, its features joined to the same 200 values.
STUDENT = RslRlCNNModelCfg(
    hidden_dims=[256, 128, 64],
    activation="elu",
    obs_normalization=True,
    distribution_cfg=RslRlMLPModelCfg.GaussianDistributionCfg(init_std=0.2, std_type="scalar"),
    cnn_cfg=RslRlCNNModelCfg.CNNCfg(
        output_channels=[16, 32, 32],
        kernel_size=[5, 3, 3],
        stride=[2, 2, 2],
        activation="elu",
        flatten=True,
    ),
)


@configclass
class DuckNavDistillCfg(RslRlDistillationRunnerCfg):
    num_steps_per_env = 24
    max_iterations = 300
    save_interval = 25
    experiment_name = "ducklab_nav_camera"
    obs_groups = {"student": ["policy", "camera"], "teacher": ["teacher"]}
    student = STUDENT
    teacher = TEACHER
    algorithm = RslRlDistillationAlgorithmCfg(
        num_learning_epochs=4,
        learning_rate=5.0e-4,
        gradient_length=12,
        max_grad_norm=1.0,
        loss_type="mse",
    )
