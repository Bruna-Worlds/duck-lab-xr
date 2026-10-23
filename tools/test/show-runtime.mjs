// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Switches the managed window back to its Runtime view (a scene or UI
 * preview command leaves it on the Editor view, which hides the app).
 *
 *   npx @iwsdk/cli browser run tools/test/show-runtime.mjs
 */
export default async function run({ page }) {
  if (page.url().includes('#editor')) {
    await page.getByRole('button', { name: 'Runtime', exact: true }).click();
    await page.waitForTimeout(1000);
  }
  console.log(`VIEW ${page.url().includes('#editor') ? 'editor' : 'runtime'}`);
}
