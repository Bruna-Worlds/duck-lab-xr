// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin layers that lie close together must not flicker through each other
 * (z-fighting), in a headless Chromium of its own. The 2D page's camera looks
 * at each subject (the wall pictures, the start and finish pads, the floor's
 * far corner) from near and far; the world is frozen and the camera nudged
 * a fraction of a millimetre a few times; pixels that flip colour between
 * nudges are surfaces fighting. Each view is measured with the 2D page's own
 * near plane and, as close as a player gets in a headset, with its 1 mm.
 * A control (a plane level with the rug, as the old pads' base was) shows
 * the measure catches fighting.
 *
 *   node tools/test/zfight-check.mjs [url]   (default https://localhost:8081/)
 *   SHEET=artifacts/zfight.jpg node tools/test/zfight-check.mjs   (also a contact sheet)
 */
import sharp from 'sharp';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'https://localhost:8081/';
const NUDGES = 4;
const NUDGE_M = 0.0003;
const FLIP = 60; // a channel change this large (of 255) is a flip, not an edge moving
const MAX_FLIPPED = 0.002; // a clean view flips under this share of its pixels
const W = 1280;
const H = 720;
/** The headset's 1 mm near plane is measured only this close: about as far as a player gets from the course in the 6 m room. */
const HEADSET_MAX_M = 6;

/**
 * Subjects (a picture by name, a pad by its placed piece's name, the floor's
 * corner or the control) and where the camera looks from: spherical, about
 * the subject.
 */
const VIEWS = [
  { subject: 'Picture3', label: 'back picture, 2.5 m', radius: 2.5, phi: 1.5, theta: 0.35 },
  { subject: 'Picture3', label: 'back picture, 4.5 m', radius: 4.5, phi: 1.5, theta: -0.3 },
  { subject: 'Picture1', label: 'left picture, 3 m', radius: 3, phi: 1.5, theta: Math.PI / 2 + 0.3 },
  { subject: 'Picture1', label: 'left picture, 5.5 m', radius: 5.5, phi: 1.52, theta: Math.PI / 2 - 0.25 },
  { subject: 'finish-pad', label: 'finish pad, 1.5 m', radius: 1.5, phi: 1.1, theta: 0.6 },
  { subject: 'finish-pad', label: 'finish pad, 4 m low', radius: 4, phi: 1.3, theta: 0.2 },
  { subject: 'finish-pad', label: 'finish pad, 6 m low', radius: 6, phi: 1.25, theta: 0.9 },
  { subject: 'finish-pad', label: 'finish pad, 8 m', radius: 8, phi: 1.05, theta: -0.5 },
  { subject: 'start-pad', label: 'start pad, 4 m low', radius: 4, phi: 1.3, theta: -0.2 },
  { subject: 'start-pad', label: 'start pad, 6 m low', radius: 6, phi: 1.25, theta: -0.9 },
  { subject: 'start-pad', label: 'start pad, 8 m', radius: 8, phi: 1.05, theta: 0.5 },
  { subject: 'floor', label: 'far floor corner, 7 m', radius: 7, phi: 1.2, theta: 0.7 },
  { subject: 'control', label: 'control: plane level with the rug, 4 m', radius: 4, phi: 1.3, theta: 0.2, control: true },
];

const frames = (page, n = 2) =>
  page.evaluate((count) => new Promise((resolve) => {
    const step = (left) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  }), n);

/** Share of pixels that flip between consecutive raw RGBA frames. */
function flipped(raws) {
  let flips = 0;
  const pixels = raws[0].length / 4;
  for (let i = 0; i < pixels; i++) {
    for (let k = 1; k < raws.length; k++) {
      const a = raws[k - 1];
      const b = raws[k];
      const o = i * 4;
      if (Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2])) > FLIP) {
        flips++;
        break;
      }
    }
  }
  return flips / pixels;
}

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors = [];
const tiles = [];
let failures = 0;
let passes = 0;
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && !document.getElementById('splash'), null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape'); // the first visit's How to play card
  await page.evaluate(() => {
    const d = globalThis.__duck;
    // The page's own elements out of the pictures (the screen-space panels go while the world is frozen).
    const canvas = d.world.renderer.domElement;
    for (const el of document.body.children) if (!el.contains(canvas)) el.style.visibility = 'hidden';
    // Pip off the course, out of every view.
    d.duck.autopilot = null;
    d.nav?.stop?.();
    d.duck.sim.teleport(1.2, 1.4, 0);
    // The control: a white plane level with the rug (4 mm up), beside the finish pad.
    const scene = d.world.scene;
    // A pad is the 'Pad' mesh of a placed piece named after its scene node (finish-pad-14).
    globalThis.__zfightFind = (subject) => {
      if (!subject.endsWith('-pad')) return scene.getObjectByName(subject);
      let found;
      scene.traverse((o) => {
        if (!found && o.name === 'Pad' && o.parent?.name.startsWith(subject)) found = o;
      });
      return found;
    };
    const finish = globalThis.__zfightFind('finish-pad');
    const at = finish.getWorldPosition(finish.position.clone());
    const Plane = scene.getObjectByName('Rug').geometry.constructor;
    const MeshClass = scene.getObjectByName('Rug').constructor;
    const material = scene.getObjectByName('Rug').material.clone();
    material.map = null;
    material.color.set(0xffffff);
    material.needsUpdate = true;
    const control = new MeshClass(new Plane(0.3, 0.3), material);
    control.geometry.rotateX(-Math.PI / 2);
    control.name = 'control';
    control.position.set(at.x, 0.004, at.z - 0.4);
    scene.add(control);
    control.visible = false;
    return [at.x, at.y, at.z].map((n) => +n.toFixed(2));
  }).then((at) => console.log(`finish pad at ${at.join(', ')}`));
  await frames(page, 30);

  for (const view of VIEWS) {
    const setup = await page.evaluate((v) => {
      const d = globalThis.__duck;
      const scene = d.world.scene;
      const camera = d.world.camera;
      const orbit = d.orbit;
      const control = scene.getObjectByName('control');
      control.visible = !!v.control;
      const V = camera.position.constructor;
      let centre;
      let box;
      if (v.subject === 'floor') {
        centre = new V(-2.3, 0, -2.3);
        box = { min: new V(-2.9, 0, -2.9), max: new V(-1.7, 0, -1.7) };
      } else {
        const object = globalThis.__zfightFind(v.subject);
        if (!object) return { error: `no ${v.subject}` };
        object.updateWorldMatrix(true, true);
        const rug = scene.getObjectByName('Rug');
        if (!rug.geometry.boundingBox) rug.geometry.computeBoundingBox();
        const b = new rug.geometry.boundingBox.constructor().setFromObject(object);
        centre = b.getCenter(new V());
        box = b;
      }
      orbit.target.copy(centre);
      orbit.spherical.set(v.radius, v.phi, v.theta);
      orbit.dirty = true;
      return { centre: centre.toArray(), min: box.min.toArray(), max: box.max.toArray() };
    }, view);
    if (setup.error) {
      console.log(`SKIP ${view.label} - ${setup.error}`);
      continue;
    }
    await frames(page, 6); // placed, the walls in the way hidden, the near plane set
    const clip = await page.evaluate((s) => {
      const d = globalThis.__duck;
      const camera = d.world.camera;
      camera.updateWorldMatrix(true, false);
      const V = camera.position.constructor;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        const p = new V(i & 1 ? s.max[0] : s.min[0], i & 2 ? s.max[1] : s.min[1], i & 4 ? s.max[2] : s.min[2]).project(camera);
        const x = ((p.x + 1) / 2) * innerWidth;
        const y = ((1 - p.y) / 2) * innerHeight;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      const pad = 12;
      x0 = Math.max(0, Math.floor(x0 - pad));
      y0 = Math.max(0, Math.floor(y0 - pad));
      x1 = Math.min(innerWidth, Math.ceil(x1 + pad));
      y1 = Math.min(innerHeight, Math.ceil(y1 + pad));
      return { x: x0, y: y0, width: Math.max(8, x1 - x0), height: Math.max(8, y1 - y0), near: camera.near };
    }, setup);
    // Freeze the world: the frames differ only by the camera's nudges. The screen-space panels hang off the camera.
    await page.evaluate(() => {
      const world = globalThis.__duck.world;
      globalThis.__zfightUpdate = world.update;
      world.update = () => {};
      for (const child of world.camera.children) child.visible = false;
    });
    const results = [];
    for (const mode of view.radius <= HEADSET_MAX_M ? ['2d', 'headset'] : ['2d']) {
      await page.evaluate((m) => {
        const camera = globalThis.__duck.world.camera;
        globalThis.__zfightNear ??= camera.near;
        camera.near = m === 'headset' ? 0.001 : globalThis.__zfightNear;
        camera.updateProjectionMatrix();
      }, mode);
      const raws = [];
      let first = null;
      for (let k = 0; k < NUDGES; k++) {
        await page.evaluate((dx) => {
          globalThis.__duck.world.camera.position.x += dx;
        }, k === 0 ? 0 : NUDGE_M);
        await frames(page, 2);
        const png = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
        if (k === 0) first = png;
        raws.push(await sharp(png).removeAlpha().ensureAlpha().raw().toBuffer());
      }
      const share = flipped(raws);
      results.push({ mode, share, near: mode === 'headset' ? 0.001 : clip.near });
      if (mode === '2d' && first) tiles.push({ png: first, label: view.label });
    }
    await page.evaluate(() => {
      const world = globalThis.__duck.world;
      const camera = world.camera;
      camera.near = globalThis.__zfightNear;
      camera.updateProjectionMatrix();
      delete globalThis.__zfightNear;
      world.update = globalThis.__zfightUpdate;
    });
    for (const r of results) {
      const ok = r.share < MAX_FLIPPED;
      const line = `${view.label} [${r.mode} near ${r.near.toFixed(3)}] - ${(r.share * 100).toFixed(2)}% of ${clip.width}x${clip.height} px flip`;
      if (view.control) {
        console.log(`${ok ? 'FAIL' : 'PASS'} ${line} (the control must flicker)`);
        if (ok) failures++;
        else passes++;
      } else {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${line}`);
        if (!ok) failures++;
        else passes++;
      }
    }
  }

  if (process.env.SHEET && tiles.length) {
    const TW = 400;
    const TH = 260;
    const cols = 4;
    const rows = Math.ceil(tiles.length / cols);
    const composites = [];
    for (let i = 0; i < tiles.length; i++) {
      const img = await sharp(tiles[i].png).resize(TW, TH - 22, { fit: 'contain', background: '#111' }).png().toBuffer();
      const label = Buffer.from(`<svg width="${TW}" height="22"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Arial" font-size="14" fill="#fff">${tiles[i].label}</text></svg>`);
      composites.push({ input: label, left: (i % cols) * TW, top: Math.floor(i / cols) * TH });
      composites.push({ input: img, left: (i % cols) * TW, top: Math.floor(i / cols) * TH + 22 });
    }
    await sharp({ create: { width: cols * TW, height: rows * TH, channels: 3, background: '#111' } })
      .composite(composites)
      .jpeg({ quality: 85 })
      .toFile(process.env.SHEET);
    console.log(`sheet ${process.env.SHEET}`);
  }
} finally {
  await browser.close();
}
console.log(`${errors.length ? 'FAIL' : 'PASS'} no page errors${errors.length ? ` - ${errors.slice(0, 3).join(' | ')}` : ''}`);
if (errors.length) failures++;
else passes++;
console.log(JSON.stringify({ passed: passes, failed: failures }));
process.exit(failures ? 1 : 0);
