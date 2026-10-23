#!/bin/bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Quest smoke test: relaunch the paired page in the headset, select the tab
# that owns the immersive session, and print the lab panel and HUD readouts.
#
#   tools/test/headset.sh <serial> <pairing-url> [extra query, e.g. "mode=vr&playground=backyard"] [wait seconds]
#
# Needs: `npx @iwsdk/cli dev up --native-xr-control --no-open`, an ADB reverse
# route for the dev port, and the URL from `runtime pair-headset`. Stale tabs
# (restored or reloaded) close themselves, so a plain deep link is enough.
set -u
SERIAL="$1"
URL="$2"
EXTRA="${3:-}"
WAIT="${4:-24}"
OUT="${TMPDIR:-/tmp}/duck-headset-rt.json"
[ -n "$EXTRA" ] && URL="$URL&$EXTRA"
ENC=$(node -e "console.log(encodeURIComponent(process.argv[1] + '&lab=1&t=' + Date.now()))" "$URL")
adb -s "$SERIAL" shell am broadcast -n com.oculus.vrshell/.ShellControlBroadcastReceiver -a com.oculus.vrshell.intent.action.LAUNCH -d apk://com.oculus.browser -e uri "ovrweb://vr?uri=$ENC" > /dev/null
sleep "$WAIT"
PAGES=$(npx @iwsdk/cli runtime targets --raw 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const t=(j.data?.targets||j.targets||[]).filter(x=>x.runtimeTarget?.deviceClass==='physical'&&x.role==='app'&&x.commandReady&&x.runtimeTarget.headsetId===process.argv[1]);console.log(JSON.stringify(t.map(x=>x.runtimeTarget)))})" "$SERIAL")
RT=$(node -e "
const list=JSON.parse(process.argv[1]);const {execFileSync}=require('child_process');
for(const rt of list){const out=execFileSync('npx',['@iwsdk/cli','xr','status','--input-json',JSON.stringify({runtimeTarget:rt}),'--raw'],{shell:true}).toString();let d={};try{d=JSON.parse(out);d=d.data?.result||d.data||d}catch{}
 if(d.sessionActive){console.log(JSON.stringify(rt));process.exit(0)}}
console.log('')" "$PAGES")
if [ -z "$RT" ]; then echo "no active immersive session among targets: $PAGES"; exit 1; fi
echo "$RT" > "$OUT"
echo "session tab: $RT"
find_idx() { npx @iwsdk/cli ecs find --input-json "{\"namePattern\":\"$1\",\"runtimeTarget\":$RT}" --raw 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const d=j.data?.result||j.data||j;const e=(d.entities||d.matches||[])[0];console.log(e?e.entityIndex??e.index:'')})"; }
read_text() { npx @iwsdk/cli ui inspect --input-json "{\"entityIndex\":$1,\"selector\":\"#$2\",\"runtimeTarget\":$RT}" --raw 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const d=j.data?.result||j.data||j;const els=d.elements||d.matches||[];console.log(process.argv[1]+': '+(els.map(e=>e.text||e.properties?.text||'')).join(' | '))})" "$2"; }
sleep 6
LAB=$(find_idx "Lab Panel"); RUN=$(find_idx "Run Panel")
for id in display-text profile-text room-text scan-text errors-text; do [ -n "$LAB" ] && read_text "$LAB" "$id"; done
for id in run-subtitle run-state duck-mood run-result; do [ -n "$RUN" ] && read_text "$RUN" "$id"; done
echo "runtime target saved to $OUT"
