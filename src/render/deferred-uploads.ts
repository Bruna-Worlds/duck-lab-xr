// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Texture uploads in a Quest headset session. super-three 0.185.0 (IWSDK
 * 1.1.0-rc.1) defers texture uploads while it draws both eyes in one
 * multiview pass, and nothing ever flushes them or turns deferral off. So in
 * a headset every texture first uploaded or redrawn after the session starts
 * never reaches the GPU: the controller ray's dot stayed invisible, Pip cam's
 * charts stayed empty, and text first drawn in the headset stayed blank.
 *
 * IWSDK 1.1.0-rc.2 fixes this (runtime/deferred-texture-uploads.js, GitHub
 * #55); this is the same fix, applied from outside. The renderer keeps its
 * WebGLTextures private, so it is caught while IWSDK builds the renderer
 * (WebGLTextures assigns `setDeferTextureUploads` as an own property, which a
 * one-shot setter on Object.prototype sees), and every render that deferred
 * uploads flushes them afterwards. Delete this module when upgrading IWSDK.
 */
import type { WebGLRenderer } from '@iwsdk/core';

const HOOK = 'setDeferTextureUploads';

interface DeferredTextures {
  setDeferTextureUploads(defer: boolean): void;
  runDeferredUploads(): void;
}

/**
 * Call right before World.create, which builds the renderer. Returns a
 * function to call once it has: it removes the hook (if nothing tripped it)
 * and returns the renderer's WebGLTextures, or null.
 */
export function catchRendererTextures(): () => DeferredTextures | null {
  let caught: DeferredTextures | null = null;
  const release = hook((textures) => {
    caught = textures;
  });
  return () => {
    release();
    return caught;
  };
}

/**
 * After each render() that turned deferral on, upload what it deferred; once
 * the outermost render() is over, stop deferring, so uploads outside the
 * multiview pass (and after the session) happen at once. Renders that never
 * defer are untouched.
 */
export function flushDeferredUploads(renderer: WebGLRenderer, initial: DeferredTextures): void {
  let textures = initial;
  let deferred = false; // turned on since the last outermost render()
  const track = (caught: DeferredTextures): void => {
    textures = caught;
    deferred = false;
    const setDefer = caught.setDeferTextureUploads;
    caught.setDeferTextureUploads = (defer: boolean) => {
      deferred ||= defer;
      setDefer(defer);
    };
  };
  track(initial);
  let depth = 0;
  const render = renderer.render;
  renderer.render = function (this: WebGLRenderer, ...args: Parameters<WebGLRenderer['render']>) {
    depth++;
    try {
      render.apply(this, args);
    } finally {
      depth--;
    }
    if (deferred) {
      textures.runDeferredUploads();
      if (depth === 0) {
        textures.setDeferTextureUploads(false);
        deferred = false;
      }
    }
  };
  // A restored context gets a new WebGLTextures from the renderer's own listener; capture listeners run first.
  renderer.domElement.addEventListener(
    'webglcontextrestored',
    () => {
      const release = hook(track);
      setTimeout(release);
    },
    { capture: true },
  );
}

/** A one-shot setter for HOOK on Object.prototype; returns a function that removes it if it has not fired. */
function hook(onCatch: (textures: DeferredTextures) => void): () => void {
  const prototype = Object.prototype as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(prototype, HOOK)) return () => {};
  const release = (): void => {
    if (Object.getOwnPropertyDescriptor(prototype, HOOK)?.set === set) delete prototype[HOOK];
  };
  function set(this: Record<string, unknown>, value: unknown): void {
    release();
    // The same own data property a plain assignment makes.
    Object.defineProperty(this, HOOK, { value, writable: true, enumerable: true, configurable: true });
    if (typeof value === 'function' && typeof this.runDeferredUploads === 'function') {
      onCatch(this as unknown as DeferredTextures);
    }
  }
  Object.defineProperty(prototype, HOOK, { set, configurable: true });
  return release;
}
