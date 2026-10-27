# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Films a step-up checkpoint without a viewer, at the simulation's own pace: mjlab's offscreen renderer, the
camera on the first duck's patch and the crowd round it (as in training, train.py DUCKSTEP_VIDEO_ENVS), on
terraces of one step height (play.py's show task). mjlab's viser viewer runs this scene at about a fifth of
real time on an 8 GB card; this writes every 50 Hz step, so the clip plays at real speed.

    cd ../trainers/microduck_rl
    DUCKSTEP_HEIGHT=0.03 uv run python <repo>/tools/train/python/duckstep/film.py <run>/model_N.pt out.mp4 [--envs 32] [--seconds 14]

A fall ends that duck's episode and it starts again on the middle square, as in training.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import imageio.v2 as imageio  # noqa: E402
import torch  # noqa: E402
from mjlab.envs import ManagerBasedRlEnv  # noqa: E402
from mjlab.rl import RslRlVecEnvWrapper  # noqa: E402
from mjlab.tasks.registry import load_rl_cfg  # noqa: E402
from mjlab.viewer.viewer_config import ViewerConfig  # noqa: E402

from duckstep import play, train  # noqa: E402  (play registers the show task)
import mjlab_microduck.tasks as pollen  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint")
    parser.add_argument("out")
    parser.add_argument("--envs", type=int, default=32)
    parser.add_argument("--seconds", type=float, default=14.0)
    parser.add_argument("--distance", type=float, default=2.8)
    parser.add_argument("--elevation", type=float, default=-26.0)
    parser.add_argument("--azimuth", type=float, default=135.0)
    args = parser.parse_args()

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    cfg = play.make_show_cfg()
    cfg.scene.num_envs = args.envs
    cfg.viewer = ViewerConfig(
        origin_type=ViewerConfig.OriginType.WORLD,
        distance=args.distance,
        elevation=args.elevation,
        azimuth=args.azimuth,
        max_extra_envs=args.envs - 1,
        width=1920,
        height=1080,
    )
    train._roomy_renderer()
    env = ManagerBasedRlEnv(cfg=cfg, device=device, render_mode="rgb_array")
    train.FILM_LOOKAT = env.scene.env_origins[0].cpu().numpy().copy()
    agent_cfg = load_rl_cfg(play.TASK)
    wrapped = RslRlVecEnvWrapper(env, clip_actions=agent_cfg.clip_actions)
    runner = pollen.MicroduckOnPolicyRunner(wrapped, asdict(agent_cfg), device=device)
    runner.load(args.checkpoint, load_cfg={"actor": True}, strict=True, map_location=device)
    policy = runner.get_inference_policy(device=device)

    fps = round(1.0 / env.step_dt)
    steps = int(args.seconds * fps)
    writer = imageio.get_writer(args.out, fps=fps, codec="libx264", quality=8, macro_block_size=8)
    obs = wrapped.get_observations()
    with torch.inference_mode():
        for k in range(steps):
            obs, _, _, _ = wrapped.step(policy(obs))
            writer.append_data(env.render())
            if k % fps == 0:
                print(f"{k / fps:.0f} s", flush=True)
    writer.close()
    env.close()
    what = f"the test case ground {train.GROUND['pack']}" if train.GROUND else f"steps {play.HEIGHT * 100:.1f} cm"
    print(f"FILM {args.out} ({steps} frames, {fps} fps, {args.envs} ducks, {what})")


if __name__ == "__main__":
    main()
