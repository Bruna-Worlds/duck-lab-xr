# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""
Runs a Duck Lab XR scenario pack in Newton (NVIDIA, Google DeepMind and Disney
Research's GPU physics engine) with its MuJoCo-Warp solver, the engine NVIDIA
trained MicroDuck with: the pack's MJCF through Newton's importer, the walking
policy at 50 Hz from the pack's start state with the inputs the headset
recorded. Prints where Pip goes next to MuJoCo's run of the same pack
(tools/train/replay.mjs --trace) and writes newton-trace.json in the same
form, every body's pose included, so Isaac Sim's test case can show it too.

    node tools/train/replay.mjs <pack> --export <folder> --trace <folder>/mujoco-trace.json
    tools/newton/.venv/Scripts/python tools/newton/run_pack.py <folder> [--contacts mujoco|newton] [--policies a,b] [--device cpu]

--contacts mujoco (default) lets MuJoCo-Warp find the contacts, as MuJoCo
does; newton uses Newton's own collision pipeline, as NVIDIA's MicroDuck task
does. The state stays in MuJoCo's convention throughout: written into the
solver's MuJoCo data and converted by Newton, read back from it after each
step. Setup: tools/newton/README.md.
"""
import argparse
import json
import math
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "isaac", "scenario"))

parser = argparse.ArgumentParser()
parser.add_argument("folder", help="an exported pack (replay.mjs --export)")
parser.add_argument("--contacts", choices=["mujoco", "newton"], default="mujoco")
parser.add_argument("--device", default=None, help="cuda:0 (default when there is a GPU) or cpu")
parser.add_argument("--mujoco-cpu", action="store_true", help="step with MuJoCo C on the CPU instead of MuJoCo-Warp")
parser.add_argument("--out", default="newton-trace.json", help="trace file name in the folder (with several brains: -<label> added)")
parser.add_argument("--policies", help="policy folders, comma-separated (default: the folder's policies/); each runs in turn")
parser.add_argument("--labels", help="a name per policy folder, comma-separated (default: the folder names)")
parser.add_argument("--verbose", action="store_true", help="print the trunk every second")
args = parser.parse_args()

import mujoco  # noqa: E402
import numpy as np  # noqa: E402
import warp as wp  # noqa: E402

import newton  # noqa: E402
import pack_scene  # noqa: E402
from onnx_mlp import OnnxMlp  # noqa: E402


def log(*parts):
    print("[newton]", *parts, flush=True)


folder = os.path.abspath(args.folder)
tree, state = pack_scene.load(folder)
control = state["control"]
N = control["numJoints"]
DEC = control["decimation"]
DEFAULT = np.array(control["defaultPose"], dtype=np.float32)
DT = control["ctrlDt"] / DEC  # the pack's physics step (Newton's MuJoCo model keeps MuJoCo's default timestep)
wp.config.quiet = True
wp.init()
device = args.device or ("cuda:0" if wp.get_cuda_device_count() > 0 else "cpu")

# Newton reads a height field's grid size from its attributes; the export names only the file.
with open(os.path.join(folder, "scene.xml"), encoding="utf-8") as f:
    xml = f.read()
terrain_bin = os.path.join(folder, "assets", "terrain.bin")
if not os.path.exists(terrain_bin):  # exports before 2026-10-26 kept it beside scene.xml
    terrain_bin = os.path.join(folder, "terrain.bin")
if os.path.exists(terrain_bin):
    with open(terrain_bin, "rb") as f:
        nrow, ncol = np.frombuffer(f.read(8), dtype="<i4")
    xml = re.sub(r'(<hfield\b[^>]*\bfile="terrain\.bin")', rf'\1 nrow="{int(nrow)}" ncol="{int(ncol)}"', xml)
scene_xml = os.path.join(folder, "newton-scene.xml")
with open(scene_xml, "w", encoding="utf-8") as f:
    f.write(xml)

builder = newton.ModelBuilder(up_axis=newton.Axis.Z)
newton.solvers.SolverMuJoCo.register_custom_attributes(builder)
# Newton's pipeline finds contacts this far before touching (0.1 m by default): none for a 12 cm robot,
# as in Newton's policy example and NVIDIA's MicroDuck task (shape margin 0).
builder.rigid_gap = 0.0
builder.add_mjcf(scene_xml, ctrl_direct=True)
model = builder.finalize(device=device)
solver = newton.solvers.SolverMuJoCo(model, use_mujoco_contacts=args.contacts == "mujoco", use_mujoco_cpu=args.mujoco_cpu)
mjm = solver.mj_model
data = solver.mj_data if args.mujoco_cpu else solver.mjw_data
log(f"Newton {newton.__version__} on {device}, MuJoCo-{'C' if args.mujoco_cpu else 'Warp'}, contacts: {args.contacts}; "
    f"{mjm.nbody} bodies, {mjm.njnt} joints, {mjm.nu} actuators, {mjm.ngeom} geoms, timestep {DT}")

names = {t: [mujoco.mj_id2name(mjm, t, i) or "" for i in range(n)] for t, n in [
    (mujoco.mjtObj.mjOBJ_JOINT, mjm.njnt), (mujoco.mjtObj.mjOBJ_BODY, mjm.nbody), (mujoco.mjtObj.mjOBJ_ACTUATOR, mjm.nu)]}


def find(kind, name):
    """An object's id in the solver's MuJoCo model (Newton names them by their path, joined by _ or /)."""
    found = [i for i, n in enumerate(names[kind]) if n == name or n.endswith("/" + name) or n.endswith("_" + name)]
    if not found:
        raise KeyError(f"{name} is not in Newton's model ({names[kind][:6]}...)")
    return found[0]


J, B, A = mujoco.mjtObj.mjOBJ_JOINT, mujoco.mjtObj.mjOBJ_BODY, mujoco.mjtObj.mjOBJ_ACTUATOR
addr = pack_scene.addresses(tree)  # the pack's own qpos/qvel layout
SIZES = {mujoco.mjtJoint.mjJNT_FREE: (7, 6), mujoco.mjtJoint.mjJNT_BALL: (4, 3)}
moves = []  # (pack qpos, pack dof, our qpos, our dof, nq, nv)
for name, (q, d) in addr.items():
    j = find(J, name)
    nq, nv = SIZES.get(mjm.jnt_type[j], (1, 1))
    moves.append((q, d, mjm.jnt_qposadr[j], mjm.jnt_dofadr[j], nq, nv))
free_q, free_d = mjm.jnt_qposadr[find(J, control["freeJoint"])], mjm.jnt_dofadr[find(J, control["freeJoint"])]
QPOS = np.array([mjm.jnt_qposadr[find(J, n)] for n in control["jointNames"]])
DOF = np.array([mjm.jnt_dofadr[find(J, n)] for n in control["jointNames"]])
# Newton's actuators have no names: each is found by the joint it drives.
ACT = np.array([int(np.flatnonzero(mjm.actuator_trnid[:, 0] == find(J, n))[0]) for n in control["jointNames"]])
trace_names = [n for n in re.findall(r'<body name="([^"]+)"', xml)]
BODIES = []
for n in trace_names:
    try:
        BODIES.append((n, find(B, n)))
    except KeyError:
        pass

states = [model.state(), model.state()]
ctl = model.control()
pipeline = None
contacts = None
if args.contacts == "newton":
    pipeline = newton.CollisionPipeline(model, rigid_contact_max=solver.get_max_contact_count(), soft_contact_max=0)
    contacts = pipeline.contacts()


def host(array):
    return array.numpy() if hasattr(array, "numpy") else np.asarray(array)


def read():
    """qpos, qvel, xpos, xquat of the (only) world, in MuJoCo's convention."""
    if args.mujoco_cpu:
        return data.qpos.copy(), data.qvel.copy(), data.xpos.copy(), data.xquat.copy()
    return host(data.qpos)[0], host(data.qvel)[0], host(data.xpos)[0], host(data.xquat)[0]


def set_state(pack_qpos, pack_qvel):
    qpos, qvel = np.zeros(mjm.nq), np.zeros(mjm.nv)
    for q, d, mq, md, nq, nv in moves:
        qpos[mq : mq + nq] = pack_qpos[q : q + nq]
        qvel[md : md + nv] = pack_qvel[d : d + nv]
    if args.mujoco_cpu:
        data.qpos[:], data.qvel[:] = qpos, qvel
        mujoco.mj_forward(mjm, data)
    else:
        data.qpos.assign(qpos[None].astype(np.float32))
        data.qvel.assign(qvel[None].astype(np.float32))
        import mujoco_warp

        mujoco_warp.kinematics(solver.mjw_model, data)
    solver._update_newton_state(model, states[0], data, state_prev=states[0])
    newton.eval_fk(model, states[0].joint_q, states[0].joint_qd, states[0])


ctrl_array = ctl.mujoco.ctrl
ctrl_host = np.zeros(ctrl_array.shape, dtype=np.float32)


def command(targets):
    ctrl_host.reshape(-1)[ACT] = targets
    ctrl_array.assign(ctrl_host)


def substeps(snapshot):
    """The decimation's physics steps, with qvel copied into snapshot before the last (MuJoCo's
    sensors are computed then). An even count leaves the state in states[0]."""
    for s in range(DEC):
        if s == DEC - 1 and snapshot is not None:
            wp.copy(snapshot, data.qvel)
        if pipeline is not None:
            pipeline.collide(states[0], contacts)
        solver.step(states[0], states[1], ctl, contacts, DT)
        states.reverse()


graph = None
qvel_snapshot = None
if not args.mujoco_cpu and device.startswith("cuda") and wp.get_device(device).is_mempool_enabled and DEC % 2 == 0:
    # One CUDA graph per control step: hundreds of small kernel launches become one.
    qvel_snapshot = wp.empty_like(data.qvel)
    substeps(qvel_snapshot)  # warm up (compiles and allocates) before capturing
    with wp.ScopedCapture(device=device) as capture:
        substeps(qvel_snapshot)
    graph = capture.graph


def step_physics():
    """One control step; returns the gyro as MuJoCo's sensor has it (before the last physics step)."""
    if graph is not None:
        wp.capture_launch(graph)
        return host(qvel_snapshot)[0][free_d + 3 : free_d + 6].copy()
    gyro = None
    for s in range(DEC):
        if s == DEC - 1:
            _, qvel, _, _ = read()
            gyro = qvel[free_d + 3 : free_d + 6].copy()
        if pipeline is not None:
            pipeline.collide(states[0], contacts)
        solver.step(states[0], states[1], ctl, contacts, DT)
        states.reverse()
    return gyro


obs = np.zeros(control["obsSize"], dtype=np.float32)


def observe(gyro, last, cmd):
    qpos, qvel, _, _ = read()
    w, x, y, z = qpos[free_q + 3 : free_q + 7]
    obs[0:3] = gyro
    obs[3:6] = [-2 * (x * z - w * y), -2 * (y * z + w * x), -(1 - 2 * (x * x + y * y))]
    obs[6 : 6 + N] = qpos[QPOS] - DEFAULT
    obs[6 + N : 6 + 2 * N] = qvel[DOF]
    obs[6 + 2 * N : 6 + 3 * N] = last
    obs[6 + 3 * N :] = cmd
    return obs


def walked(xy):
    pts = np.array(xy[::25] + [xy[-1]])
    return float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())


def turned(quats):
    yaw = np.unwrap([math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) for w, x, y, z in quats])
    return math.degrees(yaw[-1] - yaw[0])


mujoco_trace = None
if os.path.exists(os.path.join(folder, "mujoco-trace.json")):
    with open(os.path.join(folder, "mujoco-trace.json"), encoding="utf-8") as f:
        mujoco_trace = json.load(f)


def run(walk, stand, label):
    """The pack once with one brain: its start state, every input the headset recorded."""
    start = state["start"]
    set_state(np.array(start["qpos"]), np.array(start["qvel"]))
    _, _, xpos0, _ = read()
    if mujoco_trace and label == labels[0]:
        errs = sorted(((float(np.linalg.norm(xpos0[b] - np.array(mujoco_trace["bodies"][n]["pos"]))) * 1000, n) for n, b in BODIES if n in mujoco_trace["bodies"]), reverse=True)
        log(f"start pose vs MuJoCo: {len(errs)} bodies, worst {errs[0][0]:.2f} mm ({errs[0][1]})")
    last = np.array(start["lastAction"], dtype=np.float32)
    twist = np.array(start["twistSmooth"], dtype=np.float32)
    head = np.array(start["headSmooth"], dtype=np.float32)
    cmd = np.zeros(control["cmdSize"], dtype=np.float32)
    free_dof = addr[control["freeJoint"]][1]
    gyro = np.array(start["qvel"][free_dof + 3 : free_dof + 6], dtype=np.float64)
    steps = state["steps"]
    fell_at, recovering, upright, printed = None, False, 0, -1
    trunk, poses, seen = [], [], []
    ref = {round(r[0], 3): r for r in mujoco_trace["trunk"]} if mujoco_trace else {}
    wall = time.time()
    for row in steps:
        t, vx, wz, n0, n1, n2, n3 = row[:7]
        twist[0] += control["twistAlpha"] * (vx - twist[0])
        twist[2] += control["twistAlpha"] * (wz - twist[2])
        head += control["headAlpha"] * (np.array([n0, n1, n2, n3], dtype=np.float32) - head)
        cmd[:] = 0
        qpos, _, _, _ = read()
        w, x, y, z = qpos[free_q + 3 : free_q + 7]
        gz = -(1 - 2 * (x * x + y * y))
        tipped = gz > -0.5 or qpos[free_q + 2] < 0.02
        if tipped and fell_at is None:
            fell_at = t - steps[0][0]
        if tipped and not recovering:
            recovering, last[:] = True, 0
        if recovering:
            upright = upright + 1 if gz < -0.85 else 0
            if upright >= 50:
                recovering, last[:] = False, 0
            policy = stand
        else:
            cmd[0:3] = twist
            cmd[3:7] = head
            policy = walk
        o = observe(gyro, last, cmd)
        seen.append([round(float(v), 4) for v in o])
        out = policy(o)[:N]
        if np.all(np.isfinite(out)):
            last[:] = out
        command(DEFAULT + last)
        gyro = step_physics()
        qpos, _, xpos, xquat = read()
        rel = round(t - steps[0][0], 3)
        trunk.append([rel, *qpos[free_q : free_q + 7].tolist(), 1 if tipped else 0])
        poses.append([round(float(v), 4) for _, b in BODIES for v in (*xpos[b], *xquat[b])])
        if args.verbose and int(rel) != printed:
            printed = int(rel)
            m = ref.get(rel)
            apart = f"  MuJoCo ({m[1]:.3f}, {m[2]:.3f}) {np.hypot(qpos[free_q] - m[1], qpos[free_q + 1] - m[2]) * 100:5.1f} cm apart" if m else ""
            log(f"t={rel:5.1f} s  trunk ({qpos[free_q]:.3f}, {qpos[free_q + 1]:.3f}, {qpos[free_q + 2]:.3f}){'  TIPPED' if tipped else '        '}{apart}")
    wall = time.time() - wall
    summary = {
        "brain": label,
        "engine": f"newton {newton.__version__} ({'mujoco-c' if args.mujoco_cpu else 'mujoco-warp'}, {args.contacts} contacts, {device})",
        "steps": len(trunk),
        "seconds": round(len(trunk) * DT * DEC, 2),
        "wallSeconds": round(wall, 1),
        "fellAt": None if fell_at is None else round(fell_at, 2),
        "end": [round(v, 3) for v in trunk[-1][1:4]],
        "walkedM": round(walked([r[1:3] for r in trunk]), 3),
        "turnedDeg": round(turned([r[4:8] for r in trunk])),
    }
    if mujoco_trace and label == labels[0]:
        rows = mujoco_trace["trunk"][: len(trunk)]
        summary.update({
            "mujocoFellAt": mujoco_trace.get("fellAt"),
            "mujocoWalkedM": round(walked([r[1:3] for r in rows]), 3),
            "mujocoTurnedDeg": round(turned([r[4:8] for r in rows])),
            "apartM": round(float(np.hypot(trunk[-1][1] - rows[-1][1], trunk[-1][2] - rows[-1][2])), 3),
        })
        groups = [("gyro", 0, 3), ("gravity", 3, 6), ("joint pos", 6, 6 + N), ("joint vel", 6 + N, 6 + 2 * N)]
        for k in (0, 1, 5, 25, 100):
            if k < min(len(seen), len(mujoco_trace.get("obs", []))):
                a, b = np.array(seen[k]), np.array(mujoco_trace["obs"][k])
                log(f"  obs step {k:3d}: " + "  ".join(f"{g} {float(np.abs(a[i:j] - b[i:j]).mean()):.3f}/{float(np.abs(b[i:j]).mean()):.3f}" for g, i, j in groups))
    log(
        f"{label}: {summary['seconds']} s of the pack in {summary['wallSeconds']} s; walked {summary['walkedM']} m, turned {summary['turnedDeg']} deg, "
        + (f"first tipped at t={summary['fellAt']} s" if fell_at is not None else "never tipped")
        + (f" (MuJoCo: {summary['mujocoWalkedM']} m, {summary['mujocoTurnedDeg']} deg, " + (f"tipped at {summary['mujocoFellAt']:.1f} s)" if summary.get("mujocoFellAt") is not None else "never tipped)") if "mujocoWalkedM" in summary else "")
    )
    print(json.dumps(summary), flush=True)
    out = args.out if len(labels) == 1 else args.out.replace(".json", f"-{label}.json")
    with open(os.path.join(folder, out), "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "trunk": trunk, "bodyNames": [n for n, _ in BODIES], "poses": poses, "obs": seen, "fellAt": summary["fellAt"]}, f)
    return summary


# --- Each brain in turn, on the same model and captured physics -------------------
dirs = [d for d in (args.policies or os.path.join(folder, "policies")).split(",") if d]
labels = [x for x in args.labels.split(",") if x] if args.labels else [os.path.basename(os.path.normpath(d)) for d in dirs]
if len(labels) != len(dirs):
    raise SystemExit("--labels: one per --policies folder")
for directory, label in zip(dirs, labels):
    run(OnnxMlp(os.path.join(directory, "walk.onnx")), OnnxMlp(os.path.join(directory, "stand.onnx")), label)
