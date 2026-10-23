// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The 2D page's HUD at several window sizes, in a headless Chromium of its
 * own (the managed window is left alone): every visible screen-space panel's
 * drawn rectangle (IWSDK fits the panel inside its CSS box, keeping its
 * aspect) plus the touch controls, checked for overlaps, and a screenshot per
 * size in artifacts/layout/. `landing` cases use the headset browser's
 * landing layout (`?landing=1`, what the Quest browser gets).
 *
 *   node tools/test/layout-check.mjs [url]   (default https://localhost:8081/)
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'https://localhost:8081/';
const CASES = [
  { name: 'desk-1920', width: 1920, height: 1080 },
  { name: 'desk-1366', width: 1366, height: 768 },
  { name: 'desk-1280', width: 1280, height: 720 },
  { name: 'desk-1024', width: 1024, height: 700 },
  { name: 'desk-1366-details', width: 1366, height: 768, details: true },
  { name: 'desk-1366-lab', width: 1366, height: 768, query: 'lab=1' },
  { name: 'tablet-touch', width: 1180, height: 820, touch: true },
  { name: 'quest-landing', width: 1278, height: 770, query: 'landing=1&lab=1', touch: true },
];
const NODES = ['menu-panel', 'run-panel', 'moves-panel', 'robot-panel', 'lab-panel'];
mkdirSync('artifacts/layout', { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  for (const c of CASES) {
    const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true, hasTouch: !!c.touch });
    const page = await context.newPage();
    // A fresh profile: the panel sizes and camera view start from their defaults.
    await page.goto(`${base}${c.query ? `?${c.query}` : ''}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 90000 });
    if (c.details) await page.evaluate(() => globalThis.__duck.robotPanel.setSize('details'));
    await page.waitForTimeout(2500);
    const boxes = await page.evaluate((nodes) => {
      const w = globalThis.__duck.world;
      const canvas = w.renderer.domElement;
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      const py = w.camera.projectionMatrix.elements[5];
      const out = [];
      for (const node of nodes) {
        const asset = w.getSceneObject(node);
        const doc = asset?.document ?? asset;
        if (!doc?.computedSize || !doc.visible) continue;
        let shown = true;
        for (let o = doc; o; o = o.parent) if (o.visible === false) shown = false;
        if (!shown) continue;
        const z = -doc.position.z;
        if (!(z > 0)) continue; // not on the screen (a headset placement)
        const wpp = (2 * z) / py / H;
        const pw = (doc.computedSize.width / 100) * doc.scale.x / wpp;
        const ph = (doc.computedSize.height / 100) * doc.scale.y / wpp;
        const cx = doc.position.x / wpp + W / 2;
        const cy = H / 2 - doc.position.y / wpp;
        out.push({ name: node, x: cx - pw / 2, y: cy - ph / 2, w: pw, h: ph });
      }
      for (const sel of ['#duck-touch .stick', '#duck-touch .buttons', '#duck-touch .restart', '#duck-views']) {
        const el = document.querySelector(sel);
        // offsetParent is null for hidden elements, and for fixed ones (the switch) too.
        if (!el || getComputedStyle(el).display === 'none' || (el.offsetParent === null && getComputedStyle(el).position !== 'fixed')) continue;
        const r = el.getBoundingClientRect();
        const name = sel === '#duck-views' ? 'play-trainer switch' : sel.replace('#duck-touch ', 'touch-');
        if (r.width && r.height) out.push({ name, x: r.left, y: r.top, w: r.width, h: r.height });
      }
      return { W, H, out };
    }, NODES);
    await page.screenshot({ path: `artifacts/layout/${c.name}.png` });
    const inside = boxes.out.filter((b) => b.x < -1 || b.y < -1 || b.x + b.w > boxes.W + 1 || b.y + b.h > boxes.H + 1).map((b) => b.name);
    const overlaps = [];
    for (let i = 0; i < boxes.out.length; i++) {
      for (let j = i + 1; j < boxes.out.length; j++) {
        const a = boxes.out[i];
        const b = boxes.out[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        // Desktop by design: the expanded Pip cam keeps its width and may cover the scoreboard (drawn over it).
        const allowed = c.details && [a.name, b.name].includes('robot-panel') && [a.name, b.name].includes('run-panel');
        if (ox > 2 && oy > 2 && !allowed) overlaps.push(`${a.name} x ${b.name} (${Math.round(ox)}x${Math.round(oy)} px)`);
      }
    }
    const list = boxes.out.map((b) => `${b.name} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`).join('; ');
    check(`${c.name} no overlaps`, overlaps.length === 0, overlaps.length ? overlaps.join(', ') : list);
    check(`${c.name} all on screen`, inside.length === 0, inside.join(', '));
    if (c.name.startsWith('quest')) {
      const menu = boxes.out.find((b) => b.name === 'menu-panel');
      check(`${c.name} landing menu is large`, !!menu && menu.w >= boxes.W * 0.25, menu ? `${Math.round(menu.w)}x${Math.round(menu.h)} px of ${boxes.W}x${boxes.H}` : 'no menu');
    }
    await context.close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(JSON.stringify({ passed: results.length - failed, failed }));
