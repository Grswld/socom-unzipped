import {
  findLadders, ladderFrame, probeGround, segmentHits, APP_LADDER, SEAL_TUNING,
  type Grid, type Ladder, type MotionClip, type WorldPoly,
} from '@s2u/scene';
import type { TraversalPose } from './animator';
import { ClipPath, clipShape, reverseShape, rootAt, shapeTravel, straightShape, type ClipShape } from './clipPath';
import type { MotionEntry, MotionTable } from './motionTable';
import { BODY_RADIUS, rootY as stanceRootY, TICK, type Stance, type TraversalHooks, type Walker, type WalkInput } from './walk';

/**
 * The traversal moves the walk lacks (web research 86): the ladder (mount at the foot or the head, climb, climb off
 * at the head or the foot, the slide down), with the climb onto obstacles and the lean in `./climb` and `./lean`.
 * `Traversal` is the `Walker`'s tick driver (`Walker.driver`): while a move runs it owns the mover, and it hands the
 * animator the move's clip (`TraversalPose`) and the camera the root it stands on. Every number is the game's, cited to
 * research 86; placeholders are named as such.
 *
 * **The ladder, as the decompilation runs it** (research 86 section 2):
 *
 * ```
 * the list      FUN_002a9260 (decomp ~150340): a node whose di polygons include one with m_appflags == 2
 *               ((byte)poly[+0xA] & 0x7f) >> 4 == 2) is a ladder; a tall face quad and a short (<= 15) quad over it
 * the contact   FUN_005b4b40 (469562) each tick on the wall contact at seal+0x1090, the polygon walked into:
 *               in front, dot(normalize(seal - contact).xz, n) >= 0.3; facing it, dot(back axis, n) >= 0.02
 *               (the short quad: |dot| -- either facing); dropped past 24 across the ground, or feet more than
 *               10 under the short quad's bottom (FUN_005b3890, 469000). No button: walking into it mounts.
 * the mount     the tall quad: FUN_005b1c80 (468183) -> FUN_0057f880: aligned on the quad's horizontal edge's midpoint
 *               facing -normal, "Stand -> Ladder" (seal_stand2ladder, 0.9 s), the root to feet + 15.6 (0x4179999a)
 *               the short quad: FUN_0057f690: "Climb off ladder" backwards (a "180" first when facing away)
 * climbing      state 5, FUN_00584240 (443742): the clip's rate = stick x 0.135 (max_velocity 1.35 x 10 / 100,
 *               FUN_00287620), backwards for a stick back; the rise is the root's (UseVelY, VerticalMotion);
 *               no turning (NoTurn; FUN_0054f7e0), the lateral stick zeroed (FUN_00550ef0)
 * the head      at each cycle's end with the stick up (>= 0.03): a ray 11 along the facing from the root raised by
 *               the climb-off's rise less 1 (FUN_005b0eb0); no ladder polygon hit -> "Climb off ladder" forward,
 *               the SEAL set on the top at its end (FUN_00588bc0, 446544)
 * the foot      stick back and the feet under the ground + 1.0: "Stand -> Ladder" backwards (FUN_00584240)
 * the slide     the action button's "LADDER SLIDE" (0x3e4de8; FUN_00592d50 -> FUN_0057f530 -> FUN_0057f3e0):
 *               "Ladder -> slide" then "Ladderslide", falling at gravity x 0.8 (FUN_0059b440, 456492), the root at
 *               11.44 (FUN_0059b870); on the ground "Ladderslide land" (FUN_0057f310)
 * ```
 *
 * The rate works out at `0.135 x 16 keys / (0.533 s / 3)` = 12.15 keys a second at a full stick, 0.625 units of rise a
 * key: **7.59 units a second** up or down (research 86 section 2.3, a derivation of the parser's fields, W2.2c to
 * measure). A rung is 5 units: `motion.rdr` calls `ladder_rung` at 0.01 and 0.5 of the 10-unit cycle.
 */

// ---- the clips --------------------------------------------------------------------------------------------------

/** The clips the moves play, by what they are for (`motion.rdr`'s names; research 86 section 1). */
export const TRAVERSAL_CLIP = {
  toLadder: 'seal_stand2ladder', ladder: 'seal_climbladder', offLadder: 'seal_climboffladder',
  toSlide: 'seal_ladder2slide', slide: 'seal_ladderslide', slideLand: 'seal_ladderslide_land',
  climbLow: 'seal_climbcrate', climbMed: 'seal_climb_medium', toHang: 'seal_stand2hang', hang: 'seal_hang',
  hangUp: 'seal_hang2climbup', over: 'seal_climb_over',
  stand2llean: 'seal_stand2llean', stand2rlean: 'seal_stand2rlean', crouch2llean: 'seal_crouch2llean',
  crouch2rlean: 'seal_crouch2rlean', prone2llean: 'seal_prone2llean', prone2rlean: 'seal_prone2rlean',
  lleanStep: 'seal_llean_rstep', rleanStep: 'seal_rlean_rstep',
} as const;

/** Every traversal clip, for the worker's clip request (`main.ts` asks for them beside `PLAY_CLIPS`). */
export const TRAVERSAL_CLIPS: readonly string[] = Object.values(TRAVERSAL_CLIP);

/**
 * PLACEHOLDER shapes, for a mover with no clips on hand (the tests without the disc, a page before the pack arrives):
 * each clip's seconds (`motion.rdr` `playback`), root at key 0, rise and travel ahead, read off `MOTION_P.ZAR` and
 * `motion.rdr` on 2026-09-28 (research 86 section 1.2) and replaced by the clips themselves when they come.
 */
const FALLBACK: Record<string, [seconds: number, rootY: number, rise: number, ahead: number, keys: number]> = {
  [TRAVERSAL_CLIP.toLadder]: [0.9, 11.78, 3.52, 6.73, 27],
  [TRAVERSAL_CLIP.ladder]: [16 / 30 / 3, 15.58, 9.375, 0, 16],
  [TRAVERSAL_CLIP.offLadder]: [1.4, 17.02, 18.91, 8.38, 37],
  [TRAVERSAL_CLIP.toSlide]: [0.5, 20.39, -2.99, -2.14, 13],
  [TRAVERSAL_CLIP.slide]: [0.2, 18.26, 0, 0, 7],
  [TRAVERSAL_CLIP.slideLand]: [1.3, 11.44, 0.4, -4.7, 37],
  [TRAVERSAL_CLIP.climbLow]: [1.25, 11.52, 12.88, 11.34, 30],
  [TRAVERSAL_CLIP.climbMed]: [1.5, 11.52, 21.48, 11.44, 32],
  [TRAVERSAL_CLIP.hangUp]: [2.8, 18.14, 22.56, 5.1, 63],
  [TRAVERSAL_CLIP.over]: [1, 10.96, -0.96, 16.28, 19],
};

/** The shapes the moves read: the clips' own when given (`setClips`), else `FALLBACK`'s. */
export class TraversalShapes {
  private readonly shapes = new Map<string, ClipShape>();

  set(clips: Iterable<MotionClip>, table: MotionTable | null): void {
    for (const c of clips) if (TRAVERSAL_CLIPS.includes(c.name)) this.shapes.set(c.name, clipShape(c, table?.get(c.name) as MotionEntry | undefined));
  }

  get(name: string): ClipShape {
    const own = this.shapes.get(name);
    if (own) return own;
    const f = FALLBACK[name];
    if (!f) return straightShape(name, 0.5, 11.484, 0, 0, 2);
    return straightShape(name, f[0], f[1], f[2], f[3], f[4]);
  }

  /** Whether the clip's own shape is in hand. */
  has(name: string): boolean {
    return this.shapes.has(name);
  }
}

// ---- the numbers ------------------------------------------------------------------------------------------------

/** `FUN_005b1c80`: the root's height over the feet as a SEAL takes the ladder (`0x4179999a`), the cycle's key-0 root. */
export const LADDER_ROOT = 15.6;
/** `FUN_00287620`'s rate for the climb: `max_velocity` 1.35 x 10 / 100. */
export const LADDER_RATE = 0.135;
/** The rung callbacks' place in the cycle (`motion.rdr`'s `zanim_callback ladder_rung` at 0.01 and 0.5). */
const RUNG_AT = [0.01, 0.5] as const;
/** `FUN_005b0eb0`: the head ray's reach along the facing. */
const HEAD_RAY = 11;
/** `FUN_00584240`: the foot is reached with the feet under the ground + 1.0. */
const FOOT_CLEAR = 1;
/** `FUN_00586f00`'s / `DAT_003f3428`'s dead zone. */
const DEAD = 0.03;
/** `FUN_005b3890`: the contact is dropped past this across the ground, and with the feet this far under a short quad. */
const CONTACT_RANGE = 24, SHORT_REACH = 10;
/** `FUN_005b4b40`: in front (`>= 0.3`) and facing (`>= 0.02`). */
const IN_FRONT = 0.3, FACING = 0.02;
/** `FUN_002a9260`'s split: a ladder quad at most this tall is the short one at the head. */
const SHORT_QUAD = 15;
/** `motion.rdr`'s `refPt` of the climb off, the slide and its landing: the rungs are 5.565 ahead of the root. */
export const LADDER_STANDOFF = 5.565;
/** `FUN_0059b870`: the root's height through the slide. */
const SLIDE_ROOT = 11.44;
/** `FUN_0059b440`: the slide falls at gravity x 0.8. */
const SLIDE_GRAVITY = 0.8;
/** How near the wall the mover must be for its contact to count: the body's radius, and a margin for the float. */
const TOUCH = BODY_RADIUS + 0.25;
/** The standing root (`walk.ts` `STANCE.stand.rootY`), which the moves hand back to. */
const STAND_ROOT = stanceRootY('stand');

// ---- the state --------------------------------------------------------------------------------------------------

/** What a move is doing: the hook's `traversal()` and the audio's `TraversalEvent` read it. */
export type TraversalKind =
  | 'none' | 'ladderMount' | 'ladderMountTop' | 'ladder' | 'ladderOffTop' | 'ladderOffBottom' | 'ladderSlide' | 'ladderSlideLand'
  | 'climb';

/**
 * What the audio (and anything else) hears (research 86 section 6): `ladderRung` is `motion.rdr`'s `ladder_rung`
 * callback, which plays `.STEP_LADDER` at the hips; `ladderSlide` on/off is the `~LADDER_SLIDE` loop's start and stop;
 * `climbUp` is the climbs' `climb_up` callback (at 0.1), `pullUp` the hang's `pull_up`.
 */
export type TraversalEvent =
  | { type: 'ladderMount'; from: 'bottom' | 'top' }
  | { type: 'ladderRung'; y: number }
  | { type: 'ladderDismount'; at: 'top' | 'bottom' }
  | { type: 'ladderSlide'; on: boolean }
  | { type: 'ladderSlideLand' }
  | { type: 'climbStart'; kind: ClimbKind }
  | { type: 'climbUp' }
  | { type: 'pullUp' }
  | { type: 'climbEnd'; kind: ClimbKind };

/** The climb's height classes (research 86 section 3): `low/med/high_climb_height`, and the vault over. */
export type ClimbKind = 'low' | 'med' | 'high' | 'over';

/** A clip-driven move under way: its path, the clip and its time, what comes after. */
interface Running {
  kind: TraversalKind;
  clip: string;
  path: ClipPath;
  time: number;
  /** Plays the clip backwards: the keys run from the end. */
  reverse: boolean;
  /** Callbacks at a fraction of the clip, fired once. */
  calls: { at: number; event: TraversalEvent; fired: boolean }[];
  done: (w: Walker) => void;
}

/** What `state()` reports. */
export interface TraversalState {
  kind: TraversalKind;
  /** The ladder the mover is on or at, by its node path; null off ladders. */
  ladder: string | null;
  /** The clip playing, its key. */
  clip: string | null;
  key: number;
}

/** The lean clip for a stance and a side (`motion.rdr`: `seal_<stance>2<l|r>lean`, 0.4 / 0.5 / 0.8 and 0.65 s). */
export function leanClip(stance: Stance, side: -1 | 1): string {
  return `seal_${stance}2${side < 0 ? 'l' : 'r'}lean`;
}

/** The facing that looks at a ladder (-normal), as `Pose.yaw` degrees: forward is (-sin, -cos). */
function yawFacing(nx: number, nz: number): number {
  return (Math.atan2(nx, nz) * 180) / Math.PI;
}

/** The mover's forward and right on the ground at a yaw (`walk.ts`'s convention). */
function axes(yaw: number): { fx: number; fz: number; rx: number; rz: number } {
  const y = (yaw * Math.PI) / 180;
  return { fx: -Math.sin(y), fz: -Math.cos(y), rx: Math.cos(y), rz: -Math.sin(y) };
}

/**
 * The traversal driver. `WalkMode` makes one per map (`setGround`) and hangs it on the mover (`Walker.driver`); the
 * page calls `action()` for the action button and reads `pose()`, `rootY()` and `yaw()` each frame.
 */
export class Traversal implements TraversalHooks {
  readonly ladders: Ladder[];
  readonly shapes = new TraversalShapes();
  private running: Running | null = null;
  private kind_: TraversalKind = 'none';
  private ladder: Ladder | null = null;
  /** On a ladder: the cycle's phase in keys (0..16), kept from the climbed height. */
  private phase = 0;
  private slideVy = 0;
  /** The action button, pressed since the last tick. */
  private actionPressed = false;
  private readonly listeners = new Set<(e: TraversalEvent) => void>();
  /** The yaw a move holds the body to, or null. */
  private lock: number | null = null;
  /** The slide's clock, for its loop's key. */
  private slideTime = 0;
  /** The lean button held (-1 left, 1 right), the peek value it drives, the lean clip's clock and stance. */
  private leanSide: -1 | 0 | 1 = 0;
  private peekValue = 0;
  private leanTime = 0;
  private leanOn: { side: -1 | 1; stance: Stance } | null = null;

  constructor(readonly grid: Grid, polys: readonly WorldPoly[]) {
    this.ladders = findLadders(polys, grid);
  }

  /** The clips (`PlayData`), for the moves' paths: their roots replace the fallback shapes. */
  setClips(clips: Iterable<MotionClip>, table: MotionTable | null): void {
    this.shapes.set(clips, table);
  }

  /** Listens for the moves' events (the audio's hook); returns the unsubscribe. */
  on(listener: (e: TraversalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: TraversalEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** The action button (research 86 section 5): on a ladder the slide; taken on the next tick. */
  action(): void {
    this.actionPressed = true;
  }

  /** Whether a move owns the mover. */
  get active(): boolean {
    return this.kind_ !== 'none';
  }

  state(): TraversalState {
    const r = this.running;
    return { kind: this.kind_, ladder: this.ladder?.path ?? null, clip: r?.clip ?? (this.kind_ === 'ladder' ? TRAVERSAL_CLIP.ladder : null), key: r ? this.key(r) : this.phase };
  }

  /** The yaw the body is held to while a move runs (a ladder faces its rungs), or null. */
  yaw(): number | null {
    return this.lock;
  }

  /** The animator's clip (the seam in `./animator`), or null when the walk's own picker plays. */
  pose(): TraversalPose | null {
    const r = this.running;
    if (r) {
      const p = r.path.at(r.time);
      return { clip: r.clip, frame: this.key(r), loop: false, rootY: p.rootY };
    }
    if (this.kind_ === 'ladder') return { clip: TRAVERSAL_CLIP.ladder, frame: this.phase, loop: true, rootY: this.ladderRoot() };
    if (this.kind_ === 'ladderSlide') {
      const shape = this.shapes.get(TRAVERSAL_CLIP.slide);
      return { clip: TRAVERSAL_CLIP.slide, frame: (this.slideTime / shape.seconds) * shape.keys, loop: true, rootY: SLIDE_ROOT };
    }
    const lean = this.leanOn;
    if (lean) {
      const clip = leanClip(lean.stance, lean.side), shape = this.shapes.get(clip);
      return { clip, frame: Math.min(shape.keys - 1, (this.leanTime / shape.seconds) * shape.keys), loop: false, rootY: null };
    }
    return null;
  }

  /** The lean buttons, held (research 86 section 4): -1 left, 1 right, 0 neither. */
  lean(side: -1 | 0 | 1): void {
    this.leanSide = side;
  }

  /** The camera's peek value, `DAT_004161c0` (`FUN_002998f0`, decomp 141960-141976). */
  peek(): number {
    return this.peekValue;
  }

  /**
   * `FUN_002998f0`: the peek value eases to its target at `cam_peek_decay_rate` (`DAT_0044c3bc`, 6 a second):
   * `peek = target + (peek - target) x exp(-6 dt)`; the target is the lean's side, and 0 lying prone (stance 2) or in
   * a move. The body plays the stance's lean clip to its end and holds it while the button is (`LEAN_CLIPS`).
   */
  private leanTick(w: Walker, dt: number): void {
    const stance = w.posture;
    const can = this.kind_ === 'none' && !w.airborne && this.leanSide !== 0;
    const target = can && stance !== 'prone' ? this.leanSide : 0;
    this.peekValue = target + (this.peekValue - target) * Math.exp(-SEAL_TUNING.peekDecayRate * dt);
    if (Math.abs(this.peekValue - target) < 1e-4) this.peekValue = target;
    if (!can) { this.leanOn = null; return; }
    const side = this.leanSide as -1 | 1;
    if (!this.leanOn || this.leanOn.side !== side || this.leanOn.stance !== stance) { this.leanOn = { side, stance }; this.leanTime = 0; }
    else this.leanTime += dt;
  }

  /** The root's height over the feet the camera should stand on while a move runs, or null for the stance's. */
  rootY(): number | null {
    const pose = this.pose();
    return pose ? pose.rootY : null;
  }

  private key(r: Running): number {
    const shape = r.path.shape;
    const k = Math.min(shape.keys - 1, (r.time / shape.seconds) * shape.keys);
    return r.reverse ? shape.keys - 1 - k : k;
  }

  /** The climb's root over the feet: the cycle's key-0 root, its rise carried by the feet. */
  private ladderRoot(): number {
    return rootAt(this.shapes.get(TRAVERSAL_CLIP.ladder), 0)[1];
  }

  // ---- the tick ----

  tick(w: Walker, input: WalkInput, dt: number = TICK): boolean {
    const pressed = this.actionPressed;
    this.actionPressed = false;
    this.leanTick(w, dt);
    if (this.running) { this.advance(w, dt); return true; }
    switch (this.kind_) {
      case 'ladder': this.climbLadder(w, input, dt, pressed); return true;
      case 'ladderSlide': this.slide(w, dt); return true;
      default: break;
    }
    if (!w.airborne) return this.touchLadder(w, input);
    return false;
  }

  /** Runs the clip-driven move a tick: the feet along its path, its callbacks, and what follows at its end. */
  private advance(w: Walker, dt: number): void {
    const r = this.running!;
    r.time = Math.min(r.path.seconds, r.time + dt);
    const p = r.path.at(r.time);
    Object.assign(w.state, { x: p.feet[0], y: p.feet[1], z: p.feet[2], vx: 0, vz: 0, vy: 0 });
    const f = r.time / r.path.seconds;
    for (const c of r.calls) if (!c.fired && f >= c.at) { c.fired = true; this.emit(c.event); }
    if (p.done) {
      this.running = null;
      r.done(w);
    }
  }

  private run(kind: TraversalKind, clip: string, path: ClipPath, reverse: boolean, done: (w: Walker) => void, calls: Running['calls'] = []): void {
    this.kind_ = kind;
    this.running = { kind, clip, path, time: 0, reverse, calls, done };
  }

  private finish(w: Walker): void {
    this.kind_ = 'none';
    this.ladder = null;
    this.lock = null;
    w.state.stickForward = 0; w.state.stickRight = 0;
    w.setAirborne(false);
    w.settle();
  }

  // ---- the ladder ----

  /**
   * `FUN_005b4b40`'s contact test on the ladders near the mover: pushing into a ladder quad, in front of it and facing
   * it (the short quad: either facing), touching it -- the tall quad takes the mover at its foot, the short at its head.
   */
  private touchLadder(w: Walker, input: WalkInput): boolean {
    const s = w.state;
    const wish = Math.hypot(input.forward, input.right);
    if (wish <= DEAD) return false;
    const a = axes(s.yaw);
    const mx = (a.fx * input.forward + a.rx * input.right) / wish, mz = (a.fz * input.forward + a.rz * input.right) / wish;
    for (const l of this.ladders) {
      if (Math.hypot(s.x - l.x, s.z - l.z) > CONTACT_RANGE + l.halfWidth) continue;
      const f = ladderFrame(l, s.x, s.z);
      const excess = Math.max(0, Math.abs(f.across) - l.halfWidth);
      // The tall quad at the foot: from its climbing side; the short quad at the head: from the deck's side.
      const low = s.y + 6, high = s.y + 20;                      // the body's column (walk.ts STANCE.stand)
      const tall = low < l.top && high > l.bottom && l.top - l.bottom > SHORT_QUAD;
      const short = !tall && low < l.capTop && high > l.top && s.y >= l.top - SHORT_REACH;
      if (!tall && !short) continue;
      const side = tall ? 1 : -1;                                // the side of the plane the mover must be on
      const out = f.out * side;
      if (out <= 0 || out > TOUCH || Math.hypot(out, excess) === 0 || out / Math.hypot(out, excess) < IN_FRONT) continue;
      // Walking into it: the wish has a part toward the plane.
      if ((mx * l.nx + mz * l.nz) * side > -FACING) continue;
      const facing = -(a.fx * l.nx + a.fz * l.nz) * side;        // dot(back axis, n): into the quad
      if (tall && facing < FACING) continue;
      if (!tall && Math.abs(facing) < FACING) continue;
      if (tall) this.mountBottom(w, l); else this.mountTop(w, l, facing > 0);
      return true;
    }
    return false;
  }

  /** The mover's place on a ladder at height `y`: on the span's centre line, the stand-off out from the rungs. */
  private onLadder(l: Ladder, y: number): [number, number, number] {
    return [l.x + l.nx * LADDER_STANDOFF, y, l.z + l.nz * LADDER_STANDOFF];
  }

  /** `FUN_0057f880`: "Stand -> Ladder" from where the mover stands to the ladder's foot, facing the rungs. */
  private mountBottom(w: Walker, l: Ladder): void {
    const s = w.state;
    w.stance = 'stand';
    this.ladder = l;
    this.lock = yawFacing(l.nx, l.nz);
    s.yaw = this.lock;
    const shape = this.shapes.get(TRAVERSAL_CLIP.toLadder);
    const path = new ClipPath(shape, [s.x, s.y, s.z], this.onLadder(l, s.y), STAND_ROOT, this.ladderRoot());
    this.emit({ type: 'ladderMount', from: 'bottom' });
    this.run('ladderMount', TRAVERSAL_CLIP.toLadder, path, false, () => this.enterLadder());
  }

  /**
   * `FUN_0057f690`: from the deck onto the ladder's head -- "Climb off ladder" played backwards, from the deck to the
   * height the climb off starts at (`headStart`). A mover facing away turns first ("180", not played: the turn is
   * instant here, a named simplification).
   */
  private mountTop(w: Walker, l: Ladder, _facing: boolean): void {
    const s = w.state;
    w.stance = 'stand';
    this.ladder = l;
    this.lock = yawFacing(l.nx, l.nz);
    s.yaw = this.lock;
    const shape = reverseShape(this.shapes.get(TRAVERSAL_CLIP.offLadder));
    const deck = this.deckPoint(l);
    const from: [number, number, number] = [deck[0], s.y, deck[2]];
    const path = new ClipPath(shape, from, this.onLadder(l, this.headStart(l)), STAND_ROOT, this.ladderRoot());
    this.emit({ type: 'ladderMount', from: 'top' });
    this.run('ladderMountTop', TRAVERSAL_CLIP.offLadder, path, true, () => this.enterLadder());
  }

  private enterLadder(): void {
    this.kind_ = 'ladder';
    this.phase = 0;
  }

  /** The height of the feet on the ladder where the head ray first clears the ladder (the climb off's start). */
  private headStart(l: Ladder): number {
    const off = shapeTravel(this.shapes.get(TRAVERSAL_CLIP.offLadder)).rise;
    return l.capTop - (this.ladderRoot() + off - 1);
  }

  /** The deck the climb off ends on: over the plane on the deck's side, the body's radius and a half clear of it. */
  private deckPoint(l: Ladder): [number, number, number] {
    const off = shapeTravel(this.shapes.get(TRAVERSAL_CLIP.offLadder)).ahead;
    const past = Math.max(off - LADDER_STANDOFF, BODY_RADIUS + 0.5);
    return [l.x - l.nx * past, l.top, l.z - l.nz * past];
  }

  /** The highest floor under (x, z) at or below `y`, or null. */
  private groundUnder(x: number, y: number, z: number): number | null {
    let best: number | null = null;
    for (const h of probeGround(this.grid, x, z)) if (h.y <= y + 1e-6 && (best === null || h.y > best)) best = h.y;
    return best;
  }

  /**
   * State 5 (`FUN_00584240`): the stick's forward axis climbs at `LADDER_RATE` of the clip, 0.625 units a key; the
   * rungs sound at 0.01 and 0.5 of each cycle; at a cycle's end going up the head ray (`FUN_005b0eb0`) decides the
   * climb off; going down, the ground + 1.0 decides the step off; the action button slides.
   */
  private climbLadder(w: Walker, input: WalkInput, dt: number, pressed: boolean): void {
    const l = this.ladder!, s = w.state;
    s.yaw = this.lock ?? s.yaw;
    if (pressed) { this.startSlide(w); return; }
    const stick = Math.abs(input.forward) <= DEAD ? 0 : Math.max(-1, Math.min(1, input.forward));
    const shape = this.shapes.get(TRAVERSAL_CLIP.ladder);
    const keys = shape.keys, rise = shapeTravel(shape).rise, perKey = rise / (keys - 1);
    const keysPerSecond = (LADDER_RATE * keys) / shape.seconds;   // 0.135 x 16 / 0.178 s = 12.15 at a full stick
    const before = this.phase;
    let next = before + stick * keysPerSecond * dt;
    // The head: at the cycle's end with the stick up.
    if (stick > 0 && next >= keys) {
      if (this.headClear(w)) { this.phase = 0; this.climbOffTop(w); return; }
    }
    // The foot: going down with the feet under the ground + 1.
    const ground = this.groundUnder(s.x, s.y + 1e-6, s.z);
    let y = s.y + (next - before) * perKey;
    if (stick < 0 && ground !== null && y < ground + FOOT_CLEAR) { y = Math.max(y, ground); s.y = y; this.climbOffBottom(w, ground); return; }
    y = Math.min(y, this.headStart(l) + rise);                   // never past the head, whatever the ray says
    for (const at of RUNG_AT) {
      const k = at * keys;
      const crossed = stick > 0 ? before < k && next >= k || before < k + keys && next >= k + keys
        : stick < 0 ? before >= k && next < k || before >= k + keys && next < k + keys || before >= k - keys && next < k - keys : false;
      if (crossed) this.emit({ type: 'ladderRung', y });
    }
    next = ((next % keys) + keys) % keys;
    this.phase = next;
    s.y = y;
    s.vx = 0; s.vz = 0; s.vy = stick * perKey * keysPerSecond;
  }

  /** `FUN_005b0eb0`: the ray from the root, raised by the climb off's rise less 1, `HEAD_RAY` along the facing; clear of ladder polygons. */
  private headClear(w: Walker): boolean {
    const s = w.state, a = axes(s.yaw);
    const up = this.ladderRoot() + shapeTravel(this.shapes.get(TRAVERSAL_CLIP.offLadder)).rise - 1;
    const from: [number, number, number] = [s.x, s.y + up, s.z];
    const to: [number, number, number] = [s.x + a.fx * HEAD_RAY, s.y + up, s.z + a.fz * HEAD_RAY];
    return segmentHits(this.grid, from, to, (p) => (p.appflags ?? 0) === APP_LADDER).length === 0;
  }

  /** "Climb off ladder" forward: from the ladder onto the deck, the mover stood on the top at its end (`FUN_00588bc0`). */
  private climbOffTop(w: Walker): void {
    const l = this.ladder!, s = w.state;
    const shape = this.shapes.get(TRAVERSAL_CLIP.offLadder);
    const path = new ClipPath(shape, [s.x, s.y, s.z], this.deckPoint(l), this.ladderRoot(), STAND_ROOT);
    this.run('ladderOffTop', TRAVERSAL_CLIP.offLadder, path, false, (m) => { this.emit({ type: 'ladderDismount', at: 'top' }); this.finish(m); });
  }

  /** "Stand -> Ladder" backwards: off the foot onto the ground, stepping back from the rungs. */
  private climbOffBottom(w: Walker, ground: number): void {
    const l = this.ladder!, s = w.state;
    const shape = reverseShape(this.shapes.get(TRAVERSAL_CLIP.toLadder));
    const back = Math.abs(shapeTravel(shape).ahead);
    const to: [number, number, number] = [s.x + l.nx * back, ground, s.z + l.nz * back];
    const path = new ClipPath(shape, [s.x, s.y, s.z], to, this.ladderRoot(), STAND_ROOT);
    this.run('ladderOffBottom', TRAVERSAL_CLIP.toLadder, path, true, (m) => { this.emit({ type: 'ladderDismount', at: 'bottom' }); this.finish(m); });
  }

  /** `FUN_0057f3e0`: "Ladder -> slide", then the slide itself. */
  private startSlide(w: Walker): void {
    const s = w.state;
    const shape = this.shapes.get(TRAVERSAL_CLIP.toSlide);
    const path = new ClipPath({ ...shape, root: shape.root }, [s.x, s.y, s.z], [s.x, s.y, s.z], this.ladderRoot(), SLIDE_ROOT);
    this.emit({ type: 'ladderSlide', on: true });
    this.run('ladderSlide', TRAVERSAL_CLIP.toSlide, path, false, () => { this.kind_ = 'ladderSlide'; this.slideVy = 0; this.slideTime = 0; });
  }

  /** The slide: gravity x 0.8 down the ladder (`FUN_0059b440`), the root at 11.44, until the ground under it. */
  private slide(w: Walker, dt: number): void {
    const s = w.state;
    s.yaw = this.lock ?? s.yaw;
    this.slideTime += dt;
    this.slideVy -= SEAL_TUNING.gravity * SLIDE_GRAVITY * dt;
    const ground = this.groundUnder(s.x, s.y + 1e-6, s.z);
    let y = s.y + this.slideVy * dt;
    s.vy = this.slideVy;
    if (ground !== null && y <= ground) {
      y = ground;
      s.y = y;
      this.land(w);
      return;
    }
    s.y = y;
  }

  /** `FUN_0057f310`: "Ladderslide land" on the ground, stepping back off the rungs as the clip does. */
  private land(w: Walker): void {
    const l = this.ladder!, s = w.state;
    this.emit({ type: 'ladderSlide', on: false });
    this.emit({ type: 'ladderSlideLand' });
    const shape = this.shapes.get(TRAVERSAL_CLIP.slideLand);
    const back = Math.max(0, -shapeTravel(shape).ahead);
    const to: [number, number, number] = [s.x + l.nx * back, s.y, s.z + l.nz * back];
    const path = new ClipPath(shape, [s.x, s.y, s.z], to, SLIDE_ROOT, STAND_ROOT);
    this.run('ladderSlideLand', TRAVERSAL_CLIP.slideLand, path, false, (m) => this.finish(m));
  }

  /** Drops any move (a new pose from the hook, leaving the walk): the mover is the walk's again. */
  reset(w?: Walker): void {
    this.running = null;
    this.kind_ = 'none';
    this.ladder = null;
    this.lock = null;
    this.actionPressed = false;
    this.leanOn = null;
    this.peekValue = 0;
    if (w) w.setAirborne(false);
  }
}
