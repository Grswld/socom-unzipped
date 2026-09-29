import { groundGrid, moverSnapshot, rootY, EYE_HEIGHT, STANCES, TICK, Walker, type GroundData, type MoverState, type PlaySnapshot, type Stance, type SwapPick, type TraversalHooks, type WalkInput } from './mover';
import type { Grid } from '@s2u/scene';
import type { GroundWish, Pose } from './camera';
import { firstPersonHeight, firstPersonPeekShift, pitchLimits, PlayerCamera, INIT_AIM_PITCH, type Vec3 } from './playerCamera';

/**
 * The walk mode over the mover: the headless mover and its rules live in `./mover` (web sprint 3's shared sim, M2:
 * the server runs the same code), re-exported here so every import of `./walk` keeps working.
 */
export * from './mover';

/** The half of `FlyCamera` walk mode drives: the look it reads, the view it places, the wish it steps by. */
export interface WalkCamera {
  pose(): Pose;
  setPose(pose: Partial<Pose>): void;
  moveTo(x: number, y: number, z: number): void;
  setWalking(on: boolean): void;
  setPitchLimits(minDegrees: number, maxDegrees: number): void;
  placeView(eye: readonly [number, number, number], target: readonly [number, number, number] | null): void;
  groundWish(): GroundWish;
  /** The look law's state (web research 83, `./look`): its `turnRate`, rad/s left positive, is the actor's turn. */
  lookState?(): { turnRate: number };
}

/** Third person (the game's camera, the default: W2.R1) or first person (`V`). */
export type WalkView = 'third' | 'first';

/**
 * The hook's view of the walk's camera (W2.1): which view, the eye and target drawn, the root, the pitch, and the
 * pass's state (`FUN_0029bf70`: the distance `DAT_003de268`, the hold `cam+0x4c` in seconds).
 */
export interface WalkCameraState {
  mode: WalkView; eye: Vec3; target: Vec3; rootY: number; pitch: number; pass: { distance: number; hold: number };
}

/**
 * Walk and fly, one switch (W1.4 step 5): `G` toggles it (nothing on Ctrl -- `camera.ts` says why), the panel's
 * "walk" box mirrors it through `onChange`, and the hook drives it for Playwright. Entering walk stands the mover on
 * the floor under the camera, or on spawn A when there is none there; the touch stick drives the mover because
 * the mover reads the camera's own wish (`groundWish`). `setCamera` from the hook sets the mover too.
 */
export class WalkMode {
  /** The map's ground, and the mover on it once walk is first asked for: the grid costs 15 ms on Guidance. */
  private ground: GroundData | undefined;
  private walker: Walker | null = null;
  private spawn: [number, number, number] | null = null;
  private walking = false;
  private bound: EventTarget | null = null;
  /** The stance, kept here so a new map's mover takes it on (`setGround` makes a new `Walker`). */
  private stance_: Stance = 'stand';
  /** The game's camera over the mover (W2.1), made with it. */
  private player: PlayerCamera | null = null;
  private view_: WalkView = 'third';
  /** The view last placed: what the hook and the reticle read. */
  private placed: { eye: Vec3; target: Vec3; far: Vec3 } | null = null;
  /** Jumps taken: the animator sees a take-off by the count, whenever between two frames it came. */
  private jumps = 0;
  /** The aim view held (L1, the right button): first person while held, back to `view_` on release. */
  private aiming = false;
  /** TRAVERSAL SEAM: the factory `useTraversal` set, and the moves on the current mover. */
  private traversalFactory: ((walker: Walker, ground: GroundData) => TraversalHooks) | null = null;
  private moves: TraversalHooks | null = null;
  /**
   * The skeleton root's height over the feet as the body is posed (`./play` hands it over after each animator step),
   * or null with no clips: `FUN_0029a950` reads the posed root (`FUN_002869d0` on `actor+0x2e8`, decomp 142450-142460),
   * so the camera rises with the standing jump's root and sinks through a crouch as the clips do.
   */
  private posedRoot: number | null = null;
  /** The look's yaw at the last frame, degrees, and the turn since, radians a second (left positive). */
  private lastYaw: number | null = null;
  private turnRate = 0;

  constructor(private readonly camera: WalkCamera, private readonly onChange: (walking: boolean) => void = () => undefined) {}

  /**
   * TRAVERSAL SEAM (web research 86): the traversal moves' factory, called for each new mover (a map's ground); the
   * moves drive the mover (`Walker.driver`), the clip, the camera's root and peek, and the facing while they run.
   */
  useTraversal(factory: ((walker: Walker, ground: GroundData) => TraversalHooks) | null): void {
    this.traversalFactory = factory;
    this.moves = null;
    if (this.walker) this.attachMoves(this.walker);
  }

  /** TRAVERSAL SEAM: the moves on the current mover, or null (no factory, no ground, not yet walked). */
  traversal(): TraversalHooks | null {
    return this.moves;
  }

  /** TRAVERSAL SEAM: the action button (the ladder's slide, the climb): false when not walking. */
  action(): boolean {
    if (!this.walking || !this.moves) return false;
    this.moves.action();
    return true;
  }

  /** TRAVERSAL SEAM: the lean buttons, held: -1 left, 1 right, 0 neither. */
  lean(side: -1 | 0 | 1): void {
    this.moves?.lean(this.walking ? side : 0);
  }

  private attachMoves(w: Walker): void {
    this.moves = this.traversalFactory && this.ground ? this.traversalFactory(w, this.ground) : null;
    w.driver = this.moves;
  }

  /** The mover's stance (W2.2b): what `C` cycles and the hook reads. */
  stance(): Stance {
    return this.stance_;
  }

  /**
   * Sets the stance, walking or not; false, and nothing changes, for a name that is not one. Walking, it is the game's
   * change (`Walker.changeStance`: a transition clip holds the mover while it plays).
   */
  setStance(stance: Stance): boolean {
    if (!STANCES.includes(stance)) return false;
    if (this.walking && this.walker && this.moves?.busy()) return this.moves.stanceButton(this.walker, stance);   // TRAVERSAL SEAM
    if (this.walking && this.walker && stance === 'prone' && this.stance_ !== 'prone' && this.moves?.dive(this.walker)) {   // TRAVERSAL SEAM: the dive
      this.stance_ = 'prone';
      return true;
    }
    this.stance_ = stance;
    if (this.walker) {
      if (this.walking) this.walker.changeStance(stance);
      else this.walker.stance = stance;
    }
    return true;
  }

  /** `C`: stand, crouch, prone, stand (the game's d-pad cycles them). */
  cycleStance(): Stance {
    this.setStance(STANCES[(STANCES.indexOf(this.stance_) + 1) % STANCES.length]!);
    return this.stance_;
  }

  /**
   * A map's ground and a point on the floor at its spawn A, or none: `main.ts` passes A's (x, z) at the opening
   * stand's floor (W1.4b, `./stand`), A's recorded y where the probe found none. A mover already walking is stood
   * again on the new map, under wherever the page has put the camera; with nothing to stand on it goes back to flying.
   */
  setGround(ground: GroundData | undefined, spawn: [number, number, number] | null): void {
    this.ground = ground;
    this.walker = null;
    this.player = null;
    this.spawn = spawn;
    if (!this.walking) return;
    if (this.stand()) this.restart();
    else this.leave();
  }

  mode(): 'walk' | 'fly' {
    return this.walking ? 'walk' : 'fly';
  }

  /** Walk or fly. False when walk was asked for and there is no floor to stand on: the mode stays fly. */
  setMode(mode: 'walk' | 'fly'): boolean {
    if (mode === 'fly') {
      if (this.walking) this.leave();
      return true;
    }
    if (this.walking) return true;
    if (!this.stand()) return false;
    this.walking = true;
    this.camera.setWalking(true);
    this.camera.setPose({ pitch: INIT_AIM_PITCH });          // the game's spawn pitch, init_aim_pitch (W2.1)
    this.restart();
    this.onChange(true);
    return true;
  }

  /** Third or first person (`V`), or first person while the aim is held. */
  view(): WalkView {
    return this.aiming ? 'first' : this.view_;
  }

  /** The aim view, held: first person from the head while on, the chosen view after. */
  setAiming(on: boolean): void {
    if (this.aiming === on) return;
    this.aiming = on;
    if (this.walking && this.walker) this.follow();
  }

  /** Walk mode: the mover's jump (`Walker.jump`); false when flying, or in the air. */
  jump(): boolean {
    const w = this.walker;
    if (this.moves?.busy()) return !!w && this.walking && this.moves.jump(w);   // TRAVERSAL SEAM: hanging, the jump lets go
    if (!this.walking || !w || !w.jump()) return false;
    this.stance_ = w.stance;
    this.jumps++;
    return true;
  }

  /**
   * Walk mode: the rifle <-> pistol swap's clip for the WEAPON workstream (`Walker.swapWeapon`, `FUN_005a64c0`): the
   * full-body action or the overlay over the locomotion, or null when refused (not walking, in the air, an action).
   */
  swapWeapon(to: 'pistol' | 'rifle'): SwapPick | null {
    if (!this.walking || !this.walker || this.moves?.busy()) return null;
    return this.walker.swapWeapon(to);
  }

  /** Walk mode: crouches (true), stands (false) or toggles stand and crouch (no argument); crouched after (the stance). */
  crouch(on?: boolean): boolean {
    if (!this.walking || !this.walker) return false;
    this.setStance((on ?? this.stance_ !== 'crouch') ? 'crouch' : 'stand');
    return this.stance_ === 'crouch';
  }

  /** The mover's state while walking (in the air, crouched, the stance, the last landing), else null. */
  mover(): MoverState | null {
    const w = this.walker;
    if (!this.walking || !w) return null;
    return { airborne: w.airborne, crouched: w.posture === 'crouch', stance: w.stance, landing: w.landing && { ...w.landing } };
  }

  /** The mover for the body and its clips, while walking; null in fly mode. */
  snapshot(): PlaySnapshot | null {
    const w = this.walker;
    if (!this.walking || !w) return null;
    return moverSnapshot(w, this.moves, this.jumps, this.turnRate);
  }

  /** The action clips' root keys, by clip name (`./play` hands them over from the pack): `Walker.actionRoots`. */
  setActionRoots(roots: ReadonlyMap<string, Float32Array> | null): void {
    this.actionRoots = roots;
    if (this.walker) this.walker.actionRoots = roots;
  }
  private actionRoots: ReadonlyMap<string, Float32Array> | null = null;

  /**
   * The body's posed skeleton root over the feet (`./play`, after each animator step), or null to fall back on the
   * stance's measured root (`rootY`): what the camera stands its target on from the next tick.
   */
  setPosedRoot(rootY: number | null): void {
    this.posedRoot = rootY !== null && Number.isFinite(rootY) ? rootY : null;
  }

  /** Sets the view, walking or not; false for a name that is not one. */
  setView(view: WalkView): boolean {
    if (view !== 'third' && view !== 'first') return false;
    this.view_ = view;
    if (this.walking && this.walker) this.follow();
    return true;
  }

  /**
   * One frame: the look goes to the mover (the pitch clamped to the posture's limits), real time goes in -- the
   * camera ticking after each of the mover's ticks -- and the view is placed between the last two.
   */
  frame(dt: number): void {
    const w = this.walker;
    if (!this.walking || !w) return;
    this.look(w);
    const yaw = w.state.yaw;
    const look = this.camera.lookState?.();
    if (look) this.turnRate = look.turnRate;
    else if (this.lastYaw !== null && dt > 0) {
      const turn = ((((yaw - this.lastYaw) % 360) + 540) % 360) - 180;
      this.turnRate = (turn * Math.PI) / 180 / dt;
    }
    this.lastYaw = yaw;
    w.turn = this.turnRate;
    w.advance(dt, this.camera.groundWish(), () => this.cameraTick());
    this.stance_ = w.stance;                                     // TRAVERSAL SEAM: a move or the water may stand the SEAL up
    this.follow();
  }

  /**
   * The hook's pose, in walk mode as in fly: the look is taken as given, and a position is the eye to drop the mover
   * from, onto the floor under it. With no floor there the pose is honoured and the mode goes back to fly.
   */
  setCamera(pose: Partial<Pose>): void {
    this.camera.setPose(pose);
    const w = this.walker;
    if (!this.walking || !w) return;
    // A turn only: the camera keeps its pass (the distance, the hold) and its root; the next tick takes the turn.
    if (pose.x === undefined && pose.y === undefined && pose.z === undefined) { this.look(w); return; }
    const at = this.camera.pose();
    this.moves?.reset(w);                                        // TRAVERSAL SEAM: a new pose drops a move
    if (w.place(at.x, at.y, at.z)) this.restart();
    else this.leave();
  }

  /**
   * `seconds` of ticks with this input, run now rather than over frames, facing the camera's yaw -- the
   * frame-rate-proof way for a test to walk (`e2e/walk.spec.ts`). Returns the camera's pose at the end.
   */
  walkFor(seconds: number, input: WalkInput): Pose {
    const w = this.walker;
    if (!this.walking || !w) return this.camera.pose();
    this.look(w);
    for (let i = Math.round(seconds / TICK); i > 0; i--) { w.tick(input); this.cameraTick(); }
    this.stance_ = w.stance;                                     // TRAVERSAL SEAM
    w.settle();
    this.player?.settle();
    this.follow();
    return this.camera.pose();
  }

  /** The mover's feet while walking, else null. */
  feet(): [number, number, number] | null {
    const w = this.walker;
    return this.walking && w ? [w.state.x, w.state.y, w.state.z] : null;
  }

  /** The feet as drawn this frame, between the last two ticks (the body's place), or null in fly mode. */
  drawnFeet(): [number, number, number] | null {
    const w = this.walker;
    return this.walking && w ? w.drawnFeet() : null;
  }

  /** The body in use (`Walker.posture`): `stand` while a crouch runs at full stick; the stance when not walking. */
  posture(): Stance {
    return this.walking && this.walker ? this.walker.posture : this.stance_;
  }

  /** The mover's speed over the ground, units a second (0 in fly mode). */
  speed(): number {
    const w = this.walker;
    return this.walking && w ? Math.hypot(w.state.vx, w.state.vz) : 0;
  }

  /** The walk's camera as last placed, or null in fly mode (the hook's `camera()`). */
  cameraState(): WalkCameraState | null {
    const w = this.walker, placed = this.placed;
    if (!this.walking || !w || !placed) return null;
    return {
      mode: this.view_, eye: [...placed.eye], target: [...placed.target],
      rootY: this.player?.rootY() ?? rootY(w.posture), pitch: this.camera.pose().pitch,
      pass: { distance: this.player?.distance() ?? 0, hold: this.player?.hold() ?? 0 },
    };
  }

  /** The point the reticle sits on (`FUN_00297410`'s aim, 1000 ahead along the look), or null in fly mode. */
  aim(): Vec3 | null {
    return this.walking && this.placed ? [...this.placed.far] : null;
  }

  /** W2.5 (`./fire`): the shot's origin and aim -- the eye as placed (the firepoint's stand-in) and the aim point. */
  fireAim(): { eye: Vec3; far: Vec3 } | null {
    return this.walking && this.placed ? { eye: [...this.placed.eye], far: [...this.placed.far] } : null;
  }

  /** W2.5: the hull the mover stands on (the probe's grid), while walking. */
  grid(): Grid | null {
    return this.walking && this.walker ? this.walker.grid : null;
  }

  /**
   * `G` (walk and fly), `C` (the stance, while walking) and `V` (first or third person, while walking) on `target`,
   * ignored with a modifier -- so Ctrl+C and Ctrl+V stay the browser's -- on auto-repeat, and while a control has the
   * keyboard.
   */
  bindKey(target: EventTarget = globalThis): void {
    this.unbindKey();
    target.addEventListener('keydown', this.onKey as EventListener);
    this.bound = target;
  }

  unbindKey(): void {
    this.bound?.removeEventListener('keydown', this.onKey as EventListener);
    this.bound = null;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!['KeyG', 'KeyC', 'KeyV', 'Space'].includes(e.code) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code !== 'KeyG' && !this.walking) return;          // in fly mode Space stays the camera's "up"
    const target = e.target;
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    e.preventDefault();
    if (e.code === 'Space') this.jump();
    else if (e.code === 'KeyC') this.cycleStance();
    else if (e.code === 'KeyV') this.setView(this.view_ === 'third' ? 'first' : 'third');
    else this.setMode(this.walking ? 'fly' : 'walk');
  };

  /** The floor under the camera, else spawn A's. */
  private stand(): boolean {
    if (!this.walker && this.ground) {
      this.walker = new Walker(groundGrid(this.ground));
      this.walker.actionRoots = this.actionRoots;
      this.player = new PlayerCamera(this.walker.grid);
      this.attachMoves(this.walker);                              // TRAVERSAL SEAM
    }
    const w = this.walker;
    if (!w) return false;
    w.stance = this.stance_;
    const at = this.camera.pose();
    if (w.place(at.x, at.y, at.z)) return true;
    return this.spawn !== null && w.place(this.spawn[0], this.spawn[1] + EYE_HEIGHT, this.spawn[2]);
  }

  private leave(): void {
    this.walking = false;
    this.placed = null;
    this.camera.setWalking(false);
    this.onChange(false);
  }

  /** The look to the mover: the camera's yaw is the body's, its pitch clamped to the posture's limits. */
  private look(w: Walker): void {
    const [min, max] = pitchLimits(w.posture);
    this.camera.setPitchLimits(min, max);
    const held = this.moves?.yaw() ?? null;                      // TRAVERSAL SEAM: a ladder holds the facing
    if (held !== null) this.camera.setPose({ yaw: held });
    const look = this.camera.pose();
    w.state.yaw = look.yaw;
    w.state.pitch = look.pitch;
  }

  /** One camera tick on the mover's last tick: on the body's posed root when there is one, else the stance's. */
  private cameraTick(): void {
    const w = this.walker!;
    const posed = this.posedRoot;
    if (this.player) this.player.peek = this.moves?.peek() ?? 0;  // TRAVERSAL SEAM: the lean's peek (the move's root is the posed one)
    this.player?.tick([w.state.x, w.state.y, w.state.z], w.state.yaw, w.state.pitch, posed ?? this.moves?.rootY() ?? rootY(w.posture), undefined, posed !== null);
  }

  /** A new camera on the mover where it now stands (entering walk, a pose from the hook, a new map). */
  private restart(): void {
    const w = this.walker!;
    this.lastYaw = null;
    this.turnRate = 0;
    this.look(w);
    this.player?.reset();
    this.cameraTick();
    this.follow();
  }

  /** The view to the camera: the game's, between the last two ticks, or the head's in first person. */
  private follow(): void {
    const w = this.walker!;
    const third = this.player?.view(w.alpha());
    if (!third) return;
    if (this.view() === 'third') {
      this.placed = third;
      this.camera.placeView(third.eye, third.target);
      return;
    }
    const [x, y, z] = w.drawnFeet();
    const look = this.camera.pose(), yaw = (look.yaw * Math.PI) / 180, pitch = (look.pitch * Math.PI) / 180;
    const side = firstPersonPeekShift(this.moves?.peek() ?? 0);  // TRAVERSAL SEAM: the peek moves the eye across
    const moveRoot = this.moves?.rootY() ?? null;                // a move's root carries the head with it
    const height = moveRoot === null ? firstPersonHeight(w.posture) : firstPersonHeight('stand') + moveRoot - rootY('stand');
    const eye: Vec3 = [x + Math.cos(yaw) * side, y + height, z - Math.sin(yaw) * side];
    const ahead: Vec3 = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const far: Vec3 = [eye[0] + ahead[0] * 1000, eye[1] + ahead[1] * 1000, eye[2] + ahead[2] * 1000];
    this.placed = { eye, target: [eye[0] + ahead[0], eye[1] + ahead[1], eye[2] + ahead[2]], far };
    this.camera.placeView(eye, null);
  }
}
