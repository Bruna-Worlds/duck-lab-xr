// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Development only: tidies IWER's photoreal emulated room (IWER is IWSDK's
 * browser XR emulator). Its living room has a robot vacuum that drives
 * around the floor, but the vacuum is in neither the emulated room scan nor
 * the emulated depth, so Pip walks straight through it. Hiding it keeps the
 * emulated room honest about what the duck can sense. A real headset never
 * loads this room.
 */
const HIDDEN = ['robot'];

type EmulatedRoot = { getObjectByName(name: string): { visible: boolean } | undefined };

function emulatedRoom(): EmulatedRoot | null {
  const mcp = (globalThis as { IWER_MCP?: { device?: { sem?: { sceneEnvironment?: { root?: EmulatedRoot } } } } }).IWER_MCP;
  return mcp?.device?.sem?.sceneEnvironment?.root ?? null;
}

/** Hides the emulated room's moving decoration whenever a room is loaded. */
export function tidyEmulatedRoom(): void {
  setInterval(() => {
    const root = emulatedRoom();
    if (!root) return;
    for (const name of HIDDEN) {
      const object = root.getObjectByName(name);
      if (object?.visible) object.visible = false;
    }
  }, 1000);
}
