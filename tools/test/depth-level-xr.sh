#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# The menu's ROOM DEPTH chips in a headset (emulated mixed reality): shown in
# mixed reality with the level in use highlighted; a right-ray click on a chip
# switches the terrain (Fine: 3 cm cells and a soft depth layer; Off: no live
# depth; back to Filtered) and the browser remembers the choice; outside XR
# the row is hidden. Needs the dev server with --allow-browser-automation.
# Prints PASS/FAIL lines and a JSON tally.
#
#   bash tools/test/depth-level-xr.sh
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
# The terrain's level and scale, the remembered choice, the row's display, each chip's fill and where three chips are.
STATE="(() => { const d = globalThis.__duck; const w = d.world; const asset = w.getSceneObject('menu-panel'); const V = w.requireSceneEntity('menu-panel').object3D.position.constructor; const at = (id) => { const p = new V(); asset.getElementById(id).getWorldPosition(p); return { x: p.x, y: p.y, z: p.z }; }; const shown = d.hud.shown; let stored = null; try { stored = localStorage.getItem('ducklab.depthLevel'); } catch {} return { open: d.hud.menuOpen, level: d.terrain.level, cell: d.terrain.cell, half: d.terrain.half, summary: d.terrain.summary.replace(/[\"']/g, ''), stored, row: shown.get('depth-row:display') ?? 'none', bg: { off: shown.get('depth-off:bg'), raw: shown.get('depth-raw:bg'), filtered: shown.get('depth-filtered:bg'), fine: shown.get('depth-fine:bg') }, fine: at('depth-fine'), off: at('depth-off'), filtered: at('depth-filtered') }; })()"
YELLOW="#ffcf3f"
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
  sleep 1.5
}

# Start from the default level.
probe "(() => { try { localStorage.setItem('ducklab.depthLevel', 'filtered'); } catch {} return 1; })()" > /dev/null
cli browser reload --input-json '{}'
sleep 12
cli xr enter --input-json '{}'
sleep 6
click_stick
s0=$(probe "$STATE")
echo "state $s0"
[ -n "$s0" ] || { echo "FAIL probe - no state"; echo '{"passed":0,"failed":1}'; exit 1; }
check "ROOM DEPTH shows in mixed reality" "$(num "$s0" "s.open && s.row === 'flex' ? 1 : 0")" "menu open $(num "$s0" "s.open"), row $(num "$s0" "s.row")"
check "the level in use is highlighted" "$(num "$s0" "s.level === 'filtered' && s.bg.filtered === '$YELLOW' && s.bg.fine !== '$YELLOW' ? 1 : 0")" "level $(num "$s0" "s.level"), Filtered $(num "$s0" "s.bg.filtered"), Fine $(num "$s0" "s.bg.fine")"

ray_click "$(num "$s0" "JSON.stringify(s.fine)")"
s1=$(probe "$STATE")
echo "state $s1"
check "Fine: 3 cm cells, soft depth" "$(num "$s1" "s.level === 'fine' && Math.abs(s.cell - 0.03) < 1e-6 && s.half === 3 && /Fine, 3 cm, soft/.test(s.summary) ? 1 : 0")" "level $(num "$s1" "s.level"), $(num "$s1" "Math.round(s.cell * 1000) / 10") cm over +-$(num "$s1" "s.half") m; $(num "$s1" "s.summary")"
check "Fine highlighted and remembered" "$(num "$s1" "s.bg.fine === '$YELLOW' && s.bg.filtered !== '$YELLOW' && s.stored === 'fine' ? 1 : 0")" "Fine $(num "$s1" "s.bg.fine"), stored $(num "$s1" "s.stored")"

ray_click "$(num "$s1" "JSON.stringify(s.off)")"
s2=$(probe "$STATE")
echo "state $s2"
check "Off: no live depth" "$(num "$s2" "s.level === 'off' && /live depth not used/.test(s.summary) && s.stored === 'off' ? 1 : 0")" "level $(num "$s2" "s.level"); $(num "$s2" "s.summary")"

ray_click "$(num "$s2" "JSON.stringify(s.filtered)")"
s3=$(probe "$STATE")
echo "state $s3"
check "back to Filtered at 4 cm" "$(num "$s3" "s.level === 'filtered' && Math.abs(s.cell - 0.04) < 1e-6 && s.bg.filtered === '$YELLOW' ? 1 : 0")" "level $(num "$s3" "s.level"), $(num "$s3" "Math.round(s.cell * 1000) / 10") cm"
mkdir -p artifacts/ui
cli browser screenshot --output-file artifacts/ui/xr-menu-depth.png

cli xr exit --input-json '{}'
sleep 3
s4=$(probe "$STATE")
check "hidden outside XR" "$(num "$s4" "s.row === 'none' ? 1 : 0")" "row $(num "$s4" "s.row")"

echo "{\"passed\":$pass,\"failed\":$fail}"
