# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
Runs a Duck Lab XR scenario pack in Isaac Sim, with PhysX doing the physics,
headless (pack_physx.py builds and drives it; the Duck Lab XR bridge does the
same live in the streaming Isaac Sim). Prints where Pip goes next to where
MuJoCo took him (the --trace of tools/train/replay.mjs) and writes
isaac-trace.json.

    node tools/train/replay.mjs <pack> --export <folder> --trace <folder>/mujoco-trace.json
    <Isaac Sim>/python.bat tools/isaac/scenario/run_pack.py <folder> [--stand 5] [--air]

Isaac Sim 4.5, headless. Close any other Isaac Sim first on a 16 GB PC.
"""
import argparse
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

parser = argparse.ArgumentParser()
parser.add_argument("folder", help="an exported pack (replay.mjs --export)")
parser.add_argument("--stand", type=float, default=0, help="first stand still this many seconds from the STAND pose")
parser.add_argument("--air", action="store_true", help="first the motor test in the air (needs mujoco-air.json)")
parser.add_argument("--iterations", type=int, default=32, help="PhysX position iterations for Pip")
parser.add_argument("--vel-iterations", type=int, default=4, help="PhysX velocity iterations for Pip")
parser.add_argument("--contact-offset", type=float, default=0.002)
parser.add_argument("--friction", type=float, help="one friction for Pip and the world instead of the MJCF's")
parser.add_argument("--hull-limit", type=int, help="vertices per convex hull of Pip's colliders (PhysX's default is 64)")
parser.add_argument("--compliant", help="stiffness,damping: compliant contacts on every material instead of rigid ones")
parser.add_argument("--depenetration", type=float, help="Pip's links' max depenetration velocity (m/s)")
parser.add_argument("--ghost", action="store_true", help="also build MuJoCo's run as a ghost Pip (as the live test case does)")
parser.add_argument("--policies", help="policy folders, comma-separated (default: the folder's policies/); each runs in turn")
parser.add_argument("--labels", help="a name per policy folder, comma-separated (default: the folder names)")
parser.add_argument("--usd", help="also save the stage here (flattened)")
parser.add_argument("--inspect", action="store_true", help="print the imported robot's prims and stop")
args, _ = parser.parse_known_args()

from isaacsim import SimulationApp  # noqa: E402

app = SimulationApp({"headless": True})

import numpy as np  # noqa: E402
import omni.usd  # noqa: E402
from isaacsim.core.api import World  # noqa: E402
from isaacsim.core.prims import SingleArticulation, SingleRigidPrim  # noqa: E402
from isaacsim.core.utils.extensions import enable_extension  # noqa: E402
from pxr import Usd  # noqa: E402

enable_extension("isaacsim.asset.importer.mjcf")
app.update()

import pack_physx  # noqa: E402
import pack_scene  # noqa: E402


def log(*parts):
    print("[pack]", *parts, flush=True)


folder = os.path.abspath(args.folder)
options = pack_physx.Options(
    contact_offset=args.contact_offset,
    friction=args.friction,
    compliant=tuple(float(v) for v in args.compliant.split(",")) if args.compliant else None,
    hull_limit=args.hull_limit,
    depenetration=args.depenetration,
    iterations=args.iterations,
    vel_iterations=args.vel_iterations,
)
mujoco = pack_physx.load_trace(folder)

# --- The stage ----------------------------------------------------------------
dt = next((float(o.get("timestep", 0.005)) for o in pack_scene.load(folder)[0].getroot().iter("option")), 0.005)
world = World(stage_units_in_meters=1.0, physics_dt=dt, rendering_dt=dt * 4, backend="numpy")
physics = world.get_physics_context()
physics.enable_gpu_dynamics(False)
physics.set_broadphase_type("MBP")
physics.set_solver_type("TGS")
stage = omni.usd.get_context().get_stage()
scene = pack_physx.PackScene(stage, folder, "/World/Pack", options, lambda *p: log(*p))
app.update()

if args.inspect:
    for prim in Usd.PrimRange(stage.GetPrimAtPath(scene.robot_path), Usd.TraverseInstanceProxies()):
        path = prim.GetPath().pathString
        depth = path.count("/")
        flags = ("I" if prim.IsInstance() else "") + ("p" if prim.IsInstanceProxy() else "")
        apis = ",".join(s.replace("PhysicsCollisionAPI", "Coll").replace("PhysicsArticulationRootAPI", "ARTROOT") for s in prim.GetAppliedSchemas())
        print(f"[tree] {'  ' * (depth - 2)}{prim.GetName()} <{prim.GetTypeName()}>{' ' + flags if flags else ''}{' [' + apis + ']' if apis else ''}", flush=True)
    app.close()
    raise SystemExit(0)

ghost = pack_physx.Ghost(scene, "/World/Pack/Ghost", mujoco) if args.ghost and mujoco else None
pip = world.scene.add(SingleArticulation(prim_path=scene.articulation, name="pip"))
balls = {joint: world.scene.add(SingleRigidPrim(prim_path=path, name=joint)) for joint, path in scene.loose.items()}
world.reset()
run = pack_physx.PackRun(scene, pip, balls, lambda *p: log(*p))
run.configure()
N, DEFAULT, IDX, DECIMATION = scene.N, scene.default, run.idx, scene.decimation
view = run.view


def step_physics():
    for _ in range(DECIMATION):
        world.step(render=False)


# --- Check: the same start pose puts every body where MuJoCo puts it ------------
state = scene.state
run.set_state(state["start"]["qpos"], state["start"]["qvel"])
world.step(render=False)  # one 5 ms step so the links report the new pose
if mujoco:
    transforms = view._physics_view.get_link_transforms().reshape(-1, 7)
    errors = []
    for i, name in enumerate(view.body_names):
        ref = mujoco["bodies"].get(name)
        if ref:
            errors.append((float(np.linalg.norm(transforms[i, :3] - np.array(ref["pos"]))) * 1000, name))
    errors.sort(reverse=True)
    log(f"start pose vs MuJoCo: {len(errors)} bodies, worst {errors[0][0]:.1f} mm ({errors[0][1]}), median {errors[len(errors) // 2][0]:.1f} mm")
    first = run.walk(np.array(mujoco["firstObs"], dtype=np.float32))[:N]
    log(f"policy vs onnxruntime: max difference {float(np.abs(first - np.array(mujoco['firstAction'])).max()):.1e}")
if ghost:
    ghost.pose(0)
    log(f"ghost: MuJoCo's run as {sum(t is not None for t in ghost.targets)} posed bodies over {ghost.count} steps")

# --- 0. The motors alone, in the air (mujoco-air-test.mjs does the same in MuJoCo) --
air_path = os.path.join(folder, "mujoco-air.json")
if args.air and os.path.exists(air_path):
    air = json.load(open(air_path))
    run.set_state(scene.stand_qpos(air["height"]), np.zeros(len(state["start"]["qvel"])))
    targets = np.asarray(pip.get_joint_positions(), dtype=np.float64).copy()
    targets[IDX] = DEFAULT + air["step"]
    view.set_joint_position_targets(targets[None])
    angles = []
    for _ in range(air["steps"]):
        world.step(render=False)
        angles.append(np.asarray(pip.get_joint_positions())[IDX].copy())
    ref = np.array(air["angles"])
    log("motors in the air, +0.2 rad step: joint angle moved, PhysX / MuJoCo (knee, hip pitch, ankle, head yaw)")
    for s in (1, 2, 5, 10, 20, 39):
        a, b = angles[s] - DEFAULT, ref[s] - DEFAULT
        log(f"  {(s + 1) * dt * 1000:4.0f} ms: " + "  ".join(f"{a[j]:+.3f}/{b[j]:+.3f}" for j in (3, 2, 4, 7)))

# --- 1. Stand still from the STAND pose -----------------------------------------
if args.stand > 0:
    run.set_state(scene.stand_qpos(), np.zeros(len(state["start"]["qvel"])))
    last = np.zeros(N, dtype=np.float32)
    zero = np.zeros(scene.control["cmdSize"], dtype=np.float32)
    lowest, worst_tilt = 1.0, -1.0
    for k in range(int(args.stand / (dt * DECIMATION))):
        run.act(run.walk, last, zero)
        step_physics()
        pos, quat = run.trunk()
        lowest, worst_tilt = min(lowest, pos[2]), max(worst_tilt, pack_physx.gravity_z(quat))
    pos, quat = run.trunk()
    tilt = math.degrees(math.acos(min(1, -pack_physx.gravity_z(quat))))
    log(
        f"STAND {args.stand:.0f} s, no command: trunk at ({pos[0]:.3f}, {pos[1]:.3f}, {pos[2]:.3f}), "
        f"lowest {lowest:.3f} m, leaning {tilt:.1f} deg now -> {'UP' if worst_tilt < -0.5 and lowest > 0.06 else 'FELL'}"
    )

# --- 2. The pack: its start state, every input the headset recorded, per brain -------
dirs = [d for d in (args.policies or "").split(",") if d] or [os.path.join(folder, "policies")]
labels = [x for x in (args.labels or "").split(",") if x] or [os.path.basename(os.path.normpath(d)) for d in dirs]
if len(labels) != len(dirs):
    raise SystemExit("--labels: one per --policies folder")
for directory, label in zip(dirs, labels):
    run.use_policies(directory)
    run.start()
    ref = {round(row[0], 3): row for row in mujoco["trunk"]} if mujoco else {}
    last_print = -1
    wall = time.time()
    while run.control_step():
        step_physics()
        rel, pos = run.after_steps()
        if ghost:
            ghost.pose(run.k - 1)
        if len(dirs) == 1 and int(rel) != last_print:
            last_print = int(rel)
            m = ref.get(rel)
            apart = f"  MuJoCo ({m[1]:.3f}, {m[2]:.3f}, {m[3]:.3f}) {np.linalg.norm(pos[:2] - np.array(m[1:3])) * 100:5.1f} cm apart" if m else ""
            log(f"t={rel:5.1f} s  trunk ({pos[0]:.3f}, {pos[1]:.3f}, {pos[2]:.3f}){'  TIPPED' if run.tipped else '        '}{apart}")
    wall = time.time() - wall

    first = label == labels[0]
    lines = run.compare_obs(mujoco) if first else []
    if lines:
        log("observation, PhysX vs MuJoCo (mean |difference| / mean |MuJoCo value|):")
        for line in lines:
            log(line)
    summary = {"brain": label, **run.summary(mujoco if first else None, wall)}
    log(
        f"PhysX, {label}: {summary['seconds']} s of the pack in {summary['wallSeconds']} s; walked {summary['walkedM']} m, turned {summary['turnedDeg']} deg, "
        + (f"first tipped at t={summary['fellAt']} s" if summary["fellAt"] is not None else "never tipped")
        + (f" (MuJoCo: {summary['mujocoWalkedM']} m, {summary['mujocoTurnedDeg']} deg, " + (f"tipped at {summary['mujocoFellAt']:.1f} s)" if summary.get("mujocoFellAt") is not None else "never tipped)") if "mujocoWalkedM" in summary else "")
    )
    print(json.dumps(summary), flush=True)
    out = "isaac-trace.json" if len(dirs) == 1 else f"isaac-trace-{label}.json"
    with open(os.path.join(folder, out), "w") as f:
        json.dump({"summary": summary, "trunk": run.path, "obs": [[round(float(v), 4) for v in o] for o in run.recorded]}, f)
if args.usd:
    stage.Flatten().Export(args.usd)
    log("stage saved to", args.usd)
app.close()
