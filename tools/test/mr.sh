#!/usr/bin/env bash
# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
# Runs a managed-browser check script inside a fresh emulated mixed-reality
# session: reloads the app, waits for the duck, accepts the offered session,
# then runs the script. Needs `iwsdk dev up --allow-browser-automation`.
#
#   bash tools/test/mr.sh tools/test/terrain-check.mjs
set -u
script="${1:-tools/test/terrain-check.mjs}"
settle="${2:-12}"
cd "$(dirname "$0")/../.."
npx @iwsdk/cli browser reload --input-json '{}' --raw > /dev/null 2>&1
sleep "$settle"
npx @iwsdk/cli xr enter --input-json '{}' --raw 2>&1 | grep -o '"ok": [a-z]*' | head -1 | sed 's/^/xr enter /'
sleep 8
npx @iwsdk/cli browser run "$script" --timeout 100000 2>&1 | grep -o "PASS[^\"]*\|FAIL[^\"]*\|{\"passed[^}]*}\|\"message\": \"[^\"]\{0,300\}" | head -20
