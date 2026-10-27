# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
Runs a Duck Lab policy (.onnx) with numpy, so Isaac Sim's Python needs
nothing installed. Reads just enough of the ONNX protobuf (onnx/onnx.proto
field numbers) for the policies the duck ships: an input normaliser (Sub,
Div) and an MLP (Gemm, Elu). A few more element-wise operators are there
for retrained policies; anything else is refused by name.

    policy = OnnxMlp("policies/walk.onnx")
    action = policy(obs)   # float32 [61] -> [14]
"""
import struct

import numpy as np


def _varint(buf, i):
    result = 0
    shift = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, i
        shift += 7


def _fields(buf):
    """(field number, wire type, value) for each field of one message; value is an int or bytes."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 1:
            value, i = buf[i : i + 8], i + 8
        elif wire == 2:
            length, i = _varint(buf, i)
            value, i = buf[i : i + length], i + length
        elif wire == 5:
            value, i = buf[i : i + 4], i + 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
        yield field, wire, value


def _ints(wire, value):
    if wire == 0:
        return [value]
    out, i = [], 0
    while i < len(value):
        v, i = _varint(value, i)
        out.append(v)
    return out


def _tensor(buf):
    name, dims, dtype, raw, floats = "", [], 1, None, []
    for field, wire, value in _fields(buf):
        if field == 1:
            dims += _ints(wire, value)
        elif field == 2:
            dtype = value
        elif field == 4:
            floats += list(struct.unpack(f"<{len(value) // 4}f", value)) if wire == 2 else [struct.unpack("<f", value)[0]]
        elif field == 8:
            name = value.decode()
        elif field == 9:
            raw = value
    if dtype != 1:
        raise ValueError(f"tensor {name}: only float32 is supported (type {dtype})")
    data = np.frombuffer(raw, dtype="<f4") if raw is not None else np.array(floats, dtype=np.float32)
    return name, data.astype(np.float32).reshape(dims)


def _node(buf):
    node = {"input": [], "output": [], "op": "", "attrs": {}}
    for field, _, value in _fields(buf):
        if field == 1:
            node["input"].append(value.decode())
        elif field == 2:
            node["output"].append(value.decode())
        elif field == 4:
            node["op"] = value.decode()
        elif field == 5:
            attr_name, attr = "", None
            for f, w, v in _fields(value):
                if f == 1:
                    attr_name = v.decode()
                elif f == 2:
                    attr = struct.unpack("<f", v)[0]
                elif f == 3:
                    attr = v
            node["attrs"][attr_name] = attr
    return node


def _elu(x, alpha):
    return np.where(x > 0, x, alpha * (np.exp(np.minimum(x, 0)) - 1)).astype(np.float32)


class OnnxMlp:
    def __init__(self, path):
        with open(path, "rb") as f:
            model = f.read()
        graph = next(v for field, _, v in _fields(model) if field == 7)
        self.weights, self.nodes, self.inputs, self.outputs = {}, [], [], []
        for field, _, value in _fields(graph):
            if field == 1:
                self.nodes.append(_node(value))
            elif field == 5:
                name, data = _tensor(value)
                self.weights[name] = data
            elif field in (11, 12):
                name = next(v.decode() for f, _, v in _fields(value) if f == 1)
                (self.inputs if field == 11 else self.outputs).append(name)
        self.inputs = [name for name in self.inputs if name not in self.weights]
        known = {"Sub", "Div", "Add", "Mul", "Gemm", "MatMul", "Elu", "Relu", "Tanh", "Clip", "Identity"}
        unknown = sorted({n["op"] for n in self.nodes} - known)
        if unknown:
            raise ValueError(f"{path}: operators this runner does not know: {', '.join(unknown)}")

    def __call__(self, obs):
        values = dict(self.weights)
        values[self.inputs[0]] = np.asarray(obs, dtype=np.float32).reshape(1, -1)
        for node in self.nodes:
            a = [values[name] if name else None for name in node["input"]]
            op, attrs = node["op"], node["attrs"]
            if op == "Sub":
                out = a[0] - a[1]
            elif op == "Div":
                out = a[0] / a[1]
            elif op == "Add":
                out = a[0] + a[1]
            elif op == "Mul":
                out = a[0] * a[1]
            elif op == "MatMul":
                out = a[0] @ a[1]
            elif op == "Gemm":
                x = a[0].T if attrs.get("transA") else a[0]
                w = a[1].T if attrs.get("transB") else a[1]
                out = attrs.get("alpha", 1.0) * (x @ w)
                if len(a) > 2 and a[2] is not None:
                    out = out + attrs.get("beta", 1.0) * a[2]
            elif op == "Elu":
                out = _elu(a[0], attrs.get("alpha", 1.0))
            elif op == "Relu":
                out = np.maximum(a[0], 0)
            elif op == "Tanh":
                out = np.tanh(a[0])
            elif op == "Clip":
                low = a[1] if len(a) > 1 and a[1] is not None else -np.inf
                high = a[2] if len(a) > 2 and a[2] is not None else np.inf
                out = np.clip(a[0], low, high)
            else:
                out = a[0]
            values[node["output"][0]] = np.asarray(out, dtype=np.float32)
        return values[self.outputs[0]].reshape(-1)
