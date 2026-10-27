# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""A terrace: a clear square at floor level, three steps up, a short top, two steps down and a
last step to the floor at the patch's edge, so every patch meets its neighbours at floor height
(no cliffs between patches). The step height grows with the patch's difficulty row."""

from __future__ import annotations

from dataclasses import dataclass

import mujoco
import numpy as np
from mjlab.terrains.terrain_generator import SubTerrainCfg, TerrainGeometry, TerrainOutput
from mjlab.terrains.utils import make_border, make_plane

FLOOR = (0.6, 0.6, 0.62, 1.0)
STEP = (0.85, 0.62, 0.35, 1.0)


@dataclass(kw_only=True)
class TerraceTerrainCfg(SubTerrainCfg):
    step_height_range: tuple[float, float] = (0.005, 0.04)
    centre: float = 0.8
    """Side of the clear square at the middle, where robots spawn."""
    up_width: float = 0.25
    """Depth of each step up (about two of the duck's strides)."""
    top: float = 0.2
    down_width: float = 0.3

    def function(self, difficulty: float, spec: mujoco.MjSpec, rng: np.random.Generator) -> TerrainOutput:
        del rng
        body = spec.body("terrain")
        sx, sy = self.size
        h = self.step_height_range[0] + difficulty * (self.step_height_range[1] - self.step_height_range[0])
        geometries = [TerrainGeometry(geom=g, color=FLOOR) for g in make_plane(body, self.size, 0.0, center_zero=False)]
        # Rings from the middle outwards: (outer side, height of the ring's top).
        rings = []
        side = self.centre
        for k in (1, 2, 3):
            side += 2 * self.up_width
            rings.append((side, k * h))
        side += 2 * self.top
        rings.append((side, 3 * h))
        for k in (2, 1):
            side += 2 * self.down_width
            rings.append((side, k * h))
        if side > min(sx, sy) - 0.05:
            raise ValueError(f"terrace of {side:.2f} m does not fit a {sx} x {sy} m patch")
        inner = self.centre
        for outer, top in rings:
            for g in make_border(body, (outer, outer), (inner, inner), top, (sx / 2, sy / 2, top / 2)):
                geometries.append(TerrainGeometry(geom=g, color=STEP))
            inner = outer
        return TerrainOutput(origin=np.array([sx / 2, sy / 2, 0.0]), geometries=geometries)
