import { partMatrix, sampleClip, type MotionClip, type PartPose, type Skeleton } from '@s2u/scene';
import type { MotionEntry, MotionTable } from './motionTable';
import { WORLD_SCALE, type LandingKind } from './physics';

/**
 * The SEAL's clips on the mover (web sprint 2, W2.2b): each frame the mover's state picks a clip of the player's pack
 * (web/docs/research/77 §12) by name, the clip advances at its own 30 keys a second as `motion.rdr` says (§7), a new
 * clip cross-fades in over its `BlendTime`, and the pose goes into the skeleton part by part (`Skeleton.setLocal`),
 * which the page's bones and the skinned mesh follow.
 *
 * **What is the game's and what is the viewer's.** The clips, their parts, rates and keys are the disc's (77). The
 * table's fields are the disc's, read at run time (`./motionTable`, W2.R6). How the game *chooses* a clip is in
 * `CZSealBody_Tick_0` (0x57a330), whose model velocity comes from the throttles and per-stance limits (decomp
 * `CZSealBody_Tick_0_0x57a330` lines 4999-5255, through `func_58BB50` / `func_58BC00`, bodies not supplied) or from
 * the clip's own root displacement over the tick (lines 7792-7898: the root's travel at `$s1+0x14c0` differenced and
 * divided by the tick into the velocity at `+0x2c..+0x34`); neither rule is ported. So the picker below is **the
 * viewer's reading**, every threshold named: the speed bands (the table's transition speeds when read, else
 * `BAND_PLACEHOLDERS`), the direction split, the running jump, the interrupt rule.
 *
 * **The root.** The mover owns the position: the clip's root travel is not applied to it -- the decomp's root motion
 * (lines 7792-7898) is the carry -- and the body's root is stood over the feet at the bind's x and z. The root's
 * height is the clip's, so a crouch lowers the body and a jump's clip lifts it where the clip lifts it.
 */

/** The cycles a mover plays, by what they are for (research 77 §12's list). */
export const SEAL_CLIPS = {
  stand: 'seal_stand', walk: 'seal_walk', jog: 'seal_jog', run: 'seal_run', walkBack: 'seal_walk_bw', runBack: 'seal_run_bw',
  strafeLeft: 'seal_lstrafe', strafeRight: 'seal_rstrafe', crouch: 'seal_crouch', crouchWalk: 'seal_crouchwalk',
  crouchWalkBack: 'seal_crouchwalk_bw', jump: 'seal_jump', launch: 'seal_runningjump_launch',
  inAir: 'seal_runningjump_in_air', landSoft: 'seal_land_soft', landHard: 'seal_land_hard',
} as const;

/** What the SEAL holds. W2.R4's default is the M4A1 SD, a rifle, which the full-body clips hold. */
export type Weapon = 'rifle' | 'pistol';

/**
 * The pistol's version of a cycle: `seal_p_<name>` (research 77 §12: `seal_p_*` 79, the pistol). Most carry the
 * spine, the arms, the head and the pistol and no root or legs -- an upper-body layer; a few are whole bodies.
 */
export function layerName(clip: string): string {
  return clip.replace(/^seal_/, 'seal_p_');
}

/** Every clip the page asks the worker for: the sixteen, then each one's pistol version (the pack lacks some). */
export const PLAY_CLIPS: readonly string[] = [...Object.values(SEAL_CLIPS), ...Object.values(SEAL_CLIPS).map(layerName)];

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
  /** How many jumps the mover has taken: a change is a take-off, whenever between two frames it came. */
  jumps: number;
}

/** A speed band, units a second: the cycle plays from `lo` to `hi`. */
export interface Band { lo: number; hi: number }

/**
 * PLACEHOLDER (W2.R2): the speed bands, units a second, when `motion.rdr` is not read. Round numbers of the viewer's,
 * no source: the stand and the crouch under 2; walk to 20, jog 15 to 45, run from 40, overlapping so a clip is kept
 * across the overlap (`pickClip`); back, the walk to 20 and the run from 15; the strafes and the crouch walks at any
 * speed. With them the mover's 40 (research 18, Finding 3) is a jog and the boost a run.
 */
export const BAND_PLACEHOLDERS: Readonly<Record<string, Band>> = Object.freeze({
  seal_stand: { lo: 0, hi: 2 }, seal_crouch: { lo: 0, hi: 2 },
  seal_walk: { lo: 0, hi: 20 }, seal_jog: { lo: 15, hi: 45 }, seal_run: { lo: 40, hi: Infinity },
  seal_walk_bw: { lo: 0, hi: 20 }, seal_run_bw: { lo: 15, hi: Infinity },
  seal_lstrafe: { lo: 0, hi: Infinity }, seal_rstrafe: { lo: 0, hi: Infinity },
  seal_crouchwalk: { lo: 0, hi: Infinity }, seal_crouchwalk_bw: { lo: 0, hi: Infinity },
});

/**
 * The bands the picker runs on: each clip's `transition_speed_A` to `_B` where the table gives both -- metres a
 * second, times `WORLD_SCALE` as `dynamics.rdr`'s metre fields are kept (`physics.ts`) -- else its placeholder. The
 * reading: the transition speeds are the speeds a cycle covers (77 §7). With the table the stand's top is the
 * stand's own `_B`.
 */
export function bandsFrom(table: MotionTable | null): Record<string, Band> {
  const out: Record<string, Band> = { ...BAND_PLACEHOLDERS };
  if (!table) return out;
  for (const name of Object.keys(out)) {
    const e = table.get(name);
    if (e && e.transitionA !== null && e.transitionB !== null) out[name] = { lo: e.transitionA * WORLD_SCALE, hi: e.transitionB * WORLD_SCALE };
  }
  return out;
}

/** The reading: within this many degrees of the facing a move is forward, within it of the back a move back; between, a strafe. */
export const DIRECTION_SPLIT_DEG = 45;

/**
 * The clips that play once when the table is not read: the jump, the launch, the flight and the landings. Research
 * 77 §7 prints `seal_jump` and `seal_land_hard` as `looped (0)`; the other three are taken the same, the reading.
 */
const ONE_SHOTS_UNREAD = new Set<string>([
  SEAL_CLIPS.jump, SEAL_CLIPS.launch, SEAL_CLIPS.inAir, SEAL_CLIPS.landSoft, SEAL_CLIPS.landHard,
]);

/** Whether a clip loops: the table's `looped`, else the reading above. */
export function loops(name: string, table: MotionTable | null): boolean {
  return table?.get(name)?.looped ?? !ONE_SHOTS_UNREAD.has(name);
}

/** The clip playing, as the picker sees it: where it is (a fractional key), how many keys, and whether a one-shot ended. */
export interface Playing { name: string; frame: number; frames: number; done: boolean }

export interface PickInput {
  mover: MoverSnapshot;
  current: Playing | null;
  /** A take-off since the last pick (`MoverSnapshot.jumps` changed). */
  jumped: boolean;
  /** On the floor now, in the air at the last pick. */
  landed: boolean;
  bands: Readonly<Record<string, Band>>;
  table: MotionTable | null;
}

/** The first band of `family` holding `speed`; the one playing while it still holds it; past the top, the fastest. */
function bandPick(family: readonly string[], speed: number, current: Playing | null, bands: Readonly<Record<string, Band>>): string {
  const holds = (name: string): boolean => {
    const b = bands[name];
    return b !== undefined && speed >= b.lo && speed <= b.hi;
  };
  if (current && family.includes(current.name) && holds(current.name)) return current.name;
  for (const name of family) if (holds(name)) return name;
  const top = family[family.length - 1]!;
  return speed > (bands[top]?.hi ?? Infinity) ? top : family[0]!;
}

/**
 * The clip for the mover's state (the viewer's reading, the rules in order):
 *
 * 1. **A take-off**: a jump from faster than the walk band's top is the running jump's launch, else the standing jump.
 * 2. **In the air**: the jump or the launch plays to its end, then (and after a fall) the in-air clip.
 * 3. **A landing**: soft under `land_fall_rate`, hard from it (the mover's class, `physics.ts`) -- after the standing
 *    jump too: the mover's placeholder impulse (`physics.ts` `jumpImpulse`) lands before the jump clip's own landing,
 *    whose tail would hold the soles units over the floor.
 * 4. **A one-shot on the floor** (the jump, the landings) plays to its end; moving cuts it once its `NoInterrupt`
 *    fraction has played (at once without one).
 * 5. **Crouched**: the crouch under its band, else the crouch walk, back when moving back.
 * 6. **Standing**: the stand under its band; else by direction (`DIRECTION_SPLIT_DEG`) the forward cycles by speed
 *    (walk, jog, run), the back ones (walk, run) or the strafe to that side.
 */
export function pickClip(input: PickInput): string {
  const { mover, current, bands, table } = input;
  const speed = Math.hypot(mover.vx, mover.vz);
  const yaw = (mover.yaw * Math.PI) / 180;
  const forward = mover.vx * -Math.sin(yaw) + mover.vz * -Math.cos(yaw);
  const right = mover.vx * Math.cos(yaw) + mover.vz * -Math.sin(yaw);
  const playingOneShot = current !== null && !current.done && ONE_SHOT_PICKS.has(current.name);

  if (input.jumped) return speed > (bands[SEAL_CLIPS.walk]?.hi ?? Infinity) ? SEAL_CLIPS.launch : SEAL_CLIPS.jump;
  if (mover.airborne) {
    if (playingOneShot && (current!.name === SEAL_CLIPS.jump || current!.name === SEAL_CLIPS.launch)) return current!.name;
    return SEAL_CLIPS.inAir;
  }
  if (input.landed) return mover.landing === 'soft' ? SEAL_CLIPS.landSoft : SEAL_CLIPS.landHard;
  const standTop = bands[mover.crouched ? SEAL_CLIPS.crouch : SEAL_CLIPS.stand]?.hi ?? 0;
  const still = speed <= standTop;
  if (playingOneShot && current!.name !== SEAL_CLIPS.launch && current!.name !== SEAL_CLIPS.inAir) {
    const cut = table?.get(current!.name)?.noInterrupt ?? 0;
    if (still || current!.frame < cut * current!.frames) return current!.name;
  }
  if (mover.crouched) {
    if (still) return SEAL_CLIPS.crouch;
    return forward < 0 && -forward >= Math.abs(right) ? SEAL_CLIPS.crouchWalkBack : SEAL_CLIPS.crouchWalk;
  }
  if (still) return SEAL_CLIPS.stand;
  const split = Math.tan((DIRECTION_SPLIT_DEG * Math.PI) / 180) * Math.abs(right);
  if (forward >= split) return bandPick([SEAL_CLIPS.walk, SEAL_CLIPS.jog, SEAL_CLIPS.run], speed, current, bands);
  if (-forward >= split) return bandPick([SEAL_CLIPS.walkBack, SEAL_CLIPS.runBack], speed, current, bands);
  return right > 0 ? SEAL_CLIPS.strafeRight : SEAL_CLIPS.strafeLeft;
}

/** The picks that play once whatever the table says of looping (the rules of `pickClip` hold them to their end). */
const ONE_SHOT_PICKS = ONE_SHOTS_UNREAD;

/**
 * A clip's root travel, units a second in the model's frame (x to its right, z behind; its forward is -z): the root
 * translation's change from key 0 to the last key before the closing one (77 §5: key n is key 0), over that time.
 * 0 for a clip whose root is constant or absent. seal_run's is 57.7 forward (77 §6).
 */
export function rootVelocity(clip: MotionClip): [number, number] {
  const root = clip.parts.find((p) => p.name === ROOT);
  if (!root || root.translations.length <= 3 || clip.frameCount < 2) return [0, 0];
  const t = root.translations, last = 3 * (clip.frameCount - 1), seconds = (clip.frameCount - 1) / clip.rate;
  return [(t[last]! - t[0]!) / seconds + 0, (t[last + 2]! - t[2]!) / seconds + 0];
}

/**
 * PLACEHOLDER (W2.R2): the bounds on a cycle's speed factor (`clipRate`): a quarter and three times its own rate, so a
 * nearly stopped mover still steps and the strafes (whose roots travel slowly) are not flailed. No source.
 */
export const RATE_MIN_PLACEHOLDER = 0.25;
export const RATE_MAX_PLACEHOLDER = 3;

/**
 * Keys a second a clip advances at (77 §7's reading of `playback`):
 * - no entry: the clip's own rate, 30 keys a second;
 * - a clip that is no locomotion (`max_velocity` < 0, or none): its `frameCount` keys over `playback` seconds
 *   (`seal_crouch_step`'s 0.4 is the duration research 25 read in memory);
 * - a locomotion cycle (`max_velocity` > 0; `playback` 1 on all of them): its own rate times `playback` times the
 *   mover's speed over the clip's root travel -- **the viewer's reading**, so the root would travel the mover's
 *   distance (the game takes the model's velocity from that same root displacement, decomp lines 7792-7898) --
 *   between `RATE_MIN_PLACEHOLDER` and `RATE_MAX_PLACEHOLDER`.
 */
export function clipRate(clip: MotionClip, entry: MotionEntry | undefined, speed: number): number {
  if (!entry) return clip.rate;
  const playback = entry.playback !== null && entry.playback > 0 ? entry.playback : null;
  if (entry.maxVelocity === null || entry.maxVelocity <= 0) return playback ? clip.frameCount / playback : clip.rate;
  const [rx, rz] = rootVelocity(clip);
  const travel = Math.hypot(rx, rz);
  const factor = travel > 0 ? Math.min(RATE_MAX_PLACEHOLDER, Math.max(RATE_MIN_PLACEHOLDER, speed / travel)) : 1;
  return clip.rate * (playback ?? 1) * factor;
}

/**
 * PLACEHOLDER (W2.R2): the cross-fade's length, seconds, into a clip whose `motion.rdr` entry has no `BlendTime` (the
 * cycles have none) or when the table is not read. No source.
 */
export const BLEND_TIME_PLACEHOLDER = 0.2;

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

/** What `stats().anim` reports: the clip, the fractional key, the cross-fade's weight (1 settled) and from what. */
export interface AnimStats {
  clip: string;
  frame: number;
  /** The clip's key count: `frame / frames` is the cycle's phase (the audio's footfalls, web/docs/research/81 §4). */
  frames: number;
  blend: number;
  from: string | null;
  /** Keys a second the clip advances at this frame. */
  rate: number;
  /** The upper-body layer over it, or null. */
  layer: string | null;
}

export interface AnimatorOptions { weapon?: Weapon }

/**
 * The player of the clips: `step` once a frame with the mover's state. It picks (`pickClip`), advances, samples the
 * clip (and its layer), cross-fades from the pose on screen when the clip changes, and writes the skeleton. A pick the
 * pack lacks falls back to the stand, and without the stand the skeleton keeps its bind pose.
 */
export class Animator {
  private readonly clips: Map<string, MotionClip>;
  private readonly bands: Record<string, Band>;
  private readonly bind: Local[];
  private readonly root: number;
  private readonly weapon: Weapon;
  /** The pose on screen, per skeleton part. */
  private readonly shown: Local[];
  /** The pose the cross-fade leaves, frozen when the clip changed (`FUN_0028e370`'s snapshot, research 17 §4.2). */
  private from: { name: string; pose: Local[] } | null = null;
  private blendElapsed = 0;
  private blendLength = BLEND_TIME_PLACEHOLDER;
  private current: { clip: MotionClip; frame: number; rate: number; loop: boolean } | null = null;
  private layer: MotionClip | null = null;
  private lastJumps: number | null = null;
  private wasAirborne = false;

  constructor(private readonly skeleton: Skeleton, clips: Iterable<MotionClip>, private readonly table: MotionTable | null, options: AnimatorOptions = {}) {
    this.clips = new Map([...clips].map((c) => [c.name, c]));
    this.bands = bandsFrom(table);
    this.bind = bindLocals(skeleton);
    this.shown = this.bind.map((l) => ({ q: [...l.q], t: [...l.t] }));
    this.root = skeleton.indexOf(ROOT);
    this.weapon = options.weapon ?? 'rifle';
  }

  /** One frame of `dt` seconds with the mover as it now stands. */
  step(dt: number, mover: MoverSnapshot): void {
    const jumped = this.lastJumps !== null && mover.jumps !== this.lastJumps;
    const landed = this.wasAirborne && !mover.airborne;
    this.lastJumps = mover.jumps;
    this.wasAirborne = mover.airborne;

    const cur = this.current;
    const playing: Playing | null = cur && {
      name: cur.clip.name, frame: cur.frame, frames: cur.clip.frameCount, done: !cur.loop && cur.frame >= cur.clip.frameCount,
    };
    const wanted = this.resolve(pickClip({ mover, current: playing, jumped, landed, bands: this.bands, table: this.table }));
    if (!wanted) return;
    const speed = Math.hypot(mover.vx, mover.vz);
    const entry = this.table?.get(wanted.name) ?? undefined;
    const rate = clipRate(wanted, entry, speed);
    if (!cur || cur.clip !== wanted) this.change(wanted, rate, cur);
    else {
      cur.rate = rate;
      cur.frame += rate * dt;
      if (cur.loop) cur.frame %= cur.clip.frameCount;
      else cur.frame = Math.min(cur.frame, cur.clip.frameCount);
      this.blendElapsed += dt;
    }
    this.pose();
  }

  /** The pick as a clip on hand, the pistol's whole-body version standing in for it where there is one; else the stand. */
  private resolve(name: string): MotionClip | null {
    const own = this.clips.get(name) ?? this.clips.get(SEAL_CLIPS.stand) ?? null;
    this.layer = null;
    if (!own || this.weapon !== 'pistol') return own;
    const pistol = this.clips.get(layerName(own.name));
    if (!pistol) return own;
    if (pistol.parts.some((p) => p.name === ROOT)) return pistol;
    this.layer = pistol;
    return own;
  }

  /** Starts `clip`: the pose on screen is the cross-fade's start, and a cycle following a cycle keeps its phase. */
  private change(clip: MotionClip, rate: number, previous: { clip: MotionClip; frame: number } | null): void {
    const loop = loops(clip.name, this.table);
    let frame = 0;
    if (previous && loop && loops(previous.clip.name, this.table) && isCycle(previous.clip.name) && isCycle(clip.name)) {
      frame = (previous.frame / previous.clip.frameCount) * clip.frameCount;     // the viewer's: the legs keep their step
    }
    if (previous) {
      this.from = { name: previous.clip.name, pose: this.shown.map((l) => ({ q: [...l.q], t: [...l.t] })) };
      this.blendElapsed = 0;
      this.blendLength = this.table?.get(clip.name)?.blendTime ?? BLEND_TIME_PLACEHOLDER;
    }
    this.current = { clip, frame, rate, loop };
  }

  /** Samples the clip (and the layer at the same phase), blends from the frozen pose, and writes the skeleton. */
  private pose(): void {
    const cur = this.current!;
    const target = this.bind.map((l) => ({ q: [...l.q], t: [...l.t] }) as Local);
    const put = (parts: readonly PartPose[]): void => {
      for (const p of parts) {
        const i = this.skeleton.indexOf(p.name);
        if (i < 0) continue;
        target[i] = { q: [...p.rotation], t: i === this.root ? [this.bind[i]!.t[0], p.translation[1], this.bind[i]!.t[2]] : [...p.translation] };
      }
    };
    put(sampleClip(cur.clip, cur.frame / cur.clip.rate, { loop: cur.loop }).parts);
    if (this.layer) {
      const phase = cur.frame / cur.clip.frameCount;
      put(sampleClip(this.layer, (phase * this.layer.frameCount) / this.layer.rate, { loop: true }).parts);
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
    const cur = this.current;
    const blend = this.from ? blendWeight(this.blendLength > 0 ? this.blendElapsed / this.blendLength : 1) : 1;
    return {
      clip: cur?.clip.name ?? '', frame: cur?.frame ?? 0, frames: cur?.clip.frameCount ?? 0, blend, from: this.from?.name ?? null, rate: cur?.rate ?? 0,
      layer: this.layer?.name ?? null,
    };
  }

  /** The root's height over the feet as posed (the clip's, blended), or null for a skeleton without a root. */
  rootY(): number | null {
    return this.root < 0 ? null : this.shown[this.root]!.t[1];
  }
}

/** The locomotion cycles, whose phase carries from one to the next. */
const CYCLES = new Set<string>([
  SEAL_CLIPS.walk, SEAL_CLIPS.jog, SEAL_CLIPS.run, SEAL_CLIPS.walkBack, SEAL_CLIPS.runBack, SEAL_CLIPS.strafeLeft,
  SEAL_CLIPS.strafeRight, SEAL_CLIPS.crouchWalk, SEAL_CLIPS.crouchWalkBack,
]);
export const isCycle = (name: string): boolean => CYCLES.has(name.replace(/^seal_p_/, 'seal_'));
