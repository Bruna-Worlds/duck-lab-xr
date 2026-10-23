// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps Duck Lab XR's trainer page open on this computer in a headless browser
 * (https://localhost:8081/trainer/) and prints a HOST line whenever what it
 * shows changes: the pairing code, the headsets connected, the packs held.
 * For headset tests: open the app on the Quest and pair with the printed code.
 *
 *   node tools/test/trainer-host.mjs [minutes, default 15]
 *
 * Needs the dev server and, for packs and brains, the trainer engine
 * (npm run lab). The browser profile is thrown away afterwards.
 */
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const minutes = Number(process.argv[2]) || 15;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (err) => console.log(`HOST error ${err.message}`));
await page.goto(`${SITE}trainer/`, { waitUntil: 'load', timeout: 60000 });
let last = '';
const until = Date.now() + minutes * 60_000;
while (Date.now() < until) {
  const seen = await page.evaluate(() => ({
    code: document.getElementById('pair-code')?.textContent ?? '',
    headsets: [...document.querySelectorAll('#pair-list .headset')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    chip: document.getElementById('chip-headset')?.textContent ?? '',
    inbox: document.getElementById('chip-inbox')?.textContent ?? '',
    held: document.querySelector('#pair-list .meta')?.textContent ?? '',
    engine: document.getElementById('engine-missing')?.hidden === true,
  }));
  const line = JSON.stringify(seen);
  if (line !== last) {
    console.log(`HOST ${new Date().toISOString().slice(11, 19)} ${line}`);
    last = line;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
await browser.close();
