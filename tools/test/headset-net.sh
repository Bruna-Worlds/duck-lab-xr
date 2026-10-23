#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Final validation on the Quest over the normal dev server (no native XR
# control): deep-links the headset browser to the network URL with the lab
# panel and telemetry on, waits, then prints the telemetry the app posted to
# artifacts/telemetry/headset.json (depth mode, room, terrain, fps, errors).
#
#   bash tools/test/headset-net.sh <serial> [url] [extra query] [wait seconds]
#
# url defaults to the dev server's first network address (iwsdk dev status).
# The page requests the immersive session itself on launch (the
# __iwsdk_headset flag turns launchOnSessionGranted on), so the browser's
# five-second rule is met. Stale restored tabs close themselves.
set -u
SERIAL="${1:?adb serial}"
cd "$(dirname "$0")/../.."
URL="${2:-$(npx @iwsdk/cli dev status 2> /dev/null | node -e "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { try { console.log(JSON.parse(s).data.runtimeUrls.network[0] ?? ''); } catch { console.log(''); } })")}"
[ -n "$URL" ] || { echo "no network address: start the dev server, or pass the URL"; exit 1; }
EXTRA="${3:-}"
WAIT="${4:-30}"
rm -f artifacts/telemetry/headset.json
FULL="$URL?lab=1&__iwsdk_headset=1&t=$(date +%s)"
[ -n "$EXTRA" ] && FULL="$FULL&$EXTRA"
ENC=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$FULL")
adb -s "$SERIAL" shell am broadcast -n com.oculus.vrshell/.ShellControlBroadcastReceiver -a com.oculus.vrshell.intent.action.LAUNCH -d apk://com.oculus.browser -e uri "ovrweb://vr?uri=$ENC" > /dev/null
echo "launched $FULL"
sleep "$WAIT"
if [ -f artifacts/telemetry/headset.json ]; then
  node -e "
const t = require('./artifacts/telemetry/headset.json');
console.log('uptime', t.uptimeS, 's  fps', t.fps, ' frame', t.frameMs, 'ms (worst', t.frameMaxMs + ')  draws', t.draws, ' tris', t.triangles);
console.log('status:', t.status);
console.log('session:', JSON.stringify(t.session));
console.log('sim:', JSON.stringify(t.sim));
console.log('room:', t.room && t.room.state, '|', t.room && t.room.colliders, '|', t.room && t.room.scan);
console.log('terrain:', t.terrain && t.terrain.summary);
console.log('nav:', JSON.stringify(t.nav), ' cam:', JSON.stringify(t.cam), ' panel:', JSON.stringify(t.panel), ' brain:', t.brain);
console.log('scenario:', t.scenario);
console.log('profile:', t.profile);
console.log('errors:', JSON.stringify(t.errors));
"
else
  echo "no telemetry arrived from the headset (page not loaded, certificate warning, or no ?lab)"
fi
