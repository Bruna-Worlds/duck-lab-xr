# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""A camera brain checkpoint (distillation or PPO) to nav-camera.onnx + nav-camera.json for Duck Lab XR.

    uv run python <repo>/tools/train/python/isaacnav/export.py <run>/model_N.pt <repo>/public/policies/ducklab

Inputs: ``obs`` [1, 200] (the depth brain's layout, nav.json) and ``camera`` [1, 3, 36, 64] (RGB, 0..1,
rows top to bottom, the head camera); output ``twist`` [1, 2] (forward m/s, turn rad/s).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch  # noqa: E402
from rsl_rl.models import CNNModel  # noqa: E402
from tensordict import TensorDict  # noqa: E402

from isaacnav import agents, mdp  # noqa: E402
from isaacnav.env_cfg import CAMERA_FOCAL, CAMERA_SIZE, NAV_DT  # noqa: E402

OBS = 200


class CameraNavExport(torch.nn.Module):
    def __init__(self, onnx_model: torch.nn.Module):
        super().__init__()
        self.inner = onnx_model

    def forward(self, obs: torch.Tensor, camera: torch.Tensor) -> torch.Tensor:
        a = self.inner(obs, camera).clamp(-1.0, 1.0)
        vx = torch.where(a[:, :1] >= 0, a[:, :1] * mdp.VX_FORWARD, a[:, :1] * mdp.VX_BACK)
        return torch.cat([vx, a[:, 1:2] * mdp.WZ_MAX], dim=-1)


def build_student() -> CNNModel:
    w, h = CAMERA_SIZE
    obs = TensorDict({"policy": torch.zeros(1, OBS), "camera": torch.zeros(1, 3, h, w)}, batch_size=[1])
    cfg = agents.STUDENT.to_dict()
    cfg.pop("class_name", None)
    cnn = cfg.pop("cnn_cfg")
    return CNNModel(obs, {"student": ["policy", "camera"]}, "student", 2, cnn_cfg=cnn, **cfg)


def main() -> int:
    checkpoint, out_dir = sys.argv[1], sys.argv[2]
    state = torch.load(checkpoint, map_location="cpu", weights_only=False)
    weights = state.get("student_state_dict") or state["actor_state_dict"]
    model = build_student()
    model.load_state_dict(weights, strict=True)
    model.eval()
    export = CameraNavExport(model.as_onnx(verbose=False)).eval()
    w, h = CAMERA_SIZE
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "nav-camera.onnx")
    torch.onnx.export(export, (torch.zeros(1, OBS), torch.zeros(1, 3, h, w)), path, input_names=["obs", "camera"], output_names=["twist"], opset_version=18, dynamo=False)
    layout = {
        "version": "ducklab.nav-camera.v1",
        "rateHz": round(1 / NAV_DT),
        "obs": "the depth brain's 200 inputs, as nav.json describes them",
        "camera": {
            "size": [3, h, w],
            "about": "the head camera's RGB, 0..1, channels first, row 0 the top; Pollen's head_camera frame on jaw_soft",
            "verticalFovDeg": 45.0,
            "focalMm": CAMERA_FOCAL,
            "apertureMm": 20.955,
        },
        "output": {"name": "twist", "about": f"target forward m/s (-{mdp.VX_BACK} to {mdp.VX_FORWARD}) and turn rad/s (+-{mdp.WZ_MAX})"},
        "trainedIn": "NVIDIA Isaac Lab 3 (Newton, kit-less), distilled from the depth brain (Pollen's mjlab)",
        "round": int(state.get("iter", -1)),
    }
    with open(os.path.join(out_dir, "nav-camera.json"), "w", newline="\n") as f:
        f.write(json.dumps(layout, indent=2) + "\n")
    print(f"exported {path} and nav-camera.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
