import { groundGrid, moverSnapshot, reloadHold, rootY, STANCES, TICK, Walker, type GroundData, type HoldClip, type MoverState, type PlaySnapshot, type Stance, type SwapPick, type SwapProgress, type TraversalHooks, type WalkInput } from './mover';
import { PROBE_LIFT, type Grid } from '@s2u/scene';
import type { TraversalPose } from './animator';
import { Button, holdBits, STANCE_CODES, type Command } from './net/protocol';
import { MoverSim } from './net/moverSim';
import { applyKnock, type Knock } from './net/blast';
import { quantiseCommand } from './net/codec';
import { shortTurn, wrapYaw } from './yaw';
import type { GroundWish, Pose } from './camera';
import { pitchLimits, PlayerCamera, INIT_AIM_PITCH, scopeEyeHeight, scopePeekShift, type Vec3 } from './playerCamera';
import { newDeathCamera } from './deathCamera';
import { KEY_STANCE, StanceButton, STANCE_HOLD_S_PLACEHOLDER } from './stanceButton';

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

/** Third person (the game's camera: W2.R1) or the scope's view from the head, while zoomed (`setScoped`). */
export type WalkView = 'third' | 'scope';

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
  /** Whether `G` switches walk and fly (owner, 2026-09-29: off in Play for a player; the developer's `?devmode` keeps it). */
  modeKey = true;
  /** The stance, kept here so a new map's mover takes it on (`setGround` makes a new `Walker`). */
  private stance_: Stance = 'stand';
  /** The game's camera over the mover (W2.1), made with it. */
  private player: PlayerCamera | null = null;
  /** The view last placed: what the hook and the reticle read. */
  private placed: { eye: Vec3; target: Vec3; far: Vec3 } | null = null;
  /** Jumps taken: the animator sees a take-off by the count, whenever between two frames it came. */
  private jumps = 0;
  /** In the scope (the zoom's lens views, `main.ts`): the view from the head while on, third person after. */
  private scoped = false;
  /** In the 9x view or a scope (`./zoom` state 4 and up; not the night vision): the mover's stick x 0.2 (`Walker.scoped`). */
  private scopedMove = false;
  /** MULTIPLAYER: a hold the mover took since the last tick (`hold`), as its bits on the next command. */
  private pressedHold = 0;
  /**
   * `C`, the PC's stance button (owner, 2026-09-29): held or not, a press not yet seen by a frame (a tap quicker than
   * a frame still counts), and its tap-and-hold machine -- a tap toggles stand and crouch (prone to crouch), a hold of
   * `STANCE_HOLD_S_PLACEHOLDER` goes prone -- run once a frame in `frame`.
   */
  private stanceKeyHeld = false;
  private stanceKeyPressed = false;
  private readonly stanceKey = new StanceButton(STANCE_HOLD_S_PLACEHOLDER, KEY_STANCE);
  /** The touch C button (`./touch`): `C`'s rule on its own machine, fed by `stanceTouch`, run beside the key's. */
  private stanceTouchHeld = false;
  private stanceTouchPressed = false;
  private readonly stanceTouchButton = new StanceButton(STANCE_HOLD_S_PLACEHOLDER, KEY_STANCE);
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
  /**
   * MULTIPLAYER (web sprint 3, W3.R8): each tick's command, handed to the net client after the tick with the feet it
   * left the mover on (the prediction), and the presses since the last tick, which ride on the next command. The page
   * applies a press at once, between frames -- before the next tick, where the server's `MoverSim.prepare` applies it.
   */
  private netTap: ((cmd: Omit<Command, 'seq'>, feet: [number, number, number]) => void) | null = null;
  private pressed = 0;
  private pressedStance = 0;
  private weapon_: 0 | 1 = 0;
  private trigger_ = false;
  /** Dead or spectating in a networked round: the mover takes no stick and no presses. */
  private locked = false;
  /** Dead (the net client's `kill` until its `spawn`): the look is not the mover's and the camera is the death's. */
  private dead = false;
  private tickLook: [number, number, number] = [0, 0, 0];
  private deathPose: (() => TraversalPose | null) | null = null;

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

  /**
   * DOORS (`./doorPage`): the map's own action, asked first -- a door under the reticle takes the press, as the game's
   * action button takes a `CZAction` in reach before anything else (`FUN_00592d50`, decomp 452002-452022); true when
   * it did. The press then goes neither to the moves nor on the command (the door rides its own event).
   */
  private actionFilter: (() => boolean) | null = null;
  setActionFilter(filter: (() => boolean) | null): void {
    this.actionFilter = filter;
  }

  /** TRAVERSAL SEAM: the action button (the ladder's slide, the climb): false when not walking. */
  action(): boolean {
    if (this.walking && !this.locked && this.actionFilter?.()) return true;
    if (this.walking) this.pressed |= Button.Action;              // MULTIPLAYER: also the respawn's press (research 91 §4.1)
    if (this.locked || !this.walking || !this.moves) return false;
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

  /** The mover's stance (W2.2b): what `C` and the touch button change and the hook reads. */
  stance(): Stance {
    return this.stance_;
  }

  /**
   * Sets the stance, walking or not; false, and nothing changes, for a name that is not one. Walking, it is the game's
   * change (`Walker.changeStance`: a transition clip holds the mover while it plays).
   */
  setStance(stance: Stance): boolean {
    if (!STANCES.includes(stance)) return false;
    if (this.locked && this.walking) return false;
    if (this.walking) { this.pressed |= Button.Stance; this.pressedStance = STANCE_CODES.indexOf(stance); }   // MULTIPLAYER
    if (this.walking && this.walker && this.moves?.busy()) return this.moves.stanceButton(this.walker, stance);   // TRAVERSAL SEAM
    if (this.walking && this.walker && stance === 'prone' && this.stance_ !== 'prone' && this.moves?.dive(this.walker)) {   // TRAVERSAL SEAM: the dive
      this.stance_ = 'prone';
      return true;
    }
    this.stance_ = stance;
    if (this.walker) {
      if (this.walking) { this.walker.changeStance(stance); this.stance_ = this.walker.stance; }   // deep water: the game's fallback (#22)
      else this.walker.stance = stance;
    }
    return true;
  }

  /**
   * The touch C button (`./touch` `attachTouchControls`), the PC's `C` rule (owner, 2026-09-29; `KEY_STANCE`): a tap
   * toggles stand and crouch (prone to crouch), a hold of `STANCE_HOLD_S_PLACEHOLDER` goes prone; acted on in `frame`.
   * A press is taken only while walking, a release always; a cancel forgets the press, so it is no tap.
   */
  stanceTouch(event: 'down' | 'up' | 'cancel'): void {
    if (event === 'down') {
      if (!this.walking) return;
      this.stanceTouchHeld = true;
      this.stanceTouchPressed = true;
    } else if (event === 'up') {
      this.stanceTouchHeld = false;
    } else {
      this.stanceTouchHeld = false;
      this.stanceTouchPressed = false;
      this.stanceTouchButton.reset();
    }
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

  // ---- MULTIPLAYER (web sprint 3, W3.R8) ----

  /** The net client's tap: each tick's command (numbered by the client) and the feet it predicted; null to stop. */
  setNetTap(tap: ((cmd: Omit<Command, 'seq'>, feet: [number, number, number]) => void) | null): void {
    this.netTap = tap;
    this.pressed = 0;
  }

  /** The trigger held (the body's fire pose on the other screens). */
  setTrigger(on: boolean): void {
    this.trigger_ = on;
  }

  /** Dead or spectating: the mover takes no stick and no presses (the Action press still goes to the server). */
  setLocked(on: boolean): void {
    this.locked = on;
  }

  /** The page's own death clip (`./remotePlayers` `deathPose`), or null when alive. */
  setDeathPose(pose: (() => TraversalPose | null) | null): void {
    this.deathPose = pose;
  }

  isLocked(): boolean {
    return this.locked;
  }

  private tap(w: Walker, wish: WalkInput): void {
    if (!this.netTap) return;
    let buttons = this.pressed | this.pressedHold;
    this.pressed = 0;
    this.pressedHold = 0;
    if (this.scopedMove) buttons |= Button.Scope;
    if (wish.boost) buttons |= Button.Boost;
    if (this.scoped) buttons |= Button.Aim;                    // the scope is the aim now (no first person, 2026-09-29)
    if (this.trigger_) buttons |= Button.Trigger;
    const lean = this.moves?.peeking() ?? 0;
    const leanHeld = (this.moves as { leanHeld?: () => -1 | 0 | 1 } | null)?.leanHeld?.() ?? lean;
    if (leanHeld < 0) buttons |= Button.LeanLeft;
    if (leanHeld > 0) buttons |= Button.LeanRight;
    if ((this.moves as { actionHeldNow?: () => boolean } | null)?.actionHeldNow?.()) buttons |= Button.ActionHeld;
    const q = quantiseCommand({ seq: 0, forward: wish.forward, right: wish.right, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 });
    this.netTap({
      forward: q.forward, right: q.right, yaw: this.tickLook[0], pitch: this.tickLook[1], turn: this.tickLook[2],
      buttons, stance: this.pressedStance, weapon: this.weapon_,
    }, [w.state.x, w.state.y, w.state.z]);
  }

  /**
   * A spawn from the server: a new mover (the server makes a fresh one too) stood at `at` facing `yaw`, then the
   * commands the server has not run on it replayed through the shared apply (`MoverSim`). False with no ground. `at` is
   * the feet: the floor is picked from the feet + `PROBE_LIFT`, the tick's own origin (`Walker.place`; the server's
   * spawn does the same, so the two stand on one floor).
   */
  respawn(at: readonly [number, number, number], yaw: number, replay: readonly Command[] = []): boolean {
    const grid = this.walker?.grid ?? (this.ground ? groundGrid(this.ground) : null);
    if (!grid) return false;
    const w = new Walker(grid);
    w.actionRoots = this.actionRoots;
    this.walker = w;
    if (!this.player) this.player = new PlayerCamera(grid);
    this.attachMoves(w);
    if (!w.place(at[0], at[1] + PROBE_LIFT, at[2])) return false;
    w.state.yaw = wrapYaw(yaw);
    this.stance_ = 'stand';
    this.jumps = 0;
    this.weapon_ = 0;
    this.camera.setPose({ yaw, pitch: INIT_AIM_PITCH });
    if (!this.walking) { this.walking = true; this.camera.setWalking(true); this.onChange(true); }
    const sim = new MoverSim(w, this.moves);
    for (const cmd of replay) { const r = sim.apply(cmd); if (r.jumped) this.jumps++; }
    w.settle();
    this.stance_ = w.stance;
    this.restart();
    return true;
  }

  /** A blast's knock from the server (`./net/blast`): the same `applyKnock` the room laid on its mover. */
  knock(k: Knock): boolean {
    return !!this.walker && this.walking && applyKnock(this.walker, this.moves, k);
  }

  /**
   * Dead or alive, as the match server has it (the net client's `kill` and `spawn`): a dead mover's death landing stays
   * down (`Walker.dead`, `DEATH_LANDING_GETUP_PLACEHOLDER` is the free walk's alone (`&nomatch`, `&fly`)).
   */
  setDead(on: boolean): void {
    this.dead = on;
    if (this.walker) this.walker.dead = on;
    // The death camera from the death (`FUN_00297410` 140900-140913: mode 1 at state 8) to the respawn's new camera
    // (`FUN_00299150`): mode 6 until a killer is named (`setDeathKiller`).
    if (this.player) this.player.death = on ? (this.player.death ?? newDeathCamera()) : null;
  }

  /**
   * The killer the death camera turns to (`./deathCamera` mode 3: `FUN_002980d0` 141355-141375), its origin as the page
   * sees it now; null for a death with none but the SEAL itself (a suicide, a fall: mode 6).
   */
  setDeathKiller(killer: (() => Vec3 | null) | null): void {
    if (this.player?.death) this.player.death = newDeathCamera(killer);
  }

  /** Dead, as the match server has it. */
  isDead(): boolean {
    return this.dead;
  }

  /** A correction from the server: the mover moved by (dx, dy, dz) now (a small one is spread over ticks by the caller). */
  nudge(dx: number, dy: number, dz: number): void {
    const w = this.walker;
    if (!w) return;
    w.state.x += dx; w.state.y += dy; w.state.z += dz;
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

  /** Third person, or the scope's view while zoomed. */
  view(): WalkView {
    return this.scoped && !this.dead ? 'scope' : 'third';     // dead: the death camera, a third-person one
  }

  /** The scope (the zoom in a lens view, `main.ts`): the view from the head while on, third person after. */
  setScoped(on: boolean): void {
    if (this.scoped === on) return;
    this.scoped = on;
    if (this.walking && this.walker) this.follow();
  }

  /**
   * The 9x view or a scope is on (`main.ts`: `./zoom`'s `moveScale()` under 1): the mover's move stick x 0.2
   * (`Walker.scoped`, `FUN_005966a0`), sent as `Button.Scope` so the server's mover walks as slowly.
   */
  setScopedMove(on: boolean): void {
    this.scopedMove = on;
    if (this.walker) this.walker.scoped = on && this.walking;
  }

  /**
   * The kit's one-shot on the mover (`Walker.hold`: a throw's clip at the release, the claymore's placing, a still
   * crouched or prone reload), walking only; the hold rides the next command (`holdBits`) so the server's mover holds
   * on the same tick. False, and nothing sent, when the mover refuses it or the clip is no hold.
   */
  hold(clip: string): boolean {
    const w = this.walker;
    if (!this.walking || !w || this.locked || !w.hold(clip)) return false;
    this.pressedHold = holdBits(clip as HoldClip);
    return true;
  }

  /** The reload's hold for the stance and the weapon in hand (`reloadHold`): the crouched and prone ones only. */
  holdReload(): boolean {
    const w = this.walker;
    const clip = w ? reloadHold(w.stance, this.weapon_ === 1) : null;
    return clip !== null && this.hold(clip);
  }

  /** Walk mode: the mover's jump (`Walker.jump`); false when flying, or in the air. */
  jump(): boolean {
    const w = this.walker;
    if (this.locked) return false;
    if (this.walking) this.pressed |= Button.Jump;              // MULTIPLAYER: the press rides on the next command
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
    if (!this.walking || !this.walker || this.locked) return null;
    if (this.moves?.busy()) return null;
    const pick = this.walker.swapWeapon(to);
    if (pick) {                                                   // MULTIPLAYER: only a swap the mover took goes on the wire
      this.pressed |= Button.Swap;
      this.weapon_ = to === 'pistol' ? 1 : 0;
    }
    return pick;
  }

  /** Walk mode: the swap clip playing and its progress (`Walker.swapProgress`), or null. */
  swapProgress(): SwapProgress | null {
    return this.walking && this.walker ? this.walker.swapProgress() : null;
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
    const s = moverSnapshot(w, this.moves, this.jumps, this.turnRate);
    if (this.deathPose) s.traversal = this.deathPose();     // MULTIPLAYER: the death clip in place of the mover's play
    return s;
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

  /**
   * One frame: the look goes to the mover (the pitch clamped to the posture's limits), real time goes in -- the
   * camera ticking after each of the mover's ticks -- and the view is placed between the last two.
   */
  frame(dt: number): void {
    const w = this.walker;
    if (!this.walking || !w) return;
    // DEAD (DEAD_LOOK_READING, research 91 s16): the look is not the body's -- the dead's controller (`FUN_00592560` L451642-451730) takes the respawn press
    // alone; the body keeps the facing it died with and turns at no rate (the server's corpse ticks the same, `room.ts`).
    if (!this.dead) this.look(w);
    const yaw = w.state.yaw;
    const look = this.camera.lookState?.();
    if (this.dead) this.turnRate = 0;
    else if (look) this.turnRate = look.turnRate;
    else if (this.lastYaw !== null && dt > 0) {
      const turn = shortTurn(this.lastYaw, yaw);
      this.turnRate = (turn * Math.PI) / 180 / dt;
    }
    this.lastYaw = yaw;
    this.stanceKeyFrame(dt);
    w.turn = this.turnRate;
    w.scoped = this.scopedMove;
    const wish = this.locked ? { forward: 0, right: 0, boost: false } : this.camera.groundWish();
    w.advance(dt, wish, () => { this.tap(w, wish); this.cameraTick(); }, () => {
      // MULTIPLAYER: the look each tick starts from (a move may turn the mover inside a tick; the next starts there).
      if (!this.netTap) return wish;
      // Networked, the tick runs on the command as the server will read it (`quantiseCommand`), so the two agree.
      const q = quantiseCommand({ seq: 0, forward: wish.forward, right: wish.right, yaw: w.state.yaw, pitch: w.state.pitch, turn: w.turn, buttons: 0, stance: 0, weapon: 0 });
      w.state.yaw = q.yaw; w.state.pitch = q.pitch; w.turn = q.turn;
      this.tickLook = [q.yaw, q.pitch, q.turn];
      return { forward: q.forward, right: q.right, boost: wish.boost };
    });
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
      mode: this.view(), eye: [...placed.eye], target: [...placed.target],
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
   * `G` (walk and fly), `Space` (the jump) and `C` (the stance: its press and release, while walking) on `target`,
   * ignored with a modifier -- so Ctrl+C stays the browser's -- on auto-repeat, and while a control has the keyboard.
   * A lost keyboard (`blur`) lets `C` go without a tap.
   */
  bindKey(target: EventTarget = globalThis): void {
    this.unbindKey();
    target.addEventListener('keydown', this.onKey as EventListener);
    target.addEventListener('keyup', this.onKeyUp as EventListener);
    target.addEventListener('blur', this.onBlur);
    this.bound = target;
  }

  unbindKey(): void {
    this.bound?.removeEventListener('keydown', this.onKey as EventListener);
    this.bound?.removeEventListener('keyup', this.onKeyUp as EventListener);
    this.bound?.removeEventListener('blur', this.onBlur);
    this.bound = null;
    this.onBlur();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!['KeyG', 'KeyC', 'Space'].includes(e.code) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code !== 'KeyG' && !this.walking) return;          // in fly mode Space stays the camera's "up"
    if (e.code === 'KeyG' && !this.modeKey) return;           // the fly camera is not a player's in Play
    const target = e.target;
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    e.preventDefault();
    if (e.code === 'Space') this.jump();
    else if (e.code === 'KeyC') { this.stanceKeyHeld = true; this.stanceKeyPressed = true; }
    else this.setMode(this.walking ? 'fly' : 'walk');
  };

  /** `C` let go: the tap (or nothing, after a hold) is the next frame's. Taken with a modifier too: a release is a release. */
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyC') this.stanceKeyHeld = false;
  };

  private readonly onBlur = (): void => {
    this.stanceKeyHeld = false;
    this.stanceKeyPressed = false;
    this.stanceKey.reset();
  };

  /** One frame of `C`'s machine and the touch C's: a press between two frames is down for one; the stance asked for, set. */
  private stanceKeyFrame(dt: number): void {
    const down = this.stanceKeyHeld || this.stanceKeyPressed;
    this.stanceKeyPressed = false;
    const go = this.stanceKey.update(down, dt, this.stance_);
    if (go !== null) this.setStance(go);
    const touched = this.stanceTouchHeld || this.stanceTouchPressed;
    this.stanceTouchPressed = false;
    const goTouch = this.stanceTouchButton.update(touched, dt, this.stance_);
    if (goTouch !== null) this.setStance(goTouch);
  }

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
    return this.spawn !== null && w.place(this.spawn[0], this.spawn[1] + PROBE_LIFT, this.spawn[2]);   // the spawn's feet: the tick's pick
  }

  private leave(): void {
    this.walking = false;
    this.onBlur();                                               // a C press under way is no tap on the next walk
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
    w.state.yaw = wrapYaw(look.yaw);                             // canonical whatever camera hands it (yaw.ts)
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

  /** The view to the camera: the game's, between the last two ticks, or the head's in the scope. */
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
    const side = scopePeekShift(this.moves?.peek() ?? 0);        // TRAVERSAL SEAM: the peek moves the eye across
    const moveRoot = this.moves?.rootY() ?? null;                // a move's root carries the head with it
    const height = moveRoot === null ? scopeEyeHeight(w.posture) : scopeEyeHeight('stand') + moveRoot - rootY('stand');
    const eye: Vec3 = [x + Math.cos(yaw) * side, y + height, z - Math.sin(yaw) * side];
    const ahead: Vec3 = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const far: Vec3 = [eye[0] + ahead[0] * 1000, eye[1] + ahead[1] * 1000, eye[2] + ahead[2] * 1000];
    this.placed = { eye, target: [eye[0] + ahead[0], eye[1] + ahead[1], eye[2] + ahead[2]], far };
    this.camera.placeView(eye, null);
  }
}
