# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""A navigation checkpoint (model_N.pt) to nav.onnx and nav.json, without building the environment.

    uv run python <repo>/tools/train/python/ducknav/export.py <model_N.pt> <out dir> [--walker walk.onnx]

The actor is rebuilt from the checkpoint's tensors (observation normaliser, then an ELU MLP), its
output clipped and scaled to a twist exactly as train.py's export does.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import torch  # noqa: E402

from ducknav import nav_env  # noqa: E402

EPS = 1e-2  # rsl_rl's EmpiricalNormalization: (x - mean) / (std + eps)


class Actor(torch.nn.Module):
    def __init__(self, state: dict):
        super().__init__()
        self.register_buffer("mean", state["obs_normalizer._mean"].float())
        self.register_buffer("scale", state["obs_normalizer._std"].float() + EPS)
        weights = sorted({int(k.split(".")[1]) for k in state if k.startswith("mlp.") and k.endswith(".weight")})
        layers: list[torch.nn.Module] = []
        for i, idx in enumerate(weights):
            w, b = state[f"mlp.{idx}.weight"], state[f"mlp.{idx}.bias"]
            linear = torch.nn.Linear(w.shape[1], w.shape[0])
            linear.weight.data.copy_(w)
            linear.bias.data.copy_(b)
            layers.append(linear)
            if i < len(weights) - 1:
                layers.append(torch.nn.ELU())
        self.mlp = torch.nn.Sequential(*layers)
        self.obs_size = int(self.mean.shape[-1])

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        a = self.mlp((obs - self.mean) / self.scale).clamp(-1.0, 1.0)
        vx = torch.where(a[:, :1] >= 0, a[:, :1] * nav_env.VX_FORWARD, a[:, :1] * nav_env.VX_BACK)
        return torch.cat([vx, a[:, 1:2] * nav_env.WZ_MAX], dim=-1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--walker", default="walk.onnx")
    args = ap.parse_args()
    ck = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    actor = Actor(ck["actor_state_dict"]).eval()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(actor, (torch.zeros(1, actor.obs_size),), str(out / "nav.onnx"), input_names=["obs"], output_names=["twist"], opset_version=18, dynamo=False)
    from ducknav.train import write_layout

    write_layout(out, args.walker, iteration=int(ck.get("iter", -1)))
    print(f"{out / 'nav.onnx'}: {actor.obs_size} inputs -> twist, from {args.checkpoint} (round {ck.get('iter')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
