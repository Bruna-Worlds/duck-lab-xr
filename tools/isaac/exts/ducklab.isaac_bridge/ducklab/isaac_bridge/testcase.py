"""Test cases: a scenario pack the headset captured, run under PhysX in the open stage
(Isaac Sim 4.x), beside MuJoCo's run of the same pack as an orange ghost Pip.

The trainer (tools/lab/server.mjs) exports the pack and MuJoCo's run of it
(tools/train/replay.mjs --export --trace) and posts the folder here. The test
case builds it under /World/DuckLabTest with tools/isaac/scenario/pack_physx.py:
Pip through Isaac Sim's MJCF importer as a PhysX articulation, the floor,
course and terrain as colliders, the ball, and the ghost. The live mirror
(/World/DuckLab) is hidden meanwhile. Then the walking policy drives the
PhysX Pip at 50 Hz in real time, from the pack's start state with the inputs
the headset recorded, while the ghost replays MuJoCo's poses step by step.
"""
import asyncio
import importlib
import os
import sys
import tempfile
import time
import traceback

import carb
import carb.settings
import omni.kit.app
import omni.usd
from pxr import Usd, UsdGeom, UsdPhysics

SCENARIO_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "scenario"))
ROOT = "/World/DuckLabTest"
MIRROR = "/World/DuckLab"
IMPORTER = "isaacsim.asset.importer.mjcf"
# Isaac Sim's MJCF importer keeps its prototypes at the stage's root: removed with the test case.
IMPORTER_ROOTS = ("/meshes", "/visuals", "/collisions")
RATE_SETTINGS = ("/app/runLoops/main/rateLimitEnabled", "/app/runLoops/main/rateLimitFrequency")
RENDER_DT = 1.0 / 30.0
# RTX Eco Mode stops drawing frames it judges unchanged; with a scene that changes every frame the
# stream then shows black frames between drawn ones. Off while a test case is up, then as it was.
ECO_SETTING = "/rtx/ecoMode/enabled"


def _pack_physx():
    """tools/isaac/scenario's modules, fresh (they change without Kit reloading this extension)."""
    if SCENARIO_DIR not in sys.path:
        sys.path.insert(0, SCENARIO_DIR)
    import onnx_mlp
    import pack_scene
    import pack_physx

    for module in (onnx_mlp, pack_scene, pack_physx):
        importlib.reload(module)
    return pack_physx


def _log(*parts):
    carb.log_info("[ducklab] test case: " + " ".join(str(p) for p in parts))


class TestCase:
    def __init__(self, focus=None, view=None):
        self._focus = focus  # the viewport camera follows this (a point in the stage)
        self._view = view or (lambda ui: None)  # Isaac Sim's panels in the stream, or the viewport alone
        self.state = "idle"  # building, waiting (for the renderer), running, done, error
        self.error = None
        self.folder = None
        self.title = None
        self.info = {}
        self.log = []
        self._task = None
        self._world = None
        self._run = None
        self._ghost = None
        self._trace = None
        self._substep = 0
        self._posed = None  # the control step the ghost and camera were last set for
        self._options = {}
        self._update = None
        self._started = 0.0
        self._wall = None
        self._mirror_was = None
        self._eco_before = None
        self._importer_roots = []
        self._made_scene = None

    # --- Status ---------------------------------------------------------------------

    @property
    def active(self):
        return self.state in ("building", "waiting", "running", "done")

    def status(self):
        run, out = self._run, {"state": self.state, "title": self.title, "folder": self.folder, "error": self.error, "info": self.info, "log": self.log[-12:]}
        if run is not None:
            step = run.scene.dt * run.scene.decimation
            out.update({"t": round(run.time(), 2), "duration": round(run.total * step, 2), "k": run.k, "of": run.total})
            if run.path:
                out["summary"] = run.summary(self._trace, self._wall)
                out["path"] = [[round(r[1], 3), round(r[2], 3)] for r in run.path[::5]]
            if self._trace:
                out["mujocoPath"] = [[round(r[1], 3), round(r[2], 3)] for r in self._trace["trunk"][::5]]
        return out

    def _note(self, *parts):
        line = " ".join(str(p) for p in parts)
        self.log.append(line)
        _log(line)

    # --- Start, again, stop -------------------------------------------------------------

    def start(self, folder, title=None, options=None):
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = asyncio.ensure_future(self._start(folder, title, options or {}))

    async def _start(self, folder, title, options):
        await self._teardown(restore_mirror=False)
        self.state, self.error, self.folder, self.title, self.info, self.log = "building", None, folder, title, {}, []
        self._options = options  # follow (camera), ghostMoves: switches for checks
        app = omni.kit.app.get_app()
        try:
            if not os.path.isfile(os.path.join(folder, "scene.xml")):
                raise FileNotFoundError(f"no exported pack in {folder}")
            manager = app.get_extension_manager()
            if not manager.is_extension_enabled(IMPORTER):
                manager.set_extension_enabled_immediate(IMPORTER, True)
            px = _pack_physx()
            from isaacsim.core.api import World
            from isaacsim.core.prims import SingleArticulation, SingleRigidPrim

            stage = omni.usd.get_context().get_stage()
            self._hide_mirror(stage)
            self._made_scene = not any(p.IsA(UsdPhysics.Scene) for p in stage.Traverse())
            self._importer_roots = [p for p in IMPORTER_ROOTS if not stage.GetPrimAtPath(p)]
            trace = px.load_trace(folder)
            dt = 0.005
            # World sets the app's frame rate cap and the stage's time codes: keep the live app's.
            settings = carb.settings.get_settings()
            before = {key: settings.get(key) for key in RATE_SETTINGS}
            codes = stage.GetTimeCodesPerSecond()
            World.clear_instance()
            world = World(physics_dt=dt, rendering_dt=RENDER_DT, stage_units_in_meters=1.0)
            await world.initialize_simulation_context_async()
            for key, value in before.items():
                if value is not None:
                    settings.set(key, value)
            stage.SetTimeCodesPerSecond(codes)
            # PhysX on the CPU, as run_pack.py: the GPU is the renderer's and the stream's, and one
            # small robot gains nothing there.
            physics = world.get_physics_context()
            physics.enable_gpu_dynamics(False)
            physics.set_broadphase_type("MBP")
            physics.set_solver_type("TGS")
            self._world = world
            option_keys = ("friction", "compliant", "hull_limit", "depenetration", "iterations", "vel_iterations", "contact_offset")
            scene = px.PackScene(stage, folder, ROOT, px.Options(**{k: options[k] for k in option_keys if options.get(k) is not None}), self._note)
            self._ghost = px.Ghost(scene, ROOT + "/Ghost", trace) if trace else None
            self._trace = trace
            pip = world.scene.add(SingleArticulation(prim_path=scene.articulation, name="ducklab_pip"))
            balls = {joint: world.scene.add(SingleRigidPrim(prim_path=path, name="ducklab_" + joint)) for joint, path in scene.loose.items()}
            await world.reset_async()
            await world.pause_async()
            run = px.PackRun(scene, pip, balls, self._note)
            self.info = run.configure()
            self.info["ghost"] = bool(self._ghost)
            self.info["fullModel"] = bool(scene.visuals)
            self._run = run
            world.add_physics_callback("ducklab_testcase", self._on_physics_step)
            self._update = app.get_update_event_stream().create_subscription_to_pop(self._on_update, name="ducklab test case")
            run.start()
            if self._ghost:
                self._ghost.pose(0)
            # The first time new materials show, RTX compiles their shaders and draws black: hold
            # Pip at the start until the viewport shows the scene, so the run is seen from its start.
            self.state = "waiting"
            self._view(False)
            settings = carb.settings.get_settings()
            if self._eco_before is None:
                self._eco_before = (settings.get(ECO_SETTING),)
            settings.set(ECO_SETTING, False)
            self.info["ecoModeWas"] = self._eco_before[0]
            drawn = await self._until_drawn()
            self._note("the viewport shows it" if drawn else "the viewport still looks dark: running anyway")
            await self._play()
        except asyncio.CancelledError:
            raise
        except Exception as err:
            self.state, self.error = "error", f"{type(err).__name__}: {err}"
            carb.log_error("[ducklab] test case failed: %s\n%s" % (err, traceback.format_exc()))

    async def _play(self):
        """From the pack's start: PhysX Pip in its start state, the ghost at MuJoCo's first step."""
        run = self._run
        run.start()
        if self._ghost:
            self._ghost.pose(0)
        self._substep = 0
        self._posed = None
        self._wall = None
        self._started = time.time()
        self.state = "running"
        await self._world.play_async()

    async def _until_drawn(self, timeout=90.0):
        """True once the viewport is not black (a small capture, every second or so)."""
        from omni.kit.viewport.utility import capture_viewport_to_file, get_active_viewport
        from PIL import Image

        viewport = get_active_viewport()
        if viewport is None:
            return False
        path = os.path.join(tempfile.gettempdir(), "ducklab-testcase-ready.png")
        start = time.time()
        while time.time() - start < timeout:
            if os.path.exists(path):
                os.remove(path)
            capture_viewport_to_file(viewport, path)
            size = -1
            for _ in range(60):
                await asyncio.sleep(0.05)
                if os.path.exists(path) and os.path.getsize(path) > 0 and os.path.getsize(path) == size:
                    break
                size = os.path.getsize(path) if os.path.exists(path) else -1
            try:
                with Image.open(path) as image:
                    small = image.convert("L").resize((64, 36))
                    if sum(small.getdata()) / (64 * 36) > 24:
                        return True
            except Exception:
                pass
            await asyncio.sleep(0.5)
        return False

    def again(self):
        if self._run is None or self._world is None:
            return False

        async def go():
            await self._world.pause_async()
            await self._play()

        asyncio.ensure_future(go())
        return True

    def stop(self):
        if self._task is not None and not self._task.done():
            self._task.cancel()
        asyncio.ensure_future(self._teardown(restore_mirror=True))

    async def _teardown(self, restore_mirror):
        self._update = None
        world, self._world = self._world, None
        self._run, self._ghost, self._trace = None, None, None
        if world is not None:
            try:
                world.remove_physics_callback("ducklab_testcase")
                await world.stop_async()
                world.clear_all_callbacks()
            except Exception as err:
                carb.log_warn("[ducklab] test case: stopping the world: %s" % err)
        try:
            from isaacsim.core.api import World

            World.clear_instance()
        except Exception:
            pass
        stage = omni.usd.get_context().get_stage()
        if stage is not None:
            stage.RemovePrim(ROOT)
            for path in self._importer_roots:
                stage.RemovePrim(path)
            self._importer_roots = []
            if self._made_scene:
                for prim in [p for p in stage.Traverse() if p.IsA(UsdPhysics.Scene)]:
                    stage.RemovePrim(prim.GetPath())
            if restore_mirror:
                self._show_mirror(stage)
                self._view(None)
                if self._eco_before is not None:
                    if self._eco_before[0] is None:
                        carb.settings.get_settings().destroy_item(ECO_SETTING)
                    else:
                        carb.settings.get_settings().set(ECO_SETTING, self._eco_before[0])
                    self._eco_before = None
        self._made_scene = None
        if restore_mirror:
            self.state, self.error, self.folder, self.title, self.info = "idle", None, None, None, {}

    def shutdown(self):
        """The extension is going (a hot reload, Kit closing): leave the stage as it was."""
        self.stop()

    # --- The mirror ---------------------------------------------------------------------

    def _hide_mirror(self, stage):
        prim = stage.GetPrimAtPath(MIRROR)
        if prim and prim.IsValid():
            imageable = UsdGeom.Imageable(prim)
            if self._mirror_was is None:
                self._mirror_was = imageable.GetVisibilityAttr().Get()
            imageable.MakeInvisible()

    def _show_mirror(self, stage):
        prim = stage.GetPrimAtPath(MIRROR)
        if prim and prim.IsValid() and self._mirror_was is not None:
            UsdGeom.Imageable(prim).GetVisibilityAttr().Set(self._mirror_was)
        self._mirror_was = None

    # --- Running ----------------------------------------------------------------------------

    def _on_physics_step(self, step_size):
        """Before each 5 ms physics step: every fourth, the policy's control step."""
        run = self._run
        if run is None or self.state != "running":
            return
        if self._substep % run.scene.decimation == 0:
            if self._substep > 0:
                run.after_steps()
            if not run.control_step():
                self._finish()
                return
        self._substep += 1

    def _finish(self):
        self.state = "done"
        self._wall = time.time() - self._started
        summary = self._run.summary(self._trace, self._wall)
        self._note(
            f"done: PhysX walked {summary['walkedM']} m, turned {summary['turnedDeg']} deg, "
            + (f"tipped at {summary['fellAt']} s" if summary["fellAt"] is not None else "stayed up")
            + (f"; MuJoCo walked {summary.get('mujocoWalkedM')} m, turned {summary.get('mujocoTurnedDeg')} deg" if self._trace else "")
        )
        world = self._world
        if world is not None:
            asyncio.ensure_future(world.pause_async())

    def _on_update(self, event):
        """Every frame: the ghost where MuJoCo had Pip at the same control step; the camera."""
        run = self._run
        if run is None or self.state not in ("waiting", "running", "done"):
            return
        k = max(0, run.k - 1)
        if k == self._posed:
            return  # nothing moved since the last frame (paused, or done)
        self._posed = k
        if self._ghost and self._options.get("ghostMoves", True):
            self._ghost.pose(k)
        if self._focus is None or not self._options.get("follow", True):
            return
        try:
            pos, _ = run.trunk()
            focus = [float(pos[0]), float(pos[1]), float(pos[2])]
            if self._trace and self._trace["trunk"]:
                m = self._trace["trunk"][min(k, len(self._trace["trunk"]) - 1)]
                # Between the two Pips while they are near each other; on the PhysX one once they part.
                if abs(m[1] - focus[0]) + abs(m[2] - focus[1]) < 0.6:
                    focus = [(focus[0] + m[1]) / 2, (focus[1] + m[2]) / 2, (focus[2] + m[3]) / 2]
            self._focus(focus)
        except Exception:
            pass
