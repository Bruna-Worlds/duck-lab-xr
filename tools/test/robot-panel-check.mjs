// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Robot panel ("Pip cam") on the 2D page: the camera feed renders, the
 * telemetry stream fills the details view, and each size shows the right
 * parts. Saves artifacts/ui/robot-{normal,details,mini}.png (bottom-right
 * crops of the page).
 *
 *   npx @iwsdk/cli browser run tools/test/robot-panel-check.mjs --timeout 100000
 */
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

async function crop(page, frame, name) {
  const element = await frame.frameElement();
  const box = await element.boundingBox();
  if (!box) return;
  const width = Math.round(box.width * 0.3);
  const height = Math.round(box.height * 0.95);
  await page.screenshot({ path: `artifacts/ui/robot-${name}.png`, clip: { x: box.x + box.width - width, y: box.y + box.height - height, width, height } });
}

export default async function run({ page, frame }) {
  const app = frame ?? page;
  if (page.url().includes('#editor')) {
    await page.getByRole('button', { name: 'Runtime', exact: true }).click();
    await page.waitForTimeout(1000);
  }
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  const state = () =>
    app.evaluate(() => {
      const d = globalThis.__duck;
      const panel = d.world.getSceneObject('robot-panel');
      const shown = (id) => {
        const el = panel?.getElementById(id);
        return el ? el.properties?.peek?.()?.display !== 'none' && el.properties?.value?.display !== 'none' : null;
      };
      return {
        visible: panel?.document.visible ?? null,
        size: d.robotPanel.size,
        frames: d.cam.frames,
        telemetry: d.duck.sim?.telemetry.count ?? -1,
        status: shown('rp-status'),
        details: shown('rp-details'),
      };
    });
  await page.waitForTimeout(1500);
  const a = await state();
  await page.waitForTimeout(1200);
  const b = await state();
  check('panel visible', a.visible === true, JSON.stringify(a));
  check('feed renders', b.frames > a.frames, `${a.frames} -> ${b.frames} frames`);
  check('no telemetry while collapsed', b.telemetry === 0 || b.telemetry === a.telemetry, `count ${b.telemetry}`);
  await app.evaluate(() => globalThis.__duck.robotPanel.setSize('normal'));
  await page.waitForTimeout(600);
  await crop(page, frame, 'normal');

  // Details: walk a little so the charts have something to show.
  await app.evaluate(() => globalThis.__duck.robotPanel.setSize('details'));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  const c = await state();
  check('telemetry streams in details', c.telemetry > 50, `count ${c.telemetry}`);
  await crop(page, frame, 'details');
  const feet = await app.evaluate(() => {
    const ring = globalThis.__duck.duck.sim.telemetry;
    let maxL = 0;
    let maxR = 0;
    for (let back = 0; back < Math.min(ring.count, ring.capacity); back++) {
      const o = ring.offset(back);
      maxL = Math.max(maxL, ring.data[o + 82]);
      maxR = Math.max(maxR, ring.data[o + 83]);
    }
    return { maxL, maxR };
  });
  check('foot contact forces', feet.maxL > 0.3 && feet.maxR > 0.3, `peak L ${feet.maxL.toFixed(2)} N, R ${feet.maxR.toFixed(2)} N`);

  await app.evaluate(() => globalThis.__duck.robotPanel.setSize('mini'));
  await page.waitForTimeout(800);
  const d = await state();
  check('mini hides status', d.size === 'mini', JSON.stringify(d));
  await crop(page, frame, 'mini');
  await app.evaluate(() => globalThis.__duck.robotPanel.setSize('normal'));
  await page.waitForTimeout(400);
  const e = await state();
  check('telemetry stops when collapsed', e.telemetry === 0, `count ${e.telemetry}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
