// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Client for Pollen's robot rendezvous (the "central" signalling service that
 * Reachy Mini and the Microduck use): the browser signs in with the player's
 * Hugging Face token, lists the ducks on that account, opens a session with
 * one, and exchanges JSON-RPC 2.0 messages with it through the service.
 *
 * Protocol, from pollen-robotics/microduck (spaces/policy-playground,
 * docs/design/remote-access-design.md; Apache-2.0, re-implemented here):
 *   GET  /api/robot-status         robots on the account (meta.kind "microduck")
 *   GET  /events                   server-sent events for this token (open first)
 *   POST /send {type: "setPeerStatus", roles: ["listener"], meta: {name}}
 *   POST /send {type: "startSession", peerId} -> event sessionStarted {sessionId}
 *                                              or sessionRejected {activeApp}
 *   POST /send {type: "peer", sessionId, rpc: {jsonrpc, id, method, params}}
 *        -> the reply (and notifications such as robot.state) arrive as events
 *   POST /send {type: "endSession", sessionId}
 *
 * Etiquette the duck's makers ask for: one events stream per token, no
 * joystick-rate traffic through the rendezvous (it relays; 1200 requests a
 * minute per token, notifications capped at 400 a minute), never the robot's
 * own token. The low-latency path is a WebRTC data channel the same service
 * can broker; this client does not open one.
 */

export const DEFAULT_CENTRAL_URL = 'https://pollen-robotics-reachy-mini-central.hf.space';

export interface DuckListing {
  peerId: string;
  name: string;
  online: boolean;
  simulated: boolean;
  busyWith: string | null;
  raw: unknown;
}

interface RpcWaiter {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (event: Record<string, unknown>) => void;

/** Ducks on the account behind `token`. */
export async function listDucks(token: string, central = DEFAULT_CENTRAL_URL): Promise<DuckListing[]> {
  const res = await fetch(`${central}/api/robot-status`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`robot status: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const entries = Array.isArray(body) ? body : ((body as { robots?: unknown[] }).robots ?? []);
  return entries
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => ((entry.meta as Record<string, unknown> | undefined)?.kind ?? '') === 'microduck')
    .map((entry) => {
      const meta = (entry.meta ?? {}) as Record<string, unknown>;
      return {
        peerId: String(entry.peerId ?? entry.id ?? ''),
        name: String(meta.name ?? entry.name ?? 'Microduck'),
        online: entry.online !== false,
        simulated: meta.simulated === true,
        busyWith: (entry.activeApp as string | undefined) ?? null,
        raw: entry,
      };
    });
}

/**
 * One session with one duck. `call()` sends a JSON-RPC request and resolves
 * with its result; notifications (method without id) go to `onNotify`.
 */
export class RendezvousSession {
  sessionId: string | null = null;
  onNotify: ((method: string, params: unknown) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private readonly abort = new AbortController();
  private readonly waiters = new Map<number, RpcWaiter>();
  private readonly listeners = new Set<EventHandler>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly token: string,
    private readonly appName = 'Duck Lab XR',
    private readonly central = DEFAULT_CENTRAL_URL,
  ) {}

  /** Opens the event stream, announces this app and asks the duck for a session. */
  async start(peerId: string, timeoutMs = 15000): Promise<void> {
    void this.readEvents();
    await this.send({ type: 'setPeerStatus', roles: ['listener'], meta: { name: this.appName } });
    const started = this.waitFor(
      (event) => event.type === 'sessionStarted' || event.type === 'sessionRejected',
      timeoutMs,
    );
    await this.send({ type: 'startSession', peerId });
    const event = await started;
    if (event.type === 'sessionRejected') {
      throw new Error(`the duck is busy${event.activeApp ? ` with ${String(event.activeApp)}` : ''}`);
    }
    this.sessionId = String(event.sessionId ?? '');
  }

  /** A JSON-RPC request to the duck; resolves with its result. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<unknown> {
    if (!this.sessionId) return Promise.reject(new Error('no session'));
    const id = this.nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
    });
    void this.send({ type: 'peer', sessionId: this.sessionId, rpc: { jsonrpc: '2.0', id, method, params } }).catch((err: unknown) => {
      const waiter = this.waiters.get(id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    });
    return reply;
  }

  /** A JSON-RPC notification (no reply expected). */
  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.sessionId) return;
    void this.send({ type: 'peer', sessionId: this.sessionId, rpc: { jsonrpc: '2.0', method, params } }).catch(() => {});
  }

  async stop(reason = 'closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId) await this.send({ type: 'endSession', sessionId: this.sessionId }).catch(() => {});
    this.abort.abort();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.waiters.clear();
    this.onClose?.(reason);
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.central}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: this.abort.signal,
    });
    if (res.status === 429) throw new Error('rate limited by the rendezvous (too many requests)');
    if (!res.ok) throw new Error(`rendezvous send: HTTP ${res.status}`);
  }

  private waitFor(match: (event: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error('no answer from the duck'));
      }, timeoutMs);
      const listener: EventHandler = (event) => {
        if (!match(event)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(event);
      };
      this.listeners.add(listener);
    });
  }

  /** Reads the server-sent event stream with fetch (EventSource cannot send the token). */
  private async readEvents(): Promise<void> {
    try {
      const res = await fetch(`${this.central}/events`, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) this.dispatch(data);
        }
      }
      if (!this.closed) void this.stop('the rendezvous closed the event stream');
    } catch (err) {
      if (!this.closed) void this.stop(err instanceof Error ? err.message : String(err));
    }
  }

  private dispatch(data: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    for (const listener of [...this.listeners]) listener(event);
    if (event.type === 'endSession' || event.type === 'sessionEnded') {
      if (!this.closed) void this.stop('the duck ended the session');
      return;
    }
    const rpc = (event.rpc ?? (event.jsonrpc ? event : null)) as Record<string, unknown> | null;
    if (!rpc) return;
    if (typeof rpc.id === 'number' && this.waiters.has(rpc.id)) {
      const waiter = this.waiters.get(rpc.id)!;
      clearTimeout(waiter.timer);
      this.waiters.delete(rpc.id);
      if (rpc.error) {
        const error = rpc.error as { message?: string };
        waiter.reject(new Error(error.message ?? 'duck error'));
      } else {
        waiter.resolve(rpc.result);
      }
      return;
    }
    if (typeof rpc.method === 'string') this.onNotify?.(rpc.method, rpc.params);
  }
}
