# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
Reads an exported scenario pack (node tools/train/replay.mjs <pack> --export
<folder>) for Isaac Sim, in plain Python: no Isaac Sim imports, so it can be
checked with any Python 3.10 and numpy.

- robot_mjcf(): the robot alone, for Isaac Sim's MJCF importer. The world's
  shapes, the ball and the height field go in as USD instead (run_pack.py),
  and geoms MuJoCo lets touch only the robot itself are left out, as PhysX
  self-collision stays off.
- motors(): each joint's motor as MuJoCo runs it: position gain, force
  limit, damping, armature, friction loss, from the joint's and actuator's
  default classes.
- world(): the world's shapes, free bodies (the ball) and height fields.
- addresses(): where each joint's values sit in qpos and qvel.
"""
import copy
import json
import os
import struct
import xml.etree.ElementTree as ET

import numpy as np

DEFAULT_FRICTION = 1.0  # MuJoCo's geom friction (sliding)


def _floats(text, default=None):
    if text is None:
        return default
    return [float(v) for v in text.split()]


def load(folder):
    tree = ET.parse(os.path.join(folder, "scene.xml"))
    with open(os.path.join(folder, "state.json"), encoding="utf-8") as f:
        state = json.load(f)
    return tree, state


def _classes(root):
    """Default class name -> {element tag: attributes}, with nested classes inheriting."""
    classes = {}

    def walk(el, inherited):
        name = el.get("class", "main")
        mine = {tag: dict(attrs) for tag, attrs in inherited.items()}
        for child in el:
            if child.tag != "default":
                mine.setdefault(child.tag, {}).update(child.attrib)
        if name in classes:
            for tag, attrs in mine.items():
                classes[name].setdefault(tag, {}).update(attrs)
        else:
            classes[name] = mine
        for child in el:
            if child.tag == "default":
                walk(child, classes[name])

    for d in root.findall("default"):
        walk(d, classes.get("main", {}))
    return classes


def _resolved(el, tag, classes, childclass):
    """An element's attributes after its default class (its own, the body's childclass, or main)."""
    name = el.get("class") or childclass or "main"
    attrs = dict(classes.get("main", {}).get(tag, {}))
    attrs.update(classes.get(name, {}).get(tag, {}))
    attrs.update(el.attrib)
    return attrs


def _bodies(parent, classes, childclass=None):
    """(body element, its childclass) for every body below parent, in document order."""
    for body in parent.findall("body"):
        cc = body.get("childclass") or childclass
        yield body, cc
        yield from _bodies(body, classes, cc)


def robot_root(tree, free_joint):
    """The worldbody child that holds the robot's free joint."""
    for body in tree.getroot().find("worldbody").findall("body"):
        if any(j.get("name") == free_joint for j in body.iter("freejoint")) or any(
            j.get("name") == free_joint for j in body.iter("joint")
        ):
            return body
    raise ValueError(f"no body holds the free joint {free_joint}")


def robot_mjcf(tree, free_joint, out_path):
    """Writes the robot alone (same defaults, meshes, actuators) to out_path."""
    root = copy.deepcopy(tree.getroot())
    classes = _classes(root)
    world = root.find("worldbody")
    robot = robot_root(ET.ElementTree(root), free_joint)
    for child in list(world):
        if child is not robot:
            world.remove(child)
    # Geoms that collide only with the robot itself (self-collision is off in PhysX).
    left_out = []
    for body, cc in [(robot, robot.get("childclass"))] + list(_bodies(robot, classes, robot.get("childclass"))):
        for geom in list(body.findall("geom")):
            attrs = _resolved(geom, "geom", classes, cc)
            contype, conaffinity = int(attrs.get("contype", 1)), int(attrs.get("conaffinity", 1))
            if (contype or conaffinity) and not (contype & 1 or conaffinity & 1):
                body.remove(geom)
                left_out.append(geom.get("name") or geom.get("mesh") or geom.get("type"))
    asset = root.find("asset")
    if asset is not None:
        for hfield in asset.findall("hfield"):
            asset.remove(hfield)
    for keyframe in root.findall("keyframe"):
        root.remove(keyframe)
    # Isaac Sim's importer reads one top-level <default> only; MuJoCo treats them all as the
    # same root class, so their contents go into the first.
    defaults = root.findall("default")
    for extra in defaults[1:]:
        for child in list(extra):
            defaults[0].append(child)
        root.remove(extra)
    ET.ElementTree(root).write(out_path)
    return left_out


def motors(tree):
    """Joint name -> MuJoCo's motor and joint values for it."""
    root = tree.getroot()
    classes = _classes(root)
    out = {}
    for body, cc in _bodies(root.find("worldbody"), classes):
        for joint in body.findall("joint"):
            attrs = _resolved(joint, "joint", classes, cc)
            out[joint.get("name")] = {
                "damping": float(attrs.get("damping", 0)),
                "armature": float(attrs.get("armature", 0)),
                "frictionloss": float(attrs.get("frictionloss", 0)),
                "range": _floats(attrs.get("range")),
            }
    actuators = root.find("actuator")
    for act in actuators.findall("position") if actuators is not None else []:
        attrs = _resolved(act, "position", classes, None)
        joint = out.setdefault(attrs["joint"], {})
        joint["kp"] = float(attrs.get("kp", 1))
        joint["kv"] = float(attrs.get("kv", 0))
        joint["forcerange"] = _floats(attrs.get("forcerange"))
    return out


def world(tree, folder, free_joint):
    """The world's shapes, its free bodies besides the robot, and its height fields."""
    root = tree.getroot()
    classes = _classes(root)
    hfields = {}
    asset = root.find("asset")
    for hf in asset.findall("hfield") if asset is not None else []:
        size = _floats(hf.get("size"))
        if hf.get("file"):
            # MuJoCo looks for height field files in meshdir, as for meshes (older exports: beside scene.xml).
            meshdir = next((c.get("meshdir") for c in root.iter("compiler") if c.get("meshdir")), "")
            path = os.path.join(folder, meshdir, hf.get("file"))
            if not os.path.exists(path):
                path = os.path.join(folder, hf.get("file"))
            with open(path, "rb") as f:
                nrow, ncol = struct.unpack("<ii", f.read(8))
                data = np.frombuffer(f.read(nrow * ncol * 4), dtype="<f4").reshape(nrow, ncol)
        else:
            nrow, ncol = int(hf.get("nrow")), int(hf.get("ncol"))
            data = np.zeros((nrow, ncol), dtype=np.float32)
        hfields[hf.get("name")] = {"size": size, "data": data}

    def shape(geom, cc):
        attrs = _resolved(geom, "geom", classes, cc)
        friction = _floats(attrs.get("friction"), [DEFAULT_FRICTION])
        return {
            "name": geom.get("name") or "",
            "type": attrs.get("type", "sphere"),
            "size": _floats(attrs.get("size"), []),
            "pos": _floats(attrs.get("pos"), [0, 0, 0]),
            "quat": _floats(attrs.get("quat"), [1, 0, 0, 0]),
            "friction": friction[0],
            "rgba": _floats(attrs.get("rgba")),
            "hfield": attrs.get("hfield"),
            "mesh": attrs.get("mesh"),
            "mass": float(attrs["mass"]) if "mass" in attrs else None,
            "collides": int(attrs.get("contype", 1)) != 0 or int(attrs.get("conaffinity", 1)) != 0,
        }

    worldbody = root.find("worldbody")
    robot = robot_root(tree, free_joint)
    statics = [shape(g, None) for g in worldbody.findall("geom")]
    bodies = []
    for body in worldbody.findall("body"):
        if body is robot:
            continue
        free = body.find("freejoint")
        joint = free.get("name") if free is not None else None
        bodies.append(
            {
                "name": body.get("name"),
                "joint": joint,
                "pos": _floats(body.get("pos"), [0, 0, 0]),
                "quat": _floats(body.get("quat"), [1, 0, 0, 0]),
                "geoms": [shape(g, body.get("childclass")) for g in body.findall("geom")],
            }
        )
    return {"statics": statics, "bodies": bodies, "hfields": hfields}


def addresses(tree):
    """Joint name -> (qpos address, dof address), in MuJoCo's order."""
    root = tree.getroot()
    qpos = dof = 0
    out = {}
    for body, _ in _bodies(root.find("worldbody"), _classes(root)):
        for joint in body:
            if joint.tag == "freejoint" or (joint.tag == "joint" and joint.get("type") == "free"):
                out[joint.get("name")] = (qpos, dof)
                qpos, dof = qpos + 7, dof + 6
            elif joint.tag == "joint" and joint.get("type") == "ball":
                out[joint.get("name")] = (qpos, dof)
                qpos, dof = qpos + 4, dof + 3
            elif joint.tag == "joint":
                out[joint.get("name")] = (qpos, dof)
                qpos, dof = qpos + 1, dof + 1
    return out


def mesh_grid(hfield, pos):
    """A height field as a triangle mesh: (points [n, 3], triangle indices [m, 3])."""
    sx, sy, sz = hfield["size"][:3]
    data = hfield["data"]
    nrow, ncol = data.shape
    xs = pos[0] - sx + np.arange(ncol) * (2 * sx / (ncol - 1))
    ys = pos[1] - sy + np.arange(nrow) * (2 * sy / (nrow - 1))
    gx, gy = np.meshgrid(xs, ys)
    points = np.stack([gx, gy, pos[2] + data * sz], axis=-1).reshape(-1, 3)
    r, c = np.meshgrid(np.arange(nrow - 1), np.arange(ncol - 1), indexing="ij")
    a = (r * ncol + c).reshape(-1)
    b, d, e = a + 1, a + ncol, a + ncol + 1
    triangles = np.concatenate([np.stack([a, b, e], -1), np.stack([a, e, d], -1)])
    return points.astype(np.float32), triangles.astype(np.int32)
