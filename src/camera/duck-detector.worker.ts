// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck detector worker: runs a single-class YOLO-style ONNX model (the
 * community Microduck detector) on camera frames with onnxruntime-web.
 *
 * Pre-processing matches Ultralytics: letterbox to a square with grey 114,
 * RGB scaled to 0..1, CHW. The output [1, 5, N] holds centre x, centre y,
 * width, height and score for N anchors; boxes are filtered by score and
 * de-duplicated with non-maximum suppression.
 */
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type {
  Detection,
  DetectorFrame,
  DetectorIn,
  DetectorInit,
  DetectorOut,
} from './detector-protocol.js';

interface WorkerScope {
  onmessage: ((event: MessageEvent<DetectorIn>) => void) | null;
  postMessage(message: DetectorOut): void;
  location: { href: string };
  crossOriginIsolated?: boolean;
}
const scope = self as unknown as WorkerScope;

const IOU_LIMIT = 0.5;
const MAX_BOXES = 10;

let session: ort.InferenceSession | null = null;
let tensor: ort.Tensor | null = null;
let pixels = new Float32Array(0);
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let size = 320;
let minScore = 0.25;

async function init(msg: DetectorInit): Promise<void> {
  const t0 = performance.now();
  size = msg.inputSize;
  minScore = msg.minScore;
  ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, scope.location.href).href };
  // Threads need SharedArrayBuffer, which needs cross-origin isolation.
  const threads = scope.crossOriginIsolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1;
  ort.env.wasm.numThreads = threads;
  const res = await fetch(msg.modelUrl);
  if (!res.ok) {
    throw new Error(`detector model missing, HTTP ${res.status} (see public/models/README.md)`);
  }
  session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  pixels = new Float32Array(3 * size * size);
  tensor = new ort.Tensor('float32', pixels, [1, 3, size, size]);
  canvas = new OffscreenCanvas(size, size);
  context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('OffscreenCanvas 2D context unavailable');
  }
  const loadMs = performance.now() - t0;
  const w0 = performance.now();
  await session.run({ [session.inputNames[0]]: tensor });
  scope.postMessage({
    type: 'ready',
    backend: 'wasm',
    threads,
    loadMs,
    warmupMs: performance.now() - w0,
  });
}

async function detect(msg: DetectorFrame): Promise<void> {
  const frame = msg.frame;
  if (!session || !tensor || !context) {
    frame.close();
    throw new Error('detector not ready');
  }
  const t0 = performance.now();
  const sourceWidth = frame.width;
  const sourceHeight = frame.height;
  const scale = Math.min(size / sourceWidth, size / sourceHeight);
  const drawW = Math.round(sourceWidth * scale);
  const drawH = Math.round(sourceHeight * scale);
  const padX = Math.floor((size - drawW) / 2);
  const padY = Math.floor((size - drawH) / 2);
  context.fillStyle = 'rgb(114, 114, 114)';
  context.fillRect(0, 0, size, size);
  context.drawImage(frame, padX, padY, drawW, drawH);
  frame.close();
  const rgba = context.getImageData(0, 0, size, size).data;
  const plane = size * size;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    pixels[i] = rgba[p] / 255;
    pixels[plane + i] = rgba[p + 1] / 255;
    pixels[2 * plane + i] = rgba[p + 2] / 255;
  }
  const t1 = performance.now();
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const t2 = performance.now();

  const data = out[session.outputNames[0]].data as Float32Array;
  const anchors = data.length / 5;
  const candidates: Detection[] = [];
  for (let i = 0; i < anchors; i++) {
    const score = data[4 * anchors + i];
    if (score < minScore) {
      continue;
    }
    const cx = data[i];
    const cy = data[anchors + i];
    const bw = data[2 * anchors + i];
    const bh = data[3 * anchors + i];
    // Letterboxed pixels -> normalised source-image coordinates.
    candidates.push({
      x: (cx - bw / 2 - padX) / drawW,
      y: (cy - bh / 2 - padY) / drawH,
      w: bw / drawW,
      h: bh / drawH,
      score,
    });
  }
  const detections = nonMaxSuppression(candidates);
  scope.postMessage({
    type: 'result',
    id: msg.id,
    detections,
    preMs: t1 - t0,
    inferMs: t2 - t1,
    postMs: performance.now() - t2,
    sourceWidth,
    sourceHeight,
  });
}

function nonMaxSuppression(boxes: Detection[]): Detection[] {
  boxes.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const box of boxes) {
    if (kept.length >= MAX_BOXES) {
      break;
    }
    if (kept.every((k) => iou(k, box) <= IOU_LIMIT)) {
      kept.push(box);
    }
  }
  return kept;
}

function iou(a: Detection, b: Detection): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union > 0 ? overlap / union : 0;
}

scope.onmessage = (event: MessageEvent<DetectorIn>) => {
  const msg = event.data;
  const task = msg.type === 'init' ? init(msg) : detect(msg);
  task.catch((err: unknown) => {
    scope.postMessage({
      type: 'error',
      id: msg.type === 'detect' ? msg.id : undefined,
      message: String(err),
    });
  });
};
