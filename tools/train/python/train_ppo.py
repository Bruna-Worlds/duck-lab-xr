# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
Reference RL connector trainer: PPO fine-tune of Pollen's walking policy on
Duck Lab XR scenario packs, on a GPU or CPU, with Stable-Baselines3 and
MuJoCo's Python bindings. It reads a job exported by Duck Lab XR (Connect), so
the scenes are the player's real room and the moments the duck struggled,
starts from the shipped policy's weights (read from its ONNX file), and
writes a release folder the headset can load:

  python tools/train/python/train_ppo.py artifacts/connector/<trainjob>/ \
      --steps 2000000 --envs 8 --name ppo-room
  node tools/train/release.mjs rescan     # then activate it in Duck Lab XR

Install: Python 3.10+, then
  pip install mujoco gymnasium stable-baselines3 torch onnx onnxruntime numpy

Not run on the machine this was written on (no Python there). The Node
trainer (tools/train/finetune.mjs) implements the same scenes, reward and
release format and is tested; use it as the reference if anything differs.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import shutil

import numpy as np
import onnx
import torch
import torch.nn as nn
from onnx import numpy_helper
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import SubprocVecEnv

from duck_env import DuckPackEnv

POLICY_FILES = ["walk.onnx", "stand.onnx", "sitstand.onnx", "roll.onnx", "kick-left.onnx", "kick-right.onnx", "peck.onnx"]


def read_policy(path):
    """Normaliser and the four Gemm layers of a Pollen walking policy (ONNX, transB=1)."""
    model = onnx.load(path)
    weights = {t.name: numpy_helper.to_array(t) for t in model.graph.initializer}
    nodes = model.graph.node
    sub = next(n for n in nodes if n.op_type == "Sub")
    div = next(n for n in nodes if n.op_type == "Div")
    mean = weights[sub.input[1]].reshape(-1).astype(np.float32)
    std = weights[div.input[1]].reshape(-1).astype(np.float32)
    layers = [(weights[n.input[1]], weights[n.input[2]]) for n in nodes if n.op_type == "Gemm"]
    if len(layers) != 4:
        raise ValueError(f"expected 4 Gemm layers, found {len(layers)}")
    return mean, std, layers


def fnv1a(data):
    h = 0x811C9DC5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def make_env(pack_dir, normalizer, seed, horizon):
    return lambda: DuckPackEnv(pack_dir, horizon=horizon, normalizer=normalizer, seed=seed)


def evaluate(policy_fn, pack_dirs, normalizer, horizon, seeds=6, flat=False):
    falls, distances, episodes = 0, [], 0
    for pack in pack_dirs:
        for s in range(seeds):
            env = DuckPackEnv(pack, horizon=horizon, normalizer=normalizer, seed=9001 + s, flat=flat)
            obs, _ = env.reset(seed=9001 + s)
            done = False
            while not done:
                obs, _, terminated, truncated, info = env.step(policy_fn(obs))
                done = terminated or truncated
            episodes += 1
            falls += int(info.get("fell", False))
            distances.append(info.get("distance", 0.0))
    return {"episodes": episodes, "fallRate": falls / max(1, episodes), "meanDistance": float(np.mean(distances or [0]))}


class Exported(nn.Module):
    """Normaliser + trained MLP, exported with the shipped file's input and output names."""

    def __init__(self, mean, std, policy_net, action_net):
        super().__init__()
        self.register_buffer("mean", torch.tensor(mean).reshape(1, -1))
        self.register_buffer("std", torch.tensor(std).reshape(1, -1))
        self.policy_net = policy_net
        self.action_net = action_net

    def forward(self, obs):
        return self.action_net(self.policy_net((obs - self.mean) / self.std))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("job", help="folder exported by Duck Lab XR (Connect): job.json and one folder per pack")
    parser.add_argument("--steps", type=int, default=2_000_000, help="environment steps to train")
    parser.add_argument("--envs", type=int, default=8)
    parser.add_argument("--horizon", type=int, default=900)
    parser.add_argument("--name", default="ppo-room")
    parser.add_argument("--repo", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))
    args = parser.parse_args()

    with open(os.path.join(args.job, "job.json"), encoding="utf-8") as f:
        job = json.load(f)
    pack_dirs = [os.path.join(args.job, p) for p in job["packs"]]
    base_path = os.path.join(pack_dirs[0], "policies", "walk.onnx")
    mean, std, layers = read_policy(base_path)
    normalizer = (mean, std)

    envs = SubprocVecEnv(
        [make_env(pack_dirs[i % len(pack_dirs)], normalizer, i, args.horizon) for i in range(args.envs)],
        start_method="spawn",
    )
    model = PPO(
        "MlpPolicy",
        envs,
        learning_rate=3e-5,
        n_steps=1024,
        batch_size=4096,
        n_epochs=5,
        gamma=0.99,
        gae_lambda=0.95,
        clip_range=0.1,
        ent_coef=0.0,
        policy_kwargs=dict(net_arch=dict(pi=[512, 256, 128], vf=[512, 256, 128]), activation_fn=nn.ELU, log_std_init=-2.5),
        device="cuda" if torch.cuda.is_available() else "cpu",
        verbose=1,
    )
    # Start from the shipped policy: its three hidden layers and its output layer.
    linears = [m for m in model.policy.mlp_extractor.policy_net if isinstance(m, nn.Linear)]
    with torch.no_grad():
        for lin, (w, b) in zip(linears, layers[:3]):
            lin.weight.copy_(torch.tensor(w))
            lin.bias.copy_(torch.tensor(b))
        model.policy.action_net.weight.copy_(torch.tensor(layers[3][0]))
        model.policy.action_net.bias.copy_(torch.tensor(layers[3][1]))

    def act(obs):
        action, _ = model.predict(obs, deterministic=True)
        return action

    baseline = evaluate(act, pack_dirs, normalizer, args.horizon)
    baseline_flat = evaluate(act, pack_dirs[:1], normalizer, args.horizon, flat=True)
    print("baseline", baseline, "plain floor", baseline_flat)
    model.learn(total_timesteps=args.steps)
    trained = evaluate(act, pack_dirs, normalizer, args.horizon)
    trained_flat = evaluate(act, pack_dirs[:1], normalizer, args.horizon, flat=True)
    print("trained", trained, "plain floor", trained_flat)
    improved = trained["fallRate"] < baseline["fallRate"] and trained_flat["fallRate"] <= baseline_flat["fallRate"]
    if not improved:
        print("no improvement: nothing released")
        return

    stamp = dt.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%S")
    release_id = f"{stamp}-{args.name}"
    out = os.path.join(args.repo, "public", "policies", "incoming", release_id)
    os.makedirs(out, exist_ok=True)
    exported = Exported(mean, std, model.policy.mlp_extractor.policy_net.cpu(), model.policy.action_net.cpu()).eval()
    walk_path = os.path.join(out, "walk.onnx")
    torch.onnx.export(exported, torch.zeros(1, 61), walk_path, input_names=["obs"], output_names=["actions"], opset_version=17)
    files = {"walk.onnx": {"hash": fnv1a(open(walk_path, "rb").read()), "trained": True}}
    for name in POLICY_FILES[1:]:
        src = os.path.join(pack_dirs[0], "policies", name)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(out, name))
            files[name] = {"hash": fnv1a(open(src, "rb").read()), "trained": False}
    manifest = {
        "version": "duckdash.policyrelease.v1",
        "id": release_id,
        "name": args.name,
        "createdAt": dt.datetime.utcnow().isoformat() + "Z",
        "trainer": {"kind": "ppo-sb3", "description": "PPO fine-tune (Stable-Baselines3) from the shipped weights", "steps": args.steps},
        "base": {"walkHash": fnv1a(open(base_path, "rb").read())},
        "trainedOn": job["packs"],
        "results": {"baseline": baseline, "trained": trained, "flat": {"baseline": baseline_flat, "trained": trained_flat}},
        "files": files,
        "control": {"obs": 61, "actions": 14, "hz": 50},
        "note": "Based on Pollen Robotics Microduck policies; see ATTRIBUTION.md.",
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"release {release_id} -> {out}; now run: node tools/train/release.mjs rescan")


if __name__ == "__main__":
    main()
