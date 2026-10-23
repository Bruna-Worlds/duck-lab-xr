#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# The end-to-end demo, real -> sim -> real, filmed in five parts and joined,
# with the flow strip (six steps) over the top:
#   A [1] headset (emulated mixed reality): the scanned room, Pip cam (the
#     head camera) with its sensor details; the vision view; a hard moment
#     saved as a test case
#   B [2,3] Duck Lab XR: the test case arrives; a falls test case from a Quest 3
#     replayed with the shipped brain (it falls); training runs on camera for
#     about 30 s, then a brain trained earlier on these test cases (room-tuned)
#     replays the same moment beside the shipped one and is sent to the
#     headset (LAB_TRAIN=full films a whole run as a time-lapse instead)
#   C [4] headset: the trained brain offered on Pip cam, TRY IT, a tight turn
#   D [5] Duck Lab XR: publish the brain to (a stand-in) Hugging Face
#   E [6] headset: link (a stand-in) Microduck through Pollen's API, FLASH BRAIN
# -> artifacts/video/e2e.mp4
#
# Needs the dev server (--allow-browser-automation), Duck Lab XR on 8790 and a
# trained release (room-tuned). Starts the stand-in rendezvous (8799), Hub
# (8798) and a second Duck Lab XR pointed at it (8791) when needed, and puts the
# releases back as they were afterwards (releases made during the film are removed).
#
#   bash tools/test/demo-e2e.sh            all five parts
#   PARTS="a" bash tools/test/demo-e2e.sh  only part A (B to E need the parts before them)
set -u
cd "$(dirname "$0")/../.."
IWSDK="node node_modules/@iwsdk/cli/bin/iwsdk.js"
V=artifacts/video
PARTS="${PARTS:-a b c d e}"
mkdir -p "$V"
cli() { $IWSDK "$@" --raw > /dev/null 2>&1; }
probe() { PROBE="$1" $IWSDK browser run tools/test/probe.mjs 2>&1 | grep -o "PROBE [^\"]*" | sed "s/^PROBE //; s/'/\"/g"; }
now() { node -e "console.log((Date.now() / 1000).toFixed(3))"; }
num() { node -e "const s = JSON.parse(process.argv[1]); console.log($2)" "$1"; }
want() { case " $PARTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# --- Headset helpers (as in demo-xr.sh) -----------------------------------------------
REC=""
RECPID=""
start_rec() { # name seconds
  REC="$1"
  rm -f "$V/$REC.marks"
  REC_NAME="$REC" REC_SECONDS="$2" $IWSDK browser run tools/test/record-xr.mjs --timeout 110000 > "$V/$REC.rec.log" 2>&1 &
  RECPID=$!
  for _ in $(seq 1 60); do [ -f "$V/$REC/targets.json" ] && break; sleep 0.25; done
  sleep 0.8
}
end_rec() {
  wait "$RECPID"
  grep -o "REC [^\"]*" "$V/$REC.rec.log"
  mv "$V/$REC.marks" "$V/$REC/marks.txt"
}
mark() { echo "$(now) $*" >> "$V/$REC.marks"; }
target() { # name [dx dy dz]
  node -e "
const t = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const p = t[process.argv[2]];
if (!p) process.exit(1);
console.log(JSON.stringify({ x: p.x + Number(process.argv[3]), y: p.y + Number(process.argv[4]), z: p.z + Number(process.argv[5]) }));
" "$V/$REC/targets.json" "$1" "${2:-0}" "${3:-0}" "${4:-0}"
}
field() { node -e "const t = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(JSON.stringify(t[process.argv[2]]))" "$V/$REC/targets.json" "$1"; }
wait_for() { # js condition on t (targets), seconds
  for _ in $(seq 1 $(( $2 * 4 ))); do
    node -e "const t = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.exit(($1) ? 0 : 1)" "$V/$REC/targets.json" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
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
bow() {
  cli xr set-gamepad-state --input-json '{"device":"controller-right","buttons":[{"index":3,"value":1}]}'
  sleep 0.2
  cli xr set-gamepad-state --input-json '{"device":"controller-right","buttons":[{"index":3,"value":0}]}'
}
place() { cli xr set-transform --input-json "{\"device\":\"$1\",\"position\":{\"x\":$2,\"y\":$3,\"z\":$4}}"; }
# Moves the head smoothly to x y z, looking at tx ty tz, over the given seconds.
glide() { # x y z tx ty tz seconds
  local q
  q=$(node -e "
const [x, y, z, tx, ty, tz] = process.argv.slice(1).map(Number);
const dx = tx - x, dy = ty - y, dz = tz - z;
const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
console.log(JSON.stringify({ x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp }));
" -- "$1" "$2" "$3" "$4" "$5" "$6")
  cli xr animate-to --input-json "{\"device\":\"headset\",\"position\":{\"x\":$1,\"y\":$2,\"z\":$3},\"orientation\":$q,\"duration\":$7}"
}
# A fixed scene for every film: the course put in one place with the app's
# move-course action (what the right grip does), the start pad at (1.5, 0.21)
# and the course running along the TV wall, the scoreboard and Pip cam beyond
# it; and a fixed seat (head x y z, then the point it looks at) from which the
# duck, the course and Pip cam with its details open are all in shot. The
# right hand is low and to the side, so only its ray shows; the left hand is
# out of shot.
COURSE="new V(1.5, 0, 0.21), new V(0, 0, -1)" # stage origin on the floor, direction it runs
SEAT="${SEAT:--0.35 1.55 -0.4 2.12 0.9 -0.4}"
HAND="${HAND:--0.1 1.17 -0.16}"
to_seat() { glide $SEAT "${1:-1.6}"; place controller-right $HAND; }
# Stay in the seat and turn the head to look at a point: look_at x y z seconds.
look_at() { glide $(echo $SEAT | cut -d" " -f1-3) "$1" "$2" "$3" "${4:-1.2}"; }
need() { for p in "$@"; do want "$p" && return 0; done; return 1; }

# --- Setup ----------------------------------------------------------------------------------
release=$(node -e "const i = require('./public/policies/incoming/index.json'); const r = i.releases.find((x) => /room-tuned/.test(x.name)) ?? i.releases[0]; console.log(r ? r.id : '')")
[ -n "$release" ] || { echo "no trained release in public/policies/incoming"; exit 1; }
MANIFEST="public/policies/incoming/$release/manifest.json"
releases_before=$(ls public/policies/incoming)
cp "$MANIFEST" "$V/e2e-manifest-backup.json"
# Only what the chosen parts need: the offer (B, C), the stand-in Hub and its
# Duck Lab XR (D), the stand-in duck service (E).
need b && node tools/train/release.mjs deactivate > /dev/null # B sends the brain to the headset again
# Part A comes before any training: Pip cam should not offer a brain then.
active=$(node -e "console.log(JSON.parse(require('fs').readFileSync('public/policies/incoming/index.json', 'utf8')).active ?? '')")
dismiss=""
want a && ! want b && dismiss="$active"
node tools/test/flow-strip.mjs > /dev/null
started=()
if need e && ! curl -s -o /dev/null http://localhost:8799/log; then
  node tools/test/mock-central.mjs > /dev/null 2>&1 &
  started+=($!)
fi
if need d; then
  node tools/test/mock-hub.mjs 8798 > /dev/null 2>&1 &
  started+=($!)
  DUCKLAB_HUB_URL=http://localhost:8798 node tools/lab/server.mjs --port 8791 > /dev/null 2>&1 &
  started+=($!)
fi
cleanup() {
  cp "$V/e2e-manifest-backup.json" "$MANIFEST"
  # Remove only the releases made during the film.
  for dir in public/policies/incoming/*/; do
    echo "$releases_before" | grep -qx "$(basename "$dir")" || rm -rf "$dir"
  done
  node tools/train/release.mjs rescan > /dev/null
  node tools/train/release.mjs activate "$release" > /dev/null
  for pid in "${started[@]}"; do kill "$pid" 2> /dev/null; done
}
trap cleanup EXIT
probe "(localStorage.removeItem('duckdash.brain'), localStorage.setItem('duckdash.brain.dismissed', '$dismiss'), localStorage.setItem('duckdash.robotPanel.size', 'normal'), localStorage.setItem('duckdash.robotPanel.scale', '1'), localStorage.setItem('duckdash.cam.view', 'motion'), 1)" > /dev/null
cli browser reload --input-json '{}'
sleep 12
cli xr enter --input-json '{}'
sleep 6
to_seat 0.3
place controller-left -0.7 1.0 -0.75
# The seat first: the scoreboard and Pip cam stand beyond the course as seen from here.
probe "(() => { const d = globalThis.__duck; const V = d.world.scene.position.constructor; d.duck.placeCourse($COURSE); return 1; })()" > /dev/null
sleep 5 # Pip stands back up on the start pad
sleep 2

# --- A: the room, Pip cam, vision, a hard moment ---------------------------------------
if want a; then
  start_rec e2e-a 58
  mark "[1] Mixed reality: Pip walks your scanned room. The course sits on your floor; walls and furniture are solid"
  stick 0 -1
  sleep 3
  stick 0 0
  sleep 0.6
  mark "Pip cam is the duck's head camera: it turns and nods with the head"
  bow
  sleep 3
  mark "MORE opens the sensor details, live: the joint targets from the brain, the IMU and the feet"
  click "$(target more)"
  sleep 1
  stick 0.25 -1
  sleep 3.5
  stick 0 0
  sleep 0.6
  mark "VISION: what Pip sees, every object labelled exactly from the simulation"
  click "$(target viewVision)"
  sleep 1
  stick -0.35 -0.8
  sleep 3
  stick 0 0
  sleep 1.5
  mark "A hard moment, Pip pushing into the books: X saves the last 20 s as a test case. Two falls or getting stuck save one by themselves"
  stick 0 -1
  sleep 3.5
  stick 0 0
  # What X does: pack the last moments (the recorder runs it in the page).
  echo "globalThis.__duck.scenario.capture('manual')" > "$V/$REC/command.js"
  wait_for "/test case/.test(t.status)" 8
  sleep 2.5
  end_rec
fi

# --- B: Duck Lab XR replays and trains -----------------------------------------------------------
if want b; then
  node tools/test/record-lab.mjs train e2e-b http://localhost:8790/ | grep -o "REC .*"
fi

# --- C: the new brain comes back to the headset ----------------------------------------------
if want c; then
  to_seat 0.3 # an emulator command first, so its own controls are not on screen
  start_rec e2e-c 95
  mark "[4] Back in the headset: Pip cam offers the brain Duck Lab XR sent"
  wait_for "t.offer" 12
  sleep 1.2
  mark "TRY IT swaps it in while Pip keeps walking"
  click "$(target offerTry)"
  sleep 1.5
  # Tight turns on the open floor beside the start (the book stacks are ahead).
  mark "Tight turns with the new brain: Pip stays on its feet"
  stick -0.8 -0.85
  sleep 6
  stick 0 0
  sleep 1
  # Auto: the autopilot plans a way round the books and through the first gate;
  # the new brain does the walking. Slow, so it plays fast.
  mark "Auto: Pip plans its own way around the books and through the gate, with the new brain doing the walking"
  # Its way round swings wide, towards you: lean back and look down to keep it in shot.
  # (Not so far back that the emulator's floor ring round the room origin comes into view.)
  place controller-right -0.9 1.1 -0.5
  place controller-left -0.9 1.1 -0.9 # both hands behind the new head position
  glide -0.45 1.65 -0.7 1.6 0.3 -0.55 1.5
  sleep 1
  mark "!ff 4"
  echo "globalThis.__duck.nav.runCourse()" > "$V/$REC/command.js"
  sleep 1
  wait_for "t.navLeft <= 5 || !t.navTask" 70
  sleep 1.2
  mark "!ff 1"
  echo "globalThis.__duck.nav.stop()" > "$V/$REC/command.js"
  mark "Through the gate"
  sleep 1.5
  to_seat 1.5
  place controller-left -0.7 1.0 -0.75
  end_rec
fi

# --- D: publish it to the Hub -------------------------------------------------------------------
if want d; then
  node tools/test/record-lab.mjs publish e2e-d http://localhost:8791/ | grep -o "REC .*"
fi

# --- E: and onto a real duck ---------------------------------------------------------------------
if want e; then
  probe "(sessionStorage.setItem('duckdash.hfToken', 'hf_duckdash_demo_token'), globalThis.__duck.realDuck.link = new (globalThis.__duck.realDuck.link.constructor)('http://localhost:8799'), 1)" > /dev/null
  to_seat 0.3 # an emulator command first, so its own controls are not on screen
  start_rec e2e-e 38
  mark "[6] And onto a real Microduck: the menu's REAL DUCK section"
  stick_click
  sleep 1.2
  # Turn to the menu (it opens beside you), then back to the duck at the end.
  menu=$(target realLink 0 -0.05 0)
  look_at $(num "$menu" "[s.x, s.y, s.z].join(' ')") 1.2
  sleep 0.8
  mark "LINK finds your duck through Pollen's service (here a stand-in duck on the same API)"
  click "$(target realLink)"
  wait_for "t.linked" 10
  sleep 1.5
  mark "FLASH BRAIN: the duck downloads the brain from the Hub and walks with it"
  click "$(target realFlash)"
  wait_for "/now walks/.test(t.realNote)" 12
  sleep 2.5
  mark "Real to sim to real: your room's hard moments make the duck's brain better"
  stick_click
  to_seat 1.2
  sleep 2.5
  end_rec
  probe "(globalThis.__duck.realDuck.forget(), 1)" > /dev/null # unlink the stand-in duck, forget the demo token
fi
# Leave the panel and camera as a player finds them.
probe "(() => { const d = globalThis.__duck; d.robotPanel.follow(); d.robotPanel.setSize('normal'); d.robotPanel.setPanelScale(1); d.cam.setView('motion'); localStorage.removeItem('duckdash.brain.dismissed'); return 1; })()" > /dev/null
cli xr exit --input-json '{}'

# --- Encode and join ---------------------------------------------------------------------------------
clips=()
for part in a b c d e; do
  want "$part" || continue
  node tools/test/encode-rec.mjs "$V/e2e-$part" "$V/e2e-$part.mp4" | grep -o "ENC .*"
  clips+=("$V/e2e-$part.mp4")
done
[ "$PARTS" = "a b c d e" ] && node tools/test/join-clips.mjs "$V/e2e.mp4" "${clips[@]}"
