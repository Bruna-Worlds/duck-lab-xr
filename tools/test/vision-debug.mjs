// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Debug: per-object pixel counts of the vision ID pass, and the feed, in the
 * current session. Temporary helper for tuning the vision view.
 *
 *   bash tools/test/mr.sh tools/test/vision-debug.mjs 14
 */
import { writeFileSync } from 'node:fs';

export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  await app.evaluate(() => globalThis.__duck.cam.setView('vision'));
  await page.waitForTimeout(3000);
  // Paint each unlabelled mesh in its own green, to see what covers what.
  const blockers = await app.evaluate(() => {
    const v = globalThis.__duck.cam.vision;
    const names = [];
    globalThis.__blockNames = names;
    const mats = new Map();
    const Black = v.black.constructor;
    const original = v.swap;
    v.swap = (object) => {
      const before = Array.isArray(object.material) ? object.material[0] : object.material;
      original(object);
      if (object.isMesh && object.material === v.black) {
        let k = mats.get(object.uuid);
        if (!k) {
          const g = object.geometry;
          g.computeBoundingSphere?.();
          const p = object.getWorldPosition(object.position.clone()).toArray().map((n) => Math.round(n * 100) / 100);
          names.push(`${object.parent?.parent?.name ?? ''}/${object.parent?.name ?? ''}/${object.name || object.type} [${before?.type} ${before?.name ?? ''} ${g?.type} r${Math.round((g?.boundingSphere?.radius ?? 0) * 100) / 100} at ${p.join(',')} side ${before?.side} depthTest ${before?.depthTest}]`);
          k = new Black({ toneMapped: false, fog: false });
          k.color.setRGB(0, names.length / 255, 0, 'srgb-linear');
          mats.set(object.uuid, k);
        }
        object.material = k;
      }
    };
    return names;
  });
  await page.waitForTimeout(1500);
  const blockerNames = await app.evaluate(() => {
    const v = globalThis.__duck.cam.vision;
    const counts = new Map();
    for (let i = 0; i < v.pixels.length; i += 4) if (v.pixels[i] === 0 && v.pixels[i + 1] > 0) counts.set(v.pixels[i + 1], (counts.get(v.pixels[i + 1]) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${globalThis.__blockNames[k - 1]}=${n}`);
  });
  console.log(`PASS blockers ${blockerNames.join(" | ").replace(/"/g, "")}`);
  const r = await app.evaluate(() => {
    const d = globalThis.__duck;
    const v = d.cam.vision;
    const rows = v.objects.map((o, i) => `${o.name}=${v.counts[i + 1]}`);
    const renderer = d.world.renderer;
    const rt = Object.values(d.cam).find((x) => x && x.isWebGLRenderTarget);
    const { width, height } = rt;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    ctx.putImageData(image, 0, 0);
    // The ID buffer itself, ids scaled up so they show.
    const ids = v.pixels;
    const c2 = document.createElement('canvas');
    c2.width = 128;
    c2.height = 96;
    const x2 = c2.getContext('2d');
    const im2 = x2.createImageData(128, 96);
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 128; x++) {
        const s = ((95 - y) * 128 + x) * 4;
        const t = (y * 128 + x) * 4;
        im2.data[t] = (ids[s] * 37) % 256;
        im2.data[t + 1] = ids[s + 1];
        im2.data[t + 2] = (ids[s] * 91) % 256;
        im2.data[t + 3] = 255;
      }
    }
    x2.putImageData(im2, 0, 0);
    return { mr: d.room.isMixedReality, count: v.count, summary: v.summary, rows, feed: canvas.toDataURL('image/png'), ids: c2.toDataURL('image/png') };
  });
  writeFileSync('artifacts/ui/vision-debug-feed.png', Buffer.from(r.feed.split(',')[1], 'base64'));
  writeFileSync('artifacts/ui/vision-debug-ids.png', Buffer.from(r.ids.split(',')[1], 'base64'));
  console.log(`PASS debug - mr ${r.mr}, ${r.summary}: ${r.rows.join(' ')}`);
}
