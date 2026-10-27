// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainer page's side of the headset link. Duck Lab XR's trainer page, opened
 * from the website on the player's computer (<site>/trainer/, or TRAINER on the
 * game's desktop page; tools/lab/ui/app.js loads this module there), says it is
 * open in its network's lobby with a six-digit code; a headset on the same
 * network lists it, and pairing gives the headset this page's room. The link
 * runs in that room over WebRTC (src/link/mesh.ts: no server of ours).
 *
 * The page bridges the link to the trainer engine running on this computer
 * (tools/lab/server.mjs, http://localhost:8790): scenario packs from the
 * headset go into its inbox, and the brain it offers goes down to the headset.
 *
 * Kept free of IWSDK imports: the trainer page is a plain page.
 */
import {
  BRAIN_FILES,
  type BrainIndex,
  type FileHeader,
  freshCode,
  freshRoom,
  isRoom,
  LINK_APP,
  LINK_VERSION,
  type LinkMessage,
  type LobbyMessage,
  persistentId,
} from './link-protocol.js';
import { type LinkState, LinkRoom, Lobby, networkKeys, type RoomLink } from './mesh.js';

const ROOM_KEY = 'ducklab.trainerRoom';
/** Say again that this page is open, for headsets that missed it. */
const ANNOUNCE_MS = 15_000;
/** Try pairing again this long after it could not start (offline, say). */
const RETRY_MS = 30_000;

export interface TrainerLinkOptions {
  /** The trainer engine's base URL ("" when this page is served by it). */
  engine: string;
  /** Called whenever something the page shows changed. */
  onChange?: () => void;
}

export interface HeadsetPeer {
  id: string;
  name: string;
  state: LinkState;
  since: number;
  /** The brain the headset runs (null: shipped). */
  brain: string | null;
  packs: number;
  link: RoomLink;
}

export class TrainerLink {
  readonly id = persistentId('ducklab.trainerId');
  readonly name = trainerName();
  /** What headsets list this page by (a new one each visit). */
  readonly code = freshCode();
  /** One line for the page: how pairing goes. */
  status = 'Opening for headsets...';
  available = true;
  /** By device id: a headset that reconnects keeps its entry. */
  readonly headsets = new Map<string, HeadsetPeer>();
  /** Packs that came in while the engine was not running, kept until it is. */
  readonly held: { name: string; bytes: Uint8Array }[] = [];
  /** This page's room: the secret paired headsets know (kept, so they reconnect). */
  private readonly room = trainerRoom();
  private brains: BrainIndex = { active: null, releases: [] };
  private trainerLine = '';
  private linkRoom: LinkRoom | null = null;
  private lobby: Lobby | null = null;
  private announcer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly options: TrainerLinkOptions) {}

  start(): void {
    void this.open();
    window.addEventListener('pagehide', () => this.stop());
  }

  stop(): void {
    this.stopped = true;
    if (this.announcer) clearInterval(this.announcer);
    this.announcer = null;
    void this.lobby?.leave();
    void this.linkRoom?.leave();
    this.lobby = null;
    this.linkRoom = null;
  }

  get connected(): HeadsetPeer[] {
    return [...this.headsets.values()].filter((peer) => peer.state === 'open');
  }

  /** The engine's releases changed: tell the headsets (they fetch a new active brain). */
  setBrains(index: BrainIndex): void {
    this.brains = { active: index.active ?? null, releases: index.releases ?? [] };
    for (const peer of this.connected) peer.link.send({ t: 'brains', ...this.brains });
  }

  /** One line about training for the headsets' menus. */
  setTrainerLine(line: string): void {
    if (line === this.trainerLine) return;
    this.trainerLine = line;
    for (const peer of this.connected) peer.link.send({ t: 'trainer', line });
  }

  /** Posts packs held while the engine was down; true when none are left. */
  async flushHeld(): Promise<boolean> {
    while (this.held.length) {
      const pack = this.held[0];
      try {
        await this.saveToEngine(pack.bytes);
      } catch {
        return false;
      }
      this.held.shift();
      this.changed();
    }
    return true;
  }

  private changed(): void {
    this.options.onChange?.();
  }

  /** Joins this page's room (paired headsets come back there) and its network's lobby. */
  private async open(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.linkRoom) {
          const linkRoom = await LinkRoom.join(this.room);
          linkRoom.onPeer = (link) => this.welcome(link);
          this.linkRoom = linkRoom;
        }
        const keys = await networkKeys();
        if (!keys.length) throw new Error('could not tell which network this computer is on (no answer from a STUN server)');
        const lobby = await Lobby.join(keys);
        lobby.onPeerJoin = (peerId) => lobby.send(this.announcement(), peerId);
        lobby.onMessage = (message, peerId) => this.onLobby(message, peerId);
        this.lobby = lobby;
        lobby.send(this.announcement());
        this.announcer = setInterval(() => this.lobby?.send(this.announcement()), ANNOUNCE_MS);
        this.available = true;
        this.status = '';
        this.changed();
        return;
      } catch (err) {
        this.available = false;
        this.status = `Pairing is not available: ${message(err)}. Retrying.`;
        this.changed();
        await sleep(RETRY_MS);
      }
    }
  }

  private announcement(): LobbyMessage {
    return { t: 'lab', v: LINK_VERSION, lab: this.id, name: this.name, code: this.code };
  }

  /** A headset asks to pair (it picked this page's code): it gets this page's room. */
  private onLobby(message: LobbyMessage, peerId: string): void {
    if (message.t !== 'pair') return;
    this.lobby?.send({ t: 'welcome', v: LINK_VERSION, lab: this.id, name: this.name, room: this.room }, peerId);
  }

  /** Somebody joined this page's room: say who we are; a headset says so back. */
  private welcome(link: RoomLink): void {
    link.onMessage = (msg) => {
      if (msg.t !== 'hello' || msg.role !== 'headset' || msg.app !== LINK_APP) return;
      this.adopt(link, msg.id, msg.name);
    };
    link.send({ t: 'hello', app: LINK_APP, v: LINK_VERSION, role: 'trainer', id: this.id, name: this.name });
  }

  /** A paired headset is here: it is listed, and gets the brains on offer. */
  private adopt(link: RoomLink, id: string, name: string): void {
    const before = this.headsets.get(id);
    if (before && before.link !== link) before.link.close();
    const peer: HeadsetPeer = { id, name: name || 'Headset', state: 'open', since: Date.now(), brain: null, packs: before?.packs ?? 0, link };
    this.headsets.set(id, peer);
    link.onState = (state) => {
      peer.state = state;
      if (state === 'closed' && this.headsets.get(id) === peer) {
        // Keep it listed as gone for a minute, then drop it.
        setTimeout(() => {
          if (this.headsets.get(id) === peer) {
            this.headsets.delete(id);
            this.changed();
          }
        }, 60_000);
      }
      this.changed();
    };
    link.onMessage = (msg) => this.onMessage(peer, msg);
    link.onFile = (header, bytes) => void this.onFile(peer, header, bytes);
    link.send({ t: 'brains', ...this.brains });
    if (this.trainerLine) link.send({ t: 'trainer', line: this.trainerLine });
    this.changed();
  }

  private onMessage(peer: HeadsetPeer, msg: LinkMessage): void {
    if (msg.t === 'hello') {
      peer.name = msg.name || peer.name;
    } else if (msg.t === 'status') {
      peer.brain = msg.brain;
    } else if (msg.t === 'want-brain') {
      void this.sendBrain(peer, msg.id);
    }
    this.changed();
  }

  private async onFile(peer: HeadsetPeer, header: FileHeader, bytes: Uint8Array): Promise<void> {
    if (header.kind !== 'pack') return;
    peer.packs++;
    try {
      const file = await this.saveToEngine(bytes);
      peer.link.send({ t: 'pack-saved', name: header.name, file });
    } catch (err) {
      this.held.push({ name: header.name, bytes });
      peer.link.send({ t: 'pack-saved', name: header.name, file: `held on the trainer page (${message(err)})` });
    }
    this.changed();
  }

  private async saveToEngine(bytes: Uint8Array): Promise<string> {
    const res = await fetch(`${this.options.engine}/api/inbox`, { method: 'POST', body: bytes as BlobPart });
    const data = (await res.json()) as { file?: string; error?: string };
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data.file ?? 'inbox';
  }

  private async sendBrain(peer: HeadsetPeer, id: string): Promise<void> {
    const release = this.brains.releases.find((r) => r.id === id);
    if (!release) {
      peer.link.send({ t: 'brain-failed', id, error: 'the trainer has no such brain' });
      return;
    }
    try {
      // A camera brain release carries its navigation brain too.
      const names = release.brains?.includes('nav-camera') ? [...BRAIN_FILES, 'nav-camera.onnx', 'nav-camera.json'] : BRAIN_FILES;
      const files = await Promise.all(
        names.map(async (name) => {
          const res = await fetch(`${this.options.engine}/api/releases/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`);
          if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        }),
      );
      peer.link.send({ t: 'brain-start', release, files: names });
      for (let i = 0; i < files.length; i++) await peer.link.sendFile({ kind: 'brain', name: names[i], release: id }, files[i]);
      peer.link.send({ t: 'brain-end', id });
    } catch (err) {
      peer.link.send({ t: 'brain-failed', id, error: message(err) });
    }
  }
}

/** This browser's trainer room, kept so that paired headsets find it again. */
function trainerRoom(): string {
  try {
    const known = localStorage.getItem(ROOM_KEY);
    if (isRoom(known)) return known;
    const room = freshRoom();
    localStorage.setItem(ROOM_KEY, room);
    return room;
  } catch {
    return freshRoom(); // storage blocked: headsets pair again next visit
  }
}

/** "Duck Lab XR on Windows": what headsets list. */
function trainerName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const ua = navigator.userAgent;
  const platform =
    nav.userAgentData?.platform ||
    (/Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '');
  const pretty = platform === 'macOS' ? 'Mac' : platform === 'Chrome OS' ? 'Chromebook' : platform;
  return pretty ? `Duck Lab XR on ${pretty}` : 'Duck Lab XR';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
