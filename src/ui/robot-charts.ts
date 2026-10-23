// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The robot panel's three live charts, drawn on 2D canvases and shown as
 * textures in its UIKit <img> elements:
 *   - policy output: the walking policy's 14 joint commands over the last
 *     four seconds as a heat map (legs and head grouped),
 *   - IMU and feet: gyro traces, and a gait strip of each foot's contact,
 *   - servos: each joint's angle against its target, and its torque.
 * Data comes from the sim's telemetry ring (TEL layout in duck-constants.ts).
 */
import { CanvasTexture, SRGBColorSpace } from '@iwsdk/core';
import { NUM_JOINTS, TEL } from '../duck/duck-constants.js';
import type { TelemetryRing } from '../duck/sim-client.js';

const INK2 = '#1c1d36';
const CREAM = '#fff4dc';
const DIM = 'rgba(255, 244, 220, 0.55)';
const FAINT = 'rgba(255, 244, 220, 0.12)';
const YELLOW = '#ffcf3f';
const ORANGE = '#ff7a45';
const MINT = '#3de0b8';
const SKY = '#6fb7ff';
const BERRY = '#ff5c8a';
const FONT = 'DuckBebas, "Arial Narrow", sans-serif';

/** Rows top to bottom: left leg, right leg, head (indices into JOINT_NAMES). */
const ROWS = [0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 5, 6, 7, 8];
const ROW_LABELS = [
  'L HIP YAW',
  'L HIP ROLL',
  'L HIP PITCH',
  'L KNEE',
  'L ANKLE',
  'R HIP YAW',
  'R HIP ROLL',
  'R HIP PITCH',
  'R KNEE',
  'R ANKLE',
  'NECK PITCH',
  'HEAD PITCH',
  'HEAD YAW',
  'HEAD ROLL',
];
const GROUPS: { label: string; from: number; count: number; gap: number }[] = [
  { label: 'L LEG', from: 0, count: 5, gap: 0 },
  { label: 'R LEG', from: 5, count: 5, gap: 4 },
  { label: 'HEAD', from: 10, count: 4, gap: 8 },
];
/** Policy outputs (rad offsets) reach full colour at this size. */
const ACTION_SCALE = 0.5;
/** Joint offsets from the standing pose shown across the servo track (rad). */
const SERVO_RANGE = 1.0;
/** Gyro range of the IMU chart (rad/s). */
const GYRO_RANGE = 4;
/** A foot carrying more than this (N) counts as on the ground. */
const STANCE_N = 0.4;

let fontRequested = false;
/** Loads the HUD's display face for canvas text (once; charts use a fallback until it arrives). */
function requestFont(): void {
  if (fontRequested || typeof FontFace === 'undefined') return;
  fontRequested = true;
  const face = new FontFace('DuckBebas', `url(${import.meta.env.BASE_URL}fonts/BebasNeue-Regular.ttf)`);
  face
    .load()
    .then((loaded) => document.fonts.add(loaded))
    .catch(() => {
      // keep the fallback face
    });
}

function makeCanvas(width: number, height: number): { ctx: CanvasRenderingContext2D; texture: CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { ctx, texture };
}

/** 256-entry diverging colour map: sky (negative), ink (zero), yellow (positive). */
function divergingLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const ink = [0x1c, 0x1d, 0x36];
  const neg = [0x6f, 0xb7, 0xff];
  const pos = [0xff, 0xcf, 0x3f];
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * 2 - 1;
    const end = t < 0 ? neg : pos;
    const a = Math.min(1, Math.abs(t)) ** 0.8;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = ink[c] + (end[c] - ink[c]) * a;
  }
  return lut;
}

export class RobotCharts {
  readonly actions: CanvasTexture;
  readonly imu: CanvasTexture;
  readonly servos: CanvasTexture;
  private readonly actionsCtx: CanvasRenderingContext2D;
  private readonly imuCtx: CanvasRenderingContext2D;
  private readonly servosCtx: CanvasRenderingContext2D;
  private readonly heat: ImageData;
  private readonly heatCanvas: HTMLCanvasElement;
  private readonly heatCtx: CanvasRenderingContext2D;
  private readonly lut = divergingLut();
  private readonly window: number;

  constructor(samples: number) {
    requestFont();
    this.window = samples;
    const actions = makeCanvas(552, 168);
    const imu = makeCanvas(552, 144);
    const servos = makeCanvas(552, 352);
    this.actions = actions.texture;
    this.actionsCtx = actions.ctx;
    this.imu = imu.texture;
    this.imuCtx = imu.ctx;
    this.servos = servos.texture;
    this.servosCtx = servos.ctx;
    this.heatCanvas = document.createElement('canvas');
    this.heatCanvas.width = samples;
    this.heatCanvas.height = NUM_JOINTS;
    this.heatCtx = this.heatCanvas.getContext('2d')!;
    this.heat = this.heatCtx.createImageData(samples, NUM_JOINTS);
    this.clear();
  }

  /** Back to the "waiting" cards (a new duck, or the stream was off). */
  clear(): void {
    this.drawEmpty(this.actionsCtx, 'POLICY OUTPUT');
    this.drawEmpty(this.imuCtx, 'IMU AND FEET');
    this.drawEmpty(this.servosCtx, 'SERVOS');
    this.actions.needsUpdate = true;
    this.imu.needsUpdate = true;
    this.servos.needsUpdate = true;
  }

  dispose(): void {
    this.actions.dispose();
    this.imu.dispose();
    this.servos.dispose();
  }

  private drawEmpty(ctx: CanvasRenderingContext2D, what: string): void {
    const { width, height } = ctx.canvas;
    ctx.fillStyle = INK2;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = DIM;
    ctx.font = `24px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${what}: WAITING FOR DATA`, width / 2, height / 2);
  }

  /** Heat map of the 14 policy outputs over the telemetry window, newest on the right. */
  drawActions(ring: TelemetryRing): void {
    const ctx = this.actionsCtx;
    const { width, height } = ctx.canvas;
    const n = Math.min(ring.count, this.window);
    if (n === 0) return;
    const pixels = this.heat.data;
    pixels.fill(0);
    for (let back = 0; back < n; back++) {
      const o = ring.offset(back);
      const x = this.window - 1 - back;
      for (let r = 0; r < NUM_JOINTS; r++) {
        const v = ring.data[o + TEL.action + ROWS[r]] / ACTION_SCALE;
        const i = Math.max(0, Math.min(255, Math.round((v * 0.5 + 0.5) * 255)));
        const p = (r * this.window + x) * 4;
        pixels[p] = this.lut[i * 3];
        pixels[p + 1] = this.lut[i * 3 + 1];
        pixels[p + 2] = this.lut[i * 3 + 2];
        pixels[p + 3] = 255;
      }
    }
    this.heatCtx.putImageData(this.heat, 0, 0);
    ctx.fillStyle = INK2;
    ctx.fillRect(0, 0, width, height);
    const left = 74;
    const top = 6;
    const rowH = (height - top * 2 - 8) / NUM_JOINTS;
    ctx.imageSmoothingEnabled = false;
    ctx.font = `22px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const group of GROUPS) {
      const y = top + group.from * rowH + group.gap;
      ctx.drawImage(this.heatCanvas, 0, group.from, this.window, group.count, left, y, width - left - 8, group.count * rowH);
      ctx.fillStyle = CREAM;
      ctx.fillText(group.label, 10, y + (group.count * rowH) / 2 + 1);
    }
    // One-second ticks along the bottom.
    ctx.fillStyle = FAINT;
    for (let s = 1; s < 4; s++) {
      const x = left + ((width - left - 8) * s) / 4;
      ctx.fillRect(x, height - 6, 2, 6);
    }
    this.actions.needsUpdate = true;
  }

  /** Gyro traces and the gait strip (when each foot is on the ground). */
  drawImu(ring: TelemetryRing): void {
    const ctx = this.imuCtx;
    const { width, height } = ctx.canvas;
    const n = Math.min(ring.count, this.window);
    if (n === 0) return;
    ctx.fillStyle = INK2;
    ctx.fillRect(0, 0, width, height);
    const left = 74;
    const right = width - 8;
    const plotTop = 8;
    const plotBottom = 88;
    const mid = (plotTop + plotBottom) / 2;
    const xAt = (back: number) => right - ((right - left) * back) / (this.window - 1);
    ctx.fillStyle = FAINT;
    ctx.fillRect(left, mid, right - left, 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = CREAM;
    ctx.font = `22px ${FONT}`;
    ctx.fillText('GYRO', 10, mid - 12);
    ctx.fillStyle = DIM;
    ctx.font = `17px ${FONT}`;
    ctx.fillText(`+-${GYRO_RANGE} RAD/S`, 10, mid + 12);
    const colors = [BERRY, MINT, SKY];
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (let axis = 0; axis < 3; axis++) {
      ctx.strokeStyle = colors[axis];
      ctx.beginPath();
      for (let back = n - 1; back >= 0; back--) {
        const o = ring.offset(back);
        const v = Math.max(-1, Math.min(1, ring.data[o + TEL.gyro + axis] / GYRO_RANGE));
        const x = xAt(back);
        const y = mid - v * ((plotBottom - plotTop) / 2);
        if (back === n - 1) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Gait strip: a filled bar wherever the foot carries weight.
    for (let foot = 0; foot < 2; foot++) {
      const y = foot === 0 ? 100 : 122;
      ctx.fillStyle = CREAM;
      ctx.font = `20px ${FONT}`;
      ctx.fillText(foot === 0 ? 'L FOOT' : 'R FOOT', 10, y + 9);
      ctx.fillStyle = FAINT;
      ctx.fillRect(left, y, right - left, 16);
      ctx.fillStyle = foot === 0 ? YELLOW : ORANGE;
      let runStart = -1;
      for (let back = n - 1; back >= -1; back--) {
        const down = back >= 0 && ring.data[ring.offset(back) + TEL.feet + foot] > STANCE_N;
        if (down && runStart < 0) runStart = back;
        if (!down && runStart >= 0) {
          const x0 = xAt(runStart);
          const x1 = xAt(back + 1);
          ctx.fillRect(x0, y, Math.max(2, x1 - x0), 16);
          runStart = -1;
        }
      }
    }
    this.imu.needsUpdate = true;
  }

  /** Each joint: angle (dot) and target (tick) across its track, and its torque bar. */
  drawServos(ring: TelemetryRing, standing: readonly number[]): void {
    const ctx = this.servosCtx;
    const { width, height } = ctx.canvas;
    const o = ring.offset(0);
    if (o < 0) return;
    ctx.fillStyle = INK2;
    ctx.fillRect(0, 0, width, height);
    const trackLeft = 142;
    const trackRight = 420;
    const torqueLeft = 438;
    const torqueRight = width - 10;
    const rowH = (height - 10) / NUM_JOINTS;
    const xOf = (offset: number) =>
      trackLeft + ((Math.max(-1, Math.min(1, offset / SERVO_RANGE)) + 1) / 2) * (trackRight - trackLeft);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `22px ${FONT}`;
    for (let r = 0; r < NUM_JOINTS; r++) {
      const j = ROWS[r];
      const y = 4 + r * rowH + rowH / 2 + (r >= 10 ? 4 : r >= 5 ? 2 : 0);
      const angle = ring.data[o + TEL.q + j] - standing[j];
      const target = ring.data[o + TEL.target + j] - standing[j];
      const torque = Math.abs(ring.data[o + TEL.force + j]);
      ctx.fillStyle = r >= 10 ? DIM : CREAM;
      ctx.fillText(ROW_LABELS[r], 10, y + 1);
      // Track, with the standing pose in the middle.
      ctx.fillStyle = FAINT;
      ctx.fillRect(trackLeft, y - 2, trackRight - trackLeft, 4);
      ctx.fillRect((trackLeft + trackRight) / 2 - 1, y - 7, 2, 14);
      // The gap between angle and target is the servo's tracking error.
      const xa = xOf(angle);
      const xt = xOf(target);
      ctx.fillStyle = Math.abs(target - angle) > 0.12 ? ORANGE : 'rgba(111, 183, 255, 0.45)';
      ctx.fillRect(Math.min(xa, xt), y - 3, Math.max(2, Math.abs(xt - xa)), 6);
      ctx.fillStyle = YELLOW;
      ctx.fillRect(xt - 2, y - 8, 4, 16);
      ctx.fillStyle = CREAM;
      ctx.beginPath();
      ctx.arc(xa, y, 5, 0, Math.PI * 2);
      ctx.fill();
      // Torque as a share of the servo's limit.
      ctx.fillStyle = FAINT;
      ctx.fillRect(torqueLeft, y - 5, torqueRight - torqueLeft, 10);
      ctx.fillStyle = torque > 0.8 ? BERRY : torque > 0.5 ? ORANGE : MINT;
      ctx.fillRect(torqueLeft, y - 5, (torqueRight - torqueLeft) * Math.min(1, torque), 10);
    }
    this.servos.needsUpdate = true;
  }
}
