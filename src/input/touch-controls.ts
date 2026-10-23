// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * On-screen controls for phones and tablets (and any pointer-only device): a
 * thumb stick on the left, the four move buttons and Restart on the right.
 * Plain DOM over the canvas, shown only outside XR. The duck system reads
 * `stick` every frame and consumes button presses with `take()`.
 * Desktop keeps the keyboard (WASD or arrows, J K L I, R); `?touch=1` forces
 * the overlay there too.
 */
import { headsetLanding } from '../ui/page-mode.js';

export type TouchButton = 'kick' | 'roll' | 'sit' | 'peck' | 'restart';

const STICK_RADIUS = 52; // px of knob travel
// The HUD's candy palette (see public/ui/moves.uikitml).
const BUTTONS: { id: TouchButton; label: string; color: string }[] = [
  { id: 'kick', label: 'KICK', color: '#ffcf3f' },
  { id: 'roll', label: 'ROLL', color: '#6fb7ff' },
  { id: 'sit', label: 'SIT', color: '#3de0b8' },
  { id: 'peck', label: 'PECK', color: '#ff7a45' },
];

const CSS = `
@font-face { font-family: DuckBebas; src: url(${import.meta.env.BASE_URL}fonts/BebasNeue-Regular.ttf); }
#duck-touch { position: fixed; inset: 0; pointer-events: none; z-index: 20; font-family: DuckBebas, system-ui, sans-serif; letter-spacing: 1px; user-select: none; -webkit-user-select: none; }
#duck-touch[hidden] { display: none; }
#duck-touch .stick { position: absolute; left: 24px; bottom: 28px; width: 150px; height: 150px; border-radius: 50%; background: rgba(15, 16, 32, 0.55); border: 2px solid rgba(255, 244, 220, 0.3); box-shadow: 0 6px 0 rgba(15, 16, 32, 0.35); pointer-events: auto; touch-action: none; }
#duck-touch .knob { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%; background: #fff4dc; box-shadow: 0 4px 0 rgba(15, 16, 32, 0.45); }
#duck-touch .buttons { position: absolute; right: 20px; bottom: 28px; display: grid; grid-template-columns: 74px 74px; gap: 12px; pointer-events: auto; touch-action: none; }
#duck-touch button { width: 74px; height: 74px; border-radius: 50%; border: 3px solid #0f1020; font-family: inherit; font-size: 20px; letter-spacing: 1px; color: #0f1020; padding-top: 4px; box-shadow: 0 5px 0 #0f1020; touch-action: none; }
#duck-touch button:active { transform: translateY(3px); box-shadow: 0 2px 0 #0f1020; }
#duck-touch .restart { position: absolute; right: 20px; bottom: 208px; width: 160px; height: 42px; border-radius: 21px; background: rgba(15, 16, 32, 0.75); color: #fff4dc; border: 2px solid rgba(255, 244, 220, 0.35); box-shadow: 0 4px 0 rgba(15, 16, 32, 0.45); font-size: 19px; pointer-events: auto; }
#duck-touch .hint { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); color: rgba(255, 244, 220, 0.85); font-size: 15px; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); white-space: nowrap; }
`;

class TouchControls {
  /** Stick as a gamepad reports it: x right, y forward is -1. */
  readonly stick = { x: 0, y: 0 };
  private pressed = new Set<TouchButton>();
  private root: HTMLDivElement | null = null;
  private knob: HTMLDivElement | null = null;
  private pointerId: number | null = null;
  private visible = false;

  /** True on devices that have no fine pointer, or when `?touch=1` asks. */
  static wanted(): boolean {
    if (typeof window === 'undefined') return false;
    if (new URLSearchParams(location.search).get('touch') === '1') return true;
    if (headsetLanding()) return false; // a controller ray is not a finger: the landing page needs none
    return window.matchMedia?.('(pointer: coarse)').matches ?? false;
  }

  install(): void {
    if (this.root || typeof document === 'undefined' || !TouchControls.wanted()) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const root = document.createElement('div');
    root.id = 'duck-touch';
    root.hidden = true;
    const stick = document.createElement('div');
    stick.className = 'stick';
    const knob = document.createElement('div');
    knob.className = 'knob';
    stick.append(knob);
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    for (const spec of BUTTONS) {
      const button = document.createElement('button');
      button.textContent = spec.label;
      button.style.background = spec.color;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.pressed.add(spec.id);
      });
      buttons.append(button);
    }
    const restart = document.createElement('button');
    restart.className = 'restart';
    restart.textContent = 'RESTART';
    restart.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.pressed.add('restart');
    });
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'DRAG THE STICK TO WALK';
    root.append(stick, buttons, restart, hint);
    document.body.append(root);
    this.root = root;
    this.knob = knob;

    const centre = () => {
      const rect = stick.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const move = (event: PointerEvent) => {
      const c = centre();
      let dx = event.clientX - c.x;
      let dy = event.clientY - c.y;
      const length = Math.hypot(dx, dy);
      if (length > STICK_RADIUS) {
        dx *= STICK_RADIUS / length;
        dy *= STICK_RADIUS / length;
      }
      this.stick.x = dx / STICK_RADIUS;
      this.stick.y = dy / STICK_RADIUS; // screen down = stick down = backwards
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const release = () => {
      this.pointerId = null;
      this.stick.x = 0;
      this.stick.y = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.pointerId = event.pointerId;
      stick.setPointerCapture(event.pointerId);
      move(event);
    });
    stick.addEventListener('pointermove', (event) => {
      if (event.pointerId === this.pointerId) move(event);
    });
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
    this.setVisible(true);
  }

  /** Shown outside XR only. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.root) this.root.hidden = !visible;
    if (!visible) {
      this.stick.x = 0;
      this.stick.y = 0;
    }
  }

  get shown(): boolean {
    return this.visible && this.root != null;
  }

  /** True once per press. */
  take(button: TouchButton): boolean {
    return this.pressed.delete(button);
  }
}

export const touchControls = new TouchControls();
