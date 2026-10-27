# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""The test case as terrain: every patch a copy of the moment the headset saved.

The trainer page builds a training ground from the test case (tools/train/lib/ground.mjs, purpose
'step') and hands it over as DUCKLAB_GROUND (a JSON file): where Pip started, which way it was going,
where it fell, and the pieces in the way (a play mat, a dog bed: walkable steps; posts, stacks). Each
patch rebuilds them where they were, in the ground's frame (x from the start towards the goal), and
the duck starts where Pip did, facing the way it faced.

The curriculum's rows change the steps' heights round the real ones (``height_scale``: 70% on the
lowest row to 120% on the highest; the test case's own height is three fifths of the way up);
the columns move each piece by up to 3 cm and turn it by up to 3 degrees, so the copies are the test
case and not one memorised spot. Pieces taller than 10 cm (posts, stacks) keep their height.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field

import mujoco
import numpy as np
from mjlab.terrains.terrain_generator import SubTerrainCfg, TerrainGeometry, TerrainOutput
from mjlab.terrains.utils import make_plane

FLOOR = (0.6, 0.6, 0.62, 1.0)
COLOURS = {
    "play mat": (0.32, 0.62, 0.78, 1.0),
    "dog bed": (0.72, 0.42, 0.33, 1.0),
}
STEP = (0.85, 0.62, 0.35, 1.0)
TALL = (0.45, 0.45, 0.5, 1.0)
LOW = 0.10  # m: pieces up to this tall are steps whose height the curriculum scales


def load_ground(path: str | None = None) -> dict | None:
    """The ground the trainer page wrote (DUCKLAB_GROUND), or None."""
    path = path or os.environ.get("DUCKLAB_GROUND")
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        ground = json.load(f)
    if ground.get("version") != "ducklab.ground.v1":
        raise ValueError(f"{path}: not a training ground (ducklab.ground.v1)")
    return ground


def patch_size(ground: dict) -> tuple[float, float]:
    """A square patch that holds the ground's region with a margin, at least 4 m."""
    x0, x1, y0, y1 = ground["region"]
    side = max(4.0, math.ceil(max(x1 - x0, y1 - y0) + 0.6))
    return (side, side)


def target_x(ground: dict) -> float:
    """How far along x counts as past the trouble: 40 cm beyond where it fell or got stuck."""
    return float(ground["trouble"][0]) + 0.4


@dataclass(kw_only=True)
class GroundTerrainCfg(SubTerrainCfg):
    ground: dict = field(default_factory=dict)
    height_scale: tuple[float, float] = (0.7, 1.2)
    jitter: float = 0.03
    """Up to this far (m) each piece moves, per patch."""
    jitter_yaw: float = math.radians(3.0)

    def function(self, difficulty: float, spec: mujoco.MjSpec, rng: np.random.Generator) -> TerrainOutput:
        body = spec.body("terrain")
        sx, sy = self.size
        g = self.ground
        x0, x1, y0, y1 = g["region"]
        # The ground's frame in the patch: its region's centre at the patch's centre.
        ox = sx / 2 - (x0 + x1) / 2
        oy = sy / 2 - (y0 + y1) / 2
        scale = self.height_scale[0] + difficulty * (self.height_scale[1] - self.height_scale[0])
        geometries = [TerrainGeometry(geom=gm, color=FLOOR) for gm in make_plane(body, self.size, 0.0, center_zero=False)]
        for o in g["obstacles"]:
            hx, hy, hz = o["half"]
            low = o["top"] <= LOW
            if low:
                hz = max(0.002, hz * scale)
                z = hz  # resting on the floor
            else:
                z = o["pos"][2]
            dx, dy = (rng.uniform(-1.0, 1.0, 2) * self.jitter) if self.jitter else (0.0, 0.0)
            yaw = o["yaw"] + (rng.uniform(-1.0, 1.0) * self.jitter_yaw if self.jitter_yaw else 0.0)
            x = min(sx - 0.05, max(0.05, o["pos"][0] + ox + dx))
            y = min(sy - 0.05, max(0.05, o["pos"][1] + oy + dy))
            quat = (math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2))
            if o["shape"] == "cylinder":
                geom = body.add_geom(type=mujoco.mjtGeom.mjGEOM_CYLINDER, size=(hx, hz, 0.0), pos=(x, y, z), quat=quat)
            else:
                geom = body.add_geom(type=mujoco.mjtGeom.mjGEOM_BOX, size=(hx, hy, hz), pos=(x, y, z), quat=quat)
            colour = COLOURS.get(o.get("label", ""), STEP if low else TALL)
            geometries.append(TerrainGeometry(geom=geom, color=colour))
        start = g["start"]
        return TerrainOutput(origin=np.array([start["x"] + ox, start["y"] + oy, 0.0]), geometries=geometries)
