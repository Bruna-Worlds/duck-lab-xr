# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Decimate every mesh of a positions-only GLB and export it with the same node
# names and extras. Usage: blender -b --factory-startup -P decimate_glb.py -- in.glb out.glb ratio
import sys
import bpy

src, dst, ratio = sys.argv[sys.argv.index("--") + 1:][:3]
ratio = float(ratio)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

before = after = 0
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    before += sum(len(p.vertices) - 2 for p in obj.data.polygons)
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
depsgraph = bpy.context.evaluated_depsgraph_get()
for obj in bpy.data.objects:
    if obj.type == "MESH":
        mesh = obj.evaluated_get(depsgraph).to_mesh()
        after += sum(len(p.vertices) - 2 for p in mesh.polygons)
        obj.evaluated_get(depsgraph).to_mesh_clear()

bpy.ops.export_scene.gltf(
    filepath=dst,
    export_format="GLB",
    export_apply=True,
    export_normals=False,
    export_texcoords=False,
    export_materials="NONE",
    export_extras=True,
    export_yup=True,
)
print(f"DECIMATE triangles {before} -> {after} (ratio {ratio})")
