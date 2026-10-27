# Duck Lab XR packs in Newton

[Newton](https://github.com/newton-physics/newton) is the GPU physics engine
NVIDIA, Google DeepMind and Disney Research build together; its MuJoCo-Warp
solver is what NVIDIA trained MicroDuck with (Isaac Lab 3, GTC Berlin 2026).
`run_pack.py` replays a scenario pack in it: the pack's MJCF through Newton's
importer, the walking policy at 50 Hz from the pack's start state with the
inputs the headset recorded, on the RTX 3070 (or the CPU). It prints how far
Pip walked and turned and whether he tipped, beside MuJoCo's run of the same
pack, and writes the trace (every body's pose at every step).

## Set it up (once)

With [uv](https://docs.astral.sh/uv/) (Newton 1.7, Python 3.11, about 1.1 GB,
git-ignored):

```sh
uv venv tools/newton/.venv --python 3.11
uv pip install --python tools/newton/.venv/Scripts/python.exe "newton[sim,importers]"
```

`newton[sim]` brings MuJoCo-Warp and MuJoCo; `importers` reads the STL
meshes. Warp 1.18 runs on driver 580.88 (CUDA 13.0) here. The first run
compiles Newton's GPU kernels (about 40 s, then cached).

## Run a pack

```sh
node tools/train/replay.mjs <pack> --export <folder> --trace <folder>/mujoco-trace.json
tools/newton/.venv/Scripts/python tools/newton/run_pack.py <folder> [--contacts mujoco|newton] [--policies a,b --labels x,y] [--verbose]
```

- `--contacts mujoco` (default): MuJoCo-Warp finds the contacts, as MuJoCo
  does. `newton`: Newton's own collision pipeline, as NVIDIA's MicroDuck task
  uses (with no contact gap: Newton's default 0.1 m makes a 12 cm robot
  explode).
- `--policies`: several brains in one go, on the same model and GPU graph.
- `--mujoco-cpu`: Newton's importer with MuJoCo C stepping instead.

The state stays in MuJoCo's convention: it is written into the solver's
MuJoCo data and converted by Newton, and read back from it after each step
(Newton's own free joint keeps an xyzw quaternion, the centre of mass's
velocity and a world-frame angular velocity). Actuators are driven directly
(`ctrl_direct`), found by the joint they move (Newton leaves them unnamed);
joints and bodies are named by their path. The gyro is the free joint's
angular velocity just before the last physics step of each control step,
when MuJoCo computes its sensors. Each control step's four physics steps run
as one CUDA graph: a 17.7 s pack takes about 4 s (190 s without).

## What it shows

On 2026-10-26, the shipped brain on the "falls" pack (07-53-10): the start
pose matches MuJoCo's to 0.00 mm, and after one control step the gyro is
about 10% and the joint speeds 3% off MuJoCo's (PhysX: 58% and 48%).
Newton then walks Pip on longer than MuJoCo, which tips him into a book stack
at 8 s; on the mixed-reality walk pack (10-24 01-02-31) both walk him about
0.7 m and turn him about 20 degrees, with either contact pipeline.

MuJoCo-Warp computes in single precision with parallel sums, so two runs of
a pack are not bit for bit the same; a walk magnifies that over seconds.

`tools/train/cross-check.mjs` runs Newton with the other engines on many
packs and brains (`tools/train/README.md`).
