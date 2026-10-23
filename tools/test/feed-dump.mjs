// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Saves the duck cam's current frame (the robot panel's feed) to
 * artifacts/ui/feed-<FEED_NAME or "now">.png, read back from its render target.
 *
 *   FEED_NAME=mr bash tools/test/mr.sh tools/test/feed-dump.mjs
 */
import { writeFileSync } from 'node:fs';

export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => globalThis.__duck?.cam?.frames > 2, null, { timeout: 30000 });
  const url = await app.evaluate(() => {
    const d = globalThis.__duck;
    const renderer = d.world.renderer;
    const texture = d.cam.texture;
    const target = renderer.properties.get(texture).__renderTarget ?? null;
    // The render target owns the texture: find it through the cam system.
    const rt = Object.values(d.cam).find((v) => v && v.isWebGLRenderTarget) ?? target;
    const { width, height } = rt;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  });
  const out = `artifacts/ui/feed-${process.env.FEED_NAME ?? 'now'}.png`;
  writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`FEED ${out}`);
}
