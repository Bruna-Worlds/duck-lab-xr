# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""The camera brain's cross-check: brains drive in rooms rebuilt from a test case, in Isaac Lab (Newton).

Every room is the test case's (its pieces where they were, the layout turned and nudged as in training,
mdp.py), the duck where Pip started and the goal it had. Each brain gets one try per room, as long as an
episode (30 s): it reached the goal, fell, or neither (stuck). The brains drive the same rooms (the same
seed before each one).

    cd ../trainers/IsaacLab
    PYTHONUTF8=1 uv run python <repo>/tools/train/python/isaacnav/drive_check.py --ground <ground.json> \
        --brain shipped=<run>/model_399.pt --brain new=<run>/model_799.pt [--teacher <ducknav model.pt>] \
        [--envs 32] [--out results.json]

Prints one RESULT line per brain (JSON: brain, tries, reached, falls, stuck, seconds) and writes them all to --out.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ground", required=True, help="the training ground (tools/train/lib/ground.mjs, purpose nav)")
    ap.add_argument("--brain", action="append", default=[], help="name=camera brain checkpoint (isaacnav distillation)")
    ap.add_argument("--teacher", default="", help="also drive the depth brain (a ducknav checkpoint), named 'depth brain'")
    ap.add_argument("--envs", type=int, default=32)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    # The rooms: all of them the test case's (read when mdp.py is imported).
    os.environ["DUCKLAB_GROUND"] = args.ground
    os.environ["DUCKLAB_GROUND_SHARE"] = "1.0"
    os.environ["DUCKLAB_GROUND_STARTS"] = "first"  # from where the drive began

    import torch
    from isaaclab.app import launch_simulation
    from isaaclab_tasks.utils import resolve_task_config

    import isaacnav

    cfg, _ = resolve_task_config(isaacnav.TASK, "rsl_rl_cfg_entry_point", overrides=[])
    cfg.scene.num_envs = args.envs
    cfg.observations.policy.tof.params["dropout"] = 0.0  # the app's brain has its sensor
    cfg.events.push_robot = None
    stack = launch_simulation(cfg, {})
    stack.__enter__()
    from isaacnav.env import DuckNavEnv
    from isaacnav.export import build_student

    env = DuckNavEnv(cfg=cfg)
    goal = env.command_manager.get_term("goal")

    brains = []
    for spec in args.brain:
        name, path = spec.split("=", 1)
        student = build_student()
        state = torch.load(path, map_location="cpu", weights_only=False)
        student.load_state_dict(state.get("student_state_dict") or state["actor_state_dict"])
        net = student.as_onnx(verbose=False).to(env.device).eval()
        brains.append((name, lambda o, net=net: net(o["policy"], o["camera"])))
    if args.teacher:
        state = torch.load(args.teacher, map_location=env.device, weights_only=False)["actor_state_dict"]
        layers = [torch.nn.Linear(200, 256), torch.nn.ELU(), torch.nn.Linear(256, 128), torch.nn.ELU(), torch.nn.Linear(128, 64), torch.nn.ELU(), torch.nn.Linear(64, 2)]
        mlp = torch.nn.Sequential(*layers).to(env.device)
        mlp.load_state_dict({k[4:]: v for k, v in state.items() if k.startswith("mlp.")})
        mean, std = state["obs_normalizer._mean"], state["obs_normalizer._std"]
        brains.append(("depth brain", lambda o: mlp((o["teacher"] - mean) / (std + 1e-2))))

    steps = int(args.seconds / 0.1)
    results = []
    for name, brain in brains:
        torch.manual_seed(7)
        obs, _ = env.reset()
        B = env.num_envs
        open_ = torch.ones(B, dtype=torch.bool, device=env.device)  # still on its one try
        reached = torch.zeros(B, dtype=torch.bool, device=env.device)
        fell = torch.zeros(B, dtype=torch.bool, device=env.device)
        when = torch.zeros(B, device=env.device)
        seen = goal.metrics["reached"].clone()
        for i in range(steps):
            with torch.no_grad():
                action = brain(obs)
            obs, _, terminated, truncated, _ = env.step(action)
            now = goal.metrics["reached"]
            got = open_ & ((now - seen) > 0)
            reached |= got
            when = torch.where(got, torch.full_like(when, (i + 1) * 0.1), when)
            open_ &= ~got
            fell |= open_ & terminated
            open_ &= ~(terminated | truncated)
            seen = now.clone()
            if not open_.any():
                break
        n_reached = int(reached.sum())
        row = {
            "brain": name,
            "tries": B,
            "reached": n_reached,
            "falls": int(fell.sum()),
            "stuck": int(B - n_reached - int(fell.sum())),
            "seconds": round(float(when[reached].mean()), 1) if n_reached else None,
        }
        results.append(row)
        print("RESULT " + json.dumps(row), flush=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"ground": args.ground, "engine": "isaaclab", "results": results}, f, indent=1)
    env.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
