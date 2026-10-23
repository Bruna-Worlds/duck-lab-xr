// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Player-made playgrounds: a list of pieces on a base level, saved in the
 * browser and shared as a link. A piece is a manifest asset at a stage-local
 * spot with its course component values; the id is a hash of the pieces, so
 * two players who open the same link race on the same board and their run
 * records compare. No DOM beyond storage, the clipboard and the address.
 */
export interface PieceSpec {
  asset: string;
  x: number;
  z: number;
  yaw?: number;
  y?: number;
  /** Course component values by component name (CourseCrumb: { points }, ...). */
  comp?: Record<string, Record<string, number>>;
}

export interface CustomPlayground {
  version: 'duckdash.custom.v1';
  id: string;
  title: string;
  par: number;
  /** Built-in level to load first (its room, sky and panels); the pieces go on its stage. */
  base: string;
  pieces: PieceSpec[];
  at: string;
}

const STORAGE_KEY = 'duckdash.custom.v1';
export const SHARE_PARAM = 'pg';

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The id for a set of pieces (position and values, rounded to the centimetre). */
export function customId(pieces: PieceSpec[], base: string): string {
  const canon = pieces.map((p) => [p.asset, round(p.x), round(p.z), round(p.yaw ?? 0), p.comp ?? {}]);
  return `custom-${fnv1a(`${base}|${JSON.stringify(canon)}`)}`;
}

const round = (v: number): number => Math.round(v * 100) / 100;

export function loadCustoms(): CustomPlayground[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as CustomPlayground[];
    return Array.isArray(list) ? list.filter((p) => p && p.version === 'duckdash.custom.v1' && Array.isArray(p.pieces)) : [];
  } catch {
    return [];
  }
}

export function saveCustom(playground: CustomPlayground): CustomPlayground[] {
  const list = loadCustoms().filter((p) => p.id !== playground.id);
  list.unshift(playground);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    // storage blocked: the playground lives for this visit only
  }
  return list;
}

export function deleteCustom(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(loadCustoms().filter((p) => p.id !== id)));
  } catch {
    // ignore
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, BufferSource>);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

/** The playground as a short code for a link: deflated JSON when the browser can, plain otherwise. */
export async function encodeShare(playground: CustomPlayground): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(playground));
  if (typeof CompressionStream === 'function') {
    try {
      return `z${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
    } catch {
      // fall through to plain
    }
  }
  return `j${toBase64Url(json)}`;
}

export async function decodeShare(code: string): Promise<CustomPlayground> {
  const kind = code[0];
  const bytes = fromBase64Url(code.slice(1));
  const json = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  const playground = JSON.parse(new TextDecoder().decode(json)) as CustomPlayground;
  if (playground.version !== 'duckdash.custom.v1' || !Array.isArray(playground.pieces)) {
    throw new Error('not a Duck Lab XR playground link');
  }
  playground.id = customId(playground.pieces, playground.base); // never trust the link's id
  return playground;
}

export function shareUrl(code: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(SHARE_PARAM, code);
  return url.href;
}
