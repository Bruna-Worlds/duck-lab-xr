// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A link to a real Microduck through Pollen's rendezvous (rendezvous.ts),
 * speaking the duck's JSON-RPC API (pollen-robotics/microduck,
 * duck-ipc-proto, API_VERSION 44):
 *
 *   robot.move {vx, vy, vyaw}      walk; the duck stops if nothing arrives for 500 ms
 *   robot.do {skill}               kick_left, kick_right, roulade, ground_pick, sit_toggle
 *   robot.stop                     zero velocity (not an emergency stop)
 *   robot.subscribe {hz}           robot.state notifications (joints, targets, imu, safety)
 *   robot.health                   battery {volts, percent}
 *   policy.fetch {repo, revision}  the duck downloads a policy repo from the Hub itself
 *   robot.loadPolicy {slot, path}  use it as a gait;  robot.setSkill {...} as a trick
 *   robot.policies                 check the change (change_error, homed)
 *
 * Commands are limited to what the rendezvous is meant for: walking is
 * re-sent at most a few times a second (enough for the 500 ms deadman, not
 * joystick rate), and telemetry is asked for at 4 Hz (the relay caps
 * notifications at 400 a minute). Speeds are clamped to the duck's console
 * limits (0.3 m/s, 1.5 rad/s). Joint order, gains and the standing pose are
 * fixed on the duck, so a policy only needs a manifest saying it takes 61
 * observations and gives 14 actions (docs/policy-manifest.md upstream).
 */
import { type DuckListing, listDucks, RendezvousSession } from './rendezvous.js';

/** Our moves -> the duck's skills (Pollen names). The bow is a keyframe motion with no counterpart. */
export const DUCK_SKILLS: Record<string, string | null> = {
  kickL: 'kick_left',
  kickR: 'kick_right',
  roll: 'roulade',
  peck: 'ground_pick',
  sit: 'sit_toggle',
  stand: 'sit_toggle',
  motion: null,
};

const MOVE_RESEND_MS = 300; // under the 500 ms deadman, far from joystick rate
const MAX_VX = 0.3;
const MAX_VYAW = 1.5;
const STATE_HZ = 4;

export type LinkState = 'idle' | 'listing' | 'connecting' | 'connected' | 'error';

export interface DuckTelemetry {
  joints: number[];
  targets: number[];
  gyro: number[];
  quat: number[];
  fallen: boolean;
  pickedUp: boolean;
  limitedBy: string;
  at: number;
}

export interface PolicySource {
  /** A public Hub model repo with manifest.json and policy.onnx (the duck downloads it). */
  repo: string;
  revision?: string;
  /** "gait" replaces the walking policy in a slot; "trick" adds a one-shot skill. */
  kind: 'gait' | 'trick';
  slot?: string;
  name?: string;
  durationS?: number;
}

export class MicroduckLink {
  state: LinkState = 'idle';
  status = 'Not linked';
  ducks: DuckListing[] = [];
  duck: DuckListing | null = null;
  telemetry: DuckTelemetry | null = null;
  battery: number | null = null;
  /** Commands sent this session (for the panel and tests). */
  sent = 0;
  private session: RendezvousSession | null = null;
  private lastMove = { vx: 0, vyaw: 0, at: 0 };
  private moving = false;

  constructor(private readonly central?: string) {}

  get connected(): boolean {
    return this.state === 'connected' && !!this.session;
  }

  /** Lists the ducks on the account, then opens a session with the first online one (or `peerId`). */
  async connect(token: string, peerId?: string): Promise<void> {
    await this.disconnect();
    try {
      this.state = 'listing';
      this.status = 'Looking for your duck...';
      this.ducks = await listDucks(token, this.central);
      const duck = peerId ? this.ducks.find((d) => d.peerId === peerId) : this.ducks.find((d) => d.online);
      if (!duck) {
        throw new Error(this.ducks.length ? 'no duck online on this account' : 'no Microduck on this Hugging Face account');
      }
      this.duck = duck;
      this.state = 'connecting';
      this.status = `Linking to ${duck.name}...`;
      const session = new RendezvousSession(token, 'Duck Lab XR', this.central);
      session.onNotify = (method, params) => this.onNotify(method, params);
      session.onClose = (reason) => {
        if (this.session !== session) return;
        this.session = null;
        this.state = 'idle';
        this.status = `Link closed: ${reason}`;
      };
      await session.start(duck.peerId);
      this.session = session;
      this.state = 'connected';
      this.status = `Linked to ${duck.name}${duck.simulated ? ' (simulated)' : ''}`;
      await session.call('robot.subscribe', { hz: STATE_HZ }).catch(() => {});
      const health = (await session.call('robot.health').catch(() => null)) as { battery?: { percent?: number } } | null;
      this.battery = health?.battery?.percent ?? null;
    } catch (err) {
      this.state = 'error';
      this.status = `Could not link: ${err instanceof Error ? err.message : String(err)}`;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) {
      await session.call('robot.stop').catch(() => {});
      await session.stop('unlinked');
    }
    this.state = 'idle';
    this.status = 'Not linked';
    this.moving = false;
  }

  /**
   * Walking command from the game's stick or autopilot (m/s, rad/s), called
   * every frame; sent when it changes and re-sent while moving, a few times
   * a second at most.
   */
  drive(vx: number, vyaw: number, now = performance.now()): void {
    const session = this.session;
    if (!session || this.state !== 'connected') return;
    const cx = Math.max(-MAX_VX, Math.min(MAX_VX, vx));
    const cw = Math.max(-MAX_VYAW, Math.min(MAX_VYAW, vyaw));
    const still = Math.abs(cx) < 0.005 && Math.abs(cw) < 0.02;
    if (still && !this.moving) return;
    const changed = Math.abs(cx - this.lastMove.vx) > 0.02 || Math.abs(cw - this.lastMove.vyaw) > 0.08;
    if (now - this.lastMove.at < MOVE_RESEND_MS && !(changed && now - this.lastMove.at > 120)) return;
    this.lastMove = { vx: cx, vyaw: cw, at: now };
    this.moving = !still;
    this.sent++;
    if (still) {
      void session.call('robot.stop').catch(() => {});
    } else {
      void session.call('robot.move', { vx: cx, vy: 0, vyaw: cw }).catch(() => {});
    }
  }

  /** One of our moves (see DUCK_SKILLS); resolves with whether the duck accepted it. */
  async doMove(move: string): Promise<boolean> {
    const skill = DUCK_SKILLS[move];
    if (!skill || !this.session) return false;
    this.sent++;
    const reply = (await this.session.call('robot.do', { skill }).catch(() => null)) as { accepted?: boolean } | null;
    return reply?.accepted !== false && reply !== null;
  }

  async stopWalking(): Promise<void> {
    this.moving = false;
    await this.session?.call('robot.stop').catch(() => {});
  }

  /**
   * Puts a policy on the duck: it downloads the repo from the Hub, then uses
   * it as a gait (slot) or a trick, and reports when it is ready.
   */
  async installPolicy(source: PolicySource, onStep: (text: string) => void = () => {}): Promise<void> {
    const session = this.session;
    if (!session) throw new Error('not linked to a duck');
    onStep(`Downloading ${source.repo} on the duck...`);
    const fetched = (await session.call(
      'policy.fetch',
      { repo: source.repo, ...(source.revision ? { revision: source.revision } : {}) },
      120000,
    )) as { path?: string; accepted?: boolean; reason?: string } | null;
    if (fetched?.accepted === false) throw new Error(`the duck refused the download: ${fetched.reason ?? '?'}`);
    const path = fetched?.path ?? '';
    if (!path) throw new Error('the duck did not say where it stored the policy');
    onStep(source.kind === 'gait' ? `Loading it as the ${source.slot ?? 'walk'} policy...` : `Adding it as the trick ${source.name}...`);
    const changed = (await session.call(
      source.kind === 'gait' ? 'robot.loadPolicy' : 'robot.setSkill',
      source.kind === 'gait'
        ? { slot: source.slot ?? 'walk', path }
        : { name: source.name ?? 'duckdash_trick', path, duration: source.durationS ?? 2, chain: false },
      30000,
    )) as { accepted?: boolean; reason?: string } | null;
    if (changed?.accepted === false) throw new Error(`the duck refused the policy: ${changed.reason ?? '?'}`);
    for (let i = 0; i < 40; i++) {
      const policies = (await session.call('robot.policies').catch(() => null)) as { change_error?: string; homed?: boolean } | null;
      if (policies?.change_error) throw new Error(`policy change failed: ${policies.change_error}`);
      if (policies?.homed !== false) {
        onStep('The duck runs the new policy.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('the duck did not finish switching policies');
  }

  private onNotify(method: string, params: unknown): void {
    if (method !== 'robot.state' || !params || typeof params !== 'object') return;
    const p = params as Record<string, unknown>;
    const imu = (p.imu ?? {}) as Record<string, unknown>;
    const safety = (p.safety ?? {}) as Record<string, unknown>;
    const move = (p.move ?? {}) as Record<string, unknown>;
    this.telemetry = {
      joints: (p.joints as number[]) ?? [],
      targets: (p.targets as number[]) ?? [],
      gyro: (imu.gyro as number[]) ?? [],
      quat: (imu.quat as number[]) ?? [],
      fallen: safety.fallen === true,
      pickedUp: safety.picked_up === true,
      limitedBy: String(move.limited_by ?? ''),
      at: performance.now(),
    };
  }
}
