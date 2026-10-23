# Credits and licences

Duck Lab XR is copyright 2026 BRUNA GOODS LLC, and its own code is licensed
under the [Apache License 2.0](LICENSE). It bundles work by other people, and
each item keeps its own licence.

| What | Where in this repo | By | Licence |
| --- | --- | --- | --- |
| Microduck meshes and MuJoCo model | `public/asset-packs/pollen-microduck/` | [Pollen Robotics](https://www.pollen-robotics.com/) ([microduck](https://github.com/pollen-robotics/microduck), [microduck_rl](https://github.com/pollen-robotics/microduck_rl)) | Meshes: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) (non-commercial, share-alike; the decimated `microduck-lite.glb` stays under it). MuJoCo XML and `kinematics.json`: Apache-2.0. See the folder's `ATTRIBUTION.md`. |
| Walking, getting-up, sit, roll, kick and peck policies (ONNX) | `public/policies/microduck/` | Pollen Robotics, trained with microduck_rl; taken from the Space [pollen-robotics/microduck-simulator](https://huggingface.co/spaces/pollen-robotics/microduck-simulator) | Apache-2.0. See the folder's `ATTRIBUTION.md`. |
| Brains trained by Duck Lab XR | `public/policies/incoming/` (never committed or deployed) | Derived from Pollen's walking policy | Apache-2.0, with Pollen's attribution (`ATTRIBUTION.md` in each release) |
| Household objects: boat shoes (tan, brown), tall boot, cereal box, blue mug, ABC blocks wagon, Spinosaurus and Triceratops toys | `public/models/scanned/` | [Google Scanned Objects](https://app.gazebosim.org/GoogleResearch/fuel/collections/Scanned%20Objects%20by%20Google%20Research), Google Research (via Gazebo Fuel); decimated and re-textured by `tools/assets/convert-gso.sh` (headless Blender, `tools/assets/blender_jobs.py`) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Garden props: picnic table, planter box, potted plant, garden gnome, watering can, wooden crate, rubber duck toy, stone, rock, shrub, grass clump, football, wooden bucket, painted bench | `public/models/polyhaven/` | [Poly Haven](https://polyhaven.com/), fetched by `tools/assets/fetch-polyhaven.mjs` | CC0 |
| Lawn and fence textures (`aerial_grass_rock`, `weathered_planks`), park sky (`ballawley_park`) | `public/textures/polyhaven/`, `public/env/` | Poly Haven | CC0 |
| Backyard set | `public/models/backyard/` | Built by `tools/assets/blender_jobs.py` from the Poly Haven textures | CC0 inputs |
| Bebas Neue font | `public/fonts/` | Ryoichi Tsunekawa | SIL Open Font License 1.1 (`BebasNeue-OFL.txt`) |
| IWSDK starter template, `src/scene-assets/lib/hardsurface.ts` and the coding-agent guidance (`AGENTS.md` files, `.agents/`, `.claude/`, `.cursor/`, `.github/instructions/`) | see [NOTICE](NOTICE) | Meta Platforms, Inc. and affiliates | MIT ([LICENSES/MIT-IWSDK.txt](LICENSES/MIT-IWSDK.txt)) |
| MuJoCo (WebAssembly) | npm `@mujoco/mujoco` | Google DeepMind | Apache-2.0 |
| ONNX Runtime Web | npm `onnxruntime-web` | Microsoft | MIT |
| IWSDK, UIKit, three.js | npm | Meta, pmndrs, three.js authors | MIT |

Made for this project (Apache-2.0 with the code): the procedural course
pieces and toy room in `src/scene-assets/`, the playground scenes, the UI
panels, the motion sets in `public/motions/`, and the game's sounds, which are
synthesized in code (`src/audio/duck-sounds.ts`).

The menu shows the credit lines: "Microduck model and walking AI (c) Pollen
Robotics. Meshes CC BY-NC-SA 4.0." and "Household objects: Google Scanned
Objects (CC BY 4.0). Props, textures, sky: Poly Haven (CC0)." Keep this file
and those lines current when adding or removing assets.

Not included, and never to be committed or deployed: `public/models/dev-only/`
(a community Microduck detector with no declared licence, trained with
AGPL-3.0 tooling, and press photos; see `public/models/README.md`).

"Microduck" and "Pollen Robotics" are Pollen Robotics' names. Duck Lab XR is an
independent fan project, not made or endorsed by Pollen Robotics.
