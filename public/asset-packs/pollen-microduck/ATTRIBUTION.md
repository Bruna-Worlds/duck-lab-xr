# Pollen Microduck asset pack

The duck's body for the free, non-commercial website build: what it looks
like (`microduck.glb`, `kinematics.json`) and how it collides and moves
(`robot_allcollisions.xml`, `meshes/*.stl`).

## Source

- Hugging Face Space `pollen-robotics/microduck-simulator`, commit
  `ad9d41a763f30dc770817c33d92dcfec0205db1e` (2026-10-09), folder
  `app/public/robot/mjlab/`.
- Upstream: [pollen-robotics/microduck](https://github.com/pollen-robotics/microduck)
  and [pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl).

## Licences

| Files | Licence |
| --- | --- |
| `microduck.glb`, `microduck-lite.glb`, `meshes/*.stl` (the 3D meshes) | © Pollen Robotics, [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `robot_allcollisions.xml`, `kinematics.json` | © Pollen Robotics, Apache-2.0 |

CC BY-NC-SA 4.0 means:

- credit Pollen Robotics wherever the duck is shown (the app's panel does);
- no commercial use of the meshes without Pollen's permission;
- adapted meshes must be shared under the same licence.

Before the site earns money, either get Pollen's written permission or swap
this pack for one with our own meshes.

## Changes

The original files are unmodified. Only the nine meshes that the physics
model uses for collisions are copied into `meshes/`.

`microduck-lite.glb` is our adaptation of `microduck.glb`: every part
decimated to 30% of its triangles with Blender's Decimate (collapse)
modifier, using `tools/decimate_glb.py` (103k to 31k unique triangles; part
outlines move by at most 2.3 mm). Like the original, it is licensed
CC BY-NC-SA 4.0. The app uses it when the page URL has `?duck=lite`. At runtime the app removes the
visual-only geoms from the physics model and adds a floor, a 5 ms timestep
and a standing keyframe (`src/duck/mjcf.ts`).
