# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Isaac Lab's own train / play commands with Duck Lab's tasks registered first.

    uv run python <repo>/tools/train/python/isaacnav/launch.py train --task Ducklab-Nav-Camera-MicroDuck --rl_library rsl_rl ...
    uv run python <repo>/tools/train/python/isaacnav/launch.py play  --task Ducklab-Nav-Camera-MicroDuck --rl_library rsl_rl ...

Everything after the action is Isaac Lab's command line (``isaaclab train --help``).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import isaacnav  # noqa: E402,F401  (registers the tasks)


def main() -> int:
    action, *argv = sys.argv[1:] or ["--help"]
    from isaaclab_rl.entrypoints import dispatch

    if action == "train":
        return dispatch.run_train_cli(argv)
    if action == "play":
        return dispatch.run_play_cli(argv)
    print(f"unknown action {action!r}: train or play", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
