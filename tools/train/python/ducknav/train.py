# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Trains the navigation brain over the frozen shipped walker, then exports nav.onnx.

    cd ../trainers/microduck_rl
    uv run python <repo>/tools/train/python/ducknav/train.py --walker <repo>/public/policies/microduck/walk.onnx \
        [--envs 1024] [--iterations 600] [--out logs/ducknav] [--resume <model_N.pt>] [--smoke]

--smoke builds a few rooms, runs a few navigation steps with random actions and prints what the
brain would see, without training. Writes <out>/<stamp>/model_<N>.pt, nav.onnx and nav.json.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import torch  # noqa: E402

from ducknav import nav_env  # noqa: E402
from ducknav.env_cfg import TOF_FOV_DEG, TOF_RANGE, TOF_ZONES, make_nav_env_cfg  # noqa: E402
from ducknav.walker import Walker  # noqa: E402

# Curricula of the walking task at their last stage (Pollen's run counts 24 steps a round; 3,000 rounds).
WALKER_STEP_COUNTER = 72_000


def runner_cfg(iterations: int, steps: int, seed: int) -> dict:
    model = {"hidden_dims": (256, 128, 64), "activation": "elu", "obs_normalization": True, "class_name": "MLPModel"}
    return {
        "seed": seed,
        "num_steps_per_env": steps,
        "max_iterations": iterations,
        "obs_groups": {"actor": ("actor",), "critic": ("critic",)},
        "save_interval": 50,
        "experiment_name": "ducknav",
        "run_name": "ducknav",
        "logger": "tensorboard",
        "class_name": "OnPolicyRunner",
        "actor": {**model, "distribution_cfg": {"class_name": "GaussianDistribution", "init_std": 0.6, "std_type": "scalar"}},
        "critic": {**model, "distribution_cfg": None},
        "algorithm": {
            "num_learning_epochs": 5,
            "num_mini_batches": 4,
            "learning_rate": 3.0e-4,
            "schedule": "adaptive",
            "gamma": 0.99,
            "lam": 0.95,
            "entropy_coef": 0.005,
            "desired_kl": 0.01,
            "max_grad_norm": 1.0,
            "value_loss_coef": 1.0,
            "use_clipped_value_loss": True,
            "clip_param": 0.2,
            "normalize_advantage_per_mini_batch": False,
            "optimizer": "adam",
            "share_cnn_encoders": False,
            "class_name": "PPO",
        },
    }


class NavExport(torch.nn.Module):
    """The trained actor, deterministic, with its output turned into a twist: forward m/s, turn rad/s."""

    def __init__(self, policy):
        super().__init__()
        self.inner = policy.as_onnx(verbose=False)

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        a = self.inner(obs).clamp(-1.0, 1.0)
        vx = torch.where(a[:, :1] >= 0, a[:, :1] * nav_env.VX_FORWARD, a[:, :1] * nav_env.VX_BACK)
        return torch.cat([vx, a[:, 1:2] * nav_env.WZ_MAX], dim=-1)


def export(runner, out: Path, obs_dim: int, walker_path: str) -> None:
    model = NavExport(runner.alg.get_policy()).to("cpu").eval()
    torch.onnx.export(model, (torch.zeros(1, obs_dim),), str(out / "nav.onnx"), input_names=["obs"], output_names=["twist"], opset_version=18, dynamo=False)
    write_layout(out, walker_path, iteration=runner.current_learning_iteration)
    print(f"exported {out / 'nav.onnx'} ({obs_dim} inputs -> twist) and nav.json")


def write_layout(out: Path, walker_path: str, iteration: int = -1) -> None:
    """nav.json: what nav.onnx takes and gives, for the app (src/duck/nav-brain.ts) and other runtimes."""
    layout = {
        "version": "ducklab.nav.v1",
        "rateHz": 50 / nav_env.DECIMATION,
        "obs": [
            {"name": "tof", "size": nav_env.TOF_FRAMES * 64, "about": f"the newest {nav_env.TOF_FRAMES} frames first; each {TOF_ZONES}x{TOF_ZONES} zones, row 0 the top, column 0 the sensor's left; distance / {TOF_RANGE} m, misses = 1"},
            {"name": "goal", "size": 3, "about": f"distance / {TOF_RANGE} m (max 1), sin and cos of the bearing from the robot's heading (left positive)"},
            {"name": "lastAction", "size": 2, "about": "the brain's previous raw output, clipped to [-1, 1] (not the twist)"},
            {"name": "twist", "size": 2, "about": f"the smoothed command the walker follows: forward m/s, turn rad/s (alpha {nav_env.TWIST_ALPHA} per 50 Hz step)"},
            {"name": "yawRate", "size": 1, "about": "the gyro's z, rad/s, as the walking policy sees it"},
        ],
        "output": {"name": "twist", "about": f"target forward m/s (-{nav_env.VX_BACK} to {nav_env.VX_FORWARD}) and turn rad/s (+-{nav_env.WZ_MAX}); smooth it like the stick"},
        "note": "nav.onnx's lastAction input wants the raw clipped action; recover it from the twist output: forward >= 0 ? forward / VX_FORWARD : forward / VX_BACK, turn / WZ_MAX.",
        "tof": {"zones": TOF_ZONES, "fovDeg": TOF_FOV_DEG, "rangeM": TOF_RANGE, "site": "tof"},
        "goalRadiusM": nav_env.GOAL_RADIUS,
        "walker": os.path.basename(walker_path),
        "round": iteration,
    }
    (out / "nav.json").write_text(json.dumps(layout, indent=2) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--walker", required=True)
    ap.add_argument("--envs", type=int, default=1024)
    ap.add_argument("--iterations", type=int, default=600)
    ap.add_argument("--steps", type=int, default=24, help="navigation steps per env per round (2.4 s)")
    ap.add_argument("--room", type=float, default=4.0)
    ap.add_argument("--rows", type=int, default=8)
    ap.add_argument("--cols", type=int, default=8)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="logs/ducknav")
    ap.add_argument("--resume", default=None)
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()

    from mjlab.envs import ManagerBasedRlEnv
    from rsl_rl.runners import OnPolicyRunner

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    cfg = make_nav_env_cfg(num_envs=args.envs, room=args.room, rows=args.rows, cols=args.cols, seed=args.seed)
    started = time.time()
    env = ManagerBasedRlEnv(cfg=cfg, device=device)
    env.common_step_counter = WALKER_STEP_COUNTER
    venv = nav_env.NavVecEnv(env, Walker(args.walker), room=args.room)
    print(f"env: {args.envs} robots, {len(venv.obstacles)} obstacles, built in {time.time() - started:.0f} s")
    obs = venv.get_observations()
    print(f"obs: actor {tuple(obs['actor'].shape)}, critic {tuple(obs['critic'].shape)}")

    if args.smoke:
        t = time.time()
        for i in range(30):
            obs, rew, dones, extras = venv.step(torch.rand(args.envs, 2, device=device) * 2 - 1)
        dt = (time.time() - t) / 30
        tof = venv.tof_frames[0, 0].reshape(8, 8) * TOF_RANGE
        print(f"{dt * 1000:.0f} ms per navigation step ({args.envs * 5 / dt:.0f} walker steps/s)")
        print("robot 0's ToF frame (m), row 0 = top:\n" + "\n".join(" ".join(f"{v:4.2f}" for v in row) for row in tof.tolist()))
        print("goal obs (robot 0):", [round(v, 3) for v in venv._goal_obs()[0].tolist()])
        print("reward mean", float(rew.mean()), "dones", int(dones.sum()), {k: round(float(v), 4) for k, v in extras["log"].items()})
        venv.close()
        return 0

    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out = Path(args.out) / stamp
    out.mkdir(parents=True, exist_ok=True)
    runner = OnPolicyRunner(venv, runner_cfg(args.iterations, args.steps, args.seed), str(out), device)
    if args.resume:
        runner.load(args.resume)
    runner.learn(num_learning_iterations=args.iterations, init_at_random_ep_len=True)
    export(runner, out, obs["actor"].shape[-1], args.walker)
    venv.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
