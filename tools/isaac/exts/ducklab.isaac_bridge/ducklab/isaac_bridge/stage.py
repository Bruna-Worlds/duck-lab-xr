# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""The Duck Lab XR scene in the open USD stage: the room's and the course's
colliders, the terrain, Pip's bodies and the ball, under one root prim.

Everything arrives in MuJoCo's world frame (Z up, metres); the root converts
to the stage's own up axis and units. Pip and the ball are posed every frame
(a kinematic mirror: the physics runs in Duck Lab XR's MuJoCo).
"""
import base64
import hashlib
import re

import numpy as np
from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdShade, Vt

ROOT_NAME = "DuckLab"
# Shapes without a colour of their own (the colliders, which the app does not draw)
# are shaded by what they most likely are: the floor, a wall, furniture, a course piece.
FLOOR_COLOR = (0.34, 0.32, 0.30)
WALL_COLOR = (0.78, 0.78, 0.76)
FURNITURE_COLOR = (0.50, 0.56, 0.64)
COURSE_COLOR = (1.0, 0.75, 0.25)  # Duck Lab's yellow
TERRAIN_COLOR = (0.74, 0.62, 0.44)


def shape_color(item):
    if item.get("kind") == "plane":
        return FLOOR_COLOR  # MuJoCo floors are textured (a white base colour); textures do not come over
    rgba = item.get("rgba") or [0, 0, 0, 0]
    if rgba[3] > 0.05:
        return rgba[:3]
    reach = max(float(v) for v in item.get("size", [0, 0, 0]))  # the largest half extent, radius or half length
    if reach > 1.0:
        return WALL_COLOR
    if reach > 0.3:
        return FURNITURE_COLOR
    return COURSE_COLOR
# Terrain cells lower than this are floor; only raised cells become mesh.
TERRAIN_FLOOR = 0.004


def floats(text):
    """A base64 string of little-endian float32 values."""
    return np.frombuffer(base64.b64decode(text), dtype="<f4")


def vec3f_array(points):
    """Pip has about 200 000 triangles: build USD arrays from numpy directly where USD allows."""
    points = np.ascontiguousarray(points, dtype=np.float32).reshape(-1, 3)
    for build in ("FromNumpy", "FromBuffer"):
        try:
            return getattr(Vt.Vec3fArray, build)(points)
        except Exception:
            pass
    return Vt.Vec3fArray([Gf.Vec3f(*p) for p in points.tolist()])


def int_array(values):
    values = np.ascontiguousarray(values, dtype=np.int32).reshape(-1)
    for build in ("FromNumpy", "FromBuffer"):
        try:
            return getattr(Vt.IntArray, build)(values)
        except Exception:
            pass
    return Vt.IntArray(values.tolist())


def prim_name(text, index):
    """A valid prim name from a MuJoCo name (which may be empty)."""
    clean = re.sub(r"[^A-Za-z0-9_]", "_", text or "")
    return "g%03d_%s" % (index, clean) if clean else "g%03d" % index


class DuckStage:
    """The scene under /World/DuckLab (or /DuckLab when the stage has no /World)."""

    def __init__(self, stage):
        self.stage = stage
        parent = "/World" if stage.GetPrimAtPath("/World").IsValid() else ""
        self.root = Sdf.Path(parent + "/" + ROOT_NAME)
        self.materials = {}
        self.body_names = []
        self.body_attrs = []  # (translate, orient) per body, in body_names order
        self.ball_attrs = None
        self.statics = 0
        self.terrain_faces = 0
        self._build_root()

    # --- Root, lights, materials ------------------------------------------------------

    def _build_root(self):
        stage = self.stage
        stage.RemovePrim(self.root)
        xform = UsdGeom.Xform.Define(stage, self.root)
        # MuJoCo is Z up in metres: match the stage's up axis and units.
        if UsdGeom.GetStageUpAxis(stage) == UsdGeom.Tokens.y:
            xform.AddRotateXOp().Set(-90.0)
        meters = UsdGeom.GetStageMetersPerUnit(stage) or 1.0
        if abs(meters - 1.0) > 1e-9:
            s = 1.0 / meters
            xform.AddScaleOp().Set(Gf.Vec3f(s, s, s))
        for name in ("Looks", "Statics", "Terrain", "Duck"):
            UsdGeom.Scope.Define(stage, self.root.AppendChild(name))
        # A soft sky for fill; a sun only when the stage has no light of its own
        # (Isaac Sim's default stage has one, and two would wash the scene out).
        lit = any(prim.HasAPI(UsdLux.ShapingAPI) or "Light" in prim.GetTypeName() for prim in stage.Traverse())
        lights = UsdGeom.Xform.Define(stage, self.root.AppendChild("Lights"))
        sky = UsdLux.DomeLight.Define(stage, lights.GetPath().AppendChild("Sky"))
        sky.CreateIntensityAttr(150.0 if lit else 300.0)
        if not lit:
            sun = UsdLux.DistantLight.Define(stage, lights.GetPath().AppendChild("Sun"))
            sun.CreateIntensityAttr(1200.0)
            sun.CreateAngleAttr(2.0)
            sun.AddRotateXYZOp().Set(Gf.Vec3f(35.0, 0.0, 30.0))

    def material(self, color, roughness=0.6, metallic=0.0):
        key = "%.3f %.3f %.3f %.2f %.2f" % (color[0], color[1], color[2], roughness, metallic)
        found = self.materials.get(key)
        if found:
            return found
        path = self.root.AppendChild("Looks").AppendChild("m" + hashlib.md5(key.encode()).hexdigest()[:10])
        material = UsdShade.Material.Define(self.stage, path)
        shader = UsdShade.Shader.Define(self.stage, path.AppendChild("Surface"))
        shader.CreateIdAttr("UsdPreviewSurface")
        shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*[float(c) for c in color[:3]]))
        shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(float(roughness))
        shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(float(metallic))
        output = shader.CreateOutput("surface", Sdf.ValueTypeNames.Token)
        material.CreateSurfaceOutput().ConnectToSource(output)
        self.materials[key] = material
        return material

    def _bind(self, prim, color, roughness=0.6, metallic=0.0):
        UsdShade.MaterialBindingAPI(prim).Bind(self.material(color, roughness, metallic))

    def _reset(self, name):
        """Empties one of the root's groups and returns its path."""
        path = self.root.AppendChild(name)
        self.stage.RemovePrim(path)
        UsdGeom.Scope.Define(self.stage, path)
        return path

    # --- The static scene ------------------------------------------------------------

    def set_statics(self, items):
        """Boxes, cylinders, spheres, capsules, ellipsoids and planes, posed in the world."""
        group = self._reset("Statics")
        made = 0
        for index, item in enumerate(items):
            prim = self._shape(group.AppendChild(prim_name(item.get("name"), index)), item)
            if prim is None:
                continue
            self._bind(prim, shape_color(item), 0.7)
            made += 1
        self.statics = made
        return made

    def _shape(self, path, item):
        kind = item.get("kind")
        size = [float(v) for v in item.get("size", [0, 0, 0])]
        stage = self.stage
        scale = None
        if kind == "box":
            geom = UsdGeom.Cube.Define(stage, path)
            geom.CreateSizeAttr(2.0)
            scale = size[:3]
        elif kind == "sphere":
            geom = UsdGeom.Sphere.Define(stage, path)
            r = size[0]
            geom.CreateRadiusAttr(r)
            geom.CreateExtentAttr([Gf.Vec3f(-r, -r, -r), Gf.Vec3f(r, r, r)])
        elif kind == "ellipsoid":
            geom = UsdGeom.Sphere.Define(stage, path)
            geom.CreateRadiusAttr(1.0)
            scale = size[:3]
        elif kind in ("cylinder", "capsule"):
            r, half = size[0], size[1]
            if kind == "cylinder":
                geom = UsdGeom.Cylinder.Define(stage, path)
                top = half
            else:
                geom = UsdGeom.Capsule.Define(stage, path)
                top = half + r
            geom.CreateRadiusAttr(r)
            geom.CreateHeightAttr(2.0 * half)
            geom.CreateAxisAttr(UsdGeom.Tokens.z)
            geom.CreateExtentAttr([Gf.Vec3f(-r, -r, -top), Gf.Vec3f(r, r, top)])
        elif kind == "plane":
            # MuJoCo planes are infinite when their size is 0: draw 6 m.
            hx = size[0] if size[0] > 0 else 6.0
            hy = size[1] if size[1] > 0 else 6.0
            geom = UsdGeom.Mesh.Define(stage, path)
            geom.CreatePointsAttr([Gf.Vec3f(-hx, -hy, 0), Gf.Vec3f(hx, -hy, 0), Gf.Vec3f(hx, hy, 0), Gf.Vec3f(-hx, hy, 0)])
            geom.CreateFaceVertexCountsAttr([4])
            geom.CreateFaceVertexIndicesAttr([0, 1, 2, 3])
            geom.CreateExtentAttr([Gf.Vec3f(-hx, -hy, 0), Gf.Vec3f(hx, hy, 0)])
            geom.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
        else:
            return None
        pos = item.get("pos", [0, 0, 0])
        quat = item.get("quat", [1, 0, 0, 0])
        geom.AddTranslateOp().Set(Gf.Vec3d(*[float(v) for v in pos]))
        geom.AddOrientOp().Set(Gf.Quatf(float(quat[0]), float(quat[1]), float(quat[2]), float(quat[3])))
        if scale:
            geom.AddScaleOp().Set(Gf.Vec3f(*scale))
        return geom.GetPrim()

    def set_terrain(self, terrain):
        """MuJoCo's height field as a mesh of its raised cells (rows run along y, first at -y)."""
        group = self._reset("Terrain")
        self.terrain_faces = 0
        if not terrain:
            return 0
        rows, cols = int(terrain["rows"]), int(terrain["cols"])
        half = float(terrain["half"])
        heights = floats(terrain["heights"]).reshape(rows, cols) * float(terrain["elev"])
        raised = heights > TERRAIN_FLOOR
        cells = raised[:-1, :-1] | raised[1:, :-1] | raised[:-1, 1:] | raised[1:, 1:]
        r, c = np.nonzero(cells)
        if r.size == 0:
            return 0
        quads = np.stack([r * cols + c, r * cols + c + 1, (r + 1) * cols + c + 1, (r + 1) * cols + c], axis=1).reshape(-1)
        used, local = np.unique(quads, return_inverse=True)
        xs = np.linspace(-half, half, cols)
        ys = np.linspace(-half, half, rows)
        points = np.stack([xs[used % cols], ys[used // cols], heights.reshape(-1)[used]], axis=1)
        mesh = UsdGeom.Mesh.Define(self.stage, group.AppendChild("Field"))
        mesh.CreatePointsAttr(vec3f_array(points))
        mesh.CreateFaceVertexCountsAttr(int_array(np.full(r.size, 4)))
        mesh.CreateFaceVertexIndicesAttr(int_array(local))
        mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
        lo, hi = points.min(axis=0), points.max(axis=0)
        mesh.CreateExtentAttr([Gf.Vec3f(*lo.tolist()), Gf.Vec3f(*hi.tolist())])
        pos = terrain.get("pos", [0, 0, 0])
        mesh.AddTranslateOp().Set(Gf.Vec3d(*[float(v) for v in pos]))
        self._bind(mesh.GetPrim(), TERRAIN_COLOR, 0.9)
        self.terrain_faces = int(r.size)
        return self.terrain_faces

    # --- Pip and the ball ------------------------------------------------------------

    def begin_duck(self, names):
        """New body prims for Pip, in the order later poses list them."""
        group = self._reset("Duck")
        self.body_names = list(names)
        self.body_attrs = []
        for index, name in enumerate(self.body_names):
            xform = UsdGeom.Xform.Define(self.stage, group.AppendChild(prim_name(name, index)))
            t = xform.AddTranslateOp(UsdGeom.XformOp.PrecisionDouble)
            o = xform.AddOrientOp(UsdGeom.XformOp.PrecisionDouble)
            t.Set(Gf.Vec3d(0, 0, -10))  # out of sight until the first pose
            o.Set(Gf.Quatd(1, 0, 0, 0))
            self.body_attrs.append((t.GetAttr(), o.GetAttr()))
        self.ball_attrs = None

    def add_body_meshes(self, name, meshes):
        """A body's triangles (in the body's frame), one mesh per material."""
        if name not in self.body_names:
            return 0
        index = self.body_names.index(name)
        body = self.root.AppendChild("Duck").AppendChild(prim_name(name, index))
        triangles = 0
        for k, part in enumerate(meshes):
            points = floats(part["points"]).reshape(-1, 3)
            count = points.shape[0] // 3
            if count == 0:
                continue
            mesh = UsdGeom.Mesh.Define(self.stage, body.AppendChild("part%02d" % k))
            mesh.CreatePointsAttr(vec3f_array(points[: count * 3]))
            mesh.CreateFaceVertexCountsAttr(int_array(np.full(count, 3)))
            mesh.CreateFaceVertexIndicesAttr(int_array(np.arange(count * 3)))
            if part.get("normals"):
                mesh.CreateNormalsAttr(vec3f_array(floats(part["normals"]).reshape(-1, 3)[: count * 3]))
                mesh.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
            mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
            lo, hi = points.min(axis=0), points.max(axis=0)
            mesh.CreateExtentAttr([Gf.Vec3f(*lo.tolist()), Gf.Vec3f(*hi.tolist())])
            self._bind(mesh.GetPrim(), part.get("color", [0.8, 0.8, 0.8]), part.get("roughness", 0.6), part.get("metalness", 0.0))
            triangles += count
        return triangles

    def set_ball(self, ball):
        path = self.root.AppendChild("Duck").AppendChild("ball")
        self.stage.RemovePrim(path)
        self.ball_attrs = None
        if not ball:
            return
        xform = UsdGeom.Xform.Define(self.stage, path)
        t = xform.AddTranslateOp(UsdGeom.XformOp.PrecisionDouble)
        o = xform.AddOrientOp(UsdGeom.XformOp.PrecisionDouble)
        t.Set(Gf.Vec3d(0, 0, -10))
        r = float(ball.get("radius", 0.05))
        # Two halves in two colours, so the ball is seen to roll.
        for name, color, z in (("top", ball.get("color", [1.0, 0.36, 0.54]), 1.0), ("bottom", ball.get("color2", [1.0, 0.96, 0.86]), -1.0)):
            cap = UsdGeom.Mesh.Define(self.stage, path.AppendChild(name))
            points, counts, indices = hemisphere(r, z)
            cap.CreatePointsAttr(points)
            cap.CreateFaceVertexCountsAttr(counts)
            cap.CreateFaceVertexIndicesAttr(indices)
            cap.CreateExtentAttr([Gf.Vec3f(-r, -r, -r), Gf.Vec3f(r, r, r)])
            self._bind(cap.GetPrim(), color, 0.45)
        self.ball_attrs = (t.GetAttr(), o.GetAttr())

    def set_pose(self, bodies, ball):
        """One frame: [x, y, z, qw, qx, qy, qz] per body (MuJoCo world frame), and the ball's."""
        with Sdf.ChangeBlock():
            for (t, o), p in zip(self.body_attrs, bodies):
                t.Set(Gf.Vec3d(p[0], p[1], p[2]))
                o.Set(Gf.Quatd(p[3], p[4], p[5], p[6]))
            if ball and self.ball_attrs:
                t, o = self.ball_attrs
                t.Set(Gf.Vec3d(ball[0], ball[1], ball[2]))
                o.Set(Gf.Quatd(ball[3], ball[4], ball[5], ball[6]))

    def to_stage(self, point):
        """A MuJoCo-frame point in the stage's world frame (for the camera)."""
        xform = UsdGeom.Xformable(self.stage.GetPrimAtPath(self.root))
        matrix = xform.ComputeLocalToWorldTransform(Usd.TimeCode.Default())
        return matrix.Transform(Gf.Vec3d(*point))

    def clear(self):
        self.stage.RemovePrim(self.root)


def hemisphere(r, z_sign, rings=8, segments=24):
    """A closed-enough half sphere on the +z or -z side (points, face counts, indices)."""
    points = []
    for i in range(rings + 1):
        phi = (np.pi / 2) * i / rings  # 0 at the equator, pi/2 at the pole
        for j in range(segments):
            theta = 2 * np.pi * j / segments
            points.append(Gf.Vec3f(r * np.cos(phi) * np.cos(theta), r * np.cos(phi) * np.sin(theta), z_sign * r * np.sin(phi)))
    counts, indices = [], []
    for i in range(rings):
        for j in range(segments):
            a = i * segments + j
            b = i * segments + (j + 1) % segments
            c = (i + 1) * segments + (j + 1) % segments
            d = (i + 1) * segments + j
            counts.append(4)
            # Outward winding on either side.
            indices.extend([a, b, c, d] if z_sign > 0 else [a, d, c, b])
    return points, counts, indices
