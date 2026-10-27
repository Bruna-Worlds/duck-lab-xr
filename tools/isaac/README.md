# Duck Lab XR, live in Isaac Sim

NVIDIA Isaac Sim mirrors a Duck Lab XR session as it happens. What it gets:

- the floor, the course and your room's colliders, as shapes;
- the terrain from the room scan and depth sensing, as a mesh;
- Pip and the ball, posed 30 times a second.

Isaac Sim draws all of it with RTX. Its viewport comes back into Duck Lab
XR's desktop page over Isaac Sim's own WebRTC stream, in an ISAAC SIM window.
The physics stays in Duck Lab XR's MuJoCo, so Isaac Sim is a live
twin: it shows what happens, it does not decide it.

Written for and tested on Windows with an RTX 3070 (driver 580.88): Isaac
Sim 4.5.0 (Kit 106.5) on the desktop page, and Isaac Sim 2022.2.1 (Kit 104)
on the desktop page and in emulated mixed reality.

## Start it

1. Isaac Sim 4.5 only, once: accept NVIDIA's licence (run its
   `isaac-sim.bat` in a terminal and answer Yes), and fetch NVIDIA's browser
   player, which 4.5 no longer serves itself:

   ```sh
   node tools/isaac/fetch-streaming-library.mjs
   ```

   It downloads `@nvidia/omniverse-webrtc-streaming-library` 4.4.2 from
   NVIDIA's public npm registry into `tools/isaac/vendor/` (git-ignored), and
   the bridge serves it to the stream window. The library is NVIDIA's, under
   NVIDIA's licence: keep it on this computer, never commit or deploy it.
2. Close Isaac Sim if it is running, then start it headless with the bridge:

   ```powershell
   powershell -File tools/isaac/start-isaac-sim.ps1
   ```

   The script takes the newest Isaac Sim 4.5 (the standalone build, under
   `D:\Omniverse`, `C:\isaacsim` or Downloads), else the newest
   `isaac_sim-2022.2*` in the Omniverse Launcher's package folders; pass
   `-IsaacSim <install folder>` or set `ISAAC_SIM_PATH` otherwise. Extra
   arguments go to Kit, e.g.
   `--/isaac/startup/ros_bridge_extension=omni.isaac.ros2_bridge`. It pins
   4.5's web port to 8211, as in 2022.2 (4.5's own default is 8011). To use
   your own launch instead, add
   `--ext-folder <this repo>/tools/isaac/exts --enable ducklab.isaac_bridge`.
3. Wait until <http://127.0.0.1:8211/ducklab/status> answers: a minute or
   two, except on the first start after an install or a driver update, when
   Isaac Sim compiles its RTX shaders (43 minutes for 4.5 on the RTX 3070;
   later starts reuse them).
4. Open Duck Lab XR on the same computer with `?isaac`: in development
   `https://localhost:8081/?isaac`, or `https://duck.bruna.world/?isaac`
   (Chrome then asks to let the site reach this computer).

The ISAAC SIM window sits at the bottom of the page and shows Isaac Sim's
viewport alone. FOLLOW keeps Isaac Sim's camera on Pip; turn it off to steer
the camera in the stream with the mouse. ISAAC UI brings Isaac Sim's own
menus and panels into the stream (they come back by themselves when Duck Lab
XR disconnects), and with them Isaac Sim 4.5's readout of frame rate and
memory over the viewport. HIDE folds the stream away while the link keeps
running. `?isaac` looks for Kit's web port on 8211, then on 8011 (4.5 started
some other way); `?isaac=<address>:<port>` names one.

Shapes the app does not colour (its colliders) are shaded by what they most
likely are: the floor, walls, furniture, and course pieces in Duck Lab's
yellow. In mixed reality the room arrives as the terrain (the scan and live
depth), so the sofa, the tables and whatever depth sees show as raised
ground.

## Test cases: a pack from the headset, under PhysX

When Pip falls or gets stuck, the headset packs the moment (a scenario
pack, `tools/train/README.md`) and sends it to the trainer on this PC
(`npm run lab`, http://localhost:8790). There, pick the pack and press
**Run in Isaac Sim** (Isaac Sim 4.5, started as above):

1. The trainer exports the pack (`replay.mjs --export`), with MuJoCo's own
   run of it (`--trace`: every body's pose at every step) and Pip as the app
   draws him (`scenario/duck-visuals.mjs`: Pollen's full model, servos
   and all), into `artifacts/isaac-test/<pack>/`, and posts the folder to the
   bridge.
2. Isaac Sim builds it under `/World/DuckLabTest` (`scenario/pack_physx.py`):
   Pip through the MJCF importer as a PhysX articulation, dressed in the
   full model; the floor, course and terrain as colliders; the ball; and an
   orange ghost Pip. The live mirror is hidden meanwhile.
3. The walking policy drives the PhysX Pip at 50 Hz in real time, from the
   pack's start state with the inputs the headset recorded, while the ghost
   replays MuJoCo's poses step by step: where the two part is where the
   physics engines disagree.

The stream opens in the trainer page (or stays in Duck Lab XR's ISAAC SIM
window when a page holds it). The page shows progress, then how far each
walked and turned and whether it tipped, and draws both paths on its map
(PhysX sky blue, MuJoCo dashed orange). **Again** replays it, **Close**
removes it and brings the mirror back. **with the trained brain** runs the
release picked for replays instead of the shipped brain; **new packs too**
sends every pack the headset sends straight to Isaac Sim.

Bridge endpoints: `POST /ducklab/testcase` `{folder, title, options}`,
`GET /ducklab/testcase` (state: building, waiting, running, done, error;
progress, summary, both paths), `POST /ducklab/testcase/again`,
`POST /ducklab/testcase/stop`. The trainer proxies them
(`/api/packs/<id>/isaac`, `/api/isaac`, `/api/isaac/again`, `/api/isaac/stop`)
and serves the stream player at `/isaac/player.html`.

```sh
node tools/test/isaac-testcase-check.mjs [pack id]   # the page, the run, the stream (its brightness), the paths
```

The policy was trained in MuJoCo, so expect the two Pips to part (see
"Run a scenario pack under PhysX" below): a test case shows how a brain
copes with another engine's physics, not a replay of what the headset saw.

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| Isaac link | `src/link/isaac-link.ts` | Sends the scene every time it changes (checked every 2 s), Pip's meshes once, poses 30 times a second |
| Scene request | `src/duck/duck-sim.worker.ts` (`scene`) | Reads the compiled MuJoCo model: every geom welded to the world, posed, with its colour, plus both terrain layers as one height field |
| Bridge extension | `exts/ducklab.isaac_bridge` | Takes the app's messages over the stream's data channel (4.5) or a WebSocket at `/ducklab/ws` on Kit's web server (port 8211); builds `/World/DuckLab` in the open stage and moves Pip's bodies every frame |
| Stream player | `public/isaac/player.html` | Runs NVIDIA's WebRTC player inside Duck Lab XR's own page, never copied into this repository: 2022.2 serves its own, and for 4.5 the bridge serves the library fetched into `tools/isaac/vendor/`. On 4.5 it also carries the app's messages over the stream's data channel |

Everything is in the duck stage's MuJoCo frame (Z up, metres); the bridge
converts to the stage's up axis and units. Messages, app to Isaac Sim, as
JSON text:

| Message | Contents |
| --- | --- |
| `scene` | `statics`: shapes (box, cylinder, capsule, sphere, ellipsoid, plane) with size, position, quaternion and colour; `terrain`: a height field (base64 float32) |
| `terrain` | A new height field only |
| `duck` | Pip's body names, in the order poses use, and the ball |
| `duck-body` | One body's triangles and normals (base64 float32) per material |
| `camera` | `follow`: whether Isaac Sim's camera follows Pip; `eye` and `target` place it once |
| `view` | `ui`: Isaac Sim's own panels in the stream, or the viewport alone |
| `part` | A slice of a longer message (`id`, `index`, `count`, `data`) |

A pose is a binary message: little-endian float32, seven per body (x, y, z,
qw, qx, qy, qz; the trunk first), then seven for the ball (NaN when there is
none). Isaac Sim answers `hello` on connect and `ack` or `error` to the JSON
messages. It also serves `GET /ducklab/status` (what is mirrored),
`GET /ducklab/capture` (a PNG of the viewport) and
`GET /ducklab/prims?root=<path>&depth=<n>` (the stage's prims).

Kit's web server takes WebSocket messages of 1 MiB at most (its uvicorn keeps
the `websockets` default), and one of Pip's bodies is 3.8 MB of triangles,
so the app sends anything over 400 KB as `part` messages and the bridge
joins them. One page drives the stage at a time: a new connection replaces
the last (closed with code 4000). When Kit reloads the extension (it does
when its files change), the open connection is closed with 1012 and the app
reconnects.

### Over WebRTC (Isaac Sim 4.5)

On 4.5 everything the app sends goes over the WebRTC stream's own data
channel, alongside the video: the player page passes the app's messages to
NVIDIA's library, Kit puts them on its message bus
(`omni.kit.livestream.receive_message`), and the bridge answers the same way
(`omni.kit.livestream.send_message`). Each message is
`{"event_type": "ducklab", "payload": <message>}`, and a pose is
`{"type": "pose", "data": <the binary frame, base64>}`. The app picks the
channel when the bridge's status says the stream is NVIDIA's library, and
falls back to the WebSocket when the stream does not start;
`?isaac-data=socket` or `=channel` forces one.

The channel's limits, measured on 4.5:

- 64 KiB per message, counted after NVIDIA's library has escaped it twice
  more, so a quote or a backslash costs four. The app cuts slices by that
  cost, about 60 KB of Pip's base64 triangles each.
- Chrome drops, without a word, whatever goes past the channel's 16 MB send
  buffer, and Pip's meshes are 19 MB as base64. The bridge answers every
  slice with `got`, and the app keeps at most 4 MB unconfirmed. Pip arrives
  in 10 to 20 s; poses flow meanwhile.
- The channel has no close of its own: the app pings every 2 s, and the
  bridge counts it gone after 6 s of quiet (Isaac Sim's panels come back).

Kit 2022.2 passes only video and input over its WebRTC connection (the
stream server drops the client's custom messages), so there the data goes
over the WebSocket. The bridge also lets Duck Lab XR's page call Kit's
`/streaming/` endpoints (CORS), which 2022.2's player needs to start a stream
from another page.

## Limits

- Isaac Sim must run on the same computer as the browser: an https page may
  reach plain `http`/`ws` addresses only on this computer (127.0.0.1).
- Desktop page only. In a headset session the link keeps running but the
  window does not show; a Quest cannot reach Isaac Sim directly.
- The live link is a kinematic mirror: Isaac Sim's physics does not move
  Pip there (test cases do run him under PhysX).
- Isaac Sim 4.5 starts with RTX Eco Mode on, which stops drawing frames it
  judges unchanged: with Pip moving every frame, the stream showed black
  frames between drawn ones. The bridge turns it off while an app or a
  test case drives the stage, and back as it was after.
- Live and standalone runs of a pack under PhysX differ by some
  centimetres: inside the streaming app, physics steps with the app's
  frames.
- One page drives the stage at a time (a new one takes over), and Isaac Sim
  streams to one viewer at a time.
- Isaac Sim 4.5 asks for 32 GB of RAM; on 16 GB it runs, using about 10 GB,
  with little left for the browser. Run one Isaac Sim at a time.
- Isaac Sim 4.5 crashed in its renderer (`rtx.scenedb.plugin.dll`) on driver
  595.95, even with nothing of ours loaded; driver 580.88 works.

## Check it

Against a running Isaac Sim with the bridge, with the app open on `?isaac`:

```sh
GOTO="https://localhost:8081/?isaac" npx @iwsdk/cli browser run tools/test/goto.mjs
npx @iwsdk/cli browser run tools/test/isaac-live-check.mjs --timeout 100000
bash tools/test/mr.sh tools/test/isaac-live-check.mjs        # mixed reality: the room and the terrain
```

It compares the bridge's status with the app (shapes, bodies, every
triangle, pose rate, terrain, the stream) and saves Isaac Sim's view to
`artifacts/isaac-live.png`.

## Test it without Isaac Sim

`node tools/isaac/mock-bridge.mjs` is a stand-in that speaks the same
messages and records them (`GET /log`). With the dev server up:

```sh
npx @iwsdk/cli browser run tools/test/isaac-link-check.mjs --timeout 100000
```

It starts the stand-in if needed, loads the app with `?isaac` pointing at
it, and checks the connection, the scene, Pip's triangles, the pose rate and
accuracy, the ball, FOLLOW, ISAAC UI and the window. The stand-in refuses
messages over 1 MiB, as Kit does.

## Run a scenario pack under PhysX

`scenario/` runs a pack the headset captured (see `tools/train/README.md`) in
Isaac Sim with PhysX doing the physics, next to MuJoCo's replay of the same
pack. Pip comes in through Isaac Sim's MJCF importer as an articulation; the
floor, course pieces and terrain become colliders and the ball a rigid body.
The walking policy then drives him at 50 Hz from the pack's start state, with
the inputs the headset recorded. Isaac Sim 4.5 only, headless, with nothing
to install (the policy runs in numpy straight from the `.onnx` file).

```sh
node tools/train/replay.mjs <pack> --export artifacts/isaac-test/<name> --trace artifacts/isaac-test/<name>/mujoco-trace.json
D:\Omniverse\isaac-sim-4.5.0\python.bat tools/isaac/scenario/run_pack.py artifacts/isaac-test/<name> [--stand 5] [--air]
node tools/isaac/scenario/compare-plot.mjs artifacts/isaac-test/<name>      # -> compare.png
```

It prints the trunk's path each second beside MuJoCo's, where each first
tipped, how far each walked and turned, and the policy's observation in both
step by step. It shares `scenario/pack_physx.py` with the live test cases;
`--ghost` also builds MuJoCo's run as the ghost Pip, as they do. `--stand 5` first stands Pip still for 5 s; `--air` first runs
the motor test in the air (`node tools/isaac/scenario/mujoco-air-test.mjs
<pack> <folder>` makes MuJoCo's half). `--friction`, `--compliant k,c`,
`--hull-limit`, `--vel-iterations` and `--depenetration` change the contacts.

Close the streaming Isaac Sim first on a 16 GB PC. The first run compiles
the RTX shaders of Isaac Sim's Python mode, a set of its own (over 40
minutes on the RTX 3070); later runs start in 25 s, and a 17 s pack runs in
about 8 s. Start it as its own process (`Start-Process`) when Claude Code
drives it: Claude Code stops its own background commands when memory runs
low.

What the importer needs, done by `pack_scene.py` and `run_pack.py`:

- one top-level `<default>` (Pollen's MJCF has three; they are merged);
- MuJoCo's motors redone: the importer writes `drive:X` with MuJoCo's
  stiffness and damping as they are, but a revolute joint's drive is
  `angular`, and USD gives angular stiffness and damping per degree, so they
  would be 57 times too strong. Each joint gets an `angular` force drive
  with kp and damping converted, the force range as max force, and the
  armature;
- the empty `worldBody` articulation it adds is removed;
- geoms that touch only Pip himself (`power_support`) are left out, as PhysX
  self-collision stays off;
- how Pip looks: the pack's MJCF (`robot_allcollisions.xml`) has only the
  collision shells, and the importer's own materials do not resolve
  ("Cannot append child" warnings). When the folder has `visuals.json`
  (`node tools/isaac/scenario/duck-visuals.mjs <folder>`; the trainer writes
  it), every link is dressed in Pollen's full model from the app's
  `microduck.glb` (CC BY-NC-SA 4.0, see its ATTRIBUTION.md) instead, minus
  its zero-area triangles (they have no normal to shade with).

Measured on 2026-10-25 (Isaac Sim 4.5.0, PhysX TGS, 32 position
iterations): Pip weighs 737 g as in the MJCF, the start pose puts every body
within 1.7 mm of MuJoCo's, and in the air every motor follows a step as in
MuJoCo (0.187 against 0.181 rad after 0.2 s). He stands. But the walking
policy, trained in MuJoCo, behaves differently on PhysX's rigid contacts:

| Test | MuJoCo | PhysX, friction 1 | friction 0.4 |
| --- | --- | --- | --- |
| Walk straight from rest, 10 s | 0.80 m | 0.01 m (never starts) | 0.01 m |
| Walk and turn right from rest, 10 s | 0.82 m, -153 deg | 0.01 m | 0.86 m, +12 deg |
| "falls" pack (07-53-10), 17.7 s | tips at 8 s | 0.39 m in a tight circle, stays up | turns -364 deg, stays up |
| Mixed-reality walk pack (10-24 01-02-31), 6.5 s | 0.63 m, +24 deg | 0.45 m | 0.63 m, +103 deg |

Once walking he keeps going and never fell in these runs, but from rest he
rarely starts, and his turning does not match. So a pack under PhysX is a
check of how the brain copes with another engine's physics, not a replay of
what the headset saw.
