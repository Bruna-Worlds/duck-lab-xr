// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop 2D page check (development): the "How to play" card shows when Pip
 * stands, GOT IT closes it and it comes back next visit unless "Don't show
 * this again" is ticked; the menu's CONTROLS button brings it back; the menu's
 * minimize button folds the menu to its title bar (same width, so the bar
 * keeps its size) and its chevron, its title or M unfold it, remembered
 * across visits. Clicks the panels' own buttons (their place on the screen
 * comes from the panel elements).
 *
 *   node tools/test/desktop-ui-check.mjs
 */
import { chromium } from 'playwright';

const SITE = process.env.SITE ?? 'https://localhost:8081/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

/** Where a panel element is on the page (CSS px), or null when its panel is hidden. */
const spot = (page, node, id) =>
  page.evaluate(
    ([node, id]) => {
      const w = globalThis.__duck.world;
      const asset = w.getSceneObject(node);
      if (!asset?.document?.visible) return null;
      const el = asset.getElementById(id);
      if (!el) return null;
      const p = el.getWorldPosition(w.camera.position.clone());
      p.project(w.camera);
      const c = w.renderer.domElement;
      return { x: ((p.x + 1) / 2) * c.clientWidth, y: ((1 - p.y) / 2) * c.clientHeight };
    },
    [node, id],
  );
const card = (page) => page.evaluate(() => !(document.getElementById('duck-controls')?.hidden ?? true));
/** The menu's drawn size (CSS px) and whether its body shows. */
const menu = (page) =>
  page.evaluate(() => {
    const w = globalThis.__duck.world;
    const asset = w.getSceneObject('menu-panel');
    const doc = asset?.document;
    if (!doc?.visible || !doc.computedSize) return { shown: false };
    const c = w.renderer.domElement;
    const m = (2 * -doc.position.z) / w.camera.projectionMatrix.elements[5] / c.clientHeight;
    const body = asset.getElementById('menu-body');
    return {
      shown: true,
      w: Math.round(((doc.computedSize.width / 100) * doc.scale.x) / m),
      h: Math.round(((doc.computedSize.height / 100) * doc.scale.y) / m),
      body: body?.properties?.peek?.()?.display ?? body?.properties?.value?.display ?? null,
    };
  });
const unfolded = async (page) => {
  const m = await menu(page);
  return m.shown && m.h > 300;
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const open = async () => {
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(SITE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 90000 });
    await page.waitForTimeout(1200);
    return page;
  };

  let page = await open();
  check('the How to play card shows when Pip stands', await card(page));
  await page.screenshot({ path: 'artifacts/layout/desktop-card.png' });
  await page.click('#duck-controls .go');
  check('GOT IT closes it', !(await card(page)));
  await page.close();

  page = await open();
  check('it comes back next visit (box not ticked)', await card(page));
  await page.check('#duck-controls .never-box');
  await page.click('#duck-controls .go');
  await page.close();

  page = await open();
  check('ticked "Don\'t show this again": no card next visit', !(await card(page)));
  const controls = await spot(page, 'menu-panel', 'controls-button');
  if (controls) await page.mouse.click(controls.x, controls.y);
  await page.waitForTimeout(400);
  check("the menu's CONTROLS button shows it again", !!controls && (await card(page)), JSON.stringify(controls));
  await page.keyboard.press('Escape');
  check('Esc closes it', !(await card(page)));

  const full = await menu(page);
  const min = await spot(page, 'menu-panel', 'menu-min');
  if (min) await page.mouse.click(min.x, min.y);
  await page.waitForTimeout(600);
  const bar = await menu(page);
  check('the minimize button folds the menu to its title bar, same width', !!min && bar.shown && bar.h < 90 && Math.abs(bar.w - full.w) <= 3, `unfolded ${full.w}x${full.h}, folded ${bar.w}x${bar.h}`);
  await page.screenshot({ path: 'artifacts/layout/desktop-menu-folded.png' });
  const expand = await spot(page, 'menu-panel', 'menu-expand');
  if (expand) await page.mouse.click(expand.x, expand.y);
  await page.waitForTimeout(600);
  check('its chevron unfolds it', !!expand && (await unfolded(page)));
  if (min) await page.mouse.click(min.x, min.y);
  await page.waitForTimeout(400);
  await page.close();

  page = await open();
  const again = await menu(page);
  check('folded stays folded next visit', again.shown && again.h < 90, JSON.stringify(again));
  const title = await spot(page, 'menu-panel', 'menu-title');
  if (title) await page.mouse.click(title.x, title.y);
  await page.waitForTimeout(600);
  check('a click on its title unfolds it', !!title && (await unfolded(page)));
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(500);
  const folded = !(await unfolded(page));
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(500);
  check('M folds and unfolds it', folded && (await unfolded(page)));
  await page.screenshot({ path: 'artifacts/layout/desktop-menu.png' });
} catch (err) {
  check('desktop run', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
console.log(JSON.stringify({ passed, failed: results.length - passed }));
process.exit(passed === results.length ? 0 : 1);
