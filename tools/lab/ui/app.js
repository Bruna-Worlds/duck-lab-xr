// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

// Duck Lab XR's trainer page: talks to the trainer engine, tools/lab/server.mjs
// (REST + server-sent events). Served two ways:
// - by the engine itself (npm run lab, http://localhost:8790): same origin;
// - by the Duck Lab XR website (<site>/lab/, the dev server for now), which sets
//   window.DUCK_LAB_SITE: the engine is then http://localhost:8790, and the
//   page also pairs with headsets over WebRTC (src/link/trainer-link.ts).
const $ = (id) => document.getElementById(id);
const SITE = window.DUCK_LAB_SITE ?? null;
const ENGINE = SITE?.engine ?? '';
/** The headset link (website only). */
let link = null;
const state = {
  packs: [],
  datasets: [],
  releases: { active: null, releases: [] },
  selected: null,
  checked: new Set(),
  map: null,
  replays: { ship: null, rel: null },
  job: null,
  shippedHash: '',
  publishFor: null,
};
const COLORS = {
  ink: '#0f1020',
  ink2: '#1c1d36',
  cream: '#fff4dc',
  dim: 'rgba(255, 244, 220, 0.55)',
  faint: 'rgba(255, 244, 220, 0.1)',
  yellow: '#ffcf3f',
  orange: '#ff7a45',
  mint: '#3de0b8',
  sky: '#6fb7ff',
  berry: '#ff5c8a',
};
const pct = (v) => (v === null || v === undefined ? '?' : `${Math.round(v * 100)}%`);
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, body) {
  const res = await fetch(ENGINE + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// --- Inbox -----------------------------------------------------------------------------
function renderPacks(fresh = new Set()) {
  const box = $('packs');
  if (!state.packs.length) {
    box.innerHTML = '<div class="empty">No packs yet. In the app, falls and stuck moments are packed automatically (and X packs one by hand); in development they land here at once.</div>';
    return;
  }
  box.innerHTML = state.packs
    .map((p) => {
      if (p.error) return `<div class="pack"><div></div><div class="sub">${esc(p.file)}: ${esc(p.error)}</div></div>`;
      const reason = p.reason === 'falls' ? 'falls' : p.reason === 'stuck' ? 'stuck' : 'manual';
      return `<div class="pack${state.selected === p.id ? ' selected' : ''}${fresh.has(p.id) ? ' fresh' : ''}" data-id="${esc(p.id)}">
        <input type="checkbox" data-check="${esc(p.id)}" ${state.checked.has(p.id) ? 'checked' : ''} title="Train on this pack" />
        <div class="title"><span class="badge ${reason}">${esc(p.reason)}</span><span class="badge ${p.mixedReality ? 'mr' : 'vr'}">${p.mixedReality ? 'your room' : 'vr'}</span>${esc(p.playground || 'Playground')}</div>
        <div class="sub">${esc(ago(p.at))} | ${p.seconds} s recorded | ${p.falls} fall${p.falls === 1 ? '' : 's'} on the headset${p.room ? ` | ${esc(p.room)}` : ''}</div>
      </div>`;
    })
    .join('');
}

$('packs').addEventListener('click', (e) => {
  const check = e.target.closest('[data-check]');
  if (check) {
    const id = check.dataset.check;
    if (check.checked) state.checked.add(id);
    else state.checked.delete(id);
    updateTrainButtons();
    return;
  }
  const card = e.target.closest('.pack[data-id]');
  if (card) selectPack(card.dataset.id);
});

function renderDatasets() {
  const box = $('datasets');
  box.innerHTML = state.datasets.length
    ? state.datasets
        .map(
          (d) =>
            `<div class="pack"><div></div><div class="title">${esc(d.motion ?? 'motion')}<span class="meta">${esc(d.file)}</span></div><div class="sub">${d.episodes} episodes, ${d.steps} steps, ${d.stood}/${d.episodes} stood at the end. For behaviour cloning (see tools/train/README.md).</div></div>`,
        )
        .join('')
    : '<div class="empty">No motion sets yet (lab panel: Export bow set).</div>';
}

// --- Scene map ----------------------------------------------------------------------------
async function selectPack(id) {
  state.selected = id;
  state.replays = { ship: null, rel: null };
  $('replay-result').textContent = '';
  renderPacks();
  document.querySelector('.pack.selected')?.scrollIntoView({ block: 'nearest' });
  try {
    state.map = await api(`/api/packs/${encodeURIComponent(id)}/map`);
  } catch (err) {
    $('scene-title').textContent = err.message;
    return;
  }
  const m = state.map;
  $('scene-title').textContent = `${m.playground || 'Playground'} | ${m.reason} | ended ${m.end.mode} | ${m.pieces.length} pieces${m.terrain ? ' | sensed terrain' : ''}`;
  $('replay-ship').disabled = false;
  updateReplaySelect();
  drawMap();
  if (viewer) {
    viewer.setScene(m);
    await viewer.setReplay('ship', null);
    await viewer.setReplay('rel', null);
  }
}

function bounds() {
  const m = state.map;
  const xs = [m.start.x, m.end.x];
  const ys = [m.start.y, m.end.y];
  for (const p of m.pieces) {
    xs.push(p.pos[0]);
    ys.push(p.pos[1]);
  }
  for (const r of [state.replays.ship, state.replays.rel]) {
    for (const q of r?.path ?? []) {
      xs.push(q[0]);
      ys.push(q[1]);
    }
  }
  let minX = Math.min(...xs) - 0.6;
  let maxX = Math.max(...xs) + 0.6;
  let minY = Math.min(...ys) - 0.6;
  let maxY = Math.max(...ys) + 0.6;
  // 4:3, at least 2.4 m across.
  let w = Math.max(2.4, maxX - minX);
  let h = Math.max(1.8, maxY - minY);
  if (w / h > 4 / 3) h = (w * 3) / 4;
  else w = (h * 4) / 3;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  minX = cx - w / 2;
  maxX = cx + w / 2;
  minY = cy - h / 2;
  maxY = cy + h / 2;
  return { minX, maxX, minY, maxY };
}

function drawMap() {
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(0, 0, W, H);
  const m = state.map;
  if (!m) {
    ctx.fillStyle = COLORS.dim;
    ctx.font = '28px DuckBebas, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PICK A PACK FROM THE INBOX', W / 2, H / 2);
    return;
  }
  const b = bounds();
  const s = W / (b.maxX - b.minX);
  const X = (x) => (x - b.minX) * s;
  const Y = (y) => (b.maxY - y) * s;
  // Grid every 0.5 m, labels every metre.
  ctx.lineWidth = 1;
  for (let g = Math.ceil(b.minX * 2) / 2; g <= b.maxX; g += 0.5) {
    ctx.strokeStyle = Number.isInteger(g) ? 'rgba(111, 183, 255, 0.22)' : 'rgba(111, 183, 255, 0.08)';
    ctx.beginPath();
    ctx.moveTo(X(g), 0);
    ctx.lineTo(X(g), H);
    ctx.stroke();
  }
  for (let g = Math.ceil(b.minY * 2) / 2; g <= b.maxY; g += 0.5) {
    ctx.strokeStyle = Number.isInteger(g) ? 'rgba(111, 183, 255, 0.22)' : 'rgba(111, 183, 255, 0.08)';
    ctx.beginPath();
    ctx.moveTo(0, Y(g));
    ctx.lineTo(W, Y(g));
    ctx.stroke();
  }
  // Sensed terrain (max-pooled height field), sky blue by height.
  if (m.terrain && m.terrain.max > 0.005) {
    const t = m.terrain;
    const bytes = Uint8Array.from(atob(t.data), (c) => c.charCodeAt(0));
    const heights = new Float32Array(bytes.buffer);
    const [rx, ry] = t.hfieldSize;
    const [px, py] = t.pos.length ? t.pos : [0, 0];
    const cell = (2 * rx) / t.size;
    for (let r = 0; r < t.size; r++) {
      for (let c = 0; c < t.size; c++) {
        const h = heights[r * t.size + c];
        if (h < 0.01) continue;
        const x = px - rx + c * cell;
        const y = py - ry + r * cell;
        ctx.fillStyle = `rgba(111, 183, 255, ${0.18 + 0.6 * Math.min(1, h / Math.max(0.3, t.max))})`;
        ctx.fillRect(X(x), Y(y + cell), cell * s + 0.5, cell * s + 0.5);
      }
    }
  }
  // Course pieces.
  ctx.strokeStyle = COLORS.cream;
  ctx.fillStyle = 'rgba(255, 244, 220, 0.14)';
  ctx.lineWidth = 2;
  for (const p of m.pieces) {
    const [w, x, y, z] = p.quat.length === 4 ? p.quat : [1, 0, 0, 0];
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    ctx.save();
    ctx.translate(X(p.pos[0]), Y(p.pos[1]));
    ctx.rotate(-yaw);
    if (p.type === 'box') {
      ctx.fillRect(-p.size[0] * s, -p.size[1] * s, 2 * p.size[0] * s, 2 * p.size[1] * s);
      ctx.strokeRect(-p.size[0] * s, -p.size[1] * s, 2 * p.size[0] * s, 2 * p.size[1] * s);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(2, (p.size[0] ?? 0.03) * s), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
  // Replays.
  const drawPath = (r, color) => {
    if (!r?.path?.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    r.path.forEach((q, i) => (i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1]))));
    ctx.stroke();
    const last = r.path[r.path.length - 1];
    if (r.fell) cross(ctx, X(last[0]), Y(last[1]), 12, COLORS.berry);
    else dot(ctx, X(last[0]), Y(last[1]), 7, color);
  };
  drawPath(state.replays.ship, COLORS.orange);
  drawPath(state.replays.rel, COLORS.mint);
  // Start (where the pack begins) and where the headset ended.
  ctx.save();
  ctx.translate(X(m.start.x), Y(m.start.y));
  ctx.rotate(-m.start.yaw);
  ctx.fillStyle = COLORS.yellow;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-10, 10);
  ctx.lineTo(-10, -10);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  const fallen = /fall|getting/.test(m.end.mode);
  if (fallen) cross(ctx, X(m.end.x), Y(m.end.y), 9, 'rgba(255, 92, 138, 0.6)');
  ctx.fillStyle = COLORS.dim;
  ctx.font = '22px DuckBebas, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('START', X(m.start.x) + 18, Y(m.start.y) - 12);
  ctx.fillText(`1 M GRID | HEADSET ENDED ${String(m.end.mode).toUpperCase()}`, 14, H - 14);
}

function cross(ctx, x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
}

function dot(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function updateReplaySelect() {
  const sel = $('replay-release');
  const list = state.releases.releases ?? [];
  sel.innerHTML = list.length ? list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${esc(r.walkHash)})</option>`).join('') : '<option>No trained brains yet</option>';
  if (state.releases.active) sel.value = state.releases.active;
  sel.disabled = !list.length || !state.selected;
  $('replay-rel').disabled = !list.length || !state.selected;
}

// --- 3D replay -------------------------------------------------------------------------------
let viewer = null;
let view = 'map';
async function ensureViewer() {
  if (viewer) return viewer;
  const { ReplayViewer } = await import('./viewer.js');
  viewer = new ReplayViewer($('view3d'), (t, total) => {
    $('clock').textContent = `${t.toFixed(1)} / ${total.toFixed(1)} s`;
    if (!scrubbing) $('scrub').value = total ? String(Math.round((1000 * t) / total)) : '0';
  });
  if (state.map) viewer.setScene(state.map);
  for (const which of ['ship', 'rel']) if (state.replays[which]?.frames) await viewer.setReplay(which, state.replays[which].frames);
  return viewer;
}
let scrubbing = false;
$('scrub').addEventListener('input', () => {
  scrubbing = true;
  if (viewer) {
    viewer.playing = false;
    $('play').textContent = 'Play';
    viewer.seek((Number($('scrub').value) / 1000) * viewer.duration);
  }
});
$('scrub').addEventListener('change', () => {
  scrubbing = false;
});
$('play').addEventListener('click', () => {
  if (!viewer) return;
  viewer.playing = !viewer.playing;
  $('play').textContent = viewer.playing ? 'Pause' : 'Play';
});
async function showView(next) {
  view = next;
  $('tab-map').classList.toggle('on', next === 'map');
  $('tab-3d').classList.toggle('on', next === '3d');
  $('map').hidden = next !== 'map';
  $('view3d').hidden = next !== '3d';
  $('timeline').hidden = next !== '3d';
  if (next === '3d') await ensureViewer();
}
$('tab-map').addEventListener('click', () => void showView('map'));
$('tab-3d').addEventListener('click', () => void showView('3d'));

async function runReplay(which) {
  if (!state.selected) return;
  const release = which === 'rel' ? $('replay-release').value : null;
  const button = which === 'rel' ? $('replay-rel') : $('replay-ship');
  button.disabled = true;
  $('replay-result').textContent = 'Replaying in MuJoCo...';
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.selected)}/replay`, { release });
    state.replays[which] = r;
    drawMap();
    if (viewer) await viewer.setReplay(which, r.frames);
    const line = (x, label) =>
      x ? `<b>${label}</b> (${esc(x.walkHash)}): ${x.fell ? `<span style="color:${COLORS.berry}">fell after ${(x.fellAt * 0.02).toFixed(1)} s</span>` : 'stayed up'}, ${x.distance.toFixed(2)} m covered, tracking ${pct(x.tracking)}` : '';
    $('replay-result').innerHTML = [line(state.replays.ship, 'Shipped'), line(state.replays.rel, 'Trained')].filter(Boolean).join('<br>');
  } catch (err) {
    $('replay-result').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}
$('replay-ship').addEventListener('click', () => runReplay('ship'));
$('replay-rel').addEventListener('click', () => runReplay('rel'));

// --- Training -------------------------------------------------------------------------------
function updateTrainButtons() {
  const n = state.checked.size;
  const running = state.job?.state === 'running';
  $('train-count').textContent = `${n} pack${n === 1 ? '' : 's'} selected`;
  $('train').disabled = !n || running;
  $('stop').disabled = !running;
  $('export').disabled = !n && !$('export-motions').checked;
  const chip = $('chip-trainer');
  chip.textContent = running ? `Trainer: iteration ${state.job.iterations.length}/${state.job.of ?? '?'}` : 'Trainer: idle';
  chip.className = `chip${running ? ' busy' : ''}`;
  link?.setTrainerLine(running ? `Training: iteration ${state.job.iterations.length} of ${state.job.of ?? '?'}.` : '');
}

$('train').addEventListener('click', async () => {
  const body = {
    packs: [...state.checked],
    name: $('t-name').value,
    iterations: Number($('t-iterations').value),
    pairs: Number($('t-pairs').value),
    steps: Number($('t-steps').value),
    publish: $('t-publish').checked,
  };
  try {
    const job = await api('/api/train', body);
    state.job = { id: job.id, state: 'running', iterations: [], evals: [], of: body.iterations, log: [] };
    $('train-log').innerHTML = '';
    log(`Training on ${body.packs.length} pack(s): ${body.iterations} iterations of ${body.pairs * 2} candidates.`);
    updateTrainButtons();
    drawChart();
  } catch (err) {
    log(err.message, 'bad');
  }
});

$('stop').addEventListener('click', () => {
  if (state.job?.id) void api(`/api/jobs/${state.job.id}/stop`, {});
});

function log(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.innerHTML = text;
  $('train-log').prepend(line);
}

function onJob(msg) {
  if (!state.job || state.job.id !== msg.id) state.job = { id: msg.id, state: 'running', iterations: [], evals: [], of: null };
  const job = state.job;
  if (msg.event) {
    const e = msg.event;
    if (e.type === 'status') log(esc(e.message));
    if (e.type === 'iteration') {
      job.of = e.of;
      job.iterations.push(e);
    }
    if (e.type === 'eval') {
      job.evals.push(e);
      const m = e.metrics;
      log(`<b>${esc(e.label)}</b>: falls ${pct(m.fallRate)}, ${m.meanDistance.toFixed(2)} m, return ${m.meanReturn.toFixed(2)}${e.flat ? `; plain floor falls ${pct(e.flat.fallRate)}` : ''}`);
    }
  }
  if (msg.state === 'done') {
    job.state = 'done';
    const s = msg.result.summary;
    const rel = msg.result.release;
    if (s.stopped && !s.improved) {
      // Stopped before a better brain turned up: not a verdict on training.
      log(`Stopped at iteration ${job.iterations.length} of ${s.iterations}; nothing released.`);
    } else {
      log(
        s.improved
          ? `Better: falls ${pct(s.baseline.fallRate)} to ${pct(s.trained.fallRate)}, ${s.baseline.meanDistance.toFixed(2)} to ${s.trained.meanDistance.toFixed(2)} m. ${rel ? `Release <code>${esc(rel.id)}</code>${rel.active ? ', offered to the headset.' : '.'}` : ''}`
          : 'No improvement over the shipped brain; nothing released.',
        s.improved ? 'good' : 'bad',
      );
    }
  }
  if (msg.state === 'failed') {
    job.state = 'failed';
    log(`Training failed: ${esc(msg.error)}`, 'bad');
  }
  updateTrainButtons();
  drawChart();
}

function drawChart() {
  const canvas = $('chart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(0, 0, W, H);
  const its = state.job?.iterations ?? [];
  const evals = (state.job?.evals ?? []).filter((e) => e.iteration > 0 || e.label === 'baseline');
  ctx.font = '22px DuckBebas, sans-serif';
  ctx.fillStyle = COLORS.dim;
  if (!its.length && !evals.length) {
    ctx.textAlign = 'center';
    ctx.fillText('TRAINING PROGRESS SHOWS HERE', W / 2, H / 2);
    return;
  }
  const n = Math.max(state.job.of ?? its.length, 1);
  const left = 44;
  const right = W - 44;
  const top = 28;
  const bottom = H - 30;
  const X = (i) => left + ((right - left) * i) / n;
  const vals = its.map((e) => e.meanFitness).concat(evals.map((e) => e.metrics.meanReturn));
  const lo = Math.min(...vals) - 0.05;
  const hi = Math.max(...vals) + 0.05;
  const Y = (v) => bottom - ((bottom - top) * (v - lo)) / (hi - lo || 1);
  const F = (f) => bottom - (bottom - top) * f;
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.yellow;
  ctx.fillText('SCORE', left, 20);
  ctx.fillStyle = COLORS.berry;
  ctx.fillText('FALLS', left + 70, 20);
  ctx.fillStyle = COLORS.mint;
  ctx.fillText('HELD-OUT FALLS', left + 140, 20);
  ctx.strokeStyle = 'rgba(255, 244, 220, 0.1)';
  ctx.lineWidth = 1;
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.moveTo(left, F(f));
    ctx.lineTo(right, F(f));
    ctx.stroke();
  }
  const line = (points, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  };
  line(its.map((e) => [X(e.iteration), Y(e.meanFitness)]), COLORS.yellow, 3);
  line(its.map((e) => [X(e.iteration), F(e.fallRate)]), COLORS.berry, 2);
  for (const e of evals) dot(ctx, X(e.iteration), F(e.metrics.fallRate), 6, COLORS.mint);
  ctx.fillStyle = COLORS.dim;
  ctx.font = '18px DuckBebas, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('100%', W - 6, F(1) + 6);
  ctx.fillText('0%', W - 6, F(0) + 6);
  ctx.textAlign = 'center';
  ctx.fillText(`ITERATION ${its.length}/${n}`, (left + right) / 2, H - 8);
}

// --- Releases -------------------------------------------------------------------------------
function renderReleases() {
  const box = $('releases');
  const index = state.releases;
  link?.setBrains(index);
  const list = index.releases ?? [];
  $('chip-brain').textContent = index.active ? `Headset offer: ${list.find((r) => r.id === index.active)?.name ?? index.active}` : 'Headset brain: shipped';
  $('chip-brain').className = `chip${index.active ? ' on' : ''}`;
  if (!list.length) {
    box.innerHTML = '<div class="empty">No trained brains yet.</div>';
    updateReplaySelect();
    return;
  }
  box.innerHTML = list
    .map(
      (r) => `<div class="release">
        <div class="head"><span class="name">${esc(r.name)}</span>${
          r.id === index.active
            ? `<button class="btn btn-yellow" data-deactivate>Offered</button>`
            : `<button class="btn" data-activate="${esc(r.id)}">Send to headset</button>`
        }</div>
        <div class="nums">falls <b>${pct(r.baselineFallRate)} to ${pct(r.fallRate)}</b> on ${r.packs} pack(s) | walk ${esc(r.walkHash)} from ${esc(r.baseHash)} | ${esc(ago(r.createdAt))}</div>
        <div class="nums">${esc(r.trainer)} | <code>${esc(r.id)}</code></div>
        <div class="hub">${
          r.hubRepo
            ? `<span>On Hugging Face: <a href="https://huggingface.co/${esc(r.hubRepo)}" target="_blank" rel="noopener">${esc(r.hubRepo)}</a>, ready to flash to a real duck</span>`
            : '<span>Not on Hugging Face yet: a real duck downloads brains from there</span>'
        }<button class="btn btn-small" data-publish="${esc(r.id)}">${r.hubRepo ? 'Update' : 'Publish to Hugging Face'}</button></div>
      </div>`,
    )
    .join('');
  updateReplaySelect();
}

/** The publish form (one, below the list, so a live re-render never eats what is typed). */
function openPublish(id) {
  const release = (state.releases.releases ?? []).find((r) => r.id === id);
  if (!release) return;
  state.publishFor = id;
  const slug = String(release.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brain';
  $('publish-name').textContent = release.name;
  $('publish-repo').value = release.hubRepo ?? '';
  $('publish-repo').placeholder = `your-name/microduck-duckdash-${slug} (default)`;
  $('publish-out').textContent = '';
  $('publish-form').hidden = false;
  $('publish-token').focus();
}

function closePublish() {
  state.publishFor = null;
  $('publish-token').value = '';
  $('publish-form').hidden = true;
}

$('publish-cancel').addEventListener('click', closePublish);
$('publish-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.publishFor;
  if (!id) return;
  $('publish-go').disabled = true;
  $('publish-out').textContent = 'Uploading...';
  try {
    const r = await api(`/api/releases/${encodeURIComponent(id)}/publish-hub`, { token: $('publish-token').value.trim(), repo: $('publish-repo').value.trim() });
    $('publish-token').value = '';
    state.releases = r.releases;
    renderReleases();
    $('publish-out').innerHTML = `Published to <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.repo)}</a>. On the headset: menu, REAL DUCK, FLASH BRAIN.`;
  } catch (err) {
    $('publish-out').textContent = err.message;
  } finally {
    $('publish-go').disabled = false;
  }
});

$('releases').addEventListener('click', async (e) => {
  const on = e.target.closest('[data-activate]');
  const off = e.target.closest('[data-deactivate]');
  const publish = e.target.closest('[data-publish]');
  if (publish) {
    openPublish(publish.dataset.publish);
    return;
  }
  try {
    if (on) state.releases = await api(`/api/releases/${encodeURIComponent(on.dataset.activate)}/activate`, {});
    else if (off) state.releases = await api('/api/releases/deactivate', {});
    renderReleases();
  } catch (err) {
    alert(err.message);
  }
});

// --- Connector and import ----------------------------------------------------------------------
$('export-motions').addEventListener('change', () => updateTrainButtons());
$('export').addEventListener('click', async () => {
  const button = $('export');
  button.disabled = true;
  $('export-result').textContent = 'Exporting (each test case is replayed once for its dataset)...';
  try {
    const r = await api('/api/connector/export', { packs: [...state.checked], target: $('export-target').value, motions: $('export-motions').checked });
    const mb = (r.bytes / 1048576).toFixed(1);
    const what = [r.packs.length ? `${r.packs.length} test case${r.packs.length === 1 ? '' : 's'}` : '', r.motionSets.length ? `${r.motionSets.length} motion set${r.motionSets.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    $('export-result').innerHTML = `<a class="btn btn-mint" href="${esc(ENGINE + r.zip)}" download>Download ${esc(r.id)}.zip (${mb} MB)</a><br>${esc(what)} for ${esc(r.title)}: start with <code>START_HERE.md</code>. Also saved in <code>${esc(r.dir)}</code>. A brain trained elsewhere comes back as a folder in <code>public/policies/incoming/</code>, then <code>node tools/train/release.mjs rescan</code>.`;
    // Start the download right away (the link stays for another copy).
    const a = document.createElement('a');
    a.href = ENGINE + r.zip;
    a.download = `${r.id}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    $('export-result').textContent = err.message;
  } finally {
    updateTrainButtons();
  }
});

/** The export targets the engine offers (MuJoCo, mjlab, Isaac, Genesis, Gymnasium, any engine). */
function renderTargets(targets) {
  const select = $('export-target');
  const was = select.value;
  select.innerHTML = (targets ?? []).map((t) => `<option value="${esc(t.key)}">${esc(t.title)}</option>`).join('');
  if (was) select.value = was;
}

$('import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const res = await fetch(`${ENGINE}/api/inbox`, { method: 'POST', body: await file.text() });
  const data = await res.json();
  if (!res.ok) alert(data.error);
  e.target.value = '';
});

// --- Live updates --------------------------------------------------------------------------------
function connect() {
  const events = new EventSource(`${ENGINE}/api/events`);
  events.addEventListener('inbox', (e) => {
    const data = JSON.parse(e.data);
    const before = new Set(state.packs.map((p) => p.id));
    state.packs = data.packs;
    if (data.datasets) {
      state.datasets = data.datasets;
      renderDatasets();
    }
    const fresh = new Set(state.packs.filter((p) => !before.has(p.id)).map((p) => p.id));
    renderPacks(fresh);
    if (fresh.size) $('chip-inbox').textContent = `Inbox: new pack ${ago(state.packs[0].at)}`;
  });
  events.addEventListener('job', (e) => onJob(JSON.parse(e.data)));
  events.addEventListener('releases', (e) => {
    state.releases = JSON.parse(e.data);
    renderReleases();
  });
  events.onopen = () => {
    $('chip-inbox').textContent = `Inbox: watching (${state.packs.length})`;
    $('chip-inbox').className = 'chip on';
    $('engine-missing').hidden = true;
    void link?.flushHeld().then(renderPairing);
  };
  events.onerror = () => {
    $('chip-inbox').textContent = 'Inbox: reconnecting';
    $('chip-inbox').className = 'chip';
  };
}

// --- Headset pairing (website only) ------------------------------------------------------------
const spaced = (code) => (code?.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code ?? '');

function renderPairing() {
  if (!link) {
    $('pair-code').textContent = '';
    $('pair-hint').textContent = 'To pair a headset, open this trainer from the Duck Lab XR website (in development: the dev server /trainer/ page) instead of this address.';
    $('chip-headset').textContent = 'Headset: open from the website';
    return;
  }
  const peers = [...link.headsets.values()];
  const open = peers.filter((p) => p.state === 'open');
  $('pair-code').textContent = link.available ? spaced(link.code) : '';
  $('pair-hint').textContent =
    link.status ||
    (open.length
      ? 'Connected over your network. Packs from the headset land in the inbox; the brain you offer goes to the headset.'
      : `On the headset, open this website (${SITE.headsetHost ?? location.host}), then menu, TRAINER ON YOUR COMPUTER, and pick ${spaced(link.code) || 'this code'}.`);
  $('pair-list').innerHTML = peers
    .map((p) => {
      const what = p.state === 'open' ? `connected${p.packs ? `, ${p.packs} pack${p.packs === 1 ? '' : 's'} received` : ''}` : p.state === 'connecting' ? 'connecting...' : 'gone';
      const brain = p.brain ? `runs ${esc(state.releases.releases?.find((r) => r.id === p.brain)?.name ?? p.brain)}` : 'shipped brain';
      return `<div class="headset ${p.state}"><span class="who"><i class="dot"></i>${esc(p.name)}</span><span class="meta">${what} | ${brain}</span></div>`;
    })
    .join('');
  if (link.held.length) $('pair-list').insertAdjacentHTML('beforeend', `<div class="meta">${link.held.length} pack(s) waiting for the trainer to start</div>`);
  document.querySelector('.pair-card')?.classList.toggle('linked', open.length > 0);
  $('chip-headset').textContent = open.length ? `Headset: ${open.map((p) => p.name).join(', ')}` : link.available ? `Pair code ${spaced(link.code)}` : 'Headset: no pairing';
  $('chip-headset').className = `chip${open.length ? ' on' : ''}`;
}

// --- Play | Trainer (website only): one click back to the game ----------------------------------
const EMBEDDED = window.parent !== window;

function setupViews() {
  if (!SITE) return;
  // The game loads the trainer with itself from now on, so the headset link stays up while playing.
  try {
    localStorage.setItem('ducklab.trainerUsed', '1');
  } catch {
    // storage blocked
  }
  $('views').hidden = false;
  $('view-play').addEventListener('click', (e) => {
    e.preventDefault();
    if (EMBEDDED) window.parent.postMessage({ duckLab: 'view', view: 'play' }, location.origin);
    else location.href = new URL('../', location.href).href;
  });
}

async function startPairing() {
  if (!SITE) {
    renderPairing();
    return;
  }
  const { TrainerLink } = await import('/src/link/trainer-link.ts');
  link = new TrainerLink({ engine: ENGINE, onChange: renderPairing });
  link.start();
  renderPairing();
}

/** The engine's state, waiting for it to start when it is not running (website only). */
async function engineState() {
  for (;;) {
    try {
      const s = await api('/api/state');
      $('engine-missing').hidden = true;
      return s;
    } catch (err) {
      if (!SITE) throw err;
      $('engine-missing').hidden = false;
      // One click to start it, where the site can (the dev server on this computer).
      $('engine-start').hidden = !SITE.start;
      if (SITE.start) $('engine-text').innerHTML = '<b>The trainer is not running on this computer.</b> One click starts it (in its own window; close that window to stop it); this page connects by itself.';
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

$('engine-start').addEventListener('click', async () => {
  const button = $('engine-start');
  button.disabled = true;
  button.textContent = 'Starting...';
  try {
    const res = await fetch(SITE.start, { method: 'POST' });
    if (!res.ok) throw new Error(res.status === 403 ? 'start it on the computer the website runs on' : `HTTP ${res.status}`);
  } catch (err) {
    $('engine-text').textContent = `Could not start the trainer: ${err.message}. Run npm run lab in the project folder.`;
  }
  setTimeout(() => {
    button.disabled = false;
    button.textContent = 'Start the trainer';
  }, 8000);
});

async function start() {
  setupViews();
  await startPairing().catch((err) => {
    $('pair-hint').textContent = `Pairing could not start: ${err.message}`;
  });
  const s = await engineState();
  state.packs = s.packs;
  state.datasets = s.datasets;
  state.releases = s.releases;
  state.shippedHash = s.shippedHash;
  $('t-iterations').value = s.defaults.iterations;
  $('t-pairs').value = s.defaults.pairs;
  $('t-steps').value = s.defaults.steps;
  renderTargets(s.targets);
  const running = s.jobs.find((j) => j.state === 'running');
  if (running) {
    state.job = { id: running.id, state: 'running', iterations: [], evals: [], of: running.options.iterations };
    for (const event of running.events) onJob({ id: running.id, event });
  }
  renderPacks();
  renderDatasets();
  renderReleases();
  drawMap();
  drawChart();
  updateTrainButtons();
  connect();
  const firstFalls = state.packs.find((p) => p.reason === 'falls') ?? state.packs[0];
  if (firstFalls) void selectPack(firstFalls.id);
}

document.fonts.load('22px DuckBebas').finally(() => void start());
