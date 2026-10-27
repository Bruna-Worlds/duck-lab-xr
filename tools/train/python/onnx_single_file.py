# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Writes an ONNX model as one file, its weights inside.

PyTorch 2.11's exporter (Isaac Lab 3) writes the weights beside the graph
(policy.onnx + policy.onnx.data); the headset and the trainer page load one
file. Run with the trainer's own Python (it has the onnx package):

    python onnx_single_file.py <model.onnx | checkpoint.pt> <out.onnx>

Given a checkpoint, it takes the exported/policy.onnx that Isaac Lab's play
writes beside it.
"""

import sys
from pathlib import Path

import onnx


def main() -> None:
    source, out = Path(sys.argv[1]), Path(sys.argv[2])
    if source.suffix == ".pt":
        source = source.parent / "exported" / "policy.onnx"
    model = onnx.load(str(source))  # reads policy.onnx.data too
    out.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(model, str(out), save_as_external_data=False)
    io = lambda values: ", ".join(f"{v.name} {[d.dim_value or d.dim_param for d in v.type.tensor_type.shape.dim]}" for v in values)
    print(f"Written {out} (one file, opset {model.opset_import[0].version}): {io(model.graph.input)} -> {io(model.graph.output)}")


if __name__ == "__main__":
    main()
