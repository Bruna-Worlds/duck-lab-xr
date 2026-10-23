// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Opens the trainer page and its 3D replay tab once, in a throwaway headless
 * browser, before a film starts. The first time Vite sees a module (the 3D
 * tab's three.js addons, say) it pre-bundles it and reloads every open page,
 * the managed window too: mid-film that drops the headset's session.
 *
 *   node tools/film/stack/warm-trainer.mjs
 */
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await page.goto(`${SITE}trainer/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.click('#tab-3d').catch(() => {});
  await page.waitForTimeout(3000);
  await page.click('#tab-map').catch(() => {});
  await page.waitForTimeout(500);
  console.log('WARM trainer page and its 3D tab loaded');
} finally {
  await browser.close();
}
