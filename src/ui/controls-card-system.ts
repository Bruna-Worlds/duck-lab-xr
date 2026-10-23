// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop: a "How to play" card with the keyboard controls. It shows when
 * Pip first stands up on each visit, until the player ticks "Don't show this
 * again", and whenever the menu's CONTROLS button is clicked. One click on
 * GOT IT (or Esc) closes it. Not in a headset's own browser or on touch
 * screens (those have their own controls), not over the trainer, not in XR.
 */
import { createSystem, type UIKit, type UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { DuckSystem } from '../duck/duck-system.js';
import { headsetLanding } from './page-mode.js';
import { ViewSwitchSystem } from './view-switch-system.js';

const SEEN_KEY = 'ducklab.controlsSeen';
const MENU_NODE = 'menu-panel';
const BUTTON_ID = 'controls-button';

/** What, which keys, and a few words. */
const ROWS: [string, string[], string][] = [
  ['Walk and turn', ['W', 'A', 'S', 'D'], 'or the arrow keys'],
  ['Moves', ['J', 'K', 'L', 'I', 'N'], 'kick, roll, sit, peck, bow'],
  ['Quack', ['Q'], ''],
  ['Autopilot', ['P'], 'Pip runs the course by itself'],
  ['Restart', ['R'], 'the run, from the start'],
  ['Test case', ['X'], 'saves this moment for the trainer'],
  ['Pip cam', ['V'], "the duck's own camera, on or off"],
];

const CSS = `
#duck-controls { position: fixed; z-index: 35; left: 50%; top: 52%; transform: translate(-50%, -50%); width: min(500px, calc(100vw - 32px)); box-sizing: border-box; padding: 16px 18px 16px; border-radius: 22px; background: rgba(15, 16, 32, 0.96); border: 2px solid rgba(205, 180, 219, 0.45); box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45); color: #fff4dc; font: 14px/1.35 system-ui, -apple-system, 'Segoe UI', sans-serif; }
#duck-controls[hidden] { display: none; }
#duck-controls .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
#duck-controls .title { font: 26px/1 DuckBebas, 'Arial Narrow', sans-serif; letter-spacing: 2px; color: #ffcf3f; padding-top: 3px; }
#duck-controls .x { width: 30px; height: 30px; border-radius: 15px; border: 1px solid rgba(255, 244, 220, 0.25); background: rgba(255, 244, 220, 0.08); color: #fff4dc; font: 18px/1 system-ui, sans-serif; cursor: pointer; }
#duck-controls .row { display: grid; grid-template-columns: 116px auto 1fr; align-items: center; gap: 10px; padding: 5px 0; border-top: 1px solid rgba(255, 244, 220, 0.08); }
#duck-controls .what { font-weight: 700; }
#duck-controls .keys { display: flex; gap: 4px; }
#duck-controls kbd { display: inline-block; min-width: 24px; padding: 4px 6px 2px; box-sizing: border-box; border-radius: 6px; background: #fff4dc; color: #0f1020; font: 17px/1 DuckBebas, 'Arial Narrow', sans-serif; letter-spacing: 1px; text-align: center; box-shadow: 0 2px 0 #b9ad96; }
#duck-controls .note { color: rgba(255, 244, 220, 0.65); font-size: 13px; }
#duck-controls .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 10px; }
#duck-controls .hint { color: rgba(255, 244, 220, 0.65); font-size: 12.5px; margin-top: 8px; }
#duck-controls .never { display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; user-select: none; }
#duck-controls .never input { width: 18px; height: 18px; accent-color: #3de0b8; margin: 0; cursor: pointer; }
#duck-controls .go { font: 22px/1 DuckBebas, 'Arial Narrow', sans-serif; letter-spacing: 2px; color: #0f1020; background: #3de0b8; border: 0; border-radius: 999px; padding: 10px 22px 8px; cursor: pointer; flex-shrink: 0; }
#duck-controls .go:hover { background: #6cf0cc; }
`;

export class ControlsCardSystem extends createSystem({}) {
  /** Whether this page has the card (a desktop browser). */
  available = false;
  private card: HTMLDivElement | null = null;
  private duck: DuckSystem | undefined;
  private views: ViewSwitchSystem | undefined;
  private flat = true;
  /** Waiting to show it the first time (until Pip stands and the game is in view). */
  private pending = false;
  private unbind: (() => void)[] = [];

  init(): void {
    this.available = !headsetLanding() && !(window.matchMedia?.('(pointer: coarse)').matches ?? false);
    if (!this.available) return;
    this.duck = this.world.getSystem(DuckSystem);
    this.views = this.world.getSystem(ViewSwitchSystem);
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const card = document.createElement('div');
    card.id = 'duck-controls';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'How to play');
    card.hidden = true;
    const rows = ROWS.map(
      ([what, keys, note]) =>
        `<div class="row"><span class="what">${what}</span><span class="keys">${keys.map((k) => `<kbd>${k}</kbd>`).join('')}</span><span class="note">${note}</span></div>`,
    ).join('');
    card.innerHTML = `<div class="head"><span class="title">HOW TO PLAY</span><button class="x" type="button" aria-label="Close">&times;</button></div>${rows}<div class="hint">TRAINER at the top of the page: train Pip on your room and pair your headset. The menu's CONTROLS button shows this card again.</div><div class="foot"><label class="never"><input type="checkbox" class="never-box" /> Don't show this again</label><button class="go" type="button">GOT IT</button></div>`;
    document.body.appendChild(card);
    this.card = card;
    const never = card.querySelector<HTMLInputElement>('.never-box');
    if (never) never.checked = readSeen();
    never?.addEventListener('change', () => writeSeen(never.checked));
    const close = () => this.hide();
    card.querySelector('.go')?.addEventListener('click', close);
    card.querySelector('.x')?.addEventListener('click', close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !card.hidden) close();
    };
    window.addEventListener('keydown', onKey);
    this.pending = !readSeen();
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.flat = state === VisibilityState.NonImmersive;
        if (!this.flat) card.hidden = true;
      }),
      this.world.activeLevel.subscribe(() => this.bind()),
      () => window.removeEventListener('keydown', onKey),
      () => this.release(),
      () => {
        card.remove();
        style.remove();
      },
    );
  }

  update(): void {
    // After the loading screen has gone (index.html's #splash), over the game, not the trainer.
    if (!this.pending || !this.flat || !this.duck?.hasPose || this.views?.view === 'trainer' || document.getElementById('splash')) return;
    this.pending = false;
    this.show();
  }

  get shown(): boolean {
    return !!this.card && !this.card.hidden;
  }

  show(): void {
    if (this.card && this.flat) this.card.hidden = false;
  }

  /** Closes the card (it comes back next visit unless "Don't show this again" is ticked). */
  hide(): void {
    if (this.card) this.card.hidden = true;
    this.pending = false;
    // Keys go back to the game.
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  /** The menu's CONTROLS button (desktop only). */
  private bind(): void {
    this.release();
    const panel = this.world.getSceneObject<UIKitMLAsset>(MENU_NODE);
    const button = panel?.getElementById<UIKit.Text>(BUTTON_ID);
    if (!button) return;
    button.name = BUTTON_ID;
    button.setProperties({ display: 'flex' });
    const open = () => (this.shown ? this.hide() : this.show());
    button.addEventListener('click', open);
    this.unbind.push(() => button.removeEventListener('click', open));
  }

  private release(): void {
    for (const off of this.unbind) off();
    this.unbind = [];
  }
}

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSeen(never: boolean): void {
  try {
    if (never) localStorage.setItem(SEEN_KEY, '1');
    else localStorage.removeItem(SEEN_KEY);
  } catch {
    // storage blocked: it shows again next visit
  }
}
