// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The duck. Spawns the sim on the DuckStage node with the course under it,
 * drives it from the controllers, renders it and the ball, and gives it a
 * personality: it looks at you, looks around when idle, gets dizzy after a
 * couple of quick falls, and quacks with an opening beak.
 *
 * Controls in XR (keyboard outside XR):
 *   left stick        walk forward / back, turn           (WASD / arrows)
 *   A                 kick (the foot nearest the ball)    (J)
 *   B                 roll                                (K)
 *   X                 sit down / stand up                 (L)
 *   Y                 peck                                (I)
 *   right trigger     quack (squeeze to open the beak)    (Q)
 *   right grip        put the course where you point
 *   left grip         restart the run                     (R)
 *                     speed test                          (T)
 */
import {
  AssetManager,
  createSystem,
  DepthOccludable,
  type Entity,
  Group,
  InputComponent,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OcclusionShadersMode,
  Quaternion,
  RingGeometry,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { installAudioUnlock, playQuack, playSound, unlockAudio } from '../audio/duck-sounds.js';
import { touchControls } from '../input/touch-controls.js';
import { CourseBall, CourseFinish } from '../course/course-components.js';
import { FLOOR_LAYERS } from '../course/floor-layers.js';
import { fromMujocoPosition, fromMujocoQuaternion, gatherCourse } from '../course/course-physics.js';
import {
  BALL_OFFSET,
  type PolicyName,
  POSE_SIZE,
  VEL_ANG,
  VEL_BACK,
  VEL_FWD,
} from './duck-constants.js';
import { type DuckPack, packFileUrl, packFromUrl } from './duck-pack.js';
import {
  buildDuckRig,
  type DuckKinematics,
  type DuckRig,
  poseDuckRig,
  setDuckJaw,
} from './duck-rig.js';
import { DuckStage } from './duck-stage.js';
import { DuckSimClient, wallNow } from './sim-client.js';
import type { SimEvent } from './sim-protocol.js';

const STICK_DEADZONE = 0.15;
/** Draw the duck this far in the past so a newer pose is always on hand. */
const RENDER_DELAY_MS = 35;
const SPEED_TEST_STEPS = 500; // 10 s of sim time
const LOG_PERIOD_MS = 5000;
const IDLE_AFTER_MS = 6000;
const DIZZY_FALLS = 2;
const DIZZY_WINDOW_MS = 20000;
const DIZZY_MS = 7000;
const DIZZY_SPEED = 0.55;
const PROFILE_KEY = 'microduck.duck';
const WAKE_IN_XR_MS = 1500;
const RUN_PANEL_NODE = 'run-panel';
const MOVES_PANEL_NODE = 'moves-panel';
/** The move bar hangs this far under the scoreboard's centre, along its face (metres). */
const MOVES_BELOW_SCORE = 0.4;
const HUD_BEYOND = 0.95; // metres past the course's far edge
const HUD_HEIGHT = 1.05;
const WAKE_IN_BROWSER_MS = 2500;
// Pollen's blind kick is a short tap: each foot reaches about 6 cm forward,
// and the feet are 7 cm either side of the body. The guides mark where the
// ball has to be (ball centre) for that foot's kick to connect.
const KICK_SPOT_FORWARD = 0.085;
const KICK_SPOT_SIDE = 0.07;
const KICK_SPOT_RADIUS = 0.035;
const KICK_GUIDE_RANGE = 0.35;

export type MoveButton = 'kick' | 'roll' | 'sit' | 'peck' | 'bow';
export type MoveState = 'ready' | 'busy' | 'loading';

const MOVE_POLICIES: Record<MoveButton, PolicyName[]> = {
  kick: ['kickL', 'kickR'],
  roll: ['roll'],
  sit: ['sitstand'],
  peck: ['peck'],
  bow: [], // a keyframe motion, no policy (see training/motion-system.ts)
};

export interface DuckProfile {
  name: string;
  /** Voice pitch, 1 = average duck. */
  voice: number;
}

function loadProfile(): DuckProfile {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as DuckProfile | null;
    if (saved && typeof saved.name === 'string' && typeof saved.voice === 'number') {
      return saved;
    }
  } catch {
    // storage blocked or corrupt: use a fresh duck
  }
  const profile = { name: 'Pip', voice: 0.85 + Math.random() * 0.4 };
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // fine: the duck just won't keep its voice across visits
  }
  return profile;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const deadzone = (v: number): number =>
  Math.abs(v) < STICK_DEADZONE ? 0 : (v - Math.sign(v) * STICK_DEADZONE) / (1 - STICK_DEADZONE);

export class DuckSystem extends createSystem({
  stages: { required: [DuckStage] },
  balls: { required: [CourseBall] },
  finishes: { required: [CourseFinish] },
}) {
  /** One line the panels show about what the duck is doing. */
  status = 'Loading the duck...';
  sim: DuckSimClient | null = null;
  rig: DuckRig | null = null;
  /** Which duck pack is loaded, for run records. */
  packId = '';
  /** The loaded pack and policy folder, for scenario packs. */
  pack: DuckPack | null = null;
  policyBaseUrl = '';
  /** A trained policy set chosen in the app (see PolicyInboxSystem); beats ?policies= and the shipped set. */
  policyOverride: string | null = null;
  private spawnGeneration = 0;
  profile!: DuckProfile;
  /** Latest rendered pose in the stage's MuJoCo frame (see POSE_SIZE). */
  pose!: Float32Array;
  hasPose = false;
  dizzy = false;
  /** True while the player is pushing the walk stick (or holding a walk key). */
  commanded = false;
  /** Set by the nav system to drive the duck when the player is not (command units, -1..1). */
  autopilot: { forward: number; turn: number } | null = null;
  /** The navigation brain is driving: the head (and the distance sensor in it) looks straight ahead, as it trained. */
  headAhead = false;
  /** Where the autopilot is steering (radians off the heading, + left): the duck looks there. */
  autopilotLook: number | null = null;
  /** The twist last sent to the walking policy: forward m/s and turn rad/s (robot panel). */
  commandVx = 0;
  commandWz = 0;
  /** True while a UI drag owns the right trigger (no quacks then). */
  triggerClaimed = false;
  /** The motion system plays keyframe moves ("bow") through this. */
  playMotionHook: ((name: string) => boolean) | null = null;
  motionReady = false;
  fps = 0;
  frameMs = 0;
  frameMaxMs = 0;
  /** Sim events (falls, moves, resets), for the course and the HUD. */
  readonly simEvents = new Set<(event: SimEvent) => void>();
  /** Called after every restart (button, grip, placement). */
  readonly restartListeners = new Set<() => void>();

  private stage: Entity | null = null;
  private ball: Entity | null = null;
  private rigEntity: Entity | null = null;
  private guidesEntity: Entity | null = null;
  private kickGuides: Mesh[] = [];
  private guideIdle!: MeshBasicMaterial;
  private guideReady!: MeshBasicMaterial;
  private head!: Float32Array;
  private v!: Vector3;
  private readonly courseMid = new Vector3();
  /** Set by the room system in mixed reality: moves a HUD point back inside the scanned room. */
  keepInside: ((point: Vector3, from: Vector3) => void) | null = null;
  private rayOrigin!: Vector3;
  private rayDir!: Vector3;
  private right!: Vector3;
  private q!: Quaternion;
  private up!: Vector3;
  private tilt!: Quaternion;
  /** Half a turn about y: the HUD faces the other way when the player stands on the stage's far side. */
  private readonly halfTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  private kickLeftNext = true;
  private lastInputAt = 0;
  private fallTimes: number[] = [];
  private dizzyUntil = 0;
  private autoQuackStart = 0;
  private autoQuackLength = 0;
  private quackArmed = true;
  private frames = 0;
  private frameSum = 0;
  private frameMax = 0;
  private windowStart = 0;
  private lastLog = 0;
  private blurred = false;
  private introPending = false;
  /** Tests and demos: hold the head at its default pose instead of looking at the player. */
  holdHeadNeutral = false;
  /** Done waking up (the intro's sit and stand are over or skipped). */
  get awake(): boolean {
    return this.hasPose && !this.introPending;
  }
  private wakeAt = 0;
  private inXR = false;

  init(): void {
    this.profile = loadProfile();
    this.pose = new Float32Array(POSE_SIZE);
    this.head = new Float32Array(4);
    this.v = new Vector3();
    this.rayOrigin = new Vector3();
    this.rayDir = new Vector3();
    this.right = new Vector3();
    this.q = new Quaternion();
    this.up = new Vector3(0, 1, 0);
    this.tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (-15 * Math.PI) / 180);
    this.windowStart = performance.now();
    this.lastLog = this.windowStart;
    this.lastInputAt = this.windowStart;

    for (const entity of this.queries.stages.entities) {
      this.spawn(entity);
    }
    this.queries.stages.subscribe('qualify', (entity) => this.spawn(entity));
    // A ball that turns up under the live stage after its sim was built joins the sim.
    this.queries.balls.subscribe('qualify', (entity) => {
      const stage = this.stage?.object3D;
      if (stage && this.sim?.ready && entity !== this.ball && this.underStage(entity, stage)) this.rebuildCourse();
    });
    this.queries.stages.subscribe('disqualify', (entity) => {
      if (entity === this.stage) this.unspawn();
    });

    touchControls.install(); // phones and tablets get an on-screen stick (moves are on the menu)
    const onPageVisibility = () => this.applyPause();
    document.addEventListener('visibilitychange', onPageVisibility);
    this.cleanupFuncs.push(
      installAudioUnlock(),
      this.world.visibilityState.subscribe((state) => {
        this.blurred = state === VisibilityState.VisibleBlurred;
        const inXR = state !== VisibilityState.NonImmersive;
        touchControls.setVisible(!inXR);
        if (inXR) {
          unlockAudio(); // entering XR came from a button press
        }
        if (inXR && !this.inXR && this.sim?.ready) {
          this.restart(true); // every entry into XR gets a wake-up
        }
        this.inXR = inXR;
        this.applyPause();
      }),
      () => document.removeEventListener('visibilitychange', onPageVisibility),
      () => this.sim?.dispose(),
    );
  }

  /**
   * Stand the duck back up at the start, respawn the ball, reset the run.
   * With `intro`, the duck comes back sitting and wakes up shortly after.
   */
  restart(intro = false): void {
    if (!this.sim?.ready) {
      return;
    }
    this.sim.reset(intro);
    if (intro) {
      this.introPending = true;
      this.wakeAt = performance.now() + WAKE_IN_XR_MS;
      this.status = `${this.profile.name} is waking up...`;
    }
    this.hasPose = false; // listeners wait for the duck's first new pose
    this.fallTimes.length = 0;
    this.dizzyUntil = 0;
    this.dizzy = false;
    this.lastInputAt = performance.now();
    for (const listener of this.restartListeners) {
      listener();
    }
  }

  /** Run policy + physics flat out for 10 s of sim time and report the speed. */
  runSpeedTest(): void {
    if (this.sim?.ready) {
      this.status = 'Speed test running...';
      this.sim.runBenchmark(SPEED_TEST_STEPS);
    }
  }

  /** Fire a move button ("superpower"). */
  fireMove(button: MoveButton): void {
    const sim = this.sim;
    if (!sim?.ready) {
      return;
    }
    this.lastInputAt = performance.now();
    if (this.introPending) {
      this.wakeAt = 0; // any button wakes the duck first
      return;
    }
    if (button === 'kick') {
      sim.move(this.chooseKickFoot());
    } else if (button === 'bow') {
      this.playMotionHook?.('bow');
    } else if (button === 'sit') {
      const seated = sim.mode === 'sitting' || sim.mode === 'sitting-down';
      sim.move(seated ? 'stand' : 'sit');
    } else {
      sim.move(button);
    }
  }

  /** Whether a move button can fire now (for the HUD). */
  moveState(button: MoveButton): MoveState {
    const sim = this.sim;
    if (!sim?.ready || MOVE_POLICIES[button].some((p) => !sim.loadedPolicies.has(p))) {
      return 'loading';
    }
    if (button === 'bow' && !this.motionReady) {
      return 'loading';
    }
    const mode = sim.mode;
    if (button === 'sit') {
      return mode === 'walk' || mode === 'sitting' || mode === 'sitting-down' ? 'ready' : 'busy';
    }
    return mode === 'walk' ? 'ready' : 'busy';
  }

  /** A quack the duck does on its own (goal, finish, getting up). */
  quack(mood: 'happy' | 'grumpy' | 'woozy' | 'plain' = 'plain'): void {
    playQuack(this.profile.voice, mood);
    this.autoQuackStart = performance.now();
    this.autoQuackLength = mood === 'happy' || mood === 'woozy' ? 340 : 180;
  }

  update(delta: number): void {
    this.trackFrame(delta);
    const sim = this.sim;
    const rig = this.rig;
    if (!sim?.ready || !rig) {
      return;
    }
    const now = performance.now();
    this.dizzy = now < this.dizzyUntil;
    this.readControls(sim, now);
    if (this.introPending && now >= this.wakeAt && sim.mode === 'sitting') {
      this.introPending = false;
      sim.move('stand');
      this.quack('happy');
      this.status = `${this.profile.name} woke up! Left stick to walk.`;
    }
    if (sim.sample(wallNow() - RENDER_DELAY_MS, this.pose)) {
      this.hasPose = true;
      poseDuckRig(rig, this.pose);
      this.poseBall();
      this.poseKickGuides();
      if (!rig.root.visible) {
        rig.root.visible = true;
      }
    } else if (rig.root.visible) {
      rig.root.visible = false; // just reset: wait for the first new pose
    }
    if (this.hasPose) {
      this.aimHead(now);
    }
    this.maybeLog();
  }

  /** Hash of the walking policy driving the duck, once the sim is up. */
  /**
   * Switches the duck to another policy set while it keeps walking
   * (null: back to the shipped set, or ?policies= when given). Later ducks
   * (other playgrounds) load the same set. Resolves with the walking
   * policy's hash.
   */
  async usePolicies(baseUrl: string | null): Promise<string> {
    this.policyOverride = baseUrl;
    const folder = new URLSearchParams(window.location.search).get('policies');
    const url =
      baseUrl ?? (folder ? (folder.endsWith('/') ? folder : `${folder}/`) : `${import.meta.env.BASE_URL}policies/microduck/`);
    this.policyBaseUrl = url;
    // A duck still booting finishes on its first policies, then swaps.
    for (let waited = 0; this.sim && !this.sim.ready && !this.sim.error && waited < 30000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const sim = this.sim;
    if (!sim?.ready) return this.policyHash; // no duck yet: the next one loads it
    return sim.loadPolicies(url);
  }

  get policyHash(): string {
    return this.sim?.ready?.policyHash ?? '';
  }

  /** The stage the duck lives on (the new level's, during a level switch). */
  get stageEntity(): Entity | null {
    return this.stage;
  }

  /** Whether an entity's object sits under this stage (a level switch briefly has two of everything). */
  private underStage(entity: Entity | null | undefined, stage: Object3D): entity is Entity {
    let object: Object3D | null = entity?.object3D ?? null;
    while (object) {
      if (object === stage) return true;
      object = object.parent;
    }
    return false;
  }


  /**
   * The course changed under a live stage (the editor moved or added
   * pieces): rebuild the sim's colliders around the duck, or restart the
   * sim when the ball came or went (that changes the state layout).
   */
  rebuildCourse(): void {
    const stage = this.stage;
    const sim = this.sim;
    if (!stage?.object3D || !sim?.ready) return;
    let ball: Entity | null = null;
    for (const candidate of this.queries.balls.entities) {
      if (this.underStage(candidate, stage.object3D)) ball = candidate;
    }
    if (ball !== this.ball) {
      this.respawn();
      return;
    }
    sim.setCourse(gatherCourse(stage.object3D, ball?.object3D ?? null, stage.object3D.parent));
  }

  /** Start the duck over on the same stage with a fresh sim. */
  respawn(): void {
    const stage = this.stage;
    if (!stage) return;
    this.unspawn(true);
    this.spawn(stage);
  }

  /**
   * The level is going away: drop the duck, its sim and everything built on
   * the stage. With `disposeOwn`, the stage stays and what we built on it
   * (the rig, the kick guides) is removed by hand.
   */
  private unspawn(disposeOwn = false): void {
    this.spawnGeneration++;
    this.sim?.dispose();
    this.sim = null;
    this.rig = null;
    if (disposeOwn) {
      this.rigEntity?.dispose();
      this.guidesEntity?.dispose();
    }
    this.rigEntity = null;
    this.guidesEntity = null;
    this.stage = null;
    this.ball = null;
    this.kickGuides = [];
    this.hasPose = false;
    this.introPending = false;
    this.dizzy = false;
    this.status = 'Loading the duck...';
    for (const listener of this.restartListeners) {
      listener();
    }
  }

  private spawn(stage: Entity): void {
    if (this.stage === stage) {
      return;
    }
    if (this.stage) {
      this.unspawn(); // a new playground: its stage arrives before the old one is disposed
    }
    this.stage = stage;
    this.load(stage).catch((err: unknown) => {
      this.status = `The duck failed to load: ${err instanceof Error ? err.message : String(err)}`;
      console.error('[duck]', err);
    });
  }

  private async load(stage: Entity): Promise<void> {
    const generation = ++this.spawnGeneration;
    const pack = packFromUrl(window.location.search);
    this.packId = pack.id;
    this.pack = pack;
    // ?policies=<folder url> swaps in a trained policy set (same file names).
    const policyFolder = new URLSearchParams(window.location.search).get('policies');
    this.policyBaseUrl =
      this.policyOverride ??
      (policyFolder
        ? policyFolder.endsWith('/')
          ? policyFolder
          : `${policyFolder}/`
        : `${import.meta.env.BASE_URL}policies/microduck/`);
    const stageObject = stage.object3D!;
    this.ball = null;
    for (const candidate of this.queries.balls.entities) {
      if (this.underStage(candidate, stageObject)) this.ball = candidate;
    }
    const course = gatherCourse(stageObject, this.ball?.object3D ?? null, stageObject.parent);
    const sim = new DuckSimClient();
    this.sim = sim;
    sim.onEvent = (event) => this.onSimEvent(event);
    sim.onBenchmark = (result) => {
      this.status = `Speed test done: ${result.speedup.toFixed(1)}x real time.`;
      console.info(
        `[duck] speed test: ${result.steps} steps in ${result.wallMs.toFixed(0)} ms -> ` +
          `${result.speedup.toFixed(1)}x real time (policy ${result.inferMs.toFixed(3)} ms, ` +
          `physics ${result.physicsMs.toFixed(3)} ms per 20 ms step)`,
      );
    };
    const started = sim.start(
      {
        mjcfUrl: packFileUrl(pack, pack.mjcfFile),
        meshBaseUrl: packFileUrl(pack, `${pack.collisionMeshFolder}/`),
        policyBaseUrl: this.policyBaseUrl,
      },
      course,
    );

    const [gltf, kinematics] = await Promise.all([
      AssetManager.loadGLTFById(pack.meshesAssetId),
      fetch(packFileUrl(pack, pack.kinematicsFile)).then((res) => {
        if (!res.ok) {
          throw new Error(`kinematics: HTTP ${res.status}`);
        }
        return res.json() as Promise<DuckKinematics>;
      }),
    ]);
    if (generation !== this.spawnGeneration) {
      return; // the level changed while loading; unspawn() already disposed the sim
    }
    const rig = buildDuckRig(kinematics, gltf, pack);
    rig.root.visible = false;
    const rigEntity = this.world.createTransformEntity(rig.root, { parent: stage });
    // Real things in front of the duck (your hand, a ball) hide it in mixed reality.
    rigEntity.addComponent(DepthOccludable, { mode: OcclusionShadersMode.SoftOcclusion });
    this.rigEntity = rigEntity;
    this.rig = rig;
    if (this.ball?.active) {
      this.createKickGuides(stage);
      if (!this.ball.hasComponent(DepthOccludable)) {
        this.ball.addComponent(DepthOccludable, { mode: OcclusionShadersMode.SoftOcclusion });
      }
    }

    await started;
    if (generation !== this.spawnGeneration) {
      return;
    }
    this.applyPause();
    // The sim boots sitting: wake up shortly (sooner in XR).
    this.introPending = true;
    this.wakeAt = performance.now() + (this.inXR ? WAKE_IN_XR_MS : WAKE_IN_BROWSER_MS);
    this.status = `${this.profile.name} is waking up...`;
    console.info(
      `[duck] ${pack.id} ready in ${sim.ready?.bootMs.toFixed(0)} ms: ${rig.drawCalls} draw calls, ` +
        `${rig.triangles} triangles, model nq=${sim.ready?.nq} ngeom=${sim.ready?.ngeom}, ` +
        `${course.colliders.length} course colliders, ball ${course.ball ? 'yes' : 'no'}`,
    );
    // A level arrives over several frames: its ball or pieces can turn up after
    // the stage this sim was built from. Build around what is there now (a ball
    // that came late means a fresh sim; the worker is reused, so that is quick).
    this.rebuildCourse();
  }

  private onSimEvent(event: SimEvent): void {
    if (event.kind !== 'policy-loaded') {
      const ok = event.ok === undefined ? '' : event.ok ? ' ok' : ' failed';
      console.info(`[duck] ${event.kind}${event.move ? ` ${event.move}` : ''}${ok}`);
    }
    const name = this.profile.name;
    const now = performance.now();
    switch (event.kind) {
      case 'fall':
        this.status = `Oops, ${name} fell! Getting back up...`;
        playSound('bail');
        this.fallTimes.push(now);
        while (this.fallTimes.length > 0 && now - this.fallTimes[0] > DIZZY_WINDOW_MS) {
          this.fallTimes.shift();
        }
        if (this.fallTimes.length >= DIZZY_FALLS) {
          this.dizzyUntil = now + DIZZY_MS;
        }
        break;
      case 'recovered':
        this.status = this.dizzy ? `${name} is dizzy!` : `${name} is back on its feet.`;
        this.quack(this.dizzy ? 'woozy' : 'grumpy');
        break;
      case 'gave-up':
        this.status = `${name} could not get up, so it was reset.`;
        break;
      case 'reset':
        if (!this.introPending) this.status = `${name} is ready. Left stick to walk.`;
        break;
      case 'move-start':
        if (event.move === 'kickL' || event.move === 'kickR') playSound('kick');
        if (event.move === 'roll') playSound('roll');
        break;
    }
    for (const listener of this.simEvents) {
      listener(event);
    }
  }

  private readControls(sim: DuckSimClient, now: number): void {
    let sx = 0;
    let sy = 0;
    const left = this.input.xr.gamepads.left;
    const right = this.input.xr.gamepads.right;
    const stick = left?.getAxesValues(InputComponent.Thumbstick);
    if (stick) {
      sx = stick.x;
      sy = stick.y;
    }
    if (touchControls.shown) {
      sx = Math.max(-1, Math.min(1, sx + touchControls.stick.x));
      sy = Math.max(-1, Math.min(1, sy + touchControls.stick.y));
    }
    const keys = this.input.keyboard;
    if (keys.getKeyPressed('KeyW') || keys.getKeyPressed('ArrowUp')) sy = -1;
    if (keys.getKeyPressed('KeyS') || keys.getKeyPressed('ArrowDown')) sy = 1;
    if (keys.getKeyPressed('KeyA') || keys.getKeyPressed('ArrowLeft')) sx = -1;
    if (keys.getKeyPressed('KeyD') || keys.getKeyPressed('ArrowRight')) sx = 1;

    const speed = this.dizzy ? DIZZY_SPEED : 1;
    let forward = -deadzone(sy) * speed; // sticks report "up" as -1
    let turn = -deadzone(sx) * speed; // pushing left turns left (+ yaw rate)
    this.commanded = forward !== 0 || turn !== 0;
    if (!this.commanded && this.autopilot) {
      forward = this.autopilot.forward * speed;
      turn = this.autopilot.turn * speed;
    }
    if (this.commanded) {
      this.lastInputAt = now;
      if (this.introPending) this.wakeAt = 0; // the stick wakes the duck
    }
    this.commandVx = forward >= 0 ? forward * VEL_FWD : forward * VEL_BACK;
    this.commandWz = turn * VEL_ANG;
    sim.setCommand(this.commandVx, this.commandWz, this.head);

    if (right?.getButtonDown(InputComponent.A_Button) || keys.getKeyDown('KeyJ')) this.fireMove('kick');
    if (right?.getButtonDown(InputComponent.B_Button) || keys.getKeyDown('KeyK')) this.fireMove('roll');
    if (left?.getButtonDown(InputComponent.X_Button) || keys.getKeyDown('KeyL')) this.fireMove('sit');
    if (left?.getButtonDown(InputComponent.Y_Button) || keys.getKeyDown('KeyI')) this.fireMove('peck');
    if (right?.getButtonDown(InputComponent.Thumbstick) || keys.getKeyDown('KeyN')) this.fireMove('bow');
    if (left?.getButtonDown(InputComponent.Squeeze) || keys.getKeyDown('KeyR')) this.restart();
    if (right?.getButtonDown(InputComponent.Squeeze)) this.placeCourseWhereAimed();
    if (keys.getKeyDown('KeyT')) this.runSpeedTest();

    // Quack: the trigger opens the beak; a quack sounds as it passes 40%.
    const squeeze = Math.max(
      this.triggerClaimed ? 0 : (right?.getButtonValue(InputComponent.Trigger) ?? 0),
      keys.getKeyPressed('KeyQ') ? 1 : 0,
    );
    if (squeeze > 0.4 && this.quackArmed) {
      this.quackArmed = false;
      this.lastInputAt = now;
      playQuack(this.profile.voice, this.dizzy ? 'woozy' : 'plain');
    } else if (squeeze < 0.2) {
      this.quackArmed = true;
    }
    let jaw = squeeze;
    const sinceAuto = now - this.autoQuackStart;
    if (sinceAuto < this.autoQuackLength) {
      jaw = Math.max(jaw, Math.abs(Math.sin((sinceAuto / 170) * Math.PI)));
    }
    if (this.rig) {
      setDuckJaw(this.rig, jaw);
    }
  }

  /**
   * Head command: look at the player (or around, when idle), with a woozy
   * wobble while dizzy. Values use the runtime's head-slot conventions.
   */
  private aimHead(now: number): void {
    const stage = this.stage?.object3D;
    if (!stage) {
      return;
    }
    if (this.holdHeadNeutral) {
      this.head.fill(0); // looking straight ahead
      return;
    }
    const p = this.pose;
    const yaw = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
    this.world.camera.getWorldPosition(this.v);
    stage.worldToLocal(this.v);
    const dx = this.v.x - p[0]; // three -> MuJoCo: (x, -z, y)
    const dy = -this.v.z - p[1];
    const dz = this.v.y - (p[2] + 0.1);
    const lx = Math.cos(yaw) * dx + Math.sin(yaw) * dy;
    const ly = -Math.sin(yaw) * dx + Math.cos(yaw) * dy;
    let bearing = Math.atan2(ly, lx);
    let elevation = Math.atan2(dz, Math.max(Math.hypot(lx, ly), 0.05));
    if (this.headAhead && !this.commanded) {
      bearing = 0;
      elevation = 0;
    } else if (this.autopilot && !this.commanded && this.autopilotLook !== null) {
      // Driving itself: it looks where it is going, a little down at the floor ahead.
      bearing = clamp(this.autopilotLook, -0.9, 0.9);
      elevation = -0.15;
    } else if (now - this.lastInputAt > IDLE_AFTER_MS) {
      bearing = 0.8 * Math.sin(now * 0.0009); // idle: look around
      elevation = 0.25 + 0.15 * Math.sin(now * 0.0013);
    } else if (Math.abs(bearing) > 1.75) {
      bearing = 0; // you're behind it: look ahead
      elevation = 0;
    }
    this.head[0] = clamp(0.5 * elevation, -0.2, 0.5); // neck pitch, + looks up
    this.head[1] = clamp(-0.35 * elevation, -0.4, 0.2); // head pitch, + looks down
    this.head[2] = clamp(bearing, -0.9, 0.9); // head yaw, + looks left
    this.head[3] = 0; // head roll, + tilts right
    if (this.dizzy && !(this.headAhead && !this.commanded)) {
      // (Not while the depth brain drives: its sensor rides in the head.)
      this.head[2] = clamp(this.head[2] + 0.3 * Math.sin(now * 0.003), -0.9, 0.9);
      this.head[3] = 0.35 * Math.sin(now * 0.007);
    }
  }

  private poseBall(): void {
    const ball = this.ball?.object3D;
    if (!ball) {
      return;
    }
    const p = this.pose;
    const b = BALL_OFFSET;
    fromMujocoPosition(p[b], p[b + 1], p[b + 2], this.v);
    ball.position.copy(this.v);
    ball.quaternion.copy(fromMujocoQuaternion(p[b + 3], p[b + 4], p[b + 5], p[b + 6], this.q));
  }

  /** Two floor rings showing where the ball must be for each foot's kick. */
  private createKickGuides(stage: Entity): void {
    const group = new Group();
    group.name = 'kick-guides';
    this.guideIdle = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
    this.guideReady = new MeshBasicMaterial({ color: 0x3ddc84 });
    const ring = new RingGeometry(KICK_SPOT_RADIUS - 0.006, KICK_SPOT_RADIUS, 32);
    ring.rotateX(-Math.PI / 2);
    for (const side of ['left', 'right']) {
      const mesh = new Mesh(ring, this.guideIdle);
      mesh.name = `kick-guide-${side}`;
      mesh.position.y = FLOOR_LAYERS.guide;
      mesh.visible = false;
      group.add(mesh);
      this.kickGuides.push(mesh);
    }
    this.guidesEntity = this.world.createTransformEntity(group, { parent: stage });
  }

  private poseKickGuides(): void {
    if (this.kickGuides.length === 0) {
      return;
    }
    const p = this.pose;
    const yaw = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const bx = p[BALL_OFFSET];
    const by = p[BALL_OFFSET + 1];
    const near = Math.hypot(bx - p[0], by - p[1]) < KICK_GUIDE_RANGE && this.sim?.mode === 'walk';
    for (let i = 0; i < 2; i++) {
      const guide = this.kickGuides[i];
      guide.visible = near;
      if (!near) continue;
      const side = i === 0 ? KICK_SPOT_SIDE : -KICK_SPOT_SIDE; // MuJoCo +y is the duck's left
      const x = p[0] + c * KICK_SPOT_FORWARD - s * side;
      const y = p[1] + s * KICK_SPOT_FORWARD + c * side;
      guide.position.set(x, FLOOR_LAYERS.guide, -y); // MuJoCo (x, y) -> three (x, -y)
      const ready = Math.hypot(bx - x, by - y) < KICK_SPOT_RADIUS;
      guide.material = ready ? this.guideReady : this.guideIdle;
    }
  }

  private chooseKickFoot(): 'kickL' | 'kickR' {
    if (this.ball && this.hasPose) {
      const p = this.pose;
      const yaw = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
      const dx = p[BALL_OFFSET] - p[0];
      const dy = p[BALL_OFFSET + 1] - p[1];
      if (Math.hypot(dx, dy) < 0.45) {
        const ly = -Math.sin(yaw) * dx + Math.cos(yaw) * dy;
        return ly > 0 ? 'kickL' : 'kickR'; // MuJoCo +y is the duck's left
      }
    }
    this.kickLeftNext = !this.kickLeftNext;
    return this.kickLeftNext ? 'kickL' : 'kickR';
  }

  /**
   * Put the course where the right controller points: the course runs to
   * your right across your view, centred on the aimed spot.
   */
  private placeCourseWhereAimed(): void {
    const stage = this.stage?.object3D;
    const ray = this.player.raySpaces.right;
    if (!stage || !ray) {
      return;
    }
    ray.updateWorldMatrix(true, false);
    ray.getWorldPosition(this.rayOrigin);
    this.rayDir.set(0, 0, -1).transformDirection(ray.matrixWorld); // rays point down -Z
    if (this.rayDir.y > -0.05) {
      return; // not pointing at the floor
    }
    const distance = -this.rayOrigin.y / this.rayDir.y;
    if (distance > 6) {
      return;
    }
    this.v.copy(this.rayOrigin).addScaledVector(this.rayDir, distance);
    this.world.camera.getWorldQuaternion(this.q);
    this.right.set(1, 0, 0).applyQuaternion(this.q);
    this.right.y = 0;
    if (this.right.lengthSq() < 1e-6) {
      return;
    }
    this.right.normalize();
    this.v.addScaledVector(this.right, -this.courseLength() / 2);
    this.placeCourse(this.v, this.right);
  }

  /**
   * Move the course: `origin` is the stage origin in world space (on the
   * floor) and `right` the world direction the course runs along. The HUD
   * follows, standing beyond the far side of the course and facing the
   * player. Restarts the run; a wake-up still due stays due.
   */
  placeCourse(origin: Vector3, right: Vector3): void {
    const stage = this.stage?.object3D;
    if (!stage) {
      return;
    }
    const yaw = Math.atan2(-right.z, right.x);
    this.q.setFromAxisAngle(this.up, yaw);
    this.v.copy(origin);
    const parent: Object3D | null = stage.parent;
    parent?.worldToLocal(this.v);
    stage.position.set(this.v.x, this.v.y, this.v.z);
    stage.quaternion.copy(this.q);
    try {
      const panel = this.world.requireSceneEntity(RUN_PANEL_NODE).object3D;
      if (panel) {
        // Beyond the course as the player sees it, facing back at them: the
        // stage's -Z side, or its +Z side (turned round) when the player
        // stands on the -Z side (the course can be placed either way round).
        this.courseMid.copy(origin).addScaledVector(right, this.courseLength() / 2);
        this.world.camera.getWorldPosition(this.v);
        const playerOnFar = (this.v.x - this.courseMid.x) * right.z - (this.v.z - this.courseMid.z) * right.x > 0;
        const side = playerOnFar ? -1 : 1;
        this.v.copy(this.courseMid);
        this.v.x += side * right.z * HUD_BEYOND;
        this.v.z -= side * right.x * HUD_BEYOND;
        this.v.y = origin.y + HUD_HEIGHT;
        // In a scanned room: never beyond a wall.
        this.courseMid.y = this.v.y;
        this.keepInside?.(this.v, this.courseMid);
        const panelParent: Object3D | null = panel.parent;
        panelParent?.worldToLocal(this.v);
        panel.position.set(this.v.x, this.v.y, this.v.z);
        panel.quaternion.copy(this.q);
        if (playerOnFar) panel.quaternion.multiply(this.halfTurn);
        panel.quaternion.multiply(this.tilt);
        // The move bar stands just under the scoreboard, on the same slope.
        try {
          const moves = this.world.requireSceneEntity(MOVES_PANEL_NODE).object3D;
          if (moves) {
            moves.quaternion.copy(panel.quaternion);
            this.v.set(0, -MOVES_BELOW_SCORE, 0).applyQuaternion(panel.quaternion);
            moves.position.copy(panel.position).add(this.v);
          }
        } catch {
          // no move bar in this scene
        }
      }
    } catch {
      // no run panel in this scene
    }
    this.restart(this.introPending);
  }

  /** Distance from the stage origin to the finish along the course. */
  private courseLength(): number {
    const stage = this.stage?.object3D;
    for (const finish of this.queries.finishes.entities) {
      if (stage && this.underStage(finish, stage) && finish.object3D) return Math.max(0, finish.object3D.position.x);
    }
    return 0;
  }

  private applyPause(): void {
    this.sim?.setPaused(document.hidden || this.blurred);
  }

  private trackFrame(delta: number): void {
    const ms = delta * 1000;
    this.frames++;
    this.frameSum += ms;
    this.frameMax = Math.max(this.frameMax, ms);
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      this.fps = (this.frames * 1000) / elapsed;
      this.frameMs = this.frameSum / this.frames;
      this.frameMaxMs = this.frameMax;
      this.frames = 0;
      this.frameSum = 0;
      this.frameMax = 0;
      this.windowStart = now;
    }
  }

  private maybeLog(): void {
    const now = performance.now();
    if (now - this.lastLog < LOG_PERIOD_MS) {
      return;
    }
    this.lastLog = now;
    const s = this.sim?.stats;
    const info = this.world.renderer.info.render;
    console.info(
      `[duck] ${this.fps.toFixed(1)} fps, frame ${this.frameMs.toFixed(1)} ms ` +
        `(worst ${this.frameMaxMs.toFixed(1)}), ${info.calls} draws, ${info.triangles} tris | ` +
        (s
          ? `policy ${s.policyHz.toFixed(1)} Hz, infer ${s.inferMs.toFixed(2)} ms ` +
            `(worst ${s.inferMaxMs.toFixed(2)}), physics ${s.physicsMs.toFixed(2)} ms/step, ` +
            `worker busy ${(s.busy * 100).toFixed(0)}%, ${s.mode}, falls ${s.falls}`
          : 'sim stats pending'),
    );
  }
}
