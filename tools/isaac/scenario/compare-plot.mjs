// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Draws a pack's run in MuJoCo and in Isaac Sim's PhysX from above: raised
 * terrain cells grey, course shapes yellow, MuJoCo's trunk path orange,
 * PhysX's green, a dot each second and a cross where each first tipped.
 *
 *   node tools/isaac/scenario/compare-plot.mjs <export folder>   -> <folder>/compare.png
 *
 * Reads <folder>/scene.xml, assets/terrain.bin, mujoco-trace.json (replay.mjs --trace)
 * and isaac-trace.json (run_pack.py).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: node tools/isaac/scenario/compare-plot.mjs <export folder>');
  process.exit(2);
}
const xml = readFileSync(join(folder, 'scene.xml'), 'utf8');
const mujoco = JSON.parse(readFileSync(join(folder, 'mujoco-trace.json'), 'utf8'));
const isaac = JSON.parse(readFileSync(join(folder, 'isaac-trace.json'), 'utf8'));
const nums = (s) => (s ? s.trim().split(/\s+/).map(Number) : null);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

// The course pieces and room shapes (the app names them).
const shapes = [...xml.matchAll(/<geom name="(course_[^"]*|room[^"]*|wall[^"]*|furniture[^"]*)"[^>]*\/>/g)].map((m) => ({
  type: attr(m[0], 'type') ?? 'sphere',
  size: nums(attr(m[0], 'size')),
  pos: nums(attr(m[0], 'pos')) ?? [0, 0, 0],
  quat: nums(attr(m[0], 'quat')) ?? [1, 0, 0, 0],
}));

// The live terrain (terrain.bin: int32 nrow, int32 ncol, float32 data) at the terrain geom.
let terrain = null;
try {
  const bin = readFileSync(existsSync(join(folder, 'assets', 'terrain.bin')) ? join(folder, 'assets', 'terrain.bin') : join(folder, 'terrain.bin'));
  const nrow = bin.readInt32LE(0);
  const ncol = bin.readInt32LE(4);
  const data = new Float32Array(bin.buffer.slice(bin.byteOffset + 8, bin.byteOffset + 8 + nrow * ncol * 4));
  const hf = xml.match(/<hfield name="live-terrain"[^>]*>/)?.[0];
  const geom = xml.match(/<geom name="terrain"[^>]*>/)?.[0];
  const size = nums(attr(hf, 'size'));
  const pos = nums(attr(geom, 'pos'));
  terrain = { nrow, ncol, data, size, pos };
} catch {
  terrain = null;
}

const paths = [
  { name: 'MuJoCo', colour: '#ff8a1f', rows: mujoco.trunk, fell: mujoco.fellAt },
  { name: 'Isaac Sim (PhysX)', colour: '#2fbf71', rows: isaac.trunk, fell: isaac.summary.fellAt },
];
const xs = paths.flatMap((p) => p.rows.map((r) => r[1]));
const ys = paths.flatMap((p) => p.rows.map((r) => r[2]));
const minX = Math.min(...xs) - 0.35;
const maxX = Math.max(...xs) + 0.35;
const minY = Math.min(...ys) - 0.35;
const maxY = Math.max(...ys) + 0.35;
const S = 700 / Math.max(maxX - minX, maxY - minY);
const W = Math.max(760, Math.ceil((maxX - minX) * S)); // room for the legend
const H = Math.ceil((maxY - minY) * S) + 70;
const px = (x) => (x - minX) * S;
const py = (y) => (maxY - y) * S + 70;
const parts = [];

if (terrain) {
  const { nrow, ncol, data, size, pos } = terrain;
  const cw = (2 * size[0]) / (ncol - 1);
  const ch = (2 * size[1]) / (nrow - 1);
  for (let r = 0; r < nrow; r++) {
    for (let c = 0; c < ncol; c++) {
      const h = pos[2] + data[r * ncol + c] * size[2];
      if (h < 0.015) continue;
      const x = pos[0] - size[0] + c * cw;
      const y = pos[1] - size[1] + r * ch;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      const shade = Math.round(200 - Math.min(1, h / 0.5) * 120);
      parts.push(`<rect x="${px(x - cw / 2)}" y="${py(y + ch / 2)}" width="${cw * S + 0.5}" height="${ch * S + 0.5}" fill="rgb(${shade},${shade},${shade + 8})"/>`);
    }
  }
}
for (const s of shapes) {
  const yaw = (2 * Math.atan2(s.quat[3], s.quat[0]) * 180) / Math.PI;
  if (s.type === 'box') {
    parts.push(
      `<rect x="${-s.size[0] * S}" y="${-s.size[1] * S}" width="${2 * s.size[0] * S}" height="${2 * s.size[1] * S}" fill="#ffcf3f" stroke="#a8851f" transform="translate(${px(s.pos[0])} ${py(s.pos[1])}) rotate(${-yaw})"/>`,
    );
  } else if (s.type === 'cylinder' || s.type === 'capsule' || s.type === 'sphere') {
    parts.push(`<circle cx="${px(s.pos[0])}" cy="${py(s.pos[1])}" r="${Math.max(2, s.size[0] * S)}" fill="#ffcf3f" stroke="#a8851f"/>`);
  }
}
for (const p of paths) {
  const pts = p.rows.map((r) => `${px(r[1]).toFixed(1)},${py(r[2]).toFixed(1)}`).join(' ');
  parts.push(`<polyline points="${pts}" fill="none" stroke="${p.colour}" stroke-width="3.5" stroke-linejoin="round"/>`);
  for (const r of p.rows) {
    if (Math.abs(r[0] - Math.round(r[0])) < 0.011) parts.push(`<circle cx="${px(r[1])}" cy="${py(r[2])}" r="4" fill="${p.colour}"/>`);
  }
  if (p.fell !== null && p.fell !== undefined) {
    const r = p.rows.find((row) => row[0] >= p.fell - 1e-6) ?? p.rows.at(-1);
    parts.push(
      `<g stroke="${p.colour}" stroke-width="5" stroke-linecap="round"><line x1="${px(r[1]) - 11}" y1="${py(r[2]) - 11}" x2="${px(r[1]) + 11}" y2="${py(r[2]) + 11}"/><line x1="${px(r[1]) - 11}" y1="${py(r[2]) + 11}" x2="${px(r[1]) + 11}" y2="${py(r[2]) - 11}"/></g>`,
    );
  }
  const start = p.rows[0];
  parts.push(`<circle cx="${px(start[1])}" cy="${py(start[2])}" r="7" fill="none" stroke="#222" stroke-width="2.5"/>`);
}
const legend = paths
  .map(
    (p, i) =>
      `<rect x="${16 + i * 300}" y="18" width="26" height="8" fill="${p.colour}"/><text x="${50 + i * 300}" y="28" font-family="Segoe UI, sans-serif" font-size="18" fill="#222">${p.name}${p.fell != null ? `, tipped at ${p.fell.toFixed(1)} s` : ', stayed up'}</text>`,
  )
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#f6f3ec"/>${parts.join('')}${legend}<text x="16" y="56" font-family="Segoe UI, sans-serif" font-size="14" fill="#555">From above, a dot each second, ring = start, cross = first tipped. Grey: raised terrain. Yellow: course pieces.</text></svg>`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
await page.screenshot({ path: join(folder, 'compare.png') });
await browser.close();
console.log(`wrote ${join(folder, 'compare.png')}`);
