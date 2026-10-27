# Training round trip: headset -> desktop -> headset

The duck's simulator on the headset is real MuJoCo (WebAssembly) with the
real room in it: scanned walls and furniture, and a height field the depth
sensor fills in. When the duck struggles somewhere, the app packs that moment.
On the desktop, Duck Lab XR turns packs into training scenes, fine-tunes the
walking policy on them, and sends the result back; the headset offers it as
a "new brain" and swaps it in while the duck keeps walking.

```
headset (Duck Lab XR)                 desktop (this repo)                      headset
falls / stuck / X  --pack-->  artifacts/scenarios/  --Duck Lab XR-->  public/policies/incoming/<release>/
                              replay, train, export                index.json (active release)
                                                                    --poll--> "New brain ready" -> TRY IT
```

## 1. Scenario packs (headset -> desktop)

A pack is captured automatically after two falls within 20 s or when the
autopilot has made no progress for 8 s, and by hand with the X key or the lab
panel's "Pack scenario" button (`?lab=1`). It holds:

- `mjcf`: the exact scene the headset compiled (robot, course pieces, scanned
  walls and furniture, the terrain height field asset);
- `terrain`: the height field data (base64 float32, 201 x 201 cells, 4 cm);
- `start`: the sim state from 10-20 s before the capture (qpos, qvel, the
  policy's last action, the smoothed command), `steps`: every control step
  since (time, forward speed, turn rate, four head slots, move), and `end`:
  where the headset's sim ended, so a replay can be checked;
- the control convention (joint names, standing pose, observation layout,
  50 Hz with 4 physics steps) and which policy files drove the duck.

In development the pack is posted to the dev server and lands in
`artifacts/scenarios/` on the PC, also when the headset captured it. Duck
Lab also accepts packs on `POST http://localhost:8790/api/inbox` and through
its Import button.

## 2. Duck Lab XR (the desktop app)

```
npm run lab          # http://localhost:8790
```

A local web app (Node, nothing to install beyond `npm install`):

- **Inbox**: the packs (live: a new one flashes as the headset sends it) and
  the motion sets. Tick packs to train on.
- **Scene**: a top-down map of a pack (sensed terrain, course pieces, start,
  where the headset ended) and desktop replays in MuJoCo with the shipped
  brain (orange) or a trained one (mint), with where and when it fell.
- **Train**: the local fine-tune (section 3) on the ticked packs, with a live
  chart (score, falls, held-out falls) and the before/after numbers.
- **Releases**: trained brains; "Send to headset" makes one the active
  release, which the app offers to the player.
- **Export**: the ticked packs (and the motion sets) for any simulator or
  trainer, as one .zip (section 5).

It listens on 127.0.0.1 only.

## 3. Local fine-tune (CPU, minutes)

```
npm run finetune -- artifacts/scenarios/<a>.scenario.json [<b> ...] [--iterations 30] [--pairs 24] [--steps 900] [--name room-tuned] [--randomize pollen|basic] [--publish]
```

Evolution strategies (antithetic sampling, rank fitness, Adam) learn a
change to the last layer of Pollen's walking policy (14 x 128 weights and 14
biases; the policy is an MLP 61 -> 512 -> 256 -> 128 -> 14 with ELU and an
input normaliser). Each candidate runs the packs in MuJoCo on this PC from
their start states with the recorded commands, joint and velocity noise and
+-10% command noise, randomised one of two ways (`--randomize`, and the Train
card's Randomisation):

- **pollen** (the default): the domain randomisation of Pollen's and
  NVIDIA's MicroDuck recipe (Isaac Lab's `contrib/microduck/flat_env_cfg.py`
  and `robots/microduck.py`, after `pollen-robotics/microduck_rl`), as far as
  a MuJoCo position servo carries it. Per episode: foot friction 0.7-1.3,
  trunk mass x0.95-1.05, trunk and head centres of mass +-3 mm, joint
  friction and armature x0.9-1.1, encoder bias +-0.015 rad, battery 6.5-8.2
  V (the servos' gain and torque scale with it, 7.4 V nominal), a servo
  command delay of 3-6 physics steps, an IMU tilted up to 6 degrees and a
  step late or not. Per step: gyro noise +-0.03, gravity +-0.01, joint
  position +-0.001, joint velocity +-0.25 and a step late. And the trunk's
  velocity kicked by up to 0.3 m/s every 3-6 s. Episodes share one compiled
  model, so each episode's values are written into it before its physics
  steps (`PackEnv.applyModel`). Their backlash and BAM servo friction model
  are not in it.
- **basic**: the first recipe, two or three shoves of 0.8-2.5 N on the
  trunk. Bit for bit the episodes of before (checked against the committed
  `env.mjs`).

Under the pollen randomisation the shipped brain falls far more often (on
the falls pack, 7 of 12 eight-second episodes against 4 of 12). Reward
per step: 1 for staying up, forward-speed and turn-rate tracking,
penalties for jerky targets and body wobble; a fall ends the episode at -50.
Forked worker processes run batches of episodes side by side, with the
policy's 128 features computed in one batched onnxruntime call per step
(onnxruntime-node is not safe in worker threads, hence processes).

Before anything is released, the best candidate is compared with the
shipped policy on held-out seeds of the same packs and on plain floor (the
pack without its course pieces and terrain). It is released only if it
falls less (or scores higher without falling more) and does not fall more on
plain floor. The change is baked into `walk.onnx` (same graph, inputs and
outputs; only the last layer's weights differ) and checked against the
trained model with onnxruntime (max output difference about 1e-6).

First run on this PC (3 packs: one falls, one stuck, one manual; 30
iterations, 4.5 minutes on 11 processes): held-out falls 42% -> 4%, distance
0.38 -> 0.83 m, plain floor falls 0% -> 0%. Replay of the falls pack
without noise: the shipped brain falls after 7.7 s; the trained one stays up
for the whole 17.7 s.

## 4. Releases (desktop -> headset)

A release is a folder `public/policies/incoming/<id>/` with the full policy
set (trained `walk.onnx` plus the shipped files it did not change),
`ATTRIBUTION.md` and `manifest.json` (`duckdash.policyrelease.v1`: trainer,
packs, before/after numbers, file hashes). `public/policies/incoming/index.json`
(`duckdash.policies.v1`) lists the releases and names the active one.

```
node tools/train/release.mjs list | rescan | activate <id> | deactivate
```

The app polls the index in development (or with `?policyInbox=1`). When a new
release becomes active, the robot panel shows **New brain ready** with the
before/after fall rate; **TRY IT** swaps the policy files into the running sim
(no reload; the duck keeps walking), remembers the choice, and the panel
shows which brain runs with a **REVERT** button. `?policies=<folder>` still
forces a policy set for testing. Run records carry the walking policy's hash,
so runs with a trained brain are told apart.

### Publishing a release to the Hugging Face Hub (for a real duck)

A real Microduck installs policies from Hub model repos. On a release card in
Duck Lab XR, **Publish to Hugging Face** asks for a token with write access (used
once, not saved) and an optional repo name, then creates a public repo
`<you>/microduck-duckdash-<name>` with `policy.onnx` (the trained walk), the
duck's `manifest.json`, a README with the licence and Pollen's attribution, and
`ATTRIBUTION.md` (`tools/train/lib/hub.mjs`). The release's manifest records
the repo, the index exposes it as `hubRepo`, and the game's FLASH BRAIN uses
it (see "A real Microduck" in the main README). The endpoint only accepts requests from
the Lab's own page. `node tools/test/hub-publish-check.mjs` tests all of it
against a stand-in Hub.

## 5. Export: any simulator or trainer (MuJoCo, mjlab, Isaac, Genesis, Gymnasium)

The trainer's **Export** card picks a target (MuJoCo / MJX / MuJoCo
Playground, mjlab and Pollen's `microduck_rl`, Isaac Sim / Isaac Lab,
Genesis, Gymnasium + Stable-Baselines3, or any engine) and downloads one
.zip (`tools/train/lib/bundle.mjs`; also kept in `artifacts/connector/`):
`START_HERE.md` (the chosen target's quickstart first, then the others),
`job.json`, `python/` (`duck_env.py`, `train_ppo.py`, `replay.py`,
`requirements.txt`), `motion-sets/*.npz` when asked (obs N x 61, act N x 14,
episode lengths, success flags, as NumPy arrays), and per test case the folder
below plus `terrain.obj` and `obstacles.obj` (the room and the course as
meshes, Z up, metres) and `trajectory.csv` (the moment replayed with the
shipped brain: command, trunk pose, joint angles and targets per 20 ms step).
`node tools/test/export-check.mjs` builds one and checks it (the scene
compiles in MuJoCo, meshes, CSV, NumPy headers).

Per pack (also `node tools/train/replay.mjs <pack> --export <dir>`), a
folder any MuJoCo tool loads:

- `scene.xml` (meshdir `assets/`, height field in `assets/terrain.bin`:
  int32 nrow, int32 ncol, float32 data; MuJoCo looks for height field files
  in meshdir as for meshes, and rescales their data to 0-1, so the field's
  height range and the terrain geom's height are set for every cell to stand
  where it did on the headset; exports before 2026-10-26 had the file beside
  `scene.xml`, which MuJoCo itself could not open),
- `state.json` (control convention, start state, every recorded step, end
  state), `policies/` (the ONNX policies the duck ran),

plus `job.json` (`duckdash.trainjob.v1`) describing the task: observation and
action layout, episode start and randomisation, the reward above, and the
delivery format (ONNX, input `obs` [1, 61], output `actions` [1, 14], same
file names, in a release folder with a manifest). Check an export the way
another tool would load it:

```
node tools/train/check-export.mjs artifacts/connector/<job>/<pack>/
```

`tools/train/python/` is a reference PPO trainer (Stable-Baselines3 +
MuJoCo Python, GPU when available) that starts from the shipped weights and
writes a release; see the file header for the install line. It mirrors the
Node trainer but was not run on this PC (no Python here). MJX (Pollen's
`microduck_rl`) and Isaac Lab (MJCF importer) take the same `scene.xml`.

Cloud training would be the same contract, with the folders in object storage
and a job queue.

## 6. Motion training sets (headset or desktop -> trainer)

A keyframe motion (`public/motions/<name>.json`) plays as offsets on top of
the balancing walker. "Export bow set" on the lab panel (`?lab=1`, or the
U key) plays it from randomized standing starts on a copy of the sim and
records every control step: the walker's 61-value observation and the
total target offset applied (walker plus keyframe). The pack
(`duckdash.dataset.v1`, in `artifacts/datasets/`) holds `obs` and `act`
as base64 float32 (row-major, `steps x 61` and `steps x 14`), the episode
lengths, a stood-at-the-end flag per episode, the motion file and the
control convention.

```python
import base64, json, numpy as np
p = json.load(open("artifacts/datasets/<file>.dataset.json"))
obs = np.frombuffer(base64.b64decode(p["obs"]), np.float32).reshape(-1, p["control"]["obsSize"])
act = np.frombuffer(base64.b64decode(p["act"]), np.float32).reshape(-1, p["control"]["numJoints"])
ok = np.array(p["successFlags"], bool)      # one per episode
lengths = np.array(p["episodeLengths"])     # steps per episode, in order
```

Behaviour cloning on `(obs, act)` gives a policy that performs the motion on
its own (same observation as the shipped policies, so it exports to the same
ONNX convention).

## 7. Replay a pack from the command line

```
node tools/train/replay.mjs artifacts/scenarios/<pack>.scenario.json [--policies <folder>]
```

Runs the pack with the same policies (onnxruntime-node) and prints how far
from the headset's end state it finished. Sim-to-sim drift of a few
centimetres over 20 s is normal: MuJoCo is deterministic, but the policy's
floating point differs between the WebAssembly and native runtimes, and a
fall amplifies any difference.

## 8. Cross-check: brains in other physics engines

```sh
node tools/train/cross-check.mjs --packs <a.scenario.json,...> [--brains shipped,<release id>,...]
     [--engines mujoco,pollen,newton,newton-nc,physx] [--seeds 8] [--out artifacts/cross-check/<name>]
```

Each brain on each pack, replayed with the inputs the headset recorded, in
`mujoco` (as the headset runs it, `replay.mjs`), `pollen` (MuJoCo with the
pollen randomisation, `--seeds` episodes over the pack's length, an episode
ending at a fall), `newton` and `newton-nc` (Newton's MuJoCo-Warp on the GPU
with MuJoCo's contacts or Newton's own, `tools/newton/README.md`) and `physx`
(Isaac Sim 4.5, `tools/isaac/README.md`; only when no Isaac Sim is running).
Engines not set up are left out. It prints how far each walked and turned
and whether it tipped, then a table, and writes `results.json`. The trainer
page's **Cross-check** card runs it on the ticked packs, and every new
release gets a quick one (MuJoCo, randomised MuJoCo, Newton) against the
shipped brain, kept in its manifest and shown under it.

First run (2026-10-26), the shipped brain and two fine-tunes of 30
iterations on 3 packs (falls 07-53-10, stuck 07-43-01, manual 07-36-31), one
with each randomisation, on those 3 and 3 held-out packs (mixed-reality
walks 10-24 01-02-31 and 10-22 22-33-11, stuck 10-22 19-24-24); falls are
packs tipped on, or for `pollen` the share of 8 randomised episodes per pack:

| Brain | MuJoCo | MuJoCo + randomisation | Newton | Newton (its contacts) | PhysX |
| --- | --- | --- | --- | --- | --- |
| shipped | 1 of 6 | 31% | 0 of 6 | 0 of 6 | 0 of 6 |
| fine-tune, basic | 1 of 6 | 35% | 0 of 6 | 0 of 6 | 1 of 6 |
| fine-tune, pollen | 0 of 6 | 40% | 1 of 6 | 0 of 6 | 0 of 6 |

The fine-tunes fix the packs they trained on (the pollen one no longer falls
on any pack in MuJoCo) but are no sturdier elsewhere: a change to the last
layer alone (1,806 numbers) from three moments does not make a brain robust,
which takes training the whole network (section 9). Newton and PhysX were
gentler than MuJoCo on these packs: the shipped brain fell in neither.

## 9. Other trainers (the connector)

The Train card's **Trainer** picks who trains (`tools/train/lib/trainers.mjs`).
Whoever it is, the result is a `walk.onnx` with the walking contract (61
observations in, 14 joint targets out, 50 Hz, Pollen's layout): the trainer
page checks that contract, makes it a release beside the shipped policies it
did not train (with a manifest naming the trainer), and cross-checks it
against the shipped brain in MuJoCo, MuJoCo with the pollen randomisation and
Newton (section 8) before anyone sends it to the headset. A release from an
outside trainer is never offered by itself.

- **Duck Lab fine-tune**: section 3, built in.
- **Command trainers**: run on this PC in their own folder, with the job in
  the environment:

  | Variable | What |
  | --- | --- |
  | `DUCKLAB_JOB` | the job, `duckdash.trainjob.v1` (section 5) |
  | `DUCKLAB_PACKS` | the picked packs, exported (one folder each: `scene.xml`, `assets/`, `state.json`, `policies/`) |
  | `DUCKLAB_OUT` | where to write `walk.onnx`, and `metrics.json` when it has numbers |
  | `DUCKLAB_ENVS`, `DUCKLAB_ITERATIONS` | the Robots and Iterations picked on the card |

  Their output shows on the card; a line with `iteration N/M` moves the
  trainer chip. rsl_rl's table after each iteration (microduck_rl and Isaac
  Lab both print one, `Learning iteration N/M` to `ETA`) becomes one line
  and a point on the chart (mean reward, episode length); the page keeps the
  newest 400 to 600 lines. A step can also be `{ command, until }`: a
  command that is stopped once `until(values)` is true (for one that goes on
  after making its file). Outside trainers live in `../trainers/`, beside
  this repository and never in it: their code and licences stay theirs.

Defined, once set up:

- **Pollen's microduck_rl** (`../trainers/microduck_rl`, ready when its
  `.venv` exists): PPO from scratch in mjlab on MuJoCo-Warp, with the BAM
  model of the XL330 and Pollen's randomisation, on its own flat ground (the
  packs are not its terrain). It trains, then exports its newest checkpoint
  with the observation normaliser baked in. On Windows it needs two changes
  to its `pyproject.toml` (reported by people who trained it natively on an
  8 GB laptop GPU): torch from PyTorch's CUDA index (`cu128`, keeping torch
  on CUDA 12 like Warp 1.12; PyPI's Windows torch is CPU-only), and BAM
  pinned to revision `62bd8ce12154340be97e06f7f41a0ca8f116d967` (the branch
  head lacks `vin_drop_gain_range`). Then `uv sync --python 3.12`, a smoke
  run with `WANDB_MODE=offline uv run train Mjlab-Velocity-Flat-MicroDuck
  --env.scene.num-envs 64 --agent.max-iterations 5`, and the card's run.
  Measured here (RTX 3070 8 GB, driver 580.88, 16 GB RAM): torch
  2.9.1+cu128 sees the GPU; 64 robots take 1.7 s an iteration, 4096 take
  3.1 s and 5.4 GB of graphics memory (about 1,150 iterations an hour; it
  saves a checkpoint every 250). Close Isaac Sim first: with it open (6 GB)
  the install and the training run out of memory. The export runs
  `scripts/export.py --checkpoint-file <newest> --onnx-file DUCKLAB_OUT/walk.onnx`;
  its `obs`/`actions` names and the joint order match the shipped policy.
  Stop on the card ends the whole process tree (`taskkill /T` on Windows).
  The first full run (4096 robots, 3,000 iterations, 2 h 37 min; mean
  reward 110 by iteration 1,100) did not beat the shipped brain on the six
  packs of section 8: in MuJoCo both fell on 1 of 6, with the pollen
  randomisation it fell in 44 % of the runs (shipped 31 %), in Newton on 2
  of 6 (shipped 0). In Isaac Sim (PhysX) on the falls pack it stayed up.
  It trained on flat ground and the packs have the room's bumps; the rough
  task (`Mjlab-Velocity-Rough-MicroDuck`) is the next thing to try. Its
  own viewer (`uv run play <task> --checkpoint-file <pt> --viewer viser`)
  shoves every robot every 0.5 to 1 s, so an occasional fall there is the
  stress test, not a broken export.
- **Pollen's microduck_rl: step-up** (ready once microduck_rl is set up and a
  step-up run exists, section 10): our climbing task in Pollen's environment,
  continuing the newest step-up run (or the checkpoint
  `DUCKLAB_STEPUP_FROM=<run folder>/<model_N.pt>` names, under
  `logs/rsl_rl/velocity`, set when starting `npm run lab`). It trains on its
  own terraces, not the packs; the packs are for the cross-check. Pollen's
  runner exports each checkpoint as `<run>.onnx` with the normaliser inside,
  which becomes the release. It films 128 of its robots for 8 s every 200
  rounds (`videos/train` in the run folder, section 10). A resumed run counts
  its rounds on from its checkpoint (`Learning iteration 5000/5999`); the page
  shows this run's own (1/1000).
- **Isaac Lab 3 (Newton)** (`../trainers/IsaacLab`, ready when its `.venv`
  exists): NVIDIA's `IsaacContrib-Velocity-Flat-MicroDuck` task, kit-less
  (no Isaac Sim), on Newton's MuJoCo-Warp with the BAM servos. The task is on
  Isaac Lab's `main` branch only (Isaac Lab 2.x, which runs on Isaac Sim 4.5,
  is PhysX only, with neither Newton, BAM nor a MicroDuck task). Set up with
  `git clone --depth 1 https://github.com/isaac-sim/IsaacLab` into
  `../trainers` and `uv sync` (if a build stops with `Bad file descriptor`,
  run it again in the foreground with `UV_CONCURRENT_BUILDS=1`). Its docs
  name driver 595.97 for Windows, but only because of PyTorch's CUDA 13.0
  build: measured here on 580.88 (the CUDA 13.0 driver), torch
  2.11.0+cu130, Warp 1.17 and the MicroDuck task all run, 64 robots at 1.1 s
  an iteration after a minute of kernel compiling on the first. Windows long
  paths were off and it installed anyway. The card runs three steps: `uv run
  isaaclab train`, then `isaaclab play` on the newest checkpoint, which
  exports `exported/policy.onnx` and then plays until stopped (the connector
  stops it once the file is whole), then `onnx_single_file.py`
  (`tools/train/python/`), because PyTorch 2.11 writes the weights beside
  the graph (`policy.onnx.data`) and the headset loads one file. The task
  keeps Pollen's 61-wide observation and servo order (`preserve_order`), so
  the result is `obs` [1, 61] to `actions` [1, 14], opset 18. On a Windows
  set to another code page (GBK here) its UTF-8 banner stops it at the
  first line: the card sets `PYTHONUTF8=1`.

None is installed by this repository; they build and run outside code,
so set them up deliberately. Your own trainer goes in
`artifacts/trainers.json` (or the file `DUCKLAB_TRAINERS` names):

```json
[
  {
    "id": "my-ppo",
    "title": "My PPO",
    "about": "What it does, for the card.",
    "cwd": "../trainers/my-ppo",
    "command": ["python", "train.py", "--envs", "{envs}", "--iterations", "{iterations}", "--out", "{out}"],
    "output": "runs/latest/walk.onnx"
  }
]
```

`{envs}`, `{iterations}`, `{job}`, `{packs}` and `{out}` are filled in;
`output` is only needed when it does not write `DUCKLAB_OUT/walk.onnx`.
`node tools/test/trainer-connector-check.mjs` runs the whole round trip with
a stand-in trainer (`tools/test/fake-trainer.mjs`) and removes what it made.

## 10. Skills on top of the shipped walker

Pollen's walking policy (`public/policies/microduck/walk.onnx`, their
`BEST_alpha_walking.onnx`) is the base: new skills start from it or stand on
it, instead of training a walker from random weights. All of this runs in
Pollen's microduck_rl environment (section 9), from its folder.

**Warm start.** `tools/train/python/onnx_to_rslrl.py <walk.onnx> <template.pt>
<out.pt>` turns the ONNX back into an rsl_rl checkpoint: the actor (its
observation normaliser and its 512-256-128 ELU network) from the ONNX, the
critic and the step counter from any checkpoint of the same task, the action
noise set by `--std` (0.2) and the optimiser's learning rate by `--lr`. A
re-export is bit-identical to the shipped file. Resume from it with
`--agent.resume True --agent.load-run <dir> --agent.load-checkpoint <file>`.
Scored in Pollen's own environment (1024 robots, learning switched off), the
shipped brain is sturdier than a 3,000-round run from scratch: 5 % of
episodes end in a fall on flat ground (18 % from scratch) and 27 % on their
rough ground (37 %).

**Step test.** `node tools/train/step-bench.mjs [--brains shipped,<folder>]
[--heights 0,1,2,3]` walks a brain at a box step in our MuJoCo with the
pollen randomisation. The shipped brain gets onto 1 cm (5 of 8) and 1.5 cm
(3 of 8), not 2 cm (Pollen's config: the duck lifts its feet 1 to 2 cm). A
fine-tune from it on Pollen's rough ground (steps up to 1.5 cm; 1024 robots,
500 rounds, reward 110 to 130) does not raise that limit.

**Step-up** (`tools/train/python/duckstep/train.py`, task
`Ducklab-StepUp-MicroDuck`): Pollen's rough walking task on terraces (three
steps up from a clear centre, a short top, three steps down to the floor at
the patch edge) whose steps grow from 0.5 to 4 cm with the curriculum rows,
mixed with flat ground and Pollen's bumps, warm-started from the shipped
brain; the target is a 3 cm ledge (a dog bed's edge). Rough ground fills an
8 GB card at about 1024 robots.

First run (2026-10-26: 1024 robots, 1,000 rounds from the shipped brain, lr
2e-4, 45 min): no gain. The curriculum stayed on the lowest rows (terrain
level about 0.03), and the step test is the same or worse: 3 cm 0 of 8 for
both brains; 1 cm 3 of 8 (shipped 5); 1.5 cm 2 of 8 with 4 falls (shipped 3,
no falls). The walker is blind (its 61 inputs hold no height) and Pollen's
rewards keep its feet 1 to 2 cm off the ground, so the next try needs a higher
swing target (4 to 5 cm) and probably the head distance sensor as an input.

The curriculum is now mdp.py's `terrace_levels` (up a level after getting onto
the third step, down after a fall or never reaching the first), and
`climb_gain` pays for new height. Run 2 (a 4 cm swing target at Pollen's
weights) changed nothing: the swing cost is relative and times the 0.02 s step,
so the feet still peaked at 9 mm. Run 3 (swing and clearance weights -10,
climbing 20 per metre; 750 rounds from the shipped brain) lifted the feet to
14 mm. Run 4 (from run 3: weights -20 and -15, climbing 40, commands forward
0.05 to 0.35 m/s so episodes meet the steps; 1,000 rounds) lifted them to 2 cm:

    step     shipped   step-up run 4 (model_4749)
    1.5 cm   3 / 8     5 / 8
    2 cm     0 / 8     5 / 8
    2.5 cm   0 / 8     2 / 8
    3 cm     0 / 8     1 / 8

It walks forward only (a climbing skill; the shipped brain keeps every
direction). `duckstep/play.py` shows a checkpoint in mjlab's viewer on
terraces of one height (`DUCKSTEP_HEIGHT=0.02`); mjlab's viser viewer runs
that scene at about a fifth of real time here, so `duckstep/film.py` films a
checkpoint without it, every 50 Hz step, 32 ducks round a fixed camera
(`DUCKSTEP_HEIGHT=0.03 uv run python <repo>/tools/train/python/duckstep/film.py
<run>/model_N.pt out.mp4`).

Run 5 (from run 4, 500 more rounds of the same) got worse, and run 6 fixed
why. The curriculum moves a duck up a row only after it climbs three steps
without a fall, so after thousands of rounds most of them still practised on
terraces of about 1.2 cm (mean level 1.7 of 0 to 9, steps 0.5 to 4 cm) and few
ever met 2 or 3 cm. Run 6 (from run 4, 1,000 rounds, 1024 robots, about an hour,
started from the trainer page as the climbing film's take) only moved the
terraces to start at 1.5 cm (`STEPS` in train.py). The step test with 32
tries a height (the numbers above were 8):

    step     shipped   run 4     run 5     run 6 (step-up-6)
    1.5 cm    7 / 32   16 / 32    8 / 32   16 / 32
    2 cm      1 / 32   12 / 32    7 / 32   13 / 32
    2.5 cm    0 / 32    8 / 32    4 / 32   13 / 32
    3 cm      0 / 32    6 / 32    5 / 32   10 / 32

Run 6 also falls half as often at 3 cm (9 of 32, run 4 18). Its checkpoints
vary: the one at 750 rounds managed 4 of 32 at 3 cm, so test the end of a run
rather than trust the curve. On the trainer page it is the release
step-up-6; its cross-check on the Dog Bed test case (the shipped brain tripping
on the 2 cm mat): MuJoCo falls 1 of 1 to 0, randomised MuJoCo 83 % to 33 %,
Newton 1 of 1 to 0. In the app it walks up the 2 cm mat at the first try and
still trips on the 3 cm dog bed.

**Training video.** With `DUCKSTEP_VIDEO_ENVS=128` and mjlab's `--video True
--video-length 400 --video-interval 4800` (the step-up trainer on the page sets
these), train.py films 128 of the robots for 8 s every 200 rounds at 1920 x
1080, the camera on the first robot's patch: `videos/train/rl-video-step-N.mp4`
in the run folder (N is in env steps, 24 a round). Every robot is in a world of
its own, so they walk through each other. Each clip costs about two minutes of
training time.

**Dog Bed** (the playground): a 2 cm foam play mat and a 3 cm dog bed on the
course (src/scene-assets/step-kit.scene-asset.ts). Their colliders are
`walkable` (src/course/collider-spec.ts): solid to the sim, open to the
autopilot's planner, which plans across them instead of round. The shipped
brain trips on the mat; `node tools/test/dog-bed-check.mjs` (with
`POLICIES=policies/incoming/<release>/` for another brain; from Git Bash, no
leading slash) says how far up Pip gets.

Next for 3 cm: the head distance sensor as an input, so it lifts its feet
when a step is coming, and commands in every direction so it keeps the
shipped brain's turns.

**Navigation brain** (`tools/train/python/ducknav/`): a second policy that
steers the frozen shipped walker. Ten times a second it reads the head's
VL53L5CX distance sensor (8 x 8 zones over 45 degrees, 4 m; Pollen's `tof`
site, simulated with mjlab's ray caster to within 0.4 degrees of Pollen's
own model in `sim/tof.py`) and where the goal is, and answers with a twist
(forward up to 0.25 m/s, turn up to 1 rad/s) that the walker follows, smoothed
like the app's stick. It trains in walled 4 m rooms with boxes and posts
(PPO, 2048 robots, about 11 s a round on an RTX 3070):

    uv run python <repo>/tools/train/python/ducknav/train.py --walker <repo>/public/policies/microduck/walk.onnx --envs 2048 --rows 12 --cols 12 --iterations 400
    uv run python <repo>/tools/train/python/ducknav/export.py <run>/model_N.pt <repo>/public/policies/ducklab

`--smoke` prints what the brain sees without training. The export writes
`nav.onnx` (200 inputs to a twist) and `nav.json` (the input layout). In the
app, the menu's AUTOPILOT DRIVER chips (or B) switch the autopilot from the
path planner to this brain: the autopilot still picks the targets (course,
explore, come here), the worker casts the same 64 rays from the same site and
runs the brain, and the head looks straight ahead while it drives. Pip cam's
DEPTH tab shows the sensor's frame. `node tools/test/depth-brain-check.mjs`
clicks through it on the 2D page. Traps: mjlab's pinhole pattern is a
right-handed camera frame (+y up, not down as its comment says), so its rows
run bottom to top; a contact sensor's second side must be one named body or
geom, not a pattern (the obstacles share one body).

**Camera brain** (`tools/train/python/isaacnav/`, NVIDIA Isaac Lab 3, kit-less,
on Newton): the same job from the head camera as well. The Microduck has a
front camera beside the 8 x 8 sensor, and the camera sees what things are and
what falls between the sensor's zones. It learns from the depth brain
(distillation, DAgger style: the student drives, the teacher says what it
would have done) in rooms that change every episode (a floor tile, four walls,
three to eight heavy boxes and partitions, new colours each time), on NVIDIA's
port of Pollen's MicroDuck (its all-collisions robot, BAM servos) with the
shipped walker frozen underneath:

    cd ../trainers/IsaacLab
    PYTHONUTF8=1 uv run python <repo>/tools/train/python/isaacnav/launch.py train --task Ducklab-Nav-Camera-MicroDuck --rl_library rsl_rl --num_envs 256 --max_iterations 400 --checkpoint <ducknav run>/model_549.pt [--viz viser]
    PYTHONUTF8=1 uv run python <repo>/tools/train/python/isaacnav/export.py logs/rsl_rl/ducklab_nav_camera/<run>/model_399.pt <repo>/public/policies/ducklab

The student reads the depth brain's 200 inputs plus the head camera's RGB
picture (64 x 36, 45 degrees tall, Pollen's `head_camera` frame moved 3.5 cm
out of the lens housing) through a small CNN; in 30% of episodes its distance
sensor reads nothing, so it must drive from the camera. Each picture gets a new
brightness, contrast and tint per episode and noise per frame. `export.py`
writes `nav-camera.onnx` (inputs `obs` [1, 200] and `camera` [1, 3, 36, 64],
output `twist`) and `nav-camera.json`. `probe.py` drives the env with a fixed
command, the teacher (`--teacher`) or the student (`--student`, `--blind`),
reports arrivals and falls and saves what eight ducks see (`--frames`);
`probe_walker.py` runs a walking ONNX in NVIDIA's own MicroDuck task.

In the app: the menu's AUTOPILOT DRIVER chip "Camera brain" (B cycles the
three drivers). Pip cam renders a 64 x 36 head view ten times a second for it
(src/duck/duck-cam-system.ts) and its DEPTH tab shows that picture beside the
8 x 8 frame. `node tools/test/camera-brain-check.mjs` clicks through it.

Traps found on Isaac Lab 3 / Newton:
- With graph-capturable actuators (the BAM servos) Newton runs all of an env
  step's physics substeps in one CUDA graph, so an action term's Python runs
  once per env step: a walker inside it ran at 10 Hz and fell. The env steps
  at the walker's 50 Hz (decimation 4, as NVIDIA's task) and `env.py` repeats
  each brain action five times.
- MJWarp's `nconmax` is per world: a room of boxes on a tile makes about 140
  contacts; past the cap contacts are dropped and bodies sink through the floor.
- Newton's ray cast has no self-exclusion: the distance rays start 4 cm out of
  the head. Cameras keep their start-up pose unless `update_latest_camera_pose`
  is set (the first run's cameras stayed where the ducks spawned and filmed them
  walking off).
- `randomize_visual_shape` addresses an articulation's links (only a rigid
  collection's first body): `room_colors` writes Newton's `shape_color`.
- Walls that overlap get shoved apart and open gaps the camera sees through:
  they meet without crossing.
- The shipped walker runs in NVIDIA's port but walks at about half the
  commanded speed (0.13 m/s for 0.25, 0.21 for 0.4; `probe_walker.py --vx`),
  where mjlab, the app and the real duck follow it: the walker is asked for
  1.6x the forward speed (capped at 0.4) so a brain decision moves the duck as
  far as where the brain learned.
