# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Rooms to navigate: a walled square of floor with furniture, partitions, boxes and posts round a clear spawn.

Every obstacle geom is named ``obstacle_<n>`` and every wall ``wall_<n>``, so the trainer finds
them in the compiled model (positions, sizes); all of them belong to one body, ``obstacles``, so a
contact sensor can tell bumping into something from standing on the floor.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

import mujoco
import numpy as np
from mjlab.terrains.terrain_generator import SubTerrainCfg, TerrainGeometry, TerrainOutput
from mjlab.terrains.utils import make_plane

_names = itertools.count()

FLOOR = (0.62, 0.58, 0.52, 1.0)
WALL = (0.85, 0.83, 0.78, 1.0)
COLOURS = ((0.85, 0.45, 0.25, 1.0), (0.3, 0.55, 0.85, 1.0), (0.35, 0.7, 0.45, 1.0), (0.9, 0.75, 0.3, 1.0))


@dataclass(kw_only=True)
class ObstacleRoomTerrainCfg(SubTerrainCfg):
    wall_height: float = 0.35
    wall_thickness: float = 0.05
    count: tuple[int, int] = (3, 12)
    """Obstacles per room, from the easiest row to the hardest."""
    footprint: tuple[float, float] = (0.06, 0.5)
    """Side of a box (or twice a post's radius), in metres."""
    height: tuple[float, float] = (0.04, 0.45)
    clear_radius: float = 0.4
    """Nothing within this of the spawn (the room's centre)."""
    furniture: tuple[int, int] = (0, 3)
    """Table- or sofa-sized boxes per room (0.5-1.2 x 0.3-0.7 m), from the easiest row to the hardest."""
    partitions: tuple[int, int] = (0, 2)
    """Thin wall pieces (0.6-1.6 m long) per room."""

    def function(self, difficulty: float, spec: mujoco.MjSpec, rng: np.random.Generator) -> TerrainOutput:
        floor_body = spec.body("terrain")
        body = spec.body("obstacles")
        if body is None:
            body = floor_body.add_body(name="obstacles")
        sx, sy = self.size
        t, h = self.wall_thickness, self.wall_height
        geometries = [TerrainGeometry(geom=g, color=FLOOR) for g in make_plane(floor_body, self.size, 0.0, center_zero=False)]
        for cx, cy, hx, hy in (
            (sx / 2, t / 2, sx / 2, t / 2),
            (sx / 2, sy - t / 2, sx / 2, t / 2),
            (t / 2, sy / 2, t / 2, sy / 2),
            (sx - t / 2, sy / 2, t / 2, sy / 2),
        ):
            g = body.add_geom(name=f"wall_{next(_names)}", type=mujoco.mjtGeom.mjGEOM_BOX, size=(hx, hy, h / 2), pos=(cx, cy, h / 2))
            geometries.append(TerrainGeometry(geom=g, color=WALL))

        centre = np.array([sx / 2, sy / 2])
        placed: list[tuple[np.ndarray, float]] = []  # circles covering what is placed, for the gaps between

        def cover(p: np.ndarray, hx: float, hy: float, yaw: float) -> list[tuple[np.ndarray, float]]:
            """Circles along a box's long side (a long box is not one big circle)."""
            long_, short = (hx, hy) if hx >= hy else (hy, hx)
            axis = np.array([math.cos(yaw), math.sin(yaw)]) if hx >= hy else np.array([-math.sin(yaw), math.cos(yaw)])
            k = max(1, math.ceil(long_ / max(short, 0.05)))
            return [(p + axis * (-long_ + (2 * i + 1) * long_ / k), math.hypot(long_ / k, short)) for i in range(k)]

        def fits(circles: list[tuple[np.ndarray, float]]) -> bool:
            for q, r in circles:
                if q.min() < t + r + 0.02 or q[0] > sx - t - r - 0.02 or q[1] > sy - t - r - 0.02:
                    return False
                if np.linalg.norm(q - centre) < self.clear_radius + r:
                    return False
                # A gap of at least a duck's width (0.18 m) to everything else, so every room has a way through.
                if any(np.linalg.norm(q - q2) < r + r2 + 0.18 for q2, r2 in placed):
                    return False
            return True

        def big(kind: str, count: int, size_x, size_y, size_z, colour) -> None:
            done = 0
            for _ in range(200):
                if done >= count:
                    return
                hx, hy, hz = rng.uniform(*size_x) / 2, rng.uniform(*size_y) / 2, rng.uniform(*size_z) / 2
                yaw = rng.uniform(0.0, math.pi)
                p = rng.uniform([t, t], [sx - t, sy - t])
                circles = cover(p, hx, hy, yaw)
                if not fits(circles):
                    continue
                g = body.add_geom(name=f"{kind}_{next(_names)}", type=mujoco.mjtGeom.mjGEOM_BOX, size=(hx, hy, hz), pos=(p[0], p[1], hz), quat=(math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)))
                geometries.append(TerrainGeometry(geom=g, color=colour))
                placed.extend(circles)
                done += 1

        lerp = lambda pair: int(round(pair[0] + difficulty * (pair[1] - pair[0])))  # noqa: E731
        big("obstacle", lerp(self.furniture), (0.5, 1.2), (0.3, 0.7), (0.25, 0.8), (0.55, 0.42, 0.3, 1.0))
        big("obstacle", lerp(self.partitions), (0.6, 1.6), (0.04, 0.06), (0.3, 0.5), WALL)
        n = lerp(self.count)
        small = 0
        for _ in range(400):
            if small >= n:
                break
            w, d = rng.uniform(*self.footprint, size=2)
            height = rng.uniform(*self.height)
            post = rng.random() < 0.3
            radius = w / 2 if post else 0.5 * math.hypot(w, d)
            p = rng.uniform([t + radius + 0.05] * 2, [sx - t - radius - 0.05, sy - t - radius - 0.05])
            if not fits([(p, radius)]):
                continue
            yaw = rng.uniform(0.0, math.pi)
            name = f"obstacle_{next(_names)}"
            if post:
                g = body.add_geom(name=name, type=mujoco.mjtGeom.mjGEOM_CYLINDER, size=(radius, height / 2, 0), pos=(p[0], p[1], height / 2))
            else:
                g = body.add_geom(
                    name=name,
                    type=mujoco.mjtGeom.mjGEOM_BOX,
                    size=(w / 2, d / 2, height / 2),
                    pos=(p[0], p[1], height / 2),
                    quat=(math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)),
                )
            geometries.append(TerrainGeometry(geom=g, color=COLOURS[small % len(COLOURS)]))
            placed.append((p, radius))
            small += 1
        return TerrainOutput(origin=np.array([sx / 2, sy / 2, 0.0]), geometries=geometries)
