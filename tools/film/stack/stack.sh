#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# The stacked phone film (1080 x 1920): the emulated headset in mixed reality
# on top, Duck Lab XR's trainer page below, filmed at the same time and paired
# for real over WebRTC (trystero over public Nostr relays). One story:
#   Pip walks the room -> Pip cam opens on its live robot data -> a hard moment
#   saved on the headset -> it arrives on the computer -> replayed (the shipped
#   brain falls) -> a short training -> a brain trained on these moments goes
#   back -> TRY IT on the headset -> Pip walks the course on it.
# -> artifacts/video/stack/ (raw takes), then compose-stack.mjs makes the film.
#
# Needs the dev server (--allow-browser-automation), the trainer engine on
# 8790 with a release named like LAB_SHOWN (default room-tuned). Puts the
# engine's active release and the headset page's pairing back afterwards.
#
#   bash tools/film/stack/stack.sh && node tools/film/stack/compose-stack.mjs
set -u
cd "$(dirname "$0")/../../.."
IWSDK="node node_modules/@iwsdk/cli/bin/iwsdk.js"
OUT=artifacts/video/stack
ENGINE=http://localhost:8790
# The app as a headset opens it: a desktop browser does not look for trainers to pair with.
SITE="${SITE:-https://localhost:8081/}"
goto() { GOTO="$1" $IWSDK browser run tools/test/goto.mjs > /dev/null 2>&1; }
rm -rf "$OUT"
mkdir -p "$OUT"
cli() { $IWSDK "$@" --raw > /dev/null 2>&1; }
probe() { PROBE="$1" $IWSDK browser run tools/test/probe.mjs 2>&1 | grep -o "PROBE [^\"]*" | sed "s/^PROBE //; s/'/\"/g"; }
now() { node -e "console.log((Date.now() / 1000).toFixed(3))"; }
mark() { echo "$(now) $*" >> "$OUT/headset.marks"; echo "MARK $*"; }
ticks() { awk "BEGIN { print int($1 * 4 + 0.5) }"; } # seconds (fractions too) -> quarter-second ticks
wait_file() { for _ in $(seq 1 "$(ticks "$2")"); do [ -f "$OUT/$1" ] && return 0; sleep 0.25; done; return 1; }

# --- The headset's recorder: one browser lease, up to 104 s (the story fits in it) ---
segment() { echo "$OUT/headset-1"; }
run_page() { echo "$1" > "$(segment)/command.js"; } # page code while filming (the recorder runs it)
targets() { cat "$(segment)/targets.json" 2> /dev/null; }
target() { # name -> {x,y,z}
  node -e "const t = JSON.parse(process.argv[1] || '{}'); const p = t[process.argv[2]]; if (!p) process.exit(1); console.log(JSON.stringify(p));" "$(targets)" "$1"
}
wait_for() { # js condition on t (targets), seconds
  for _ in $(seq 1 "$(ticks "$2")"); do
    node -e "const t = JSON.parse(process.argv[1] || '{}'); process.exit(($1) ? 0 : 1)" "$(targets)" 2> /dev/null && return 0
    sleep 0.25
  done
  return 1
}
aim() { cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$1}"; }
click() {
  aim "$1"
  sleep 0.4
  cli xr select --input-json '{"device":"controller-right","duration":0.25}'
}
place() { cli xr set-transform --input-json "{\"device\":\"$1\",\"position\":{\"x\":$2,\"y\":$3,\"z\":$4}}"; }
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
# The demo film's fixed scene and seat (tools/test/demo-e2e.sh): Pip, the course and Pip cam all in shot.
COURSE="new V(1.5, 0, 0.21), new V(0, 0, -1)"
# (Looking a little lower than the demo film: Pip stays in frame down to the start pad.)
SEAT="${SEAT:--0.35 1.55 -0.4 2.12 0.7 -0.4}"
HAND="${HAND:--0.1 1.17 -0.16}"
# The last walk: higher and closer over the course, so the way round the books (towards
# the seat) stays in the picture; the panels leave the top of it.
WALK_SEAT="${WALK_SEAT:-0.0 1.35 -0.25 1.25 0.0 -0.38}"

# --- Setup -------------------------------------------------------------------------
# (The engine's state is too long for a command line: node reads it itself.)
read -r active_before shown_id walk_hash < <(node -e "
fetch('$ENGINE/api/state').then((r) => r.json()).then((s) => {
  const r = s.releases.releases.find((x) => x.name === (process.env.LAB_SHOWN ?? 'room-tuned'));
  console.log([s.releases.active ?? '-', r ? r.id : '-', r ? r.walkHash : '-'].join(' '));
}, () => console.log('- - -'));
")
[ "$active_before" = "-" ] && active_before=""
for d in public/policies/incoming/*-film-quick/; do [ -d "$d" ] && rm -rf "$d" && echo "removed a leftover film release: $d"; done
node tools/train/release.mjs rescan > /dev/null
[ -n "$shown_id" ] && [ "$shown_id" != "-" ] || { echo "no release named ${LAB_SHOWN:-room-tuned} in the trainer (or the engine is not running on 8790)"; exit 1; }
curl -s -X POST "$ENGINE/api/releases/deactivate" -H 'content-type: application/json' -d '{}' > /dev/null
packs_before=$(ls artifacts/scenarios)
releases_before=$(ls public/policies/incoming)
cleanup() {
  touch "$OUT/done.txt"
  [ -n "${RECPID:-}" ] && wait "$RECPID" 2> /dev/null
  [ -n "${TPID:-}" ] && wait "$TPID" 2> /dev/null
  # Leave the browser as it was before the film: unpaired, on the shipped brain, no linked brains kept.
  probe "(globalThis.__duck.labLink.forget(), globalThis.__duck.policyInbox.revert(), localStorage.removeItem('ducklab.autoPacks'), localStorage.removeItem('ducklab.linkedBrains'), localStorage.removeItem('duckdash.brain'), caches.delete('ducklab-brains'), 1)" > /dev/null || echo 'cleanup: could not reset the browser (unpair it with ?unpair)'
  if [ -n "$active_before" ]; then curl -s -X POST "$ENGINE/api/releases/$active_before/activate" -H 'content-type: application/json' -d '{}' > /dev/null
  else curl -s -X POST "$ENGINE/api/releases/deactivate" -H 'content-type: application/json' -d '{}' > /dev/null; fi
  # The film's test case and quick training leave nothing behind.
  for f in artifacts/scenarios/*; do echo "$packs_before" | grep -qx "$(basename "$f")" || rm -f "$f"; done
  for d in public/policies/incoming/*/; do echo "$releases_before" | grep -qx "$(basename "$d")" || rm -rf "$d"; done
  node tools/train/release.mjs rescan > /dev/null
  goto "$SITE" # the managed window back on the plain page
}
trap cleanup EXIT

probe "(localStorage.removeItem('duckdash.brain'), localStorage.removeItem('duckdash.brain.dismissed'), localStorage.setItem('duckdash.robotPanel.size', 'normal'), localStorage.setItem('duckdash.robotPanel.scale', '1'), localStorage.setItem('duckdash.cam.view', 'motion'), localStorage.setItem('ducklab.view', 'play'), localStorage.setItem('ducklab.controlsSeen', '1'), localStorage.removeItem('ducklab.pairedTrainer'), localStorage.removeItem('ducklab.linkedBrains'), localStorage.setItem('ducklab.autoPacks', '0'), 1)" > /dev/null
echo "$SEAT" > "$OUT/seat.txt" # the composer projects panels into the picture with it
node tools/film/stack/warm-trainer.mjs # Vite pre-bundles what the trainer loads now, not mid-film
goto "${SITE}?landing=1"
sleep 12
cli xr enter --input-json '{}'
sleep 6
glide $SEAT 0.3
place controller-right $HAND
place controller-left -0.7 1.0 -0.75
probe "(() => { const d = globalThis.__duck; const V = d.world.scene.position.constructor; d.duck.placeCourse($COURSE); return 1; })()" > /dev/null
sleep 7

# The trainer page (its own browser) and the pairing.
node tools/film/stack/record-trainer.mjs "$OUT/trainer" > "$OUT/trainer.log" 2>&1 &
TPID=$!
wait_file code.txt 60 || { echo "the trainer page showed no code"; exit 1; }
code=$(cat "$OUT/code.txt")
echo "pairing with $code"
probe "(globalThis.__duck.labLink.pairCode('$code'), 1)" > /dev/null
wait_file paired.txt 40 || { echo "the headset did not pair"; exit 1; }

# The headset's recorder (one lease: a second one cannot start cleanly while the CLI is busy).
REC_NAME="stack/headset-1" REC_SECONDS=104 $IWSDK browser run tools/test/record-xr.mjs --timeout 110000 > "$OUT/rec-headset-1.log" 2>&1 &
RECPID=$!
for _ in $(seq 1 60); do [ -f "$(segment)/targets.json" ] && break; sleep 0.25; done
sleep 1

# --- The story (headset side; the trainer page plays its part as things arrive) --------
mark "Pip walks your living room, in mixed reality"
run_page "globalThis.__duck.nav.runCourse()"
mark "!ff 2" # walking is slow: the film shows it twice as fast (with a badge)
sleep 6.5
mark "!ff 1"
# Pip cam opens on its live data (what its expand button does; a ray click costs seconds of the lease).
mark "Live robot data: every joint, the balance sensor and the brain's output"
run_page "globalThis.__duck.robotPanel.setSize('details')"
sleep 6
run_page "globalThis.__duck.robotPanel.setSize('normal')"
sleep 1
mark "A hard moment? One tap saves it as a test case"
sleep 1.5
run_page "globalThis.__duck.scenario.capture('manual')"
wait_for "/test case|has it/.test(t.status)" 15
sleep 2
run_page "globalThis.__duck.nav.stop?.()"
wait_file offered.txt 240 || { echo "the trainer never sent a brain"; exit 1; }
wait_for "t.offer" 40 || echo "no offer on the headset"
sleep 0.8
mark "The new brain is on the headset: TRY IT"
sleep 2.4
# TRY IT with the controller ray; if the click is lost, the page's own accept. The wait is cut from the film.
click "$(target offerTry)"
# The controller leaves the picture while the brain loads and the film is close on Pip cam (its ray pointing away).
place controller-right -0.45 1.0 0.05
aim '{"x":-3,"y":1,"z":0.5}'
if ! wait_for "t.brain === '$walk_hash'" 2.5; then
  echo "TRY IT through the page"
  mark "!cut"
  run_page "globalThis.__duck.policyInbox.accept()"
  wait_for "t.brain === '$walk_hash'" 20 || echo "the brain did not load"
  mark "!resume"
fi
sleep 0.3
mark "Pip walks with the brain trained on your room, round the books"
run_page "globalThis.__duck.nav.runCourse()"
mark "!ff 3" # the room-tuned brain walks slowly: three times as fast, round the books and through the gate
glide $WALK_SEAT 1.2
sleep 28
touch "$OUT/done.txt"
for s in "$OUT"/headset-*/; do touch "$s/stop"; done
wait "$RECPID"
wait "$TPID"
RECPID=""
TPID=""
grep -h "REC " "$OUT"/rec-headset-*.log "$OUT/trainer.log" | head
echo "STACK takes in $OUT"
