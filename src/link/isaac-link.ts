// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Live link to NVIDIA Isaac Sim. Isaac Sim, running the Duck Lab XR bridge
 * extension (tools/isaac), mirrors this session: the static scene (floor,
 * course, the room's colliders, the terrain), Pip's meshes and then Pip's
 * pose every frame go to it, and its viewport comes back over Isaac Sim's own
 * WebRTC stream, in a picture-in-picture window (public/isaac/player.html).
 * The physics stays in this page's MuJoCo; Isaac Sim draws what happens, with RTX.
 *
 * The data goes over the WebRTC stream's own data channel when Isaac Sim has
 * one (4.x: the player page passes it on), else over a WebSocket on Kit's web
 * server (2022.2). ?isaac-data=socket or =channel picks one.
 *
 * On with ?isaac (Isaac Sim on this computer, Kit's web port 8211, else 8011:
 * Isaac Sim 4.x's own) or ?isaac=<host>:<port>. From an https page only this computer is reachable.
 * The window shows on the desktop page; in an immersive session it hides
 * while the link keeps running.
 */
import { createSystem, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3, VisibilityState } from '@iwsdk/core';
import { BALL_OFFSET, BALL_RADIUS } from '../duck/duck-constants.js';
import type { DuckRig } from '../duck/duck-rig.js';
import { DuckSystem } from '../duck/duck-system.js';
import type { SceneTerrain } from '../duck/sim-protocol.js';

/** Poses per second sent to Isaac Sim. */
const SEND_HZ = 30;
/** How often the static scene is checked for changes (the room scan, the terrain, a new course). */
const SCENE_EVERY_MS = 2000;
const RETRY_MS = 3000;
/** Poses are dropped while this much is still waiting to go out. */
const BACKLOG_BYTES = 256 * 1024;
/**
 * Kit's web server takes WebSocket messages of 1 MiB at most (uvicorn 0.12 keeps the
 * websockets default), and one of Pip's bodies is 3.8 MB: longer messages go in parts.
 */
const PART_CHARS = 400 * 1024;
/**
 * The stream's data channel takes 64 KiB per message, counted after NVIDIA's player has
 * escaped it twice more (a quote or a backslash then costs four), and Chrome drops whatever
 * goes past its 16 MB send buffer without a word: long messages go in slices of at most this
 * cost, and at most CHANNEL_WINDOW of them goes unconfirmed (the bridge answers each with got).
 */
const CHANNEL_PART_COST = 60000;
const CHANNEL_WINDOW = 4 * 1024 * 1024;
/** Unconfirmed slices count as lost after this long without a confirmation. */
const CHANNEL_STALL_MS = 5000;
/** How long to wait for the player page to say which stream this Isaac Sim has. */
const PLAYER_WAIT_MS = 10000;
/** How long to wait for the stream's data channel to open. */
const CHANNEL_WAIT_MS = 30000;
/** The data channel has no close: Isaac Sim counts the app gone after 6 s of quiet. */
const PING_MS = 2000;

export type IsaacLinkState = 'off' | 'connecting' | 'live' | 'unreachable' | 'replaced';
/** Kit's WebSocket, or the WebRTC stream's data channel (Isaac Sim 4.x). */
export type IsaacTransport = 'socket' | 'channel';

interface BridgeMessage {
  type: string;
  message?: string;
  code?: number;
  id?: number;
  index?: number;
}

/** A message waiting for the data channel; a slice has a key and a size and needs confirming. */
interface ChannelItem {
  payload: object;
  key: string | null;
  size: number;
}

interface LinkBody {
  name: string;
  group: Object3D;
  /** Index of the parent body in the list, or -1 under the MuJoCo frame. */
  parent: number;
}

interface BridgeHello {
  type: 'hello';
  bridge: string;
  transport?: IsaacTransport;
  app: string;
  appVersion: string;
  stage: string;
}

const CSS = `
/* Bottom centre: the menu holds the left side, Pip cam the bottom right. */
#duck-isaac { position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px; z-index: 25; width: clamp(280px, 38vw, 560px); display: flex; flex-direction: column; border-radius: 14px; overflow: hidden; background: #0f1020; border: 2px solid rgba(255, 244, 220, 0.22); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45); }
#duck-isaac[hidden] { display: none; }
#duck-isaac .bar { display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px 12px; color: #fff4dc; user-select: none; -webkit-user-select: none; }
#duck-isaac .name { font: 20px/1 DuckBebas, 'Arial Narrow', sans-serif; letter-spacing: 2px; }
#duck-isaac .state { flex: 1; min-width: 0; font: 600 12px/1.2 'Segoe UI', system-ui, sans-serif; color: rgba(255, 244, 220, 0.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#duck-isaac .state::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: #8a8fa3; vertical-align: 0; }
#duck-isaac[data-state='live'] .state::before { background: #3de0b8; }
#duck-isaac[data-state='unreachable'] .state::before { background: #ff5c8a; }
#duck-isaac button { font: 17px/1 DuckBebas, 'Arial Narrow', sans-serif; letter-spacing: 1.5px; color: #fff4dc; background: rgba(255, 244, 220, 0.1); border: 0; border-radius: 999px; padding: 6px 12px 4px; cursor: pointer; }
#duck-isaac button:hover { background: rgba(255, 244, 220, 0.2); }
#duck-isaac button.on { background: #ffcf3f; color: #0f1020; }
#duck-isaac button:focus-visible { outline: 2px solid #ffcf3f; outline-offset: 2px; }
#duck-isaac iframe { display: block; width: 100%; aspect-ratio: 16 / 9; border: 0; background: #0f1020; }
#duck-isaac.small iframe { display: none; }
`;

export class IsaacLinkSystem extends createSystem({}) {
  /** Whether this page links to Isaac Sim at all (?isaac). */
  enabled = false;
  host = '127.0.0.1';
  port = 8211;
  state: IsaacLinkState = 'off';
  /** Isaac Sim's greeting on the current connection. */
  bridge: BridgeHello | null = null;
  /** The viewport camera follows Pip. */
  follow = true;
  /** Isaac Sim's own panels in the stream (off: the viewport fills it). */
  isaacUi = false;
  framesSent = 0;
  scenesSent = 0;
  /** The stream window's state, from the player page. */
  stream = 'loading';
  /** Which transport to use: 'auto' takes the data channel when Isaac Sim has one. */
  dataMode: 'auto' | IsaacTransport = 'auto';
  /** The transport in use (or being tried). */
  transport: IsaacTransport | null = null;
  /** What the player page found: 'library' (Isaac Sim 4.x), 'kit-player' (2022.2), null; undefined before it says. */
  playerKind: string | null | undefined = undefined;
  /** The stream's data channel is open. */
  channelUp = false;

  private duck!: DuckSystem;
  private socket: WebSocket | null = null;
  private rig: DuckRig | null = null;
  private bodies: LinkBody[] = [];
  private relative: Matrix4[] = [];
  private frame = new Float32Array(0);
  private sinceSend = 0;
  private sceneAt = 0;
  private sceneBusy = false;
  private sentShapes = '';
  private sentTerrain = '';
  private retryTimer = 0;
  private waitTimer = 0;
  private pingAt = 0;
  /** Messages for the data channel, in order: slices wait for room in the window. */
  private channelQueue: ChannelItem[] = [];
  private channelInFlight = 0;
  private readonly channelSizes = new Map<string, number>();
  private channelProgressAt = 0;
  private playerFrame: HTMLIFrameElement | null = null;
  private stateDetail = '';
  private partId = 0;
  private panel: HTMLDivElement | null = null;
  private stateText: HTMLSpanElement | null = null;
  private followButton: HTMLButtonElement | null = null;
  private uiButton: HTMLButtonElement | null = null;
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();

  init(): void {
    const param = new URLSearchParams(location.search).get('isaac');
    if (param === null) return;
    const [host, port] = param.split(':');
    if (host) this.host = host;
    if (Number(port) > 0) this.port = Number(port);
    const data = new URLSearchParams(location.search).get('isaac-data');
    if (data === 'socket' || data === 'channel') this.dataMode = data;
    this.enabled = true;
    this.duck = this.world.getSystem(DuckSystem)!;
    this.state = 'connecting';
    void (Number(port) > 0 ? Promise.resolve() : this.findPort()).then(() => this.start());
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (this.panel) this.panel.hidden = state !== VisibilityState.NonImmersive;
      }),
      () => {
        window.clearTimeout(this.retryTimer);
        window.clearTimeout(this.waitTimer);
        const socket = this.socket;
        this.socket = null;
        socket?.close();
        this.panel?.remove();
      },
    );
  }

  update(delta: number): void {
    if (!this.enabled || this.state !== 'live') return;
    const socket = this.transport === 'socket' ? this.socket : null;
    if (!socket && this.transport !== 'channel') return;
    const now = performance.now();
    if (this.transport === 'channel') {
      if (now - this.pingAt > PING_MS) {
        this.pingAt = now;
        this.toChannel({ type: 'ping' });
      }
      if (this.channelQueue.length) this.pumpChannel();
    }
    const rig = this.duck.rig;
    if (rig !== this.rig) {
      // A new duck (a playground switch, a respawn): its meshes, and the scene again.
      this.rig = rig;
      this.sentShapes = '';
      this.sentTerrain = '';
      if (rig) this.sendDuck(rig);
    }
    if (!rig || !this.duck.sim?.ready) return;
    if (!this.sceneBusy && now - this.sceneAt > SCENE_EVERY_MS) {
      this.sceneAt = now;
      void this.syncScene();
    }
    this.sinceSend += delta;
    const interval = 1 / SEND_HZ;
    if (this.sinceSend < interval || (socket && socket.bufferedAmount > BACKLOG_BYTES)) return;
    this.sinceSend = Math.min(this.sinceSend - interval, interval); // keep the rhythm at any frame rate, never a burst
    this.writePose();
    if (socket) socket.send(this.frame);
    else this.toChannel({ type: 'pose', data: base64(this.frame) });
    this.framesSent++;
  }

  /** Whether Isaac Sim's viewport camera follows Pip (it can be steered in the stream otherwise). */
  setFollow(follow: boolean): void {
    this.follow = follow;
    this.followButton?.classList.toggle('on', follow);
    this.sendJson({ type: 'camera', follow });
  }

  /** Points Isaac Sim's camera from `eye` at `target` (stage MuJoCo frame, metres) and stops following Pip. */
  lookAt(eye: readonly number[], target: readonly number[]): void {
    this.follow = false;
    this.followButton?.classList.remove('on');
    this.sendJson({ type: 'camera', follow: false, eye, target });
  }

  /** Isaac Sim's own panels in the stream, or the viewport alone. */
  setIsaacUi(ui: boolean): void {
    this.isaacUi = ui;
    this.uiButton?.classList.toggle('on', ui);
    this.sendJson({ type: 'view', ui });
  }

  // --- The connection ----------------------------------------------------------------

  private start(): void {
    if (!this.enabled) return;
    this.buildPanel();
    this.setState('connecting');
    if (this.dataMode === 'socket') this.connect();
    else this.waitTimer = window.setTimeout(() => this.fallBack('the stream player did not answer'), PLAYER_WAIT_MS);
  }

  /** Kit's web port when ?isaac names none: 8211 (Isaac Sim 2022.2, or started by tools/isaac/start-isaac-sim.ps1), else 8011 (4.x's own). */
  private async findPort(): Promise<void> {
    for (const port of [8211, 8011]) {
      try {
        const res = await fetch(`http://${this.host}:${port}/ducklab/status`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          this.port = port;
          return;
        }
      } catch {
        // not there
      }
    }
  }

  /** The WebSocket on Kit's web server. */
  private connect(): void {
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.waitTimer);
    this.transport = 'socket';
    this.setState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://${this.host}:${this.port}/ducklab/ws`);
    } catch {
      // An https page may not open ws:// to another computer.
      this.setState('unreachable', `an https page reaches only Isaac Sim on this computer (?isaac=127.0.0.1)`);
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') this.onBridge(JSON.parse(event.data) as BridgeMessage);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.bridge = null;
      if (event.code === 4000) {
        this.setState('replaced', 'another page took over Isaac Sim');
        return;
      }
      this.setState('unreachable', `no bridge at ${this.host}:${this.port}, trying again`);
      this.retryTimer = window.setTimeout(() => this.connect(), RETRY_MS);
    };
  }

  /** The player page says which stream this Isaac Sim has: the data channel comes with the library's. */
  private onPlayerKind(kind: string | null): void {
    this.playerKind = kind;
    if (this.transport !== null || this.state === 'replaced') return; // chosen already
    window.clearTimeout(this.waitTimer);
    if (kind === 'library') {
      if (this.channelUp) this.helloChannel();
      else this.waitTimer = window.setTimeout(() => this.fallBack('the stream did not start'), CHANNEL_WAIT_MS);
    } else if (this.dataMode === 'channel') {
      this.setState('unreachable', 'this Isaac Sim has no data channel on its stream (Isaac Sim 4.x has)');
    } else {
      this.connect();
    }
  }

  private onChannel(up: boolean): void {
    this.channelUp = up;
    if (up && this.transport === null && this.playerKind === 'library' && this.state !== 'replaced') {
      window.clearTimeout(this.waitTimer);
      this.helloChannel();
    } else if (!up && this.transport === 'channel') {
      this.fallBack('the stream stopped');
    }
  }

  /** Hello over the data channel, again until Isaac Sim answers (it may miss messages while the channel opens). */
  private helloChannel(): void {
    window.clearTimeout(this.retryTimer);
    this.transport = 'channel';
    this.clearChannel();
    if (this.state !== 'connecting') this.setState('connecting');
    this.toChannel({ type: 'hello' });
    this.retryTimer = window.setTimeout(() => {
      if (this.transport === 'channel' && this.state === 'connecting') this.helloChannel();
    }, RETRY_MS);
  }

  /** No data channel after all: the WebSocket, unless the channel was asked for. */
  private fallBack(why: string): void {
    window.clearTimeout(this.waitTimer);
    window.clearTimeout(this.retryTimer);
    this.bridge = null;
    if (this.dataMode === 'channel') {
      this.transport = null;
      this.setState('unreachable', why);
    } else {
      this.connect();
    }
  }

  /** A message from the bridge, over either transport. */
  private onBridge(message: BridgeMessage): void {
    if (message.type === 'hello') {
      window.clearTimeout(this.retryTimer);
      this.clearChannel(); // everything goes again
      this.bridge = message as unknown as BridgeHello;
      this.rig = null; // everything again, to this Isaac Sim
      this.setState('live');
      this.sendJson({ type: 'camera', follow: this.follow });
      this.sendJson({ type: 'view', ui: this.isaacUi });
    } else if (message.type === 'bye' && this.transport === 'channel') {
      this.bridge = null;
      if (message.code === 4000) {
        this.transport = null;
        this.setState('replaced', 'another page took over Isaac Sim');
      } else {
        // The bridge restarted (a reload of its code): hello to the new one.
        this.setState('connecting');
        window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => this.helloChannel(), RETRY_MS);
      }
    } else if (message.type === 'got') {
      const key = `${message.id}:${message.index}`;
      const size = this.channelSizes.get(key);
      if (size !== undefined) {
        this.channelSizes.delete(key);
        this.channelInFlight -= size;
        this.channelProgressAt = performance.now();
        this.pumpChannel();
      }
    } else if (message.type === 'error') {
      console.warn(`[isaac] ${message.message}`);
    }
  }

  /** Sends what the window has room for, in order. */
  private pumpChannel(): void {
    const now = performance.now();
    if (this.channelInFlight > 0 && now - this.channelProgressAt > CHANNEL_STALL_MS) {
      this.channelInFlight = 0; // the confirmations went missing: carry on
      this.channelSizes.clear();
    }
    let sent = 0;
    while (sent < this.channelQueue.length) {
      const item = this.channelQueue[sent];
      if (item.key && this.channelInFlight > 0 && this.channelInFlight + item.size > CHANNEL_WINDOW) break;
      if (item.key) {
        this.channelInFlight += item.size;
        this.channelSizes.set(item.key, item.size);
        this.channelProgressAt = now;
      }
      this.toChannel(item.payload);
      sent++;
    }
    if (sent) this.channelQueue.splice(0, sent);
  }

  private clearChannel(): void {
    this.channelQueue.length = 0;
    this.channelInFlight = 0;
    this.channelSizes.clear();
  }

  private toChannel(payload: object): void {
    this.playerFrame?.contentWindow?.postMessage({ duckLab: 'isaac-send', message: { event_type: 'ducklab', payload } }, location.origin);
  }

  private sendJson(message: object): void {
    if (this.transport === 'channel') {
      const text = JSON.stringify(message);
      if (channelSliceEnd(text, 0) === text.length) {
        this.channelQueue.push({ payload: message, key: null, size: 0 });
      } else {
        const id = ++this.partId;
        const slices: string[] = [];
        for (let start = 0; start < text.length; ) {
          const end = channelSliceEnd(text, start);
          slices.push(text.slice(start, end));
          start = end;
        }
        for (let index = 0; index < slices.length; index++) {
          const data = slices[index];
          this.channelQueue.push({ payload: { type: 'part', id, index, count: slices.length, data }, key: `${id}:${index}`, size: data.length });
        }
      }
      this.pumpChannel();
      return;
    }
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(message);
    if (text.length <= PART_CHARS) {
      socket.send(text);
      return;
    }
    const id = ++this.partId;
    const count = Math.ceil(text.length / PART_CHARS);
    for (let index = 0; index < count; index++) {
      socket.send(JSON.stringify({ type: 'part', id, index, count, data: text.slice(index * PART_CHARS, (index + 1) * PART_CHARS) }));
    }
  }

  // --- What goes over ----------------------------------------------------------------

  /** Pip's bodies (the order poses use) and their triangles, in each body's own frame. */
  private sendDuck(rig: DuckRig): void {
    const frame = rig.root.children.find((child) => child.name === 'mujoco-frame');
    if (!frame) return;
    const bodies: LinkBody[] = [];
    const walk = (object: Object3D, parent: number) => {
      for (const child of object.children) {
        if (!child.userData.mujocoBody) continue; // meshes, the beak's pivot, cameras attached later
        bodies.push({ name: child.name, group: child, parent });
        walk(child, bodies.length - 1);
      }
    };
    walk(frame, -1);
    this.bodies = bodies;
    this.relative = bodies.map(() => new Matrix4());
    this.frame = new Float32Array((bodies.length + 1) * 7);
    this.sendJson({
      type: 'duck',
      bodies: bodies.map((b) => b.name),
      ball: { radius: BALL_RADIUS, color: [1, 0.36, 0.54], color2: [1, 0.96, 0.86] },
    });
    for (const body of bodies) {
      const meshes: object[] = [];
      for (const child of body.group.children) {
        if ((child as Mesh).isMesh) meshes.push(meshPart(child as Mesh, null));
        else if (child.name === 'jaw-pivot') {
          child.updateMatrix(); // the beak as it is now (closed, mostly)
          for (const part of child.children) if ((part as Mesh).isMesh) meshes.push(meshPart(part as Mesh, child.matrix));
        }
      }
      if (meshes.length) this.sendJson({ type: 'duck-body', name: body.name, meshes });
    }
  }

  /** Every body's pose in the stage's MuJoCo frame, then the ball's, as float32 (see the bridge). */
  private writePose(): void {
    const out = this.frame;
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      body.group.updateMatrix();
      const m = this.relative[i];
      if (body.parent < 0) m.copy(body.group.matrix);
      else m.multiplyMatrices(this.relative[body.parent], body.group.matrix);
      m.decompose(this.position, this.rotation, this.scale);
      const o = i * 7;
      out[o] = this.position.x;
      out[o + 1] = this.position.y;
      out[o + 2] = this.position.z;
      out[o + 3] = this.rotation.w;
      out[o + 4] = this.rotation.x;
      out[o + 5] = this.rotation.y;
      out[o + 6] = this.rotation.z;
    }
    // The ball: position and quaternion (w first) from the sim pose; NaN when there is none.
    const pose = this.duck.pose;
    const o = this.bodies.length * 7;
    const b = BALL_OFFSET;
    const norm = Math.hypot(pose[b + 3], pose[b + 4], pose[b + 5], pose[b + 6]);
    for (let k = 0; k < 7; k++) out[o + k] = norm > 0.5 ? pose[b + k] : Number.NaN;
  }

  /** The static scene, sent when it differs from what Isaac Sim has. */
  private async syncScene(): Promise<void> {
    const sim = this.duck.sim;
    if (!sim) return;
    this.sceneBusy = true;
    try {
      const scene = await sim.scene();
      const shapes = JSON.stringify(scene.shapes);
      const terrain = scene.terrain ? encodeTerrain(scene.terrain) : null;
      const terrainKey = terrain ? `${terrain.half} ${terrain.heights.length} ${fingerprint(scene.terrain!.heights)}` : 'none';
      if (shapes !== this.sentShapes) {
        this.sendJson({ type: 'scene', statics: scene.shapes, terrain });
        this.scenesSent++;
      } else if (terrainKey !== this.sentTerrain) {
        this.sendJson({ type: 'terrain', terrain });
      }
      this.sentShapes = shapes;
      this.sentTerrain = terrainKey;
    } finally {
      this.sceneBusy = false;
    }
  }

  // --- The window ----------------------------------------------------------------------

  private buildPanel(): void {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const panel = document.createElement('div');
    panel.id = 'duck-isaac';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = 'ISAAC SIM';
    const state = document.createElement('span');
    state.className = 'state';
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.textContent = 'FOLLOW';
    follow.title = "Isaac Sim's camera follows Pip (off: steer it in the stream)";
    follow.classList.toggle('on', this.follow);
    follow.addEventListener('click', () => this.setFollow(!this.follow));
    const ui = document.createElement('button');
    ui.type = 'button';
    ui.textContent = 'ISAAC UI';
    ui.title = "Isaac Sim's own panels in the stream (off: the viewport alone)";
    ui.classList.toggle('on', this.isaacUi);
    ui.addEventListener('click', () => this.setIsaacUi(!this.isaacUi));
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.textContent = 'HIDE';
    fold.title = 'Fold the stream away (the link keeps running)';
    fold.addEventListener('click', () => {
      const small = panel.classList.toggle('small');
      fold.textContent = small ? 'SHOW' : 'HIDE';
    });
    bar.append(name, state, follow, ui, fold);
    const frame = document.createElement('iframe');
    frame.title = "Isaac Sim's viewport, live";
    frame.allow = 'autoplay; local-network-access';
    const url = new URL(`${import.meta.env.BASE_URL}isaac/player.html`, document.baseURI);
    url.searchParams.set('server', this.host);
    url.searchParams.set('port', String(this.port));
    frame.src = url.href;
    panel.append(bar, frame);
    panel.hidden = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    document.body.appendChild(panel);
    this.panel = panel;
    this.stateText = state;
    this.followButton = follow;
    this.uiButton = ui;
    this.playerFrame = frame;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
      const data = event.data as { duckLab?: string; state?: string; kind?: string | null; up?: boolean; message?: unknown } | null;
      if (data?.duckLab === 'isaac-stream') {
        this.stream = data.state ?? 'loading';
        this.renderState();
      } else if (data?.duckLab === 'isaac-player') {
        this.onPlayerKind(data.kind ?? null);
      } else if (data?.duckLab === 'isaac-channel') {
        this.onChannel(!!data.up);
      } else if (data?.duckLab === 'isaac-message' && this.transport === 'channel') {
        const envelope = data.message as { event_type?: string; payload?: BridgeMessage } | null;
        if (envelope?.event_type === 'ducklab' && envelope.payload) this.onBridge(envelope.payload);
      }
    };
    window.addEventListener('message', onMessage);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('message', onMessage);
      style.remove();
    });
  }

  private setState(state: IsaacLinkState, detail = ''): void {
    this.state = state;
    this.stateDetail = detail;
    this.renderState();
  }

  private renderState(): void {
    if (!this.panel || !this.stateText) return;
    this.panel.dataset.state = this.state;
    const words: Record<IsaacLinkState, string> = {
      off: 'off',
      connecting: `connecting to ${this.host}:${this.port}`,
      live: `mirroring Pip${this.bridge ? ` in ${this.bridge.app} ${this.bridge.appVersion}` : ''}${this.transport === 'channel' ? ' over WebRTC' : ''}`,
      unreachable: this.stateDetail,
      replaced: this.stateDetail,
    };
    const stream = this.stream === 'playing' ? '' : this.stream === 'error' ? ' / no stream' : '';
    this.stateText.textContent = words[this.state] + stream;
  }
}

/** One mesh as base64 float32 triangles (and normals), moved by `matrix` when given, with its look. */
function meshPart(mesh: Mesh, matrix: Matrix4 | null): object {
  const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  let points = geometry.getAttribute('position').array as Float32Array;
  let normals = (geometry.getAttribute('normal')?.array as Float32Array | undefined) ?? null;
  if (matrix) {
    points = points.slice();
    const v = new Vector3();
    for (let i = 0; i < points.length; i += 3) v.fromArray(points, i).applyMatrix4(matrix).toArray(points, i);
    if (normals) {
      normals = normals.slice();
      const turn = new Quaternion().setFromRotationMatrix(matrix);
      for (let i = 0; i < normals.length; i += 3) v.fromArray(normals, i).applyQuaternion(turn).toArray(normals, i);
    }
  }
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
  return {
    points: base64(points),
    normals: normals ? base64(normals) : null,
    color: material.color ? [material.color.r, material.color.g, material.color.b] : [0.8, 0.8, 0.8],
    roughness: material.roughness ?? 0.6,
    metalness: material.metalness ?? 0,
  };
}

function encodeTerrain(t: SceneTerrain): { half: number; elev: number; rows: number; cols: number; pos: number[]; heights: string } {
  return { half: t.half, elev: t.elev, rows: t.rows, cols: t.cols, pos: t.pos, heights: base64(t.heights) };
}

/** Where a slice of `text` from `start` ends, for the data channel's 64 KiB (see CHANNEL_PART_COST). */
function channelSliceEnd(text: string, start: number): number {
  let cost = 0;
  let i = start;
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    cost += c === 34 || c === 92 ? 4 : c > 127 ? 12 : 1; // quote, backslash; anything past ASCII, generously
    if (cost > CHANNEL_PART_COST) break;
  }
  return i;
}

/** A float array's bytes as base64 (little-endian, as Isaac Sim reads them). */
function base64(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** A cheap fingerprint of a height field (to see whether it changed). */
function fingerprint(values: Float32Array): string {
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    weighted += values[i] * ((i % 997) + 1);
  }
  return `${sum.toFixed(4)}:${weighted.toFixed(2)}`;
}
