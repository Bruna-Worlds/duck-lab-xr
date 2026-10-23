// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The real Microduck, linked from the game (menu: REAL DUCK).
 *
 * - LINK signs in to Pollen's rendezvous with the player's Hugging Face
 *   token (asked once on the 2D page, kept for this browser session only)
 *   and opens a session with the first duck online on that account.
 * - MIRROR sends the game's walking command and moves to the real duck as
 *   well as the simulated one: the sim is the preview, the duck follows
 *   (move -> skill: kick_left/kick_right, roulade, ground_pick, sit_toggle).
 * - FLASH BRAIN asks the duck to download the brain running in the game
 *   (a trained release published to a public Hub repo from Duck Lab XR) and use
 *   it as its walking policy.
 * - STOP WALKING zeroes the duck's velocity (it is not an emergency stop:
 *   use the duck's own button for that).
 *
 * Development: ?duckCentral=<url> points at another rendezvous (the mock in
 * tools/test/mock-central.mjs, or Pollen's scripts/duck-sim registered on
 * your account).
 */
import { createSystem, type UIKit, UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { DuckSystem } from '../duck/duck-system.js';
import type { SimEvent } from '../duck/sim-protocol.js';
import { PolicyInboxSystem } from '../training/policy-inbox-system.js';
import { MicroduckLink } from './microduck-link.js';

const MENU_NODE = 'menu-panel';
const TOKEN_KEY = 'duckdash.hfToken';
const REFRESH_MS = 250;
const YELLOW = '#ffcf3f';
const INK = '#0f1020';
const CREAM = '#fff4dc';
const IDLE_BG = 'rgba(255, 244, 220, 0.08)';
const IDLE_BORDER = 'rgba(255, 244, 220, 0.25)';

type Text = UIKit.Text;

const readToken = (): string | null => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
const writeToken = (token: string | null): void => {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked
  }
};

export class RealDuckSystem extends createSystem({}) {
  link!: MicroduckLink;
  mirror = false;
  /** Extra line for the panels: what the last flash or link step did. */
  note = '';
  private duck: DuckSystem | undefined;
  private inbox: PolicyInboxSystem | undefined;
  private elements = new Map<string, Text>();
  private written = new Map<string, string>();
  private unbind: (() => void)[] = [];
  private lastRefresh = 0;
  private flat = true;
  private busy = false;

  init(): void {
    const central = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('duckCentral') : null;
    this.link = new MicroduckLink(central ?? undefined);
    this.duck = this.world.getSystem(DuckSystem);
    this.inbox = this.world.getSystem(PolicyInboxSystem);
    const onSimEvent = (event: SimEvent) => {
      if (this.mirror && event.kind === 'move-start' && event.move) void this.link.doMove(event.move);
    };
    this.duck?.simEvents.add(onSimEvent);
    this.cleanupFuncs.push(
      () => this.duck?.simEvents.delete(onSimEvent),
      this.world.visibilityState.subscribe((state) => {
        this.flat = state === VisibilityState.NonImmersive;
      }),
      this.world.activeLevel.subscribe(() => this.bind()),
      () => this.release(),
      () => void this.link.disconnect(),
    );
  }

  /** Links to the duck; asks for the token on the 2D page when none is kept. */
  async connect(): Promise<void> {
    if (this.busy) return;
    let token = readToken();
    if (!token) {
      if (!this.flat) {
        this.note = 'Link from the 2D page first (it asks for your Hugging Face token)';
        return;
      }
      token = window.prompt(
        'Hugging Face access token for the account your Microduck is signed in to. Make a new read token just for Duck Lab XR: two apps sharing one token disconnect each other. Kept in this browser tab only.',
      )?.trim() ?? '';
      if (!token) return;
    }
    this.busy = true;
    try {
      await this.link.connect(token);
      writeToken(token);
      this.note = '';
    } catch {
      // the link's status says why
    } finally {
      this.busy = false;
    }
  }

  async disconnect(): Promise<void> {
    this.mirror = false;
    await this.link.disconnect();
  }

  /** Forgets the kept token (and unlinks). */
  async forget(): Promise<void> {
    writeToken(null);
    await this.disconnect();
  }

  /** Installs the brain running in the game on the real duck. */
  async flashBrain(): Promise<void> {
    if (this.busy) return;
    const release = this.inbox?.current ?? null;
    if (!this.link.connected) {
      this.note = 'Link to your duck first';
      return;
    }
    if (!release) {
      this.note = 'The game runs the shipped brain: the duck already has it';
      return;
    }
    if (!release.hubRepo) {
      this.note = `Publish ${release.name} to the Hugging Face Hub from Duck Lab XR first (the duck downloads it from there)`;
      return;
    }
    this.busy = true;
    try {
      await this.link.installPolicy({ repo: release.hubRepo, kind: 'gait', slot: 'walk', name: release.name }, (text) => {
        this.note = text;
      });
      this.note = `${this.link.duck?.name ?? 'The duck'} now walks with ${release.name}`;
    } catch (err) {
      this.note = `Flash failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  update(): void {
    const duck = this.duck;
    if (this.mirror && duck && this.link.connected) this.link.drive(duck.commandVx, duck.commandWz);
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    const link = this.link;
    const t = link.telemetry;
    let line = this.note || link.status;
    if (link.connected && !this.note) {
      const parts = [link.status];
      if (link.battery !== null) parts.push(`battery ${Math.round(link.battery)}%`);
      if (t?.fallen) parts.push('fallen');
      else if (t?.pickedUp) parts.push('picked up');
      if (this.mirror) parts.push('mirroring your stick');
      line = parts.join(' | ');
    }
    this.text('real-status', line);
    this.text('real-link', link.connected ? 'UNLINK' : link.state === 'connecting' || link.state === 'listing' ? 'LINKING...' : 'LINK');
    this.toggle('real-link', link.connected);
    this.toggle('real-mirror', this.mirror && link.connected);
  }

  /** The menu panel of this level: wire the REAL DUCK buttons. */
  private bind(): void {
    this.release();
    this.elements.clear();
    this.written.clear();
    const panel = this.world.getSceneObject<UIKitMLAsset>(MENU_NODE);
    if (!panel) return;
    for (const id of ['real-status', 'real-link', 'real-mirror', 'real-flash', 'real-stop']) {
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
    listen('real-link', () => void (this.link.connected ? this.disconnect() : this.connect()));
    listen('real-mirror', () => {
      if (!this.link.connected) {
        this.note = 'Link to your duck first';
        return;
      }
      this.mirror = !this.mirror;
      if (!this.mirror) void this.link.stopWalking();
      this.note = '';
    });
    listen('real-flash', () => void this.flashBrain());
    listen('real-stop', () => {
      this.mirror = false;
      void this.link.stopWalking();
    });
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

  private toggle(id: string, on: boolean): void {
    const key = `${id}:on`;
    const value = on ? '1' : '0';
    const element = this.elements.get(id);
    if (!element || this.written.get(key) === value) return;
    this.written.set(key, value);
    element.setProperties({
      backgroundColor: on ? YELLOW : IDLE_BG,
      borderColor: on ? YELLOW : IDLE_BORDER,
      color: on ? INK : CREAM,
    });
  }
}
