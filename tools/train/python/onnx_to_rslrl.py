# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""A walking policy's ONNX (Pollen's microduck_rl export: obs normaliser, then an
ELU MLP) back into an rsl_rl checkpoint, so PPO can start from it instead of
from random weights.

    python -I onnx_to_rslrl.py <policy.onnx> <template.pt> <out.pt> [--std 0.2] [--lr 2e-4] [--fresh-critic]

The template is any checkpoint of the same task and network (a few iterations of
a run are enough). The actor (its normaliser and MLP) comes from the ONNX, the
action noise is set to --std, the critic and the training step count come from
the template (a critic that already knows the task's values keeps the first
updates from wrecking a good walker; --fresh-critic re-draws its weights), and
the optimiser keeps the template's shape with its first moments cleared and its
learning rate set to --lr. Runs in the trainer's own Python (torch, onnx).
"""

import argparse
import sys

import onnx
import torch
from onnx import numpy_helper

EPS = 1e-2  # rsl_rl's EmpiricalNormalization: (x - mean) / (std + eps); the export folds std + eps into one constant


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("onnx")
    ap.add_argument("template")
    ap.add_argument("out")
    ap.add_argument("--std", type=float, default=0.2, help="action noise to start PPO with")
    ap.add_argument("--lr", type=float, default=2e-4, help="starting learning rate (the adaptive schedule moves it)")
    ap.add_argument("--fresh-critic", action="store_true", help="re-draw the critic's weights instead of the template's")
    args = ap.parse_args()

    graph = onnx.load(args.onnx).graph
    inits = {t.name: torch.from_numpy(numpy_helper.to_array(t).copy()) for t in graph.initializer}
    # The normaliser's two constants feed the Sub and Div at the graph's input.
    sub = next(n for n in graph.node if n.op_type == "Sub" and n.input[0] == graph.input[0].name)
    div = next(n for n in graph.node if n.op_type == "Div" and n.input[0] == sub.output[0])
    mean, std_eps = inits[sub.input[1]], inits[div.input[1]]

    ck = torch.load(args.template, map_location="cpu", weights_only=False)
    actor = ck["actor_state_dict"]
    for name in [k for k in actor if k.startswith("mlp.")]:
        if name not in inits or inits[name].shape != actor[name].shape:
            print(f"{name}: not in the ONNX or another shape ({tuple(actor[name].shape)})", file=sys.stderr)
            return 1
        actor[name] = inits[name].clone()
    std = (std_eps - EPS).clamp_min(1e-6)
    actor["obs_normalizer._mean"] = mean.clone()
    actor["obs_normalizer._std"] = std
    actor["obs_normalizer._var"] = std * std
    for key in ("distribution.std_param", "std"):
        if key in actor:
            actor[key] = torch.full_like(actor[key], args.std)
    if "distribution.log_std_param" in actor:
        actor["distribution.log_std_param"] = torch.full_like(actor["distribution.log_std_param"], float(torch.log(torch.tensor(args.std))))

    if args.fresh_critic:
        for name, t in ck["critic_state_dict"].items():
            if name.startswith("mlp.") and name.endswith("weight"):
                torch.nn.init.orthogonal_(t, gain=1.0)
            elif name.startswith("mlp.") and name.endswith("bias"):
                t.zero_()

    opt = ck.get("optimizer_state_dict")
    if opt:
        for state in opt["state"].values():
            if "exp_avg" in state:
                state["exp_avg"].zero_()
        for group in opt["param_groups"]:
            group["lr"] = args.lr

    torch.save(ck, args.out)
    print(f"{args.out}: actor from {args.onnx} (std {args.std}), critic {'re-drawn' if args.fresh_critic else 'from the template'}, "
          f"iteration {ck['iter']}, step counter {ck.get('infos', {}).get('env_state', {}).get('common_step_counter')}, lr {args.lr}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
