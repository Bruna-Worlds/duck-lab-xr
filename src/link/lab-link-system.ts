// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The headset's link to Duck Lab XR's trainer on the player's computer (menu:
 * TRAINER ON YOUR COMPUTER).
 *
 * Both devices open the same website. The trainer (TRAINER on the computer) tells the
 * site's pairing rendezvous it is open and shows a six-digit code; the headset
 * lists the trainers on its network, and the player picks the one with the
 * code their computer shows. The headset then opens a WebRTC data channel
 * straight to that page, so scenario packs go up and trained brains come down
 * over the home network, not through the website. The pairing is remembered:
 * later the headset reconnects by itself whenever that trainer page is open.
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
import { type BrainRelease, type FileHeader, LINK_APP, LINK_VERSION, type LinkMessage, persistentId, spacedCode } from './link-protocol.js';
import { PeerLink } from './peer-link.js';
import { type LabInfo, PairingUnavailable, RendezvousClient } from './rendezvous-client.js';

const MENU_NODE = 'menu-panel';
const PAIRED_KEY = 'ducklab.pairedTrainer';
/** List the trainers on the network this often while not connected. */
const LOOK_MS = 4000;
/** Knock on the paired trainer this often when it is not listed (another network path). */
const KNOCK_MS = 30_000;
const ANSWER_MS = 15_000;
const OPEN_MS = 12_000;
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

interface Paired {
  lab: string;
  name: string;
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
  /** The brain last reported to the trainer (it shows which one the headset runs). */
  private brainSent: string | null | undefined = undefined;
  private link: PeerLink | null = null;
  private linkLab: LabInfo | null = null;
  private rendezvous!: RendezvousClient;
  private inbox: PolicyInboxSystem | undefined;
  private views: ViewSwitchSystem | undefined;
  private duck: DuckSystem | undefined;
  /** The "trainer found" hint went to the mood line already. */
  private nudged = false;
  private kept: { name: string; json: string }[] = [];
  private acks = new Map<string, (file: string | null) => void>();
  private brain: { release: BrainRelease; files: Map<string, Uint8Array> } | null = null;
  private lastLook = -Infinity;
  private lastKnock = -Infinity;
  private looking = false;
  private elements = new Map<string, Text>();
  private written = new Map<string, string>();
  private unbind: (() => void)[] = [];
  private lastRefresh = 0;

  init(): void {
    this.rendezvous = new RendezvousClient(new URL(`${import.meta.env.BASE_URL}__duck/pair/`, document.baseURI).href);
    this.inbox = this.world.getSystem(PolicyInboxSystem);
    this.views = this.world.getSystem(ViewSwitchSystem);
    this.duck = this.world.getSystem(DuckSystem);
    this.cleanupFuncs.push(
      this.world.activeLevel.subscribe(() => this.bind()),
      () => this.release(),
      () => this.link?.close(),
    );
    // Development: ?unpair forgets the paired trainer (headset tests clean up with it);
    // ?pairCode=<6 digits> pairs with that trainer on load (headset tests without a tap).
    const params = new URLSearchParams(location.search);
    if (import.meta.env.DEV && params.has('unpair')) this.forget();
    const code = import.meta.env.DEV ? params.get('pairCode') : null;
    if (code) setTimeout(() => void this.pairCode(code), 1500);
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
    if (!this.connected && this.phase !== 'connecting' && !this.looking && !(this.desktop && !this.paired)) {
      const every = this.phase === 'unavailable' ? LOOK_MS * 15 : LOOK_MS;
      if (now - this.lastLook > every) {
        this.lastLook = now;
        this.looking = true;
        void this.look().finally(() => {
          this.looking = false;
        });
      }
    }
    if (now - this.lastRefresh >= REFRESH_MS) {
      this.lastRefresh = now;
      // The trainer page shows which brain the headset runs: report a change at once.
      const brain = this.inbox?.current?.id ?? null;
      if (this.connected && brain !== this.brainSent) {
        this.brainSent = brain;
        this.link?.send({ t: 'status', brain });
      }
      this.refresh();
    }
  }

  /** Pairs with the listed trainer at `index` (the menu's PAIR buttons). */
  pair(index: number): void {
    const lab = this.nearby[index];
    if (lab && !this.connected) void this.connect(lab, false);
  }

  /** Pairs with the trainer showing this code (it need not be listed). */
  async pairCode(code: string): Promise<void> {
    try {
      await this.connect(await this.rendezvous.byCode(code), false);
    } catch (err) {
      this.note = message(err);
    }
  }

  /** Unpairs: closes the link and stops reconnecting. */
  forget(): void {
    this.paired = null;
    writePaired(null);
    const link = this.link;
    this.link = null;
    this.linkLab = null;
    link?.close();
    this.closed();
    this.note = '';
    this.phase = 'looking';
    this.lastLook = -Infinity;
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

  private async look(): Promise<void> {
    try {
      this.nearby = (await this.rendezvous.labs()).slice(0, LAB_BUTTONS.length);
      if (this.phase === 'unavailable') this.phase = 'looking';
    } catch (err) {
      this.nearby = [];
      if (err instanceof PairingUnavailable) this.phase = 'unavailable';
      return;
    }
    const paired = this.paired;
    if (!paired && this.nearby.length && !this.nudged && this.duck) {
      // Once: a trainer showed up and the menu may be closed (in a headset it is).
      this.nudged = true;
      const code = this.nearby.length === 1 ? ` ${spacedCode(this.nearby[0].code)}` : '';
      this.duck.status = `Duck Lab XR's trainer is open on your computer. Pair in the menu: TRAINER, PAIR${code}.`;
    }
    if (!paired || this.connected || this.phase === 'connecting') return;
    const listed = this.nearby.find((lab) => lab.lab === paired.lab);
    const now = performance.now();
    if (listed) {
      await this.connect(listed, false);
    } else if (now - this.lastKnock > KNOCK_MS) {
      // Not listed (another network path, say): offer anyway, quietly.
      this.lastKnock = now;
      await this.connect({ lab: paired.lab, name: paired.name, code: '' }, true);
    }
  }

  private async connect(lab: LabInfo, quiet: boolean): Promise<void> {
    if (this.phase === 'connecting' || this.connected) return;
    this.link?.close();
    if (!quiet) {
      this.phase = 'connecting';
      this.linkLab = lab;
      this.note = '';
    }
    try {
      const { link, sdp } = await PeerLink.offer();
      const nonce = freshNonce();
      this.wire(link, lab);
      await this.rendezvous.send(lab.lab, this.deviceId, { type: 'offer', sdp, name: this.deviceName, role: 'headset', nonce });
      const answer = await this.awaitAnswer(lab.lab, nonce);
      if (this.link !== link) return;
      if (!answer) {
        link.close();
        if (!quiet) this.note = `${lab.name} did not answer. Is its page still open?`;
        return;
      }
      await link.accept(answer.sdp);
      if (!(await opened(link, OPEN_MS))) {
        link.close();
        if (!quiet) this.note = `Could not reach ${lab.name} over your network`;
      }
    } catch (err) {
      if (!quiet) this.note = `Pairing failed: ${message(err)}`;
    } finally {
      if (this.phase === 'connecting') this.phase = this.connected ? 'connected' : 'looking';
      if (!this.connected && !quiet) this.linkLab = null;
    }
  }

  /** The trainer's answer to the offer with this nonce, or null after ANSWER_MS. */
  private async awaitAnswer(lab: string, nonce: string): Promise<{ sdp: string; name: string } | null> {
    const deadline = performance.now() + ANSWER_MS;
    while (performance.now() < deadline) {
      const wait = Math.min(5000, deadline - performance.now());
      const messages = await this.rendezvous.inbox(this.deviceId, wait);
      const answer = messages.find((m) => m.from === lab && m.data?.type === 'answer' && m.data.nonce === nonce);
      if (answer) return answer.data;
    }
    return null;
  }

  private wire(link: PeerLink, lab: LabInfo): void {
    this.link = link;
    link.onState = (state) => {
      if (this.link !== link) return;
      if (state === 'open') {
        this.linkLab = lab;
        this.phase = 'connected';
        this.note = '';
        this.paired = { lab: lab.lab, name: lab.name };
        writePaired(this.paired);
        link.send({ t: 'hello', app: LINK_APP, v: LINK_VERSION, role: 'headset', id: this.deviceId, name: this.deviceName });
        this.brainSent = this.inbox?.current?.id ?? null;
        link.send({ t: 'status', brain: this.brainSent });
        if (this.inbox) this.inbox.linkConnected = true;
        void this.flushKept();
      } else if (state === 'closed') {
        const wasOpen = this.phase === 'connected';
        this.link = null;
        this.closed();
        if (wasOpen) {
          this.phase = 'looking';
          this.note = `Lost ${lab.name}. Reconnecting when its page is open.`;
          this.lastLook = -Infinity;
        }
      }
    };
    link.onMessage = (msg) => this.onMessage(msg);
    link.onFile = (header, bytes) => this.onFile(header, bytes);
  }

  private closed(): void {
    this.trainerLine = '';
    this.brain = null;
    if (this.inbox) this.inbox.linkConnected = false;
    for (const resolve of this.acks.values()) resolve(null);
    this.acks.clear();
  }

  private onMessage(msg: LinkMessage): void {
    switch (msg.t) {
      case 'hello':
        if (this.linkLab && msg.name) {
          this.linkLab = { ...this.linkLab, name: msg.name };
          this.paired = { lab: this.linkLab.lab, name: msg.name };
          writePaired(this.paired);
        }
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
        this.brain = { release: msg.release, files: new Map() };
        this.note = `Getting ${msg.release.name} from ${this.trainerName}...`;
        break;
      case 'brain-end': {
        const got = this.brain;
        this.brain = null;
        if (got && got.release.id === msg.id) {
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
        break;
      }
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
    if (header.kind === 'brain' && brain && header.release === brain.release.id) brain.files.set(header.name, bytes);
  }

  // --- Menu --------------------------------------------------------------------

  private statusLine(): string {
    if (this.note) return this.note;
    if (this.desktop && !this.connected) return "Duck Lab XR's trainer runs in this browser: TRAINER at the top of the page, or the button below. Your headset pairs with it there.";
    if (this.phase === 'unavailable') return 'Pairing needs the Duck Lab XR website; this copy of the app has no pairing service.';
    if (this.connected) {
      const line = `Connected to ${this.trainerName}. Hard moments go there; new brains come back.`;
      return this.trainerLine ? `${line} ${this.trainerLine}` : line;
    }
    if (this.phase === 'connecting') return `Connecting to ${this.linkLab?.name ?? 'Duck Lab XR'}...`;
    const kept = this.kept.length ? ` ${this.kept.length} pack${this.kept.length === 1 ? '' : 's'} waiting.` : '';
    if (this.paired) return `Paired with ${this.paired.name}. Open ${this.trainerAddress} on that computer and click TRAINER to connect.${kept}`;
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

function readPaired(): Paired | null {
  try {
    const value = JSON.parse(localStorage.getItem(PAIRED_KEY) ?? 'null') as Paired | null;
    return value && typeof value.lab === 'string' && typeof value.name === 'string' ? value : null;
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

/** A fresh id for one offer (its answer must carry it back). */
function freshNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function opened(link: PeerLink, ms: number): Promise<boolean> {
  if (link.state !== 'connecting') return Promise.resolve(link.open);
  return new Promise((resolve) => {
    const previous = link.onState;
    const timer = setTimeout(() => finish(false), ms);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      if (link.onState === watch) link.onState = previous;
      resolve(value);
    };
    const watch = (state: 'connecting' | 'open' | 'closed') => {
      previous?.(state);
      if (state !== 'connecting') finish(state === 'open');
    };
    link.onState = watch;
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
