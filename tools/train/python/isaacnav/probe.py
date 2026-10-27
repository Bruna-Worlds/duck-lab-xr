# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Steps the navigation env with a fixed brain output and reports whether the walker keeps the duck up,
what the head's distance sensor reads, and a camera frame (PNG).

    uv run python <repo>/tools/train/python/isaacnav/probe.py [--robot all|walk] [--self-collision 0|1]
        [--forward 0.0] [--turn 0.0] [--steps 60] [--envs 8] [--png out.png]
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--robot", default="all")
    ap.add_argument("--self-collision", type=int, default=1)
    ap.add_argument("--forward", type=float, default=0.0, help="raw brain output, -1..1")
    ap.add_argument("--turn", type=float, default=0.0)
    ap.add_argument("--steps", type=int, default=60)
    ap.add_argument("--envs", type=int, default=8)
    ap.add_argument("--png", default="")
    ap.add_argument("--spacing", type=float, default=0.0)
    ap.add_argument("--verbose", type=int, default=0)
    ap.add_argument("--teacher", default="", help="a ducknav checkpoint: the depth brain drives")
    ap.add_argument("--student", default="", help="a camera brain checkpoint (isaacnav): it drives")
    ap.add_argument("--diag", action="store_true", help="print which world each kind of shape is in")
    ap.add_argument("--blind", action="store_true", help="the student's distance sensor reads nothing, every episode: the camera alone")
    ap.add_argument("--frames", default="", help="a folder: save the first 8 ducks' camera pictures each step")
    args = ap.parse_args()

    import torch
    from isaaclab.app import launch_simulation
    from isaaclab_assets.robots.microduck import MICRODUCK_CFG
    from isaaclab_tasks.utils import resolve_task_config

    import isaacnav
    from isaacnav import mdp

    cfg, _ = resolve_task_config(isaacnav.TASK, "rsl_rl_cfg_entry_point", overrides=[])
    cfg.scene.num_envs = args.envs
    if args.blind:
        cfg.observations.policy.tof.params["dropout"] = 1.0
    if args.spacing:
        cfg.scene.env_spacing = args.spacing
    if args.robot == "walk":
        cfg.scene.robot = MICRODUCK_CFG.replace(prim_path="{ENV_REGEX_NS}/Robot")
    cfg.scene.robot.spawn.articulation_props.self_collision_enabled = bool(args.self_collision)
    stack = launch_simulation(cfg, {})
    stack.__enter__()
    from isaacnav.env import DuckNavEnv

    env = DuckNavEnv(cfg=cfg)
    env.reset()
    if args.diag:
        import warp as wp
        from collections import Counter

        model = env.sim.backend_manager.get_model()
        worlds = wp.to_torch(model.shape_world).cpu().tolist()
        flags = wp.to_torch(model.shape_flags).cpu().tolist()
        types = wp.to_torch(model.shape_type).cpu().tolist()
        kinds = {}
        for i, label in enumerate(model.shape_label):
            kind = "robot" if "/Robot/" in label else "room" if "/Room/" in label else "other"
            kinds.setdefault(kind, Counter())[(worlds[i], types[i], flags[i] & 1)] += 1
        for kind, c in kinds.items():
            print(f"{kind}: (world, type, visible) -> count", dict(sorted(c.items())[:12]))
        sample = [l for l in model.shape_label if "/Robot/" in l][:3]
        print("robot shape labels:", sample)
    robot = env.scene["robot"]
    action = torch.tensor([[args.forward, args.turn]], device=env.device).repeat(env.num_envs, 1)
    falls = 0
    brain = None
    if args.teacher:
        state = torch.load(args.teacher, map_location=env.device, weights_only=False)["actor_state_dict"]
        layers = [torch.nn.Linear(200, 256), torch.nn.ELU(), torch.nn.Linear(256, 128), torch.nn.ELU(), torch.nn.Linear(128, 64), torch.nn.ELU(), torch.nn.Linear(64, 2)]
        mlp = torch.nn.Sequential(*layers).to(env.device)
        mlp.load_state_dict({k[4:]: v for k, v in state.items() if k.startswith("mlp.")})
        mean, std = state["obs_normalizer._mean"], state["obs_normalizer._std"]
        brain = lambda o: mlp((o - mean) / (std + 1e-2))
    if args.student:
        # The camera brain (a distillation checkpoint): the student drives, from its camera and sensor.
        from isaacnav.export import build_student

        student = build_student()
        state = torch.load(args.student, map_location="cpu", weights_only=False)
        student.load_state_dict(state.get("student_state_dict") or state["actor_state_dict"])
        net = student.as_onnx(verbose=False).to(env.device).eval()
        brain = lambda o: net(o["policy"], o["camera"])
    obs = env.observation_manager.compute()
    goal = env.command_manager.get_term("goal")
    if args.frames:
        os.makedirs(args.frames, exist_ok=True)
    arrived = 0.0
    seen = goal.metrics["reached"].clone()
    for i in range(args.steps):
        if brain is not None:
            with torch.no_grad():
                action = brain(obs) if args.student else brain(obs["teacher"])
        obs, _, terminated, truncated, _ = env.step(action)
        falls += int(terminated.sum())
        now = goal.metrics["reached"]
        arrived += float((now - seen).clamp(min=0).sum())
        seen = now.clone()
        if args.frames:
            # What the brains see: the first eight ducks' camera pictures, 4 x 2, each 64 x 36 drawn 5 x.
            import numpy as np
            from PIL import Image

            pics = (obs["camera"][:8].clamp(0, 1) * 255).to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
            gap = 2
            sheet = np.full((2 * 36 + gap, 4 * 64 + 3 * gap, 3), 16, dtype=np.uint8)
            for k, pic in enumerate(pics):
                r, c = divmod(k, 4)
                sheet[r * (36 + gap) : r * (36 + gap) + 36, c * (64 + gap) : c * (64 + gap) + 64] = pic
            Image.fromarray(sheet).resize((sheet.shape[1] * 5, sheet.shape[0] * 5), Image.NEAREST).save(os.path.join(args.frames, f"{i:05d}.png"))
        if args.verbose and i < args.verbose:
            t = obs["teacher"][0]
            z = robot.data.root_pos_w.torch[:, 2]
            print(f"  {i}: act {[round(v, 2) for v in action[0].tolist()]} goal {[round(v, 2) for v in t[192:195].tolist()]} last {[round(v, 2) for v in t[195:197].tolist()]} twist {[round(v, 2) for v in t[197:199].tolist()]} yaw {t[199].item():.2f} tof min {t[:64].min().item():.2f} mean {t[:64].mean().item():.2f} | z {[round(v, 2) for v in z.tolist()]} done {terminated.nonzero().flatten().tolist()}")
        if i % 10 == 9 or i == args.steps - 1:
            pos = robot.data.root_pos_w.torch
            grav = robot.data.projected_gravity_b.torch
            tilt = torch.rad2deg(torch.acos((-grav[:, 2]).clamp(-1, 1)))
            origin = env.scene.env_origins
            moved = (pos[:, :2] - origin[:, :2]).norm(dim=-1)
            print(f"step {i + 1:3d}: z {pos[:, 2].mean():.3f} (min {pos[:, 2].min():.3f}), tilt {tilt.mean():.1f} deg (max {tilt.max():.1f}), from middle {moved.mean():.2f} m, falls so far {falls}")
    tof = mdp.tof_distances(env, "tof")[0].reshape(8, 8)
    print("tof env 0 (m), row 0 top, col 0 left:\n" + "\n".join(" ".join(f"{v:4.2f}" for v in row) for row in tof.tolist()))
    pos = robot.data.root_pos_w.torch
    print("ducks relative to duck 0 (m):", [[round(v, 2) for v in (p - pos[0])[:2].tolist()] for p in pos[1:]])
    print("env origins:", [[round(v, 1) for v in o[:2].tolist()] for o in env.scene.env_origins[:4]])
    print(f"goals reached per duck per minute: {arrived / env.num_envs / (args.steps * 0.1) * 60:.2f}, falls per duck per minute: {falls / env.num_envs / (args.steps * 0.1) * 60:.2f}")
    room = env.scene["room"]
    print("room env 0 (x, y, z) per body:", [[round(v, 2) for v in b.tolist()] for b in (room.data.body_pos_w.torch[0] - env.scene.env_origins[0])])
    twist = env.action_manager.get_term("drive").twist[0].tolist()
    print("smoothed twist env 0:", [round(v, 3) for v in twist], "goal obs:", [round(v, 3) for v in mdp.goal_obs(env)[0].tolist()])
    if args.png:
        rgb = env.scene.sensors["head_cam"].data.output["rgb"].torch[..., :3]
        from PIL import Image

        tiles = [rgb[i].cpu().numpy() for i in range(min(4, env.num_envs))]
        import numpy as np

        Image.fromarray(np.concatenate(tiles, axis=1)).resize((64 * 4 * 4, 36 * 4), Image.NEAREST).save(args.png)
        print("wrote", args.png)
    env.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
