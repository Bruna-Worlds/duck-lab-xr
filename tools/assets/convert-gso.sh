#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Converts the Google Scanned Objects used by Sneaker Alley (CC BY 4.0) from
# their Gazebo Fuel OBJ zips into decimated GLBs with JPEG textures, through
# headless Blender (tools/assets/blender_jobs.py, job "gso").
#
#   bash tools/assets/convert-gso.sh <folder with one subfolder per model>
#
# Each model folder is the unzipped Fuel download: meshes/model.obj,
# materials/textures/texture.png.
set -u
src="${1:?folder with the unzipped Google Scanned Objects}"
blender="${BLENDER:-C:/Program Files/Blender Foundation/Blender 5.2/blender.exe}"
cd "$(dirname "$0")/../.."
out=public/models/scanned
mkdir -p "$out"
# model folder -> asset file, decimate ratio, texture size
models=(
  "Granimals_20_Wooden_ABC_Blocks_Wagon blocks-wagon 0.25 1024"
  "Womens_Bluefish_2Eye_Boat_Shoe_in_Tan boat-shoe-tan 0.25 1024"
  "Vans_Cereal_Honey_Nut_Crunch_11_oz_box cereal-box 0.3 1024"
  "Cole_Hardware_Mug_Classic_Blue mug-blue 0.3 1024"
  "Schleich_Spinosaurus_Action_Figure spinosaurus 0.25 1024"
  "Timberland_Mens_Classic_2Eye_Boat_Shoe timberland-shoe 0.25 1024"
  "Great_Dinos_Triceratops_Toy triceratops 0.25 1024"
  "UGG_Classic_Tall_Womens_Boots_Chestnut_7 ugg-boot 0.25 1024"
)
for entry in "${models[@]}"; do
  set -- $entry
  obj="$src/$1/meshes/model.obj"
  if [ ! -f "$obj" ]; then
    echo "missing $obj"
    continue
  fi
  echo "== $1 -> $out/$2.glb"
  "$blender" -b --factory-startup -P tools/assets/blender_jobs.py -- gso "$obj" "$out/$2.glb" "$3" "$4" 2>&1 | grep -E "^(size|wrote)|Error|error" | head -5
done
ls -la "$out"
