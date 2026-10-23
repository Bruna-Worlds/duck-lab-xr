// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The 2D page's camera turns when the room is dragged (src/ui/orbit-camera-system.ts),
 * in a headless Chromium of its own: a mouse drag over empty floor turns it, the
 * wheel moves it in and out, a drag that starts on a panel leaves it alone, and on
 * a phone-sized touch page a one-finger drag (real touch events) turns it too.
 *
 *   node tools/test/orbit-check.mjs [url]   (default https://localhost:8081/)
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'https://localhost:8081/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const eye = (page) =>
  page.evaluate(() => {
    const c = globalThis.__duck.world.camera;
    c.updateWorldMatrix(true, false);
    const p = c.getWorldPosition(c.position.clone());
    return [p.x, p.y, p.z];
  });
const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (p) => p.map((v) => v.toFixed(2)).join(', ');
// A spot over the floor with no panel on it: the middle of the canvas, a little low.
const open = async (browser, options, query = '') => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 1, ...options });
  const page = await context.newPage();
  await page.goto(`${base}${query}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && !document.getElementById('splash'), null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  return { context, page };
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  // Desktop: mouse.
  {
    const { context, page } = await open(browser, { viewport: { width: 1366, height: 768 } });
    page.on('pageerror', (e) => errors.push(e.message));
    // A first visit shows the How to play card over the middle of the page: Esc closes it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const start = await eye(page);
    await page.mouse.move(683, 520);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(683 + i * 18, 520 - i * 4);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const turned = await eye(page);
    check('a mouse drag over the floor turns the camera', moved(start, turned) > 0.2, `${fmt(start)} -> ${fmt(turned)}`);
    const distance = (p, t) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    const target = await page.evaluate(() => {
      const c = globalThis.__duck.world.camera;
      const d = c.getWorldDirection(c.position.clone());
      const p = c.getWorldPosition(c.position.clone());
      const t = (0.05 - p.y) / d.y;
      return [p.x + d.x * t, 0.05, p.z + d.z * t];
    });
    const before = distance(turned, target);
    await page.mouse.move(683, 520);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    const after = distance(await eye(page), target);
    check('the wheel moves the camera out', after > before + 0.1, `${before.toFixed(2)} m -> ${after.toFixed(2)} m from the spot it looks at`);
    // A drag that starts on the menu (top left) leaves the camera alone.
    const still = await eye(page);
    await page.mouse.move(120, 300);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(120 + i * 15, 300 + i * 6);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after2 = await eye(page);
    check('a drag that starts on a panel does not turn it', moved(still, after2) < 0.01, `${fmt(still)} -> ${fmt(after2)}`);
    // Walls: from behind the back wall it hides, so the course stays in view; inside, all stand.
    const walls = async (theta, radius) => {
      await page.evaluate(([theta, radius]) => {
        const o = globalThis.__duck.orbit;
        o.spherical.theta = theta;
        o.spherical.radius = radius;
        o.spherical.phi = 1.2;
        o.dirty = true;
      }, [theta, radius]);
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        const s = globalThis.__duck.world.scene;
        const shown = (name) => s.getObjectByName(name)?.visible ?? null;
        return { back: shown('BackWall'), front: shown('FrontWall'), left: shown('LeftWall'), right: shown('RightWall'), ceiling: shown('CeilingSide') };
      });
    };
    const behind = await walls(Math.PI, 6);
    check('the wall between the camera and the course hides', behind.back === false && behind.front === true && behind.left === true && behind.right === true, JSON.stringify(behind).replace(/"/g, ''));
    const inside = await walls(0, 1.5);
    check('inside the room every wall stands', Object.values(inside).every((v) => v === true), JSON.stringify(inside).replace(/"/g, ''));
    // Furniture: from outside the right wall the pieces along it that stand in the way hide too.
    const furniture = async (theta, radius) => {
      await walls(theta, radius);
      await page.waitForTimeout(1700); // the next scan of the room
      return page.evaluate(() => {
        const s = globalThis.__duck.world.scene;
        const out = {};
        for (const name of ['Sofa', 'SideTable', 'Bookshelf', 'FloorLamp', 'Plant', 'ToyChest']) out[name] = s.getObjectByName(name)?.visible ?? null;
        return out;
      });
    };
    const right = await furniture(Math.PI / 2, 4.6);
    check('furniture in the way of the course hides', right.Sofa === false || right.SideTable === false, JSON.stringify(right).replace(/"/g, ''));
    const middle = await furniture(0, 1.5);
    check('furniture out of the way stands', Object.values(middle).every((v) => v === true), JSON.stringify(middle).replace(/"/g, ''));
    await context.close();
  }
  // Phone: one finger, real touch events.
  {
    const { context, page } = await open(browser, { viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true }, '?touch=1');
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    const start = await eye(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', 200, 330);
    for (let i = 1; i <= 10; i++) await touch('touchMove', 200 + i * 12, 330 + i * 3);
    await touch('touchEnd', 0, 0);
    await page.waitForTimeout(200);
    const turned = await eye(page);
    check('a finger drag over the floor turns the camera (phone)', moved(start, turned) > 0.2, `${fmt(start)} -> ${fmt(turned)}`);
    // The editor: a finger drag that starts on a piece moves the piece, not the camera.
    await page.evaluate(() => {
      const d = globalThis.__duck;
      if (!d.editor.editing) d.editor.toggle();
      // Look at a book stack, so it stands in the middle of the screen.
      const o = d.orbit;
      for (const entity of d.editor.queries.pieces.entities) {
        const object = entity.object3D;
        if (!object || !/book/.test(String(object.userData.iwsdkSceneAssetId))) continue;
        object.getWorldPosition(o.target);
        break;
      }
      o.spherical.theta = 0.3;
      o.spherical.radius = 1.3;
      o.spherical.phi = 0.8;
      o.dirty = true;
    });
    await page.waitForTimeout(500);
    const piece = await page.evaluate(() => {
      const d = globalThis.__duck;
      const camera = d.world.camera;
      const canvas = d.world.renderer.domElement;
      const rect = canvas.getBoundingClientRect();
      const names = [];
      // A solid piece (a book stack: a gate's origin is its open middle), aimed at the middle of its box.
      const pieces = [...d.editor.queries.pieces.entities].sort((a, b) => {
        const rank = (e) => (/book/.test(String(e.object3D?.userData.iwsdkSceneAssetId)) ? 0 : 1);
        return rank(a) - rank(b);
      });
      for (const entity of pieces) {
        const o = entity.object3D;
        if (!o) continue;
        const id = o.userData.iwsdkSceneAssetId ?? o.name;
        if (!/book|goal/.test(String(id))) continue;
        const box = new (camera.position.constructor === Object ? Object : globalThis.__duck.orbit.courseBox.constructor)();
        box.setFromObject(o);
        const p = box.getCenter(o.position.clone());
        const ndc = p.clone().project(camera);
        const x = rect.left + ((ndc.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - ndc.y) / 2) * rect.height;
        names.push(String(id));
        if (x > 40 && x < rect.width - 40 && y > rect.height * 0.3 && y < rect.height * 0.62) return { id: String(id), index: entity.index, x, y, at: [o.position.x, o.position.z] };
      }
      return { none: names.join(',') };
    });
    if (piece.none !== undefined) {
      check('a finger drag on a piece moves the piece in the editor (phone)', false, `no piece on screen (${piece.none})`);
    } else {
      const camBefore = await eye(page);
      await touch('touchStart', piece.x, piece.y);
      await page.waitForTimeout(120);
      for (let i = 1; i <= 10; i++) {
        await touch('touchMove', piece.x + i * 6, piece.y + i * 2);
        await page.waitForTimeout(30);
      }
      await touch('touchEnd', 0, 0);
      await page.waitForTimeout(400);
      const after = await page.evaluate((index) => {
        for (const entity of globalThis.__duck.editor.queries.pieces.entities) if (entity.index === index) return [entity.object3D.position.x, entity.object3D.position.z];
        return null;
      }, piece.index);
      const camAfter = await eye(page);
      const shift = after ? Math.hypot(after[0] - piece.at[0], after[1] - piece.at[1]) : 0;
      check('a finger drag on a piece moves the piece in the editor (phone)', shift > 0.03 && moved(camBefore, camAfter) < 0.01, `${piece.id} moved ${(100 * shift).toFixed(1)} cm, camera moved ${moved(camBefore, camAfter).toFixed(3)} m`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((ok) => !ok).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
process.exit(failed ? 1 : 0);
