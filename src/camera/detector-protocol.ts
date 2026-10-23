// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/** Messages between the main thread and the duck detector worker. */

export interface DetectorInit {
  type: 'init';
  /** Absolute URL of the ONNX model (input [1,3,S,S], output [1,5,N]). */
  modelUrl: string;
  inputSize: number;
  /** Minimum score to keep a box (Ultralytics' default is 0.25). */
  minScore: number;
}

export interface DetectorFrame {
  type: 'detect';
  id: number;
  /** Ownership moves to the worker, which closes it. */
  frame: ImageBitmap;
}

export type DetectorIn = DetectorInit | DetectorFrame;

/** A box in normalised source-image coordinates (0..1, top-left origin). */
export interface Detection {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface DetectorReady {
  type: 'ready';
  backend: string;
  threads: number;
  loadMs: number;
  /** The first inference is slow (kernel set-up); measured separately. */
  warmupMs: number;
}

export interface DetectorResult {
  type: 'result';
  id: number;
  detections: Detection[];
  /** Letterbox + pixel conversion, network, and box decoding + NMS (ms). */
  preMs: number;
  inferMs: number;
  postMs: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface DetectorError {
  type: 'error';
  id?: number;
  message: string;
}

export type DetectorOut = DetectorReady | DetectorResult | DetectorError;
