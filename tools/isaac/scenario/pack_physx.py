# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
A scenario pack under PhysX in an open Isaac Sim 4.5 stage. Shared by
run_pack.py (standalone, headless) and the Duck Lab XR bridge's test cases
(the live, streaming Isaac Sim):

    scene = PackScene(stage, folder, "/World/DuckLabTest", Options(), log)  # before physics starts
    pip, balls = SingleArticulation(scene.articulation), SingleRigidPrims(scene.loose)  # added to the World
    run = PackRun(scene, pip, balls, log)                                  # after the World's reset
    run.configure(); run.start()
    while run.control_step():          # observation -> policy -> motor targets, 50 Hz
        <scene.decimation physics steps>
        run.after_steps()              # where the trunk went
    run.summary(mujoco_trace)

    ghost = Ghost(scene, "/World/DuckLabTest/Ghost", mujoco_trace)  # MuJoCo's run of the same pack
    ghost.pose(k)

Pip comes in through Isaac Sim's MJCF importer, with what it needs fixed
(pack_scene.robot_mjcf, and here: MuJoCo's motors as PhysX force drives, the
empty worldBody articulation removed); the floor, course pieces and terrain
become colliders and the ball a rigid body. Everything is in MuJoCo's frame,
so the stage must be Z up in metres (Isaac Sim's default).
"""
import base64
import json
import math
import os

import numpy as np
import omni.kit.commands
from pxr import Gf, PhysxSchema, Sdf, Usd, UsdGeom, UsdPhysics, UsdShade, Vt

import pack_scene
from onnx_mlp import OnnxMlp

DEG = math.pi / 180
COURSE_COLOR = (1.0, 0.75, 0.25)
FLOOR_COLOR = (0.34, 0.32, 0.30)  # as the live mirror's floor
TERRAIN_COLOR = (0.74, 0.62, 0.44)
GHOST_COLOR = (1.0, 0.48, 0.27)  # MuJoCo's run: orange, as on the trainer page's map
PHYSX_COLOR = (0.44, 0.72, 1.0)  # the PhysX run: sky blue, likewise


class Options:
    """How the contacts and the solver are set (run_pack.py's switches)."""

    def __init__(self, **kw):
        self.contact_offset = kw.get("contact_offset", 0.002)
        self.friction = kw.get("friction")  # one friction for everything instead of the MJCF's
        self.compliant = kw.get("compliant")  # (stiffness, damping) instead of rigid contacts
        self.hull_limit = kw.get("hull_limit")
        self.depenetration = kw.get("depenetration")
        self.iterations = kw.get("iterations", 32)
        self.vel_iterations = kw.get("vel_iterations", 4)


def quat_matrix(q):
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def gravity_z(quat):
    _, x, y, _ = quat
    return -(1 - 2 * (x * x + y * y))


def place(prim, pos, quat, scale=None):
    x = UsdGeom.Xformable(prim)
    x.ClearXformOpOrder()
    x.AddTranslateOp(UsdGeom.XformOp.PrecisionDouble).Set(Gf.Vec3d(*pos))
    x.AddOrientOp(UsdGeom.XformOp.PrecisionDouble).Set(Gf.Quatd(*quat))
    if scale is not None:
        x.AddScaleOp(UsdGeom.XformOp.PrecisionDouble).Set(Gf.Vec3d(*scale))


def paint(stage, robot_path, look):
    """One colour on an imported robot's visual meshes (the importer's own materials do not
    resolve). Its "visuals" prims are instanceable: those, and only those, are made plain prims
    so their meshes take a binding; the colliders stay as imported."""
    for _ in range(8):
        instances = [p for p in Usd.PrimRange(stage.GetPrimAtPath(robot_path)) if p.IsInstance() and "/visuals" in p.GetPath().pathString]
        if not instances:
            break
        for p in instances:
            p.SetInstanceable(False)
    # The importer binds its own material on each "visuals" prim (it wins over its meshes'): replace
    # that one, and the meshes' too. Never above "visuals": the colliders' physics material is there.
    for prim in Usd.PrimRange(stage.GetPrimAtPath(robot_path)):
        if prim.GetName() == "visuals" or (prim.IsA(UsdGeom.Mesh) and "/visuals" in prim.GetPath().pathString):
            UsdShade.MaterialBindingAPI.Apply(prim).Bind(look, UsdShade.Tokens.strongerThanDescendants)


def import_mjcf(robot_xml, prim_path):
    """Isaac Sim's MJCF importer, into the open stage; returns the robot's prim path."""
    _, config = omni.kit.commands.execute("MJCFCreateImportConfig")
    for name, value in [
        ("set_fix_base", False),
        ("set_import_inertia_tensor", True),
        ("set_self_collision", False),
        ("set_make_default_prim", False),
        ("set_create_physics_scene", False),
        ("set_distance_scale", 1.0),
        ("set_import_sites", False),
        ("set_convex_decomp", False),
    ]:
        if hasattr(config, name):
            getattr(config, name)(value)
    _, path = omni.kit.commands.execute("MJCFCreateAsset", mjcf_path=robot_xml, import_config=config, prim_path=prim_path)
    return path or prim_path


class PackScene:
    """A pack's world in the stage under root: Pip (PhysX articulation), colliders, the ball."""

    def __init__(self, stage, folder, root, options=None, log=print):
        if UsdGeom.GetStageUpAxis(stage) != UsdGeom.Tokens.z or abs((UsdGeom.GetStageMetersPerUnit(stage) or 1.0) - 1.0) > 1e-6:
            raise ValueError("a pack needs a stage that is Z up in metres (Isaac Sim's default)")
        self.stage, self.folder, self.root, self.log = stage, os.path.abspath(folder), root, log
        self.options = options or Options()
        self.tree, self.state = pack_scene.load(self.folder)
        self.control = self.state["control"]
        self.N = self.control["numJoints"]
        self.dt = 0.005
        for opt in self.tree.getroot().iter("option"):
            self.dt = float(opt.get("timestep", self.dt))
        self.decimation = self.control["decimation"]
        self.default = np.array(self.control["defaultPose"], dtype=np.float32)
        self.motor = pack_scene.motors(self.tree)
        self.addresses = pack_scene.addresses(self.tree)
        self.free_q, self.free_d = self.addresses[self.control["freeJoint"]]
        self.materials = {}
        stage.RemovePrim(root)
        parent = root.rsplit("/", 1)[0]
        if parent and not stage.GetPrimAtPath(parent):
            UsdGeom.Xform.Define(stage, parent)
        UsdGeom.Xform.Define(stage, root)
        UsdGeom.Scope.Define(stage, f"{root}/Physics")
        self.robot_xml = os.path.join(self.folder, "robot.xml")
        self.left_out = pack_scene.robot_mjcf(self.tree, self.control["freeJoint"], self.robot_xml)
        self.robot_path = import_mjcf(self.robot_xml, f"{root}/Pip")
        self.articulation = self._fix_robot()
        self.visuals = load_visuals(self.folder)
        self._dress_robot()
        self._drives()
        self.world = pack_scene.world(self.tree, self.folder, self.control["freeJoint"])
        self._statics()
        self.loose = self._balls()

    # --- Materials and colliders -----------------------------------------------------

    def _material(self, friction):
        if self.options.friction is not None:
            friction = self.options.friction
        key = round(friction, 4)
        if key in self.materials:
            return self.materials[key]
        mat = UsdShade.Material.Define(self.stage, f"{self.root}/Physics/Friction_{len(self.materials)}")
        api = UsdPhysics.MaterialAPI.Apply(mat.GetPrim())
        api.CreateStaticFrictionAttr(friction)
        api.CreateDynamicFrictionAttr(friction)
        api.CreateRestitutionAttr(0.0)
        px = PhysxSchema.PhysxMaterialAPI.Apply(mat.GetPrim())
        px.CreateFrictionCombineModeAttr("max")  # MuJoCo takes the larger friction of the two geoms
        px.CreateRestitutionCombineModeAttr("min")
        if self.options.compliant:
            k, c = self.options.compliant
            px.CreateCompliantContactStiffnessAttr(float(k))
            px.CreateCompliantContactDampingAttr(float(c))
        self.materials[key] = mat
        return mat

    def _collider(self, prim, friction=pack_scene.DEFAULT_FRICTION, approximation=None):
        UsdPhysics.CollisionAPI.Apply(prim)
        px = PhysxSchema.PhysxCollisionAPI.Apply(prim)
        px.CreateContactOffsetAttr(self.options.contact_offset)
        px.CreateRestOffsetAttr(0.0)
        if approximation:
            UsdPhysics.MeshCollisionAPI.Apply(prim).CreateApproximationAttr(approximation)
        UsdShade.MaterialBindingAPI.Apply(prim).Bind(self._material(friction), UsdShade.Tokens.weakerThanDescendants, "physics")

    def _look(self, color, emissive=0.0):
        path = f"{self.root}/Physics/Look_{'_'.join(str(int(c * 255)) for c in color)}_{int(emissive * 100)}"
        found = UsdShade.Material.Get(self.stage, path)
        if found:
            return found
        material = UsdShade.Material.Define(self.stage, path)
        shader = UsdShade.Shader.Define(self.stage, f"{path}/Surface")
        shader.CreateIdAttr("UsdPreviewSurface")
        shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*color))
        shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.6)
        if emissive:
            shader.CreateInput("emissiveColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(*(c * emissive for c in color)))
        material.CreateSurfaceOutput().ConnectToSource(shader.CreateOutput("surface", Sdf.ValueTypeNames.Token))
        return material

    # --- Pip ------------------------------------------------------------------------

    def _fix_robot(self):
        """Removes the importer's empty worldBody articulation; MuJoCo's contact distances and friction."""
        roots, empty, colliders = [], [], []
        for prim in Usd.PrimRange(self.stage.GetPrimAtPath(self.robot_path)):
            path = prim.GetPath().pathString
            if prim.HasAPI(UsdPhysics.ArticulationRootAPI):
                has_bodies = any(p.HasAPI(UsdPhysics.RigidBodyAPI) for p in Usd.PrimRange(prim))
                (roots if has_bodies else empty).append(path)
            # Each link's colliders are one instanceable "collisions" prim (merged convex hulls): editable itself.
            if prim.HasAPI(UsdPhysics.CollisionAPI):
                colliders.append(prim)
        for path in empty:
            self.stage.RemovePrim(path)
        for prim in colliders:
            self._collider(prim)
            if self.options.hull_limit:
                PhysxSchema.PhysxConvexHullCollisionAPI.Apply(prim).CreateHullVertexLimitAttr(self.options.hull_limit)
        if self.options.depenetration is not None:
            for prim in Usd.PrimRange(self.stage.GetPrimAtPath(self.robot_path)):
                if prim.HasAPI(UsdPhysics.RigidBodyAPI):
                    PhysxSchema.PhysxRigidBodyAPI.Apply(prim).CreateMaxDepenetrationVelocityAttr(self.options.depenetration)
        self.log(f"Pip imported at {self.robot_path}: {len(colliders)} colliders, articulation {roots}, removed empty {empty}, left out {self.left_out}")
        if len(roots) != 1:
            raise RuntimeError(f"expected one articulation with bodies, found {roots}")
        return roots[0]

    def _dress_robot(self):
        """How the PhysX Pip looks: Pollen's full model in its own colours (visuals.json, servos
        and all) instead of the MJCF's collision shells; without it, the shells in sky blue."""
        if not self.visuals:
            paint(self.stage, self.robot_path, self._look(PHYSX_COLOR, emissive=0.15))
            self.log("Pip: the MJCF's collision shells (no visuals.json)")
            return
        triangles = 0
        for prim in list(Usd.PrimRange(self.stage.GetPrimAtPath(self.robot_path))):
            if prim.IsValid() and prim.GetName() == "visuals":
                prim.SetActive(False)
            elif prim.HasAPI(UsdPhysics.RigidBodyAPI) and prim.GetName() in self.visuals["bodies"]:
                triangles += dress(self.stage, prim.GetPath().pathString, self.visuals["bodies"][prim.GetName()], self._look)
        self.log(f"Pip: Pollen's full model, {triangles} triangles")

    def _drives(self):
        """MuJoCo's position actuators as PhysX force drives. The importer writes drive "X" with
        MuJoCo's numbers, but a revolute joint's drive is "angular", and USD gives its stiffness
        and damping per degree (57 times too strong as written)."""
        redriven = 0
        for prim in Usd.PrimRange(self.stage.GetPrimAtPath(self.robot_path)):
            m = self.motor.get(prim.GetName())
            if not m or "kp" not in m or not prim.IsA(UsdPhysics.RevoluteJoint):
                continue
            for instance in ("X", "angular"):
                if prim.HasAPI(UsdPhysics.DriveAPI, instance):
                    prim.RemoveAPI(UsdPhysics.DriveAPI, instance)
            drive = UsdPhysics.DriveAPI.Apply(prim, "angular")
            drive.CreateTypeAttr("force")
            drive.CreateStiffnessAttr(m["kp"] * DEG)
            drive.CreateDampingAttr((m.get("kv", 0) + m["damping"]) * DEG)  # joint damping, as the drive's (target speed 0)
            drive.CreateMaxForceAttr(max(abs(v) for v in m["forcerange"]) if m.get("forcerange") else 1e3)
            PhysxSchema.PhysxJointAPI.Apply(prim).CreateArmatureAttr(m["armature"])
            redriven += 1
        self.log(f"{redriven} joints driven as MuJoCo's position actuators")

    # --- The world ------------------------------------------------------------------

    def _statics(self):
        group = f"{self.root}/Course"
        UsdGeom.Scope.Define(self.stage, group)
        skipped = []
        for i, s in enumerate(self.world["statics"]):
            if not s["collides"]:
                continue
            path = f"{group}/{(s['name'] or f'geom_{i}').replace('-', '_')}"
            t, size, pos, quat = s["type"], s["size"], s["pos"], s["quat"]
            color = tuple(s["rgba"][:3]) if s["rgba"] else COURSE_COLOR
            if t == "plane":
                prim = UsdGeom.Cube.Define(self.stage, path)
                prim.CreateSizeAttr(2.0)
                place(prim, [pos[0], pos[1], pos[2] - 0.1], [1, 0, 0, 0], [30, 30, 0.1])
                color = FLOOR_COLOR  # MuJoCo floors are textured white
            elif t == "box":
                prim = UsdGeom.Cube.Define(self.stage, path)
                prim.CreateSizeAttr(2.0)
                place(prim, pos, quat, size[:3])
            elif t in ("cylinder", "capsule"):
                prim = (UsdGeom.Cylinder if t == "cylinder" else UsdGeom.Capsule).Define(self.stage, path)
                prim.CreateRadiusAttr(size[0])
                prim.CreateHeightAttr(2 * size[1])
                prim.CreateAxisAttr("Z")
                place(prim, pos, quat)
            elif t == "sphere":
                prim = UsdGeom.Sphere.Define(self.stage, path)
                prim.CreateRadiusAttr(size[0])
                place(prim, pos, quat)
            elif t == "hfield":
                hf = self.world["hfields"][s["hfield"]]
                if float(hf["data"].max()) <= 0:
                    self.log(f"{s['name']}: height field is flat (all zero, {pos[2]:+.3f} m): left out")
                    continue
                points, triangles = pack_scene.mesh_grid(hf, pos)
                prim = UsdGeom.Mesh.Define(self.stage, path)
                prim.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(points))
                prim.CreateFaceVertexCountsAttr(Vt.IntArray([3] * len(triangles)))
                prim.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(triangles.reshape(-1)))
                prim.CreateSubdivisionSchemeAttr("none")
                UsdShade.MaterialBindingAPI.Apply(prim.GetPrim()).Bind(self._look(TERRAIN_COLOR))
                self._collider(prim.GetPrim(), s["friction"], "none")
                self.log(f"{s['name']}: height field as {len(triangles)} triangles, up to {float(points[:, 2].max()):.3f} m")
                continue
            else:
                skipped.append(f"{s['name'] or i} ({t})")
                continue
            UsdShade.MaterialBindingAPI.Apply(prim.GetPrim()).Bind(self._look(color))
            self._collider(prim.GetPrim(), s["friction"])
        if skipped:
            self.log("world shapes not built yet: " + ", ".join(skipped))

    def _balls(self):
        loose = {}
        for body in self.world["bodies"]:
            g = next((g for g in body["geoms"] if g["type"] == "sphere"), None)
            if not body["joint"] or g is None:
                self.log(f"body {body['name']}: only free spheres are built (left out)")
                continue
            path = f"{self.root}/{body['name']}"
            prim = UsdGeom.Sphere.Define(self.stage, path)
            prim.CreateRadiusAttr(g["size"][0])
            place(prim, body["pos"], body["quat"])
            UsdShade.MaterialBindingAPI.Apply(prim.GetPrim()).Bind(self._look(tuple(g["rgba"][:3]) if g["rgba"] else (0.95, 0.95, 0.95)))
            UsdPhysics.RigidBodyAPI.Apply(prim.GetPrim())
            UsdPhysics.MassAPI.Apply(prim.GetPrim()).CreateMassAttr(g["mass"] or 0.03)
            self._collider(prim.GetPrim(), g["friction"])
            loose[body["joint"]] = path
        return loose

    def stand_qpos(self, height=None):
        key = next(k for k in self.tree.getroot().iter("key") if k.get("name") == self.control.get("standKeyframe", "STAND"))
        qpos = [float(v) for v in key.get("qpos").split()]
        if height is not None:
            qpos[self.free_q + 2] = height
        return qpos


class PackRun:
    """The walking policy driving the PhysX Pip at 50 Hz from the pack's start state, with the
    inputs the headset recorded, as tools/train/replay.mjs drives MuJoCo's."""

    def __init__(self, scene, pip, balls, log=print):
        self.scene, self.pip, self.balls, self.log = scene, pip, balls, log
        self.view = pip._articulation_view
        c = scene.control
        self.control, self.N, self.default = c, scene.N, scene.default
        policies = os.path.join(scene.folder, "policies")
        self.walk = OnnxMlp(os.path.join(policies, "walk.onnx"))
        self.stand = OnnxMlp(os.path.join(policies, "stand.onnx"))
        self.obs = np.zeros(c["obsSize"], dtype=np.float32)
        self.steps = scene.state["steps"]
        self.recorded = None
        self.path = []
        self.k = 0

    def use_policies(self, directory):
        """Another brain: walk.onnx and stand.onnx from this folder."""
        self.walk = OnnxMlp(os.path.join(directory, "walk.onnx"))
        self.stand = OnnxMlp(os.path.join(directory, "stand.onnx"))

    def configure(self):
        """Joint order, MuJoCo's motors in SI (they match the USD drives) and the solver."""
        names = list(self.pip.dof_names)
        missing = [n for n in self.control["jointNames"] if n not in names]
        if missing:
            raise RuntimeError(f"joints missing from the articulation: {missing} (it has {names})")
        self.idx = np.array([names.index(n) for n in self.control["jointNames"]])
        ndof = self.ndof = len(names)
        kp, kd, effort, armature = np.zeros(ndof), np.zeros(ndof), np.full(ndof, 1e3), np.zeros(ndof)
        for name, i in zip(self.control["jointNames"], self.idx):
            m = self.scene.motor[name]
            kp[i] = m["kp"]
            kd[i] = m.get("kv", 0) + m["damping"]
            if m.get("forcerange"):
                effort[i] = max(abs(v) for v in m["forcerange"])
            armature[i] = m["armature"]
        parsed_kp, _ = self.view.get_gains()
        self.view.set_gains(kps=kp[None], kds=kd[None])
        self.view.set_max_efforts(effort[None])
        self.view.set_armatures(armature[None])
        self.view.set_max_joint_velocities(np.full((1, ndof), 1000.0))
        o = self.scene.options
        self.pip.set_solver_position_iteration_count(o.iterations)
        self.pip.set_solver_velocity_iteration_count(o.vel_iterations)
        self.pip.set_enabled_self_collisions(False)
        self.pip.set_sleep_threshold(0.0)
        self.pip.set_stabilization_threshold(0.0)
        masses = self.view.get_body_masses()[0]
        info = {
            "parsedKp": round(float(parsed_kp[0][self.idx[3]]), 4),
            "kp": round(float(kp[self.idx[3]]), 4),
            "massG": round(float(np.sum(masses)) * 1000),
            "bodies": len(masses),
        }
        self.log(f"drives as parsed: kp {info['parsedKp']} N m/rad (MuJoCo {info['kp']}); Pip weighs {info['massG']} g over {info['bodies']} bodies")
        return info

    # --- State ------------------------------------------------------------------------

    def set_state(self, qpos, qvel):
        qpos, qvel = np.asarray(qpos, dtype=np.float64), np.asarray(qvel, dtype=np.float64)
        fq, fd = self.scene.free_q, self.scene.free_d
        quat = qpos[fq + 3 : fq + 7]
        self.pip.set_world_pose(position=qpos[fq : fq + 3], orientation=quat)
        jp, jv = np.zeros(self.ndof), np.zeros(self.ndof)
        for name, i in zip(self.control["jointNames"], self.idx):
            q, d = self.scene.addresses[name]
            jp[i], jv[i] = qpos[q], qvel[d]
        self.pip.set_joint_positions(jp)
        self.pip.set_joint_velocities(jv)
        self.view.set_joint_position_targets(jp[None])
        # MuJoCo's free joint: linear velocity in the world, angular in the body's frame.
        self.pip.set_linear_velocity(qvel[fd : fd + 3])
        self.pip.set_angular_velocity(quat_matrix(quat) @ qvel[fd + 3 : fd + 6])
        for joint, ball in self.balls.items():
            q, d = self.scene.addresses[joint]
            if q + 7 <= len(qpos):
                ball.set_world_pose(position=qpos[q : q + 3], orientation=qpos[q + 3 : q + 7])
                ball.set_linear_velocity(qvel[d : d + 3])
                ball.set_angular_velocity(quat_matrix(qpos[q + 3 : q + 7]) @ qvel[d + 3 : d + 6])

    def trunk(self):
        pos, quat = self.pip.get_world_pose()
        return np.asarray(pos, dtype=np.float64), np.asarray(quat, dtype=np.float64)

    def observe(self, last_action, command):
        N, obs = self.N, self.obs
        _, quat = self.trunk()
        w, x, y, z = quat
        obs[0:3] = quat_matrix(quat).T @ np.asarray(self.pip.get_angular_velocity(), dtype=np.float64)  # the IMU's gyro
        obs[3:6] = [-2 * (x * z - w * y), -2 * (y * z + w * x), -(1 - 2 * (x * x + y * y))]
        obs[6 : 6 + N] = np.asarray(self.pip.get_joint_positions())[self.idx] - self.default
        obs[6 + N : 6 + 2 * N] = np.asarray(self.pip.get_joint_velocities())[self.idx]
        obs[6 + 2 * N : 6 + 3 * N] = last_action
        obs[6 + 3 * N :] = command
        return obs

    def act(self, policy, last_action, command):
        out = policy(self.observe(last_action, command))[: self.N]
        if self.recorded is not None:
            self.recorded.append(self.obs.copy())
        if not np.all(np.isfinite(out)):
            return
        last_action[:] = out
        targets = np.asarray(self.pip.get_joint_positions(), dtype=np.float64).copy()
        targets[self.idx] = self.default + out
        self.view.set_joint_position_targets(targets[None])

    # --- The pack's run -----------------------------------------------------------------

    def start(self):
        s = self.scene.state["start"]
        self.set_state(s["qpos"], s["qvel"])
        self.last = np.array(s["lastAction"], dtype=np.float32)
        self.twist = np.array(s["twistSmooth"], dtype=np.float32)
        self.head = np.array(s["headSmooth"], dtype=np.float32)
        self.command = np.zeros(self.control["cmdSize"], dtype=np.float32)
        self.fell_at, self.recovering, self.upright, self.tipped = None, False, 0, False
        self.path, self.recorded, self.k = [], [], 0

    @property
    def total(self):
        return len(self.steps)

    def time(self, k=None):
        """Seconds since the pack's start at control step k."""
        k = self.k if k is None else k
        return k * self.scene.dt * self.scene.decimation

    def control_step(self):
        """One control step's input: smoothing, falls (the stand policy until upright), the policy.
        False once every recorded step has been played."""
        if self.k >= len(self.steps):
            return False
        c = self.control
        t, vx, wz, n0, n1, n2, n3 = self.steps[self.k][:7]
        self.twist[0] += c["twistAlpha"] * (vx - self.twist[0])
        self.twist[2] += c["twistAlpha"] * (wz - self.twist[2])
        self.head += c["headAlpha"] * (np.array([n0, n1, n2, n3], dtype=np.float32) - self.head)
        self.command[:] = 0
        pos, quat = self.trunk()
        self.tipped = gravity_z(quat) > -0.5 or pos[2] < 0.02
        if self.tipped and self.fell_at is None:
            self.fell_at = t - self.steps[0][0]
        if self.tipped and not self.recovering:
            self.recovering = True
            self.last[:] = 0
        if self.recovering:
            self.upright = self.upright + 1 if gravity_z(quat) < -0.85 else 0
            if self.upright >= 50:
                self.recovering = False
                self.last[:] = 0
            self.act(self.stand, self.last, self.command)
        else:
            self.command[0:3] = self.twist
            self.command[3:7] = self.head
            self.act(self.walk, self.last, self.command)
        return True

    def after_steps(self):
        """After the control step's physics steps: where the trunk is."""
        pos, quat = self.trunk()
        rel = round(self.steps[self.k][0] - self.steps[0][0], 3)
        self.path.append([rel, *pos.tolist(), *quat.tolist(), 1 if self.tipped else 0])
        self.k += 1
        return rel, pos

    def summary(self, mujoco=None, wall=None):
        """How the PhysX run went, beside MuJoCo's (replay.mjs --trace)."""
        pos = self.path[-1][1:4] if self.path else [0, 0, 0]
        out = {
            "steps": len(self.path),
            "of": len(self.steps),
            "seconds": round(len(self.path) * self.scene.dt * self.scene.decimation, 2),
            "wallSeconds": None if wall is None else round(wall, 1),
            "fellAt": None if self.fell_at is None else round(self.fell_at, 2),
            "end": [round(v, 3) for v in pos],
            "walkedM": round(walked([row[1:3] for row in self.path], self.scene), 3) if self.path else 0,
            "turnedDeg": round(turned([row[4:8] for row in self.path])) if self.path else 0,
            "headsetEnd": [round(v, 3) for v in self.scene.state["end"]["qpos"][:3]],
            "reason": self.scene.state.get("reason"),
        }
        if mujoco:
            rows = mujoco["trunk"][: max(1, len(self.path))]
            out.update(
                {
                    "mujocoFellAt": mujoco["fellAt"] if mujoco.get("fellAt") is not None and mujoco["fellAt"] <= out["seconds"] + 1e-6 else None,
                    "mujocoEnd": [round(v, 3) for v in rows[-1][1:4]],
                    "mujocoWalkedM": round(walked([row[1:3] for row in rows], self.scene), 3),
                    "mujocoTurnedDeg": round(turned([row[4:8] for row in rows])),
                    "apartM": round(float(np.linalg.norm(np.array(pos[:2]) - np.array(rows[-1][1:3]))), 3),
                }
            )
        return out

    def compare_obs(self, mujoco):
        """Where the two simulators part: each part of the observation, step by step."""
        if not mujoco or not mujoco.get("obs") or not self.recorded:
            return []
        N = self.N
        groups = [("gyro", 0, 3), ("gravity", 3, 6), ("joint pos", 6, 6 + N), ("joint vel", 6 + N, 6 + 2 * N), ("action", 6 + 2 * N, 6 + 3 * N)]
        lines = []
        for k in [0, 1, 2, 3, 5, 10, 25, 50, 100, 200]:
            if k >= min(len(self.recorded), len(mujoco["obs"])):
                break
            a, b = self.recorded[k], np.array(mujoco["obs"][k], dtype=np.float32)
            lines.append(f"  step {k:3d}: " + "  ".join(f"{g} {float(np.abs(a[i:j] - b[i:j]).mean()):.3f}/{float(np.abs(b[i:j]).mean()):.3f}" for g, i, j in groups))
        return lines


def turned(quats):
    """How far the trunk turned about the vertical, in degrees (signed, left positive)."""
    yaw = np.unwrap([math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) for w, x, y, z in quats])
    return math.degrees(yaw[-1] - yaw[0])


def walked(xy, scene):
    """How far the trunk went over the floor, sampled every half second (steps sway it)."""
    pts = np.array(xy[:: max(1, int(0.5 / (scene.dt * scene.decimation)))] + [xy[-1]])
    return float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum()) if len(pts) > 1 else 0.0


def load_visuals(folder):
    """Pollen's full MicroDuck model per body (duck-visuals.mjs), when the folder has it."""
    path = os.path.join(folder, "visuals.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dress(stage, link_path, parts, look_for):
    """A body's parts (visuals.json: in the body's frame) as meshes under link_path/look;
    look_for(color) gives each part's material. Returns the triangle count."""
    group = f"{link_path}/look"
    UsdGeom.Xform.Define(stage, group)
    triangles = 0
    for i, part in enumerate(parts):
        points = np.frombuffer(base64.b64decode(part["points"]), dtype="<f4").reshape(-1, 3)
        indices = np.frombuffer(base64.b64decode(part["indices"]), dtype="<u4").astype(np.int32)
        normals = np.frombuffer(base64.b64decode(part["normals"]), dtype="<f4").reshape(-1, 3)
        mesh = UsdGeom.Mesh.Define(stage, f"{group}/part_{i}")
        mesh.CreatePointsAttr(Vt.Vec3fArray.FromNumpy(np.ascontiguousarray(points)))
        mesh.CreateFaceVertexCountsAttr(Vt.IntArray.FromNumpy(np.full(len(indices) // 3, 3, dtype=np.int32)))
        mesh.CreateFaceVertexIndicesAttr(Vt.IntArray.FromNumpy(indices))
        mesh.CreateNormalsAttr(Vt.Vec3fArray.FromNumpy(np.ascontiguousarray(normals)))
        mesh.SetNormalsInterpolation(UsdGeom.Tokens.faceVarying)
        mesh.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
        UsdShade.MaterialBindingAPI.Apply(mesh.GetPrim()).Bind(look_for(tuple(part["color"])))
        triangles += len(indices) // 3
    return triangles


def load_trace(folder):
    path = os.path.join(folder, "mujoco-trace.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class Ghost:
    """MuJoCo's run of the same pack (replay.mjs --trace: every body's pose at every step), as
    an orange Pip without physics beside the PhysX one."""

    def __init__(self, scene, path, trace, color=GHOST_COLOR):
        self.stage, self.trace = scene.stage, trace
        stage = scene.stage
        look = scene._look(color, emissive=0.15)
        links = {}
        if scene.visuals:
            # Pollen's full model (visuals.json), one orange: a plain transform per body, posed in the world.
            UsdGeom.Xform.Define(stage, path)
            for name, parts in scene.visuals["bodies"].items():
                prim = UsdGeom.Xform.Define(stage, f"{path}/{name}").GetPrim()
                dress(stage, prim.GetPath().pathString, parts, lambda _color: look)
                links[name] = prim
        else:
            # The collision shells only: the robot imported again, without physics.
            robot = import_mjcf(scene.robot_xml, path)
            for prim in Usd.PrimRange(stage.GetPrimAtPath(robot)):
                if prim.HasAPI(UsdPhysics.RigidBodyAPI):
                    links[prim.GetName()] = prim
            for _ in range(8):
                instances = [p for p in Usd.PrimRange(stage.GetPrimAtPath(robot)) if p.IsInstance()]
                if not instances:
                    break
                for p in instances:
                    p.SetInstanceable(False)
            for prim in list(Usd.PrimRange(stage.GetPrimAtPath(robot))):
                if not prim.IsValid():
                    continue
                if prim.GetName() in ("joints", "collisions", "worldBody"):
                    prim.SetActive(False)
                    continue
                for api in (UsdPhysics.ArticulationRootAPI, PhysxSchema.PhysxArticulationAPI, UsdPhysics.RigidBodyAPI, PhysxSchema.PhysxRigidBodyAPI, UsdPhysics.MassAPI):
                    if prim.HasAPI(api):
                        prim.RemoveAPI(api)
            paint(stage, robot, look)
        self.targets = []  # (translate op, orient op, parent world inverse) per traced body
        names = trace["bodyNames"] if trace else []
        for i, name in enumerate(names):
            prim = links.get(name)
            if prim is None and any(b["name"] == name and b["joint"] for b in scene.world["bodies"]):
                prim = self._ball(scene, f"{path}_{name}", name, look)
            if prim is None:
                self.targets.append(None)
                continue
            self.targets.append(self._ops(prim))
        self.count = len(trace["poses"]) if trace else 0

    def _ball(self, scene, path, name, look):
        body = next(b for b in scene.world["bodies"] if b["name"] == name)
        g = next(g for g in body["geoms"] if g["type"] == "sphere")
        prim = UsdGeom.Sphere.Define(self.stage, path)
        prim.CreateRadiusAttr(g["size"][0])
        place(prim, body["pos"], body["quat"])
        UsdShade.MaterialBindingAPI.Apply(prim.GetPrim()).Bind(look)
        return prim.GetPrim()

    @staticmethod
    def _ops(prim):
        xform = UsdGeom.Xformable(prim)
        translate = orient = None
        for op in xform.GetOrderedXformOps():
            if op.GetOpType() == UsdGeom.XformOp.TypeTranslate and translate is None:
                translate = op
            elif op.GetOpType() == UsdGeom.XformOp.TypeOrient and orient is None:
                orient = op
        if translate is None or orient is None:
            scale = None
            for op in xform.GetOrderedXformOps():
                if op.GetOpType() == UsdGeom.XformOp.TypeScale:
                    scale = op.Get()
            xform.ClearXformOpOrder()
            translate = xform.AddTranslateOp(UsdGeom.XformOp.PrecisionDouble)
            orient = xform.AddOrientOp(UsdGeom.XformOp.PrecisionDouble)
            if scale is not None:
                xform.AddScaleOp().Set(scale)
        parent = UsdGeom.Xformable(prim.GetParent()).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
        return translate, orient, parent.GetInverse()

    def pose(self, k):
        """Every body where MuJoCo had it after control step k."""
        if not self.count:
            return
        row = self.trace["poses"][max(0, min(k, self.count - 1))]
        with Sdf.ChangeBlock():
            for i, target in enumerate(self.targets):
                if target is None:
                    continue
                translate, orient, parent_inv = target
                p = row[i * 7 : i * 7 + 7]
                world = Gf.Matrix4d(Gf.Rotation(Gf.Quatd(p[3], p[4], p[5], p[6])), Gf.Vec3d(p[0], p[1], p[2]))
                local = world * parent_inv
                q = local.ExtractRotationQuat()
                translate.Set(local.ExtractTranslation() if translate.GetPrecision() == UsdGeom.XformOp.PrecisionDouble else Gf.Vec3f(local.ExtractTranslation()))
                orient.Set(q if orient.GetPrecision() == UsdGeom.XformOp.PrecisionDouble else Gf.Quatf(q))
