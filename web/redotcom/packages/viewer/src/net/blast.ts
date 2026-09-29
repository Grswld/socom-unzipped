import type { Stance, Walker } from '../mover';
import { applyHit, fragmentCount, fragmentDamage, fragmentPart, PART, type Health } from './damage';

/**
 * A grenade's blast on one SEAL, headless (web research 85 section 7, 91 section 5): what the server's room and the
 * page's single-player match (`./loopback`, the same room) apply to each player a blast reaches. Every rule is the
 * decompilation's; what it does not settle is a named reading.
 *
 * - **Who it reaches** (`FUN_005ac070` L464806-464850): every actor -- the thrower too: nothing asks who threw it --
 *   whose `GetDamage` at its origin is over 0 (or any in a flashbang's), with the line from the blast to its head
 *   node clear (the room's `segmentHit`, `seen` here).
 * - **The reach factor** (`FUN_005a0e70` L459160-459172): `f = 1 - d^2 / r^2`, `d` from the actor's origin (its feet),
 *   `r` the round's `Explosion_Radius`; nothing at f <= 0.
 * - **The ringing ears** (L459221-459227): on the player (the player controller's `+0x2c` answers 1, `FUN_005431f0`),
 *   for anything but a shotgun (weapon ids 'Q'-'T'), `.RINGING_EARS` and every sound channel held at 0.35 for 5 s
 *   (`FUN_003412f0(5.0, 0.35, ...)`).
 * - **The fragments** (`FUN_005a18b0`, L459236-459256): `fragmentCount` of them, each `fragmentDamage` at the feet's
 *   distance on `fragmentPart`'s part at the round's piercing (`./damage`).
 * - **The knock** (`FUN_0057ed10`, stored when fragments struck and the damage at the feet is over 0, L459261-459281;
 *   applied by `FUN_0057e770` L440940-441092): see `blastKnock`.
 */

type V3 = [number, number, number];

/** `FUN_003412f0(0x40a00000, 0x3eb33333, ...)`: the ears ring for 5 s with every channel at 0.35. */
export const BLAST_RING_SECONDS = 5;
export const BLAST_RING_VOLUME = 0.35;

/** `actor+0xf84` (`param_1[0x3e1] = 0x42b40000`, the SEAL's constructor L419803): the mass the push divides by. */
export const KNOCK_MASS = 90;
/** `DAT_0044c254` = 0x42f00000 (L328369): the push's scale. `DAT_0044c250` / 98.1 is 1 at its value, 98.1 (L328368). */
export const KNOCK_PUSH = 120;
/** The push's cap, units a second (L441056-441058), and its least rise: `f x 50` (L441060-441063). */
export const KNOCK_SPEED_MAX = 100;
export const KNOCK_RISE = 50;

/**
 * The height the push is measured from (`FUN_0057e770` L440983-440986): the actor's origin plus the y of the node the
 * vtable's `+0x88` hands back (`FUN_00553db0`: `actor+0x2e8`, bound to `skel_root` at L419606). Its y at each posture's
 * idle, key 0 of `MOTION_P.ZAR`'s `seal_stand`, `seal_crouch`, `seal_prone` (the same key the page's clips pose).
 */
export const ROOT_HEIGHT: Readonly<Record<Stance, number>> = { stand: 11.48, crouch: 5.5, prone: 2.17 };

/** Which way the knocked SEAL falls: `Fall forward` or `Fall backwards` (`FUN_005807d0` L441900-441960). */
export type KnockFall = 'fallForward' | 'fallBackwards';

/** A knock: the velocity the SEAL leaves the ground with, units a second, and the clip it falls in. */
export interface Knock { velocity: V3; fall: KnockFall }

/** The SEAL a blast is resolved on: its feet, posture and facing (`Pose.yaw`: it faces (-sin yaw, 0, -cos yaw)). */
export interface BlastVictim { feet: readonly number[]; posture: Stance; yaw: number }

/** The blast: its round's record, its piercing, whether it throws fragments, whether it is a flashbang. */
export interface BlastKind {
  record: { explosionDamage: number; explosionRadius: number };
  piercing: number;
  fragments: boolean;
  flash?: boolean;
}

export interface BlastOutcome {
  /** `1 - d^2 / r^2` at the feet. */
  factor: number;
  /** The ringing ears (`BLAST_RING_SECONDS` at `BLAST_RING_VOLUME`). */
  ring: boolean;
  fragments: number;
  hits: { part: number; damage: number }[];
  /** The last fragment's part (the death's, `FUN_005a54d0(actor, part, 4)`), BODY with none. */
  part: number;
  died: boolean;
  /** The push, when fragments struck with damage at the feet; null otherwise, and prone (`blastKnock`). */
  knock: Knock | null;
}

/**
 * The push of a blast (`FUN_0057e770`): from the root (`ROOT_HEIGHT` over the feet) at `len` from the blast, inside the
 * radius only (a living SEAL; L440988), `f = clamp(1 - len^2 / r^2)`; prone, no push -- the game plays `Prone cover`
 * (`DAT_003dece0`, L441003-441012) in place, a clip the SEAL's pack does not hold (PRONE_COVER_PLACEHOLDER: nothing
 * plays). Standing or crouched: the speed `min(100, f x (dmg / 14) x 120 / 90)` along the unit line from the blast to
 * the root, its rise at least `f x 50` (L441053-441068), and the fall clip by the side the blast is on.
 *
 * KNOCK_SIDE_READING: the clip is chosen by the line put through the actor's matrix (`FUN_00306fd0`, a VU0 routine on
 * a stack copy of the negated first row, L441044-441051): a positive third component `Fall backwards`, else `Fall
 * forward`. Read here as the push against the facing: pushed back (the blast in front) falls backwards.
 *
 * `damage` is `GetDamage` at the feet (`fragmentDamage` at the feet's distance), 14 x the push's `dmg / 14`.
 */
export function blastKnock(victim: BlastVictim, point: readonly number[], record: { explosionRadius: number }, damage: number): Knock | null {
  if (victim.posture === 'prone' || !(damage > 0)) return null;
  const r = record.explosionRadius;
  const root: V3 = [victim.feet[0]!, victim.feet[1]! + ROOT_HEIGHT[victim.posture], victim.feet[2]!];
  const d: V3 = [root[0] - point[0]!, root[1] - point[1]!, root[2] - point[2]!];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len < r)) return null;
  const f = Math.max(0, Math.min(1, 1 - (len * len) / (r * r)));
  const speed = Math.min(KNOCK_SPEED_MAX, (f * (damage / 14) * KNOCK_PUSH) / KNOCK_MASS);
  const u: V3 = len > 0 ? [d[0] / len, d[1] / len, d[2] / len] : [0, 1, 0];
  const velocity: V3 = [u[0] * speed, Math.max(f * KNOCK_RISE, u[1] * speed), u[2] * speed];
  const yaw = (victim.yaw * Math.PI) / 180;
  const along = -Math.sin(yaw) * u[0] - Math.cos(yaw) * u[2];     // the push against the facing
  return { velocity, fall: along < 0 ? 'fallBackwards' : 'fallForward' };
}

/**
 * The whole blast on one SEAL (`FUN_005a0e70`): null when it does not reach (outside the radius, no line to the head,
 * or no damage at the feet and not a flashbang); else the ringing, the fragments laid on `health` in order, and the
 * knock. `random` is drawn as the game draws: the count's two, then one a fragment.
 */
export function resolveBlast(health: Health, victim: BlastVictim, point: readonly number[], kind: BlastKind, random: () => number, seen: boolean): BlastOutcome | null {
  const r = kind.record.explosionRadius;
  const dx = victim.feet[0]! - point[0]!, dy = victim.feet[1]! - point[1]!, dz = victim.feet[2]! - point[2]!;
  const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
  const atFeet = fragmentDamage(kind.record.explosionDamage, r, d);
  if (!seen || !(atFeet > 0 || kind.flash)) return null;       // FUN_005ac070: queued only with the line and damage
  const factor = r > 0 && d2 < r * r ? 1 - d2 / (r * r) : 0;
  if (factor <= 0) return null;
  const fragments = kind.fragments ? fragmentCount(d, victim.posture, random) : 0;
  const hits: { part: number; damage: number }[] = [];
  let died = false, part: number = PART.BODY;
  for (let i = 0; i < fragments; i++) {
    part = fragmentPart(random);
    hits.push({ part, damage: atFeet });
    if (applyHit(health, part, atFeet, kind.piercing)) died = true;
  }
  const knock = fragments > 0 ? blastKnock(victim, point, kind.record, atFeet) : null;
  return { factor, ring: true, fragments, hits, part, died, knock };
}

/**
 * Lays a knock on a mover: none while a traversal move holds it (KNOCK_IN_MOVE_PLACEHOLDER: the game drops the SEAL out
 * of a ladder or a hang first, `FUN_0057ee00` / `FUN_005a5da0` L441006-441012; the moves here are not cut). The room
 * and the page's prediction call this one function.
 */
export function applyKnock(walker: Walker, moves: { busy(): boolean } | null, knock: Knock): boolean {
  if (moves?.busy()) return false;
  return walker.knock(knock.velocity, knock.fall);
}
