// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Lists what the duck cam can draw in mixed reality: every visible mesh in the
 * scene with its material colour, opacity and layers, grouped by name, so a
 * surface in the feed can be traced to the object that drew it.
 *
 *   npx @iwsdk/cli browser run tools/test/cam-scene-probe.mjs
 */
export default async function run({ page, frame }) {
  const app = frame ?? page;
  const rows = await app.evaluate(() => {
    const d = globalThis.__duck;
    const scene = d.world.scene;
    const room = d.room;
    room.setCamView(true);
    const groups = new Map();
    scene.traverseVisible((o) => {
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const color = m?.color ? `#${m.color.getHexString()}` : '-';
      const emissive = m?.emissive ? `#${m.emissive.getHexString()}` : '-';
      let path = o.name || o.type;
      let p = o.parent;
      for (let i = 0; i < 3 && p; i++, p = p.parent) path = `${p.name || p.type}/${path}`;
      const key = `${path.replace(/[0-9a-f-]{8,}/g, '#')} | ${m?.type} ${color} em ${emissive} op ${m?.opacity} layers ${o.layers.mask}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    });
    room.setCamView(false);
    return [...groups.entries()].map(([k, n]) => `${n}x ${k}`);
  });
  for (const row of rows) console.log(`MESH ${row.replace(/"/g, "'")}`);
}
