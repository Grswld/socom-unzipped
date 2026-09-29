import { partMatrix, sampleClip, SEAL_TUNING, type MotionClip, type PartPose, type Skeleton } from '@s2u/scene';
import {
  BLEND_TIME_DEFAULT, CROUCH_IDLES, PISTOL_ANIMS, MOTION_CLIPS, SEAL_ANIMS, SEAL_SETS, crouchPlay, entryOf, motionOf, nodeSpeed,
  phaseRate, pronePlay, standPlay, type DirectionClass, type Motion, type MotionSets, type PlayNode, type SetName,
} from './locomotion';
import { HEAD_LOOK_NODES, HeadLook, lookFractions } from './headLook';
import type { MotionTable } from './motionTable';
import type { LandingKind } from './physics';
import type { GroundMotion, MoverAction, Stance } from './walk';

/**
 * The SEAL's clips on the mover, played the game's way (web sprint 2 W2.2b; the motion workstream's port, web/docs/
 * research/80-the-jump.md): each frame the mover's state -- its action (the jumps, the landings, the stance
 * transitions) or its ground state and stick -- names a **play**, the game's `FUN_0028dc90` play on the skeleton at
 * `actor+0x170`: a list of nodes (a motion, a weight, a speed) sharing one phase (`./locomotion`).
 *
 * - **Locomotion** is the game's pick and blend, rebuilt every tick with no cross-fade inside it (`FUN_0028bef0` swaps
 *   the node list): standing, the forward/back set and the strafe set shared by the stick's angle (`FUN_00583030`),
 *   each set's clips chosen and split by their transition bands at the stick's speed (`FUN_0058bdf0`); crouched the
 *   one set of the direction class (`FUN_00582d10`); prone the crawl or the prone strafe (`FUN_00583500`). Every clip
 *   plays at the speed that makes its root travel the mover's speed, whatever that is -- no clamp.
 * - **A new play** (a new action, locomotion starting or stopping, a crouch or prone class change) cross-fades from the
 *   pose on screen over the new motion's `BlendTime` (0.4 when `motion.rdr` gives none, `FUN_00287620`), keeping the
 *   phase when both are loops (`FUN_0028dc90`); a stance transition played backwards starts at its end (`FUN_0028c160`).
 * - **One-shots** play keys 0 to n - 1 in `playback x ((n - 1) / n)^2` seconds and hold there (`FUN_0028c4f0`,
 *   `FUN_0028d670`; `./locomotion` `oneShotSeconds`).
 * - **Events** for the page (the audio): each `zanim_callback` as the phase crosses it (`FUN_0028c9e0`), and each
 *   footfall -- the left foot as a moving locomotion phase enters (0, 0.5), the right as it enters (0.5, 1)
 *   (`FUN_005a3570`, decomp 460266-460382) -- and each play started (`onEvent`).
 *
 * **The root.** The mover owns the position: the clip's root travel is not applied to it, and the body's root is stood
 * over the feet at the bind's x and z. The root's height is the clips', blended, so a crouch lowers the body and the
 * standing jump's clip lifts it -- and the camera reads it (`rootY`, `WalkMode.setPosedRoot`).
 */

/** What the SEAL holds. W2.R4's default is the M4A1 SD, a rifle, which the full-body clips hold. */
export type Weapon = 'rifle' | 'pistol';

/**
 * The pistol's version of a clip: `seal_p_<name>` (research 77 §12: `seal_p_*` 79, the pistol). Most carry the
 * spine, the arms, the head and the pistol and no root or legs -- an upper-body layer; a few are whole bodies.
 */
export function layerName(clip: string): string {
  return clip.replace(/^seal_/, 'seal_p_');
}

/** The locomotion clips: every set's, and the prone crawl and strafes (a pistol version counts as its rifle clip's). */
const CYCLES = new Set<string>([
  ...Object.values(SEAL_SETS).flat(), SEAL_ANIMS.proneCrawl, SEAL_ANIMS.proneRight, SEAL_ANIMS.proneLeft,
]);

/** Whether a clip is a locomotion cycle: one a locomotion play's footfalls come from (`FUN_005a3570`). */
export function isCycle(name: string): boolean {
  return CYCLES.has(name.replace(/^seal_p_/, 'seal_'));
}

/** Every clip the page asks the worker for: the plays' (`./locomotion` `MOTION_CLIPS`), then each one's pistol version. */
export const PLAY_CLIPS: readonly string[] = [...MOTION_CLIPS, ...MOTION_CLIPS.map(layerName)];

/** The mover as the animator reads it each frame (`WalkMode.snapshot`). */
export interface MoverSnapshot {
  /** Velocity across the ground, units a second, world axes. */
  vx: number; vz: number;
  /** Upward, units a second. */
  vy: number;
  /** The facing: the look's yaw in degrees, as `Pose.yaw` -- forward is (-sin, -cos), right (cos, -sin). */
  yaw: number;
  airborne: boolean;
  crouched: boolean;
  /** The last landing's class, null in the air or before the first. */
  landing: LandingKind | null;
  /** How many jumps the mover has taken. */
  jumps: number;
  /** The body in use (`Walker.posture`): what the idle plays by. Absent: `crouched` says crouch or stand. */
  stance?: Stance;
  /** The ground state and its stick (`Walker.ground`); absent or `idle`: no locomotion. */
  ground?: GroundMotion;
  /** The action holding the mover, or none. */
  action?: MoverAction | null;
  /**
   * The turn, radians a second, left positive (the look's yaw growing; web research 83's `LookState.turnRate`): prone
   * and still, a turn plays `seal_prone_turn` (`FUN_0054aa30`, decomp 415110, while `actor+0x48` is not 0); standing
   * and crouched a turn plays no clip -- the body pivots.
   */
  turnRate?: number;
  /** The aim's pitch, degrees, up positive (the camera's): the upper body takes it (`FUN_005aca70`). */
  pitch?: number;
  /**
   * The rifle's raise weight, 0 down to 1 up (`FUN_00286b80(actor+0x1160)`; the WEAPON workstream's `./weaponRaise`):
   * the aim's twist is scaled by it and runs only over 0, the head look runs with it at 0 (`FUN_0057a330` 439152-439193).
   * Absent: `AIM_WEIGHT_PLACEHOLDER`.
   */
  aimWeight?: number;
  /**
   * An upper-body clip over the locomotion (`./walk` `MoverOverlay`: the moving rifle <-> pistol swap, a `BlendOverlay`
   * motion on the game's second play channel `anim+0x60`): laid over the parts it carries, `t` of `seconds` in.
   */
  overlay?: { clip: string; t: number; seconds: number; reversed: boolean } | null;
  /** TRAVERSAL SEAM (`./traversal`): a ladder, a climb or a lean playing its own clip; absent or null otherwise. */
  traversal?: TraversalPose | null;
}

/**
 * TRAVERSAL SEAM: a clip a traversal move plays in place of the mover's own play (web research 86): the clip, where it is (keys,
 * the move's own clock: a ladder's phase follows the climbed height), whether it loops, and the skeleton root's height
 * over the drawn feet when the move carries the root's rise in the mover (null: the clip's own). The animator plays it
 * as a one-node play keyed `trav:<clip>`, its phase set from the move's key, so its `zanim_callback`s (`ladder_rung`,
 * `climb_up`, `pull_up`, `jump_whoosh`) fire through `onEvent` like any other play's.
 */
export interface TraversalPose {
  clip: string; frame: number; loop: boolean; rootY: number | null;
  /** The clip's root rotation held at its key 0: the move turns the body by code (the "180"). */
  holdRootTurn?: boolean;
  /** A second node at the same phase and its share (the crate/medium climb, `FUN_00581110`); `clip` has the rest. */
  blend?: { clip: string; weight: number };
}

/** An event for the page: `onEvent`'s listeners get each as the animator steps past it. */
export type AnimEvent =
  /** A `motion.rdr` `zanim_callback` crossed: `name` is the zAnim animation the game fires (e.g. `jump_whoosh`). */
  | { kind: 'callback'; clip: string; name: string; phase: number }
  /** A footfall (`FUN_005a3570`): which foot came down, in which clip. */
  | { kind: 'footfall'; foot: 'left' | 'right'; clip: string }
  /** A new play: its main clip and what started it (`play` key, e.g. `jump`, `land`, `loco:stand`, `idle:crouch`). */
  | { kind: 'play'; clip: string; play: string };

/** What `stats().anim` reports: the main clip, the fractional key, the cross-fade's weight (1 settled) and from what. */
export interface AnimStats {
  clip: string;
  frame: number;
  /** The main clip's key count: `frame / frames` is its phase. */
  frames: number;
  blend: number;
  from: string | null;
  /** Keys a second the main clip advances at this frame (negative: backwards). */
  rate: number;
  /** The upper-body layer over it, or null. */
  layer: string | null;
  /** The play's nodes: each clip, its weight and speed (`+0x24`). */
  nodes: { clip: string; weight: number; speed: number }[];
  /** The play's key (`AnimEvent`'s `play`). */
  play: string;
  /** The run's bank on `spinelo` this frame, radians about its parent's z (`FUN_0057a330`); 0 with none. */
  bank: number;
  /** The upper body's turn toward the aim this frame, radians, `spinelo` and `spinehi` together (`FUN_005aca70`). */
  twist: number;
  /**
   * The head look (`./headLook`): the rotator's yaw and pitch fractions (`FUN_00287210`, right and up positive, 1 at
   * 90 and 80 degrees), whether the pose took it this frame, and the request's priority (1 the turn's lead, 0 ahead).
   */
  look: { yaw: number; pitch: number; on: boolean; priority: number };
  /** The overlay play's clip over the locomotion (the moving swap), or null. */
  overlay: string | null;
}

/** The play's main clip, as a pose layer sees it: the clip, its fractional key and its phase (0 to 1). */
export interface LayerContext {
  clip: MotionClip; frame: number; phase: number;
  /**
   * Every node of the play with a weight, each at its own phase (the main clip's among them): a layer made per motion
   * slot -- the Fire set, `FUN_0057a330` blending each slot's Fire version into that slot -- reads these.
   */
  nodes?: readonly { clip: MotionClip; frame: number; phase: number; weight: number }[];
}

/**
 * A pose over the clips (the WEAPON workstream's fire set and reload, `./weaponPose`): the parts to blend toward and
 * by how much (0 none, 1 all), or null for nothing this frame. A part the layer does not carry keeps the pose below.
 */
export interface PoseLayer {
  sample(current: LayerContext): { parts: readonly PartPose[]; weight: number } | null;
}

/** The held item's node (`FUN_00553290` 0x553290 names it `rifle`) and SOCOM 1's name for it in the older clips. */
export const HELD_PART = 'rifle', HELD_ALIAS = 'weapon';
/** WEAPON: the held items' nodes (`FUN_00553290` slots 1 and 2), whose unmixed locals `Animator.heldLocal` keeps. */
const HELD_NODES = [HELD_PART, 'pistol'] as const;
/**
 * WEAPON: the clips whose `rifle` track is not a hold in the hand but the rifle's place on `spinelo` (`./heldItem`'s
 * `swap` mount): the four swaps, standing, crouched, prone and the moving overlay. Every other clip's `rifle` and
 * `pistol` tracks are the grip in `rhand` (1.27 along the hand, give or take the clip's own turn of it).
 */
export const SPINE_HELD_CLIPS: ReadonlySet<string> = new Set([SEAL_ANIMS.swapStand, SEAL_ANIMS.swapCrouch, SEAL_ANIMS.swapProne, SEAL_ANIMS.swapMoving]);

/** A held node's local and the frame its track is in: `spine` a swap clip's `rifle` on `spinelo`, else the hand's. */
interface HeldLocal { local: Local; spine: boolean }

/**
 * A clip part's skeleton slot. The held item's node is `rifle` in most of the pack's clips and `weapon` in the few
 * that keep SOCOM 1's name (`seal_jump`, `seal_runningjump_in_air`, `seal_prone_crawl`, `seal_crouch_recoil`: the
 * same constant key where both exist; reCOM `zSeal/seal.cpp:150` names the node `weapon`): the viewer's reading is
 * that a clip without `rifle` moves the rifle by its `weapon` track.
 */
export function partIndex(skeleton: Skeleton, parts: readonly { name: string }[], name: string): number {
  const i = skeleton.indexOf(name);
  if (i >= 0 || name !== HELD_ALIAS) return i;
  return parts.some((p) => p.name === HELD_PART) ? -1 : skeleton.indexOf(HELD_PART);
}

export interface AnimatorOptions {
  weapon?: Weapon;
  /** The random draw for the crouch's three idles (`CROUCH_IDLES`), [0, 1): `Math.random` by default. */
  random?: () => number;
}

/**
 * The cross-fade's weight at `s` of its length: the ease the game's node blend traced (research 17 §4.2, `FUN_0028e040`
 * blending a snapshot into the current pose, "a clean symmetric smoothstep": 0.020, 0.080, 0.180, 0.319, 0.499, 0.681,
 * 0.819 at even steps), 2s^2 up to the middle and its mirror after. Between two keys `MOTION_BLEND` (77 §7) still
 * holds: rotations slerp on the shorter arc, translations lerp.
 */
export function blendWeight(s: number): number {
  if (!(s > 0)) return 0;
  if (s >= 1) return 1;
  return s < 0.5 ? 2 * s * s : 1 - 2 * (1 - s) * (1 - s);
}

/**
 * `FUN_0028c7c0(t, from, to)`: whether a callback at phase `t` fires on a step from `from` to `to`: forward, `from <= t
 * <= to`; a loop that wrapped (`to < from`), `from - 1 <= t <= to`; a one-shot played backwards, `to <= t <= from`.
 * No step, no fire.
 */
export function crosses(t: number, from: number, to: number, looped: boolean, backwards: boolean): boolean {
  if (from === to) return false;
  if (!backwards) {
    if (from <= to) return from <= t && t <= to;
    return looped && from - 1 <= t && t <= to;
  }
  if (to <= from) return to <= t && t <= from;
  return looped && to - 1 <= t && t <= from;
}

/** A part's local pose: a unit quaternion (x, y, z, w) and a translation. */
type Local = { q: [number, number, number, number]; t: [number, number, number] };

/**
 * The SEAL skeleton's own parts (`CLIB_GEO.ZED`'s `seal_A_scuba`, research 78): a clip part not among them -- the
 * held item's `rifle`, the props -- keeps the clip's translation.
 */
export const BODY_PARTS: ReadonlySet<string> = new Set([
  'skel_root', 'hips', 'rthigh', 'rcalf', 'rfoot', 'rtoe', 'lthigh', 'lcalf', 'lfoot', 'ltoe', 'aimnodes', 'spinelo',
  'spinehi', 'rshoulder_wgt', 'rscap', 'rbicep', 'rforearm', 'rhand', 'neck', 'head', 'lshoulder_wgt', 'lscap', 'lbicep',
  'lforearm', 'lhand', 'body',
]);

/**
 * The body parts whose translation the engine takes from the clip (`FUN_005777d0`, decomp 437177-437297: `+0x0e` = 0 for
 * the nodes at `actor+0x2e8` skel_root, `+0x304` hips, `+0x328` lbicep, `+0x320` rbicep, `+0x338` lshoulder_wgt,
 * `+0x33c` rshoulder_wgt); every other body part keeps the skeleton's own (the node's `+0x30`). They are exactly the
 * parts whose clip translations move (hips 0.73, the biceps and shoulders 0.6; the rest within 0.18 of the bind).
 */
export const SAMPLED_TRANSLATIONS: ReadonlySet<string> = new Set(['skel_root', 'hips', 'lbicep', 'rbicep', 'lshoulder_wgt', 'rshoulder_wgt']);

/** The skeleton's root part, `m_root` (77 §4). */
const ROOT = 'skel_root';

/**
 * A rotation's quaternion out of a local matrix in the engine's layout (row-major, row vectors: three's column-major
 * elements, `partMatrix`'s inverse): three's `setFromRotationMatrix`, element for element.
 */
export function quatOfMatrix(m: ArrayLike<number>): [number, number, number, number] {
  const m11 = m[0]!, m12 = m[4]!, m13 = m[8]!, m21 = m[1]!, m22 = m[5]!, m23 = m[9]!, m31 = m[2]!, m32 = m[6]!, m33 = m[10]!;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

/**
 * `FUN_00306ae0`, the engine's slerp: the shorter arc; over a dot of 0.95 a normalised lerp, else the true slerp (the
 * node blend `FUN_00576e30`, the cross-fade `FUN_0028e040`).
 */
export function slerp(a: readonly number[], b: readonly number[], t: number): [number, number, number, number] {
  if (t <= 0) return [a[0]!, a[1]!, a[2]!, a[3]!];
  if (t >= 1) return [b[0]!, b[1]!, b[2]!, b[3]!];
  let [bx, by, bz, bw] = b as [number, number, number, number];
  const [ax, ay, az, aw] = a as [number, number, number, number];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  let wa = 1 - t, wb = t;
  if (dot <= 0.95) {
    const theta = Math.acos(Math.min(1, dot)), s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  const x = wa * ax + wb * bx, y = wa * ay + wb * by, z = wa * az + wb * bz, w = wa * aw + wb * bw;
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

/** The cross-fade of one part (`FUN_0028e040`): the turn slerped, the place lerped, `w` of the way from `a` to `b`. */
function mixLocal(a: Local, b: Local, w: number): Local {
  return { q: slerp(a.q, b.q, w), t: [a.t[0] + (b.t[0] - a.t[0]) * w, a.t[1] + (b.t[1] - a.t[1]) * w, a.t[2] + (b.t[2] - a.t[2]) * w] };
}

type Quat = [number, number, number, number];
type Vec = [number, number, number];

/** The Hamilton product `a b` (`FUN_003070c0`): `b` first, then `a` (three.js's `multiplyQuaternions`). */
export function qmul(a: readonly number[], b: readonly number[]): Quat {
  const [ax, ay, az, aw] = a as Quat, [bx, by, bz, bw] = b as Quat;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** `v` turned by the unit quaternion `q`. */
export function qrot(q: readonly number[], v: readonly number[]): Vec {
  const [x, y, z, w] = q as Quat;
  const tx = 2 * (y * v[2]! - z * v[1]!), ty = 2 * (z * v[0]! - x * v[2]!), tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}

/** The model's forward in its own frame (`DAT_003f6500`, set at start-up; the SEAL faces -z: research 77, 78). */
const MODEL_FORWARD: Vec = [0, 0, -1];

/**
 * `FUN_005aca70`'s share of the aim each spine node takes (decomp 465019-465336): the cross of the forward and the aim,
 * both in the node's frame, times the aim weight and this, is a rotation vector whose quaternion is
 * `(v sin|v| / |v|, cos|v|)` (`FUN_003067b0`) -- so the node turns by twice it. `spinelo` 0.1, `spinehi` 0.4: the
 * whole of a small pitch between them.
 */
export const TWIST_SHARE: Readonly<Record<'spinelo' | 'spinehi', number>> = Object.freeze({ spinelo: 0.1, spinehi: 0.4 });

/**
 * The aim weight when the mover gives none (`MoverSnapshot.aimWeight`, fed from the WEAPON workstream's raise envelope
 * `FUN_00286b80(actor+0x1160)`): the rifle taken as up.
 */
export const AIM_WEIGHT_PLACEHOLDER = 1;


/** `FUN_0057a330` (decomp 439197-439204): the run's bank on `spinelo`, radians, for a turn (rad/s) and the local z speed. */
export const BANK_FACTOR = -0.000375;

/**
 * `FUN_00583960` (decomp 443497-443545): the turn-in-place clip's speed for the turn axis (`actor+0x23c`, the turn over
 * `turn_maxrate`): |axis| times the stance's share, capped at it -- standing 0.6 (`Step`), crouched 0.3 (`Crouch
 * step`), prone 0.35 (`Prone turn`) -- and backwards for a left turn (a positive axis).
 */
export const TURN_STEP: Readonly<Record<Stance, number>> = Object.freeze({ stand: 0.6, crouch: 0.3, prone: 0.35 });
export function turnStepSpeed(turnRate: number, stance: Stance): number {
  const axis = turnRate / SEAL_TUNING.turnMaxRate, cap = TURN_STEP[stance];
  const speed = Math.min(cap, Math.abs(axis) * cap);
  return -axis * 2 < 0 ? -speed : speed;
}

/**
 * `FUN_00577000` with `FUN_00576e30` (decomp 436853-437136): the nodes' rotations for one part merged two at a time --
 * the `Lateral` clips first, then the others, then what is left -- each pair by the engine's slerp at `wb / (wa + wb)`,
 * the survivor carrying the summed weight. A node that lacks the part gives way to one that has it.
 */
export function mergeRotations(entries: { q: Quat | null; w: number; lateral: boolean }[]): Quat | null {
  const live = entries.map((e) => ({ ...e, on: true }));
  const pass = (pick: (e: { lateral: boolean }) => boolean): void => {
    for (let guard = 0; guard < 30; guard++) {
      const two = live.filter((e) => e.on && pick(e)).slice(0, 2);
      if (two.length < 2) return;
      const [a, b] = two as [typeof live[number], typeof live[number]];
      const total = a.w + b.w;
      const f = total > 0 ? Math.min(1, Math.max(0, b.w / total)) : 0;
      if (!a.q) a.q = b.q;
      else if (b.q && f > 0.001) a.q = f >= 0.999 ? b.q : slerp(a.q, b.q, f);
      a.w = total;
      b.on = false;
    }
  };
  pass((e) => e.lateral);
  pass((e) => !e.lateral);
  pass(() => true);
  return live.find((e) => e.on)?.q ?? null;
}

/** Each skeleton part's bind pose as a quaternion and a translation. */
function bindLocals(skeleton: Skeleton): Local[] {
  return skeleton.parts.map((p) => ({ q: quatOfMatrix(p.bindLocal), t: [p.bindLocal[12]!, p.bindLocal[13]!, p.bindLocal[14]!] }));
}

/**
 * Writes a sampled pose into the skeleton (`Skeleton.setLocal` per part it has; a prop the skeleton lacks is
 * skipped), the root stood over the feet at the bind's x and z with the clip's height, then composes it.
 */
export function writePose(skeleton: Skeleton, parts: readonly PartPose[]): void {
  const root = skeleton.indexOf(ROOT);
  for (const p of parts) {
    const i = skeleton.indexOf(p.name);
    if (i < 0) continue;
    const t: [number, number, number] = i === root
      ? [skeleton.parts[i]!.bindLocal[12]!, p.translation[1], skeleton.parts[i]!.bindLocal[14]!] : p.translation;
    skeleton.setLocal(i, partMatrix(p.rotation, t));
  }
  skeleton.update();
}

/** A play: its key, its nodes, its phase, and whether it loops or runs backwards. */
interface Play {
  key: string;
  nodes: PlayNode[];
  phase: number;
  looped: boolean;
  backwards: boolean;
  /** The crouch idle drawn for this play (`CROUCH_IDLES`), kept while it lasts. */
  pick?: Motion;
}

/** What the mover asks to be played: a key, and how to build (and rebuild) its nodes. */
interface Wanted {
  key: string;
  nodes: () => PlayNode[];
  /** A stance transition played backwards (`FUN_0028c160`). */
  backwards?: boolean;
  /** A locomotion play: footfalls count. */
  locomotion?: boolean;
  /** Rebuilt every tick (`FUN_0028bef0`'s swap, or a speed set each tick): the locomotion and the turn in place. */
  rebuild?: boolean;
  /**
   * `FUN_00586050`: starting the turn in place from a loop whose phase x 60 is in 17..47, the phase goes to 0.5 (the
   * other foot).
   */
  snapHalf?: boolean;
}

/**
 * The player of the clips: `step` once a frame with the mover's state. It works out the play the mover's state asks
 * for, starts it (a cross-fade from the pose on screen) when that is a new one, rebuilds a locomotion play's nodes,
 * advances the shared phase, fires the events it passed, samples and blends the nodes, and writes the skeleton. A
 * clip the pack lacks is left out of its play; with nothing to play the skeleton keeps its bind pose.
 */
export class Animator {
  private readonly motions = new Map<string, Motion>();
  private readonly sets: MotionSets;
  private readonly bind: Local[];
  private readonly root: number;
  private weapon: Weapon;
  private readonly random: () => number;
  /** The pose on screen, per skeleton part. */
  private readonly shown: Local[];
  /** The pose the cross-fade leaves, frozen when the play changed (`FUN_0028e3e0`'s snapshot, research 17 §4.2). */
  private from: { name: string; pose: Local[]; held: Map<number, HeldLocal> } | null = null;
  private blendElapsed = 0;
  private blendLength = BLEND_TIME_DEFAULT;
  private play: Play | null = null;
  private layer: MotionClip | null = null;
  private lastRate = 0;
  /** `actor+0x211` / `+0x210`: the left and the right foot already struck this half cycle. */
  private feet = { left: false, right: false };
  private readonly listeners = new Set<(e: AnimEvent) => void>();
  private readonly poseLayers: PoseLayer[] = [];
  /** Per part: the clip's translation (`SAMPLED_TRANSLATIONS`, the props), else the skeleton's own. */
  private readonly clipTranslation: boolean[];
  private lastBank = 0;
  private lastTwist = 0;
  /** The head look (`./headLook`): the controller's request, the rotator at `actor+0x1190`, the pose. */
  readonly look: HeadLook;
  /**
   * WEAPON: the held items' nodes (`rifle`, `pistol`) as `heldLocal` gives them this frame, and the frame each is in:
   * cross-faded with the arms where the pose left and the pose coming hold it in the same frame, else the clip coming's
   * own (`heldLocal`). What a cross-fade starting freezes (`from.held`).
   */
  private readonly heldShown = new Map<number, HeldLocal>();
  /** The overlay play's clip this frame, or null (`stats().overlay`). */
  private overlayName: string | null = null;
  private lookDt = 0;
  private lookOn = false;
  /** TRAVERSAL SEAM: the root's height over the feet a traversal move sets, or null for the clip's own. */
  private rootOverride: number | null = null;
  /** TRAVERSAL SEAM: the root's rotation a traversal move holds (the clip's key 0), or null for the clip's own. */
  private rootTurn: [number, number, number, number] | null = null;
  /** TRAVERSAL SEAM: the move's play has had its first key (its phase is the move's, not the one carried over). */
  private traversalStarted = false;

  constructor(private readonly skeleton: Skeleton, clips: Iterable<MotionClip>, private readonly table: MotionTable | null, options: AnimatorOptions = {}) {
    for (const c of clips) this.motions.set(c.name, motionOf(c, entryOf(c.name, table)));
    this.sets = Object.fromEntries((Object.keys(SEAL_SETS) as SetName[]).map((k) => [k, SEAL_SETS[k].flatMap((n) => {
      const m = this.motions.get(n);
      return m ? [m] : [];
    })])) as MotionSets;
    this.bind = bindLocals(skeleton);
    this.shown = this.bind.map((l) => ({ q: [...l.q], t: [...l.t] }));
    this.root = skeleton.indexOf(ROOT);
    this.clipTranslation = skeleton.parts.map((p) => SAMPLED_TRANSLATIONS.has(p.name) || !BODY_PARTS.has(p.name));
    this.weapon = options.weapon ?? 'rifle';
    this.random = options.random ?? Math.random;
    this.look = new HeadLook(this.random);
  }

  /**
   * Adds a pose layer over the clips (additive: the plays and the cross-fade are untouched). Layers apply in the order
   * added, each blended over the pose below it by its own weight, after the nodes and the pistol layer and before the
   * cross-fade; each sees the play's main clip.
   */
  addPoseLayer(layer: PoseLayer): void {
    this.poseLayers.push(layer);
  }

  /** Listens to the animator's events (`AnimEvent`); returns the unsubscribe. */
  onEvent(listener: (e: AnimEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The motion a clip plays as (`./locomotion` `Motion`), or undefined when the pack lacks it. */
  motion(name: string): Motion | undefined {
    return this.motions.get(name);
  }

  /** One frame of `dt` seconds with the mover as it now stands. */
  step(dt: number, mover: MoverSnapshot): void {
    // The controller's look request runs every tick (FUN_00596f10 -> FUN_00600550), whatever the body plays.
    this.look.request(dt, (mover.turnRate ?? 0) / SEAL_TUNING.turnMaxRate);
    this.lookDt = dt;
    if (mover.traversal) { this.traversalStep(dt, mover.traversal, mover); return; }
    this.rootOverride = null;
    this.rootTurn = null;
    const wanted = this.wanted(mover);
    if (!wanted) return;
    let play = this.play;
    if (!play || play.key !== wanted.key) play = this.start(wanted);
    else if (wanted.rebuild) play.nodes = wanted.nodes();
    if (!play.nodes.length) return;
    if (play !== this.play) this.play = play;
    else this.blendElapsed += dt;

    const before = play.phase;
    const rate = phaseRate(play.nodes);
    let after = before + rate * dt;
    const end = play.looped ? 1 : play.nodes[0]!.motion.end;
    if (play.looped) after = ((after % 1) + 1) % 1;
    else after = Math.min(end, Math.max(0, after));
    play.phase = after;
    const main = this.main(play);
    this.lastRate = rate * main.motion.frames;
    this.pose(mover);
    this.fire(play, before, after, rate < 0, wanted.locomotion === true && !mover.airborne && Math.hypot(mover.vx, mover.vz, mover.vy) > 0.5);
  }

  /**
   * TRAVERSAL SEAM (`./traversal`, web research 86): the move's clip as a one-node play at the move's own key -- no
   * advance of its own -- its callbacks fired as its phase passes them, the root's height the move's.
   */
  private traversalStep(dt: number, over: TraversalPose, mover: MoverSnapshot): void {
    const m = this.motions.get(over.clip);
    if (!m) return;
    const second = over.blend ? this.motions.get(over.blend.clip) : undefined;
    const key = second ? `trav:${over.clip}+${second.name}` : `trav:${over.clip}`;
    let play = this.play;
    if (!play || play.key !== key) {
      // A blend's play is made for its second node (the medium: `FUN_00581110` starts "Climb medium", then swaps in
      // the two), whose end and phase the move's key is laid out on.
      play = this.start({ key, nodes: () => second && over.blend
        ? [{ motion: second, weight: 1 - over.blend.weight, speed: 0, offset: 0 }, { motion: m, weight: over.blend.weight, speed: 0, offset: 0 }]
        : [{ motion: m, weight: 1, speed: 0, offset: 0 }] });
      play.looped = over.loop;
      this.play = play;
      this.traversalStarted = false;                             // a new move's first key fires nothing behind it
    } else this.blendElapsed += dt;
    const lead = second ?? m;
    const frames = lead.clip.frameCount;
    let after = over.frame / frames;
    after = over.loop ? ((after % 1) + 1) % 1 : Math.max(0, Math.min(lead.end, after));
    const before = play === this.play && play.key === key && play.phase !== undefined && this.traversalStarted ? play.phase : after;
    this.traversalStarted = true;
    play.phase = after;
    this.lastRate = dt > 0 ? ((after - before) * frames) / dt : 0;
    this.rootOverride = over.rootY;
    this.rootTurn = over.holdRootTurn ? (sampleClip(m.clip, 0, { loop: false }).parts.find((p) => p.name === ROOT)?.rotation ?? null) : null;
    // A ladder or a climb holds the body to its clip: no aim twist, no run bank (FUN_005aca70, FUN_0057a330 are the
    // ground state's).
    this.pose({ ...mover, pitch: undefined, turnRate: 0 });
    if (after !== before) this.fire(play, before, after, after < before && !over.loop, false);
  }

  /** The play the mover asks for (the header's rules), or null when there is nothing to play it with. */
  private wanted(mover: MoverSnapshot): Wanted | null {
    const one = (key: string, name: string, backwards = false): Wanted => ({
      key, backwards, nodes: () => {
        const m = this.motions.get(name);
        return m ? [{ motion: m, weight: 1, speed: nodeSpeed(m, 1) * (backwards ? -1 : 1), offset: 0 }] : [];
      },
    });
    const a = mover.action;
    if (a) {
      const name = a.name === 'fall' ? SEAL_ANIMS.inAir : a.name === 'launch' ? SEAL_ANIMS.launch : SEAL_ANIMS[a.name];
      return one(`${a.name}#${a.serial}`, name, a.reversed);
    }
    const g = mover.ground;
    const stance: Stance = mover.stance ?? (mover.crouched ? 'crouch' : 'stand');
    if (g && g.state === 'stand') return { key: 'loco:stand', locomotion: true, rebuild: true, nodes: () => standPlay(g.forward, g.right, this.sets) };
    if (g && g.state !== 'idle' && g.cls !== -1) {
      const cls = g.cls as DirectionClass;
      if (g.state === 'crouch') return { key: `loco:crouch:${cls}`, locomotion: true, rebuild: true, nodes: () => crouchPlay(g.forward, g.right, cls, this.sets) };
      const motions = { crawl: this.motions.get(SEAL_ANIMS.proneCrawl), right: this.motions.get(SEAL_ANIMS.proneRight), left: this.motions.get(SEAL_ANIMS.proneLeft) };
      return { key: `loco:prone:${cls}`, locomotion: true, rebuild: true, nodes: () => pronePlay(g.forward, g.right, cls, motions) };
    }
    const turn = mover.turnRate ?? 0;
    if (turn !== 0 && !mover.airborne) {
      // Turning in place, the move stick at rest (FUN_00586570 -> FUN_00586050, FUN_00584c60, FUN_005845c0): the
      // stance's step clip, its speed set each tick by the turn (FUN_00583960).
      const name = stance === 'prone' ? SEAL_ANIMS.proneTurn : stance === 'crouch' ? SEAL_ANIMS.crouchStep : SEAL_ANIMS.step;
      const m = this.motions.get(name);
      if (m) {
        return {
          key: `turn:${stance}`, rebuild: true, snapHalf: stance !== 'prone',
          nodes: () => [{ motion: m, weight: 1, speed: nodeSpeed(m, turnStepSpeed(turn, stance)), offset: 0 }],
        };
      }
    }
    if (stance === 'crouch') {
      return {
        key: 'idle:crouch', nodes: () => {
          const pick = this.play?.key === 'idle:crouch' && this.play.pick ? this.play.pick : this.crouchIdle();
          return pick ? [{ motion: pick, weight: 1, speed: nodeSpeed(pick, 1), offset: 0 }] : [];
        },
      };
    }
    return stance === 'prone' ? one('idle:prone', SEAL_ANIMS.prone) : one('idle:stand', SEAL_ANIMS.stand);
  }

  /** `CROUCH_IDLES`: one of the crouch's three, by their chances; the plain crouch when the others are not on hand. */
  private crouchIdle(): Motion | undefined {
    const on = CROUCH_IDLES.filter((c) => this.motions.has(c.clip));
    const total = on.reduce((t, c) => t + c.chance, 0);
    let r = this.random() * total;
    for (const c of on) {
      r -= c.chance;
      if (r < 0) return this.motions.get(c.clip);
    }
    return on.length ? this.motions.get(on[on.length - 1]!.clip) : undefined;
  }

  /**
   * A new play (`FUN_0028dc90`): the pose on screen frozen for the cross-fade over the new main motion's `BlendTime`;
   * the phase kept from a looped play into a looped one, a backwards one-shot started at its end.
   */
  private start(wanted: Wanted): Play {
    const nodes = wanted.nodes();
    const prev = this.play;
    const main = nodes[0]?.motion;
    const looped = main?.looped ?? true;
    const backwards = wanted.backwards === true;
    let phase = 0;
    if (backwards && main) phase = main.end;
    else if (prev && prev.looped && looped) phase = prev.phase;
    if (wanted.snapHalf && prev) {
      const at = Math.trunc(prev.phase * 60);
      if (at >= 17 && at <= 47) phase = 0.5;
    }
    const play: Play = { key: wanted.key, nodes, phase, looped, backwards };
    if (wanted.key === 'idle:crouch' && main) play.pick = main;
    if (!nodes.length) return play;
    if (prev) {
      this.from = this.freeze(this.main(prev).motion.name);
      this.blendElapsed = 0;
      this.blendLength = main!.blendTime;
    }
    this.feet = { left: false, right: false };
    this.emit({ kind: 'play', clip: main!.name, play: wanted.key });
    return play;
  }

  /** The play's heaviest node: its clip names the play in the stats. */
  private main(play: Play): PlayNode {
    let best = play.nodes[0]!;
    for (const n of play.nodes) if (n.weight > best.weight) best = n;
    return best;
  }

  /** The callbacks each node's motion crosses on this step, then the footfalls of a moving locomotion play. */
  private fire(play: Play, before: number, after: number, backwards: boolean, stepping: boolean): void {
    for (const n of play.nodes) {
      for (const c of n.motion.callbacks) {
        if (crosses(c.phase, before, after, play.looped, backwards)) this.emit({ kind: 'callback', clip: n.motion.name, name: c.name, phase: c.phase });
      }
    }
    if (!stepping) return;
    const frac = after - Math.floor(after), clip = this.main(play).motion.name;
    if (frac > 0 && frac < 0.5) {
      if (!this.feet.left) { this.feet.left = true; this.emit({ kind: 'footfall', foot: 'left', clip }); }
    } else this.feet.left = false;
    if (frac > 0.5 && frac < 1) {
      if (!this.feet.right) { this.feet.right = true; this.emit({ kind: 'footfall', foot: 'right', clip }); }
    } else this.feet.right = false;
  }

  private emit(e: AnimEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** The node's clip (the pistol's version is laid over it per node: `pistolOf`). */
  private clipOf(motion: Motion): MotionClip {
    return motion.clip;
  }

  /**
   * The pistol's version of a node's motion (`PISTOL_ANIMS`), when the SEAL holds the pistol and the pack has it: the
   * sub-node `FUN_0057a330` (438760-438850) hangs under the node through `FUN_0058c9e0` at weight 1, which
   * `FUN_00576bb0` lays over the node's parts it carries (`FUN_00577ea0`), before the nodes are merged.
   */
  private pistolOf(motion: Motion): MotionClip | null {
    if (this.weapon !== 'pistol') return null;
    const name = PISTOL_ANIMS[motion.name];
    return (name && this.motions.get(name)?.clip) || null;
  }

  /**
   * The held item (the WEAPON workstream's sidearm switch): the rifle's clips or the pistol's versions laid over them
   * (`PISTOL_ANIMS`), from the next frame, cross-fading from the pose on screen over the playing motion's `BlendTime`
   * [reading: the swap's own clips, `seal_rifle2pistol`..., are the weapon's to play].
   */
  setWeapon(weapon: Weapon): void {
    if (weapon === this.weapon) return;
    this.weapon = weapon;
    if (this.play && this.play.nodes.length) {
      this.from = this.freeze(this.main(this.play).motion.name);
      this.blendElapsed = 0;
      this.blendLength = this.main(this.play).motion.blendTime;
    }
  }

  /**
   * Samples every node at the shared phase, merges them (`mergeRotations`; the translations a weighted sum,
   * `FUN_00577000`), lays the pistol and the pose layers over, cross-fades from the frozen pose, writes the skeleton,
   * then turns the spine toward the aim and banks the run (`aim`).
   */
  private pose(mover: MoverSnapshot): void {
    const play = this.play!;
    const n = this.bind.length;
    this.layer = null;
    const acc: { q: [number, number, number, number]; t: [number, number, number]; w: number }[] =
      Array.from({ length: n }, () => ({ q: [0, 0, 0, 0], t: [0, 0, 0], w: 0 }));
    const rotations: { q: Quat | null; w: number; lateral: boolean }[][] = Array.from({ length: n }, () => []);
    const add = (parts: readonly PartPose[], weight: number, lateral = false): void => {
      const seen = new Array<boolean>(n).fill(false);
      for (const p of parts) {
        const i = partIndex(this.skeleton, parts, p.name);
        if (i < 0) continue;
        const a = acc[i]!;
        seen[i] = true;
        rotations[i]!.push({ q: [...p.rotation], w: weight, lateral });
        a.t = [a.t[0] + p.translation[0] * weight, a.t[1] + p.translation[1] * weight, a.t[2] + p.translation[2] * weight];
        a.w += weight;
      }
      for (let i = 0; i < n; i++) if (!seen[i]) rotations[i]!.push({ q: null, w: weight, lateral });
    };
    for (const node of play.nodes) {
      if (!(node.weight > 0)) continue;
      const clip = this.clipOf(node.motion);
      let frame: number;
      if (play.looped) frame = (((play.phase + node.offset) % 1) + 1) % 1 * clip.frameCount;
      else frame = Math.min(play.phase, node.motion.end) * clip.frameCount;
      const parts = sampleClip(clip, frame / clip.rate, { loop: play.looped }).parts;
      const pistol = this.pistolOf(node.motion);
      if (pistol) {
        const over = sampleClip(pistol, ((frame / clip.frameCount) * pistol.frameCount) / pistol.rate, { loop: play.looped }).parts;
        const byName = new Map(over.map((p) => [p.name, p]));
        add([...parts.filter((p) => !byName.has(p.name)), ...over], node.weight, node.motion.lateral);
        if (node === this.main(play)) this.layer = pistol;
      } else add(parts, node.weight, node.motion.lateral);
    }
    for (let i = 0; i < n; i++) {
      const q = mergeRotations(rotations[i]!);
      if (q) acc[i]!.q = q;
    }
    const target: Local[] = acc.map((a, i) => {
      if (!(a.w > 0)) return { q: [...this.bind[i]!.q], t: [...this.bind[i]!.t] } as Local;
      const len = Math.hypot(...a.q) || 1;
      const t: [number, number, number] = this.clipTranslation[i] ? [a.t[0] / a.w, a.t[1] / a.w, a.t[2] / a.w] : [...this.bind[i]!.t];
      // FUN_0057a330 (439110-439130): the root's x and z are zeroed after the update -- the travel is the velocity's
      if (i === this.root) { t[0] = 0; t[2] = 0; }
      if (i === this.root && this.rootOverride !== null) t[1] = this.rootOverride;   // TRAVERSAL SEAM: the move's root
      if (i === this.root && this.rootTurn) return { q: [...this.rootTurn], t };           // TRAVERSAL SEAM: the move turns it
      return { q: [a.q[0] / len, a.q[1] / len, a.q[2] / len, a.q[3] / len], t };
    });
    const held = HELD_NODES.map((name) => this.skeleton.indexOf(name)).filter((i) => i >= 0);
    // WEAPON: the frame each held node's track is in (`SPINE_HELD_CLIPS`): the main clip's, and the overlay's where its
    // frame is not the main clip's -- that one is kept unmixed (`overlaid`), a rifle on the back is not eased into one
    // in the hand.
    const rifle = this.skeleton.indexOf(HELD_PART);
    const onSpine = (i: number, clip: string): boolean => i === rifle && SPINE_HELD_CLIPS.has(clip);
    const mainClip = this.main(play).motion.name;
    const overlaid = new Map<number, HeldLocal>();
    // The overlay play (the moving swap, `FUN_0028d860(anim+0x60, ...)`): over the parts it carries, eased in and out
    // over its `BlendTime` [reading: the second channel's blend is not read].
    this.overlayName = null;
    const ov = mover.overlay ? this.motions.get(mover.overlay.clip) : undefined;
    if (ov && mover.overlay) {
      const o = mover.overlay, run = Math.min(1, Math.max(0, o.t / o.seconds)) * ov.end;
      const phase = o.reversed ? ov.end - run : run;
      const bt = ov.blendTime > 0 ? ov.blendTime : BLEND_TIME_DEFAULT;
      const w = Math.min(blendWeight(Math.min(1, o.t / bt)), blendWeight(Math.min(1, Math.max(0, o.seconds - o.t) / bt)));
      const parts = sampleClip(ov.clip, (phase * ov.clip.frameCount) / ov.clip.rate).parts;
      this.overlayName = ov.name;
      for (const p of parts) {
        const i = partIndex(this.skeleton, parts, p.name);
        if (i < 0 || i === this.root || !(w > 0)) continue;
        const from = target[i]!;
        const t: [number, number, number] = this.clipTranslation[i] ? [...p.translation] : [...this.bind[i]!.t];
        if (held.includes(i) && onSpine(i, ov.name) !== onSpine(i, mainClip)) {
          overlaid.set(i, { local: { q: [...p.rotation], t: [...t] }, spine: onSpine(i, ov.name) });
        }
        target[i] = { q: slerp(from.q, p.rotation, w), t: [from.t[0] + (t[0] - from.t[0]) * w, from.t[1] + (t[1] - from.t[1]) * w, from.t[2] + (t[2] - from.t[2]) * w] };
      }
    }
    // The pose layers (`addPoseLayer`: the weapon's fire set and reload, `./weaponPose`), each over what is below it.
    if (this.poseLayers.length) {
      const main = this.main(play);
      const phaseOf = (n: PlayNode): number => play.looped ? (((play.phase + n.offset) % 1) + 1) % 1 : Math.min(play.phase, n.motion.end);
      const phase = phaseOf(main);
      const nodes = play.nodes.filter((n) => n.weight > 0)
        .map((n) => ({ clip: n.motion.clip, frame: phaseOf(n) * n.motion.frames, phase: phaseOf(n), weight: n.weight }));
      const context: LayerContext = { clip: main.motion.clip, frame: phase * main.motion.frames, phase, nodes };
      for (const layer of this.poseLayers) {
        const over = layer.sample(context);
        if (!over || !(over.weight > 0)) continue;
        const w = Math.min(1, over.weight);
        for (const p of over.parts) {
          const i = partIndex(this.skeleton, over.parts, p.name);
          if (i < 0) continue;
          const from = target[i]!;
          const t: [number, number, number] = i === this.root ? [0, p.translation[1], 0]
            : this.clipTranslation[i] ? [...p.translation] : [...this.bind[i]!.t];
          target[i] = w >= 1 ? { q: [...p.rotation], t } : {
            q: slerp(from.q, p.rotation, w),
            t: [from.t[0] + (t[0] - from.t[0]) * w, from.t[1] + (t[1] - from.t[1]) * w, from.t[2] + (t[2] - from.t[2]) * w],
          };
        }
      }
    }
    const w = this.from ? blendWeight(this.blendLength > 0 ? this.blendElapsed / this.blendLength : 1) : 1;
    if (w >= 1) this.from = null;
    // WEAPON: the held nodes cross-fade with the arms -- the hold in the hand changes from clip to clip (the run left
    // turns the rifle 35 degrees from the stand's; the owner's playtest, 2026-09-29: a hot rifle snapped out of the
    // hands at a strafe's start and stop) -- except across frames (the hand's and `spinelo`'s at a swap's ends: the
    // owner's earlier playtest, the rifle snapped in front of the SEAL) and on the overlay's own channel.
    this.heldShown.clear();
    for (const i of held) {
      const over = overlaid.get(i);
      if (over) { this.heldShown.set(i, over); continue; }
      const to: HeldLocal = { local: { q: [...target[i]!.q], t: [...target[i]!.t] }, spine: onSpine(i, mainClip) };
      const from = this.from?.held.get(i);
      this.heldShown.set(i, from && from.spine === to.spine ? { local: mixLocal(from.local, to.local, w), spine: to.spine } : to);
    }
    target.forEach((to, i) => {
      const from = this.from?.pose[i];
      const shown = this.shown[i]!;
      if (!from) { shown.q = to.q; shown.t = to.t; }
      else {
        const mixed = mixLocal(from, to, w);
        shown.q = mixed.q;
        shown.t = mixed.t;
      }
      this.skeleton.setLocal(i, partMatrix(shown.q, shown.t));
    });
    this.skeleton.update();
    this.aim(play, mover);
  }

  /**
   * The spine after the clips (`FUN_0057a330` decomp 439152-439204): the upper body turned toward the aim
   * (`FUN_005aca70`; not prone, not on a clip flagged `NoPitchtwist` -- `FUN_00587a30` reads the play's last node) and
   * the run's bank on `spinelo` -- `BANK_FACTOR x` the turn `x` the local z speed about its parent's z, 3.1 degrees
   * into a full turn at the run (web research 83), on the floor only. Written over the frame's pose, not kept in the
   * pose the next cross-fade leaves (the game's snapshot would carry them; a tenth of a degree's difference).
   */
  private aim(play: Play, mover: MoverSnapshot): void {
    this.lastBank = 0;
    this.lastTwist = 0;
    this.lookOn = false;
    const stance: Stance = mover.stance ?? (mover.crouched ? 'crouch' : 'stand');
    const weight = mover.aimWeight ?? AIM_WEIGHT_PLACEHOLDER;
    // The head look (FUN_0057a330 439152-439191, `./headLook`): with the rifle down or the rotator still turning, not
    // prone (the prone head turn is action 0x1a's clip) and not on a ladder or a hang (FUN_00587b40), the rotator runs
    // (FUN_005ad920) and the head, the neck and the spine take its turn after the clips (FUN_005ad5b0). Not in the
    // death landing either: FUN_005af590 pushes `Land forward` in state 8, which FUN_00587b40 refuses.
    const lookLocal = new Map<number, Quat>();
    if (stance !== 'prone' && !mover.traversal && mover.action?.name !== 'landDeath' && (weight === 0 || !this.look.done)) {
      this.look.advance(this.lookDt);
      for (const name of HEAD_LOOK_NODES) {
        const i = this.skeleton.indexOf(name);
        if (i >= 0) lookLocal.set(i, qmul(this.shown[i]!.q, this.look.quat(name)));
      }
      if (lookLocal.size) {
        this.lookOn = true;
        for (const [i, q] of lookLocal) this.skeleton.setLocal(i, partMatrix(q, this.shown[i]!.t));
        this.skeleton.update();
      }
    }
    const lo = this.skeleton.indexOf('spinelo'), hi = this.skeleton.indexOf('spinehi');
    if (lo < 0 || hi < 0) return;
    const last = play.nodes[play.nodes.length - 1]?.motion;
    const local = { lo: lookLocal.get(lo) ?? [...this.shown[lo]!.q] as Quat, hi: lookLocal.get(hi) ?? [...this.shown[hi]!.q] as Quat };
    // FUN_0057a330 439192: the twist only with the rifle's weight over 0, scaled by it (FUN_005aca70).
    if (stance !== 'prone' && last && !last.noPitchtwist && mover.pitch !== undefined && weight > 0) {
      const p = (mover.pitch * Math.PI) / 180;
      const aimDir: Vec = [0, Math.sin(p), -Math.cos(p)];
      const palette = this.skeleton.palette();
      const turn = (i: number, share: number): Quat => {
        const q = quatOfMatrix(palette[i]!);
        const inv: Quat = [-q[0], -q[1], -q[2], q[3]];
        const a = qrot(inv, MODEL_FORWARD), b = qrot(inv, aimDir);
        const k = weight * share;
        const v: Vec = [(a[1] * b[2] - a[2] * b[1]) * k, (a[2] * b[0] - a[0] * b[2]) * k, (a[0] * b[1] - a[1] * b[0]) * k];
        const m = Math.hypot(...v);
        this.lastTwist += 2 * m;
        return m > 0 ? [(v[0] * Math.sin(m)) / m, (v[1] * Math.sin(m)) / m, (v[2] * Math.sin(m)) / m, Math.cos(m)] : [0, 0, 0, 1];
      };
      const tLo = turn(lo, TWIST_SHARE.spinelo), tHi = turn(hi, TWIST_SHARE.spinehi);
      local.lo = qmul(tLo, local.lo);
      local.hi = qmul(tHi, local.hi);
    }
    const yaw = (mover.yaw * Math.PI) / 180;
    const vzLocal = -(mover.vx * -Math.sin(yaw) + mover.vz * -Math.cos(yaw));
    const turnRate = mover.turnRate ?? 0;
    if (!mover.airborne && turnRate !== 0 && vzLocal !== 0) {
      const angle = turnRate * vzLocal * BANK_FACTOR;
      this.lastBank = angle;
      local.lo = qmul([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)], local.lo);
    }
    if (this.lastTwist === 0 && this.lastBank === 0) return;
    this.skeleton.setLocal(lo, partMatrix(local.lo, this.shown[lo]!.t));
    this.skeleton.setLocal(hi, partMatrix(local.hi, this.shown[hi]!.t));
    this.skeleton.update();
  }

  /**
   * WEAPON: a held item's node (`rifle`, `pistol`) local this frame, or null before a pose or without the node.
   * `./play` hangs the weapon from this, so the weapon is where the drawn hand holds it:
   * - Cross-faded with the arms, over the same weight, while the pose left and the pose coming hold it in the same
   *   frame: each clip holds the weapon its own way in the hand (the run left's rifle turned 35 degrees from the
   *   stand's, the pistol's 90-degree run 0.7 further out) and the arms change with it (the owner's playtest,
   *   2026-09-29: with the gun hot, a strafe's start and stop snapped the rifle 5.6 units at the muzzle in one frame
   *   while the arms eased, the off hand 2 units off the fore-end).
   * - The two frames a node's track is in (the hand's, and `spinelo`'s in the swap clips, `SPINE_HELD_CLIPS`:
   *   `./heldItem`'s `swap` mount) are never mixed: across them it is the clip coming's own key -- the play's target,
   *   or the moving swap's where the overlay carries the node (the owner's earlier playtest: a mix put the rifle in
   *   front of the SEAL at the swap's start and up at its end; `./heldItem`'s `MountEase` eases that change).
   */
  heldLocal(name: string): Float32Array | null {
    const l = this.heldShown.get(this.skeleton.indexOf(name))?.local;
    return l ? partMatrix(l.q, l.t) : null;
  }

  /** The pose on screen frozen for a cross-fade (`from`), the held nodes as `heldLocal` gave them with their frames. */
  private freeze(name: string): { name: string; pose: Local[]; held: Map<number, HeldLocal> } {
    const held = new Map([...this.heldShown].map(([i, h]) => [i, { local: { q: [...h.local.q], t: [...h.local.t] } as Local, spine: h.spine }]));
    return { name, pose: this.shown.map((l) => ({ q: [...l.q], t: [...l.t] })), held };
  }

  /** The clip, the frame, the blend: the hook's `stats().anim`. */
  stats(): AnimStats {
    const play = this.play;
    const blend = this.from ? blendWeight(this.blendLength > 0 ? this.blendElapsed / this.blendLength : 1) : 1;
    if (!play || !play.nodes.length) {
      return { clip: '', frame: 0, frames: 0, blend, from: this.from?.name ?? null, rate: 0, layer: null, nodes: [], play: play?.key ?? '', bank: 0, twist: 0, look: this.lookStats(), overlay: this.overlayName };
    }
    const main = this.main(play);
    const phase = play.looped ? (((play.phase + main.offset) % 1) + 1) % 1 : Math.min(play.phase, main.motion.end);
    return {
      clip: main.motion.name, frame: phase * main.motion.frames, frames: main.motion.frames, blend, from: this.from?.name ?? null, rate: this.lastRate,
      layer: this.layer?.name ?? null, play: play.key,
      nodes: play.nodes.map((n) => ({ clip: n.motion.name, weight: n.weight, speed: n.speed })),
      bank: this.lastBank, twist: this.lastTwist, look: this.lookStats(), overlay: this.overlayName,
    };
  }

  private lookStats(): AnimStats['look'] {
    const [yaw, pitch] = lookFractions(this.look.dir);
    return { yaw, pitch, on: this.lookOn, priority: this.look.priority };
  }

  /** The root's height over the feet as posed (the clips', blended), or null for a skeleton without a root. */
  rootY(): number | null {
    return this.root < 0 ? null : this.shown[this.root]!.t[1];
  }
}
