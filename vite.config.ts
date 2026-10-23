/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * Copyright 2026 BRUNA GOODS LLC
 *
 * Begun from the IWSDK starter template, licensed under the MIT license found
 * in LICENSES/MIT-IWSDK.txt. BRUNA GOODS LLC's changes are licensed under the
 * Apache License 2.0 (LICENSE).
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig, normalizePath, type Plugin } from 'vite';

/**
 * Dev only. Two inboxes the app posts to, so a headset run leaves files on
 * the PC: scenario packs (src/training/scenario-system.ts) land in
 * artifacts/scenarios/ (replay with `node tools/train/replay.mjs <file>`),
 * and the lab panel's telemetry (src/dev/telemetry-system.ts, with ?lab)
 * lands in artifacts/telemetry/<name>.json plus a .jsonl history.
 */
function duckInbox(): Plugin {
  const readBody = (req: import('node:http').IncomingMessage): Promise<Buffer> =>
    new Promise((done) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => done(Buffer.concat(chunks)));
    });
  const safeName = (url: URL, fallback: string): string =>
    (url.searchParams.get('name') ?? fallback).replace(/[^A-Za-z0-9_-]/g, '_');
  return {
    name: 'duck-inbox',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__duck/scenarios', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        void readBody(req).then((body) => {
          const name = safeName(new URL(req.url ?? '', 'http://localhost'), `scenario-${Date.now()}`);
          const dir = resolve(server.config.root, 'artifacts/scenarios');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${name}.scenario.json`), body);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ file: `artifacts/scenarios/${name}.scenario.json` }));
        });
      });
      server.middlewares.use('/__duck/datasets', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        void readBody(req).then((body) => {
          const name = safeName(new URL(req.url ?? '', 'http://localhost'), `dataset-${Date.now()}`);
          const dir = resolve(server.config.root, 'artifacts/datasets');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${name}.dataset.json`), body);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ file: `artifacts/datasets/${name}.dataset.json` }));
        });
      });
      server.middlewares.use('/__duck/telemetry', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        void readBody(req).then((body) => {
          const name = safeName(new URL(req.url ?? '', 'http://localhost'), 'browser');
          const dir = resolve(server.config.root, 'artifacts/telemetry');
          mkdirSync(dir, { recursive: true });
          writeFileSync(resolve(dir, `${name}.json`), body);
          appendFileSync(resolve(dir, `${name}.jsonl`), body.toString('utf8').replace(/\s*\n\s*/g, ' ') + '\n');
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

/**
 * The trainer page as the website serves it (<site>/trainer/): the trainer
 * engine's own page (tools/lab/ui), told where things are. It talks to the
 * engine on the player's computer (npm run lab, http://localhost:8790) and
 * pairs with headsets (src/link/trainer-link.ts, over WebRTC: no server of
 * ours). Plain HTML: the page must not get the headset emulator the app's
 * index.html gets in development.
 */
function trainerPageHtml(root: string, site: Record<string, unknown>): string {
  return readFileSync(resolve(root, 'tools/lab/ui/index.html'), 'utf8')
    .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '')
    .replace('href="style.css"', 'href="/tools/lab/ui/style.css"')
    .replace(
      '<script type="module" src="app.js"></script>',
      `<script>window.DUCK_LAB_SITE = ${JSON.stringify(site)};</script>
    <script type="module" src="/tools/lab/ui/app.js"></script>`,
    );
}

/**
 * Production builds: the trainer page goes in as dist/trainer/index.html (a
 * second entry, made from tools/lab/ui/index.html when the build asks for it).
 * The website cannot start the engine; the page says how (npm run lab).
 */
function trainerPage(): Plugin {
  let root = process.cwd();
  const entry = () => normalizePath(resolve(root, 'trainer/index.html'));
  return {
    name: 'duck-lab-trainer-page',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    resolveId(source) {
      return normalizePath(resolve(root, source)) === entry() ? entry() : null;
    },
    load(id) {
      if (normalizePath(id) !== entry()) return null;
      return trainerPageHtml(root, { engine: 'http://localhost:8790', duck: '../asset-packs/pollen-microduck/', start: null, headsetHost: null });
    },
  };
}

/**
 * Dev only, the website half of Duck Lab XR's trainer:
 * - /trainer/: the trainer page (trainerPageHtml), so the headset and the
 *   computer open the same site. On a desktop the game shows it in a frame
 *   (src/ui/view-switch-system.ts). /lab/ (its first address) redirects here.
 * - POST /__duck/trainer/start: the trainer page's one-click "Start the
 *   trainer" when the engine is not running. Only for browsers on this PC;
 *   on Windows the engine opens in its own window (close it to stop it).
 *   A hosted site cannot start programs: there a small installed helper will.
 */
function duckLabSite(): Plugin {
  const site = { engine: 'http://localhost:8790', duck: '/asset-packs/pollen-microduck/', start: '/__duck/trainer/start' };
  /** Whether a request comes from a browser on this PC (loopback or one of its own addresses). */
  const fromThisComputer = (address: string | undefined): boolean => {
    const ip = (address ?? '').replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1') return true;
    return Object.values(networkInterfaces()).some((list) => list?.some((entry) => entry.address === ip));
  };
  const engineRunning = (): Promise<boolean> =>
    fetch('http://127.0.0.1:8790/api/state', { signal: AbortSignal.timeout(1500) }).then(
      (res) => res.ok,
      () => false,
    );
  return {
    name: 'duck-lab-site',
    apply: 'serve',
    configureServer(server) {
      let starting = 0;
      server.middlewares.use('/__duck/trainer/start', (req, res) => {
        if (req.method !== 'POST' || !fromThisComputer(req.socket.remoteAddress)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        void engineRunning().then((running) => {
          const now = Date.now();
          if (!running && now - starting > 15000) {
            starting = now;
            const root = server.config.root;
            if (process.platform === 'win32') {
              const node = `"${process.execPath}"`;
              spawn('cmd.exe', ['/c', 'start', '"Duck Lab XR trainer"', node, 'tools/lab/server.mjs'], { cwd: root, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
            } else {
              spawn(process.execPath, ['tools/lab/server.mjs'], { cwd: root, detached: true, stdio: 'ignore' }).unref();
            }
          }
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify({ running, starting: !running }));
        });
      });
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/trainer' || path === '/lab' || path === '/lab/') {
          res.statusCode = 302;
          res.setHeader('location', '/trainer/');
          res.end();
          return;
        }
        if (path !== '/trainer/' && path !== '/trainer/index.html') {
          next();
          return;
        }
        // What the headset types: this PC's address on the home network (the page itself may be on localhost).
        const lan = Object.values(networkInterfaces())
          .flatMap((list) => list ?? [])
          .filter((entry) => (entry.family === 'IPv4' || (entry.family as unknown) === 4) && !entry.internal)
          .map((entry) => entry.address)
          .sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')))[0];
        const pageSite = { ...site, headsetHost: lan ? `${lan}:${server.config.server.port ?? 8081}` : null };
        const html = trainerPageHtml(server.config.root, pageSite);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(html);
      });
    },
  };
}

// public/models/dev-only holds files we may not redistribute (see
// public/models/README.md), and public/policies/incoming holds policies
// trained on this PC from the player's own room (Duck Lab XR, tools/train):
// production builds delete their copies of both.
function dropDevOnlyModels(): Plugin {
  let outDir = 'dist';
  return {
    name: 'drop-dev-only-models',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      rmSync(resolve(outDir, 'models/dev-only'), { recursive: true, force: true });
      rmSync(resolve(outDir, 'policies/incoming'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [iwsdkDev(), dropDevOnlyModels(), duckInbox(), duckLabSite(), trainerPage()],
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    // The game, and the trainer page (made by trainerPage() above).
    rollupOptions: { input: { main: './index.html', trainer: './trainer/index.html' } },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (three@0.185 vs app super-three@0.181). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  // The duck sim worker imports MuJoCo and onnxruntime-web as ES modules.
  worker: { format: 'es' },
  optimizeDeps: {
    // Both ship ready-made ESM plus a .wasm loaded through ?url imports.
    exclude: ['@babylonjs/havok', '@mujoco/mujoco', 'onnxruntime-web'],
    include: [
      'three',
      'trystero',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
