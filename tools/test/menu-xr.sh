#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# The menu in a headset (emulated mixed reality): closed at first, opened by
# clicking the left thumbstick, hung beside the scoreboard on its right (in
# its plane, centred on it and the move bar, covering neither, and Pip cam
# steps aside), a playground picked with the right ray loads (and closes the menu),
# the menu's close button works, and a closed menu does not catch rays.
# Needs the dev server with --allow-browser-automation. Prints PASS/FAIL
# lines and a JSON tally.
#
#   bash tools/test/menu-xr.sh
set -u
cd "$(dirname "$0")/../.."
pass=0
fail=0
check() { # name ok detail
  if [ "$2" = "1" ]; then pass=$((pass + 1)); echo "PASS $1 - $3"; else fail=$((fail + 1)); echo "FAIL $1 - $3"; fi
}
probe() {
  PROBE="$1" npx @iwsdk/cli browser run tools/test/probe.mjs 2>&1 | grep -o "PROBE [^\"]*" | sed "s/^PROBE //; s/'/\"/g"
}
cli() { npx @iwsdk/cli "$@" --raw > /dev/null 2>&1; }
num() { node -e "const s = JSON.parse(process.argv[1]); console.log($2)" "$1"; }
# Menu state: open flag, document shown, where it hangs in the scoreboard's frame (metres), what it covers, and two chips' world positions.
MENU="(() => { const d = globalThis.__duck; const w = d.world; const asset = w.getSceneObject('menu-panel'); const host = w.requireSceneEntity('menu-panel').object3D; const score = w.requireSceneEntity('run-panel').object3D; const moves = w.requireSceneEntity('moves-panel').object3D; const V = host.position.constructor; const Q = host.quaternion.constructor; const sq = score.getWorldQuaternion(new Q()); const inv = sq.clone().invert(); const sp = score.getWorldPosition(new V()); const rect = (o, doc) => { if (!o || !doc || !doc.computedSize) return null; const c = o.getWorldPosition(new V()).sub(sp).applyQuaternion(inv); const s = new V(); o.getWorldScale(s); const hw = doc.computedSize.width * 0.01 * s.x / 2; const hh = doc.computedSize.height * 0.01 * s.y / 2; return { x0: c.x - hw, x1: c.x + hw, y0: c.y - hh, y1: c.y + hh, y: c.y, z: c.z }; }; const m = rect(host, asset.document); const b = rect(score, w.getSceneObject('run-panel').document); const mv = rect(moves, w.getSceneObject('moves-panel').document); const rp = d.robotPanel; const r = rp && rp.hostEntity && rp.asset ? rect(rp.hostEntity.object3D, rp.asset.document) : null; const over = (a, c) => !!(a && c && a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1); const turn = 2 * Math.acos(Math.min(1, Math.abs(host.getWorldQuaternion(new Q()).dot(sq)))) * 180 / Math.PI; const at = (id) => { const el = asset.getElementById(id); const p = new V(); el.getWorldPosition(p); return { x: p.x, y: p.y, z: p.z }; }; const right = Math.max(b.x1, mv ? mv.x1 : b.x1); const mid = (b.y1 + (mv ? mv.y0 : b.y0)) / 2; const r3 = (v) => Math.round(v * 1000) / 1000; return { open: d.hud.menuOpen, shown: asset.document.visible, gap: r3(m.x0 - right), dy: r3(m.y - mid), plane: r3(Math.abs(m.z)), turn: Math.round(turn * 10) / 10, overBlock: over(m, b) || over(m, mv), overRobot: over(m, r), chip: at('pg-1'), close: at('menu-close'), playground: d.playgrounds.current }; })()"
click_stick() {
  cli xr set-gamepad-state --input-json '{"device":"controller-left","buttons":[{"index":2,"value":1}]}'
  sleep 0.4
  cli xr set-gamepad-state --input-json '{"device":"controller-left","buttons":[{"index":2,"value":0}]}'
  sleep 1
}
ray_click() { # target json
  cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$1}"
  sleep 0.8
  cli xr select --input-json '{"device":"controller-right","duration":0.2}'
  sleep 1
}

cli browser reload --input-json '{}'
sleep 12
cli xr enter --input-json '{}'
sleep 6
m0=$(probe "$MENU")
echo "menu $m0"
[ -n "$m0" ] || { echo "FAIL probe - no state"; echo '{"passed":0,"failed":1}'; exit 1; }
check "menu closed at first" "$(num "$m0" "!s.open && !s.shown ? 1 : 0")" "open $(num "$m0" "s.open") shown $(num "$m0" "s.shown")"

click_stick
m1=$(probe "$MENU")
echo "menu $m1"
check "left stick click opens it" "$(num "$m1" "s.open && s.shown ? 1 : 0")" "open $(num "$m1" "s.open") shown $(num "$m1" "s.shown")"
check "beside the scoreboard, on its right" "$(num "$m1" "s.gap > 0.02 && s.gap < 0.15 && Math.abs(s.dy) < 0.05 ? 1 : 0")" "$(num "$m1" "s.gap") m right of the scoreboard and move bar, centred $(num "$m1" "s.dy") m off"
check "in their plane, turned as they are" "$(num "$m1" "s.plane < 0.02 && s.turn < 1 ? 1 : 0")" "$(num "$m1" "s.plane") m off the plane, turned $(num "$m1" "s.turn") deg"
check "covers neither the scoreboard nor the move bar" "$(num "$m1" "!s.overBlock ? 1 : 0")" "over them $(num "$m1" "s.overBlock")"
sleep 2.5 # Pip cam glides to its slot
m1b=$(probe "$MENU")
check "Pip cam steps aside" "$(num "$m1b" "!s.overRobot ? 1 : 0")" "over Pip cam $(num "$m1b" "s.overRobot")"
cli browser screenshot --output-file artifacts/ui/xr-menu.png

before=$(num "$m1" "s.playground")
ray_click "$(num "$m1" "JSON.stringify(s.chip)")"
sleep 6
m2=$(probe "$MENU")
echo "menu $m2"
check "ray picks a playground" "$(num "$m2" "s.playground !== '$before' ? 1 : 0")" "$before -> $(num "$m2" "s.playground")"
check "menu closes after picking" "$(num "$m2" "!s.open && !s.shown ? 1 : 0")" "open $(num "$m2" "s.open") shown $(num "$m2" "s.shown")"

# A closed menu catches no rays: aim where the chip was and click.
now=$(num "$m2" "s.playground")
ray_click "$(num "$m1" "JSON.stringify(s.chip)")"
sleep 3
m3=$(probe "$MENU")
check "closed menu ignores rays" "$(num "$m3" "s.playground === '$now' ? 1 : 0")" "still $(num "$m3" "s.playground")"

click_stick
m4=$(probe "$MENU")
ray_click "$(num "$m4" "JSON.stringify(s.close)")"
m5=$(probe "$MENU")
check "close button closes it" "$(num "$m5" "!s.open && !s.shown ? 1 : 0")" "open $(num "$m5" "s.open") shown $(num "$m5" "s.shown")"

# Back to the first playground for whatever runs next.
probe "globalThis.__duck.playgrounds.load('living-room-dash')" > /dev/null
sleep 4
cli xr exit --input-json '{}'
echo "{\"passed\":$pass,\"failed\":$fail}"
[ "$fail" -eq 0 ]
