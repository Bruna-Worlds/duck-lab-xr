// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Draws autopilot traces (tools/test/nav-trace.mjs) from above: the planning
 * grid (grown obstacles light, solid dark), the course pieces, and Pip's
 * track coloured by time with a tick and its heading every second.
 *
 *   node tools/test/nav-plot.mjs artifacts/nav/trace-a.json [more.json ...] -> artifacts/nav/<name>.png
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium } from 'playwright';

const files = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
for (const file of files) {
  const tr = JSON.parse(readFileSync(file, 'utf8'));
  const S = 160; // px per metre
  const g = tr.grid;
  const xs = tr.samples.map((s) => s.x);
  const ys = tr.samples.map((s) => s.y);
  const minX = Math.min(g ? g.x0 : Infinity, ...xs) - 0.1;
  const maxX = Math.max(g ? g.x0 + g.cols * g.cell : -Infinity, ...xs) + 0.1;
  const minY = Math.min(g ? g.y0 : Infinity, ...ys) - 0.1;
  const maxY = Math.max(g ? g.y0 + g.rows * g.cell : -Infinity, ...ys) + 0.1;
  // Course x runs right, stage y (left of the course) runs up.
  const W = Math.ceil((maxX - minX) * S);
  const H = Math.ceil((maxY - minY) * S);
  const px = (x) => (x - minX) * S;
  const py = (y) => (maxY - y) * S;
  const parts = [];
  if (g) {
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        const k = j * g.cols + i;
        const solid = g.solid[k] === '1';
        if (!solid && g.blocked[k] !== '1') continue;
        const x = g.x0 + i * g.cell;
        const y = g.y0 + (j + 1) * g.cell;
        parts.push(`<rect x="${px(x)}" y="${py(y)}" width="${g.cell * S}" height="${g.cell * S}" fill="${solid ? '#555' : '#ddd'}"/>`);
      }
    }
  }
  for (const p of tr.pieces) {
    const color = { crumb: '#f5b700', gate: '#2d7ff9', goal: '#aa44cc', finish: '#19a35b' }[p.kind] ?? '#000';
    parts.push(`<circle cx="${px(p.x)}" cy="${py(p.y)}" r="${p.kind === 'crumb' ? 5 : 9}" fill="none" stroke="${color}" stroke-width="3"/>`);
  }
  const n = tr.samples.length;
  for (let k = 1; k < n; k++) {
    const a = tr.samples[k - 1];
    const b = tr.samples[k];
    const u = k / n;
    const color = `hsl(${Math.round(240 - 240 * u)},85%,45%)`;
    parts.push(`<line x1="${px(a.x)}" y1="${py(a.y)}" x2="${px(b.x)}" y2="${py(b.y)}" stroke="${color}" stroke-width="3"/>`);
  }
  for (let k = 0; k < n; k += 10) {
    const s = tr.samples[k];
    const hx = px(s.x + Math.cos(s.yaw) * 0.06);
    const hy = py(s.y + Math.sin(s.yaw) * 0.06);
    parts.push(`<line x1="${px(s.x)}" y1="${py(s.y)}" x2="${hx}" y2="${hy}" stroke="#000" stroke-width="2"/>`);
    parts.push(`<text x="${px(s.x) + 4}" y="${py(s.y) - 4}" font-size="11" fill="#333">${Math.round(s.t)}</text>`);
  }
  const last = tr.samples[n - 1];
  const title = `${basename(file)} | brain ${tr.brain} | ${last?.t.toFixed(1)} s | ${last?.status} | crumbs ${last?.crumbs} gates ${last?.gates} falls ${last?.falls}`;
  const html = `<!doctype html><html><body style="margin:0;background:#fff;font:14px sans-serif"><div style="padding:6px">${title}</div><svg width="${W}" height="${H}" style="background:#fafafa">${parts.join('')}</svg></body></html>`;
  const page = await browser.newPage({ viewport: { width: Math.max(600, W), height: H + 32 } });
  await page.setContent(html);
  const out = file.replace(/\.json$/, '.png');
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  console.log(out);
}
await browser.close();
