// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Loads a URL in the managed browser's application frame (the app's page in
 * the managed window), e.g. with ?landing=1 so the emulated headset pairs
 * like a real one (a desktop browser does not look for trainers).
 *
 *   GOTO="https://localhost:8081/?landing=1" npx @iwsdk/cli browser run tools/test/goto.mjs
 */
export default async function run({ page, frame }) {
  const url = process.env.GOTO ?? 'https://localhost:8081/';
  const target = frame ?? page;
  await target.goto(url, { waitUntil: 'load', timeout: 60000 });
  console.log(`GOTO ${target.url()}`);
}
