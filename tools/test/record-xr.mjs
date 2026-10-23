// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Films the managed window while a scripted test runs, and tells the test
 * where things are. For REC_SECONDS (default 70) it:
 *   - streams frames over the Chrome DevTools screencast into
 *     artifacts/video/<REC_NAME>/frames/ (JPEG) with their timestamps,
 *   - every 250 ms writes artifacts/video/<REC_NAME>/targets.json: world
 *     positions of the robot panel's bar, corner grip and buttons, the menu's
 *     chips, the duck, and a little app state, so a driver script can aim
 *     the emulated controllers (`xr look-at`) at them; the same snapshots,
 *     with the wall clock and the world corners of Pip cam, its offer card and
 *     its details, go to targets-log.jsonl (a film can zoom on them).
 * The app frame's box goes to meta.json for cropping, with a label for the
 * film saying where it was recorded (the emulator, AR or VR mode).
 *
 *   REC_NAME=ar-demo REC_SECONDS=70 npx @iwsdk/cli browser run tools/test/record-xr.mjs --timeout 100000
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export default async function run({ page, frame }) {
  const app = frame ?? page;
  const name = process.env.REC_NAME ?? 'xr-demo';
  const seconds = Number(process.env.REC_SECONDS ?? 70);
  const dir = `artifacts/video/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(`${dir}/frames`, { recursive: true });
  const element = frame ? await frame.frameElement() : null;
  const box = element ? await element.boundingBox() : null;
  const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  // A small corner label for the film saying where it was recorded (REC_LABEL overrides; empty for none).
  const where = await app
    .evaluate(() => ({ emulator: !!globalThis.IWER_MCP, ar: !!globalThis.__duck?.room?.isMixedReality }))
    .catch(() => ({ emulator: false, ar: false }));
  const label = process.env.REC_LABEL ?? (where.emulator ? `Recorded in ${where.ar ? 'AR' : 'VR'} mode in the IWER emulator` : '');
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ box, viewport, label }));

  // A film field of view (REC_FOV degrees, vertical; 0 keeps the emulated
  // headset's 90) so panels read at video size, and no emulator badges:
  // IWER's "Remote Control Active" and the managed window's view switcher.
  // All put back afterwards.
  const film = (on, fovDeg, was) =>
    app.evaluate(
      ({ on, fovDeg, was }) => {
        const device = globalThis.IWER_MCP?.device;
        const before = device?.fovy ?? null;
        if (device && on && fovDeg > 0) device.fovy = (fovDeg * Math.PI) / 180;
        if (device && !on && was) device.fovy = was;
        // The badge is a pill (a dot and the words), maybe inside a shadow
        // root: hide the pill around the words.
        const walk = (root) => {
          for (const el of root.querySelectorAll('*')) {
            const words = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes('Remote Control Active'));
            if (words) (el.parentElement ?? el).style.visibility = on ? 'hidden' : '';
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        return before;
      },
      { on, fovDeg, was },
    );
  const fovWas = await film(true, Number(process.env.REC_FOV ?? 62), null).catch(() => null);
  const switcher = (hidden) =>
    page.evaluate((h) => document.querySelectorAll('.workspace-view-switcher').forEach((e) => (e.style.visibility = h ? 'hidden' : '')), hidden).catch(() => {});
  await switcher(true);

  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let count = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = `f${String(count++).padStart(6, '0')}.jpg`;
    writeFileSync(`${dir}/frames/${file}`, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp, w: metadata.deviceWidth, h: metadata.deviceHeight });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  // Every second frame (30 fps, what the encoder writes): filming every frame
  // loads the browser enough to slow the app down (a playground switch took 20 s).
  const nth = Number(process.env.REC_NTH ?? 2);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1600, maxHeight: 1200, everyNthFrame: nth });

  const started = Date.now();
  let ticks = 0;
  while (Date.now() - started < seconds * 1000) {
    // A driver can end the recording early by dropping a stop file.
    if (existsSync(`${dir}/stop`)) break;
    // A driver can run page code while filming: it drops it in command.js
    // (a second browser script cannot run while this one holds the page).
    const commandFile = `${dir}/command.js`;
    if (existsSync(commandFile)) {
      const js = readFileSync(commandFile, 'utf8');
      rmSync(commandFile, { force: true });
      await app.evaluate(`(async () => { ${js}; })()`).catch((err) => console.log(`CMD failed: ${String(err).slice(0, 120)}`));
    }
    const targets = await app
      .evaluate(() => {
        const d = globalThis.__duck;
        if (!d) return null;
        const w = d.world;
        const scene = w.scene;
        const point = (object) => {
          if (!object) return null;
          const p = object.getWorldPosition(object.position.clone());
          return { x: p.x, y: p.y, z: p.z };
        };
        const robot = w.getSceneObject('robot-panel');
        const menu = w.getSceneObject('menu-panel');
        const el = (asset, id) => point(asset?.getElementById(id));
        // A UIKit element is a unit quad scaled by its world matrix: its four corners in the world.
        const corners = (object) => {
          if (!object?.matrixWorld || !object.isMesh) return null;
          object.updateWorldMatrix(true, false);
          return [
            [-0.5, -0.5],
            [0.5, -0.5],
            [0.5, 0.5],
            [-0.5, 0.5],
          ].map(([x, y]) => {
            const p = object.position.clone().set(x, y, 0).applyMatrix4(object.matrixWorld);
            return { x: p.x, y: p.y, z: p.z };
          });
        };
        return {
          t: performance.now(),
          wall: Date.now() / 1000,
          robotCorners: corners(robot?.document?.rootElement),
          offerCorners: robot?.getElementById('rp-offer')?.isVisible?.value ? corners(robot.getElementById('rp-offer')) : null,
          detailsCorners: robot?.getElementById('rp-details')?.isVisible?.value ? corners(robot.getElementById('rp-details')) : null,
          bar: point(scene.getObjectByName('robot-panel-bar')),
          grip: point(scene.getObjectByName('robot-panel-resizer')),
          more: el(robot, 'rp-more'),
          less: el(robot, 'rp-less'),
          offerTry: el(robot, 'rp-offer-try'),
          pin: el(robot, 'rp-pin'),
          pg1: el(menu, 'pg-1'),
          pg3: el(menu, 'pg-3'),
          pg0: el(menu, 'pg-0'),
          menuClose: el(menu, 'menu-close'),
          duck: point(d.duck.rig?.trunk),
          menuOpen: d.hud.menuOpen,
          size: d.robotPanel.size,
          scale: d.robotPanel.panelScale,
          pinned: d.robotPanel.pinned,
          offer: d.policyInbox.offer?.id ?? null,
          brain: d.duck.policyHash,
          ready: d.duck.hasPose,
          viewVision: el(robot, 'rp-view-vision'),
          viewMotion: el(robot, 'rp-view-motion'),
          realLink: el(menu, 'real-link'),
          realFlash: el(menu, 'real-flash'),
          linked: d.realDuck?.link?.connected ?? false,
          realNote: d.realDuck?.note ?? '',
          status: d.duck.status,
          onWall: d.robotPanel.onWall,
          ctrl: point(w.player.raySpaces.right),
          // From the panel's bar to the nearest scanned wall (mixed reality), and the panel's right.
          wallDelta: (() => {
            const bar = scene.getObjectByName('robot-panel-bar');
            if (!bar || !d.room?.nearestWall) return null;
            const b = bar.getWorldPosition(bar.position.clone());
            const p = b.clone();
            const n = b.clone();
            return d.room.nearestWall(b, 4, p, n) ? { x: p.x - b.x, y: 0, z: p.z - b.z } : null;
          })(),
          panelRight: (() => {
            const host = w.requireSceneEntity('robot-panel').object3D;
            const r = host.position.clone().set(1, 0, 0).applyQuaternion(host.getWorldQuaternion(host.quaternion.clone()));
            return { x: r.x, y: r.y, z: r.z };
          })(),
          playground: d.playgrounds.current,
          nav: d.nav?.status ?? '',
          navTask: d.nav?.task ?? null,
          navLeft: d.nav?.waypointsLeft ?? 0,
        };
      })
      .catch(() => null);
    if (targets) {
      writeFileSync(`${dir}/targets.json`, JSON.stringify(targets));
      appendFileSync(`${dir}/targets-log.jsonl`, `${JSON.stringify(targets)}\n`);
    }
    if (++ticks % 8 === 0) await film(true, 0, null).catch(() => {}); // the badge comes back when the session restarts
    await page.waitForTimeout(250);
  }
  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(300);
  await film(false, 0, fovWas).catch(() => {});
  await switcher(false);
  writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
  console.log(`REC ${count} frames in ${seconds} s -> ${dir}`);
}
