// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The robot panel's VISION view on the 2D page. A real mouse click on the
 * VISION tab switches the duck cam to the camera view; the object-ID pass
 * labels what the duck sees (in Living Room Dash: the course pieces); the
 * boxes are drawn into the feed in their class colours; the choice is kept;
 * a click on MOTION switches back. Saves artifacts/ui/feed-vision.png (the
 * feed) and artifacts/ui/robot-vision.png (the panel).
 *
 *   npx @iwsdk/cli browser run tools/test/vision-check.mjs --timeout 100000
 */
import { writeFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

export default async function run({ page, frame }) {
  const app = frame ?? page;
  if (page.url().includes('#editor')) {
    await page.getByRole('button', { name: 'Runtime', exact: true }).click();
    await page.waitForTimeout(1000);
  }
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  if ((await app.evaluate(() => globalThis.__duck.playgrounds.current)) !== 'living-room-dash') {
    await app.evaluate(() => globalThis.__duck.playgrounds.load('living-room-dash'));
    await app.waitForFunction(
      () => globalThis.__duck.playgrounds.current === 'living-room-dash' && globalThis.__duck.duck.hasPose,
      null,
      { timeout: 40000 },
    );
  }
  await app.evaluate(() => {
    globalThis.__duck.cam.setView('motion');
    globalThis.__duck.robotPanel.setSize('normal');
  });
  await page.waitForTimeout(1500);

  // Where a panel element is on the page, for a real mouse click.
  const frameBox = frame ? await (await frame.frameElement()).boundingBox() : { x: 0, y: 0 };
  const click = async (id) => {
    const p = await app.evaluate((elementId) => {
      const w = globalThis.__duck.world;
      const element = w.getSceneObject('robot-panel')?.getElementById(elementId);
      if (!element) return null;
      const v = element.getWorldPosition(element.position.clone());
      v.project(w.camera);
      const r = w.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    }, id);
    if (!p) return false;
    await page.mouse.click(frameBox.x + p.x, frameBox.y + p.y);
    return true;
  };
  const read = () =>
    app.evaluate(() => {
      const cam = globalThis.__duck.cam;
      const boxes = cam.vision.boxes.slice(0, cam.vision.count).map((b) => ({ ...b }));
      let stored = null;
      try {
        stored = localStorage.getItem('duckdash.cam.view');
      } catch {
        // storage blocked
      }
      return { view: cam.view, count: cam.vision.count, objects: cam.vision.objectCount, summary: cam.vision.summary, boxes, stored };
    });

  const clicked = await click('rp-view-vision');
  await page.waitForTimeout(2500);
  const s = await read();
  check('VISION tab click switches the view', clicked && s.view === 'vision', `view ${s.view}`);
  check('labelled objects found in the level', s.objects > 0, `${s.objects} objects`);
  const labels = [...new Set(s.boxes.map((b) => b.label))];
  check('course pieces labelled in view', s.count > 0 && labels.some((l) => ['books', 'gate', 'ball', 'goal', 'crumb', 'start', 'finish'].includes(l)), `${s.summary}`);
  check('choice remembered', s.stored === 'vision', `stored ${s.stored}`);

  // The feed, read back from its render target: the boxes are drawn in it.
  const feed = await app.evaluate((boxes) => {
    const d = globalThis.__duck;
    const renderer = d.world.renderer;
    const rt = Object.values(d.cam).find((v) => v && v.isWebGLRenderTarget);
    const { width, height } = rt;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    const at = (x, y) => {
      const row = height - 1 - Math.round(y); // the target's rows start at the bottom
      const i = (row * width + Math.round(x)) * 4;
      return [pixels[i], pixels[i + 1], pixels[i + 2]];
    };
    // Each box's left edge, half way down: should be its class colour.
    const edges = boxes.map((b) => ({ label: b.label, rgb: at(b.x0 + 0.5, (b.y0 + b.y1) / 2) }));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    ctx.putImageData(image, 0, 0);
    return { url: canvas.toDataURL('image/png'), edges };
  }, s.boxes);
  writeFileSync('artifacts/ui/feed-vision.png', Buffer.from(feed.url.split(',')[1], 'base64'));
  const COLORS = { ball: [255, 92, 138], books: [255, 207, 63], gate: [111, 183, 255], goal: [61, 224, 184], crumb: [255, 209, 102], start: [205, 180, 219], finish: [205, 180, 219] };
  const near = (a, b) => b && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 60;
  const drawn = feed.edges.filter((e) => near(e.rgb, COLORS[e.label]));
  check('boxes drawn into the feed in class colours', drawn.length > 0, `${drawn.length}/${feed.edges.length} box edges match (${feed.edges.map((e) => `${e.label} ${e.rgb.join(',')}`).join('; ')})`);

  // The panel as the player sees it.
  const box = frameBox.width ? frameBox : await (await frame.frameElement()).boundingBox();
  if (box) {
    const w = Math.round(box.width * 0.3);
    const h = Math.round(box.height * 0.6);
    await page.screenshot({ path: 'artifacts/ui/robot-vision.png', clip: { x: box.x + box.width - w, y: box.y + box.height - h, width: w, height: h } });
  }

  await click('rp-view-motion');
  await page.waitForTimeout(1200);
  const m = await read();
  check('MOTION tab click switches back', m.view === 'motion' && m.count === 0 && m.stored === 'motion', `view ${m.view}, ${m.count} boxes, stored ${m.stored}`);
  const failed = results.filter((ok) => !ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
