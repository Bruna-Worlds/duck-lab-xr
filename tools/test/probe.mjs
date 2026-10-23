// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Evaluates a JavaScript expression in the managed browser page and prints
 * the JSON result. The expression comes from the PROBE environment variable:
 *
 *   PROBE="globalThis.__duck.room.state" npx @iwsdk/cli browser run tools/test/probe.mjs
 *
 * Needs a dev server started with --allow-browser-automation.
 */
export default async function run({ page, frame }) {
  const expression = process.env.PROBE ?? 'document.title';
  const target = frame ?? page; // the app lives in the managed window's application frame
  const result = await target.evaluate(`(async () => { const r = (${expression}); return r instanceof Promise ? await r : r; })()`);
  // One greppable line without double quotes (the CLI wraps script output in JSON).
  console.log(`PROBE ${JSON.stringify(result).replace(/"/g, "'")}`);
  return result;
}
