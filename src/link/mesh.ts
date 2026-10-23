// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How the headset and Duck Lab XR's trainer page find each other and talk, with
 * no server of ours. Trystero (MIT) carries the WebRTC handshake over public
 * Nostr relays: they see a few bytes of signalling (encrypted in a room with a
 * secret) and nothing else. After that, messages and files go straight between
 * the two devices over a WebRTC data channel on the home network.
 *
 * Two kinds of trystero room:
 * - a lobby per home network (networkKeys): trainer pages say they are open
 *   there, and a headset asks one of them to pair;
 * - a trainer's own room, named after a secret that only the headsets it
 *   paired with know (LinkRoom): the link itself. A paired headset joins it on
 *   every visit, which is how it reconnects by itself.
 *
 * Kept free of IWSDK imports: the trainer page loads it too. Trystero is
 * loaded on demand, the first time pairing is needed.
 */
import type { JsonValue, MessageAction, Room } from 'trystero';
import { type FileHeader, isLobbyMessage, type LinkMessage, type LobbyMessage, MAX_FILE_BYTES } from './link-protocol.js';

/** One app on the relays; bumped with the messages (link-protocol.ts LINK_VERSION). */
export const MESH_APP = 'duck-lab-xr-v2';
/** Public STUN only: two devices on one network connect directly, no TURN relay. */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }],
};
/**
 * Nostr relays for the handshake: trystero's own defaults that answered on
 * 2026-10-23 (some of its 28 no longer exist, and the browser logs every failed
 * connection). Both sides use this list, so they meet on the same relays.
 */
const RELAYS = [
  'wss://nos.lol',
  'wss://bucket.coracle.social',
  'wss://purplerelay.com',
  'wss://nostr-relay.corb.net',
  'wss://basspistol.org',
  'wss://nostr.islandarea.net',
  'wss://nostr-01.uid.ovh',
  'wss://relay-can.zombi.cloudrodion.com',
];
/** How long to wait for a STUN server to say where this network is. */
const STUN_MS = 5000;

type Trystero = typeof import('trystero');
let trystero: Promise<Trystero> | null = null;

/** Joins a trystero room. A secret also encrypts the handshake on the relays. */
export async function joinMesh(roomId: string, secret?: string): Promise<Room> {
  trystero ??= import('trystero');
  const { joinRoom } = await trystero.catch((err: unknown) => {
    trystero = null; // try again next time (offline, say)
    throw err;
  });
  return joinRoom({ appId: MESH_APP, rtcConfig: RTC_CONFIG, relayConfig: { urls: RELAYS }, ...(secret ? { password: secret } : {}) }, roomId);
}

// --- Which network ---------------------------------------------------------------

/**
 * The lobby rooms for the network this device is on: a hash of the home's
 * public address as a STUN server sees it. A headset and a computer behind the
 * same router share the same IPv4 address, or the same IPv6 /64 prefix, so they
 * meet in the same lobby; devices elsewhere never do. Empty when no STUN server
 * answered (offline, or a network that blocks it).
 */
export async function networkKeys(timeoutMs = STUN_MS): Promise<string[]> {
  const found = new Set<string>();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  try {
    pc.createDataChannel('probe');
    const gathered = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.addEventListener('icecandidate', (event) => {
        if (!event.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const network = publicNetwork(event.candidate);
        if (network) found.add(network);
      });
    });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered;
  } finally {
    pc.close();
  }
  return Promise.all([...found].sort().map(async (network) => `net-${await shortHash(network)}`));
}

/** "ipv4:203.0.113.5" or "ipv6:2001:db8:85a3:8d3" from a server-reflexive candidate. */
function publicNetwork(candidate: RTCIceCandidate): string | null {
  if (candidate.type !== 'srflx') return null;
  const address = candidate.address || candidate.candidate.split(' ')[4] || '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return `ipv4:${address}`;
  const groups = ipv6Groups(address);
  return groups ? `ipv6:${groups.slice(0, 4).join(':')}` : null;
}

/** The eight groups of an IPv6 address, written out ("::" expanded), or null. */
function ipv6Groups(address: string): string[] | null {
  const clean = address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!/^[0-9a-f:]+$/.test(clean) || !clean.includes(':')) return null;
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array<string>(missing).fill('0'), ...tail].map((group) => group.replace(/^0+(?=.)/, ''));
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${MESH_APP}|${text}`));
  return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

// --- The lobby -------------------------------------------------------------------

/** The lobby rooms of this network (one per key): pairing messages, to one peer or to all. */
export class Lobby {
  onMessage: ((message: LobbyMessage, peerId: string) => void) | null = null;
  onPeerJoin: ((peerId: string) => void) | null = null;
  onPeerLeave: ((peerId: string) => void) | null = null;
  /** In how many of the rooms each peer is (a peer can be in the IPv4 and the IPv6 lobby). */
  private readonly seen = new Map<string, number>();

  private constructor(private readonly rooms: { room: Room; action: MessageAction<JsonValue> }[]) {
    for (const { room, action } of rooms) {
      action.onMessage = (data, { peerId }) => {
        if (isLobbyMessage(data)) this.onMessage?.(data, peerId);
      };
      room.onPeerJoin = (peerId) => {
        const count = (this.seen.get(peerId) ?? 0) + 1;
        this.seen.set(peerId, count);
        if (count === 1) this.onPeerJoin?.(peerId);
      };
      room.onPeerLeave = (peerId) => {
        const count = (this.seen.get(peerId) ?? 1) - 1;
        if (count > 0) {
          this.seen.set(peerId, count);
          return;
        }
        this.seen.delete(peerId);
        this.onPeerLeave?.(peerId);
      };
    }
  }

  static async join(keys: string[]): Promise<Lobby> {
    const rooms = await Promise.all(
      keys.map(async (key) => {
        const room = await joinMesh(key);
        return { room, action: room.makeAction<JsonValue>('lobby') };
      }),
    );
    return new Lobby(rooms);
  }

  /** To one peer (in whichever lobby it is) or, without one, to everybody. */
  send(message: LobbyMessage, peerId?: string): void {
    for (const { room, action } of this.rooms) {
      if (peerId && !(peerId in room.getPeers())) continue;
      void action.send(message, peerId ? { target: peerId } : undefined).catch(() => undefined);
      if (peerId) return;
    }
  }

  async leave(): Promise<void> {
    this.seen.clear();
    await Promise.all(this.rooms.map(({ room }) => room.leave().catch(() => undefined)));
  }
}

// --- A trainer's room: the link ------------------------------------------------------

export type LinkState = 'open' | 'closed';

/**
 * A trainer's own room (`link-<secret>`): the trainer page and the headsets it
 * paired with. Every peer in it gets a RoomLink; messages and files go to one
 * peer at a time.
 */
export class LinkRoom {
  /** A peer arrived (a headset, or the trainer): its link, open already. */
  onPeer: ((link: RoomLink) => void) | null = null;
  private readonly links = new Map<string, RoomLink>();

  private constructor(
    private readonly room: Room,
    private readonly msg: MessageAction<JsonValue>,
    private readonly file: MessageAction<ArrayBuffer>,
  ) {
    msg.onMessage = (data, { peerId }) => this.links.get(peerId)?.receive(data);
    file.onMessage = (data, { peerId, metadata }) => this.links.get(peerId)?.receiveFile(data, metadata);
    room.onPeerJoin = (peerId) => {
      this.links.get(peerId)?.setState('closed');
      const link = new RoomLink(peerId, msg, file);
      this.links.set(peerId, link);
      this.onPeer?.(link);
    };
    room.onPeerLeave = (peerId) => {
      const link = this.links.get(peerId);
      this.links.delete(peerId);
      link?.setState('closed');
    };
  }

  static async join(secret: string): Promise<LinkRoom> {
    const room = await joinMesh(`link-${secret}`, secret);
    return new LinkRoom(room, room.makeAction<JsonValue>('msg'), room.makeAction<ArrayBuffer>('file'));
  }

  async leave(): Promise<void> {
    for (const link of this.links.values()) link.setState('closed');
    this.links.clear();
    await this.room.leave().catch(() => undefined);
  }
}

/** One peer in a LinkRoom: JSON messages, and files sent whole with their header. */
export class RoomLink {
  state: LinkState = 'open';
  onMessage: ((message: LinkMessage) => void) | null = null;
  onFile: ((header: FileHeader, bytes: Uint8Array) => void) | null = null;
  onState: ((state: LinkState) => void) | null = null;
  private sending: Promise<void> = Promise.resolve();

  constructor(
    readonly peerId: string,
    private readonly msg: MessageAction<JsonValue>,
    private readonly file: MessageAction<ArrayBuffer>,
  ) {}

  get open(): boolean {
    return this.state === 'open';
  }

  send(message: LinkMessage): boolean {
    if (!this.open) return false;
    void this.msg.send(message as unknown as JsonValue, { target: this.peerId }).catch(() => undefined);
    return true;
  }

  /** Sends a file; files go one after another, each whole. */
  sendFile(header: FileHeader, bytes: Uint8Array): Promise<void> {
    const job = this.sending.then(async () => {
      if (!this.open) throw new Error('not connected');
      const metadata: JsonValue = header.release ? { kind: header.kind, name: header.name, release: header.release } : { kind: header.kind, name: header.name };
      await this.file.send(bytes.slice().buffer, { target: this.peerId, metadata });
    });
    this.sending = job.catch(() => undefined);
    return job;
  }

  /** Stops using this link (the room stays: the peer may come back). */
  close(): void {
    this.setState('closed');
  }

  setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed') return;
    this.state = state;
    this.onState?.(state);
  }

  receive(data: unknown): void {
    if (this.open && typeof data === 'object' && data !== null && typeof (data as { t?: unknown }).t === 'string') {
      this.onMessage?.(data as LinkMessage);
    }
  }

  receiveFile(data: ArrayBuffer | ArrayBufferView, metadata: JsonValue | undefined): void {
    if (!this.open || typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return;
    const { kind, name, release } = metadata as Record<string, unknown>;
    if ((kind !== 'pack' && kind !== 'brain') || typeof name !== 'string') return;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength > MAX_FILE_BYTES) return;
    this.onFile?.({ kind, name, ...(typeof release === 'string' ? { release } : {}) }, bytes);
  }
}
