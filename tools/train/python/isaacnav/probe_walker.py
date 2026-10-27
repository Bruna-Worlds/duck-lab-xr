# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Runs a walking ONNX (default: the shipped walk.onnx) in NVIDIA's own MicroDuck flat task and reports falls,
to check that the 61-wide contract really is the same in Isaac Lab's port.

    uv run python <repo>/tools/train/python/isaacnav/probe_walker.py [--walker walk.onnx] [--steps 300] [--envs 16]
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--walker", default=os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "public", "policies", "microduck", "walk.onnx"))
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--envs", type=int, default=16)
    ap.add_argument("--zero", action="store_true", help="hold the default pose instead of running the walker")
    ap.add_argument("--still", action="store_true", help="zero velocity commands")
    ap.add_argument("--vx", type=float, default=None, help="a fixed forward command, m/s")
    args = ap.parse_args()

    import torch
    from isaaclab.app import launch_simulation
    from isaaclab.envs import ManagerBasedRLEnv
    from isaaclab_tasks.utils import resolve_task_config

    from ducknav.walker import Walker

    cfg, _ = resolve_task_config("IsaacContrib-Velocity-Flat-MicroDuck", "rsl_rl_cfg_entry_point", overrides=[])
    cfg.scene.num_envs = args.envs
    cfg.events.push_robot = None
    if args.still:
        cfg.commands.base_velocity.rel_standing_envs = 1.0
    if args.vx is not None:
        r = cfg.commands.base_velocity.ranges
        r.lin_vel_x, r.lin_vel_y, r.ang_vel_z = (args.vx, args.vx), (0.0, 0.0), (0.0, 0.0)
        c = cfg.commands.base_velocity
        c.rel_standing_envs = 0.0
        for name in ("rel_forward_envs", "rel_turn_in_place_envs", "rel_heading_envs"):
            if hasattr(c, name):
                setattr(c, name, 0.0)
        cfg.curriculum = None
    stack = launch_simulation(cfg, {})
    stack.__enter__()
    env = ManagerBasedRLEnv(cfg=cfg)
    walker = Walker(os.path.abspath(args.walker)).to(env.device)
    obs, _ = env.reset()
    robot = env.scene["robot"]
    falls = 0
    for i in range(args.steps):
        o = obs["policy"]
        act = torch.zeros(env.num_envs, 14, device=env.device) if args.zero else walker(o)
        obs, _, terminated, _, _ = env.step(act)
        falls += int(terminated.sum())
        if i == 0:
            print("obs[0] first 20:", [round(v, 3) for v in o[0, :20].tolist()])
            print("obs[0] 20-61:", [round(v, 3) for v in o[0, 20:].tolist()])
            print("action[0]:", [round(v, 3) for v in act[0].tolist()])
        if i % 50 == 49:
            grav = robot.data.projected_gravity_b.torch
            tilt = torch.rad2deg(torch.acos((-grav[:, 2]).clamp(-1, 1)))
            vel = robot.data.root_lin_vel_b.torch[:, 0]
            cmd = env.command_manager.get_command("base_velocity")[:, 0]
            print(f"step {i + 1}: z {robot.data.root_pos_w.torch[:, 2].mean():.3f}, tilt {tilt.mean():.1f} (max {tilt.max():.1f}), vx {vel.mean():.3f} for cmd {cmd.mean():.3f}, falls {falls}")
    print(f"falls per duck per 10 s: {falls / env.num_envs / (args.steps * env.step_dt) * 10:.2f}")
    env.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
