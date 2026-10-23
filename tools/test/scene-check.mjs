// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Scene understanding in emulated mixed reality: the emulator's room scan
 * reaches the game (floor, walls, furniture), the course lands on the scanned
 * floor (not in the air), walls and furniture are solid for the duck, and the
 * duck's camera draws them. Saves the duck's view as artifacts/ui/feed-scene.png.
 *
 *   bash tools/test/mr.sh tools/test/scene-check.mjs 14
 */
import { writeFileSync } from 'node:fs';

export default async function run({ page, frame }) {
  const app = frame ?? page;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true, null, { timeout: 40000 });
  await app.evaluate(() => globalThis.__duck.playgrounds.load('living-room-dash'));
  const read = () =>
    app.evaluate(
      () =>
        new Promise((resolve) => {
          const d = globalThis.__duck;
          const session = d.world.session;
          if (!session) return resolve(null);
          session.requestAnimationFrame((t, f) => {
            const space = d.world.renderer.xr.getReferenceSpace();
            const planes = [...(f.detectedPlanes ?? [])];
            const floor = planes.find((p) => p.semanticLabel === 'floor');
            const floorY = floor ? f.getPose(floor.planeSpace, space)?.transform.position.y ?? null : null;
            const stage = [...d.room.queries.stages.entities][0]?.object3D;
            const stageY = stage ? stage.getWorldPosition(stage.position.clone()).y : null;
            const r = d.room;
            resolve({
              mode: session.environmentBlendMode,
              state: r.state,
              solid: r.physicsSummary,
              colliders: r.roomColliders.length,
              planes: planes.map((p) => `${p.semanticLabel ?? '?'}/${p.orientation}`),
              meshes: [...(f.detectedMeshes ?? [])].map((m) => m.semanticLabel ?? '?'),
              floorY,
              stageY,
              furnitureTwins: r.occluders.size,
              planeTwins: r.planeTwins?.size ?? 0,
              camFrames: d.cam.frames,
            });
          });
        }),
    );
  let s = await read();
  for (let i = 0; i < 40 && !(s && ['placed', 'tight'].includes(s.state)); i++) {
    await wait(500);
    s = await read();
  }
  const count = (list, re) => list.filter((x) => re.test(x)).length;
  check('mixed reality session', s?.mode === 'alpha-blend' || s?.mode === 'additive', s?.mode);
  check(
    'room scan arrives',
    s.planes.length > 0 && count(s.planes, /^floor/) === 1 && count(s.planes, /^wall/) > 0,
    `${s.planes.length} planes (${count(s.planes, /^floor/)} floor, ${count(s.planes, /^wall/)} walls, ${count(s.planes, /horizontal/) - count(s.planes, /^(floor|ceiling)/)} other surfaces), ${s.meshes.length} meshes (${[...new Set(s.meshes)].join(', ')})`,
  );
  check('course placed on the scan', ['placed', 'tight'].includes(s.state), s.state);
  check(
    'course sits on the scanned floor',
    s.floorY !== null && s.stageY !== null && Math.abs(s.stageY - s.floorY) < 0.03,
    `stage y ${s.stageY?.toFixed(3)}, floor y ${s.floorY?.toFixed(3)}`,
  );
  check('walls and furniture are solid for the duck', s.colliders > 0 && /wall/.test(s.solid), `${s.solid} (${s.colliders} colliders)`);
  check('duck camera models the furniture', s.furnitureTwins > 0, `${s.furnitureTwins} furniture volumes`);
  check('duck camera models walls, doors, windows, surfaces', s.planeTwins > 0, `${s.planeTwins} plane slabs`);
  // The duck's view, read back from its render target.
  await app.waitForFunction((n) => globalThis.__duck.cam.frames > n + 3, s.camFrames, { timeout: 20000 });
  const feed = await app.evaluate(() => {
    const d = globalThis.__duck;
    const renderer = d.world.renderer;
    const rt = Object.values(d.cam).find((v) => v && v.isWebGLRenderTarget);
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
    // Share of pixels that are not the dark backdrop: how much of the room the duck sees.
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 120) lit++;
    return { url: canvas.toDataURL('image/png'), lit: lit / (width * height) };
  });
  writeFileSync('artifacts/ui/feed-scene.png', Buffer.from(feed.url.split(',')[1], 'base64'));
  check('duck camera sees the room', feed.lit > 0.15, `${Math.round(feed.lit * 100)}% of the frame is room, saved artifacts/ui/feed-scene.png`);

  // The vision view in mixed reality: a solid room, and labels for what is in sight.
  const hasVision = await app.evaluate(() => typeof globalThis.__duck.cam.setView === 'function');
  if (hasVision) {
    await app.evaluate(() => globalThis.__duck.cam.setView('vision'));
    await page.waitForTimeout(3000);
    const v = await app.evaluate(() => {
      const c = globalThis.__duck.cam;
      return { count: c.vision.count, objects: c.vision.objectCount, labels: c.vision.boxes.slice(0, c.vision.count).map((b) => b.label), summary: c.vision.summary };
    });
    check('vision view finds course and scanned furniture', v.objects > 0, `${v.objects} labelled objects in the level`);
    check('vision view labels what is in sight', v.count > 0, `${v.summary} [${v.labels.join(', ')}]`);
    const shot = await app.evaluate(() => {
      const d = globalThis.__duck;
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
      return canvas.toDataURL('image/png');
    });
    writeFileSync('artifacts/ui/feed-vision-mr.png', Buffer.from(shot.split(',')[1], 'base64'));
    await app.evaluate(() => globalThis.__duck.cam.setView('motion'));
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
