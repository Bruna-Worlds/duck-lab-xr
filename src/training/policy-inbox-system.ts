// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy inbox: trained policy releases ("brains") coming back from the
 * computer, offered on the robot panel ("New brain ready"). Trying one swaps
 * the policies into the running sim (no reload); the choice is remembered,
 * and Revert goes back to the shipped policies.
 *
 * Two ways in:
 * - Linked (src/link/lab-link-system.ts): the trainer page the headset is
 *   paired with sends the brain it offers over their WebRTC link. Its files
 *   are kept in this browser's Cache Storage under policies/linked/<id>/,
 *   where the sim worker looks first, so a chosen brain survives a reload.
 * - Development: the trainer (tools/lab, tools/train/finetune.mjs) writes
 *   releases to public/policies/incoming/<id>/ and lists them in
 *   public/policies/incoming/index.json (duckdash.policies.v1); the dev
 *   server serves that folder and this system polls the index (only in
 *   development or with ?policyInbox=1, and not while linked).
 */
import { createSystem } from '@iwsdk/core';
import { DuckSystem } from '../duck/duck-system.js';
import type { BrainIndex, BrainRelease } from '../link/link-protocol.js';

const POLL_MS = 4000;
const CHOSEN_KEY = 'duckdash.brain';
const DISMISSED_KEY = 'duckdash.brain.dismissed';
/** Brains received over the link: their details (the files are in LINKED_CACHE). */
const LINKED_KEY = 'ducklab.linkedBrains';
const LINKED_CACHE = 'ducklab-brains';
const KEEP_LINKED = 6;

export type PolicyRelease = BrainRelease;

interface PolicyIndex extends BrainIndex {
  version: string;
}

const readStore = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStore = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage blocked
  }
};

export class PolicyInboxSystem extends createSystem({}) {
  /** Releases listed by the computer, newest first. */
  releases: PolicyRelease[] = [];
  /** A release waiting for the player's yes (shown on the robot panel). */
  offer: PolicyRelease | null = null;
  /** The release the duck runs, or null for the shipped policies. */
  current: PolicyRelease | null = null;
  /** What is happening, for the panel ("Loading room-tuned...", errors). */
  status = '';
  busy = false;
  /** Set by the link system: brains come over the link, so the dev index is not polled. */
  linkConnected = false;
  /** Brains received over the link and kept in this browser, newest first. */
  linked: PolicyRelease[] = [];
  private duck: DuckSystem | undefined;
  private polling = false;
  private enabled = false;
  private lastPoll = -Infinity;
  private chosenId: string | null = null;
  private restored = false;
  private restoredLinked = false;

  init(): void {
    this.duck = this.world.getSystem(DuckSystem);
    const params = new URLSearchParams(window.location.search);
    this.enabled = import.meta.env.DEV || params.get('policyInbox') === '1';
    // Development: ?demoReset=1 forgets the brain chosen and the offer dismissed (for repeatable demos).
    if (import.meta.env.DEV && params.has('demoReset')) {
      writeStore(CHOSEN_KEY, null);
      writeStore(DISMISSED_KEY, null);
    }
    try {
      const kept = JSON.parse(readStore(LINKED_KEY) ?? '[]') as PolicyRelease[];
      this.linked = Array.isArray(kept) ? kept.filter((r) => r && typeof r.id === 'string') : [];
    } catch {
      this.linked = [];
    }
    // A release chosen earlier comes back once it is known to still exist (a
    // deleted folder must not keep the duck from loading).
    this.chosenId = !params.has('policies') ? readStore(CHOSEN_KEY) : null;
  }

  private folder(id: string): string {
    if (this.linked.some((r) => r.id === id)) return linkedFolder(id);
    return `${import.meta.env.BASE_URL}policies/incoming/${encodeURIComponent(id)}/`;
  }

  update(): void {
    if (!this.restoredLinked) {
      this.restoredLinked = true;
      const chosen = this.chosenId ? this.linked.find((r) => r.id === this.chosenId) : undefined;
      if (chosen) {
        this.restored = true;
        void this.restoreLinked(chosen);
      }
    }
    if (!this.enabled || this.linkConnected) return;
    const now = performance.now();
    if (this.polling || now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    this.polling = true;
    void this.poll().finally(() => {
      this.polling = false;
    });
  }

  /** A brain chosen in an earlier visit, still in the cache: back on it. */
  private async restoreLinked(release: PolicyRelease): Promise<void> {
    if (await hasLinkedFiles(release.id)) {
      await this.accept(release, false);
    } else {
      this.linked = this.linked.filter((r) => r.id !== release.id);
      this.saveLinked();
      writeStore(CHOSEN_KEY, null);
      this.chosenId = null;
    }
  }

  private async poll(): Promise<void> {
    let index: PolicyIndex;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}policies/incoming/index.json`, { cache: 'no-store' });
      if (!res.ok) return;
      const text = await res.text();
      if (!text.trim().startsWith('{')) return; // the dev server's page fallback: no index yet
      index = JSON.parse(text) as PolicyIndex;
    } catch {
      return;
    }
    if (index.version !== 'duckdash.policies.v1' || !Array.isArray(index.releases)) return;
    if (this.linkConnected) return;
    this.releases = index.releases;
    // The running brain's details can change after it was accepted (the
    // trainer publishes it to the Hub, say): keep them current for FLASH BRAIN.
    const running = this.current ? this.releases.find((r) => r.id === this.current?.id) : undefined;
    if (running) this.current = running;
    if (!this.restored) {
      this.restored = true;
      const chosen = this.chosenId ? this.releases.find((r) => r.id === this.chosenId) : undefined;
      if (chosen) void this.accept(chosen, false);
      else if (this.chosenId) {
        // The chosen release is gone from the computer: stay on the shipped policies.
        writeStore(CHOSEN_KEY, null);
        this.chosenId = null;
      }
    }
    const active = index.active ? this.releases.find((r) => r.id === index.active) : undefined;
    this.offerIfNew(active ?? null);
  }

  /**
   * The paired trainer's brains arrived over the link: offer its active one,
   * asking for the files first when this browser does not have them.
   */
  fromTrainer(index: BrainIndex, request: (id: string) => void): void {
    this.releases = Array.isArray(index.releases) ? index.releases : [];
    const running = this.current ? this.releases.find((r) => r.id === this.current?.id) : undefined;
    if (running) {
      this.current = running;
      this.rememberLinked(running);
    }
    const active = index.active ? this.releases.find((r) => r.id === index.active) : undefined;
    if (!active) {
      this.offer = null;
      return;
    }
    if (active.id === this.current?.id || active.id === readStore(DISMISSED_KEY)) {
      this.offer = null;
      return;
    }
    if (this.linked.some((r) => r.id === active.id)) this.offerIfNew(active);
    else request(active.id);
  }

  /** A brain's files came over the link: keep them here and offer it. */
  async storeLinked(release: PolicyRelease, files: Map<string, Uint8Array>): Promise<void> {
    if (typeof caches === 'undefined') throw new Error('this browser cannot keep files (no Cache Storage)');
    const cache = await caches.open(LINKED_CACHE);
    const folder = linkedFolder(release.id);
    for (const [name, bytes] of files) {
      await cache.put(folder + encodeURIComponent(name), new Response(bytes as BlobPart, { headers: { 'content-type': 'application/octet-stream' } }));
    }
    this.rememberLinked(release);
    // Only the newest few stay: drop the files of the others (never the running one).
    const keep = new Set(this.linked.slice(0, KEEP_LINKED).map((r) => r.id));
    if (this.current) keep.add(this.current.id);
    for (const old of this.linked.filter((r) => !keep.has(r.id))) {
      for (const request of await cache.keys()) if (request.url.startsWith(linkedFolder(old.id))) await cache.delete(request);
    }
    this.linked = this.linked.filter((r) => keep.has(r.id));
    this.saveLinked();
    this.offerIfNew(release);
  }

  private rememberLinked(release: PolicyRelease): void {
    this.linked = [release, ...this.linked.filter((r) => r.id !== release.id)];
    this.saveLinked();
  }

  private saveLinked(): void {
    writeStore(LINKED_KEY, JSON.stringify(this.linked));
  }

  private offerIfNew(release: PolicyRelease | null): void {
    const dismissed = readStore(DISMISSED_KEY);
    this.offer = release && release.id !== this.current?.id && release.id !== dismissed ? release : null;
    // Development, ?acceptBrain: take the offer at once (headset tests where a tap cannot reach TRY IT).
    if (this.offer && import.meta.env.DEV && new URLSearchParams(window.location.search).has('acceptBrain')) void this.accept(this.offer);
  }

  /** Loads the offered (or given) release into the running duck (announce: say so in the mood line). */
  async accept(release: PolicyRelease | null = this.offer, announce = true): Promise<void> {
    const duck = this.duck;
    if (!release || !duck || this.busy) return;
    this.busy = true;
    this.status = `Loading ${release.name}...`;
    try {
      const hash = await duck.usePolicies(this.folder(release.id));
      this.current = release;
      this.offer = null;
      writeStore(CHOSEN_KEY, release.id);
      this.status = `Running ${release.name} (${hash})`;
      if (announce) duck.status = `${duck.profile?.name ?? 'The duck'} learned from your room: ${release.name}!`;
    } catch (err) {
      this.status = `Could not load ${release.name}: ${err instanceof Error ? err.message : String(err)}`;
      console.error('[policy inbox]', this.status);
    } finally {
      this.busy = false;
    }
  }

  /** Not now: the offer goes away until another release is made active. */
  dismiss(): void {
    if (this.offer) writeStore(DISMISSED_KEY, this.offer.id);
    this.offer = null;
  }

  /** Back to the shipped policies. */
  async revert(): Promise<void> {
    const duck = this.duck;
    if (!duck || this.busy) return;
    this.busy = true;
    try {
      await duck.usePolicies(null);
      this.current = null;
      writeStore(CHOSEN_KEY, null);
      this.status = 'Back on the shipped policies';
    } catch (err) {
      this.status = `Could not switch back: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Where a linked brain's files live: a URL under the site that no server
 * answers; the sim worker finds the files in Cache Storage first
 * (src/duck/duck-sim.worker.ts, fetchPolicy).
 */
export function linkedFolder(id: string): string {
  return new URL(`${import.meta.env.BASE_URL}policies/linked/${encodeURIComponent(id)}/`, document.baseURI).href;
}

async function hasLinkedFiles(id: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(LINKED_CACHE);
    return !!(await cache.match(`${linkedFolder(id)}walk.onnx`));
  } catch {
    return false;
  }
}
