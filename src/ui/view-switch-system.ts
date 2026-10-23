// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop: one click between playing (this page) and Duck Lab XR's trainer
 * (<site>/trainer/). The trainer shows in a frame over the game, so neither
 * reloads, the duck keeps its place, and the trainer's headset link stays up
 * while you play. The game shows a PLAY | TRAINER switch at the top centre;
 * the trainer page shows the same switch in its header and asks this page to
 * swap back (postMessage). The page reopens on the view used last; #trainer
 * in the address opens on the trainer.
 *
 * Not on a headset's own browser (its 2D page is a landing page) or on touch
 * screens. Someone who used the trainer before gets it loaded (hidden) with
 * the game, so their headset finds it without a click.
 */
import { createSystem, VisibilityState } from '@iwsdk/core';
import { headsetLanding } from './page-mode.js';

export type PageView = 'play' | 'trainer';

/** Set by the trainer page when it opens from the website (tools/lab/ui/app.js). */
const USED_KEY = 'ducklab.trainerUsed';
/** The view shown last ('play' or 'trainer'). */
const VIEW_KEY = 'ducklab.view';

const CSS = `
#duck-views { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 30; display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: rgba(15, 16, 32, 0.88); border: 2px solid rgba(255, 244, 220, 0.22); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35); user-select: none; -webkit-user-select: none; }
#duck-views button { font: 21px/1 DuckBebas, 'Arial Narrow', sans-serif; letter-spacing: 2px; color: #fff4dc; background: transparent; border: 0; border-radius: 999px; padding: 8px 18px 6px; cursor: pointer; }
#duck-views button:hover { background: rgba(255, 244, 220, 0.12); }
#duck-views button.on { background: #ffcf3f; color: #0f1020; cursor: default; }
#duck-trainer { position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; z-index: 60; background: #0f1020; }
#duck-trainer[hidden] { display: none; }
@media (max-width: 760px) { #duck-views { display: none; } }
`;

export class ViewSwitchSystem extends createSystem({}) {
  /** Whether this page offers the switch (a desktop browser). */
  available = false;
  view: PageView = 'play';
  private root: HTMLDivElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private flat = true;

  init(): void {
    this.available = !headsetLanding() && !(window.matchMedia?.('(pointer: coarse)').matches ?? false);
    if (!this.available) return;
    const style = document.createElement('style');
    // In development the emulator's own Enter XR button sits at the top centre: stay under it.
    style.textContent = import.meta.env.DEV ? `${CSS}\n#duck-views { top: 60px; }` : CSS;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.id = 'duck-views';
    root.setAttribute('role', 'tablist');
    for (const view of ['play', 'trainer'] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.view = view;
      button.textContent = view === 'play' ? 'PLAY' : 'TRAINER';
      button.title = view === 'play' ? 'Play with Pip' : "Duck Lab XR's trainer: train Pip on your room and pair your headset";
      button.addEventListener('click', () => this.show(view));
      root.appendChild(button);
    }
    document.body.appendChild(root);
    this.root = root;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { duckLab?: string; view?: PageView } | null;
      if (event.origin !== location.origin || data?.duckLab !== 'view') return;
      if (data.view === 'play' || data.view === 'trainer') this.show(data.view);
    };
    window.addEventListener('message', onMessage);
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        this.flat = state === VisibilityState.NonImmersive;
        this.render();
      }),
      () => window.removeEventListener('message', onMessage),
      () => {
        root.remove();
        style.remove();
        this.frame?.remove();
      },
    );
    if (location.hash === '#trainer' || readStore(VIEW_KEY) === 'trainer') this.show('trainer');
    else if (readStore(USED_KEY) === '1') this.trainerFrame(); // loaded, hidden: the headset link is up while playing
    this.render();
  }

  /** Shows the game or the trainer (one click from either). */
  show(view: PageView): void {
    if (!this.available) return;
    this.view = view;
    writeStore(VIEW_KEY, view);
    if (view === 'trainer') this.trainerFrame();
    this.render();
    const url = `${location.pathname}${location.search}${view === 'trainer' ? '#trainer' : ''}`;
    history.replaceState(history.state, '', url);
    if (view === 'play') {
      // Keys go to the game again.
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.focus();
    } else {
      this.frame?.focus();
    }
  }

  private trainerFrame(): HTMLIFrameElement {
    if (this.frame) return this.frame;
    const frame = document.createElement('iframe');
    frame.id = 'duck-trainer';
    frame.title = "Duck Lab XR's trainer";
    frame.hidden = true;
    // The trainer reaches the trainer engine on this computer (http://localhost:8790).
    frame.allow = 'local-network-access';
    frame.src = new URL(`${import.meta.env.BASE_URL}trainer/`, document.baseURI).href;
    document.body.appendChild(frame);
    this.frame = frame;
    return frame;
  }

  private render(): void {
    const trainer = this.view === 'trainer' && this.flat;
    if (this.frame) this.frame.hidden = !trainer;
    if (this.root) {
      // The trainer page has the same switch in its header.
      this.root.style.display = this.flat && !trainer ? '' : 'none';
      for (const button of this.root.querySelectorAll('button')) {
        const on = button.dataset.view === this.view;
        button.classList.toggle('on', on);
        button.setAttribute('aria-selected', String(on));
      }
    }
  }
}

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the view is not remembered
  }
}
