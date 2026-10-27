// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * What the headset and Duck Lab XR's trainer page say to each other: in a
 * network's lobby while pairing (LobbyMessage), then over the link in the
 * trainer's own room (LinkMessage, plus files: a scenario pack, or one policy
 * of a trained brain, each sent whole with its FileHeader). See src/link/mesh.ts.
 *
 * Kept free of IWSDK and DOM-only imports: the trainer page loads it too.
 */
import { POLICY_FILES } from '../duck/duck-constants.js';

export const LINK_APP = 'duck-lab';
export const LINK_VERSION = 2;
/** Largest file either side accepts. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** The files of a trained brain, in the order they are sent. */
export const BRAIN_FILES: string[] = Object.values(POLICY_FILES);

export type LinkRole = 'headset' | 'trainer';

/** A trained brain as the trainer lists it (the duckdash.policies.v1 release shape). */
export interface BrainRelease {
  id: string;
  name: string;
  createdAt: string;
  trainer: string;
  baseHash: string;
  walkHash: string;
  packs: number;
  fallRate: number | null;
  baselineFallRate: number | null;
  note?: string;
  /** The public Hub repo it was published to (what a real duck downloads), if any. */
  hubRepo?: string | null;
  /** The trainer page's cross-check: each brain's falls on the packs, per physics engine. */
  crossCheck?: { brain: string; engine: string; falls: number; walkedM?: number }[] | null;
}

export interface BrainIndex {
  active: string | null;
  releases: BrainRelease[];
}

export interface FileHeader {
  kind: 'pack' | 'brain';
  name: string;
  /** For brain files: the release they belong to. */
  release?: string;
}

export type LinkMessage =
  | { t: 'hello'; app: string; v: number; role: LinkRole; id: string; name: string }
  /** Headset: which brain it runs now (null: the shipped one). */
  | { t: 'status'; brain: string | null; playground?: string }
  /** Trainer: a pack arrived and was saved (or could not be). */
  | { t: 'pack-saved'; name: string; file: string }
  | { t: 'pack-failed'; name: string; error: string }
  /** Trainer: its brains and which one it offers the headset. */
  | ({ t: 'brains' } & BrainIndex)
  /** Headset: send me this brain's files. */
  | { t: 'want-brain'; id: string }
  | { t: 'brain-start'; release: BrainRelease; files: string[] }
  | { t: 'brain-end'; id: string }
  | { t: 'brain-failed'; id: string; error: string }
  /** Trainer: what it is doing, one line ("Training room-tuned: iteration 4 of 30"). */
  | { t: 'trainer'; line: string };

/**
 * In a network's lobby: a trainer page says it is open (with the code its
 * page shows); a headset asks it to pair; the trainer answers with its room,
 * a secret only the headsets it paired with know.
 */
export type LobbyMessage =
  | { t: 'lab'; v: number; lab: string; name: string; code: string }
  | { t: 'pair'; v: number; id: string; name: string }
  | { t: 'welcome'; v: number; lab: string; name: string; room: string };

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM = /^[0-9a-f]{32}$/;
const CODE = /^\d{6}$/;
const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80;

/** Could this, which came from a stranger in the lobby, be a message we send? */
export function isLobbyMessage(data: unknown): data is LobbyMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.v !== LINK_VERSION) return false;
  switch (m.t) {
    case 'lab':
      return typeof m.lab === 'string' && ID.test(m.lab) && isName(m.name) && typeof m.code === 'string' && CODE.test(m.code);
    case 'pair':
      return typeof m.id === 'string' && ID.test(m.id) && isName(m.name);
    case 'welcome':
      return typeof m.lab === 'string' && ID.test(m.lab) && isName(m.name) && isRoom(m.room);
    default:
      return false;
  }
}

/** Is this a trainer's room secret (32 hex digits)? */
export const isRoom = (value: unknown): value is string => typeof value === 'string' && ROOM.test(value);

/** A fresh room secret. */
export function freshRoom(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh six-digit pairing code. */
export function freshCode(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
}

/** A random id for this device or page, kept in local storage. */
export function persistentId(key: string): string {
  try {
    const known = localStorage.getItem(key);
    if (known && /^[A-Za-z0-9_-]{8,64}$/.test(known)) return known;
  } catch {
    // storage blocked: a fresh id per load
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem(key, id);
  } catch {
    // storage blocked
  }
  return id;
}

/** "482 913": a pairing code as people read it. */
export const spacedCode = (code: string): string => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
