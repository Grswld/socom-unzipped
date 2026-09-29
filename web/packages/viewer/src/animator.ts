import { partMatrix, sampleClip, type MotionClip, type PartPose, type Skeleton } from '@s2u/scene';
import {
  BLEND_TIME_DEFAULT, CROUCH_IDLES, MOTION_CLIPS, SEAL_ANIMS, SEAL_SETS, crouchPlay, entryOf, motionOf, nodeSpeed,
  phaseRate, pronePlay, standPlay, type DirectionClass, type Motion, type MotionSets, type PlayNode, type SetName,
} from './locomotion';
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
export interface TraversalPose { clip: string; frame: number; loop: boolean; rootY: number | null }

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
}

/** The play's main clip, as a pose layer sees it: the clip, its fractional key and its phase (0 to 1). */
export interface LayerContext { clip: MotionClip; frame: number; phase: number }

/**
 * A pose over the clips (the WEAPON workstream's fire set and reload, `./weaponPose`): the parts to blend toward and
 * by how much (0 none, 1 all), or null for nothing this frame. A part the layer does not carry keeps the pose below.
 */
export interface PoseLayer {
  sample(current: LayerContext): { parts: readonly PartPose[]; weight: number } | null;
}

/** The held item's node (`FUN_00553290` 0x553290 names it `rifle`) and SOCOM 1's name for it in the older clips. */
export const HELD_PART = 'rifle', HELD_ALIAS = 'weapon';

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

/** Slerp on the shorter arc, normalised: `MOTION_BLEND` (77 §7; `@s2u/scene`'s `slerp` is the sampler's own). */
function slerp(a: readonly number[], b: readonly number[], t: number): [number, number, number, number] {
  let [bx, by, bz, bw] = b as [number, number, number, number];
  const [ax, ay, az, aw] = a as [number, number, number, number];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  let wa = 1 - t, wb = t;
  if (dot < 0.9995) {
    const theta = Math.acos(Math.min(1, dot)), s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  const x = wa * ax + wb * bx, y = wa * ay + wb * by, z = wa * az + wb * bz, w = wa * aw + wb * bw;
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
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
  private readonly weapon: Weapon;
  private readonly random: () => number;
  /** The pose on screen, per skeleton part. */
  private readonly shown: Local[];
  /** The pose the cross-fade leaves, frozen when the play changed (`FUN_0028e3e0`'s snapshot, research 17 §4.2). */
  private from: { name: string; pose: Local[] } | null = null;
  private blendElapsed = 0;
  private blendLength = BLEND_TIME_DEFAULT;
  private play: Play | null = null;
  private layer: MotionClip | null = null;
  private lastRate = 0;
  /** `actor+0x211` / `+0x210`: the left and the right foot already struck this half cycle. */
  private feet = { left: false, right: false };
  private readonly listeners = new Set<(e: AnimEvent) => void>();
  private readonly poseLayers: PoseLayer[] = [];
  /** TRAVERSAL SEAM: the root's height over the feet a traversal move sets, or null for the clip's own. */
  private rootOverride: number | null = null;
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
    this.weapon = options.weapon ?? 'rifle';
    this.random = options.random ?? Math.random;
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
    if (mover.traversal) { this.traversalStep(dt, mover.traversal); return; }
    this.rootOverride = null;
    const wanted = this.wanted(mover);
    if (!wanted) return;
    let play = this.play;
    if (!play || play.key !== wanted.key) play = this.start(wanted);
    else if (play.key.startsWith('loco:')) play.nodes = wanted.nodes();
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
    this.pose();
    this.fire(play, before, after, rate < 0, wanted.locomotion === true && !mover.airborne && Math.hypot(mover.vx, mover.vz, mover.vy) > 0.5);
  }

  /**
   * TRAVERSAL SEAM (`./traversal`, web research 86): the move's clip as a one-node play at the move's own key -- no
   * advance of its own -- its callbacks fired as its phase passes them, the root's height the move's.
   */
  private traversalStep(dt: number, over: TraversalPose): void {
    const m = this.motions.get(over.clip);
    if (!m) return;
    const key = `trav:${over.clip}`;
    let play = this.play;
    if (!play || play.key !== key) {
      play = this.start({ key, nodes: () => [{ motion: m, weight: 1, speed: 0, offset: 0 }] });
      play.looped = over.loop;
      this.play = play;
      this.traversalStarted = false;                             // a new move's first key fires nothing behind it
    } else this.blendElapsed += dt;
    const frames = m.clip.frameCount;
    let after = over.frame / frames;
    after = over.loop ? ((after % 1) + 1) % 1 : Math.max(0, Math.min(m.end, after));
    const before = play === this.play && play.key === key && play.phase !== undefined && this.traversalStarted ? play.phase : after;
    this.traversalStarted = true;
    play.phase = after;
    this.lastRate = dt > 0 ? ((after - before) * frames) / dt : 0;
    this.rootOverride = over.rootY;
    this.pose();
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
    if (g && g.state === 'stand') return { key: 'loco:stand', locomotion: true, nodes: () => standPlay(g.forward, g.right, this.sets) };
    if (g && g.state !== 'idle' && g.cls !== -1) {
      const cls = g.cls as DirectionClass;
      if (g.state === 'crouch') return { key: `loco:crouch:${cls}`, locomotion: true, nodes: () => crouchPlay(g.forward, g.right, cls, this.sets) };
      const motions = { crawl: this.motions.get(SEAL_ANIMS.proneCrawl), right: this.motions.get(SEAL_ANIMS.proneRight), left: this.motions.get(SEAL_ANIMS.proneLeft) };
      return { key: `loco:prone:${cls}`, locomotion: true, nodes: () => pronePlay(g.forward, g.right, cls, motions) };
    }
    if (stance === 'crouch') {
      return {
        key: 'idle:crouch', nodes: () => {
          const pick = this.play?.key === 'idle:crouch' && this.play.pick ? this.play.pick : this.crouchIdle();
          return pick ? [{ motion: pick, weight: 1, speed: nodeSpeed(pick, 1), offset: 0 }] : [];
        },
      };
    }
    if (stance === 'prone' && (mover.turnRate ?? 0) !== 0 && this.motions.has(SEAL_ANIMS.proneTurn)) return one('turn:prone', SEAL_ANIMS.proneTurn);
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
    const play: Play = { key: wanted.key, nodes, phase, looped, backwards };
    if (wanted.key === 'idle:crouch' && main) play.pick = main;
    if (!nodes.length) return play;
    if (prev) {
      this.from = { name: this.main(prev).motion.name, pose: this.shown.map((l) => ({ q: [...l.q], t: [...l.t] })) };
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

  /** The node's clip, the pistol's whole-body version standing in for it where there is one. */
  private clipOf(motion: Motion): MotionClip {
    if (this.weapon !== 'pistol') return motion.clip;
    const pistol = this.motions.get(layerName(motion.name));
    return pistol && pistol.clip.parts.some((p) => p.name === ROOT) ? pistol.clip : motion.clip;
  }

  /** Samples every node at the shared phase, blends them by weight, cross-fades from the frozen pose, writes the skeleton. */
  private pose(): void {
    const play = this.play!;
    const n = this.bind.length;
    const acc: { q: [number, number, number, number]; t: [number, number, number]; w: number }[] =
      Array.from({ length: n }, () => ({ q: [0, 0, 0, 0], t: [0, 0, 0], w: 0 }));
    const add = (parts: readonly PartPose[], weight: number): void => {
      for (const p of parts) {
        const i = partIndex(this.skeleton, parts, p.name);
        if (i < 0) continue;
        const a = acc[i]!;
        let [x, y, z, w] = p.rotation;
        if (a.w > 0 && a.q[0] * x + a.q[1] * y + a.q[2] * z + a.q[3] * w < 0) { x = -x; y = -y; z = -z; w = -w; }
        a.q = [a.q[0] + x * weight, a.q[1] + y * weight, a.q[2] + z * weight, a.q[3] + w * weight];
        a.t = [a.t[0] + p.translation[0] * weight, a.t[1] + p.translation[1] * weight, a.t[2] + p.translation[2] * weight];
        a.w += weight;
      }
    };
    for (const node of play.nodes) {
      if (!(node.weight > 0)) continue;
      const clip = this.clipOf(node.motion);
      let frame: number;
      if (play.looped) frame = (((play.phase + node.offset) % 1) + 1) % 1 * clip.frameCount;
      else frame = Math.min(play.phase, node.motion.end) * clip.frameCount;
      add(sampleClip(clip, frame / clip.rate, { loop: play.looped }).parts, node.weight);
    }
    this.layer = null;
    if (this.weapon === 'pistol') {
      const main = this.main(play).motion;
      const pistol = this.motions.get(layerName(main.name));
      if (pistol && !pistol.clip.parts.some((p) => p.name === ROOT)) {
        this.layer = pistol.clip;
        const phase = play.looped ? play.phase : Math.min(play.phase, main.end);
        const parts = sampleClip(pistol.clip, (phase * pistol.clip.frameCount) / pistol.clip.rate, { loop: true }).parts;
        for (const p of parts) {
          const i = partIndex(this.skeleton, parts, p.name);
          if (i >= 0) acc[i] = { q: [...p.rotation], t: [...p.translation], w: 1 };
        }
      }
    }
    const target: Local[] = acc.map((a, i) => {
      if (!(a.w > 0)) return { q: [...this.bind[i]!.q], t: [...this.bind[i]!.t] } as Local;
      const len = Math.hypot(...a.q) || 1;
      const t: [number, number, number] = [a.t[0] / a.w, a.t[1] / a.w, a.t[2] / a.w];
      if (i === this.root) { t[0] = this.bind[i]!.t[0]; t[2] = this.bind[i]!.t[2]; }
      if (i === this.root && this.rootOverride !== null) t[1] = this.rootOverride;   // TRAVERSAL SEAM: the move's root
      return { q: [a.q[0] / len, a.q[1] / len, a.q[2] / len, a.q[3] / len], t };
    });
    // The pose layers (`addPoseLayer`: the weapon's fire set and reload, `./weaponPose`), each over what is below it.
    if (this.poseLayers.length) {
      const main = this.main(play);
      const phase = play.looped ? (((play.phase + main.offset) % 1) + 1) % 1 : Math.min(play.phase, main.motion.end);
      const context: LayerContext = { clip: main.motion.clip, frame: phase * main.motion.frames, phase };
      for (const layer of this.poseLayers) {
        const over = layer.sample(context);
        if (!over || !(over.weight > 0)) continue;
        const w = Math.min(1, over.weight);
        for (const p of over.parts) {
          const i = partIndex(this.skeleton, over.parts, p.name);
          if (i < 0) continue;
          const from = target[i]!;
          const t: [number, number, number] = i === this.root ? [this.bind[i]!.t[0], p.translation[1], this.bind[i]!.t[2]] : [...p.translation];
          target[i] = w >= 1 ? { q: [...p.rotation], t } : {
            q: slerp(from.q, p.rotation, w),
            t: [from.t[0] + (t[0] - from.t[0]) * w, from.t[1] + (t[1] - from.t[1]) * w, from.t[2] + (t[2] - from.t[2]) * w],
          };
        }
      }
    }
    const w = this.from ? blendWeight(this.blendLength > 0 ? this.blendElapsed / this.blendLength : 1) : 1;
    if (w >= 1) this.from = null;
    target.forEach((to, i) => {
      const from = this.from?.pose[i];
      const shown = this.shown[i]!;
      if (!from) { shown.q = to.q; shown.t = to.t; }
      else {
        shown.q = slerp(from.q, to.q, w);
        shown.t = [from.t[0] + (to.t[0] - from.t[0]) * w, from.t[1] + (to.t[1] - from.t[1]) * w, from.t[2] + (to.t[2] - from.t[2]) * w];
      }
      this.skeleton.setLocal(i, partMatrix(shown.q, shown.t));
    });
    this.skeleton.update();
  }

  /** The clip, the frame, the blend: the hook's `stats().anim`. */
  stats(): AnimStats {
    const play = this.play;
    const blend = this.from ? blendWeight(this.blendLength > 0 ? this.blendElapsed / this.blendLength : 1) : 1;
    if (!play || !play.nodes.length) {
      return { clip: '', frame: 0, frames: 0, blend, from: this.from?.name ?? null, rate: 0, layer: null, nodes: [], play: play?.key ?? '' };
    }
    const main = this.main(play);
    const phase = play.looped ? (((play.phase + main.offset) % 1) + 1) % 1 : Math.min(play.phase, main.motion.end);
    return {
      clip: main.motion.name, frame: phase * main.motion.frames, frames: main.motion.frames, blend, from: this.from?.name ?? null, rate: this.lastRate,
      layer: this.layer?.name ?? null, play: play.key,
      nodes: play.nodes.map((n) => ({ clip: n.motion.name, weight: n.weight, speed: n.speed })),
    };
  }

  /** The root's height over the feet as posed (the clips', blended), or null for a skeleton without a root. */
  rootY(): number | null {
    return this.root < 0 ? null : this.shown[this.root]!.t[1];
  }
}
