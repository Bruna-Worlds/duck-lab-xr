// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Draws the demo's flow strip: the six steps from a hard moment in the
 * headset to a brain on a real duck, one PNG per step with that step lit
 * (earlier steps ticked, later ones dim). join-clips.mjs lays them over the
 * top of the film. 1280x46, transparent around the bar.
 *
 *   node tools/test/flow-strip.mjs [out dir]   (default artifacts/video/flow)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

export const STEPS = [
  ['Headset', 'save a hard moment'],
  ['Duck Lab XR', 'replay it in physics'],
  ['Duck Lab XR', 'train the brain'],
  ['Headset', 'try the new brain'],
  ['Hugging Face', 'publish it'],
  ['Real duck', 'flash it'],
];

const out = process.argv[2] ?? 'artifacts/video/flow';
mkdirSync(out, { recursive: true });
const font = readFileSync('public/fonts/BebasNeue-Regular.ttf').toString('base64');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 46 }, deviceScaleFactor: 1 });
for (let active = 1; active <= STEPS.length; active++) {
  const cells = STEPS.map(([where, what], i) => {
    const n = i + 1;
    const cls = n === active ? 'on' : n < active ? 'done' : 'todo';
    return `<div class="step ${cls}"><b>${n < active ? '&#10003;' : n}</b><span class="where">${where}</span><span class="what">${what}</span></div>`;
  }).join('<i>&#9654;</i>');
  await page.setContent(`<!doctype html><html><head><style>
    @font-face { font-family: Bebas; src: url(data:font/ttf;base64,${font}); }
    html, body { margin: 0; background: transparent; }
    .bar { display: flex; align-items: center; justify-content: center; gap: 3px; height: 46px; padding: 0 8px;
      background: rgba(15, 16, 32, 0.84); font-family: Bebas, sans-serif; letter-spacing: 0.5px; }
    .step { display: flex; align-items: baseline; gap: 5px; padding: 4px 8px; border-radius: 8px; white-space: nowrap; }
    .step b { display: inline-block; min-width: 20px; height: 22px; line-height: 23px; border-radius: 11px; text-align: center; font-size: 17px; font-weight: normal; }
    .where { font-size: 18px; }
    .what { font-size: 14px; opacity: 0.85; }
    .todo { color: rgba(255, 244, 220, 0.42); }
    .todo b { border: 1.5px solid rgba(255, 244, 220, 0.3); }
    .done { color: #7fe0c8; }
    .done b { background: rgba(127, 224, 200, 0.18); }
    .on { color: #0f1020; background: #ffcf3f; }
    .on b { background: #0f1020; color: #ffcf3f; }
    i { color: rgba(255, 244, 220, 0.35); font-style: normal; font-size: 11px; }
  </style></head><body><div class="bar">${cells}</div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${out}/step-${active}.png`, omitBackground: true });
}
await browser.close();
console.log(`FLOW ${STEPS.length} strips -> ${out}`);
