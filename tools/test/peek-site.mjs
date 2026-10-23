// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Opens a public web page in a second tab of the managed browser and saves a
 * screenshot, for design reference (`PEEK_URL=https://... PEEK_OUT=artifacts/x.png
 * npx @iwsdk/cli browser run tools/test/peek-site.mjs`). The app's own tab is
 * left alone; the extra tab is closed afterwards.
 */
export default async function run({ context }) {
  const url = process.env.PEEK_URL ?? 'https://example.com/';
  const out = process.env.PEEK_OUT ?? 'artifacts/peek.png';
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 2400 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: out, fullPage: false });
    // Pull the computed palette and fonts of the most common elements.
    const summary = await page.evaluate(() => {
      const counts = new Map();
      const fonts = new Map();
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        for (const key of ['color', 'backgroundColor', 'borderColor']) {
          const v = cs[key];
          if (!v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent') continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const f = cs.fontFamily.split(',')[0].replace(/"/g, '').trim();
        if (f) fonts.set(f, (fonts.get(f) ?? 0) + 1);
      }
      const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
      const h1 = document.querySelector('h1');
      const h1cs = h1 ? getComputedStyle(h1) : null;
      return {
        title: document.title,
        colors: top(counts, 14),
        fonts: top(fonts, 6),
        h1: h1 ? { text: h1.textContent?.trim().slice(0, 80), font: h1cs.fontFamily, weight: h1cs.fontWeight, size: h1cs.fontSize, transform: h1cs.textTransform, color: h1cs.color } : null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        radii: top(new Map([...document.querySelectorAll('button, a, .card, [class*=card], [class*=btn]')].map((e) => [getComputedStyle(e).borderRadius, 1]).reduce((m, [k]) => m.set(k, (m.get(k) ?? 0) + 1), new Map())), 6),
      };
    });
    console.log(`PEEK ${JSON.stringify(summary).replace(/"/g, "'")}`);
  } finally {
    await page.close();
  }
}
