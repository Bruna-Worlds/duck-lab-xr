# Models

## `dev-only/` (git-ignored, stripped from production builds)

Files for the Phase 0 camera test. They stay on the developer's machine:
`.gitignore` skips the folder, and `vite.config.ts` deletes `dist/models/dev-only`
after every build.

| File | What | Why dev-only |
| --- | --- | --- |
| `microduck_yolo11n_320.onnx` | Community Microduck detector ([pngwn/microduck-detector](https://huggingface.co/pngwn/microduck-detector)), exported to ONNX at 320 px | The model repo declares no licence, and it was trained with Ultralytics YOLO11 (AGPL-3.0). Do not ship it until that is cleared, or train our own detector on the Apache-2.0 [microduck-detection-dataset](https://huggingface.co/datasets/pngwn/microduck-detection-dataset). |
| `watching.jpg`, `kickabout.jpg` | Press photos of the real Microduck, from the [what-the-microduck](https://huggingface.co/spaces/pngwn/what-the-microduck) Space examples | Photo copyright is not ours. Used only by the detector self-test. |

### Recreate the ONNX file

Needs [uv](https://docs.astral.sh/uv/). Download `microduck_yolo11n.pt` from the
model repo, then:

```bash
uv run --no-project --python 3.12 --with "ultralytics==8.3.*" --with onnx \
  --with onnxslim --with onnxruntime python -I export_onnx.py \
  microduck_yolo11n.pt public/models/dev-only/microduck_yolo11n_320.onnx
```

where `export_onnx.py` calls
`YOLO(pt).export(format="onnx", imgsz=320, opset=17, simplify=True, dynamic=False)`.
The `.pt` file is a Python pickle. Before loading it, list its imports with
`pickletools` (only `torch`, `ultralytics`, `collections.OrderedDict` and
`builtins.set` should appear).

Output: input `images` `[1, 3, 320, 320]` (RGB, 0..1, letterboxed with grey 114),
output `[1, 5, 2100]` (centre x, centre y, width, height, score per anchor).
