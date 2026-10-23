// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The 2D page in a headset's own browser (Quest Browser and the like) is a
 * landing page: its job is Enter MR / Enter VR, so the menu shows large enough
 * for a controller ray, and the touch controls, the move bar and the dev lab
 * panel stay hidden (there is no stick or keyboard to play with there).
 * `?landing=1` previews that layout on a desktop.
 */
export function headsetLanding(): boolean {
  if (typeof navigator === 'undefined' || typeof location === 'undefined') return false;
  return /OculusBrowser|PicoBrowser|Wolvic/i.test(hostUserAgent()) || new URLSearchParams(location.search).has('landing');
}

/**
 * The browser's own user agent. In development the emulator (IWER) reports
 * the emulated headset's; IWSDK keeps the real one, read before the emulator
 * installed.
 */
export function hostUserAgent(): string {
  if (typeof navigator === 'undefined') return '';
  const host = (globalThis as { __IWSDK_HOST_BROWSER_ENVIRONMENT?: { userAgent?: string } }).__IWSDK_HOST_BROWSER_ENVIRONMENT;
  return host?.userAgent ?? navigator.userAgent;
}
