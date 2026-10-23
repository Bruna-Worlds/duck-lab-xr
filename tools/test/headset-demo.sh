#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Records Duck Lab XR on a real Quest in mixed reality under native XR control:
# the same steps as demo-xr.sh (walk, drag and pin the robot panel, resize
# it, expand it, try a trained brain, pin it back, open the menu, pick a
# playground), driven through the IWSDK CLI with the headset page's
# runtimeTarget, filmed with `adb screenrecord`, then cropped to one eye
# with captions.
#
#   npx @iwsdk/cli dev up --native-xr-control --no-open
#   bash tools/test/headset-launch.sh <serial>   (then pick the active tab)
#   node tools/test/headset-uuids.mjs
#   bash tools/test/headset-demo.sh <serial> [seconds]
#   -> artifacts/video/quest-headset.mp4
set -u
SERIAL="${1:?adb serial}"
SECONDS_REC="${2:-88}"
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
IWSDK="node node_modules/@iwsdk/cli/bin/iwsdk.js"
RT=$(cat artifacts/video/rt.json)
MARKS=artifacts/video/quest-headset.marks
cli() { $IWSDK "$@" --raw > /dev/null 2>&1; }
xr() { # action json-without-braces
  cli xr "$1" --input-json "{$2,\"runtimeTarget\":$RT}"
}
now() { node -e "console.log((Date.now() / 1000).toFixed(3))"; }
mark() { echo "$(now) $*" >> "$MARKS"; }
pos() { # element [dx dy dz] -> json point relative to the XR origin
  local uuid
  uuid=$(node -e "console.log(require('./artifacts/video/uuids.json')[process.argv[1]] ?? '')" "$1")
  [ -n "$uuid" ] || { echo "{\"x\":0,\"y\":1,\"z\":-2}"; return; }
  $IWSDK scene transform --input-json "{\"uuid\":\"$uuid\",\"runtimeTarget\":$RT}" --raw 2>/dev/null | node -e "
let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const j = JSON.parse(s); const r = j.data?.result ?? j.result ?? j;
  const p = r.positionRelativeToXROrigin ?? r.globalPosition;
  const x = Array.isArray(p) ? p : [p.x, p.y, p.z];
  console.log(JSON.stringify({ x: x[0] + Number(process.argv[1]), y: x[1] + Number(process.argv[2]), z: x[2] + Number(process.argv[3]) }));
});" -- "${2:-0}" "${3:-0}" "${4:-0}"
}
aim() { xr look-at "\"device\":\"controller-right\",\"target\":$1"; }
hold() { xr set-select-value "\"device\":\"controller-right\",\"value\":$1"; }
click() {
  aim "$1"
  sleep 0.4
  xr select "\"device\":\"controller-right\",\"duration\":0.25"
}
stick() { xr set-gamepad-state "\"device\":\"controller-left\",\"axes\":[{\"index\":0,\"value\":$1},{\"index\":1,\"value\":$2}]"; }
stick_click() {
  xr set-gamepad-state "\"device\":\"controller-left\",\"buttons\":[{\"index\":2,\"value\":1}]"
  sleep 0.2
  xr set-gamepad-state "\"device\":\"controller-left\",\"buttons\":[{\"index\":2,\"value\":0}]"
}

# A synthetic seat that sees the duck, the docked robot panel and the scoreboard.
xr set-transform "\"device\":\"headset\",\"position\":{\"x\":-0.5,\"y\":1.35,\"z\":0.1}"
xr look-at "\"device\":\"headset\",\"target\":{\"x\":-0.55,\"y\":0.7,\"z\":-1.8}"
xr set-transform "\"device\":\"controller-left\",\"position\":{\"x\":-0.72,\"y\":1.02,\"z\":-0.22}"
xr set-transform "\"device\":\"controller-right\",\"position\":{\"x\":-0.28,\"y\":1.02,\"z\":-0.22}"
sleep 1.5
rm -f "$MARKS"
adb -s "$SERIAL" shell rm -f /sdcard/Movies/quest-headset.mp4
adb -s "$SERIAL" shell screenrecord --time-limit "$SECONDS_REC" --size 1920x1080 /sdcard/Movies/quest-headset.mp4 &
recorder=$!
echo "$(now)" > artifacts/video/quest-headset.start
sleep 1.5

mark "On a Quest 3, in mixed reality: Pip cam docked beside the scoreboard"
sleep 3.5
mark "Walk the duck with the left stick: the feed and status update live"
stick 0.2 -1
sleep 3.5
stick 0 0
sleep 0.8
mark "Drag its bar to put it anywhere: it stays there and turns to face you"
aim "$(pos bar)"
sleep 0.5
hold 1
sleep 0.3
aim "$(pos bar -0.3 0.12 0.25)"
sleep 0.8
hold 0
sleep 1.5
mark "Pull the corner grip to resize it"
aim "$(pos grip)"
sleep 0.5
hold 1
sleep 0.3
aim "$(pos grip 0.08 0.02 0.03)"
sleep 0.8
hold 0
sleep 1.5
mark "Expand it: policy output, IMU and feet, servos, autopilot"
click "$(pos rp-more)"
sleep 0.8
stick -0.25 -1
sleep 4
stick 0 0
sleep 2
click "$(pos rp-less)"
sleep 1
mark "A brain trained in Duck Lab XR on your room: TRY IT swaps it in while the duck walks"
sleep 2
click "$(pos rp-offer-try)"
sleep 3
mark "The pin button sends the panel back to its slot"
click "$(pos rp-pin)"
sleep 2.5
mark "Left stick click opens the menu at your side"
stick_click
sleep 2
mark "Pick a playground with the ray: Your Room"
click "$(pos pg-3)"
sleep 5
mark "Free roam in your own room"
stick 0 -1
sleep 4
stick 0 0
wait "$recorder"
adb -s "$SERIAL" pull /sdcard/Movies/quest-headset.mp4 artifacts/video/quest-headset-raw.mp4 > /dev/null
node tools/test/encode-headset.mjs artifacts/video/quest-headset-raw.mp4 artifacts/video/quest-headset.mp4 "$(cat artifacts/video/quest-headset.start)" "$MARKS"
