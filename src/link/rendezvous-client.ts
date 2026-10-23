// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Client for the pairing rendezvous (tools/link/rendezvous-server.mjs):
 * trainer pages say they are open, headsets list the ones on their network,
 * and both pass a WebRTC offer and answer through it.
 */
import type { SignalData } from './link-protocol.js';

export interface LabInfo {
  /** The trainer page's id (where offers go). */
  lab: string;
  name: string;
  /** Six digits, shown on the trainer page. */
  code: string;
}

export interface SignalMessage {
  from: string;
  data: SignalData;
}

/** The site has no rendezvous (a static build served without it). */
export class PairingUnavailable extends Error {}

export class RendezvousClient {
  /** `base` is absolute and ends with "/" (the dev server: <site>/__duck/pair/). */
  constructor(readonly base: string) {}

  announce(lab: string, name: string): Promise<{ code: string }> {
    return this.call('lab', { lab, name });
  }

  /** The trainer page is closing: off the list at once (a beacon outlives the page). */
  bye(lab: string): void {
    try {
      navigator.sendBeacon(`${this.base}bye`, JSON.stringify({ lab }));
    } catch {
      // the entry expires by itself
    }
  }

  async labs(): Promise<LabInfo[]> {
    return (await this.call<{ labs: LabInfo[] }>('labs')).labs;
  }

  byCode(code: string): Promise<LabInfo> {
    return this.call('code', { code });
  }

  async send(to: string, from: string, data: SignalData): Promise<void> {
    await this.call('send', { to, from, data });
  }

  /** Messages for `id`, waiting up to `waitMs` for the first one. */
  async inbox(id: string, waitMs: number, signal?: AbortSignal): Promise<SignalMessage[]> {
    const path = `inbox?id=${encodeURIComponent(id)}&wait=${Math.round(waitMs)}`;
    return (await this.call<{ messages: SignalMessage[] }>(path, undefined, signal)).messages;
  }

  private async call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
    const text = await res.text();
    let data: (T & { error?: string }) | null = null;
    try {
      data = JSON.parse(text) as T & { error?: string };
    } catch {
      // the site answered with a page, not the rendezvous
    }
    if (!data || (res.status === 404 && !data.error)) throw new PairingUnavailable('pairing is not available on this site');
    if (!res.ok) throw new Error(data.error ?? `pairing: HTTP ${res.status}`);
    return data;
  }
}
