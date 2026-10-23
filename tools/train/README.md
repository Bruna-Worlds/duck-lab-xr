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
npm run finetune -- artifacts/scenarios/<a>.scenario.json [<b> ...] [--iterations 30] [--pairs 24] [--steps 900] [--name room-tuned] [--publish]
```

Evolution strategies (antithetic sampling, rank fitness, Adam) learn a
change to the last layer of Pollen's walking policy (14 x 128 weights and 14
biases; the policy is an MLP 61 -> 512 -> 256 -> 128 -> 14 with ELU and an
input normaliser). Each candidate runs the packs in MuJoCo on this PC from
their start states with the recorded commands, joint and velocity noise, two
or three shoves of 0.8-2.5 N on the trunk, and +-10% command noise. Reward
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

- `scene.xml` (meshdir `assets/`, height field in `terrain.bin`: int32 nrow,
  int32 ncol, float32 data),
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
