# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Duck Lab's navigation brain: steers the shipped walking policy with its head's 8x8 depth sensor.

Runs in Pollen's microduck_rl environment (mjlab on MuJoCo-Warp), outside this repository:

    cd ../trainers/microduck_rl
    uv run python <repo>/tools/train/python/ducknav/train.py --walker <repo>/public/policies/microduck/walk.onnx

See tools/train/README.md, section 10.
"""
