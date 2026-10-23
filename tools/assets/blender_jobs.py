# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Headless Blender jobs for playground assets.

  blender -b --factory-startup -P tools/assets/blender_jobs.py -- gso <model.obj> <out.glb> <decimate ratio> <texture px>
  blender -b --factory-startup -P tools/assets/blender_jobs.py -- backyard <out.glb> <grass texture dir> <planks texture dir>

gso: imports a Google Scanned Objects OBJ (Z up, metres), decimates it, shrinks
its texture, puts the origin at the floor centre and exports a Y-up GLB with
JPEG textures. backyard: builds a lawn with a wooden fence from Poly Haven
PBR textures (CC0) and exports it as one GLB.
"""
import math
import os
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
job = argv[0]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def export(out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        export_image_format='JPEG',
        export_jpeg_quality=82,
        export_apply=True,
        export_yup=True,
    )
    print('wrote', out, os.path.getsize(out) // 1024, 'kB')


def pbr_material(name, folder, prefix, uv_scale=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    mapping = None
    if uv_scale != 1.0:
        coord = nodes.new('ShaderNodeTexCoord')
        mapping = nodes.new('ShaderNodeMapping')
        mapping.inputs['Scale'].default_value = (uv_scale, uv_scale, 1)
        links.new(coord.outputs['UV'], mapping.inputs['Vector'])

    def image(file, non_color=False):
        path = os.path.join(folder, file)
        if not os.path.exists(path):
            return None
        img = bpy.data.images.load(path)
        if non_color:
            img.colorspace_settings.name = 'Non-Color'
        node = nodes.new('ShaderNodeTexImage')
        node.image = img
        if mapping is not None:
            links.new(mapping.outputs['Vector'], node.inputs['Vector'])
        return node

    diff = image(prefix + 'diffuse_1k.jpg')
    if diff is not None:
        links.new(diff.outputs['Color'], bsdf.inputs['Base Color'])
    rough = image(prefix + 'rough_1k.jpg', True)
    if rough is not None:
        links.new(rough.outputs['Color'], bsdf.inputs['Roughness'])
    nor = image(prefix + 'nor_gl_1k.jpg', True)
    if nor is not None:
        normal = nodes.new('ShaderNodeNormalMap')
        links.new(nor.outputs['Color'], normal.inputs['Color'])
        links.new(normal.outputs['Normal'], bsdf.inputs['Normal'])
    return mat


def box(name, size, location, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    obj.data.materials.append(material)
    return obj


if job == 'gso':
    obj_path, out, ratio, texsize = argv[1], argv[2], float(argv[3]), int(argv[4])
    reset()
    bpy.ops.wm.obj_import(filepath=obj_path, forward_axis='Y', up_axis='Z')
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for obj in meshes:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        if ratio < 1.0:
            mod = obj.modifiers.new('dec', 'DECIMATE')
            mod.ratio = ratio
            bpy.ops.object.modifier_apply(modifier='dec')
        obj.select_set(False)
    # The MTL names texture.png next to the OBJ, but the zip keeps it under
    # materials/textures/, so hook it up by hand when the importer missed it.
    texture = os.path.join(os.path.dirname(os.path.dirname(obj_path)), 'materials', 'textures', 'texture.png')
    loaded = bpy.data.images.load(texture) if os.path.exists(texture) else None
    hooked = 0
    for mat in bpy.data.materials:
        if not mat.use_nodes or loaded is None:
            continue
        nodes = mat.node_tree.nodes
        bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        # An image node whose file was never found carries no pixels: replace it.
        image_nodes = [n for n in nodes if n.type == 'TEX_IMAGE']
        usable = [n for n in image_nodes if n.image is not None and n.image.has_data]
        if usable:
            continue
        for n in image_nodes:
            nodes.remove(n)
        node = nodes.new('ShaderNodeTexImage')
        node.image = loaded
        mat.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.65
        hooked += 1
    print('texture', 'found' if loaded is not None else 'missing', 'hooked into', hooked, 'materials')
    for img in bpy.data.images:
        if img.size[0] > texsize:
            img.scale(texsize, texsize)
    # Origin at the floor centre.
    xs, ys, zs = [], [], []
    for obj in meshes:
        for v in obj.data.vertices:
            w = obj.matrix_world @ v.co
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    cx, cy, z0 = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)
    for obj in meshes:
        obj.location.x -= cx; obj.location.y -= cy; obj.location.z -= z0
    tris = sum(len(o.data.polygons) for o in meshes)
    print('size x %.3f y %.3f z %.3f, %d faces' % (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), tris))
    export(out)

elif job == 'backyard':
    out, grass_dir, planks_dir = argv[1], argv[2], argv[3]
    reset()
    grass = pbr_material('Lawn', grass_dir, '', uv_scale=6.0)
    planks = pbr_material('Planks', planks_dir, '', uv_scale=2.0)
    bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, 0))
    lawn = bpy.context.active_object
    lawn.name = 'Lawn'
    lawn.data.materials.append(grass)
    # Fence: posts every 2 m around a 12 m square, two rails and pickets.
    half = 6.0
    posts = []
    for i in range(-3, 4):
        for (x, y) in ((i * 2, -half), (i * 2, half), (-half, i * 2), (half, i * 2)):
            posts.append(box('Post', (0.12, 0.12, 1.15), (x, y, 0.575), planks))
    for side in range(4):
        along_x = side < 2
        fixed = -half if side % 2 == 0 else half
        for z in (0.35, 0.95):
            size = (12.0, 0.05, 0.1) if along_x else (0.05, 12.0, 0.1)
            loc = (0, fixed, z) if along_x else (fixed, 0, z)
            box('Rail', size, loc, planks)
        for k in range(-30, 31):
            if k % 6 == 0:
                continue
            p = k * 0.2
            size = (0.09, 0.03, 0.9) if along_x else (0.03, 0.09, 0.9)
            loc = (p, fixed + (0.05 if side % 2 == 0 else -0.05), 0.55) if along_x else (fixed + (0.05 if side % 2 == 0 else -0.05), p, 0.55)
            box('Picket', size, loc, planks)
    # Join the fence into one mesh for one draw call.
    fence = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.name != 'Lawn']
    for o in fence:
        o.select_set(True)
    bpy.context.view_layer.objects.active = fence[0]
    bpy.ops.object.join()
    bpy.context.active_object.name = 'Fence'
    export(out)
