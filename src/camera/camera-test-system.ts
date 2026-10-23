// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 0 camera test. Opens the headset camera (getUserMedia, once the
 * player allows it), runs the community Microduck detector on as many frames
 * as it can in a worker, and reports detections per second, timings and how
 * often a duck was seen. The self-test runs the same detector on two press
 * photos, for machines without a camera (like the desktop emulator).
 */
import { createSystem } from '@iwsdk/core';
import type {
  Detection,
  DetectorIn,
  DetectorOut,
  DetectorReady,
  DetectorResult,
} from './detector-protocol.js';

const MODEL_FILE = 'models/dev-only/microduck_yolo11n_320.onnx';
const SELF_TEST_PHOTOS = ['models/dev-only/watching.jpg', 'models/dev-only/kickabout.jpg'];
const INPUT_SIZE = 320;
const MIN_SCORE = 0.25;
const SELF_TEST_RUNS = 8;
const WINDOW_MS = 2000;
const LOG_PERIOD_MS = 5000;

const publicUrl = (file: string): string =>
  new URL(`${import.meta.env.BASE_URL}${file}`, document.baseURI).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describe(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permission denied';
    if (err.name === 'NotFoundError') return 'no camera found';
    if (err.name === 'NotReadableError') return 'camera busy in another app';
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

interface Pending {
  resolve: (result: DetectorResult) => void;
  reject: (err: Error) => void;
}

export class CameraTestSystem extends createSystem({}) {
  /** One line for the lab panel. */
  summary = 'Camera: off';
  running = false;
  busy = false;

  private worker: Worker | null = null;
  private ready: Promise<DetectorReady> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  private windowStart = 0;
  private frames = 0;
  private framesWithDuck = 0;
  private newCameraFrames = 0;
  private lastVideoTime = -1;
  private workMs = 0;
  private inferMs = 0;
  private bestScore = 0;
  private lastLog = 0;

  init(): void {
    this.cleanupFuncs.push(
      () => this.stopCamera(),
      () => this.worker?.terminate(),
    );
  }

  async toggleCamera(): Promise<void> {
    if (this.running) {
      this.stopCamera();
    } else {
      await this.startCamera();
    }
  }

  async startCamera(): Promise<void> {
    if (this.running || this.busy) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.summary = 'Camera: this browser has no camera access';
      return;
    }
    this.busy = true;
    this.summary = 'Camera: loading the detector...';
    try {
      const ready = await this.ensureDetector();
      this.summary = 'Camera: asking for permission...';
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = this.stream;
      await video.play();
      this.video = video;
      this.running = true;
      const track = this.stream.getVideoTracks()[0];
      const s = track?.getSettings();
      console.info(
        `[camera] "${track?.label}" ${s?.width}x${s?.height} at ${s?.frameRate} fps; ` +
          `detector on ${ready.backend} x${ready.threads} (load ${ready.loadMs.toFixed(0)} ms, ` +
          `first run ${ready.warmupMs.toFixed(0)} ms)`,
      );
      this.summary = 'Camera: running, measuring...';
      this.resetWindow();
      void this.loop();
    } catch (err) {
      this.stopCamera();
      this.summary = `Camera: ${describe(err)}`;
      console.warn('[camera]', err);
    } finally {
      this.busy = false;
    }
  }

  stopCamera(): void {
    const wasRunning = this.running;
    this.running = false;
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (wasRunning) {
      this.summary = this.summary.replace(/^Camera:/u, 'Camera (stopped):');
    }
  }

  /** Runs the detector on the two press photos and reports speed and hits. */
  async runSelfTest(): Promise<void> {
    if (this.running || this.busy) {
      return;
    }
    this.busy = true;
    this.summary = 'Self-test: loading the detector...';
    try {
      const ready = await this.ensureDetector();
      let found = 0;
      let totalMs = 0;
      let runs = 0;
      for (const photo of SELF_TEST_PHOTOS) {
        const res = await fetch(publicUrl(photo));
        if (!res.ok) {
          throw new Error(`${photo}: HTTP ${res.status}`);
        }
        const full = await createImageBitmap(await res.blob());
        const scale = INPUT_SIZE / Math.max(full.width, full.height);
        const small = await createImageBitmap(full, {
          resizeWidth: Math.round(full.width * scale),
          resizeHeight: Math.round(full.height * scale),
          resizeQuality: 'medium',
        });
        full.close();
        let top: Detection | undefined;
        for (let r = 0; r < SELF_TEST_RUNS; r++) {
          const result = await this.detect(await createImageBitmap(small));
          totalMs += result.preMs + result.inferMs + result.postMs;
          runs++;
          top = result.detections[0];
        }
        small.close();
        if (top) {
          found++;
        }
        console.info(
          `[camera] self-test ${photo.split('/').pop()}: ` +
            (top
              ? `duck ${top.score.toFixed(2)} at x ${top.x.toFixed(2)} y ${top.y.toFixed(2)} ` +
                `w ${top.w.toFixed(2)} h ${top.h.toFixed(2)}`
              : 'no duck'),
        );
      }
      const perFrame = totalMs / runs;
      this.summary =
        `Self-test: duck in ${found}/${SELF_TEST_PHOTOS.length} photos, ` +
        `${perFrame.toFixed(0)} ms per frame (${(1000 / perFrame).toFixed(1)} det/s, ${ready.backend})`;
      console.info(`[camera] ${this.summary}`);
    } catch (err) {
      this.summary = `Self-test: ${describe(err)}`;
      console.warn('[camera]', err);
    } finally {
      this.busy = false;
    }
  }

  private async loop(): Promise<void> {
    try {
      while (this.running && this.video) {
        const video = this.video;
        if (video.readyState < 2 || video.videoWidth === 0) {
          await sleep(30);
          continue;
        }
        if (video.currentTime !== this.lastVideoTime) {
          this.lastVideoTime = video.currentTime;
          this.newCameraFrames++;
        }
        const scale = INPUT_SIZE / Math.max(video.videoWidth, video.videoHeight);
        const frame = await createImageBitmap(video, {
          resizeWidth: Math.round(video.videoWidth * scale),
          resizeHeight: Math.round(video.videoHeight * scale),
          resizeQuality: 'low',
        });
        this.record(await this.detect(frame));
      }
    } catch (err) {
      this.stopCamera();
      this.summary = `Camera: stopped, ${describe(err)}`;
      console.warn('[camera]', err);
    }
  }

  private record(result: DetectorResult): void {
    this.frames++;
    this.workMs += result.preMs + result.inferMs + result.postMs;
    this.inferMs += result.inferMs;
    const top = result.detections[0];
    if (top) {
      this.framesWithDuck++;
      this.bestScore = Math.max(this.bestScore, top.score);
    }
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) {
      return;
    }
    const rate = (this.frames * 1000) / elapsed;
    const cameraFps = (this.newCameraFrames * 1000) / elapsed;
    const seen = Math.round((100 * this.framesWithDuck) / this.frames);
    this.summary =
      `Camera: ${rate.toFixed(1)} det/s (camera ${cameraFps.toFixed(0)} fps), ` +
      `${(this.workMs / this.frames).toFixed(0)} ms/frame, duck in ${seen}% ` +
      `(best ${this.bestScore.toFixed(2)})`;
    if (now - this.lastLog >= LOG_PERIOD_MS) {
      this.lastLog = now;
      console.info(
        `[camera] ${this.summary}; network ${(this.inferMs / this.frames).toFixed(1)} ms` +
          (top
            ? `; top box x ${top.x.toFixed(2)} y ${top.y.toFixed(2)} w ${top.w.toFixed(2)} h ${top.h.toFixed(2)}`
            : ''),
      );
    }
    this.resetWindow();
  }

  private resetWindow(): void {
    this.windowStart = performance.now();
    this.frames = 0;
    this.framesWithDuck = 0;
    this.newCameraFrames = 0;
    this.workMs = 0;
    this.inferMs = 0;
    this.bestScore = 0;
  }

  private detect(frame: ImageBitmap): Promise<DetectorResult> {
    const worker = this.worker;
    if (!worker) {
      frame.close();
      return Promise.reject(new Error('detector not started'));
    }
    const id = ++this.nextId;
    return new Promise<DetectorResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg: DetectorIn = { type: 'detect', id, frame };
      worker.postMessage(msg, [frame]);
    });
  }

  private ensureDetector(): Promise<DetectorReady> {
    if (this.ready) {
      return this.ready;
    }
    const modelUrl = publicUrl(MODEL_FILE);
    const worker = new Worker(new URL('./duck-detector.worker.ts', import.meta.url), {
      type: 'module',
      name: 'duck-detector',
    });
    this.worker = worker;
    const ready = new Promise<DetectorReady>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<DetectorOut>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          resolve(msg);
        } else if (msg.type === 'result') {
          this.pending.get(msg.id)?.resolve(msg);
          this.pending.delete(msg.id);
        } else if (msg.id !== undefined) {
          this.pending.get(msg.id)?.reject(new Error(msg.message));
          this.pending.delete(msg.id);
        } else {
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (event: ErrorEvent) => reject(new Error(event.message));
    });
    const init: DetectorIn = {
      type: 'init',
      modelUrl,
      inputSize: INPUT_SIZE,
      minScore: MIN_SCORE,
    };
    worker.postMessage(init);
    this.ready = ready.catch((err: unknown) => {
      // Allow a retry after a failed start.
      worker.terminate();
      this.worker = null;
      this.ready = null;
      throw err;
    });
    return this.ready;
  }
}
