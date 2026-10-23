// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * On-screen controls for phones and tablets (and any pointer-only device): a
 * thumb stick in the bottom left corner. The moves and
 * Restart are buttons on the menu, and dragging the room turns the camera
 * (src/ui/orbit-camera-system.ts). Plain DOM over the canvas, shown only
 * outside XR. The duck system reads `stick` every frame. Desktop keeps the
 * keyboard (WASD or arrows, J K L I N, R); `?touch=1` forces the overlay
 * there too.
 */
import { headsetLanding } from '../ui/page-mode.js';

const STICK_RADIUS = 52; // px of knob travel
/** The stick's size and its margins from the bottom left corner (px): the HUD keeps clear of it. */
export const STICK_SIZE_PX = 150;
const STICK_LEFT_PX = 24;
const STICK_BOTTOM_PX = 28;
/** How far up from the bottom, and right from the left, the stick reaches (px). */
export const STICK_ZONE_PX = STICK_BOTTOM_PX + STICK_SIZE_PX;
export const STICK_RIGHT_PX = STICK_LEFT_PX + STICK_SIZE_PX + 16;

const CSS = `
@font-face { font-family: DuckBebas; src: url(${import.meta.env.BASE_URL}fonts/BebasNeue-Regular.ttf); }
#duck-touch { position: fixed; inset: 0; pointer-events: none; z-index: 20; font-family: DuckBebas, system-ui, sans-serif; letter-spacing: 1px; user-select: none; -webkit-user-select: none; }
#duck-touch[hidden] { display: none; }
#duck-touch .stick { position: absolute; left: ${STICK_LEFT_PX}px; bottom: ${STICK_BOTTOM_PX}px; width: ${STICK_SIZE_PX}px; height: ${STICK_SIZE_PX}px; border-radius: 50%; background: rgba(15, 16, 32, 0.55); border: 2px solid rgba(255, 244, 220, 0.3); box-shadow: 0 6px 0 rgba(15, 16, 32, 0.35); pointer-events: auto; touch-action: none; }
#duck-touch .knob { position: absolute; left: 50%; top: 50%; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%; background: #fff4dc; box-shadow: 0 4px 0 rgba(15, 16, 32, 0.45); }
`;

class TouchControls {
  /** Stick as a gamepad reports it: x right, y forward is -1. */
  readonly stick = { x: 0, y: 0 };
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
    root.append(stick);
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

}

export const touchControls = new TouchControls();
