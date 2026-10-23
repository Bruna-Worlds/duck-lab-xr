#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Every scripted check, in order, against the running dev server
# (`npx @iwsdk/cli dev up --headed --open --allow-browser-automation`).
# Prints each script's PASS/FAIL lines and a final tally; exits 1 on any
# failure. About seventeen minutes. Starts the stand-in rendezvous
# (tools/test/mock-central.mjs) and Duck Lab XR when they are not running.
#
#   bash tools/test/all.sh
set -u
cd "$(dirname "$0")/../.."
totals=$(mktemp)
tally() {
  # $1: label, stdin: script output. Runs in a pipeline, so totals go through a file.
  local out
  out=$(cat)
  echo "$out" | grep -o "PASS[^\"]*\|FAIL[^\"]*" | sed "s/^/  /"
  local summary
  summary=$(echo "$out" | grep -o '{"passed":[0-9]*,"failed":[0-9]*}' | tail -1)
  local p f
  p=$(echo "$summary" | grep -o '"passed":[0-9]*' | grep -o '[0-9]*')
  f=$(echo "$summary" | grep -o '"failed":[0-9]*' | grep -o '[0-9]*')
  echo "${p:-0} ${f:-1}" >> "$totals"
  echo "$1: ${p:-0} passed, ${f:-?} failed"
}
echo "== renders and playground runtime (smoke.mjs)"
node tools/test/smoke.mjs all 2>&1 | tally smoke
echo "== editor (desktop)"
npx @iwsdk/cli browser run tools/test/editor-check.mjs --timeout 100000 2>&1 | tally editor
echo "== motions (desktop)"
npx @iwsdk/cli browser run tools/test/motion-check.mjs --timeout 100000 2>&1 | tally motion
echo "== robot panel (desktop)"
npx @iwsdk/cli browser run tools/test/robot-panel-check.mjs --timeout 100000 2>&1 | tally robot-panel
echo "== robot panel vision view (desktop, real clicks)"
npx @iwsdk/cli browser run tools/test/vision-check.mjs --timeout 100000 2>&1 | tally vision
echo "== head camera follows the head (desktop)"
npx @iwsdk/cli browser run tools/test/head-cam-check.mjs --timeout 100000 2>&1 | tally head-cam
echo "== physics worker reused across playgrounds (desktop)"
npx @iwsdk/cli browser run tools/test/worker-reuse-check.mjs --timeout 100000 2>&1 | tally worker-reuse
echo "== layout (2D HUD at several window sizes, in its own browser)"
node tools/test/layout-check.mjs 2>&1 | tally layout
echo "== dragging the room turns the camera (2D page, in its own browser)"
node tools/test/orbit-check.mjs 2>&1 | tally orbit
echo "== room mesh fills the terrain map (desktop)"
npx @iwsdk/cli browser run tools/test/mesh-heights-check.mjs --timeout 100000 2>&1 | tally mesh-heights
echo "== terrain and room colliders (emulated mixed reality)"
bash tools/test/mr.sh tools/test/terrain-check.mjs 14 2>&1 | tally terrain
echo "== scene understanding: scan, placement, duck camera (emulated mixed reality)"
bash tools/test/mr.sh tools/test/scene-check.mjs 14 2>&1 | tally scene
echo "== scenario pack (emulated mixed reality)"
bash tools/test/mr.sh tools/test/scenario-check.mjs 14 2>&1 | tally scenario
echo "== robot panel in a headset (emulated mixed reality)"
bash tools/test/robot-panel-xr.sh 2>&1 | tally robot-panel-xr
echo "== menu in a headset (emulated mixed reality)"
bash tools/test/menu-xr.sh 2>&1 | tally menu-xr
echo "== free roam (emulated mixed reality)"
bash tools/test/mr.sh tools/test/explore-check.mjs 14 2>&1 | tally explore
# Waits until a local URL answers (up to 15 s).
wait_for() {
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "$1" && return 0
    sleep 0.5
  done
  return 1
}
echo "== real duck link, against a stand-in rendezvous (desktop)"
mock_pid=""
if ! curl -s -o /dev/null http://localhost:8799/log; then
  node tools/test/mock-central.mjs > /dev/null 2>&1 &
  mock_pid=$!
  wait_for http://localhost:8799/log
fi
npx @iwsdk/cli browser run tools/test/real-duck-check.mjs --timeout 100000 2>&1 | tally real-duck
[ -n "$mock_pid" ] && kill "$mock_pid"
echo "== Duck Lab XR: publishing a brain, against a stand-in Hugging Face Hub"
node tools/test/hub-publish-check.mjs 2>&1 | tally hub-publish
echo "== Duck Lab XR: the publish form (desktop)"
lab_pid=""
if ! curl -s -o /dev/null http://localhost:8790/api/state; then
  node tools/lab/server.mjs > /dev/null 2>&1 &
  lab_pid=$!
  wait_for http://localhost:8790/api/state
fi
npx @iwsdk/cli browser run tools/test/lab-publish-ui.mjs --timeout 60000 2>&1 | tally lab-publish
echo "== Pairing: headset and trainer page over WebRTC (pack up, brain down, reconnect)"
node tools/test/pair-check.mjs 2>&1 | tally pairing
echo "== Desktop PLAY | TRAINER switch"
node tools/test/views-check.mjs 2>&1 | tally views
echo "== Desktop 2D page: How to play card, folding menu"
node tools/test/desktop-ui-check.mjs 2>&1 | tally desktop-ui
echo "== Trainer: export for any simulator"
node tools/test/export-check.mjs 2>&1 | tally export
[ -n "$lab_pid" ] && kill "$lab_pid"
total_pass=$(awk '{p += $1} END {print p + 0}' "$totals")
total_fail=$(awk '{f += $2} END {print f + 0}' "$totals")
rm -f "$totals"
echo "TOTAL: $total_pass passed, $total_fail failed"
[ "$total_fail" -eq 0 ]
