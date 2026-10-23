// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The headset's link to Duck Lab XR's trainer on the player's computer (menu:
 * TRAINER ON YOUR COMPUTER).
 *
 * Both devices open the same website. The trainer (TRAINER on the computer)
 * says it is open in its network's lobby and shows a six-digit code; the
 * headset, in the same lobby, lists the trainers on its network, and the
 * player picks the one with the code their computer shows. Pairing gives the
 * headset that trainer's room, and the link runs there over WebRTC, straight
 * between the two devices: scenario packs go up and trained brains come down
 * over the home network. No server of ours is involved (src/link/mesh.ts).
 * The pairing is remembered: the headset joins the trainer's room on every
 * visit, so it reconnects by itself whenever that trainer page is open.
 *
 * On a desktop the trainer is one click away in the same page (PLAY | TRAINER,
 * src/ui/view-switch-system.ts): the section offers OPEN TRAINER instead.
 *
 * See src/link/trainer-link.ts for the page's side.
 */
import { createSystem, type UIKit, UIKitMLAsset } from '@iwsdk/core';
import { DuckSystem } from '../duck/duck-system.js';
import { PolicyInboxSystem } from '../training/policy-inbox-system.js';
import { hostUserAgent } from '../ui/page-mode.js';
import { ViewSwitchSystem } from '../ui/view-switch-system.js';
import {
  type BrainRelease,
  type FileHeader,
  isRoom,
  LINK_APP,
  LINK_VERSION,
  type LinkMessage,
  type LobbyMessage,
  persistentId,
  spacedCode,
} from './link-protocol.js';
import { LinkRoom, Lobby, networkKeys, type RoomLink } from './mesh.js';

const MENU_NODE = 'menu-panel';
const PAIRED_KEY = 'ducklab.pairedTrainer';
/** A trainer not heard from for this long is off the list (they say so every 15 s). */
const HEARD_MS = 40_000;
/** Try the lobby or the trainer's room again this long after it could not open. */
const RETRY_MS = 30_000;
const ANSWER_MS = 15_000;
const OPEN_MS = 20_000;
const PACK_ACK_MS = 30_000;
const MAX_KEPT_PACKS = 8;
const REFRESH_MS = 250;
const LAB_BUTTONS = ['lab-0', 'lab-1', 'lab-2'];
const YELLOW = '#ffcf3f';
const INK = '#0f1020';
const CREAM = '#fff4dc';
const MINT = '#3de0b8';
const IDLE_BG = 'rgba(255, 244, 220, 0.08)';
const IDLE_BORDER = 'rgba(255, 244, 220, 0.25)';

type Text = UIKit.Text;
export type LinkPhase = 'unavailable' | 'looking' | 'connecting' | 'connected';

/** A trainer page open on this network, as the menu lists it. */
export interface LabInfo {
  lab: string;
  name: string;
  /** Six digits, shown on the trainer page. */
  code: string;
}

interface Heard extends LabInfo {
  peerId: string;
  at: number;
}

interface Paired {
  lab: string;
  name: string;
  /** The trainer's room (a secret it gave this headset when they paired). */
  room: string;
}

export class LabLinkSystem extends createSystem({}) {
  readonly deviceId = persistentId('ducklab.deviceId');
  readonly deviceName = headsetName();
  phase: LinkPhase = 'looking';
  /** Trainer pages open on this network (at most three: the menu has three buttons). */
  nearby: LabInfo[] = [];
  paired: Paired | null = readPaired();
  /** What the trainer is doing, in its words ("Training room-tuned: iteration 4 of 30"). */
  trainerLine = '';
  /** The last thing worth saying (an error, a brain arriving); cleared on success. */
  note = '';
  packsSent = 0;
  /** Why pairing cannot work here, when it cannot. */
  private unavailable = '';
  /** The brain last reported to the trainer (it shows which one the headset runs). */
  private brainSent: string | null | undefined = undefined;
  /** The trainer's link, once it said hello in its room. */
  private link: RoomLink | null = null;
  private linkLab: LabInfo | null = null;
  private lobby: Lobby | null = null;
  private lobbyBusy = false;
  private lobbyTriedAt = -Infinity;
  private linkRoom: LinkRoom | null = null;
  /** The room joined or being joined ('' for none). */
  private linkRoomFor = '';
  private roomTriedAt = -Infinity;
  private readonly heard = new Map<string, Heard>();
  /** A pairing request waiting for its welcome. */
  private asking: { lab: string; done: (welcome: Paired | null) => void } | null = null;
  private inbox: PolicyInboxSystem | undefined;
  private views: ViewSwitchSystem | undefined;
  private duck: DuckSystem | undefined;
  /** The "trainer found" hint went to the mood line already. */
  private nudged = false;
  private kept: { name: string; json: string }[] = [];
  private acks = new Map<string, (file: string | null) => void>();
  private brain: { release: BrainRelease; expect: string[]; files: Map<string, Uint8Array>; ended: boolean } | null = null;
  private elements = new Map<string, Text>();
  private written = new Map<string, string>();
  private unbind: (() => void)[] = [];
  private lastRefresh = 0;

  init(): void {
    this.inbox = this.world.getSystem(PolicyInboxSystem);
    this.views = this.world.getSystem(ViewSwitchSystem);
    this.duck = this.world.getSystem(DuckSystem);
    this.cleanupFuncs.push(
      this.world.activeLevel.subscribe(() => this.bind()),
      () => this.release(),
      () => {
        void this.lobby?.leave();
        void this.linkRoom?.leave();
      },
    );
    // Development: ?unpair forgets the paired trainer (headset tests clean up with it);
    // ?pairCode=<6 digits> pairs with that trainer once it is listed (headset tests without a tap).
    const params = new URLSearchParams(location.search);
    if (import.meta.env.DEV && params.has('unpair')) this.forget();
    const code = import.meta.env.DEV ? params.get('pairCode') : null;
    if (code) void this.pairCode(code);
  }

  get connected(): boolean {
    return this.link?.open === true;
  }

  /** A desktop browser: the trainer is in this page (PLAY | TRAINER), nothing to pair. */
  get desktop(): boolean {
    return this.views?.available === true;
  }

  get trainerName(): string {
    return this.linkLab?.name ?? this.paired?.name ?? 'Duck Lab XR';
  }

  /** Packs waiting for the link. */
  get keptPacks(): number {
    return this.kept.length;
  }

  /** Where the player opens the trainer: this site on the computer (then TRAINER at the top). */
  get trainerAddress(): string {
    const url = new URL(import.meta.env.BASE_URL, document.baseURI);
    return `${url.host}${url.pathname}`.replace(/\/$/, '');
  }

  update(): void {
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    const paired = this.paired;
    // The trainer's room: where a paired headset finds its trainer, on every visit.
    if (paired && this.linkRoomFor !== paired.room && now - this.roomTriedAt > RETRY_MS) {
      this.roomTriedAt = now;
      void this.joinLinkRoom(paired.room);
    }
    // The lobby: the trainers on this network, while not connected.
    const wantLobby = !this.connected && !(this.desktop && !paired);
    if (wantLobby && !this.lobby && !this.lobbyBusy && now - this.lobbyTriedAt > RETRY_MS) {
      this.lobbyTriedAt = now;
      void this.joinLobby();
    } else if (!wantLobby && this.lobby && !this.lobbyBusy) {
      const lobby = this.lobby;
      this.lobby = null;
      this.heard.clear();
      void lobby.leave();
    }
    for (const [lab, entry] of this.heard) if (Date.now() - entry.at > HEARD_MS) this.heard.delete(lab);
    this.nearby = [...this.heard.values()].slice(0, LAB_BUTTONS.length).map(({ lab, name, code }) => ({ lab, name, code }));
    // The trainer page shows which brain the headset runs: report a change at once.
    const brain = this.inbox?.current?.id ?? null;
    if (this.connected && brain !== this.brainSent) {
      this.brainSent = brain;
      this.link?.send({ t: 'status', brain });
    }
    this.refresh();
  }

  /** Pairs with the listed trainer at `index` (the menu's PAIR buttons). */
  pair(index: number): void {
    const lab = this.nearby[index];
    if (lab && !this.connected) void this.connect(lab);
  }

  /** Pairs with the trainer showing this code, once it is listed (development: ?pairCode). */
  async pairCode(code: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !this.connected) {
      const lab = [...this.heard.values()].find((entry) => entry.code === code);
      if (lab) {
        await this.connect(lab);
        return;
      }
      await sleep(500);
    }
    if (!this.connected) this.note = `No trainer showing ${spacedCode(code)} on this network.`;
  }

  /** Unpairs: closes the link and stops reconnecting. */
  forget(): void {
    this.paired = null;
    writePaired(null);
    const link = this.link;
    this.link = null;
    this.linkLab = null;
    link?.close();
    const room = this.linkRoom;
    this.linkRoom = null;
    this.linkRoomFor = '';
    void room?.leave();
    this.closed();
    this.note = '';
    this.phase = this.unavailable ? 'unavailable' : 'looking';
  }

  /**
   * A scenario pack for the trainer: sent now when the link is up, otherwise
   * kept (in memory) until it is. Says where it went.
   */
  async sendPack(name: string, json: string): Promise<string> {
    if (!this.connected) {
      this.kept.push({ name, json });
      if (this.kept.length > MAX_KEPT_PACKS) this.kept.shift();
      return `kept for ${this.trainerName} (${this.kept.length} waiting)`;
    }
    return this.deliver(name, json);
  }

  private async deliver(name: string, json: string): Promise<string> {
    const link = this.link;
    if (!link) throw new Error('not connected');
    const saved = new Promise<string | null>((resolve) => {
      this.acks.set(name, resolve);
      setTimeout(() => {
        if (this.acks.get(name) === resolve) {
          this.acks.delete(name);
          resolve(null);
        }
      }, PACK_ACK_MS);
    });
    await link.sendFile({ kind: 'pack', name }, new TextEncoder().encode(json));
    const file = await saved;
    this.packsSent++;
    return file ? `sent to ${this.trainerName} (${file})` : `sent to ${this.trainerName}`;
  }

  private async flushKept(): Promise<void> {
    while (this.kept.length && this.connected) {
      const pack = this.kept[0];
      try {
        await this.deliver(pack.name, pack.json);
      } catch {
        return;
      }
      this.kept.shift();
    }
  }

  // --- Finding and pairing ----------------------------------------------------------

  private async joinLobby(): Promise<void> {
    this.lobbyBusy = true;
    try {
      const keys = await networkKeys();
      if (!keys.length) throw new Error('could not tell which network this headset is on (no answer from a STUN server)');
      const lobby = await Lobby.join(keys);
      lobby.onMessage = (message, peerId) => this.onLobby(message, peerId);
      lobby.onPeerLeave = (peerId) => {
        for (const [lab, entry] of this.heard) if (entry.peerId === peerId) this.heard.delete(lab);
      };
      this.lobby = lobby;
      this.unavailable = '';
      if (this.phase === 'unavailable') this.phase = 'looking';
    } catch (err) {
      this.unavailable = message(err);
      if (!this.connected && this.phase !== 'connecting') this.phase = 'unavailable';
    } finally {
      this.lobbyBusy = false;
    }
  }

  private onLobby(message: LobbyMessage, peerId: string): void {
    if (message.t === 'lab') {
      this.heard.set(message.lab, { lab: message.lab, name: message.name, code: message.code, peerId, at: Date.now() });
      if (!this.paired && !this.nudged && this.duck) {
        // Once: a trainer showed up and the menu may be closed (in a headset it is).
        this.nudged = true;
        const one = this.heard.size === 1 ? ` ${spacedCode(message.code)}` : '';
        this.duck.status = `Duck Lab XR's trainer is open on your computer. Pair in the menu: TRAINER, PAIR${one}.`;
      }
    } else if (message.t === 'welcome' && this.asking?.lab === message.lab) {
      this.asking.done({ lab: message.lab, name: message.name, room: message.room });
    }
  }

  private async connect(lab: LabInfo): Promise<void> {
    if (this.phase === 'connecting' || this.connected) return;
    this.phase = 'connecting';
    this.linkLab = lab;
    this.note = '';
    try {
      const welcome = await this.askToPair(lab);
      if (!welcome) {
        this.note = `${lab.name} did not answer. Is its page still open?`;
        return;
      }
      this.paired = welcome;
      writePaired(welcome);
      await this.joinLinkRoom(welcome.room);
      if (!(await this.trainerArrives(OPEN_MS))) this.note = `Could not reach ${lab.name} over your network`;
    } catch (err) {
      this.note = `Pairing failed: ${message(err)}`;
    } finally {
      if (this.phase === 'connecting') this.phase = this.connected ? 'connected' : this.unavailable ? 'unavailable' : 'looking';
      if (!this.connected) this.linkLab = null;
    }
  }

  /** Asks a listed trainer to pair; its welcome carries its room. Null when it did not answer. */
  private askToPair(lab: LabInfo): Promise<Paired | null> {
    const heard = this.heard.get(lab.lab);
    if (!this.lobby || !heard) return Promise.resolve(null);
    this.asking?.done(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), ANSWER_MS);
      const finish = (welcome: Paired | null) => {
        clearTimeout(timer);
        if (this.asking?.done === finish) this.asking = null;
        resolve(welcome);
      };
      this.asking = { lab: lab.lab, done: finish };
      this.lobby?.send({ t: 'pair', v: LINK_VERSION, id: this.deviceId, name: this.deviceName }, heard.peerId);
    });
  }

  /** Joins the paired trainer's room: the trainer is there whenever its page is open. */
  private async joinLinkRoom(room: string): Promise<void> {
    if (this.linkRoomFor === room && this.linkRoom) return;
    const old = this.linkRoom;
    this.linkRoom = null;
    this.linkRoomFor = room;
    void old?.leave();
    try {
      const linkRoom = await LinkRoom.join(room);
      if (this.paired?.room !== room) {
        void linkRoom.leave(); // forgotten meanwhile
        return;
      }
      linkRoom.onPeer = (link) => this.meet(link);
      this.linkRoom = linkRoom;
    } catch (err) {
      this.linkRoomFor = ''; // try again later
      this.note = `Could not open the link: ${message(err)}`;
    }
  }

  /** Somebody joined the trainer's room: say who we are; the trainer says so back. */
  private meet(link: RoomLink): void {
    link.onMessage = (msg) => {
      if (msg.t === 'hello' && msg.role === 'trainer' && msg.app === LINK_APP && msg.id === this.paired?.lab) this.adopt(link, msg.name);
    };
    link.send({ t: 'hello', app: LINK_APP, v: LINK_VERSION, role: 'headset', id: this.deviceId, name: this.deviceName });
  }

  /** The paired trainer is here: the link is up. */
  private adopt(link: RoomLink, name: string): void {
    const paired = this.paired;
    if (!paired) return;
    if (this.link && this.link !== link) this.link.close();
    this.link = link;
    const trainer = name || paired.name;
    this.linkLab = { lab: paired.lab, name: trainer, code: '' };
    if (trainer !== paired.name) {
      this.paired = { ...paired, name: trainer };
      writePaired(this.paired);
    }
    this.phase = 'connected';
    this.note = '';
    link.onState = (state) => {
      if (state !== 'closed' || this.link !== link) return;
      this.link = null;
      this.closed();
      this.phase = this.unavailable ? 'unavailable' : 'looking';
      this.note = `Lost ${trainer}. Reconnecting when its page is open.`;
    };
    link.onMessage = (msg) => this.onMessage(msg);
    link.onFile = (header, bytes) => this.onFile(header, bytes);
    this.brainSent = this.inbox?.current?.id ?? null;
    link.send({ t: 'status', brain: this.brainSent });
    if (this.inbox) this.inbox.linkConnected = true;
    void this.flushKept();
  }

  /** Resolves true once the trainer said hello in its room, false after `ms`. */
  private async trainerArrives(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.connected) return true;
      await sleep(250);
    }
    return this.connected;
  }

  private closed(): void {
    this.trainerLine = '';
    this.brain = null;
    if (this.inbox) this.inbox.linkConnected = false;
    for (const resolve of this.acks.values()) resolve(null);
    this.acks.clear();
  }

  // --- Over the link ------------------------------------------------------------------

  private onMessage(msg: LinkMessage): void {
    switch (msg.t) {
      case 'hello':
        if (this.linkLab && msg.name) this.linkLab = { ...this.linkLab, name: msg.name };
        break;
      case 'pack-saved':
        this.acks.get(msg.name)?.(msg.file);
        this.acks.delete(msg.name);
        break;
      case 'pack-failed':
        this.acks.get(msg.name)?.(null);
        this.acks.delete(msg.name);
        this.note = `${this.trainerName} could not keep a pack: ${msg.error}`;
        break;
      case 'brains':
        this.inbox?.fromTrainer(msg, (id) => this.link?.send({ t: 'want-brain', id }));
        break;
      case 'brain-start':
        this.brain = { release: msg.release, expect: msg.files, files: new Map(), ended: false };
        this.note = `Getting ${msg.release.name} from ${this.trainerName}...`;
        break;
      case 'brain-end':
        if (this.brain && this.brain.release.id === msg.id) {
          this.brain.ended = true;
          this.finishBrain();
        }
        break;
      case 'brain-failed':
        this.brain = null;
        this.note = `Could not get the new brain: ${msg.error}`;
        break;
      case 'trainer':
        this.trainerLine = msg.line;
        break;
      default:
        break;
    }
  }

  private onFile(header: FileHeader, bytes: Uint8Array): void {
    const brain = this.brain;
    if (header.kind === 'brain' && brain && header.release === brain.release.id) {
      brain.files.set(header.name, bytes);
      this.finishBrain();
    }
  }

  /** Keeps a brain once its end and all its files are in (they travel on separate channels). */
  private finishBrain(): void {
    const got = this.brain;
    if (!got || !got.ended || got.expect.some((name) => !got.files.has(name))) return;
    this.brain = null;
    void this.inbox?.storeLinked(got.release, got.files).then(
      () => {
        this.note = '';
        this.link?.send({ t: 'status', brain: this.inbox?.current?.id ?? null });
      },
      (err: unknown) => {
        this.note = `Could not keep ${got.release.name}: ${message(err)}`;
      },
    );
  }

  // --- Menu --------------------------------------------------------------------

  private statusLine(): string {
    if (this.note) return this.note;
    if (this.desktop && !this.connected) return "Duck Lab XR's trainer runs in this browser: TRAINER at the top of the page, or the button below. Your headset pairs with it there.";
    if (this.connected) {
      const line = `Connected to ${this.trainerName}. Hard moments go there; new brains come back.`;
      return this.trainerLine ? `${line} ${this.trainerLine}` : line;
    }
    if (this.phase === 'connecting') return `Connecting to ${this.linkLab?.name ?? 'Duck Lab XR'}...`;
    const kept = this.kept.length ? ` ${this.kept.length} pack${this.kept.length === 1 ? '' : 's'} waiting.` : '';
    if (this.paired) return `Paired with ${this.paired.name}. Open ${this.trainerAddress} on that computer and click TRAINER to connect.${kept}`;
    if (this.phase === 'unavailable') return `Pairing is not available here: ${this.unavailable || 'no internet connection'}.`;
    if (this.nearby.length) return 'Pick the code your computer shows.';
    return `On your computer, open ${this.trainerAddress} and click TRAINER at the top. Its code shows up here.`;
  }

  private refresh(): void {
    this.text('lab-status', this.statusLine());
    const offer = this.connected || this.phase === 'connecting' || this.desktop ? [] : this.nearby;
    LAB_BUTTONS.forEach((id, i) => {
      const lab = offer[i];
      this.show(id, !!lab);
      if (lab) {
        this.text(id, `PAIR ${spacedCode(lab.code)}`);
        // Yellow: the one paired before; mint: the only one there (the obvious tap).
        this.toggle(id, lab.lab === this.paired?.lab ? 'paired' : !this.paired && offer.length === 1 ? 'go' : 'idle');
      }
    });
    this.show('lab-open', this.desktop);
    this.show('lab-forget', !!this.paired);
  }

  /** The menu panel of this level: wire the trainer buttons. */
  private bind(): void {
    this.release();
    this.elements.clear();
    this.written.clear();
    const panel = this.world.getSceneObject<UIKitMLAsset>(MENU_NODE);
    if (!panel) return;
    for (const id of ['lab-status', ...LAB_BUTTONS, 'lab-open', 'lab-forget']) {
      const element = panel.getElementById<Text>(id);
      if (element) {
        element.name = id;
        this.elements.set(id, element);
      }
    }
    const listen = (id: string, handler: () => void) => {
      const element = this.elements.get(id);
      if (!element) return;
      element.addEventListener('click', handler);
      this.unbind.push(() => element.removeEventListener('click', handler));
    };
    LAB_BUTTONS.forEach((id, i) => listen(id, () => this.pair(i)));
    listen('lab-open', () => this.views?.show('trainer'));
    listen('lab-forget', () => this.forget());
  }

  private release(): void {
    for (const off of this.unbind) off();
    this.unbind = [];
  }

  private text(id: string, value: string): void {
    const element = this.elements.get(id);
    if (element && this.written.get(id) !== value) {
      this.written.set(id, value);
      element.setProperties({ text: value });
    }
  }

  private show(id: string, on: boolean): void {
    const key = `${id}:shown`;
    const value = on ? '1' : '0';
    const element = this.elements.get(id);
    if (!element || this.written.get(key) === value) return;
    this.written.set(key, value);
    element.setProperties({ display: on ? 'flex' : 'none' });
  }

  private toggle(id: string, look: 'idle' | 'paired' | 'go'): void {
    const key = `${id}:look`;
    const element = this.elements.get(id);
    if (!element || this.written.get(key) === look) return;
    this.written.set(key, look);
    const fill = look === 'paired' ? YELLOW : look === 'go' ? MINT : null;
    element.setProperties({
      backgroundColor: fill ?? IDLE_BG,
      borderColor: fill ?? IDLE_BORDER,
      color: fill ? INK : CREAM,
    });
  }
}

/** "Quest 3": how the trainer page lists this device. */
function headsetName(): string {
  const ua = hostUserAgent();
  const quest = ua.match(/Quest (3S|3|Pro|2)/);
  if (quest) return `Quest ${quest[1]}`;
  if (/OculusBrowser/.test(ua)) return 'Quest';
  if (/PicoBrowser|Pico/.test(ua)) return 'Pico';
  if (typeof navigator !== 'undefined' && navigator.userAgent !== ua) return 'Emulated headset';
  return /Mobile|Android|iPhone|iPad/.test(ua) ? 'Phone or tablet' : 'Browser';
}

/** The trainer this headset paired with. A pairing from before rooms (no room) is dropped. */
function readPaired(): Paired | null {
  try {
    const value = JSON.parse(localStorage.getItem(PAIRED_KEY) ?? 'null') as Partial<Paired> | null;
    return value && typeof value.lab === 'string' && typeof value.name === 'string' && isRoom(value.room)
      ? { lab: value.lab, name: value.name, room: value.room }
      : null;
  } catch {
    return null;
  }
}

function writePaired(value: Paired | null): void {
  try {
    if (value) localStorage.setItem(PAIRED_KEY, JSON.stringify(value));
    else localStorage.removeItem(PAIRED_KEY);
  } catch {
    // storage blocked: paired for this visit only
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
