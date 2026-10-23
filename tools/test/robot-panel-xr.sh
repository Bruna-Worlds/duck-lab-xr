#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Robot panel in a headset (emulated mixed reality): it docks in the
# background beside the scoreboard and move bar without covering them or the
# duck, its bar can be dragged with the right controller's ray
# and trigger, it stays pinned where it is let go (still facing the player),
# the pin button sends it back to its slot, and the corner grip resizes it. Needs the dev server with
# --allow-browser-automation. Prints PASS/FAIL lines and a JSON tally.
#
#   bash tools/test/robot-panel-xr.sh
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
# World positions of the panel, its bar, the duck and the head; and how squarely the panel faces the head.
STATE="(() => { const d = globalThis.__duck; const w = d.world; const host = w.requireSceneEntity('robot-panel').object3D; const bar = w.scene.getObjectByName('robot-panel-bar'); const V = host.position.constructor; const Q = host.quaternion.constructor; const hp = new V(), bp = new V(), tp = new V(), head = new V(); host.getWorldPosition(hp); bar.getWorldPosition(bp); d.duck.rig.trunk.getWorldPosition(tp); w.player.head.getWorldPosition(head); const z = new V(0, 0, 1).applyQuaternion(host.getWorldQuaternion(new Q())); const to = head.clone().sub(hp).normalize(); const r = (v) => v.toArray().map((n) => Math.round(n * 1000) / 1000); const sh = w.requireSceneEntity('run-panel').object3D; const sp = new V(); sh.getWorldPosition(sp); const sq = sh.getWorldQuaternion(new Q()); const right = new V(1, 0, 0).applyQuaternion(sq); const sz = new V(0, 0, 1).applyQuaternion(sq); const size = (name, object) => { const c = w.getSceneObject(name).document.computedSize; const s = new V(); object.getWorldScale(s); return [c.width * 0.01 * s.x, c.height * 0.01 * s.y]; }; const mh = w.requireSceneEntity('moves-panel').object3D; const mp = new V(); mh.getWorldPosition(mp); const [scoreW] = size('run-panel', sh); const [movesW] = size('moves-panel', mh); const [panelW] = size('robot-panel', host); const blockHalf = Math.max(scoreW / 2, Math.abs(mp.clone().sub(sp).dot(right)) + movesW / 2); const side = Math.abs(hp.clone().sub(sp).dot(right)); return { host: r(hp), bar: r(bp), trunk: r(tp), head: r(head), facing: Math.round(z.dot(to) * 1000) / 1000, sameTurn: Math.round(z.dot(sz) * 1000) / 1000, clearOfBlock: Math.round((side - blockHalf - panelW / 2) * 1000) / 1000, behindDuck: Math.round((Math.hypot(hp.x - head.x, hp.z - head.z) - Math.hypot(tp.x - head.x, tp.z - head.z)) * 1000) / 1000, pinned: d.robotPanel.pinned, barVisible: bar.visible, docVisible: w.getSceneObject('robot-panel').document.visible }; })()"
num() { node -e "const s = JSON.parse(process.argv[1]); console.log($2)" "$1"; }

cli browser reload --input-json '{}'
sleep 12
cli xr enter --input-json '{}'
sleep 6
s1=$(probe "$STATE")
echo "state $s1"
[ -n "$s1" ] || { echo "FAIL probe - no state"; echo '{"passed":0,"failed":1}'; exit 1; }
check "docked beside the scoreboard, not over it" "$(num "$s1" "s.clearOfBlock >= 0 ? 1 : 0")" "$(num "$s1" "s.clearOfBlock") m clear of the scoreboard and move bar"
check "in the background, beyond the duck" "$(num "$s1" "s.behindDuck > 0.1 ? 1 : 0")" "$(num "$s1" "s.behindDuck") m further than the duck along the floor"
check "turned as the backdrop, towards the player" "$(num "$s1" "s.sameTurn > 0.99 && s.facing > 0.8 ? 1 : 0")" "same turn $(num "$s1" "s.sameTurn"), facing $(num "$s1" "s.facing")"
check "panel and bar shown in XR" "$(num "$s1" "s.barVisible && s.docVisible ? 1 : 0")" "bar $(num "$s1" "s.barVisible") doc $(num "$s1" "s.docVisible")"
cli browser screenshot --output-file artifacts/ui/xr-robot-follow.png

# Drag: aim the right ray at the bar, hold the trigger, sweep the ray, let go.
bar=$(num "$s1" "JSON.stringify({x: s.bar[0], y: s.bar[1], z: s.bar[2]})")
cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$bar}"
sleep 1
cli xr set-select-value --input-json '{"device":"controller-right","value":1}'
sleep 0.6
target=$(num "$s1" "JSON.stringify({x: s.bar[0] + 0.45, y: s.bar[1] + 0.35, z: s.bar[2] + 0.1})")
cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$target}"
sleep 1
cli xr set-select-value --input-json '{"device":"controller-right","value":0}'
sleep 1
s2=$(probe "$STATE")
echo "state $s2"
moved=$(node -e "const a = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]); console.log(Math.hypot(b.bar[0] - a.bar[0], b.bar[1] - a.bar[1], b.bar[2] - a.bar[2]).toFixed(3))" "$s1" "$s2")
check "drag moves the panel" "$(node -e "console.log(Number(process.argv[1]) > 0.15 ? 1 : 0)" "$moved")" "moved ${moved} m"
check "pinned after the drag" "$(num "$s2" "s.pinned ? 1 : 0")" "pinned $(num "$s2" "s.pinned")"
check "pinned, it faces the player" "$(num "$s2" "s.facing > 0.97 ? 1 : 0")" "facing $(num "$s2" "s.facing")"

# Pinned: the duck walks away, the panel stays.
# Walk with the left stick (the real input; it also wakes a sitting duck).
cli xr set-gamepad-state --input-json '{"device":"controller-left","axes":[{"index":0,"value":0.3},{"index":1,"value":-1}]}'
sleep 4
cli xr set-gamepad-state --input-json '{"device":"controller-left","axes":[{"index":0,"value":0},{"index":1,"value":0}]}'
sleep 0.5
cli browser screenshot --output-file artifacts/ui/xr-robot-pinned.png
probe "(globalThis.__duck.robotPanel.setSize('details'), 1)" > /dev/null
sleep 2
cli browser screenshot --output-file artifacts/ui/xr-robot-details.png
probe "(globalThis.__duck.robotPanel.setSize('normal'), 1)" > /dev/null
s3=$(probe "$STATE")
echo "state $s3"
stayed=$(node -e "const a = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]); console.log(Math.hypot(b.bar[0] - a.bar[0], b.bar[1] - a.bar[1], b.bar[2] - a.bar[2]).toFixed(3))" "$s2" "$s3")
walked=$(node -e "const a = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]); console.log(Math.hypot(b.trunk[0] - a.trunk[0], b.trunk[2] - a.trunk[2]).toFixed(3))" "$s2" "$s3")
check "stays where pinned" "$(node -e "console.log(Number(process.argv[1]) < 0.02 && Number(process.argv[2]) > 0.1 ? 1 : 0)" "$stayed" "$walked")" "bar moved ${stayed} m while the duck walked ${walked} m"

# The pin button's other half: back to its slot beside the scoreboard.
probe "globalThis.__duck.robotPanel.follow()" > /dev/null
sleep 3
s4=$(probe "$STATE")
echo "state $s4"
back=$(node -e "const a = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]); console.log(Math.hypot(b.bar[0] - a.bar[0], b.bar[1] - a.bar[1], b.bar[2] - a.bar[2]) < 0.06 && b.clearOfBlock >= 0 ? 1 : 0)" "$s1" "$s4")
check "pin button sends it back to its slot" "$back" "bar $(num "$s4" "s.bar") (docked at $(num "$s1" "s.bar"))"
# On a wall: hold the bar, carry the controller towards the scanned wall behind the backdrop, let go.
WALL="(() => { const d = globalThis.__duck; const bar = d.world.scene.getObjectByName('robot-panel-bar'); const V = bar.position.constructor; const b = bar.getWorldPosition(new V()); const p = new V(), n = new V(); const near = d.room.nearestWall(b, 3, p, n); const c = d.world.player.raySpaces.right.getWorldPosition(new V()); return { bar: { x: b.x, y: b.y, z: b.z }, wall: { x: p.x, y: p.y, z: p.z }, near, ctrl: { x: c.x, y: c.y, z: c.z }, onWall: d.robotPanel.onWall }; })()"
w=$(probe "$WALL")
echo "wall $w"
cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$(num "$w" "JSON.stringify(s.bar)")}"
sleep 1
cli xr set-select-value --input-json '{"device":"controller-right","value":1}'
sleep 0.6
# Carry it to 12 cm in front of the wall (whichever way that is): move the controller by the same amount.
cli xr set-transform --input-json "{\"device\":\"controller-right\",\"position\":$(num "$w" "(() => { const dx = s.wall.x - s.bar.x, dz = s.wall.z - s.bar.z; const len = Math.hypot(dx, dz) || 1; const k = Math.max(0, len - 0.12) / len; return JSON.stringify({ x: s.ctrl.x + dx * k, y: s.ctrl.y, z: s.ctrl.z + dz * k }); })()")}"
sleep 1
cli xr set-select-value --input-json '{"device":"controller-right","value":0}'
sleep 1
w2=$(probe "$WALL")
echo "wall after $w2"
check "let go near a wall: it sticks flat on it" "$(num "$w2" "s.onWall && Math.abs(Math.hypot(s.bar.x - s.wall.x, s.bar.z - s.wall.z) - 0.02) < 0.03 ? 1 : 0")" "on wall $(num "$w2" "s.onWall"), $(num "$w2" "Math.hypot(s.bar.x - s.wall.x, s.bar.z - s.wall.z).toFixed(3)") m off the wall"
s6=$(probe "$STATE")
check "on the wall it faces the room, not the player" "$(num "$s6" "s.facing > 0.5 ? 1 : 0")" "facing the head $(num "$s6" "s.facing")"
cli browser screenshot --output-file artifacts/ui/xr-robot-wall.png
probe "globalThis.__duck.robotPanel.follow()" > /dev/null
cli xr set-transform --input-json "{\"device\":\"controller-right\",\"position\":$(num "$w" "JSON.stringify(s.ctrl)")}"
sleep 3
# Resize: drag the corner grip outwards (bigger), then inwards (smaller).
GRIP="(() => { const d = globalThis.__duck; const g = d.world.scene.getObjectByName('robot-panel-resizer'); const p = g.getWorldPosition(g.position.clone()); const host = d.world.requireSceneEntity('robot-panel').object3D; const s = host.getWorldScale(host.position.clone()); const right = p.clone().set(1, 0, 0).applyQuaternion(host.getWorldQuaternion(host.quaternion.clone())); const head = d.world.player.head.getWorldPosition(p.clone()); const toward = head.sub(p); toward.y = 0; toward.normalize(); return { grip: { x: p.x, y: p.y, z: p.z }, right: { x: right.x, y: right.y, z: right.z }, toward: { x: toward.x, y: 0, z: toward.z }, scale: d.robotPanel.panelScale, hostScale: Math.round(s.x * 10000) / 10000, visible: g.visible }; })()"
drag_grip() { # along the panel's right, up, towards the player: where to pull the ray, relative to the grip
  g=$(probe "$GRIP")
  grip=$(num "$g" "JSON.stringify(s.grip)")
  cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$grip}"
  sleep 1
  cli xr set-select-value --input-json '{"device":"controller-right","value":1}'
  sleep 0.6
  to=$(num "$g" "JSON.stringify({x: s.grip.x + s.right.x * ($1) + s.toward.x * ($3), y: s.grip.y + ($2), z: s.grip.z + s.right.z * ($1) + s.toward.z * ($3)})")
  cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$to}"
  sleep 1
  cli xr set-select-value --input-json '{"device":"controller-right","value":0}'
  sleep 1
}
probe "(globalThis.__duck.robotPanel.setPanelScale(1), 1)" > /dev/null
sleep 0.5
r0=$(probe "$GRIP")
echo "grip $r0"
check "resize grip shown" "$(num "$r0" "s.visible ? 1 : 0")" "scale $(num "$r0" "s.scale")"
drag_grip 0.25 0 0.08
r1=$(probe "$GRIP")
echo "grip $r1"
check "corner drag grows the panel" "$(num "$r1" "s.scale > 1.3 ? 1 : 0")" "scale $(num "$r1" "s.scale"), panel world scale $(num "$r1" "s.hostScale")"
cli browser screenshot --output-file artifacts/ui/xr-robot-resized.png
drag_grip -0.3 0 -0.08
r2=$(probe "$GRIP")
echo "grip $r2"
check "corner drag shrinks the panel" "$(num "$r2" "s.scale < $(num "$r1" "s.scale") - 0.3 ? 1 : 0")" "scale $(num "$r1" "s.scale") -> $(num "$r2" "s.scale")"
kept=$(probe "localStorage.getItem('duckdash.robotPanel.scale')")
check "size kept for next time" "$(node -e "console.log(Math.abs(Number(process.argv[1].replace(/\"/g, '')) - Number(process.argv[2])) < 0.01 ? 1 : 0)" "$kept" "$(num "$r2" "s.scale")")" "stored $kept"
# The feed's view tabs, with the right controller's ray: VISION labels what the duck sees, MOTION goes back.
TABS="(() => { const p = globalThis.__duck.world.getSceneObject('robot-panel'); const at = (id) => { const el = p.getElementById(id); const v = el.getWorldPosition(el.position.clone()); return { x: v.x, y: v.y, z: v.z }; }; return { vision: at('rp-view-vision'), motion: at('rp-view-motion') }; })()"
tabs=$(probe "$TABS")
cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$(num "$tabs" "JSON.stringify(s.vision)")}"
sleep 0.6
cli xr select --input-json '{"device":"controller-right","duration":0.2}'
sleep 2.5
v1=$(probe "(() => { const c = globalThis.__duck.cam; return { view: c.view, count: c.vision.count, summary: c.vision.summary }; })()")
check "ray click on VISION labels what the duck sees" "$(num "$v1" "s.view === 'vision' && s.count > 0 ? 1 : 0")" "$(num "$v1" "s.view + ': ' + s.summary")"
cli browser screenshot --output-file artifacts/ui/xr-robot-vision.png
cli xr look-at --input-json "{\"device\":\"controller-right\",\"target\":$(num "$tabs" "JSON.stringify(s.motion)")}"
sleep 0.6
cli xr select --input-json '{"device":"controller-right","duration":0.2}'
sleep 1.2
v2=$(probe "globalThis.__duck.cam.view")
check "ray click on MOTION goes back" "$([ "$v2" = '"motion"' ] && echo 1 || echo 0)" "view $v2"
probe "(globalThis.__duck.robotPanel.setPanelScale(1), 1)" > /dev/null
cli xr exit --input-json '{}'
echo "{\"passed\":$pass,\"failed\":$fail}"
[ "$fail" -eq 0 ]
