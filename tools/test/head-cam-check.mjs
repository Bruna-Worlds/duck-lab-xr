// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The duck cam rides in the head: standing, it looks along the body's
 * heading; during a bow (head and neck pitch down) it tilts down with the
 * head, more than the body does. Saves artifacts/ui/feed-head-{rest,bow}.png.
 *
 *   npx @iwsdk/cli browser run tools/test/head-cam-check.mjs --timeout 100000
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
  await app.waitForFunction(() => globalThis.__duck?.duck?.hasPose === true && /woke|ready|walk/i.test(globalThis.__duck.duck.status), null, { timeout: 40000 });
  await app.evaluate(() => {
    globalThis.__duck.cam.setView('motion');
    globalThis.__duck.robotPanel.setSize('normal');
  });
  // The duck looks at the player; for the level check, hold its head at the default pose.
  await app.evaluate(() => {
    globalThis.__duck.duck.holdHeadNeutral = true;
  });
  await page.waitForTimeout(2000);
  // Eye and trunk directions: pitch of each (degrees above the horizon) and the angle between their headings.
  const pose = () =>
    app.evaluate(() => {
      const d = globalThis.__duck;
      const eye = d.cam.eye;
      const trunk = d.duck.rig.trunk;
      const V = eye.position.constructor;
      const Q = eye.quaternion.constructor;
      const look = new V(0, 0, -1).applyQuaternion(eye.getWorldQuaternion(new Q()));
      const ahead = new V(1, 0, 0).applyQuaternion(trunk.getWorldQuaternion(new Q()));
      const deg = (r) => (r * 180) / Math.PI;
      const flat = (v) => new V(v.x, 0, v.z).normalize();
      return {
        eyePitch: deg(Math.asin(Math.max(-1, Math.min(1, look.y)))),
        trunkPitch: deg(Math.asin(Math.max(-1, Math.min(1, ahead.y)))),
        heading: deg(Math.acos(Math.max(-1, Math.min(1, flat(look).dot(flat(ahead)))))),
        headYaw: deg(d.duck.pose[7 + 7]), // joint 7 is head_yaw
        parent: eye.parent?.name ?? '',
      };
    });
  const feed = (name) =>
    app.evaluate((n) => {
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
      for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
      ctx.putImageData(image, 0, 0);
      return { name: n, url: canvas.toDataURL('image/png') };
    }, name);
  const save = (shot) => writeFileSync(`artifacts/ui/feed-head-${shot.name}.png`, Buffer.from(shot.url.split(',')[1], 'base64'));

  const rest = await pose();
  check('camera rides in the head', /head|neck|yaw_roll/.test(rest.parent), `parent ${rest.parent}`);
  check('head at rest: it looks where the body faces, level', rest.heading < 8 && Math.abs(rest.eyePitch) < 12, `heading off by ${rest.heading.toFixed(1)} deg, pitch ${rest.eyePitch.toFixed(1)} deg`);
  save(await feed('rest'));

  // Let the duck look at the player again: the camera turns as far as the head does.
  await app.evaluate(() => {
    globalThis.__duck.duck.holdHeadNeutral = false;
  });
  await page.waitForTimeout(2500);
  const looking = await pose();
  check(
    'head turned: the camera turns with it',
    Math.abs(looking.headYaw) > 5 ? Math.abs(looking.heading - Math.abs(looking.headYaw)) < 10 : true,
    `head yaw ${looking.headYaw.toFixed(1)} deg, camera off the body heading by ${looking.heading.toFixed(1)} deg`,
  );
  await app.evaluate(() => {
    globalThis.__duck.duck.holdHeadNeutral = true;
  });
  await page.waitForTimeout(1500);

  await app.evaluate(() => globalThis.__duck.duck.fireMove('bow'));
  let lowest = rest;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(100);
    const p = await pose();
    if (p.eyePitch < lowest.eyePitch) lowest = p;
    if (i === 6) save(await feed('bow'));
  }
  const eyeDrop = rest.eyePitch - lowest.eyePitch;
  const trunkDrop = rest.trunkPitch - lowest.trunkPitch;
  check('bowing tilts the camera down with the head', eyeDrop > 10 && eyeDrop > trunkDrop + 3, `camera pitch ${rest.eyePitch.toFixed(1)} -> ${lowest.eyePitch.toFixed(1)} deg (body ${trunkDrop.toFixed(1)} deg)`);
  await app.evaluate(() => {
    globalThis.__duck.duck.holdHeadNeutral = false;
  });
  const failed = results.filter((ok) => !ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
