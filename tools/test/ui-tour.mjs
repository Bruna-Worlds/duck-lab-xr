// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Captures the run panel (HUD) in its main states at full resolution, for a
 * visual check of the UI: idle, editor open, and a phone-sized window with
 * the touch controls. Pictures go to artifacts/ui/tour-*.png.
 *
 *   npx @iwsdk/cli browser run tools/test/ui-tour.mjs --timeout 100000
 *
 * Needs a dev server started with --allow-browser-automation.
 */
const OUT = 'artifacts/ui';

/** Screenshot of a corner of the app frame (top right: scoreboard; top left: menu). */
async function hud(page, frame, name, corner = 'right') {
  const element = await frame.frameElement();
  const box = await element.boundingBox();
  const width = Math.round(box.width * 0.42);
  const height = Math.round(box.height * 0.52);
  const clip = { x: corner === 'right' ? box.x + box.width - width : box.x, y: box.y, width, height };
  await page.screenshot({ path: `${OUT}/tour-${name}.png`, clip });
  console.log(`SHOT ${name} ${width}x${height}`);
}

export default async function run({ page, frame, context }) {
  const app = frame ?? page;
  const wait = (ms) => page.waitForTimeout(ms);
  // A UI preview or scene command leaves the managed window on its Editor
  // view, which hides the app frame: switch back to the Runtime view.
  if (page.url().includes('#editor')) {
    await page.getByRole('button', { name: 'Runtime', exact: true }).click();
    await wait(1500);
  }
  await app.waitForFunction(() => globalThis.__duck?.duck?.sim != null, null, { timeout: 30000 });
  await wait(1500);
  await hud(page, frame, 'idle');

  // Editor: the palette row and its status line.
  await app.evaluate(() => globalThis.__duck.editor.toggle());
  await wait(800);
  await hud(page, frame, 'editor', 'left');
  await app.evaluate(() => globalThis.__duck.editor.toggle());
  await wait(500);

  // Phone: a second tab at phone size with the touch overlay forced on.
  const phone = await context.newPage();
  try {
    await phone.setViewportSize({ width: 412, height: 860 });
    await phone.goto(`${new URL(app.url()).origin}/?touch=1`, { waitUntil: 'load', timeout: 45000 });
    await phone.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
    await phone.waitForTimeout(3000);
    await phone.screenshot({ path: `${OUT}/tour-phone.png` });
    console.log('SHOT phone 412x860');
  } finally {
    await phone.close();
  }
}
