# Microduck policies

| File | Original name | What it does |
| --- | --- | --- |
| `walk.onnx` | `BEST_alpha_walking.onnx` | Walks at the commanded speed and turn rate |
| `stand.onnx` | `BEST_alpha_stand.onnx` | Gets back up after a fall |
| `sitstand.onnx` | `BEST_alpha_sitstand.onnx` | Sits on its hull and stands back up (command slot 0 = 1 to sit) |
| `roll.onnx` | `roulade.onnx` | Rolls over and recovers (one-shot, about 1–3 s) |
| `kick-left.onnx`, `kick-right.onnx` | `ball_kick_left.onnx`, `ball_kick_right.onnx` | Blind kick with one leg (0.5 s window, commands zeroed) |
| `peck.onnx` | `alpha_ground_pick.onnx` | Pecks the ground and stands back up (phase-driven, about 2.8 s) |

- Source: Hugging Face Space `pollen-robotics/microduck-simulator`, commit
  `ad9d41a763f30dc770817c33d92dcfec0205db1e` (2026-10-09), folder
  `app/public/policies/`.
- Trained by Pollen Robotics with
  [microduck_rl](https://github.com/pollen-robotics/microduck_rl).
- Licence: Apache-2.0, © Pollen Robotics.

Both take the same 61 inputs (gyro 3, projected gravity 3, joint positions 14,
joint velocities 14, last action 14, command 13) and return 14 joint position
offsets, run at 50 Hz.
