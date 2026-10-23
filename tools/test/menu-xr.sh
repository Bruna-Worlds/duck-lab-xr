#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# The menu in a headset (emulated mixed reality): closed at first, opened by
# clicking the left thumbstick, placed in front of the player and facing
# them, a playground picked with the right ray loads (and closes the menu),
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
# Menu state: open flag, document shown, where it is relative to the head, and a chip's world position.
MENU="(() => { const d = globalThis.__duck; const w = d.world; const asset = w.getSceneObject('menu-panel'); const host = w.requireSceneEntity('menu-panel').object3D; const V = host.position.constructor; const Q = host.quaternion.constructor; const hp = new V(), head = new V(); host.getWorldPosition(hp); w.player.head.getWorldPosition(head); const z = new V(0, 0, 1).applyQuaternion(host.getWorldQuaternion(new Q())); const to = head.clone().sub(hp); const dist = to.length(); to.normalize(); const at = (id) => { const el = asset.getElementById(id); const p = new V(); el.getWorldPosition(p); return { x: p.x, y: p.y, z: p.z }; }; const fwd = new V(0, 0, -1).applyQuaternion(w.player.head.getWorldQuaternion(new Q())); const toPanel = hp.clone().sub(head).normalize(); const offAxis = Math.acos(Math.max(-1, Math.min(1, fwd.dot(toPanel)))) * 180 / Math.PI; const size = asset.document.computedSize; const ws = new V(); host.getWorldScale(ws); const halfWidth = size ? Math.atan((size.width * 0.01 * ws.x) / 2 / dist) * 180 / Math.PI : 0; return { offAxis: Math.round(offAxis), halfWidth: Math.round(halfWidth), open: d.hud.menuOpen, shown: asset.document.visible, distance: Math.round(dist * 1000) / 1000, facing: Math.round(z.dot(to) * 1000) / 1000, chip: at('pg-1'), close: at('menu-close'), playground: d.playgrounds.current }; })()"
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
check "in front of the player" "$(num "$m1" "s.distance > 0.4 && s.distance < 0.9 ? 1 : 0")" "$(num "$m1" "s.distance") m from the eyes"
check "faces the player" "$(num "$m1" "s.facing > 0.95 ? 1 : 0")" "facing $(num "$m1" "s.facing")"
check "keeps the centre of view clear" "$(num "$m1" "s.offAxis - s.halfWidth >= 10 ? 1 : 0")" "centre $(num "$m1" "s.offAxis") deg off the line of sight, $(num "$m1" "2 * s.halfWidth") deg wide"
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
