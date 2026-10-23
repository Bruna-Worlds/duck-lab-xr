// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Editor check through the managed browser (desktop, no XR needed):
 *   npx @iwsdk/cli browser run tools/test/editor-check.mjs
 * Builds a small course in the room-only playground with the editor's API
 * (add, move, remove), checks the course and the physics follow, saves it,
 * encodes a share link, decodes it back, loads the custom playground from
 * the picker list and checks the pieces are there.
 */
export default async function run({ page, frame }) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const target = frame ?? page;
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };
  const read = () =>
    target.evaluate(() => {
      const d = globalThis.__duck;
      return {
        playground: d.playgrounds.current,
        loading: d.playgrounds.loading,
        error: d.playgrounds.error,
        status: d.duck.status,
        awake: d.duck.hasPose && /woke|ready/i.test(d.duck.status),
        pieces: d.editor.pieceCount,
        editor: d.editor.status,
        editing: d.editor.editing,
        courseState: d.course.state,
        crumbs: d.course.crumbsTotal,
        freeRoam: d.course.freeRoam,
        ngeom: d.duck.sim && d.duck.sim.ready ? d.duck.sim.ready.ngeom : -1,
        rebuilds: d.duck.sim ? d.duck.sim.rebuilds : -1,
        all: d.playgrounds.all.map((p) => p.id),
      };
    });
  const until = async (name, pred, tries = 60) => {
    let s = await read();
    for (let i = 0; i < tries && !pred(s); i++) {
      await wait(500);
      s = await read();
    }
    return s;
  };

  await target.evaluate(() => globalThis.__duck.playgrounds.load('free-roam'));
  let s = await until('free roam', (s) => s.playground === 'free-roam' && s.awake);
  check('room-only playground up', s.playground === 'free-roam' && s.awake, `${s.pieces} piece(s), ngeom ${s.ngeom}`);
  const ngeom0 = s.ngeom;

  // Build: crumb, gate, books, finish; then move them into a line.
  await target.evaluate(async () => {
    const e = globalThis.__duck.editor;
    if (!e.editing) e.toggle();
    const crumb = await e.add('course-crumb');
    const gate = await e.add('course-gate');
    const books = await e.add('course-book-stack');
    const finish = await e.add('course-finish-pad');
    e.moveTo(crumb, 0.3, 0);
    e.moveTo(gate, 0.7, 0);
    e.moveTo(books, 1.0, 0.15, 0.3);
    e.moveTo(finish, 1.4, 0);
  });
  s = await until('pieces applied', (s) => s.pieces >= 5 && s.rebuilds >= 1 && !s.freeRoam, 30);
  check('pieces added and physics rebuilt', s.pieces === 5 && s.rebuilds >= 1 && s.ngeom > ngeom0, `${s.pieces} pieces, ngeom ${ngeom0} -> ${s.ngeom}, ${s.rebuilds} rebuild(s); ${s.editor}`);
  check('course sees the new pieces', !s.freeRoam && s.crumbs === 1, `free roam ${s.freeRoam}, crumbs ${s.crumbs}, state ${s.courseState}`);

  // Save, share, decode.
  const share = await target.evaluate(async () => {
    const d = globalThis.__duck;
    const saved = d.editor.save('Test board');
    const mod = await import('/src/playgrounds/custom.ts');
    const code = await mod.encodeShare(saved);
    const back = await mod.decodeShare(code);
    return { id: saved.id, pieces: saved.pieces.length, codeLength: code.length, backId: back.id, backPieces: back.pieces.length, inList: d.playgrounds.all.some((p) => p.id === saved.id) };
  });
  check('saved and share code round-trips', share.backId === share.id && share.backPieces === share.pieces && share.inList, `${share.id}: ${share.pieces} pieces, code ${share.codeLength} chars, in picker ${share.inList}`);

  // Leave the editor, switch to a built-in and back to the custom one from the picker.
  await target.evaluate(() => {
    const d = globalThis.__duck;
    if (d.editor.editing) d.editor.toggle();
    return d.playgrounds.load('living-room-dash');
  });
  s = await until('living room', (s) => s.playground === 'living-room-dash' && s.awake);
  await target.evaluate((id) => globalThis.__duck.playgrounds.load(id), share.id);
  s = await until('custom loaded', (s) => s.playground === share.id && s.awake && !s.loading, 80);
  check('custom playground loads from the picker', s.playground === share.id && s.pieces === 5 && !s.freeRoam, `${s.playground}, ${s.pieces} pieces, crumbs ${s.crumbs}, error "${s.error}"`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  return results;
}
