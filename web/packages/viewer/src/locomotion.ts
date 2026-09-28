import { SEAL_LOCOMOTION, type MotionClip } from '@s2u/scene';
import type { MotionEntry, MotionTable } from './motionTable';

/**
 * How the game plays the SEAL's clips (web sprint 3 motion workstream; web/docs/research/80-the-jump.md §3-§5): the
 * loaded motion's constants, the locomotion sets and the pick-and-blend of `FUN_0058bdf0`, the stand, crouch and
 * prone playlists, all read from `game/analysis/socom2_game.elf.decomp.c`. `./animator` plays what these return.
 *
 * **A motion as the game holds it.** The clip reader `FUN_0028a5c0` keeps the file's duration at `+0x10` and its 1.0
 * at `+0x14`; the `motion.rdr` loader `FUN_00287620` (decomp 131191-131653) then rewrites them, and `FUN_0028ab10` /
 * `FUN_0028aa20` (133194-133292) finish them:
 *
 * ```
 * +0x49 bit 6  looped;  bit 7  max_velocity < 0 (no locomotion; the velocity is then read as 0)
 * +0x1c V      looped ? (max_velocity x 10 / 100 || 1) : 1          metres a second / 10: units a second / 100
 * +0x10 T      !looped or bit 7 ? playback : duration / playback      seconds a pass
 * +0x18 D      |root(key n-1) - root(key 0)| in x and z, x n / (n - 1) when looped    the root's travel a cycle
 * +0x14 K      looped and D > 0.2 ? (bit 7 ? T : T x 100) / D : 1
 * +0x20        BlendTime, 0.4 when the entry has none (0x3ecccccd)
 * callbacks    time > 1 ? time / (T x (n - 1) / n) : time          the phase the zAnim animation fires at
 * ```
 *
 * **Playing it** (`FUN_0028c4f0`, `FUN_0028d570`, `FUN_0028d670`, 134223-134905): a play holds nodes -- a motion, a
 * weight (`+0x08`), a speed (`+0x24`, set through `FUN_0028d570` as x times K on a looped motion) -- and one phase
 * (`+0x1c`) that every node samples at (plus the node's own offset, `+0x0c`). Each tick the phase moves by
 * `dt x sum(weight x speed / (T x a))`, `a` being 1 on a looped motion and (n - 1) / n on the rest (`FUN_0028ada0`);
 * a looped phase wraps in [0, 1), a one-shot's stops at (n - 1) / n, and the key sampled is `phase x n` -- so a
 * one-shot plays its keys 0 to n - 1 in `playback x ((n - 1) / n)^2` seconds at speed 1 (`oneShotSeconds`: `seal_jump`
 * 0.993 of its 1.1) and a locomotion cycle turns at `speed x K / T = target / D` cycles a second, its root travelling
 * exactly the target speed.
 */

/** `FUN_00287620`: the cross-fade into a motion whose entry has no `BlendTime` (`puStack_8[8] = 0x3ecccccd`). */
export const BLEND_TIME_DEFAULT = 0.4;
/** `FUN_0028aa20`: a looped motion whose root travels no further than this a cycle keeps K = 1. */
const TRAVEL_FLOOR = 0.2;
/** `FUN_00583350`: a forward or lateral axis within this of 0 is none (`DAT_003f3428`, 0.03). */
export const AXIS_DEAD = 0.03;

/** The player's anim set (`READERC.ZAR/animset.rdr`, `Seal anim set`, the default mode; its `GLOBAL` include for the jump). */
export const SEAL_ANIMS = {
  stand: 'seal_stand',
  walk: 'seal_walk_alert', jog: 'seal_jog_alert', run: 'seal_run',
  walkBack: 'seal_walk_bw', jogBack: 'seal_run_bw',
  strafeRight: 'seal_rstrafe', strafeRightFast: 'seal_rstrafe_fast', runRight: 'seal_run_90r',
  strafeLeft: 'seal_lstrafe', strafeLeftFast: 'seal_lstrafe_fast', runLeft: 'seal_run_90l',
  crouch: 'seal_crouch', crouchWalk: 'seal_crouchwalk', crouchWalkBack: 'seal_crouchwalk_bw',
  crouchStrafeLeft: 'seal_crouchstrafe_left', crouchStrafeRight: 'seal_crouchstrafe_right_fast',
  prone: 'seal_prone', proneCrawl: 'seal_prone_crawl', proneRight: 'seal_prone_rstrafe', proneLeft: 'seal_prone_lstrafe',
  proneTurn: 'seal_prone_turn',
  standToCrouch: 'seal_stand2crouch', crouchToProne: 'seal_crouch2prone', standToProne: 'seal_stand2prone',
  jump: 'seal_jump', launch: 'seal_runningjump_launch', inAir: 'seal_runningjump_in_air',
  land: 'seal_land_soft', landHard: 'seal_land_hard',
} as const;

/**
 * The `Crouch` action's default mode in the `Seal anim set`: three clips and their chances (`(seal_crouch 0.3)
 * (seal_crouch_alert01 0.3) (seal_crouch_alert02 0.4)`), one drawn each time the crouch starts.
 */
export const CROUCH_IDLES: readonly { clip: string; chance: number }[] = [
  { clip: 'seal_crouch', chance: 0.3 }, { clip: 'seal_crouch_alert01', chance: 0.3 }, { clip: 'seal_crouch_alert02', chance: 0.4 },
];

/**
 * The anim set's locomotion sets, each in `motion.rdr`'s order (the builder `FUN_005e30f0`, decomp 495581, walks the
 * file's transition records in order into `FUN_005e0030`, 494313-494495, which files each by its action): `+0x60`
 * Walk, Jog, Run; `+0x90` Walk backwards, Jog backwards; `+0xf0` Strafe right, Strafe right fast, Run right; `+0xc0`
 * Strafe left, Strafe left fast, Run left; `+0x120` Crouch walk; `+0x150` Crouch walk backwards; `+0x180` Crouch
 * strafe left; `+0x1b0` Crouch strafe right (fast). A set holds the actions; each plays its default-mode clip.
 */
export const SEAL_SETS = {
  forward: [SEAL_ANIMS.walk, SEAL_ANIMS.jog, SEAL_ANIMS.run],
  back: [SEAL_ANIMS.walkBack, SEAL_ANIMS.jogBack],
  right: [SEAL_ANIMS.strafeRight, SEAL_ANIMS.strafeRightFast, SEAL_ANIMS.runRight],
  left: [SEAL_ANIMS.strafeLeft, SEAL_ANIMS.strafeLeftFast, SEAL_ANIMS.runLeft],
  crouchForward: [SEAL_ANIMS.crouchWalk],
  crouchBack: [SEAL_ANIMS.crouchWalkBack],
  crouchLeft: [SEAL_ANIMS.crouchStrafeLeft],
  crouchRight: [SEAL_ANIMS.crouchStrafeRight],
} as const;
export type SetName = keyof typeof SEAL_SETS;

/** Every clip the plays above can ask for. */
export const MOTION_CLIPS: readonly string[] = [...new Set<string>([
  ...Object.values(SEAL_ANIMS), ...CROUCH_IDLES.map((c) => c.clip),
])];

/** A motion's constants as the game holds them once loaded (the header's table). */
export interface Motion {
  clip: MotionClip;
  name: string;
  /** Keys, n. */
  frames: number;
  looped: boolean;
  /** `max_velocity` >= 0: a locomotion motion (bit 7 clear). */
  locomotion: boolean;
  /** `+0x1c`, V. */
  velocity: number;
  /** `+0x10`, T, seconds. */
  period: number;
  /** `+0x18`, D, units a cycle. */
  travel: number;
  /** `+0x14`, K. */
  scale: number;
  /** `(n - 1) / n` for a one-shot, 1 looped (`FUN_0028ada0`): where a one-shot's phase stops. */
  end: number;
  /** `+0x20`, seconds. */
  blendTime: number;
  /** `NoInterrupt`, a fraction, or null. */
  noInterrupt: number | null;
  /** The transition band, units a second (`transition_speed_A/B` x 10, as `FUN_005e0030` files them), or null. */
  band: { lo: number; hi: number } | null;
  /** The zAnim callbacks, each at its phase. */
  callbacks: { name: string; phase: number }[];
}

/**
 * The entry a motion plays by: the table's when read, else `@s2u/scene`'s transcription of `motion.rdr`'s moving
 * clips (`SEAL_LOCOMOTION`, pinned against the file by its fixture test; W2.R5), else none (the clip's own rate).
 */
export function entryOf(name: string, table: MotionTable | null): MotionEntry | undefined {
  const read = table?.get(name);
  if (read) return read;
  const t = SEAL_LOCOMOTION.find((l) => l.clip === name);
  if (!t) return undefined;
  return {
    looped: t.looped, playback: t.playback, maxVelocity: t.maxVelocity / 10, blendTime: null,
    transitionA: t.from / 10, transitionB: t.to / 10, noInterrupt: null, callbacks: [],
  };
}

/** `FUN_0028ab10`: the root's travel over a cycle, x and z (the `VerticalMotion` flag's y is no SEAL clip's). */
export function cycleTravel(clip: MotionClip, looped: boolean): number {
  const root = clip.parts.find((p) => p.name === 'skel_root');
  const n = clip.frameCount;
  if (!root || root.translations.length <= 3 || n < 1) return 0;
  const t = root.translations, last = 3 * (n - 1);
  let d = Math.hypot(t[last]! - t[0]!, t[last + 2]! - t[2]!);
  if (looped && n > 1) d *= n / (n - 1);
  return d;
}

/**
 * A clip as the game would hold it under `entry` (the header's table): an entry without `looped` is a one-shot (the
 * loader's default 0). No entry at all -- a clip `motion.rdr` does not name -- plays looped at its own duration, K 1.
 */
export function motionOf(clip: MotionClip, entry: MotionEntry | undefined): Motion {
  const n = clip.frameCount;
  const looped = entry ? entry.looped ?? false : true;
  const mv = entry?.maxVelocity ?? -1;
  const locomotion = mv >= 0;
  const playback = entry?.playback ?? null;
  const velocity = looped ? (Math.max(0, mv) * 10) / 100 || 1 : 1;
  let period: number;
  if (!entry || playback === null || playback <= 0) period = clip.duration;
  else if (!looped || !locomotion) period = playback;
  else period = clip.duration / playback;
  const travel = cycleTravel(clip, looped);
  const scale = looped && travel > TRAVEL_FLOOR ? (locomotion ? period * 100 : period) / travel : 1;
  const end = looped || n < 2 ? 1 : (n - 1) / n;
  const band = entry && entry.transitionA !== null && entry.transitionB !== null && (entry.transitionA !== 0 || entry.transitionB !== 0)
    ? { lo: entry.transitionA * 10, hi: entry.transitionB * 10 } : null;
  const callbacks = (entry?.callbacks ?? []).map((c) => ({ name: c.name, phase: c.time > 1 ? c.time / (period * end) : c.time }));
  return {
    clip, name: clip.name, frames: n, looped, locomotion, velocity, period, travel, scale, end,
    blendTime: entry?.blendTime ?? BLEND_TIME_DEFAULT, noInterrupt: entry?.noInterrupt ?? null, band, callbacks,
  };
}

/**
 * `FUN_0028c4f0` on a one-shot of `frames` keys and `playback` seconds at speed 1: the phase runs at
 * `1 / (playback x (n - 1) / n)` a second to its stop at (n - 1) / n, `playback x ((n - 1) / n)^2` seconds.
 */
export function oneShotSeconds(playback: number, frames: number): number {
  const a = frames < 2 ? 1 : (frames - 1) / frames;
  return playback * a * a;
}

/** `FUN_0028d570`: a node's speed for `x` -- times K on a looped motion. */
export function nodeSpeed(motion: Motion, x: number): number {
  return motion.looped ? x * motion.scale : x;
}

/** One node of a play: a motion, its weight and speed (`FUN_0028d570`), and its phase offset (`+0x0c`). */
export interface PlayNode { motion: Motion; weight: number; speed: number; offset: number }

/** `FUN_0028c4f0`'s phase step a second for these nodes: sum(weight x speed / (T x a)). */
export function phaseRate(nodes: readonly PlayNode[]): number {
  let r = 0;
  for (const n of nodes) if (n.motion.period > 0) r += (n.weight * n.speed) / (n.motion.period * (n.motion.looped ? 1 : n.motion.end));
  return r;
}

/**
 * `FUN_0058bdf0(m, weight, set)`: the set's clips whose band holds `|m| x 100 x V` of its first clip (units a second:
 * `m` of the first clip's `max_velocity` x 10), each at speed `m x V` (x K). One holds it: that one at `weight`. Two
 * (the bands overlap): split by how far into the overlap the speed is, `f = (v - A) / (B - A)` with A the higher of
 * their starts and B the lower of their ends, the earlier `(1 - f) weight` and the later `f weight` (f >= 1 the later
 * alone, f <= 0 the earlier). None: under every band the clip that starts lowest at its start's speed, over every
 * band the one that ends highest at its end's. `weight` under 1 first scales what is already in the play by
 * `1 - weight` (`FUN_0028cfc0`) -- which is how `FUN_00583030` shares the forward and the strafe sets. The back and
 * left sets are played with -m and their speeds turned back by `FUN_0058bab0(-1)`; their net speed is `|m|`'s, as here.
 */
export function bandPick(m: number, weight: number, set: readonly Motion[], play: PlayNode[] = []): PlayNode[] {
  if (!(weight > 0) || !set.length) return play;
  const am = Math.abs(m);
  const v = am * 100 * set[0]!.velocity;
  let minA = 100, maxB = 0, lowest: Motion | null = null, highest: Motion | null = null;
  let hiA = 0, loB = 100;
  const hit: Motion[] = [];
  for (const motion of set.slice(0, 4)) {
    const b = motion.band;
    if (!b) continue;
    if (b.lo < minA) { minA = b.lo; lowest = motion; }
    if (b.hi > maxB) { maxB = b.hi; highest = motion; }
    if (b.lo <= v && v <= b.hi) {
      hit.push(motion);
      loB = Math.min(loB, b.hi);
      hiA = Math.max(hiA, b.lo);
    }
  }
  const nodes: PlayNode[] = [];
  if (hit.length) for (const motion of hit) nodes.push({ motion, weight: 0, speed: nodeSpeed(motion, am * motion.velocity), offset: 0 });
  else if (v < minA && lowest) nodes.push({ motion: lowest, weight: 0, speed: nodeSpeed(lowest, minA / 100), offset: 0 });
  else if (maxB < v && highest) nodes.push({ motion: highest, weight: 0, speed: nodeSpeed(highest, maxB / 100), offset: 0 });
  if (!nodes.length) return play;
  if (weight < 1) for (const n of play) n.weight *= 1 - weight;
  if (nodes.length >= 2) {
    const f = (v - hiA) / (loB - hiA);
    if (f >= 1) play.push({ ...nodes[1]!, weight });
    else if (f > 0) play.push({ ...nodes[0]!, weight: (1 - f) * weight }, { ...nodes[1]!, weight: f * weight });
    else play.push({ ...nodes[0]!, weight });
  } else play.push({ ...nodes[0]!, weight });
  return play;
}

/**
 * `FUN_00583350(lateral, forward)`: the stick's magnitude `m = min(1, |stick|)` (a forward within 0.03 counted as 0)
 * and `w = asin(|lateral| / |stick|) x 2 / pi`, how far off straight ahead it points.
 */
export function stickSplit(forward: number, right: number): { m: number; w: number } {
  const f = Math.abs(forward) <= AXIS_DEAD ? 0 : forward;
  const len = Math.hypot(right, f);
  let w = len > 0 ? Math.abs(right) / len : 0;
  if (w >= 1) w = 1;
  else if (w <= 0) w = 0;
  else w = Math.min(1, Math.max(0, Math.asin(w) * (2 / Math.PI)));
  return { m: Math.min(1, len), w };
}

/** The sets as motions, for `standPlay` and the rest: a name the pack lacks is left out of its set. */
export type MotionSets = Record<SetName, Motion[]>;

/**
 * `FUN_00583030(forward, lateral)`, the standing locomotion (and the crouch's run): the forward set (`+0x60`, or the
 * back one `+0x90`) at weight 1 when the forward axis is off 0.03 and `w` < 1, then the strafe set (`+0xf0` right,
 * `+0xc0` left) at weight `w` when the lateral axis is off 0.03 and `w` > 0 -- which leaves the forward clips `1 - w`
 * (`FUN_0058bdf0`'s share; the forward call's weight is `$f13` = 1.0, set at 0x5830b8). Every node's offset is 0.
 */
export function standPlay(forward: number, right: number, sets: MotionSets): PlayNode[] {
  const { m, w } = stickSplit(forward, right);
  const play: PlayNode[] = [];
  if (Math.abs(forward) > AXIS_DEAD && w < 1) bandPick(m, 1, forward >= 0 ? sets.forward : sets.back, play);
  if (Math.abs(right) > AXIS_DEAD && w > 0) bandPick(m, w, right >= 0 ? sets.right : sets.left, play);
  return play;
}

/** `FUN_005858a0`'s direction class: 0 right, 1 forward, 2 left, 3 back (`./walk` `moveClass`). */
export type DirectionClass = 0 | 1 | 2 | 3;

/**
 * `FUN_00582d10(forward, lateral)`, the crouch walk: the one set of the class (`+0x120` forward, `+0x150` back,
 * `+0x180` left, `+0x1b0` right) at `m` and weight 1; the right set's clips play half a cycle on (`+0x0c = 0.5`).
 */
export function crouchPlay(forward: number, right: number, cls: DirectionClass, sets: MotionSets): PlayNode[] {
  const { m } = stickSplit(forward, right);
  const set = cls === 3 ? sets.crouchBack : cls === 2 ? sets.crouchLeft : cls === 1 ? sets.crouchForward : sets.crouchRight;
  const play = bandPick(m, 1, set);
  if (cls === 0) for (const n of play) n.offset = 0.5;
  return play;
}

/**
 * `FUN_00583500(forward, lateral)`, prone: the class keeps one axis; forward or back the crawl (`Prone crawl`), across
 * `Prone rstrafe` (lateral >= 0) or `Prone lstrafe`, weight 1 at speed `max(|f|, |l|) x V` (x K), negative backing up:
 * the crawl plays backwards. Each is its own action (`FUN_00588bc0`), started afresh when the class changes.
 */
export function pronePlay(forward: number, right: number, cls: DirectionClass, motions: { crawl?: Motion; right?: Motion; left?: Motion }): PlayNode[] {
  const f = cls === 1 || cls === 3 ? forward : 0, l = cls === 1 || cls === 3 ? 0 : right;
  const axis = Math.max(Math.abs(f), Math.abs(l));
  const motion = cls === 1 || cls === 3 ? motions.crawl : l >= 0 ? motions.right : motions.left;
  if (!motion) return [];
  return [{ motion, weight: 1, speed: nodeSpeed(motion, (f < 0 ? -axis : axis) * motion.velocity), offset: 0 }];
}

/**
 * The per-stance speeds the `Jump` action's stick drives the SEAL at (`FUN_0057a330` decomp 438955-438985 through
 * `FUN_0058bb50` / `FUN_0058bc00`, 447619-447686): the highest band end of each set (`FUN_005e0450`, 494496-494629),
 * units a second -- standing 65 ahead, 37 back, 65 each side; crouched 20 each way.
 */
export function airBands(stance: 'stand' | 'crouch', table: MotionTable | null): { forward: number; back: number; right: number; left: number } {
  const top = (names: readonly string[]): number => {
    let hi = 0;
    for (const n of names) {
      const e = entryOf(n, table);
      if (e?.transitionB != null) hi = Math.max(hi, e.transitionB * 10);
    }
    return hi;
  };
  return stance === 'stand'
    ? { forward: top(SEAL_SETS.forward), back: top(SEAL_SETS.back), right: top(SEAL_SETS.right), left: top(SEAL_SETS.left) }
    : { forward: top(SEAL_SETS.crouchForward), back: top(SEAL_SETS.crouchBack), right: top(SEAL_SETS.crouchRight), left: top(SEAL_SETS.crouchLeft) };
}
