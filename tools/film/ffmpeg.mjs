// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Where ffmpeg is, for the film and recording tools:
 *   1. FFMPEG, when set;
 *   2. ffmpeg-static installed in this repo (`npm install --no-save ffmpeg-static`);
 *   3. ffmpeg-static in a project next to this one (any <dir>/<sub>/node_modules
 *      two folders above this repo, for machines that keep it in another project);
 *   4. "ffmpeg" on the PATH.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINARY = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const MAX_ENTRIES = 300; // do not crawl a big folder (a home directory, say)

const staticIn = (dir) => join(dir, 'node_modules', 'ffmpeg-static', BINARY);
const folders = (dir) => {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    return entries.length > MAX_ENTRIES ? [] : entries.map((e) => join(dir, e.name));
  } catch {
    return [];
  }
};

export function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  if (existsSync(staticIn(ROOT))) return staticIn(ROOT);
  for (const project of folders(resolve(ROOT, '..', '..'))) {
    for (const sub of folders(project)) {
      if (existsSync(staticIn(sub))) return staticIn(sub);
    }
  }
  return 'ffmpeg';
}
