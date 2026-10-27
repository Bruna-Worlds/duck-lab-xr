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
    void showGround();
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
  $('isaac-run').disabled = false;
  updateReplaySelect();
  isaac.drawn = null;
  isaac.drawnKey = '';
  drawMap();
  pollIsaac(true);
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
  // The Isaac Sim test case: MuJoCo's run (the ghost) dashed orange, PhysX's sky blue.
  if (isaac.drawn) {
    ctx.save();
    ctx.setLineDash([10, 8]);
    drawPath({ path: isaac.drawn.mujoco }, COLORS.orange);
    ctx.restore();
    drawPath({ path: isaac.drawn.path, fell: isaac.drawn.fell }, COLORS.sky);
  }
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

// --- Isaac Sim test case ---------------------------------------------------------------------
// The pack under PhysX in the streaming Isaac Sim on this PC, beside an orange ghost replaying
// MuJoCo's run of it (tools/isaac, the bridge's /ducklab/testcase).
const isaac = { timer: 0, status: null, bridge: null, watching: false, asked: false, drawn: null, drawnKey: '' };

async function runIsaac(id) {
  if (!id) return;
  const release = $('isaac-trained').checked ? $('replay-release').value || null : null;
  $('isaac-run').disabled = true;
  $('isaac-result').textContent = "Exporting the pack and MuJoCo's run of it...";
  try {
    const r = await api(`/api/packs/${encodeURIComponent(id)}/isaac`, { release });
    isaac.bridge = r.bridge;
    $('isaac-result').textContent = 'Building it in Isaac Sim...';
    // The stream in this page from the start, unless a Duck Lab XR page holds it (it shows there).
    if (!isaac.watching && !isaac.status?.appConnected) watchIsaac(true);
    pollIsaac(true);
  } catch (err) {
    $('isaac-result').textContent = err.message;
  } finally {
    $('isaac-run').disabled = !state.selected;
  }
}

/** Polls the test case: quickly while it builds or runs, then every few seconds. */
function pollIsaac(now = false) {
  clearTimeout(isaac.timer);
  const tick = async () => {
    let s;
    try {
      s = await api('/api/isaac');
    } catch (err) {
      s = { available: false, error: err.message };
    }
    showIsaac(s);
    const busy = s.available && ['building', 'waiting', 'running'].includes(s.testcase?.state);
    isaac.timer = setTimeout(tick, busy ? 500 : s.available ? 4000 : 10000);
  };
  isaac.timer = setTimeout(tick, now ? 0 : 4000);
}

function showIsaac(s) {
  isaac.status = s;
  const tc = s.testcase;
  if (s.bridge) isaac.bridge = s.bridge;
  $('isaac-controls').hidden = !s.available || !tc || tc.state === 'idle';
  $('isaac-again').disabled = tc?.state !== 'done' && tc?.state !== 'running';
  if (!s.available) {
    $('isaac-result').textContent = isaac.asked ? s.error : '';
    return;
  }
  const where = s.appConnected && !isaac.watching ? " The stream is in Duck Lab XR's ISAAC SIM window (Watch here takes it)." : '';
  const sum = tc?.summary;
  const fell = (t) => (t === null || t === undefined ? 'stayed up' : `<span style="color:${COLORS.berry}">tipped at ${t.toFixed(1)} s</span>`);
  if (!tc || tc.state === 'idle') $('isaac-result').textContent = '';
  else if (tc.state === 'error') $('isaac-result').textContent = `Isaac Sim: ${tc.error}`;
  else if (tc.state === 'building') $('isaac-result').textContent = `Building ${tc.title ?? 'the pack'} in Isaac Sim: Pip through the MJCF importer, the colliders, the ghost...`;
  else if (tc.state === 'waiting') $('isaac-result').textContent = 'Built. Waiting for Isaac Sim to draw it (the first time, RTX compiles the new materials: up to a minute)...' + where;
  else if (sum) {
    const head = tc.state === 'running' ? `Running in Isaac Sim: ${tc.t.toFixed(1)} of ${tc.duration.toFixed(1)} s` : `Done in Isaac Sim (${esc(tc.title ?? '')})`;
    $('isaac-result').innerHTML =
      `${head}.${where}<br>` +
      `<b style="color:${COLORS.sky}">PhysX</b>: ${sum.walkedM.toFixed(2)} m walked, turned ${sum.turnedDeg} deg, ${fell(sum.fellAt)}<br>` +
      (sum.mujocoWalkedM !== undefined
        ? `<b style="color:${COLORS.orange}">MuJoCo (ghost)</b>: ${sum.mujocoWalkedM.toFixed(2)} m walked, turned ${sum.mujocoTurnedDeg} deg, ${fell(sum.mujocoFellAt)}; ${Math.round(sum.apartM * 100)} cm apart now`
        : '');
  } else $('isaac-result').textContent = `Starting in Isaac Sim...${where}`;
  // Both paths on the map, for the pack they belong to.
  const id = tc?.title ? tc.title.split(',')[0] : null;
  const paths = id && id === state.selected && tc.path ? { path: tc.path, mujoco: tc.mujocoPath ?? [], fell: sum?.fellAt != null } : null;
  const key = paths ? `${paths.path.length}:${paths.fell}` : '';
  if (key !== isaac.drawnKey) {
    isaac.drawnKey = key;
    isaac.drawn = paths;
    drawMap();
  }
}

$('isaac-run').addEventListener('click', () => {
  isaac.asked = true;
  void runIsaac(state.selected);
});
$('isaac-again').addEventListener('click', async () => {
  await api('/api/isaac/again', {}).catch((err) => ($('isaac-result').textContent = err.message));
  pollIsaac(true);
});
$('isaac-stop').addEventListener('click', async () => {
  await api('/api/isaac/stop', {}).catch((err) => ($('isaac-result').textContent = err.message));
  watchIsaac(false);
  isaac.drawn = null;
  drawMap();
  pollIsaac(true);
});
$('isaac-watch').addEventListener('click', () => watchIsaac(!isaac.watching));

/** Isaac Sim's stream in this page (it streams to one page at a time: this takes it). */
function watchIsaac(on) {
  isaac.watching = on;
  const frame = $('isaac-stream');
  const [server, port] = (isaac.bridge ?? '127.0.0.1:8211').split(':');
  frame.hidden = !on;
  frame.src = on ? `/isaac/player.html?server=${server}&port=${port}` : 'about:blank';
  $('isaac-watch').textContent = on ? 'Hide stream' : 'Watch here';
}
pollIsaac(true);

// --- Training -------------------------------------------------------------------------------
function updateTrainButtons() {
  const n = state.checked.size;
  const running = state.job?.state === 'running';
  $('train-count').textContent = `${n} pack${n === 1 ? '' : 's'} selected`;
  $('train').disabled = !n || running || (currentTrainer() ? !currentTrainer().ready : false);
  $('stop').disabled = !running;
  $('export').disabled = !n && !$('export-motions').checked;
  const chip = $('chip-trainer');
  const done = state.job?.trainer && state.job.trainer !== 'es' ? state.job.progress ?? 0 : (state.job?.iterations.length ?? 0);
  chip.textContent = running ? `Trainer: iteration ${done}/${state.job.of ?? '?'}` : 'Trainer: idle';
  chip.className = `chip${running ? ' busy' : ''}`;
  if (typeof updateCrossCheckButton === 'function' && state.releases) updateCrossCheckButton();
  link?.setTrainerLine(running ? `Training: iteration ${state.job.iterations.length} of ${state.job.of ?? '?'}.` : '');
}

$('train').addEventListener('click', async () => {
  const trainer = currentTrainer();
  const builtin = trainer?.kind !== 'command';
  const body = builtin
    ? {
        trainer: trainer?.id ?? 'es',
        packs: [...state.checked],
        name: $('t-name').value,
        iterations: Number($('t-iterations').value),
        pairs: Number($('t-pairs').value),
        steps: Number($('t-steps').value),
        randomize: $('t-randomize').value,
        publish: $('t-publish').checked,
      }
    : {
        trainer: trainer.id,
        packs: [...state.checked],
        name: $('t-oname').value,
        envs: Number($('t-envs').value),
        iterations: Number($('t-oiterations').value),
      };
  try {
    const job = await api('/api/train', body);
    state.job = { id: job.id, state: 'running', iterations: [], evals: [], metrics: [], of: body.iterations, log: [], trainer: body.trainer, packs: body.packs, progress: 0 };
    state.gateRows = [];
    $('train-log').innerHTML = '';
    log(
      builtin
        ? `Training on ${body.packs.length} pack(s): ${body.iterations} iterations of ${body.pairs * 2} candidates, ${body.randomize === 'pollen' ? "Pollen and NVIDIA's randomisation" : 'shoves only'}.`
        : `${esc(trainer.title)} on ${body.packs.length} pack(s): ${body.envs} robots, ${body.iterations} iterations.`,
    );
    updateTrainButtons();
    drawChart();
  } catch (err) {
    log(err.message, 'bad');
  }
});

// --- Trainers ---------------------------------------------------------------------------------
function currentTrainer() {
  return (state.trainers ?? []).find((t) => t.id === $('t-trainer').value) ?? null;
}

function renderTrainers() {
  const list = state.trainers ?? [];
  const sel = $('t-trainer');
  const keep = sel.value;
  sel.innerHTML = list.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}${t.ready ? '' : ' (not set up here)'}</option>`).join('');
  if (list.some((t) => t.id === keep)) sel.value = keep;
  showTrainer();
}

function showTrainer() {
  const t = currentTrainer();
  const builtin = !t || t.kind !== 'command';
  $('t-about').textContent = t?.about ?? '';
  $('t-es').hidden = !builtin;
  $('t-outside').hidden = builtin;
  $('t-publish-row').hidden = !builtin;
  $('t-install').hidden = !t || t.ready;
  $('t-install').textContent = t && !t.ready ? `Not set up on this PC yet: ${t.install ?? ''}` : '';
  $('t-check-hint').textContent =
    t?.brain === 'nav-camera'
      ? 'The new camera brain is then cross-checked against the one that drove in the test case: both drive in rooms rebuilt from it, in Isaac Lab.'
      : 'Every new brain is then cross-checked against the one that failed in the test case (or the shipped one) in MuJoCo, MuJoCo with the randomisation, and Newton.';
  updateTrainButtons();
  void showGround();
}
$('t-trainer').addEventListener('change', showTrainer);

// --- The training ground a test case makes ----------------------------------------------------
/**
 * For a trainer that trains on the test case itself (trainers.mjs `ground`): the first ticked test case
 * rebuilt (tools/train/lib/ground.mjs), drawn from above, and what Pip's camera saw. A running job shows
 * the ground it was given.
 */
async function showGround() {
  const t = currentTrainer();
  const running = state.job?.state === 'running' && state.job.ground;
  if (running) return drawGround(state.job.ground, state.job.groundPictures);
  const pack = [...state.checked][0];
  if (!t?.ground || !pack) {
    $('t-ground').hidden = true;
    return;
  }
  const key = `${pack}|${t.ground}`;
  if (state.groundKey === key && !$('t-ground').hidden) return;
  state.groundKey = key;
  try {
    const res = await api(`/api/ground?pack=${encodeURIComponent(pack)}&purpose=${t.ground}`);
    if (state.groundKey === key) drawGround(res.ground, res.pictures);
  } catch {
    $('t-ground').hidden = true;
  }
}

const GROUND_COLOURS = { step: COLORS.sky, furniture: '#9a9db0', wall: '#d8d2c8', piece: COLORS.orange };

function drawGround(g, pictures) {
  $('t-ground').hidden = false;
  $('t-ground-from').textContent = `from test case ${g.pack}${g.playground ? ` (${g.playground})` : ''}`;
  const [x0, x1, y0, y1] = g.region;
  const W = 480;
  const H = 240;
  const pad = 18;
  const s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  const ox = W / 2 - ((x0 + x1) / 2) * s;
  const oy = H / 2 + ((y0 + y1) / 2) * s;
  // The ground's x to the right, its y (Pip's left) up.
  const X = (x) => +(ox + x * s).toFixed(1);
  const Y = (y) => +(oy - y * s).toFixed(1);
  const parts = [`<rect x="${X(x0)}" y="${Y(y1)}" width="${((x1 - x0) * s).toFixed(1)}" height="${((y1 - y0) * s).toFixed(1)}" rx="8" fill="${COLORS.ink2}" />`];
  const labels = [];
  for (const o of g.obstacles) {
    const kind = o.walkable ? 'step' : o.source === 'room' ? (/wall|window|door|art/.test(o.label) ? 'wall' : 'furniture') : 'piece';
    // Steps in the colours the trainer's terrain gives them (duckstep/ground.py): the dog bed brown.
    const fill = kind === 'step' && /bed/.test(o.label) ? '#c27a5f' : GROUND_COLOURS[kind];
    const deg = (-o.yaw * 180) / Math.PI;
    const at = `translate(${X(o.pos[0])} ${Y(o.pos[1])}) rotate(${deg.toFixed(1)})`;
    if (o.shape === 'cylinder') parts.push(`<circle cx="${X(o.pos[0])}" cy="${Y(o.pos[1])}" r="${Math.max(2, o.half[0] * s).toFixed(1)}" fill="${fill}" />`);
    else
      parts.push(
        `<rect transform="${at}" x="${(-o.half[0] * s).toFixed(1)}" y="${(-o.half[1] * s).toFixed(1)}" width="${(2 * o.half[0] * s).toFixed(1)}" height="${(2 * o.half[1] * s).toFixed(1)}" rx="3" fill="${fill}" fill-opacity="${kind === 'step' ? 0.85 : 0.9}" />`,
      );
    if ((kind === 'step' || kind === 'furniture') && o.half[0] * o.half[1] * s * s > 120) {
      labels.push(`<text x="${X(o.pos[0])}" y="${Y(o.pos[1]) + 4}" text-anchor="middle" class="gl">${esc(kind === 'step' ? `${Math.round(o.top * 100)} cm ${o.label}` : o.label)}</text>`);
    }
  }
  // Pip's start (and the way it faced), the way to its goal, and where it went wrong.
  const end = g.goal ?? [g.trouble[0] + 0.6, g.trouble[1]];
  parts.push(`<line x1="${X(0)}" y1="${Y(0)}" x2="${X(end[0])}" y2="${Y(end[1])}" stroke="${COLORS.dim}" stroke-width="1.5" stroke-dasharray="5 5" />`);
  if (g.goal) parts.push(`<circle cx="${X(g.goal[0])}" cy="${Y(g.goal[1])}" r="8" fill="none" stroke="${COLORS.mint}" stroke-width="3" />`, `<text x="${X(g.goal[0])}" y="${Y(g.goal[1]) - 13}" text-anchor="middle" class="gl mint">goal</text>`);
  const tx = X(g.trouble[0]);
  const ty = Y(g.trouble[1]);
  parts.push(`<path d="M${tx - 7} ${ty - 7}L${tx + 7} ${ty + 7}M${tx + 7} ${ty - 7}L${tx - 7} ${ty + 7}" stroke="${COLORS.berry}" stroke-width="3.5" stroke-linecap="round" />`);
  labels.push(`<text x="${tx}" y="${ty + 22}" text-anchor="middle" class="gl berry">${g.reason === 'falls' ? 'fell here' : g.reason === 'stuck' ? 'stuck here' : 'saved here'}</text>`);
  // The other starts training ducks get (steering: the test case's own start, the stuck pose): small rings.
  for (const st of (g.starts ?? []).slice(1)) {
    parts.push(
      `<line x1="${X(st.x)}" y1="${Y(st.y)}" x2="${X(st.x + 0.16 * Math.cos(st.yaw))}" y2="${Y(st.y + 0.16 * Math.sin(st.yaw))}" stroke="${COLORS.yellow}" stroke-width="2" stroke-linecap="round" />`,
      `<circle cx="${X(st.x)}" cy="${Y(st.y)}" r="5" fill="none" stroke="${COLORS.yellow}" stroke-width="2" />`,
    );
  }
  const yaw = g.start.yaw;
  parts.push(
    `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(0.22 * Math.cos(yaw))}" y2="${Y(0.22 * Math.sin(yaw))}" stroke="${COLORS.yellow}" stroke-width="3" stroke-linecap="round" />`,
    `<circle cx="${X(0)}" cy="${Y(0)}" r="7" fill="${COLORS.yellow}" />`,
  );
  labels.push(`<text x="${X(0)}" y="${Y(0) - 13}" text-anchor="middle" class="gl yellow">Pip</text>`);
  $('t-ground-svg').innerHTML = `<style>.gl{font:600 12px system-ui,sans-serif;fill:${COLORS.ink};paint-order:stroke;stroke:${COLORS.cream};stroke-width:3px}.gl.mint,.gl.berry,.gl.yellow{fill:${COLORS.cream};stroke:${COLORS.ink}}</style>${parts.join('')}${labels.join('')}`;
  $('t-ground-text').textContent =
    g.purpose === 'nav'
      ? `${g.summary}. 7 of 10 training rooms rebuild it (turned, the pieces nudged${g.look ? ", painted in the colours Pip's camera saw" : ''}). Pip starts where the drive began${(g.starts?.length ?? 0) > 1 ? ' or where it got into trouble (the rings)' : ''} and is sent to its goal.`
      : `${g.summary}. Three in five terrain patches are copies of it, Pip starting where it did and walking the way it went, the steps 70% to 120% as tall; the rest are earlier terraces and flat floor, so it keeps what it knew.`;
  const pics = pictures?.frames ?? [];
  $('t-ground-saw').hidden = !pics.length;
  $('t-ground-pics').innerHTML = '';
  for (const b64 of pics.slice(-8)) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const canvas = document.createElement('canvas');
    canvas.width = pictures.width;
    canvas.height = pictures.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(pictures.width, pictures.height);
    for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
      img.data[j] = bytes[i];
      img.data[j + 1] = bytes[i + 1];
      img.data[j + 2] = bytes[i + 2];
      img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    $('t-ground-pics').appendChild(canvas);
  }
}

// --- Cross-check ---------------------------------------------------------------------------------
const ENGINE_TITLES = { mujoco: 'MuJoCo', pollen: 'MuJoCo + randomisation', newton: 'Newton', 'newton-nc': 'Newton (its contacts)', physx: 'PhysX' };
/** Column heads for the table, which shares a narrow card (the full names are their tooltips). */
const ENGINE_SHORT = { mujoco: 'MuJoCo', pollen: 'Randomised', newton: 'Newton', 'newton-nc': 'Newton contacts', physx: 'PhysX' };

function renderCrossCheckChoices() {
  const releases = state.releases.releases ?? [];
  const brains = [{ id: 'shipped', name: 'shipped' }, ...releases.map((r) => ({ id: r.id, name: r.name }))];
  const picked = new Set(state.ccBrains ?? ['shipped', ...releases.slice(0, 1).map((r) => r.id)]);
  $('cc-brains').innerHTML = brains
    .map((b) => `<label class="check"><input type="checkbox" data-brain="${esc(b.id)}" ${picked.has(b.id) ? 'checked' : ''} />${esc(b.name)}</label>`)
    .join('');
  const engines = state.engines ?? Object.keys(ENGINE_TITLES);
  const on = new Set(state.ccEngines ?? ['mujoco', 'pollen', 'newton']);
  $('cc-engines').innerHTML = engines
    .map((e) => `<label class="check"><input type="checkbox" data-engine="${esc(e)}" ${on.has(e) ? 'checked' : ''} />${esc(ENGINE_TITLES[e] ?? e)}</label>`)
    .join('');
  updateCrossCheckButton();
}

function updateCrossCheckButton() {
  const running = state.crossJob?.state === 'running';
  $('cc-run').disabled = running || !state.checked.size;
  $('cc-run').textContent = running ? 'Cross-checking...' : `Cross-check on ${state.checked.size} selected`;
}

$('cc-brains').addEventListener('change', () => {
  state.ccBrains = [...document.querySelectorAll('#cc-brains [data-brain]')].filter((i) => i.checked).map((i) => i.dataset.brain);
});
$('cc-engines').addEventListener('change', () => {
  state.ccEngines = [...document.querySelectorAll('#cc-engines [data-engine]')].filter((i) => i.checked).map((i) => i.dataset.engine);
});

$('cc-run').addEventListener('click', async () => {
  const brains = [...document.querySelectorAll('#cc-brains [data-brain]')].filter((i) => i.checked).map((i) => i.dataset.brain);
  const engines = [...document.querySelectorAll('#cc-engines [data-engine]')].filter((i) => i.checked).map((i) => i.dataset.engine);
  try {
    state.crossJob = await api('/api/crosscheck', { packs: [...state.checked], brains, engines, seeds: 8 });
    state.crossRows = [];
    $('cc-state').textContent = 'running';
    renderCrossTable({ brains, engines, results: [] });
  } catch (err) {
    $('cc-table').textContent = err.message;
  }
  updateCrossCheckButton();
});

/** Brains down, engines across: falls and distance (randomised MuJoCo: the fall rate over its seeds). */
function renderCrossTable(report) {
  const rows = report.results ?? [];
  const brains = report.brains ?? [...new Set(rows.map((r) => r.brain))];
  const engines = (report.engines ?? [...new Set(rows.map((r) => r.engine))]).filter((e) => rows.some((r) => r.engine === e) || state.crossJob?.state === 'running');
  const name = (b) => (b === 'shipped' ? 'shipped' : ((state.releases.releases ?? []).find((r) => r.id === b)?.name ?? b));
  const cell = (brain, engine) => {
    const list = rows.filter((r) => r.brain === brain && r.engine === engine);
    if (!list.length) return '<td>...</td>';
    if (engine === 'pollen') {
      const rate = list.reduce((a, r) => a + r.fallRate, 0) / list.length;
      const dist = list.reduce((a, r) => a + r.meanDistanceM, 0) / list.length;
      return `<td class="${rate > 0.25 ? 'fell' : 'up'}">${pct(rate)} fell<br>${dist.toFixed(2)} m</td>`;
    }
    const fell = list.filter((r) => r.fellAt !== null).length;
    const walked = list.reduce((a, r) => a + r.walkedM, 0) / list.length;
    return `<td class="${fell ? 'fell' : 'up'}">${fell}/${list.length} fell<br>${walked.toFixed(2)} m</td>`;
  };
  $('cc-table').innerHTML = rows.length || state.crossJob?.state === 'running'
    ? `<table class="cc-table"><tr><th>Brain</th>${engines.map((e) => `<th title="${esc(ENGINE_TITLES[e] ?? e)}">${esc(ENGINE_SHORT[e] ?? e)}</th>`).join('')}</tr>${brains
        .map((b) => `<tr><td>${esc(name(b))}</td>${engines.map((e) => cell(b, e)).join('')}</tr>`)
        .join('')}</table><div class="meta">${(report.packs ?? state.crossJob?.packs ?? []).length} pack(s)${report.at ? `, ${esc(ago(report.at))}` : ''}</div>`
    : '';
}

/** A camera brain's cross-check: each brain driving the test case again, in the app and in Isaac Lab's rebuilt rooms. */
const DRIVE_ENGINES = { app: 'In the app (its MuJoCo, its camera pictures)', isaaclab: "Isaac Lab, rooms rebuilt from it" };
function renderDrives(rows, packs) {
  const name = (r) => (r.role === 'after' ? `new: ${(state.releases?.releases ?? []).find((x) => x.id === r.brain)?.name ?? r.brain.replace(/^[\dT-]{20}/, '')}` : 'the one that got stuck');
  $('cc-state').textContent = 'the camera brains, on the test case';
  const engines = [...new Set(rows.map((r) => r.engine))];
  $('cc-table').innerHTML = `<table class="drives"><tr><th>Where</th><th>Camera brain</th><th>Reached the goal</th><th>Stuck</th><th>Fell</th></tr>${engines
    .map((e) => {
      const list = rows.filter((r) => r.engine === e);
      const best = Math.max(...list.map((r) => r.reached));
      return list
        .map(
          (r, i) =>
            `<tr><td>${i ? '' : esc(DRIVE_ENGINES[e] ?? e)}</td><td>${esc(name(r))}</td><td class="${r.reached === best && list.length > 1 && list.some((x) => x.reached < best) ? 'good' : ''}"><b>${r.reached}</b> of ${r.tries}</td><td>${r.stuck}</td><td>${r.falls}</td></tr>`,
        )
        .join('');
    })
    .join('')}</table><div class="meta">Test case ${esc(packs[0] ?? '')}: its drive from where it began to its goal, the same start for each brain</div>`;
}

function onCrossCheck(msg) {
  if (!state.crossJob || state.crossJob.id !== msg.id) state.crossJob = { id: msg.id, state: 'running', rows: [] };
  if (msg.event?.type === 'result') {
    state.crossJob.rows = [...(state.crossJob.rows ?? []), msg.event];
    renderCrossTable({ brains: state.crossJob.brains, engines: state.crossJob.engines, packs: state.crossJob.packs, results: state.crossJob.rows });
  }
  if (msg.event?.type === 'pack') $('cc-state').textContent = `on ${msg.event.pack}`;
  if (msg.state === 'done') {
    state.crossJob.state = 'done';
    $('cc-state').textContent = 'done';
    renderCrossTable(msg.report);
  }
  if (msg.state === 'failed') {
    state.crossJob.state = 'failed';
    $('cc-state').textContent = `failed: ${msg.error}`;
  }
  updateCrossCheckButton();
}

$('stop').addEventListener('click', () => {
  if (state.job?.id) void api(`/api/jobs/${state.job.id}/stop`, {});
});

function log(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.innerHTML = text;
  const box = $('train-log');
  box.prepend(line);
  while (box.childElementCount > 300) box.lastElementChild.remove();
}

function onJob(msg) {
  if (!state.job || state.job.id !== msg.id) state.job = { id: msg.id, state: 'running', iterations: [], evals: [], metrics: [], of: null };
  const job = state.job;
  if (msg.event) {
    const e = msg.event;
    if (e.type === 'status') log(esc(e.message));
    if (e.type === 'status' && /both camera brains drive/.test(e.message)) {
      // A camera brain's own cross-check starts: the card waits for its drives, not the last walking table.
      job.drives = [];
      $('cc-state').textContent = 'the camera brains, on the test case';
      $('cc-table').innerHTML = '<div class="meta">Driving the test case again with both camera brains: in the app, then in Isaac Lab...</div>';
    }
    if (e.type === 'log') log(`<span class="meta">${esc(e.line)}</span>`);
    if (e.type === 'progress') {
      job.of = e.of;
      job.progress = e.iteration;
    }
    if (e.type === 'metric') (job.metrics ??= []).push(e);
    if (e.type === 'ground') {
      // The trainer's ground, built from the test case: drawn on the card while it trains.
      job.ground = e.ground;
      job.groundPictures = e.pictures;
      drawGround(e.ground, e.pictures);
    }
    if (e.type === 'drives') {
      // The camera brain's cross-check: drives in rooms rebuilt from the test case.
      job.drives = [...(job.drives ?? []), e];
      renderDrives(job.drives, job.packs ?? []);
    }
    if (e.type === 'crosscheck' && e.kind === 'result') {
      const what = e.fallRate !== undefined ? `${pct(e.fallRate)} of ${e.seeds} randomised runs fell` : `${e.walkedM.toFixed(2)} m, ${e.fellAt === null ? 'stayed up' : `tipped at ${e.fellAt.toFixed(1)} s`}`;
      log(`<span class="meta">cross-check ${esc(ENGINE_TITLES[e.engine] ?? e.engine)}, ${esc(e.brain === 'shipped' ? 'shipped' : 'new brain')}, ${esc(e.pack)}: ${what}</span>`);
      // The new brain's gate check fills the Cross-check card as it goes.
      state.gateRows = [...(state.gateRows ?? []), { ...e, type: 'result' }];
      if (state.crossJob?.state !== 'running') {
        $('cc-state').textContent = 'checking the new brain';
        renderCrossTable({ results: state.gateRows, packs: state.job.packs ?? [] });
      }
    }
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
  if (msg.state === 'done' && !msg.result?.summary) {
    // An outside trainer: its release, and how it fared in the cross-check.
    job.state = 'done';
    if (state.gateRows?.length && state.crossJob?.state !== 'running') $('cc-state').textContent = 'the new brain against the shipped one';
    const rel = msg.result?.release;
    log(rel ? `Trained: release <code>${esc(rel.id)}</code>. Send it to the headset from Releases once the cross-check looks right.` : 'Finished without a brain.', rel ? 'good' : 'bad');
  } else if (msg.state === 'done') {
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
  if (state.job?.trainer && state.job.trainer !== 'es') return drawOutsideChart(ctx, W, H);
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

/** An outside trainer (rsl_rl): mean reward and episode length per iteration, each on its own scale. */
function drawOutsideChart(ctx, W, H) {
  const job = state.job;
  const ms = (job.metrics ?? []).filter((m) => Number.isFinite(m.reward));
  const n = Math.max(job.of ?? 1, 1);
  const left = 44;
  const right = W - 44;
  const top = 34;
  const bottom = H - 30;
  const X = (i) => left + ((right - left) * i) / n;
  ctx.strokeStyle = 'rgba(255, 244, 220, 0.1)';
  ctx.lineWidth = 1;
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.moveTo(left, bottom - (bottom - top) * f);
    ctx.lineTo(right, bottom - (bottom - top) * f);
    ctx.stroke();
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.yellow;
  ctx.fillText('MEAN REWARD', left, 22);
  ctx.fillStyle = COLORS.mint;
  ctx.fillText('EPISODE LENGTH', left + 120, 22);
  const series = (key, color, width) => {
    const vals = ms.map((m) => m[key]).filter(Number.isFinite);
    if (!vals.length) return null;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const Y = (v) => bottom - ((bottom - top) * (v - lo)) / (hi - lo || 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ms.forEach((m, i) => (i ? ctx.lineTo(X(m.iteration), Y(m[key])) : ctx.moveTo(X(m.iteration), Y(m[key]))));
    ctx.stroke();
    return vals[vals.length - 1];
  };
  series('length', COLORS.mint, 2);
  const reward = series('reward', COLORS.yellow, 3);
  const last = ms[ms.length - 1];
  ctx.font = '18px DuckBebas, sans-serif';
  ctx.fillStyle = COLORS.dim;
  ctx.textAlign = 'center';
  const done = job.progress ?? last?.iteration ?? 0;
  ctx.fillText(
    ms.length ? `ITERATION ${done}/${n}  |  REWARD ${reward.toFixed(1)}  |  EPISODES ${Math.round(last.length)} STEPS` : job.state === 'running' ? 'STARTING THE TRAINER...' : 'TRAINING PROGRESS SHOWS HERE',
    W / 2,
    ms.length ? H - 8 : H / 2,
  );
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
        <div class="nums">${
          // An outside trainer reports no falls on the packs: its numbers are the cross-check's.
          r.fallRate === null || r.fallRate === undefined ? `${r.packs} pack(s) given to the trainer` : `falls <b${worse(r.fallRate, r.baselineFallRate)}>${pct(r.baselineFallRate)} to ${pct(r.fallRate)}</b> on ${r.packs} pack(s)`
        } | walk ${esc(r.walkHash)} from ${esc(r.baseHash)} | ${esc(ago(r.createdAt))}</div>
        <div class="nums">${esc(r.trainer)} | <code>${esc(r.id)}</code></div>${crossLine(r)}
        <div class="hub">${
          r.hubRepo
            ? `<span>On Hugging Face: <a href="https://huggingface.co/${esc(r.hubRepo)}" target="_blank" rel="noopener">${esc(r.hubRepo)}</a>, ready to flash to a real duck</span>`
            : '<span>Not on Hugging Face yet: a real duck downloads brains from there</span>'
        }<button class="btn btn-small" data-publish="${esc(r.id)}">${r.hubRepo ? 'Update' : 'Publish to Hugging Face'}</button></div>
      </div>`,
    )
    .join('');
  updateReplaySelect();
  renderCrossCheckChoices();
}

/** A class for a number that got worse than the shipped brain's (falls more): shown in berry, not mint. */
const worse = (now, before) => (now > before + 1e-9 ? ' class="worse"' : '');

/** A release's cross-check against the shipped brain, engine by engine. */
function crossLine(r) {
  if (!r.crossCheck?.length) return '';
  const engines = [...new Set(r.crossCheck.map((x) => x.engine))];
  const of = (brain, engine) => r.crossCheck.find((x) => x.engine === engine && x.brain === brain);
  // The brain it is checked against: the one that failed in the test case (the shipped one, or a release).
  const other = r.crossCheck.find((x) => x.brain !== r.id)?.brain ?? 'shipped';
  const parts = engines.map((e) => {
    const a = of(other, e);
    const b = of(r.id, e);
    if (!a || !b) return '';
    // A camera brain's drives in the test case's rebuilt room.
    if (b.tries) return `${e === 'app' ? 'In the app' : 'Isaac Lab rooms'}: reached the goal ${a.reached} to <b${b.reached < a.reached ? ' class="bad"' : ''}>${b.reached}</b> of ${b.tries}`;
    return `${esc(ENGINE_TITLES[e] ?? e)} ${pct(a.falls)} to <b${worse(b.falls, a.falls)}>${pct(b.falls)}</b> fell`;
  });
  return `<div class="nums">cross-check: ${parts.filter(Boolean).join(' | ')}</div>`;
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
    // "New packs too": a pack the headset just sent goes straight to Isaac Sim.
    const newest = state.packs.find((p) => fresh.has(p.id) && !p.error);
    if (newest && $('isaac-auto').checked) {
      isaac.asked = true;
      void selectPack(newest.id).then(() => runIsaac(newest.id));
    }
  });
  events.addEventListener('job', (e) => onJob(JSON.parse(e.data)));
  events.addEventListener('crosscheck', (e) => onCrossCheck(JSON.parse(e.data)));
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
  try {
    const t = await api('/api/trainers');
    state.trainers = t.trainers;
    state.engines = t.engines;
    renderTrainers();
    const cc = await api('/api/crosscheck');
    state.crossJob = cc.job;
    if (cc.job?.state === 'running') renderCrossTable({ brains: cc.job.brains, engines: cc.job.engines, packs: cc.job.packs, results: cc.job.rows });
    else if (cc.latest) renderCrossTable(cc.latest);
  } catch {
    // an older trainer engine: the fine-tune only
  }
  renderCrossCheckChoices();
  const running = s.jobs.find((j) => j.state === 'running');
  if (running) {
    state.job = { id: running.id, state: 'running', iterations: [], evals: [], metrics: [], of: running.options.iterations, trainer: running.trainer, packs: running.packs, progress: 0 };
    // Show the card as it was started: its trainer and settings.
    if ((state.trainers ?? []).some((t) => t.id === running.trainer)) {
      $('t-trainer').value = running.trainer;
      showTrainer();
      if (running.trainer !== 'es') {
        $('t-oname').value = running.options.name;
        $('t-envs').value = running.options.envs;
        $('t-oiterations').value = running.options.iterations;
      }
    }
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
