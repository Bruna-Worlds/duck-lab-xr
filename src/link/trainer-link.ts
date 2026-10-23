// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The trainer page's side of the headset link. Duck Lab XR's trainer page, opened
 * from the website on the player's computer (<site>/trainer/, or TRAINER on the
 * game's desktop page; tools/lab/ui/app.js loads this module there), says it
 * is open to the site's rendezvous, which gives it a
 * six-digit code; headsets on the same network list it and connect with a
 * WebRTC data channel. The page bridges that channel to the trainer engine
 * running on this computer (tools/lab/server.mjs, http://localhost:8790):
 * scenario packs from the headset go into its inbox, and the brain it offers
 * goes down to the headset.
 *
 * Kept free of IWSDK imports: the trainer page is a plain page.
 */
import {
  BRAIN_FILES,
  type BrainIndex,
  type FileHeader,
  LINK_APP,
  LINK_VERSION,
  type LinkMessage,
  persistentId,
  type SignalData,
} from './link-protocol.js';
import { type LinkState, PeerLink } from './peer-link.js';
import { PairingUnavailable, RendezvousClient } from './rendezvous-client.js';

const ANNOUNCE_MS = 15_000;
const INBOX_WAIT_MS = 15_000;

export interface TrainerLinkOptions {
  /** The rendezvous, absolute, ending with "/". */
  signal: string;
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
  link: PeerLink;
}

export class TrainerLink {
  readonly id = persistentId('ducklab.trainerId');
  readonly name = trainerName();
  code = '';
  /** One line for the page: how pairing goes. */
  status = 'Opening for headsets...';
  available = true;
  readonly headsets = new Map<string, HeadsetPeer>();
  /** Packs that came in while the engine was not running, kept until it is. */
  readonly held: { name: string; bytes: Uint8Array }[] = [];
  private brains: BrainIndex = { active: null, releases: [] };
  private trainerLine = '';
  private readonly rendezvous: RendezvousClient;
  private stopped = false;

  constructor(private readonly options: TrainerLinkOptions) {
    this.rendezvous = new RendezvousClient(options.signal);
  }

  start(): void {
    void this.announceLoop();
    void this.inboxLoop();
    // Closing the page takes it off the headsets' lists at once.
    window.addEventListener('pagehide', () => this.rendezvous.bye(this.id));
  }

  stop(): void {
    this.stopped = true;
    this.rendezvous.bye(this.id);
    for (const peer of this.headsets.values()) peer.link.close();
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

  private async announceLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const { code } = await this.rendezvous.announce(this.id, this.name);
        this.code = code;
        this.available = true;
        this.status = '';
      } catch (err) {
        this.available = !(err instanceof PairingUnavailable);
        this.status = this.available ? `Pairing: ${message(err)} (retrying)` : 'Pairing is not available on this site.';
      }
      this.changed();
      await sleep(this.available ? ANNOUNCE_MS : ANNOUNCE_MS * 4);
    }
  }

  private async inboxLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const messages = await this.rendezvous.inbox(this.id, INBOX_WAIT_MS);
        for (const m of messages) await this.onSignal(m.from, m.data);
      } catch {
        await sleep(this.available ? 2000 : ANNOUNCE_MS);
      }
    }
  }

  private async onSignal(from: string, data: SignalData): Promise<void> {
    if (data?.type !== 'offer' || data.role !== 'headset') return;
    this.headsets.get(from)?.link.close();
    let answer: { link: PeerLink; sdp: string };
    try {
      answer = await PeerLink.answer(data.sdp);
    } catch (err) {
      this.status = `A headset could not connect: ${message(err)}`;
      this.changed();
      return;
    }
    const { link, sdp } = answer;
    const peer: HeadsetPeer = { id: from, name: data.name || 'Headset', state: 'connecting', since: Date.now(), brain: null, packs: 0, link };
    this.headsets.set(from, peer);
    link.onState = (state) => {
      peer.state = state;
      if (state === 'open') {
        peer.since = Date.now();
        link.send({ t: 'hello', app: LINK_APP, v: LINK_VERSION, role: 'trainer', id: this.id, name: this.name });
        link.send({ t: 'brains', ...this.brains });
        if (this.trainerLine) link.send({ t: 'trainer', line: this.trainerLine });
      }
      if (state === 'closed' && this.headsets.get(from) === peer) {
        // Keep it listed as gone for a minute, then drop it.
        setTimeout(() => {
          if (this.headsets.get(from) === peer) {
            this.headsets.delete(from);
            this.changed();
          }
        }, 60_000);
      }
      this.changed();
    };
    link.onMessage = (msg) => this.onMessage(peer, msg);
    link.onFile = (header, bytes) => void this.onFile(peer, header, bytes);
    await this.rendezvous.send(from, this.id, { type: 'answer', sdp, name: this.name, nonce: data.nonce });
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
      const files = await Promise.all(
        BRAIN_FILES.map(async (name) => {
          const res = await fetch(`${this.options.engine}/api/releases/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`);
          if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        }),
      );
      peer.link.send({ t: 'brain-start', release, files: BRAIN_FILES });
      for (let i = 0; i < files.length; i++) await peer.link.sendFile({ kind: 'brain', name: BRAIN_FILES[i], release: id }, files[i]);
      peer.link.send({ t: 'brain-end', id });
    } catch (err) {
      peer.link.send({ t: 'brain-failed', id, error: message(err) });
    }
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
