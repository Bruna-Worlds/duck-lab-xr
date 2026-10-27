# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""A walking policy's ONNX (Pollen's export: observation normaliser, then an ELU MLP) as a frozen
torch module, so it runs batched on the GPU inside the navigation environment."""

from __future__ import annotations

import onnx
import torch
from onnx import numpy_helper


class Walker(torch.nn.Module):
    def __init__(self, path: str):
        super().__init__()
        graph = onnx.load(path).graph
        inits = {t.name: torch.from_numpy(numpy_helper.to_array(t).copy()) for t in graph.initializer}
        sub = next(n for n in graph.node if n.op_type == "Sub" and n.input[0] == graph.input[0].name)
        div = next(n for n in graph.node if n.op_type == "Div" and n.input[0] == sub.output[0])
        self.register_buffer("mean", inits[sub.input[1]].float())
        self.register_buffer("scale", inits[div.input[1]].float())
        layers: list[torch.nn.Module] = []
        gemms = [n for n in graph.node if n.op_type == "Gemm"]
        for i, node in enumerate(gemms):
            w, b = inits[node.input[1]], inits[node.input[2]]
            linear = torch.nn.Linear(w.shape[1], w.shape[0])
            linear.weight.data.copy_(w)
            linear.bias.data.copy_(b)
            layers.append(linear)
            if i < len(gemms) - 1:
                layers.append(torch.nn.ELU())
        self.mlp = torch.nn.Sequential(*layers)
        self.requires_grad_(False)
        self.obs_size = int(self.mean.shape[-1])
        self.action_size = int(inits[gemms[-1].input[1]].shape[0])

    @torch.no_grad()
    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        return self.mlp((obs - self.mean) / self.scale)
