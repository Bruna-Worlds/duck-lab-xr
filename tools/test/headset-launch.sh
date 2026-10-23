#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Native-control headset session (dev server started with
# `npx @iwsdk/cli dev up --native-xr-control --no-open`): pairs the Quest,
# deep-links the app, waits for its immersive session, and writes the
# headset page's runtimeTarget to artifacts/video/rt.json and the UUIDs of
# the panels' buttons and handles to artifacts/video/uuids.json (for
# headset-demo.sh).
#
#   bash tools/test/headset-launch.sh <serial> [extra query, e.g. demoReset=1]
set -u
SERIAL="${1:?adb serial}"
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
IWSDK="node node_modules/@iwsdk/cli/bin/iwsdk.js"
mkdir -p artifacts/video
PORT=$($IWSDK dev status --raw 2>/dev/null | grep -o '"port": [0-9]*' | head -1 | grep -o '[0-9]*')
adb -s "$SERIAL" reverse "tcp:$PORT" "tcp:$PORT" > /dev/null
URL=$($IWSDK runtime pair-headset --input-json "{\"headsetId\":\"$SERIAL\"}" --raw 2>/dev/null | grep -o '"url": "[^"]*"' | head -1 | sed 's/"url": "//; s/"$//')
[ -n "$URL" ] || { echo "pairing failed"; exit 1; }
before=$($IWSDK runtime targets --raw 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(JSON.stringify((j.targets??[]).filter(t=>t.headsetId==='$SERIAL').map(t=>[t.pageId,t.tabGeneration])))}catch{console.log('[]')}})")
FULL="$URL&t=$(date +%s)${2:+&$2}"
ENC=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$FULL")
adb -s "$SERIAL" shell am broadcast -n com.oculus.vrshell/.ShellControlBroadcastReceiver -a com.oculus.vrshell.intent.action.LAUNCH -d apk://com.oculus.browser -e uri "ovrweb://vr?uri=$ENC" > /dev/null
RT=""
for i in $(seq 1 40); do
  RT=$($IWSDK runtime targets --raw 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{
const j=JSON.parse(s); const before=new Map(JSON.parse(process.argv[1]));
const ts=(j.targets??[]).filter(t=>t.deviceClass==='physical'&&t.role==='app'&&t.commandReady&&t.headsetId==='$SERIAL'&&(!before.has(t.pageId)||t.tabGeneration>before.get(t.pageId)));
if(ts.length===1)console.log(JSON.stringify(ts[0].runtimeTarget));}catch{}})" "$before")
  [ -n "$RT" ] && break
  sleep 2
done
[ -n "$RT" ] || { echo "no new headset target"; exit 1; }
echo "$RT" > artifacts/video/rt.json
for i in $(seq 1 15); do
  active=$($IWSDK xr status --input-json "{\"runtimeTarget\":$RT}" --raw 2>/dev/null | grep -o '"sessionActive": true')
  [ -n "$active" ] && break
  sleep 2
done
echo "target $RT ${active:-session not active}"
sleep 4 # the duck wakes and the panels lay out
# UUIDs of the panels' handles and buttons (UIKit elements are named by their ids).
$IWSDK scene runtime-hierarchy --input-json "{\"maxDepth\":6,\"runtimeTarget\":$RT}" --raw > artifacts/video/hier.json 2>/dev/null
node -e "
const fs = require('fs');
const root = (j => j.data?.result ?? j.result ?? j)(JSON.parse(fs.readFileSync('artifacts/video/hier.json', 'utf8')));
const ids = {};
const walk = (n) => { if (!n || typeof n !== 'object') return; if (n.name && !ids[n.name]) ids[n.name] = n.uuid; for (const c of n.children ?? []) walk(c); };
walk(root);
fs.writeFileSync('artifacts/video/hosts.json', JSON.stringify({ robot: ids['Robot Panel'], menu: ids['Menu Panel'], bar: ids['robot-panel-bar'], grip: ids['robot-panel-resizer'], duck: ids['trunk_base'], score: ids['Scoreboard'] }));
"
uuids='{}'
for host in robot menu; do
  hid=$(node -e "console.log(require('./artifacts/video/hosts.json')['$host'] ?? '')")
  [ -n "$hid" ] || continue
  $IWSDK scene runtime-hierarchy --input-json "{\"parentId\":\"$hid\",\"maxDepth\":12,\"runtimeTarget\":$RT}" --raw > "artifacts/video/hier-$host.json" 2>/dev/null
done
node -e "
const fs = require('fs');
const found = JSON.parse(fs.readFileSync('artifacts/video/hosts.json', 'utf8'));
for (const n of ['robot', 'menu']) {
  if (!fs.existsSync('artifacts/video/hier-' + n + '.json')) continue;
  const root = (j => j.data?.result ?? j.result ?? j)(JSON.parse(fs.readFileSync('artifacts/video/hier-' + n + '.json', 'utf8')));
  const walk = (x) => { if (!x || typeof x !== 'object') return; if (/^(rp-|pg-|menu-close)/.test(x.name || '') && !found[x.name]) found[x.name] = x.uuid; for (const c of x.children ?? []) walk(c); };
  walk(root);
}
fs.writeFileSync('artifacts/video/uuids.json', JSON.stringify(found, null, 1));
console.log('uuids', Object.keys(found).length);
"
