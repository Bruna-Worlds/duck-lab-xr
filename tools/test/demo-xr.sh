#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Records the emulated mixed reality session running the headset tests'
# steps with the emulated controllers, then encodes an MP4 with captions:
# the robot panel docked beside the scoreboard, dragged and pinned, resized
# from its corner, expanded to its technical details, a trained brain from
# Duck Lab XR swapped in, and the side menu opened with a left stick click to
# pick a playground.
#
#   bash tools/test/demo-xr.sh [name] [seconds]
#   -> artifacts/video/<name>.mp4
#
# Needs the dev server with --allow-browser-automation and a trained
# release in public/policies/incoming (Duck Lab XR or tools/train/finetune.mjs).
set -u
cd "$(dirname "$0")/../.."
NAME="${1:-ar-emulator}"
REC_SECONDS="${2:-92}"
DIR="artifacts/video/$NAME"
IWSDK="node node_modules/@iwsdk/cli/bin/iwsdk.js" # 3x faster than npx per call
cli() { $IWSDK "$@" --raw > /dev/null 2>&1; }
probe() { PROBE="$1" $IWSDK browser run tools/test/probe.mjs > /dev/null 2>&1; }
now() { node -e "console.log((Date.now() / 1000).toFixed(3))"; }
mark() { echo "$(now) $*" >> "$DIR.marks"; }
target() { # name [dx dy dz] -> json point from the recorder's targets.json
  node -e "
const t = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const p = t[process.argv[2]];
if (!p) process.exit(1);
console.log(JSON.stringify({ x: p.x + Number(process.argv[3]), y: p.y + Number(process.argv[4]), z: p.z + Number(process.argv[5]) }));
" "$DIR/targets.json" "$1" "${2:-0}" "${3:-0}" "${4:-0}"
}
aim() { cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$1}"; }
hold() { cli xr set-select-value --input-json "{\"device\":\"controller-right\",\"value\":$1}"; }
click() {
  aim "$1"
  sleep 0.4
  cli xr select --input-json '{"device":"controller-right","duration":0.25}'
}
stick() { cli xr set-gamepad-state --input-json "{\"device\":\"controller-left\",\"axes\":[{\"index\":0,\"value\":$1},{\"index\":1,\"value\":$2}]}"; }
stick_click() {
  cli xr set-gamepad-state --input-json '{"device":"controller-left","buttons":[{"index":2,"value":1}]}'
  sleep 0.2
  cli xr set-gamepad-state --input-json '{"device":"controller-left","buttons":[{"index":2,"value":0}]}'
}
place() { # device x y z: absolute position
  cli xr set-transform --input-json "{\"device\":\"$1\",\"position\":{\"x\":$2,\"y\":$3,\"z\":$4}}"
}

# --- Setup: a trained brain on offer, panel at its defaults, fresh MR session.
release=$(node -e "const i = require('./public/policies/incoming/index.json'); console.log(i.releases[0]?.id ?? '')")
[ -n "$release" ] || { echo "no trained release in public/policies/incoming"; exit 1; }
node tools/train/release.mjs activate "$release" > /dev/null
probe "(localStorage.removeItem('duckdash.brain'), localStorage.removeItem('duckdash.brain.dismissed'), localStorage.setItem('duckdash.robotPanel.size', 'normal'), localStorage.setItem('duckdash.robotPanel.scale', '1'), 1)"
cli browser reload --input-json '{}'
sleep 12
cli xr enter --input-json '{}'
sleep 4
# A closer seat: standing a metre from the duck's start, hands in front.
place headset -0.45 1.25 -0.55
cli xr look-at --input-json '{"device":"headset","target":{"x":-0.5,"y":0.55,"z":-2.2}}'
place controller-left -0.68 0.95 -0.85
place controller-right -0.22 0.95 -0.85
sleep 2
mkdir -p artifacts/video
rm -f "$DIR.marks"

# --- Record in the background; the recorder also publishes target positions.
REC_NAME="$NAME" REC_SECONDS="$REC_SECONDS" $IWSDK browser run tools/test/record-xr.mjs --timeout 110000 > "$DIR.rec.log" 2>&1 &
recorder=$!
for i in $(seq 1 40); do [ -f "$DIR/targets.json" ] && break; sleep 0.25; done
sleep 1

mark "Pip cam docks in the background, beside the scoreboard: nothing covers the course"
sleep 3.5
mark "Walk the duck with the left stick: its camera feed and status update live"
stick 0.2 -1
sleep 3.5
stick 0 0
sleep 0.8
mark "Drag its bar to put it anywhere: it stays there and turns to face you"
aim "$(target bar)"
sleep 0.5
hold 1
sleep 0.3
aim "$(target bar -0.35 0.1 0.2)"
sleep 0.8
hold 0
sleep 1.5
mark "Pull the corner grip to resize it"
aim "$(target grip)"
sleep 0.5
hold 1
sleep 0.3
aim "$(target grip 0.08 0.02 0.03)"
sleep 0.8
hold 0
sleep 1.5
mark "Expand it: policy output, IMU and feet, servos, autopilot"
click "$(target more)"
sleep 0.8
stick -0.25 -1
sleep 4
stick 0 0
sleep 2
click "$(target less)"
sleep 1
mark "A brain trained in Duck Lab XR on your room: TRY IT swaps it in while the duck walks"
sleep 2
click "$(target offerTry)"
sleep 3
mark "The pin button sends the panel back to its slot"
click "$(target pin)"
sleep 2.5
mark "Left stick click opens the menu at your side"
stick_click
sleep 2
mark "Pick a playground with the ray: Your Room"
click "$(target pg3)"
# Wait for the duck to stand in the new playground (its sim worker starts fresh).
sleep 2
for _ in $(seq 1 80); do
  node -e "const t = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.exit(t.playground === 'free-roam' && t.ready ? 0 : 1)" "$DIR/targets.json" 2>/dev/null && break
  sleep 0.5
done
sleep 1.5
mark "Free roam in your own room, with the new brain"
stick 0 -1
sleep 4
stick 0 0
wait "$recorder"
grep -o "REC [^\"]*" "$DIR.rec.log"
mv "$DIR.marks" "$DIR/marks.txt"
node -e "const t = require('./$DIR/targets.json'); console.log('end state', JSON.stringify({ size: t.size, scale: t.scale, pinned: t.pinned, offer: t.offer, brain: t.brain, playground: t.playground }))"
cli xr exit --input-json '{}'
node tools/test/encode-rec.mjs "$DIR" "artifacts/video/$NAME.mp4"
