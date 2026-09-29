import {
  buildGrid, cellAt, footprintDistance, isWallSurface, planeHeightAt, probeGround, ringCells, selectFloor, surfaceWord, upNormal,
  PROBE_LIFT, SEAL_LOCOMOTION, SEAL_TUNING, SURFACE_SKIP,
  type CollisionOwner, type MotionClip, type Grid, type GridParams, type Hit, type WorldPoly,
} from '@s2u/scene';
import type { GroundWish, Pose } from './camera';
import { airBands, oneShotSeconds, SEAL_ANIMS } from './locomotion';
import { landingKind, sealTuning, type LandingKind } from './physics';
import type { TraversalPose } from './animator';

/**
 * Walk mode (web sprint 1, W1.4; web sprint 2, W2.2b): a mover that stands on the floor the engine's probe finds,
 * slides along the walls research 24 names, runs at the game's speeds, crouches, goes prone and falls.
 *
 * - **The tick.** `CGame::Tick` (`FUN_001E7040`) runs the game at 60 Hz (web/docs/research/71 section 1.5). The
 *   mover steps on that clock from a fixed-step accumulator the page feeds real time into, so it takes the same
 *   steps at 30 fps and at 240 fps; the eye is drawn between the last two steps (`eye`).
 * - **The speed: the law, as read from the decompilation (W2.2b step 1 and its review).** Each actor tick
 *   (`dt = actor+0x2e0`) `FUN_005af930` puts the pad in `actor+0x244` (lateral, controller.rdr's `Strafe`) and
 *   `actor+0x240` (forward, `MoveLong`) -- the move stick as the pad reader leaves it (`./moveStick`: 0.3 dead per
 *   axis, rescaled, x sqrt 2, each axis clamped and the pair never put in the unit disc; the keys a full axis each, so
 *   W+D is (1, 1); web research 88 section 3) -- and `FUN_005870e0` (decomp 445164-445169) runs the ground state by the
 *   stance at `actor+0x174`: 0 -> `FUN_00586570` (stand), 1 -> `FUN_00584c60` (crouch), 2 -> `FUN_005845c0`
 *   (prone). `FUN_00586f00` calls a stick within 0.03 of rest (`DAT_003f3428`) idle: no locomotion, the stop is
 *   at once whatever the stick was.
 *
 *   ```
 *   FUN_00586c10(stick)    the throttle ramp, per axis, against last tick's (actor+0x248/0x24c):
 *     lo, hi = lower/upper_x_accel (lateral) or lower/upper_z_accel (forward)     DAT_0044c294..2a0 = 2, 5
 *     limit  = lo + (hi - lo) * (1 - (1 - |target|)^8)                            per second, in stick units
 *     if |target - prev| / dt > limit:  target = prev +- limit * dt
 *     if |prev| > 0.9 and |raw - prev| / dt > 9   (lateral: 0.78, 7.8):  target = raw, the clip blend reset to
 *       0.2 s (FUN_0028e3e0 on actor+0x170)
 *   FUN_00583350(lateral, forward)  -> m = min(1, |stick|) with forward = 0 when |forward| <= 0.03;
 *     w = asin(|lateral| / |stick|) * 2/pi (0 ahead .. 1 abeam); DAT_0064fc80 = 1 / sqrt(w^2 + (1 - w)^2)
 *   FUN_005858a0(lateral, forward)  -> the direction class actor+0x1338: 1 forward, 3 back, 0 right, 2 left, by the
 *     dominant axis (|a / b| > 0.839), in the diagonal band between by quadrant and the last class (hysteresis)
 *   FUN_0058bdf0(m, weight, set)    -> m x 100 x max_velocity (cm/s) picks the set's clip(s) by transition_speed_A..B
 *   FUN_0057a330                    -> velocity actor+0x2c = the clips' root motion (FUN_0028c250), scaled by
 *                                      DAT_0064fc80 in FUN_00309180
 *
 *   STAND  FUN_00586570: stick at rest -> no ramp (the raw 0 is kept); else FUN_00586c10, then FUN_00583030:
 *          the forward set (+0x60, back +0x90 reversed) at m with weight 1 - w when |forward| > 0.03 and w < 1,
 *          the strafe set (+0xf0 right, +0xc0 left) at m with weight w when |lateral| > 0.03 and w > 0,
 *          renormalised by DAT_0064fc80
 *   CROUCH FUN_00584c60: FUN_005858a0 on the raw stick; then
 *          |stick| x 14.8 >= 12.4 (0.838 of a stick) and the root under 9 (the stance test) -> FUN_0057efe0's
 *            headroom ray (from a node + 2 up to the feet + 19): clear -> state 2 and FUN_00583030, the STANDING
 *            run sets and blend -- the SEAL stands and runs; the stance word stays crouch, so under 0.838 it is back
 *            to the crouch walk
 *          else: stick x 14 / (|stick| x 14.8) (magnitude 0.946 whatever the push), FUN_00586c10, FUN_00582d10:
 *            ONE set by the class (+0x120 forward, +0x150 back and +0x180 left played at -m, +0x1b0 right) at
 *            weight 1, no blend -- 0.946 x 14.8 = 14.0 ahead, x 13.5 back, x 15 aside
 *   PRONE  FUN_005845c0 -> FUN_00583500: no FUN_00586c10 at all; the class keeps one axis (1/3 forward, 0/2
 *          lateral) and zeroes the other; the crawl (forward, reversed backward) or the prone strafe plays at that
 *          axis's |value|, so the speed is max(|x|, |z|) x the band on the first tick
 *   ```
 *
 *   So the velocity is `m x max_velocity` of the clip the class or the blend picks (`READERC.ZAR/motion.rdr`, at
 *   `MetersPerUnit` 0.1: 65 forward, 37 back, research 25 section 0's (0, 0, -65) and (0, 0, +37)); the ramp is the
 *   stick's, not the speed's: 0 to full in 1 / 5 s, 90 % on tick 11 (0.18 s). `fb_accel` / `lr_accel`
 *   (`DAT_0044c360/364`, `dynamics.rdr` 0.01) and `throt_exp` have no reader in the decompilation besides the
 *   static initialiser `FUN_00400870` and the loader: they do not shape the SEAL's walk. Not modelled: the slope
 *   and water slow-down `FUN_005b56c0` (`DAT_0044c358/35c`), the clips' own blend-in (0.2 s), and the root
 *   motion's shape within a stride. One consequence is kept as read: `FUN_00582d10` calls `FUN_00583350`, whose
 *   `DAT_0064fc80` then scales the crouch walk's single set, so a crouch diagonal runs 1 / sqrt(w^2 + (1 - w)^2)
 *   faster along its class's axis (19.8 at 45 degrees). Research 18 section 3.13's 0.9 s "lead" and its average of
 *   40 are the orbit camera trailing the actor on our recomp at 18.7 frames a second, not this ramp. [reading of
 *   the decompilation; W2.2c measures it on the console, W2.R7]
 * - **Stances.** A tap of `C` toggles stand and crouch (prone to crouch), a hold goes prone (owner, 2026-09-29; the
 *   touch button cycles stand, crouch, prone; nothing on Ctrl -- `camera.ts` says why); each
 *   has its bands, its body column and its skeleton root height (`STANCE`). `Walker.posture` is the body in use:
 *   `stand` while a crouch runs at full stick.
 * - **The floor.** After each sub-step `probeGround` at the new (x, z) and `selectFloor` from the origin y + 5 with
 *   the feet at y (research 23 section 1.1-1.2, research 24 section 2). A floor up to `step_height` 6.5 over the
 *   feet is stepped onto, one steeper than `max_slope` 50 degrees is not climbed, and one higher than 6.5 is refused
 *   like a wall; one down to `ground_touch_distance` 8 under them is stepped down to (`READERC.ZAR/dynamics.rdr`,
 *   reCOM `zCharacter/char_dyn.cpp:17-20`; research 17 section 8's `+0x14..+0x1c`). No floor, and the step is refused.
 *   Known gap, for W2.2c: `selectFloor` takes the highest floor at or under y + 6, so a kerb between 6 and 6.5 over
 *   the feet with a lower floor also under the line is passed over for the lower one -- the selection's behaviour,
 *   inherited, not the step rule's.
 * - **The fall.** Further than 8 down, the mover is airborne. `FUN_0059b440` integrates it: the fall speed
 *   `actor+0x133c += g x dt`, then the height `actor+0x2e4 -= speed x dt` (as here: `vy -= g x dt`, `y += vy x dt`),
 *   with `g` the table's `0x44c250 +0x00` -- the static default `0x42c43333` = 98.1 (1 g in units), overwritten
 *   with `dynamics.rdr`'s 235 by the loader `FUN_0059ba80`, so units a second squared and the SEAL falls at 2.4 g.
 *   `g x 0.8` applies only in the `Ladderslide` state (`DAT_003def50`, the string at `0x6620c8`), not a walk-off or
 *   a landing: not modelled. The horizontal velocity is held as it left the edge (no air control: the stick-driven
 *   velocity with `FUN_00586c10` in `FUN_0057a330` runs only in the `Jump` state, `DAT_003deae8` = "Jump" at
 *   `0x661510`), until the probe's floor is met. A 42-unit drop (Frostfire's decks, research 24 section 7 item 4)
 *   takes sqrt(2 x 42 / 235) = 0.60 s.
 * - **The walls.** Research 24 section 2 step 3: a polygon with bit 1 set, bit 18 clear and `|n_y| < 0.7`, met by
 *   the body's column (y + 6 to y + 20 standing) at radius 3.5 (W1.R2); the mover is pushed out along the wall
 *   until it is 3.5 from it, and keeps the part of its step that runs along it. The game's movement collision is
 *   not decompiled -- that walls stop the mover is research 24's inference from the 3c trails, which stand off wall
 *   planes at 4.4-5.8 (section 4.1).
 * - **The view (W2.1, W2.R1).** The game's third-person camera (`playerCamera.ts`): its target `rootY + ramp` over
 *   the feet at the posture's root, its eye behind and over, the pass against the hull, a tick at a time after the
 *   mover's and drawn between ticks; zoomed, the scope's view from the head (`scopeEyeHeight`). There is no first
 *   person (the owner, 2026-09-29: the views are third person and scoped, as SOCOM II's). The mouse turns the body's
 *   yaw and the camera's pitch (`camera.ts`). Sprint 1's eye 15.4 (`EYE_HEIGHT`, W1.R2) is retired as a view; it
 *   stays the height a pose drops the mover from.
 * - **The jump** (web/docs/research/80-the-jump.md, read from the decompilation). `FUN_0057e1b0` (decomp
 *   440776-440867) takes the press when the SEAL is on walkable ground (`actor+0x1348` >= cos `max_slope`), not prone
 *   (`FUN_005b4340(.., 0xb)` refuses stance 2), and not within 0.4 s (`actor+0x135c`) of a running jump's take-off or
 *   of a landing. **At 15 units a second or more** (speed^2 >= 225) it is the **running jump**: the `Jump launch` action
 *   (`seal_runningjump_launch`), the take-off's world velocity kept at `actor+0x1350..0x1358` and carried through the
 *   air with no stick (`FUN_0054d9a0`, 416501-416555), and `actor+0x1364 = jump_factor x gravity x -0.4` -- -79.9 --
 *   written into the fall speed 0.1 s later (`actor+0x1360`, `FUN_005af930`): an impulse of **79.9 units a second up**
 *   under the 235 fall, a rise of 13.6 units (1.36 m) and 0.68 s in the air after the 0.1 s wind-up. **Under 15** it is
 *   the **standing jump**: the `Jump` action (`seal_jump`, 0.99 s), and the feet never leave the floor -- the height
 *   comes from the clip only for `UseVelY` motions (`FUN_0059afd0`, 456328-456466), and `seal_jump` is none: the rise
 *   is the skeleton root's, 10.5 to 15.1 over the feet, and the game's camera follows that root. While it plays the
 *   stick drives the SEAL at each set's top speed (`FUN_0057a330` 438955-438985, the only air control: 65 ahead, 37
 *   back, 65 aside standing, 20 crouched). **Landing** (`FUN_005af590`, 466641-466728): over `land_hard_fall_rate` 115
 *   the `Jump land hard` action (`seal_land_hard`, 0.9 s); else, with the stick at rest or the last airborne tick's
 *   velocity under 20 (`actor+0x38`, the fall included: `FUN_005483d0` decomp 413963), `Jump land` (`seal_land_soft`,
 *   0.63 s); else no clip, the run going on from the stick at once (the ramp skipped: `actor+0x248 = +0x244`). Through a
 *   landing clip the carried velocity runs down at 150 a second squared (`FUN_0054d9a0`). A walk-off plays the
 *   in-air clip (`Jump fall`, `FUN_0057e050`) and lands by the same rule.
 * - **The stance changes** (`FUN_005817d0`, `FUN_00581c10`, `FUN_00581540`, decomp 442170-442660): standing to crouch
 *   plays `Stand -> Crouch` (0.60 s) unless moving over 10 a second; crouch to stand the same clip backwards unless
 *   moving over 10; to prone `Stand -> Prone` (0.95 s) or `Crouch -> Prone` (0.85 s), and out of prone those backwards.
 *   The ground state does not run while a transition plays (`FUN_005870e0` runs it only on a locomotion action) [reading].
 */

/** Seconds per tick: `CGame::Tick` at 60 Hz (web/docs/research/71 section 1.5). */
export const TICK = 1 / 60;
/**
 * Sprint 1's eye over the feet (W1.R2): no longer a view (W2.1 retired it: W2.R1), the height `setCamera` and the
 * spawn drop the mover from, and `Walker.eye`'s.
 */
export const EYE_HEIGHT = 15.4;
/** The body's radius against walls (W1.R2; research 24 section 2 step 3, section 4.1). */
export const BODY_RADIUS = 3.5;
/** No step moves further than this at once, so a wall 3.5 away cannot be stepped through at any speed. */
const MAX_SUBSTEP = 1;

/** The SEAL's three stances, in the order the touch button cycles them (`zSeal/zseal.h`'s `SEAL_STANCE`). */
export type Stance = 'stand' | 'crouch' | 'prone';
export const STANCES: readonly Stance[] = ['stand', 'crouch', 'prone'];

/** A stance's four moving bands, units a second: the `max_velocity` of the clip each direction plays. */
export interface Bands { forward: number; back: number; right: number; left: number }

/** What a stance is to the mover: its bands, its skeleton root's height, and the column a wall has to reach. */
export interface StanceBody {
  bands: Bands;
  /** The skeleton root node's Y over the feet (`actor+0x2e8` -> `+0x04`), W2.1's `rootY + ramp(rootY)`. */
  rootY: number;
  /** The body's column over the feet that a wall has to reach into. */
  bodyLow: number;
  bodyHigh: number;
}

/** A clip's `max_velocity` from `READERC.ZAR/motion.rdr` (`SEAL_LOCOMOTION`, units a second). */
function band(clip: string): number {
  const b = SEAL_LOCOMOTION.find((l) => l.clip === clip);
  if (!b) throw new Error(`motion.rdr has no ${clip}`);
  return b.maxVelocity;
}

/**
 * The stances. The bands are `motion.rdr`'s (W2.R2); the actor's per-stance speed table at `actor+0x528` is read
 * by stance `actor+0x174` in `FUN_0058bb50` (lateral) and `FUN_0058bc00` (forward/back).
 *
 * - **Stand.** `seal_run` 65, `seal_run_bw` 37, `seal_rstrafe` / `seal_lstrafe` 65. Root **11.484**, measured:
 *   `skel_root` of the five standing actors in the console dump `logs/parity/spawn_pcsx2.rdram` (32 node pointers at
 *   `+0x64`, the CZBodyPart layout, the W2.3 decode). With it `FUN_0029a950`'s ramp is at its top (fVar9 = 10), a
 *   standing look-at target 21.48 over the feet, which is where `dynamics.rdr`'s `cam_*_aim` y 20.5 sits. Column
 *   6-20 (research 24 section 2 step 3).
 * - **Crouch.** `seal_crouchwalk` 14.8, `_bw` 13.5, `seal_crouchstrafe_right_fast` / `_left` 15. Root **5.504**,
 *   measured: the player at spawn in the same dump is crouched -- its root is under the game's own stance test
 *   `node[0].y < 9.0` (`FUN_00584c60`, research 17 section 8) and its right knee is on the ground at 0.54. Research
 *   17 section 1 called 5.504 "standing idle"; the dump's reading contradicts it (under review: W2.1 and W2.2c settle
 *   it). Column 6-14 [estimate]: the standing top 20 x 0.7, the height a crouch keeps; it stays over
 *   `min_stand_height` 10 (`dynamics.rdr`, x10), which reads as the clearance a standing SEAL needs
 *   (`char_dyn.cpp:421-422` names it, nothing here reads it).
 * - **Prone.** `seal_prone_crawl` 11 each way (`motion.rdr` has no backward crawl with a positive `max_velocity`;
 *   `FUN_00583500` plays the crawl at `-|forward|` backing up, the clip reversed), `seal_prone_rstrafe` /
 *   `_lstrafe` 5.5. Root **1.8** [estimate, W2.2c measures]: under the ramp's floor 2.169155, where the camera
 *   stops lowering -- the lowest stance is the one the floor was cut for -- and about a body's half-thickness,
 *   0.18 m, over the ground. Column 6-9 [estimate]: a body lying down is about 0.9 m high with the head and rifle
 *   up; the column's foot stays at 6, the step's band, so a kerb a standing SEAL steps onto is a step prone too.
 */
export const STANCE: Readonly<Record<Stance, StanceBody>> = {
  stand: {
    bands: { forward: band('seal_run'), back: band('seal_run_bw'), right: band('seal_rstrafe'), left: band('seal_lstrafe') },
    rootY: 11.484, bodyLow: 6, bodyHigh: 20,
  },
  crouch: {
    bands: { forward: band('seal_crouchwalk'), back: band('seal_crouchwalk_bw'), right: band('seal_crouchstrafe_right_fast'), left: band('seal_crouchstrafe_left') },
    rootY: 5.504, bodyLow: 6, bodyHigh: 14,
  },
  prone: {
    bands: { forward: band('seal_prone_crawl'), back: band('seal_prone_crawl'), right: band('seal_prone_rstrafe'), left: band('seal_prone_lstrafe') },
    rootY: 1.8, bodyLow: 6, bodyHigh: 9,
  },
};

/** A stance's bands, root and column (`STANCE`). */
export function stanceBody(stance: Stance): StanceBody {
  return STANCE[stance];
}

/** The skeleton root's height over the feet in a stance: W2.1's camera stands on `rootY + ramp(rootY)`. */
export function rootY(stance: Stance): number {
  return STANCE[stance].rootY;
}

/** `FUN_00586c10`'s snap: an axis past `at` whose wish jumps faster than `rate` a second takes the wish at once. */
const SNAP = { right: { at: 0.78, rate: 7.8 }, forward: { at: 0.9, rate: 9 } } as const;
/** `FUN_00583350`'s dead zone on the forward axis (`DAT_003f3428`, 0.03 in the ELF's data). */
const FORWARD_DEAD = 0.03;
/** `max_slope` as the game keeps it, a cosine: 0.642788 for 50 degrees (research 17 section 8 `+0x18`). */
const MAX_SLOPE_COS = Math.cos((SEAL_TUNING.maxSlopeDeg * Math.PI) / 180);

/**
 * One tick of `FUN_00586c10` on one stick axis: `prev` is last tick's value, `target` the pad's; the value the
 * mover uses this tick. `forward` takes `lower/upper_z_accel`, `right` `lower/upper_x_accel` (`dynamics.rdr` 2 and
 * 5; the game's x is the actor's lateral, its z the forward).
 */
export function throttleStep(prev: number, target: number, axis: 'forward' | 'right', dt: number = TICK): number {
  const [lo, hi] = axis === 'forward' ? SEAL_TUNING.accelZ : SEAL_TUNING.accelX;
  const snap = SNAP[axis];
  if (Math.abs(prev) > snap.at && Math.abs(target - prev) / dt > snap.rate) return target;
  const rest = (1 - Math.abs(target)) ** 2;
  const limit = lo + (hi - lo) * (1 - (rest * rest) ** 2);
  if (Math.abs(target - prev) / dt <= limit) return target;
  return target > prev ? prev + limit * dt : prev - limit * dt;
}

/**
 * `FUN_00583350` and the blend it sets up: the velocity on the ground plane, (forward, right) in units a second,
 * for the ramped stick in a stance's bands. The forward/back band carries `1 - w` of it, the strafe band `w`, with
 * `w` the stick's angle off straight ahead over 90 degrees, and the sum renormalised by `1 / sqrt(w^2 + (1 - w)^2)`
 * -- so a 45-degree stick in two 65 bands runs at 65 along 45 degrees.
 */
export function locomotion(forward: number, right: number, bands: Bands): { forward: number; right: number } {
  const f = Math.abs(forward) <= FORWARD_DEAD ? 0 : forward;
  const length = Math.hypot(f, right);
  if (length === 0) return { forward: 0, right: 0 };
  const m = Math.min(1, length);
  const w = Math.min(1, Math.max(0, Math.asin(Math.min(1, Math.abs(right) / length)) * (2 / Math.PI)));
  const norm = 1 / Math.hypot(w, 1 - w);
  const along = f === 0 || w >= 1 ? 0 : Math.sign(f) * (1 - w) * m * (f > 0 ? bands.forward : bands.back) * norm;
  const across = Math.abs(right) <= FORWARD_DEAD || w <= 0 ? 0 : Math.sign(right) * w * m * (right > 0 ? bands.right : bands.left) * norm;
  return { forward: along, right: across };
}

/** `FUN_005858a0`'s direction classes (`actor+0x1338`): 0 right, 1 forward, 2 left, 3 back; -1 at rest. */
export type MoveClass = -1 | 0 | 1 | 2 | 3;
/** Where one axis counts as dominant in `FUN_005858a0`: `|a / b| > 0.839`. */
const DOMINANT = 0.839;

/**
 * `FUN_005858a0`: the direction class of a (lateral, forward) stick, `prev` the last one. A dominant axis names it;
 * in the diagonal band between, the quadrant and the last class do, so a stick swept across a diagonal holds its
 * class until the other axis dominates.
 */
export function moveClass(right: number, forward: number, prev: MoveClass): MoveClass {
  if (right === 0 && forward === 0) return -1;
  if (forward !== 0 && Math.abs(right / forward) <= DOMINANT) return forward > 0 ? 1 : 3;
  if (right !== 0 && Math.abs(forward / right) <= DOMINANT) return right > 0 ? 0 : 2;
  if (right > 0 && forward > 0) return prev === 3 || prev === 0 ? 0 : 1;
  if (right < 0 && forward > 0) return prev === 3 || prev === 2 ? 2 : 1;
  if (right < 0 && forward < 0) return prev === 2 || prev === 1 ? 2 : 3;
  return prev === 1 || prev === 0 ? 0 : 3;
}

/** A class's axis as (forward, right) unit components, and its band in a stance. */
function classAxis(c: MoveClass, bands: Bands): { f: number; r: number; band: number } {
  switch (c) {
    case 0: return { f: 0, r: 1, band: bands.right };
    case 1: return { f: 1, r: 0, band: bands.forward };
    case 2: return { f: 0, r: -1, band: bands.left };
    case 3: return { f: -1, r: 0, band: bands.back };
    default: return { f: 0, r: 0, band: 0 };
  }
}

/** `FUN_00586f00`: a stick within 0.03 of rest (`DAT_003f3428`) is idle; no locomotion runs. */
function idle(forward: number, right: number): boolean {
  return Math.abs(right) <= FORWARD_DEAD && Math.abs(forward) <= FORWARD_DEAD;
}

/** `FUN_00584c60`: the crouch runs from this stick magnitude: 12.4 / 14.8 (`153.76 <= |s|^2 x 219.04`). */
const CROUCH_RUN = 12.4 / 14.8;
/** `FUN_00584c60`'s crouch-walk rescale: the stick to 14 / 14.8 of a push, 14.0 a second in `seal_crouchwalk`. */
const CROUCH_WALK = 14 / 14.8;
/**
 * `FUN_0057efe0(actor, 0)`'s headroom ray: from a skeleton node (`actor+0x304`) + 2 up to the feet + 19. The node's
 * height is not in hand; the ray is taken from the crouch column's top, 14 [estimate, W2.2c measures].
 */
const HEADROOM_FROM = 14, HEADROOM_TO = 19;
/** Ticks one `advance` may run: a stalled tab catches up this far and drops the rest (the page caps dt at 0.1 s). */
const MAX_TICKS = 30;
/** How many times the walls are revisited in one step, for a corner where one push leads into the next wall. */
const WALL_PASSES = 4;

/** What the mover is asked to do each tick: `camera.ts`'s ground-plane wish, from the keys or the touch stick. */
export type WalkInput = GroundWish;

/**
 * What the worker hands the page for the walk: the probe's polygon set (`worldCollision`, 3,318 on Frostfire,
 * research 24 section 1.1), its nodes (`collisionOwners`: the probe's per-model unit and the gate's flags) and the
 * map's `grid_params`. The polygons travel packed in two typed arrays the worker transfers: as objects, Guidance's
 * 18,464 took 44 ms to clone (measured 2026-09-28), part of it on the page's thread at every map load.
 */
export interface GroundData {
  grid: GridParams;
  owners: CollisionOwner[];
  /** Every polygon's points, xyz, polygon after polygon in `worldCollision` order. */
  points: Float32Array;
  /** Per polygon, `GROUND_FIELDS` words: ptcount, ditype, material, cameratype, region, appflags. */
  fields: Uint32Array;
}
/** TRAVERSAL SEAM (web research 86): the sixth word is `m_appflags`, which marks the ladders (`./traversal`). */
const GROUND_FIELDS = 6;

/** Packs a map's hull for the trip from the worker (`GroundData`). */
export function packGround(grid: GridParams, polys: readonly WorldPoly[], owners: CollisionOwner[]): GroundData {
  let floats = 0;
  for (const p of polys) floats += p.points.length;
  const points = new Float32Array(floats);
  const fields = new Uint32Array(polys.length * GROUND_FIELDS);
  let at = 0;
  polys.forEach((p, i) => {
    points.set(p.points, at);
    at += p.points.length;
    // AUDIO (web/docs/research/81 §9): the sixth word also carries m_inside (bit 3) and the reverb zone (bit 4).
    const flags = (p.appflags ?? 0) | ((p.inside ?? 0) << 3) | ((p.reverbZone ?? 0) << 4);
    fields.set([p.ptcount, p.ditype, p.material, p.cameratype, p.region >>> 0, flags], i * GROUND_FIELDS);
  });
  return { grid, owners, points, fields };
}

/** The polygons back out of a `GroundData`, their points views on its buffer, named by the node that owns them. */
export function groundPolygons(ground: GroundData): WorldPoly[] {
  const count = ground.fields.length / GROUND_FIELDS;
  const owner: (CollisionOwner | undefined)[] = new Array(count);
  for (const o of ground.owners) for (let i = o.first; i < Math.min(count, o.first + o.count); i++) owner[i] = o;
  const out: WorldPoly[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const f = i * GROUND_FIELDS, ptcount = ground.fields[f]!;
    out.push({
      modelName: owner[i]?.modelName ?? 'worldmodel', path: owner[i]?.path ?? '',
      ptcount, ditype: ground.fields[f + 1]!, material: ground.fields[f + 2]!, cameratype: ground.fields[f + 3]!,
      region: ground.fields[f + 4]!, appflags: ground.fields[f + 5]! & 7,
      inside: (ground.fields[f + 5]! >> 3) & 1, reverbZone: (ground.fields[f + 5]! >> 4) & 1, points: ground.points.subarray(at, at + ptcount * 3),
    });
    at += ptcount * 3;
  }
  return out;
}

/** The grid the probe walks, from what the worker sent: only the collision is linked, which is all it reads. */
export function groundGrid(ground: GroundData): Grid {
  return buildGrid(ground.grid, [], [], groundPolygons(ground), ground.owners);
}

/**
 * The mover's state: feet position, look (degrees, as `Pose`), velocity (units a second; `vy` only while airborne),
 * and the ramped stick (`FUN_00586c10`'s `actor+0x248/0x24c`: last tick's forward and lateral).
 */
export interface WalkState {
  x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vz: number; vy: number;
  stickForward: number; stickRight: number;
}

/**
 * The last landing: its class against the table's landing rates, the vertical speed at contact (units a second,
 * downward), and the seconds from leaving the floor to the contact.
 */
export interface Landing {
  kind: LandingKind; speed: number; airTime: number;
  /** The clip the game plays for it (`FUN_005af590`), or null: the run goes on. */
  clip: 'land' | 'landHard' | 'hit' | 'hitStomach' | 'landDeath' | null;
  /** `FUN_005ac1f0`'s class (`landingClass`): 0 none, 1 light, 2 heavy, 3 death -- the audio's landing sounds. */
  cls: 0 | 1 | 2 | 3;
}

/** What the hook reports of the mover: in the air, crouched (the posture), the stance, and the last landing. */
export interface MoverState { airborne: boolean; crouched: boolean; stance: Stance; landing: Landing | null }

/**
 * The mover as the body and its clips read it each frame (`./animator`'s `MoverSnapshot` and where to stand): the
 * drawn feet, the look, the velocity, the posture, the last landing's class, and the jumps taken.
 */
export interface PlaySnapshot {
  feet: [number, number, number];
  yaw: number; pitch: number;
  vx: number; vz: number; vy: number;
  airborne: boolean; crouched: boolean; stance: Stance;
  landing: LandingKind | null;
  jumps: number;
  /** The ground state and its stick (`GroundMotion`): what the locomotion clips play by. */
  ground: GroundMotion;
  /** The action holding the mover, or null. */
  action: MoverAction | null;
  /** The upper-body overlay over the locomotion (the moving swap), or null. */
  overlay?: MoverOverlay | null;
  /** The look's turn over the last frame, radians a second, left positive: what turns the prone body in place. */
  turnRate: number;
  /** TRAVERSAL SEAM: the traversal move's clip, or null (`./animator` `MoverSnapshot.traversal`). */
  traversal?: TraversalPose | null;
  /**
   * TRAVERSAL SEAM: the peek held (state 3, `seal+0x375`: -1 left, 1 right; 0 none) -- `GetThrowAnim` takes the lean's
   * toss from it (web research 86 section 4.4; `./grenade`).
   */
  peek?: -1 | 0 | 1;
}

/** The table's jump and landing fields (`./physics`): `jump_factor`, `gravity` and the landing rates. */
const JUMP_TABLE = sealTuning(null);

/** TRAVERSAL SEAM: what `Walker.driver` is (`./traversal`'s `Traversal`). */
export interface TickDriver {
  tick(walker: Walker, input: WalkInput, dt: number): boolean;
  /** The stick's factor this tick (web research 86 section 5: the water's `FUN_005b56c0`), 1 when absent. */
  stickFactor?(walker: Walker): number;
  /**
   * The stick as `FUN_005b56c0` leaves it (web research 86 section 5.3): each axis by the ground's uphill factor, then
   * the water's; unchanged when absent.
   */
  stickScale?(walker: Walker, forward: number, right: number): [number, number];
}

/**
 * TRAVERSAL SEAM (web research 86): what `WalkMode` asks of the traversal moves (`./traversal`'s `Traversal`, made by
 * the factory `main.ts` hands `WalkMode.useTraversal`, so this file imports none of it): the tick, the clip for the
 * animator, the root the camera stands on, the yaw a move holds, the peek, the action and lean buttons, and a reset.
 */
export interface TraversalHooks extends TickDriver {
  pose(): TraversalPose | null;
  rootY(): number | null;
  yaw(): number | null;
  /** The camera's peek value `DAT_004161c0`, -1 left .. 1 right (`./playerCamera` `peekShift`). */
  peek(): number;
  /** The peek held (state 3): -1 left, 1 right, 0 none -- the body's lean, not the camera's eased value. */
  peeking(): -1 | 0 | 1;
  action(): void;
  lean(side: -1 | 0 | 1): void;
  reset(walker?: Walker): void;
  /** Whether a move holds the mover (a ladder, a climb, a hang): no jump and no stance change then. */
  busy(): boolean;
  /** The jump while busy (hanging: let go); true when it did something. */
  jump(walker: Walker): boolean;
  /** The dive (`FUN_0057e540`) in place of a go-prone from a run; true when it dived. */
  dive(walker: Walker): boolean;
  /** A stance button while busy (hanging: stand climbs, crouch or prone let go); true when it did something. */
  stanceButton(walker: Walker, stance: Stance): boolean;
}

/** `FUN_0057e1b0`: a take-off at this speed or more (`225 <= |v|^2`, the local velocity) is the running jump. */
export const RUNNING_JUMP_SPEED = 15;
/** `FUN_0057e1b0` -> `FUN_005af930`: the running jump's impulse lands in the fall speed this long after the take-off (`actor+0x1360 = 0x3dcccccd`). */
export const JUMP_DELAY = 0.1;
/** `actor+0x135c = 0x3ecccccd`: no jump this long after a running jump's take-off, or after any landing (`FUN_005af930`). */
export const JUMP_LOCK = 0.4;
/** `FUN_0054d9a0`: the carried velocity runs down by this many units a second, each second, through a landing clip. */
export const CARRY_DECAY = 150;
/** `FUN_005af590`: the soft landing's speed, units a second (`|actor+0x38|^2 <= 400`); the stick at rest also gives it. */
export const LAND_STILL = 20;
/** `FUN_005817d0` / `FUN_00581c10`: a stance change at more than this (`speed^2 > 100`) runs on without a transition clip. */
export const STANCE_MOVING = 10;

/**
 * The running jump's impulse, units a second up: `actor+0x1364 = jump_factor x gravity x -0.4` (`FUN_0057e1b0`, decomp
 * 440830), the fall speed `FUN_005af930` writes 0.1 s after the take-off -- 0.85 x 235 x 0.4 = 79.9.
 */
export function runningJumpSpeed(t: { jump_factor: number; gravity: number } = JUMP_TABLE): number {
  return t.jump_factor * t.gravity * 0.4;
}

/**
 * The clips the mover waits on -- the standing jump, the landings, the heavy fall's hits, the deadly fall and the
 * three stance transitions -- as `motion.rdr`'s `playback` and `NoInterrupt` and `MOTION_P.ZAR`'s key count and root
 * travel (x, z over keys 0 to n - 1): transcribed (W2.R5), pinned against both files by the fixture test.
 *
 * `noInterrupt` is the phase past which the stick cuts the clip (`FUN_00587c20`, decomp 445514-445576: an entry's
 * `NoInterrupt`, 0 when absent and 1 when bare -- never); for the player the three transitions are never cut
 * whatever their entry says (the same function refuses actions 17, 19 and 25 when the controller's `+0x30` answers).
 */
export const ACTION_CLIPS = Object.freeze({
  jump: { playback: 1.1, frames: 20, noInterrupt: 0.7, travel: [0, 0] },
  launch: { playback: 2.4, frames: 25, noInterrupt: 1, travel: [0, 0] },
  land: { playback: 0.7, frames: 20, noInterrupt: 0, travel: [0.19, -2.09] },
  landHard: { playback: 1, frames: 20, noInterrupt: 0.35, travel: [0.19, -2.09] },
  standToCrouch: { playback: 0.65, frames: 27, noInterrupt: 1, travel: [-1.2, 1.27] },
  crouchToProne: { playback: 0.9, frames: 33, noInterrupt: 1, travel: [0.99, -8.39] },
  standToProne: { playback: 1, frames: 36, noInterrupt: 1, travel: [-1.59, -3.41] },
  hit: { playback: 3.7, frames: 22, noInterrupt: 0.8, travel: [0.48, -16.63] },
  hitStomach: { playback: 2.9, frames: 32, noInterrupt: 0.8, travel: [0.63, 6.79] },
  landDeath: { playback: 0.4, frames: 11, noInterrupt: 1, travel: [0.05, -0.72] },
  getUp: { playback: 2, frames: 27, noInterrupt: 0.8, travel: [-1.79, -1.1] },
  // The rifle <-> pistol swap's full-body clips (`FUN_005a64c0`): `NoInterrupt ()`, but the standing one gives way to the
  // stick all the same (`FUN_00550ef0` 418183: action 0x35 is tested whatever `FUN_00587c20` says).
  swapStand: { playback: 1.32, frames: 32, noInterrupt: 1, travel: [0, 0] },
  swapCrouch: { playback: 1, frames: 23, noInterrupt: 1, travel: [0, 0] },
  swapProne: { playback: 1.8, frames: 38, noInterrupt: 1, travel: [0, 0] },
} as const);

/** `Moving rifle -> Pistol` (`seal_mv_rifle2pistol`, 21 keys, `playback` 1.32, `BlendOverlay`): the swap on the move. */
export const SWAP_OVERLAY = { playback: 1.32, frames: 21 } as const;

/**
 * The swap `WalkMode.swapWeapon` / `Walker.swapWeapon` picked (`FUN_005a64c0`): the full-body action it started, or
 * the overlay over the locomotion (`overlay` true), and whether it plays backwards (the pistol back to the rifle).
 */
export interface SwapPick { action: 'swapStand' | 'swapCrouch' | 'swapProne' | null; overlay: boolean; reversed: boolean; seconds: number }

/**
 * WEAPON: the swap clip playing on the mover (`Walker.swapProgress`): the action it is (null for the moving overlay),
 * whether it is the overlay, and how far through it is, 0..1 of its seconds whichever way the clip runs. The kit's
 * hand-off and end run on this clock, the one the body is drawn by, not a count of their own.
 */
export interface SwapProgress { action: 'swapStand' | 'swapCrouch' | 'swapProne' | null; overlay: boolean; progress: number }

/**
 * An upper-body clip over the locomotion (the game's second play channel, `FUN_0028d860(anim+0x60, ...)`; a motion
 * flagged `BlendOverlay`): the moving swap. `t` seconds into `seconds`, backwards when `reversed`.
 */
export interface MoverOverlay { clip: string; serial: number; t: number; seconds: number; reversed: boolean }

/** `FUN_00550ef0` (decomp 418180-418190): an interruptible action is cut when a stick axis passes this. */
export const INTERRUPT_STICK = 0.1;

/**
 * `FUN_005ac1f0`'s landing classes (decomp 464864-464968): the contact speed against `m_landSpeed[3]` = the table's
 * gravity x sqrt(2 x `FALLING_DAMAGE_LIGHT/HEAVY/DEATH` / gravity) (`+0x30..0x38`; reCOM `char_dyn.cpp:32-35`):
 * 170.7, 206.8 and 237.5 at 235 and 62 / 91 / 120 units. 0 none, 1 light (over the first), 2 heavy (over the
 * second), 3 death (at or over the third).
 */
export function landingClass(speed: number, g: number = SEAL_TUNING.gravity, heights: readonly number[] = SEAL_TUNING.fallingDamage): 0 | 1 | 2 | 3 {
  const [light, heavy, death] = heights.map((h) => g * Math.sqrt((2 * h) / g)) as [number, number, number];
  if (!(speed > light)) return 0;
  if (!(speed > heavy)) return 1;
  return speed >= death ? 3 : 2;
}

/**
 * How long each holds the mover: the one-shot's run to its last key (`./locomotion` `oneShotSeconds`, `FUN_0028c4f0`):
 * `seal_jump` 0.993 s, the landings 0.632 and 0.903, the transitions 0.603, 0.846 and 0.945.
 */
export const ACTION_SECONDS: Readonly<Record<keyof typeof ACTION_CLIPS, number>> = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_CLIPS).map(([k, c]) => [k, oneShotSeconds(c.playback, c.frames)]),
) as Record<keyof typeof ACTION_CLIPS, number>);

/**
 * What the mover is doing besides the ground state (the game's action stack, `actor+0x1c0`): the standing jump
 * (`Jump`), the running jump's take-off (`Jump launch`), the fall (`Jump fall`), the landings (`Jump land`, `Jump land
 * hard`) and a stance transition (`Stand -> Crouch`, `Crouch -> Prone`, `Stand -> Prone`, played backwards when
 * getting up). `serial` changes with every start, so the animator sees a restart.
 */
export type MoverActionName = 'jump' | 'launch' | 'fall' | 'land' | 'landHard' | 'standToCrouch' | 'crouchToProne' | 'standToProne'
  | 'hit' | 'hitStomach' | 'landDeath' | 'getUp' | 'swapStand' | 'swapCrouch' | 'swapProne';
export interface MoverAction {
  name: MoverActionName;
  serial: number;
  /** Seconds since it started. */
  t: number;
  /** How long it holds the mover, or null (the fall holds until the landing; the launch its clip's run, or the landing). */
  seconds: number | null;
  /** A transition played backwards: getting up. */
  reversed: boolean;
}

/**
 * The ground state as the animator needs it (`./locomotion`): which state ran (`FUN_00586570` stand -- the crouch's run
 * too --, `FUN_00584c60` crouch, `FUN_005845c0` prone, or none: at rest), the stick values it ran on (ramped,
 * rescaled) and the direction class.
 */
export interface GroundMotion { state: 'idle' | Stance; forward: number; right: number; cls: MoveClass }

/** A wall polygon with what the step needs of it computed once. */
interface Wall {
  poly: WorldPoly;
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
  /** The unit normal's horizontal part, normalised: the direction a push leaves the wall along. */
  nx: number; nz: number;
}

function wallOf(poly: WorldPoly): Wall | null {
  const n = upNormal(poly);
  if (n === null) return null;
  const h = Math.hypot(n[0], n[2]);
  if (h < 1e-9) return null;
  const p = poly.points;
  const wall: Wall = { poly, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity, nx: n[0] / h, nz: n[2] / h };
  for (let i = 0; i < p.length; i += 3) {
    wall.minX = Math.min(wall.minX, p[i]!); wall.maxX = Math.max(wall.maxX, p[i]!);
    wall.minY = Math.min(wall.minY, p[i + 1]!); wall.maxY = Math.max(wall.maxY, p[i + 1]!);
    wall.minZ = Math.min(wall.minZ, p[i + 2]!); wall.maxZ = Math.max(wall.maxZ, p[i + 2]!);
  }
  return wall;
}

/**
 * The part of a polygon between two heights, as its footprint: Sutherland-Hodgman against y >= lo and y <= hi,
 * then the x and z of what is left, flattened. A vertical wall's footprint is a segment; a leaning one's has area.
 */
function bandFootprint(points: Float32Array, lo: number, hi: number): number[] {
  let poly: number[][] = [];
  for (let i = 0; i < points.length; i += 3) poly.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  const clip = (inside: (y: number) => boolean, at: number): void => {
    const out: number[][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const ina = inside(a[1]!), inb = inside(b[1]!);
      if (ina) out.push(a);
      if (ina !== inb) {
        const t = (at - a[1]!) / (b[1]! - a[1]!);
        out.push([a[0]! + t * (b[0]! - a[0]!), at, a[2]! + t * (b[2]! - a[2]!)]);
      }
    }
    poly = out;
  };
  clip((y) => y >= lo, lo);
  if (poly.length) clip((y) => y <= hi, hi);
  const xz: number[] = [];
  for (const p of poly) xz.push(p[0]!, p[2]!);
  return xz;
}

/** The nearest point of a convex footprint (x, z pairs) to (x, z), and whether (x, z) is inside it. */
function nearest(xz: number[], x: number, z: number): { x: number; z: number; d: number; inside: boolean } {
  const n = xz.length / 2;
  let best = { x: xz[0]!, z: xz[1]!, d: Math.hypot(x - xz[0]!, z - xz[1]!) };
  let left = false, right = false, area = 0;
  for (let i = 0; i < n; i++) {
    const ax = xz[i * 2]!, az = xz[i * 2 + 1]!, bx = xz[((i + 1) % n) * 2]!, bz = xz[((i + 1) % n) * 2 + 1]!;
    const ex = bx - ax, ez = bz - az, len = ex * ex + ez * ez;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len)) : 0;
    const px = ax + t * ex, pz = az + t * ez, d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { x: px, z: pz, d };
    const cross = ex * (z - az) - ez * (x - ax);
    if (cross > 1e-9) left = true; else if (cross < -1e-9) right = true;
    area += ax * bz - bx * az;
  }
  return { ...best, inside: Math.abs(area) > 1e-6 && !(left && right) };
}

/**
 * The mover. `advance` is what the page calls each frame; `tick` is one 60 Hz step; `place` stands it on the floor
 * under a point. The page reads `eye` for the camera and writes `state.yaw` / `state.pitch` from the look.
 */
export class Walker {
  readonly state: WalkState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, stickForward: 0, stickRight: 0 };
  private stance_: Stance = 'stand';
  /** Off the ground, falling (`fall`). */
  private inAir = false;
  /** The last landing, null in the air or before the first fall. */
  private landing_: Landing | null = null;
  /** Seconds since the feet left the floor, while airborne. */
  private airTime = 0;
  /** `FUN_005858a0`'s direction class, kept for its hysteresis. */
  private cls: MoveClass = -1;
  /** The body in use: the stance, but `stand` while a crouch runs at full stick. */
  private posture_: Stance = 'stand';
  /** The action holding the mover (`MoverAction`), or null. */
  private action_: MoverAction | null = null;
  private serial = 0;
  /** `actor+0x135c`: seconds before the next jump may start. */
  private jumpLock = 0;
  /** `actor+0x1360`: seconds before the running jump's impulse; 0 when none is pending. */
  private jumpDelay = 0;
  /** In a running jump (`actor+0x1061` bit 1): the fall runs from the impulse, not from a walk-off. */
  private jumping = false;
  /** The velocity carried through the air and a landing clip (`actor+0x1350` / `+0x1358`), world x and z. */
  private carried: [number, number] = [0, 0];
  /** The floor's normal y under the feet (`actor+0x1348`), for the jump's slope test. */
  private floorNormalY = 1;
  /** The ground state as it last ran (`GroundMotion`). */
  private ground_: GroundMotion = { state: 'idle', forward: 0, right: 0, cls: -1 };
  /** The ground state the feet left the floor in: the play the launch or the fall was pushed over (`land`). */
  private groundBefore: GroundMotion = { state: 'idle', forward: 0, right: 0, cls: -1 };

  /** The stance (`actor+0x174`): which ground state runs and which bands it reads (`STANCE`). */
  get stance(): Stance {
    return this.stance_;
  }

  /** Sets the stance at once, with no transition clip (placing the mover, a new map): `changeStance` is the game's. */
  set stance(stance: Stance) {
    this.stance_ = stance;
    this.posture_ = stance;
  }

  /**
   * The game's stance change (`FUN_005817d0` to crouch, `FUN_00581c10` to stand, `FUN_00581540` to prone; decomp
   * 442170-442660): the stance is the new one at once, and on the floor a transition clip holds the mover while it
   * plays -- unless the SEAL is moving over `STANCE_MOVING` between stand and crouch, which runs straight on. In the air
   * the stance simply changes.
   */
  changeStance(stance: Stance): void {
    const from = this.stance_;
    if (stance === from) return;
    this.stance = stance;
    if (this.inAir || (this.action_ && this.action_.name !== 'fall')) return;
    const moving = Math.hypot(this.state.vx, this.state.vz) > STANCE_MOVING;
    const pair = (a: Stance, b: Stance): boolean => (from === a && stance === b) || (from === b && stance === a);
    let name: MoverActionName;
    if (pair('stand', 'crouch')) { if (moving) return; name = 'standToCrouch'; }
    else if (pair('crouch', 'prone')) name = 'crouchToProne';
    else name = 'standToProne';
    const reversed = stance !== 'prone' && !(from === 'stand' && stance === 'crouch');
    this.start(name, ACTION_SECONDS[name], reversed);
    this.state.vx = 0; this.state.vz = 0;
  }

  /** The action holding the mover (`MoverAction`), or null. */
  get action(): MoverAction | null {
    return this.action_;
  }

  /** The upper-body overlay playing over the locomotion (the moving swap), or null. */
  get overlay(): MoverOverlay | null {
    return this.overlay_;
  }
  private overlay_: MoverOverlay | null = null;

  /**
   * The rifle <-> pistol swap's clip (`FUN_005a64c0`, decomp 461850-462030; the WEAPON workstream owns the item and
   * calls `Animator.setWeapon` at its hand-off): prone `Prone rifle -> Pistol`; crouched or standing, at 20 a second
   * or under (`|v|^2 <= 400`) `Crouch rifle -> Pistol` / `Rifle -> Pistol` as an action holding the mover, faster
   * `Moving rifle -> Pistol` over the locomotion. To the rifle each plays backwards (`FUN_00588bc0`'s fourth
   * argument 1, `FUN_0028c160`) [reading for the moving one, pushed forward both ways]. Refused in the air and while
   * an action plays [reading: the caller's gate is not read]. Null when refused.
   */
  swapWeapon(to: 'pistol' | 'rifle'): SwapPick | null {
    if (this.inAir || this.action_) return null;
    const reversed = to === 'rifle';
    const s = this.state;
    const still = s.vx * s.vx + s.vz * s.vz + s.vy * s.vy <= 400;
    if (this.stance_ === 'prone' || still) {
      const action = this.stance_ === 'prone' ? 'swapProne' : this.stance_ === 'crouch' ? 'swapCrouch' : 'swapStand';
      this.start(action, ACTION_SECONDS[action], reversed);
      s.vx = 0; s.vz = 0;
      return { action, overlay: false, reversed, seconds: ACTION_SECONDS[action] };
    }
    const seconds = oneShotSeconds(SWAP_OVERLAY.playback, SWAP_OVERLAY.frames);
    this.overlay_ = { clip: SEAL_ANIMS.swapMoving, serial: ++this.serial, t: 0, seconds, reversed };
    return { action: null, overlay: true, reversed, seconds };
  }

  /**
   * WEAPON: the swap clip playing -- the standing, crouched or prone action, or the moving overlay (a standing swap cut
   * by the stick goes on as the overlay at the phase it reached) -- and its progress; null when none is (it ended, or
   * another action took the mover).
   */
  swapProgress(): SwapProgress | null {
    const a = this.action_;
    if (a && (a.name === 'swapStand' || a.name === 'swapCrouch' || a.name === 'swapProne') && a.seconds) {
      return { action: a.name, overlay: false, progress: Math.min(1, a.t / a.seconds) };
    }
    const o = this.overlay_;
    if (o && o.clip === SEAL_ANIMS.swapMoving && o.seconds > 0) return { action: null, overlay: true, progress: Math.min(1, o.t / o.seconds) };
    return null;
  }

  /** The ground state as it last ran (`GroundMotion`). */
  get ground(): GroundMotion {
    return this.ground_;
  }

  private start(name: MoverActionName, seconds: number | null, reversed = false): void {
    this.action_ = { name, serial: ++this.serial, t: 0, seconds, reversed };
  }

  /** The random draw `FUN_005af590` makes between its two hit clips (`FUN_00197740`), [0, 1): `Math.random` unless set. */
  random: () => number = Math.random;

  /**
   * `FUN_00587c20` (decomp 445514-445576) with `FUN_00550ef0`'s stick test (418180-418190): whether the action on the
   * mover gives way to the stick this tick -- its phase (`t / (playback x (n - 1) / n)`) past its `NoInterrupt` and a
   * move axis past `INTERRUPT_STICK`. The launch and the fall never do: they end on the floor.
   */
  private interrupted(forward: number, right: number): boolean {
    const a = this.action_;
    if (!a || a.name === 'launch' || a.name === 'fall') return false;
    const c = ACTION_CLIPS[a.name];
    const phase = a.t / (c.playback * ((c.frames - 1) / c.frames));
    // FUN_00550ef0 418183: action 0x35 (`Rifle -> Pistol`) takes the stick test whatever FUN_00587c20 answers.
    if (!(phase > c.noInterrupt) && a.name !== 'swapStand') return false;
    // FUN_00550ef0 418183-418186: the move axes (actor+0x240, +0x244) and the turn axis (actor+0x23c, the turn over
    // turn_maxrate), any past 0.1.
    return Math.abs(forward) > INTERRUPT_STICK || Math.abs(right) > INTERRUPT_STICK
      || Math.abs(this.turn / SEAL_TUNING.turnMaxRate) > INTERRUPT_STICK;
  }

  /**
   * The actor's turn, radians a second, left positive (`actor+0x48`; `WalkMode` sets it from the look each frame): the
   * turn axis `actor+0x23c` is this over `turn_maxrate`, and past 0.1 it cuts an interruptible action as the move
   * stick does (`FUN_00550ef0`).
   */
  turn = 0;

  /**
   * The action clips' root travel per key, x and z in the model's frame, by clip name (`WalkMode.setActionRoots`, from
   * the pack the page loads): what `FUN_0028c250` reads the velocity off. Without them each clip's mean
   * (`ACTION_CLIPS[..].travel`) stands in.
   */
  actionRoots: ReadonlyMap<string, Float32Array> | null = null;

  /**
   * `FUN_0028c250` through `FUN_00289bb0` (decomp 134145-134183, 132691-132756) for an action on the mover: the root's
   * change from the key the phase is on to the next (the last key paired with the one before), times the keys over
   * `playback` -- units a second in the model's frame, (x right, z behind) -- backwards for a transition played
   * backwards. The phase is the one-shot's `t / (playback (n - 1) / n)`, from its end when backwards.
   */
  actionVelocity(name: keyof typeof ACTION_CLIPS, t: number, reversed: boolean): [number, number] {
    const c = ACTION_CLIPS[name], n = c.frames, end = (n - 1) / n;
    const keys = this.actionRoots?.get(SEAL_ANIMS[name]);
    if (!keys || keys.length < 2 * n) {
      const v = (reversed ? -1 : 1) / ACTION_SECONDS[name];
      return [c.travel[0] * v, c.travel[1] * v];
    }
    const run = t / (c.playback * end);
    const phase = Math.min(end, Math.max(0, reversed ? end - run : run));
    let a = Math.min(n - 1, Math.floor(phase * n + 1e-9)), b = a + 1;
    if (b >= n) { b = n - 1; a = Math.max(0, n - 2); }
    const k = ((reversed ? -1 : 1) * n) / c.playback;
    return [(keys[2 * b]! - keys[2 * a]!) * k, (keys[2 * b + 1]! - keys[2 * a + 1]!) * k];
  }

  /** The body in use (`STANCE[posture]` gives its root and column): `stand` while a crouch runs at full stick. */
  get posture(): Stance {
    return this.posture_;
  }
  /** The feet before the last tick, for drawing the eye between ticks. */
  private prev = { x: 0, y: 0, z: 0 };
  /** Real time not yet stepped, in seconds, under one tick. */
  private accumulator = 0;
  private readonly wallsByCell = new Map<number, Wall[]>();
  /** The walls of the 3 x 3 cells around the mover's cell, kept until it changes cell. */
  private near: { cell: number; walls: Wall[] } | null = null;

  constructor(readonly grid: Grid) {}

  /**
   * TRAVERSAL SEAM (web research 86, `./traversal`): a move that owns the tick while it runs -- the ladder, the
   * climb. Its `tick` runs first each tick and returns true when it moved the mover itself; false lets the walk run.
   */
  driver: TickDriver | null = null;

  /**
   * TRAVERSAL SEAM: moves the mover across the ground by (dx, dz) as a tick's step does -- the walls, the floors, a step
   * down, an edge's fall -- for a move that carries it (the dive).
   */
  glide(dx: number, dz: number): void {
    this.move(dx, dz);
  }

  /**
   * TRAVERSAL SEAM: puts the mover on the floor where it is (`on` false: `vy` zeroed, no landing recorded) or in the
   * air at `vy` (the `Jump fall` action) -- a climb takes it (a jump-grab ends the jump), a climb's end or a hang's
   * let-go hands it back. Either way the jump, the action and the carried velocity are dropped.
   */
  setAirborne(on: boolean, vy = 0): void {
    this.action_ = null;
    this.jumping = false; this.jumpDelay = 0;
    if (on) {
      this.takeOff();
      this.state.vy = vy;
      this.start('fall', null);                                  // FUN_0057e050: `Jump fall`
      return;
    }
    this.inAir = false;
    this.state.vy = 0;
    this.carried = [0, 0];
  }

  /**
   * Stands the mover on the floor under (x, fromY, z): the probe's highest floor at or under `fromY` + 1, else
   * the lowest within 20 over `fromY` - 5 -- the selection with the origin at `fromY`. Pass the camera's eye to
   * drop from where the camera is. False, and nothing moves, when there is no floor there.
   */
  place(x: number, fromY: number, z: number): boolean {
    const floor = selectFloor(probeGround(this.grid, x, z), fromY, fromY - PROBE_LIFT);
    if (!floor) return false;
    Object.assign(this.state, { x, y: floor.y, z, vx: 0, vz: 0, vy: 0, stickForward: 0, stickRight: 0 });
    this.prev = { x, y: floor.y, z };
    this.accumulator = 0;
    this.inAir = false;
    this.landing_ = null;
    this.action_ = null;
    this.overlay_ = null;
    this.jumpLock = 0; this.jumpDelay = 0; this.jumping = false; this.carried = [0, 0];
    this.floorNormalY = floor.normal[1];
    this.ground_ = { state: 'idle', forward: 0, right: 0, cls: -1 };
    return true;
  }

  /** Whether the mover is falling. */
  get airborne(): boolean {
    return this.inAir;
  }

  /** The last landing since the feet last left the floor, or null: in the air, or not yet fallen since `place`. */
  get landing(): Landing | null {
    return this.landing_;
  }

  /**
   * The jump (`FUN_0057e1b0`, decomp 440776-440867, the header): refused in the air (`actor+0x105e` bit 5), within
   * `JUMP_LOCK` of a take-off or a landing (`actor+0x135c`), off walkable ground (`actor+0x1348` under cos
   * `max_slope`), prone (`FUN_005b4340(actor, 0xb)`: stance 2 -- its other refusals, the knock-downs `Fall forward` /
   * `backwards`, the death landings, `180`, `dive_to_prone`, the hang and ladder states, are not the walk's), and
   * **unless the action on top plays a looped motion** (`FUN_005551a0(entry+0x28, 0x40)`: the entry's bit 0x40 is its
   * motion's looped bit, `FUN_0028dc90` from `+0x49` bit 6). `FUN_00550ef0` takes the press whatever plays
   * (`ctrl+0x170` bit 2, set with it by `FUN_00592d50`), so a press during a one-shot -- the jump, the launch, the
   * fall, a landing, a transition, a hit, the get-up -- is spent and refused; the idles, the locomotion and the turn
   * steps are all looped. At `RUNNING_JUMP_SPEED` or more the running jump -- off the floor with the velocity carried,
   * the impulse `JUMP_DELAY` later; under it the standing jump -- the `Jump` action on the floor. True when a jump
   * started.
   */
  jump(): boolean {
    if (this.inAir || this.jumpLock > 1e-9 || this.stance_ === 'prone') return false;
    if (this.action_) return false;                              // every action the walk plays is a one-shot
    if (this.floorNormalY < MAX_SLOPE_COS) return false;
    const s = this.state;
    if (s.vx * s.vx + s.vz * s.vz + s.vy * s.vy >= RUNNING_JUMP_SPEED * RUNNING_JUMP_SPEED) {
      this.takeOff();
      this.jumping = true;
      this.jumpDelay = JUMP_DELAY;
      this.jumpLock = JUMP_LOCK;
      this.start('launch', ACTION_SECONDS.launch);             // its clip's 2.21 s, or the landing: whichever first
    } else {
      this.start('jump', ACTION_SECONDS.jump);
    }
    return true;
  }

  /** Leaves the floor: the velocity across it carried (`actor+0x1350 = +0x38`), the fall from 0. */
  private takeOff(): void {
    this.groundBefore = this.ground_;
    this.inAir = true;
    this.landing_ = null;
    this.airTime = 0;
    this.state.vy = 0;
    this.carried = [this.state.vx, this.state.vz];
  }

  /** Feeds `seconds` of real time in and runs the whole ticks it makes, `afterTick` after each; returns how many ran. */
  advance(seconds: number, input: WalkInput, afterTick?: () => void, beforeTick?: () => WalkInput): number {
    this.accumulator += Math.max(0, seconds);
    let ticks = 0;
    while (this.accumulator >= TICK - 1e-9 && ticks < MAX_TICKS) {
      // MULTIPLAYER (web sprint 3, W3.R8): a command stream sets each tick's look, buttons and stick before it runs.
      this.tick(beforeTick ? beforeTick() : input);
      afterTick?.();
      this.accumulator -= TICK;
      ticks++;
    }
    if (this.accumulator >= TICK) this.accumulator = 0;          // a backlog past MAX_TICKS is dropped, not run
    return ticks;
  }

  /** Drops the part-tick in hand, so the eye is exactly over the feet: after a run of ticks driven by hand. */
  settle(): void {
    this.prev = { x: this.state.x, y: this.state.y, z: this.state.z };
    this.accumulator = 0;
  }

  /** The eye, 15.4 over the feet, drawn between the last two ticks by the time left over in the accumulator. */
  eye(): [number, number, number] {
    const [x, y, z] = this.drawnFeet();
    return [x, y + EYE_HEIGHT, z];
  }

  /** How far the page's time is into the next tick, 0..1: what the view is drawn between the last two ticks by. */
  alpha(): number {
    return Math.max(0, Math.min(1, this.accumulator / TICK));
  }

  /** The feet between the last two ticks (`alpha`): where the body is drawn, so it moves with the drawn camera. */
  drawnFeet(): [number, number, number] {
    const s = this.state, t = this.alpha();
    return [this.prev.x + (s.x - this.prev.x) * t, this.prev.y + (s.y - this.prev.y) * t, this.prev.z + (s.z - this.prev.z) * t];
  }

  /**
   * One 60 Hz step. The jump lock and the action's clock run down first. Airborne: the fall (`fall`). Holding the
   * mover: a landing clip carries the landing's velocity down at `CARRY_DECAY`; a stance transition stands still; the
   * standing jump moves by the stick at the stance's top speeds (`FUN_0057a330`). Otherwise the ground state: the
   * stick through the throttle ramp (`throttleStep`), the velocity from the stance's bands (`locomotion`), then the
   * move in sub-steps, each sliding off the walls and standing on the floor. The boost of `GroundWish` is not read:
   * the walk has none (W2.R2; the owner's ruling of the motion workstream).
   */
  tick(input: WalkInput, dt: number = TICK): void {
    const s = this.state;
    this.prev = { x: s.x, y: s.y, z: s.z };
    if (this.driver?.tick(this, input, dt)) return;               // TRAVERSAL SEAM: a ladder or a climb has the tick
    this.jumpLock = Math.max(0, this.jumpLock - dt);
    const o = this.overlay_;
    if (o) { o.t += dt; if (o.t >= o.seconds - 1e-9) this.overlay_ = null; }
    const a = this.action_;
    if (a) {
      a.t += dt;
      if (a.seconds !== null && a.t >= a.seconds - 1e-9) {
        // PLACEHOLDER (the viewer has no death): the deadly fall's `Land forward` gets up (`Get up forward`). In the game
        // FUN_005af590 pushes `Land forward` in state 8 and the SEAL dies there (the vtable's +0x90, FUN_005a5da0): the
        // controller's FUN_005979a0 (454470-454495) spectates, or in a respawn game fades the body out (alpha 0 at 0.1 a
        // second, FUN_00552780) and FUN_00599b60 (455695) fades the new SEAL in at a spawn (1.0 at 4 a second). No
        // get-up follows a death; `Get up forward` is the game's own action, not one it plays after `Land forward`.
        if (a.name === 'landDeath') this.start('getUp', ACTION_SECONDS.getUp);
        else this.action_ = null;
      }
    }
    // The pad reader clamps each axis to +-1 and never puts the pair in the unit disc (`./moveStick`): a full
    // diagonal is (1, 1), which the standing blend takes as min(1, |stick|) and prone as one axis at 1.
    let forward = Math.max(-1, Math.min(1, input.forward)), right = Math.max(-1, Math.min(1, input.right));
    if (!this.inAir && this.driver?.stickScale) [forward, right] = this.driver.stickScale(this, forward, right);   // TRAVERSAL SEAM: slope, water
    if (this.inAir) { this.fall(dt, forward, right); return; }
    if (this.interrupted(forward, right)) {                     // FUN_00587c20: cut; the ground state takes over
      const cut = this.action_!;
      if (cut.name === 'landDeath') this.start('getUp', ACTION_SECONDS.getUp);
      else if (cut.name === 'swapStand') {
        // FUN_00550ef0 418226-418245: the standing swap cut by the stick goes on as `Moving rifle -> Pistol` over the
        // locomotion, at the phase it had reached.
        const seconds = oneShotSeconds(SWAP_OVERLAY.playback, SWAP_OVERLAY.frames);
        const phase = Math.min(1, cut.t / ACTION_SECONDS.swapStand);
        this.overlay_ = { clip: SEAL_ANIMS.swapMoving, serial: ++this.serial, t: phase * seconds, seconds, reversed: cut.reversed };
        this.action_ = null;
      } else this.action_ = null;
    }
    const held = this.action_?.name;
    if (held === 'hit' || held === 'hitStomach' || held === 'landDeath' || held === 'getUp'
      || held === 'standToCrouch' || held === 'crouchToProne' || held === 'standToProne'
      || held === 'swapStand' || held === 'swapCrouch' || held === 'swapProne') {
      // The clip's own root motion carries the mover (FUN_0028c250), key by key, along the facing -- backwards for a
      // transition played backwards (getting up). The ground state does not run (FUN_005870e0).
      s.stickForward = forward; s.stickRight = right;
      this.ground_ = { state: 'idle', forward: 0, right: 0, cls: -1 };
      const [tx, tz] = this.actionVelocity(held, this.action_!.t, this.action_!.reversed);
      const yaw = (s.yaw * Math.PI) / 180, c = Math.cos(yaw), sn = Math.sin(yaw);
      s.vx = tx * c + tz * sn;
      s.vz = -tx * sn + tz * c;
      this.move(s.vx * dt, s.vz * dt);
      return;
    }
    if (held === 'land' || held === 'landHard') {             // FUN_0054d9a0: the carried velocity, running down
      s.stickForward = forward; s.stickRight = right;          // FUN_0057a330: actor+0x248 = +0x244 each tick
      this.ground_ = { state: 'idle', forward: 0, right: 0, cls: -1 };
      const [cx, cz] = this.carried, c = Math.hypot(cx, cz), cut = CARRY_DECAY * dt;
      this.carried = c <= cut ? [0, 0] : [cx - (cx / c) * cut, cz - (cz / c) * cut];
      [s.vx, s.vz] = this.carried;
      this.move(s.vx * dt, s.vz * dt);
      return;
    }
    const v = held === 'jump' ? this.jumpControl(forward, right, dt) : this.locomote(forward, right, dt);
    const yaw = (s.yaw * Math.PI) / 180;
    // The camera looks down its own -z (`camera.ts`): forward is (-sin, -cos), right is (cos, -sin).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    s.vx = fx * v.forward + rx * v.right;
    s.vz = fz * v.forward + rz * v.right;
    this.move(s.vx * dt, s.vz * dt);
  }

  /**
   * The `Jump` action's stick (`FUN_0057a330` decomp 438955-438985): off rest, the ramp (`FUN_00586c10`) and then the
   * velocity straight from it -- the lateral axis times the side sets' top speed, the forward times the forward set's
   * or, backing up, the back set's (`FUN_0058bb50` / `FUN_0058bc00` by stance: `airBands`), no blend and no
   * renormalisation (`DAT_0064fc80` is 1 here). At rest, the clip's root motion: `seal_jump`'s root does not travel.
   */
  private jumpControl(forward: number, right: number, dt: number): { forward: number; right: number } {
    const s = this.state;
    this.ground_ = { state: 'idle', forward: 0, right: 0, cls: -1 };
    if (idle(forward, right)) { s.stickForward = forward; s.stickRight = right; return { forward: 0, right: 0 }; }
    s.stickForward = throttleStep(s.stickForward, forward, 'forward', dt);
    s.stickRight = throttleStep(s.stickRight, right, 'right', dt);
    const b = airBands(this.stance_ === 'crouch' ? 'crouch' : 'stand', null);
    return {
      forward: s.stickForward * (s.stickForward >= 0 ? b.forward : b.back),
      right: s.stickRight * (s.stickRight >= 0 ? b.right : b.left),
    };
  }

  /**
   * The ground state `FUN_005870e0` runs for the stance (the header's pseudo-code): the stick ramped or not, the
   * direction class, and the velocity (forward, right) in units a second. Sets `posture`.
   */
  private locomote(forward: number, right: number, dt: number): { forward: number; right: number } {
    const s = this.state;
    const still = { forward: 0, right: 0 };
    if (idle(forward, right)) {                                  // FUN_00586f00: at rest, the raw stick is kept
      s.stickForward = forward; s.stickRight = right;
      this.cls = -1;
      this.posture_ = this.stance;
      this.ground_ = { state: 'idle', forward: 0, right: 0, cls: -1 };
      return still;
    }
    if (this.stance === 'prone') {                               // FUN_005845c0 -> FUN_00583500: no ramp
      s.stickForward = forward; s.stickRight = right;
      this.cls = moveClass(right, forward, this.cls);
      this.posture_ = 'prone';
      this.ground_ = { state: 'prone', forward, right, cls: this.cls };
      const a = classAxis(this.cls, STANCE.prone.bands);
      const speed = (a.f !== 0 ? Math.abs(forward) : Math.abs(right)) * a.band;
      return { forward: a.f * speed, right: a.r * speed };
    }
    if (this.stance === 'crouch') {                              // FUN_00584c60
      this.cls = moveClass(right, forward, this.cls);
      const push = Math.hypot(forward, right);
      const run = push >= CROUCH_RUN && (STANCE[this.posture_].rootY >= 9 || this.headroom());
      if (!run) {
        const k = CROUCH_WALK / push;
        s.stickForward = throttleStep(s.stickForward, forward * k, 'forward', dt);
        s.stickRight = throttleStep(s.stickRight, right * k, 'right', dt);
        this.posture_ = 'crouch';
        this.ground_ = { state: 'crouch', forward: s.stickForward, right: s.stickRight, cls: this.cls };
        // FUN_00582d10: one set by the class at m, no blend; FUN_00583350's DAT_0064fc80 scales it all the same.
        const f = Math.abs(s.stickForward) <= FORWARD_DEAD ? 0 : s.stickForward;
        const len = Math.hypot(f, s.stickRight);
        if (len === 0) return still;
        const m = Math.min(1, len);
        const w = Math.min(1, Math.asin(Math.min(1, Math.abs(s.stickRight) / len)) * (2 / Math.PI));
        const a = classAxis(this.cls, STANCE.crouch.bands);
        const speed = (m * a.band) / Math.hypot(w, 1 - w);
        return { forward: a.f * speed, right: a.r * speed };
      }
      this.posture_ = 'stand';                                  // headroom: stands and runs the standing blend
    } else {
      this.posture_ = 'stand';
    }
    s.stickForward = throttleStep(s.stickForward, forward, 'forward', dt);
    s.stickRight = throttleStep(s.stickRight, right, 'right', dt);
    this.ground_ = { state: 'stand', forward: s.stickForward, right: s.stickRight, cls: this.cls };
    return locomotion(s.stickForward, s.stickRight, STANCE.stand.bands);   // FUN_00583030
  }

  /**
   * `FUN_0057efe0(actor, 0)`: clear when no collision polygon (bit 18 aside) crosses the vertical line over the feet
   * between `HEADROOM_FROM` and 19 over them.
   */
  private headroom(): boolean {
    const s = this.state;
    const lo = s.y + HEADROOM_FROM, hi = s.y + HEADROOM_TO;
    for (const atom of cellAt(this.grid, s.x, s.z).atoms) {
      if (atom.object.kind !== 'collision') continue;
      for (const poly of atom.object.polys) {
        if ((surfaceWord(poly) & SURFACE_SKIP) !== 0) continue;
        if (footprintDistance(poly.points, s.x, s.z) > 0) continue;
        const y = planeHeightAt(poly.points, s.x, s.z);
        if (y !== null && y > lo && y <= hi) return false;
      }
    }
    return true;
  }

  /** The horizontal move of a tick in sub-steps of at most `MAX_SUBSTEP`: on the ground, or in the air past an edge. */
  private move(dx: number, dz: number): void {
    const distance = Math.hypot(dx, dz);
    if (distance === 0) return;
    const parts = Math.ceil(distance / MAX_SUBSTEP);
    for (let i = 0; i < parts; i++) {
      if (this.inAir) this.airStep(dx / parts, dz / parts);
      else this.step(dx / parts, dz / parts);
    }
  }

  /**
   * One airborne tick. A running jump waits out `JUMP_DELAY` with the feet held on the floor [reading: the landing is
   * off while `actor+0x1360` runs, so the collision is what holds them], then takes `runningJumpSpeed` up
   * (`FUN_005af930`: `actor+0x133c = +0x1364`); from then on, as a walk-off, `FUN_0059b440`: gravity on `vy`, the
   * height by `vy`, the carried velocity across the ground and the walls, and the floor as the ground takes it
   * (`selectFloor`): feet under it are put on it -- a rise goes on, a fall is the landing, classed and given its clip
   * by `land` (web research 86 section 6.3: before 2026-09-29 only a floor under the feet as they were was looked at,
   * so a slope rising over a jump's feet was never met and the SEAL fell through it). The stick reads 0 in the air (`FUN_005af930`
   * zeroes `actor+0x240..0x244`).
   */
  private fall(dt: number, forward: number, right: number): void {
    const s = this.state;
    s.stickForward = 0; s.stickRight = 0;
    this.ground_ = { state: 'idle', forward: 0, right: 0, cls: -1 };
    // FUN_005af930 (466729-467019), the airborne branch: with neither action 8 (`Jump launch`) nor 9 (`Jump fall`)
    // current, FUN_0057e130 -> FUN_0057e050 pushes `Jump fall`. The launch is `NoInterrupt ()` and ends only with its
    // play (FUN_00582540 on FUN_0028c6e0's end, 2.21 s) or the landing's pop, so a flat running jump (0.75 s) lands in
    // the launch -- about its key 8 -- and `seal_runningjump_in_air` plays only on a walk-off or a flight outlasting
    // the launch [reading: the game pushes the fall the tick after the launch's pop; here the same tick].
    const held = this.action_?.name;
    if (held !== 'fall' && held !== 'launch') this.start('fall', null);                  // FUN_0057e050: `Jump fall`
    [s.vx, s.vz] = this.carried;
    this.airTime += dt;
    this.move(s.vx * dt, s.vz * dt);
    let windUp = false;
    if (this.jumpDelay > 0) {
      // FUN_005af930 then FUN_0059b440: through the wind-up the fall runs from 0 with the landing off (FUN_0059ad30
      // wants actor+0x1360 <= 0) -- the feet sink 0.98 in five ticks -- and on the tick the delay runs out the fall
      // speed becomes the impulse before this tick's step: 79.9 - g dt up, back over the floor at once.
      this.jumpDelay -= dt;
      if (this.jumpDelay > 1e-9) windUp = true;
      else { this.jumpDelay = 0; s.vy = runningJumpSpeed(); }
    }
    s.vy -= SEAL_TUNING.gravity * dt;
    const from = s.y;
    s.y += s.vy * dt;
    if (windUp) return;
    // The floor is FUN_005b5d40's pick, as on the ground: the highest at or under the probe's origin + 1 (the feet as
    // they were + 6), else the lowest while within 20 over the feet -- so a slope that rose over the feet is still
    // theirs. FUN_0059ad30 (456313-456322) puts the feet on it whenever they are under it, rising or not, and
    // FUN_0059b440's walk-off branch (456502-456512) zeroes the fall speed only when it is a fall: rising into the
    // ground the feet ride it and the rise goes on; falling, it is the landing (web research 86 section 6.3).
    const floor = selectFloor(probeGround(this.grid, s.x, s.z), from + PROBE_LIFT, s.y);
    if (floor && s.y <= floor.y) {
      s.y = floor.y;
      this.floorNormalY = floor.normal[1];
      if (s.vy <= 0) this.land(forward, right);
    }
  }

  /**
   * The landing (`FUN_005af930` -> `FUN_005af590`, decomp 466641-466728): the contact speed classed for the hook
   * (`./physics` `landingKind`); over `land_hard_fall_rate` the hard clip, else with the stick at rest or the last
   * airborne velocity (the fall included) under `LAND_STILL` the soft one, else none -- the stick taking the run on at
   * once (`actor+0x248 = +0x244`). No jump for `JUMP_LOCK` after (`actor+0x135c`).
   */
  private land(forward: number, right: number): void {
    const s = this.state;
    const speed = Math.max(0, -s.vy);
    const still = idle(forward, right) || Math.hypot(s.vx, s.vy, s.vz) <= LAND_STILL;
    let clip: Landing['clip'] = null;
    if (speed > JUMP_TABLE.land_hard_fall_rate) {
      // FUN_005af590 by FUN_005ac1f0's class: death `Land forward`, heavy one of the two hits, else `Jump land hard`.
      const cls = landingClass(speed);
      clip = cls === 3 ? 'landDeath' : cls === 2 ? (this.random() <= 0.5 ? 'hitStomach' : 'hit') : 'landHard';
    } else if (still) clip = 'land';
    this.landing_ = { kind: landingKind(speed, JUMP_TABLE), speed, airTime: this.airTime, clip, cls: landingClass(speed) };
    s.vy = 0;
    this.inAir = false;
    this.jumping = false;
    this.jumpLock = JUMP_LOCK;
    if (clip) this.start(clip, ACTION_SECONDS[clip]);
    else {
      // FUN_00589aa0 pops the launch or the fall, and FUN_0028da00 hands back the play it was pushed over -- the run
      // the SEAL left the floor in -- so the landing tick poses the locomotion, never a frame of the stand; the next
      // tick's ground state takes the stick on (FUN_005af930's no-clip branch, 0x248 = 0x244).
      this.action_ = null;
      this.ground_ = this.groundBefore;
      s.stickForward = forward; s.stickRight = right;
    }
  }

  /**
   * An airborne sub-step: the walls push, and a column with no floor within `step_height` over the feet is not
   * entered -- the step's own allowance, so a flight up a slope goes on over ground rising under it (the tick's
   * floor then lifts the feet onto it, `fall`), and the wind-up's sunk feet still move.
   */
  private airStep(dx: number, dz: number): void {
    const s = this.state;
    const [x, z] = this.slide(s.x + dx, s.z + dz, s.x, s.z);
    if (!probeGround(this.grid, x, z).some((h) => h.y <= s.y + SEAL_TUNING.stepHeight + 1e-9)) return;
    s.x = x; s.z = z;
  }

  /**
   * One sub-step on the ground: move, slide off the walls, then stand on the floor there -- `selectFloor` from the
   * origin y + 5 with the feet at y. A floor more than `step_height` over the feet is refused, as is a climb onto one
   * steeper than `max_slope`; one more than `ground_touch_distance` under them takes the step and leaves the mover in
   * the air. A refused step is tried again as its part along x and its part along z, so a mover pressed diagonally
   * against an edge runs along it rather than stopping dead; with no floor for either, it stays where it was.
   */
  private step(dx: number, dz: number): void {
    const s = this.state;
    for (const [ax, az] of [[dx, dz], [dx, 0], [0, dz]] as const) {
      if (ax === 0 && az === 0) continue;
      const [x, z] = this.slide(s.x + ax, s.z + az, s.x, s.z);
      const floor = selectFloor(probeGround(this.grid, x, z), s.y + PROBE_LIFT, s.y);
      if (!floor) continue;
      const rise = floor.y - s.y;
      if (rise > SEAL_TUNING.stepHeight) continue;
      if (rise > 0 && floor.normal[1] < MAX_SLOPE_COS) continue;
      s.x = x; s.z = z;
      if (rise < -SEAL_TUNING.groundTouchDistance) {
        this.takeOff();
        this.start('fall', null);                                // FUN_0057e050: `Jump fall`
      } else {
        s.y = floor.y;
        this.floorNormalY = floor.normal[1];
      }
      return;
    }
  }

  /**
   * Pushes (x, z) out of every wall the body's column meets until it is `BODY_RADIUS` from each, and takes the
   * velocity's part into a wall away (research 24 section 2 step 3). A mover already inside a wall's footprint is
   * pushed out to the side it came from.
   */
  private slide(x: number, z: number, fromX: number, fromZ: number): [number, number] {
    const s = this.state;
    const body = STANCE[this.posture_];
    const lo = s.y + body.bodyLow, hi = s.y + body.bodyHigh, r = BODY_RADIUS;
    const walls = this.wallsNear(x, z);
    for (let pass = 0; pass < WALL_PASSES; pass++) {
      let pushed = false;
      for (const w of walls) {
        if (w.maxY <= lo || w.minY >= hi) continue;
        if (x < w.minX - r || x > w.maxX + r || z < w.minZ - r || z > w.maxZ + r) continue;
        const band = bandFootprint(w.poly.points, lo, hi);
        if (band.length < 4) continue;
        const near = nearest(band, x, z);
        if (near.d >= r && !near.inside) continue;
        let ux: number, uz: number, push: number;
        if (near.d > 1e-9 && !near.inside) {
          ux = (x - near.x) / near.d; uz = (z - near.z) / near.d; push = r - near.d;
        } else {
          const side = (fromX - near.x) * w.nx + (fromZ - near.z) * w.nz;
          ux = side >= 0 ? w.nx : -w.nx; uz = side >= 0 ? w.nz : -w.nz;
          let far = 0;
          for (let i = 0; i < band.length; i += 2) far = Math.max(far, (band[i]! - x) * ux + (band[i + 1]! - z) * uz);
          push = far + r;
        }
        x += ux * push; z += uz * push;
        const into = s.vx * ux + s.vz * uz;
        if (into < 0) { s.vx -= into * ux; s.vz -= into * uz; }
        pushed = true;
      }
      if (!pushed) break;
    }
    return [x, z];
  }

  /** The wall polygons of the mover's cell and its eight neighbours (`ringCells`' square ring 1), each once. */
  private wallsNear(x: number, z: number): Wall[] {
    const cell = cellAt(this.grid, x, z).index;
    if (this.near?.cell === cell) return this.near.walls;
    const seen = new Set<WorldPoly>();
    const walls: Wall[] = [];
    for (const { cell: c } of ringCells(this.grid, x, z, 1, 'square')) {
      for (const w of this.wallsOf(c.index)) {
        if (seen.has(w.poly)) continue;
        seen.add(w.poly);
        walls.push(w);
      }
    }
    this.near = { cell, walls };
    return walls;
  }

  private wallsOf(index: number): Wall[] {
    const known = this.wallsByCell.get(index);
    if (known) return known;
    const walls: Wall[] = [];
    for (const atom of this.grid.cells[index]!.atoms) {
      if (atom.object.kind !== 'collision') continue;
      for (const poly of atom.object.polys) {
        if (!isWallSurface(poly)) continue;
        const w = wallOf(poly);
        if (w) walls.push(w);
      }
    }
    this.wallsByCell.set(index, walls);
    return walls;
  }
}

/**
 * The root keys of the clips the mover plays as actions (`./walk` `ACTION_CLIPS`: the hits, the death landing, the
 * get-up, the transitions), x and z a key in the model's frame: what the mover's per-key root motion reads
 * (`Walker.actionVelocity`, `FUN_0028c250`).
 */
export function actionRoots(clips: readonly MotionClip[]): Map<string, Float32Array> {
  const wanted = new Set<string>(Object.keys(ACTION_CLIPS).map((k) => SEAL_ANIMS[k as keyof typeof ACTION_CLIPS]));
  const out = new Map<string, Float32Array>();
  for (const c of clips) {
    if (!wanted.has(c.name)) continue;
    const root = c.parts.find((p) => p.name === 'skel_root');
    if (!root || root.translations.length < 3 * c.frameCount) continue;
    const keys = new Float32Array(2 * c.frameCount);
    for (let i = 0; i < c.frameCount; i++) { keys[2 * i] = root.translations[3 * i]!; keys[2 * i + 1] = root.translations[3 * i + 2]!; }
    out.set(c.name, keys);
  }
  return out;
}

/**
 * The mover as the body and its clips read it (`PlaySnapshot`): what `WalkMode.snapshot` hands the page's animator and
 * what the multiplayer server sends of every other player (web sprint 3, `./net/body`) -- one function for both.
 */
export function moverSnapshot(w: Walker, moves: TraversalHooks | null, jumps: number, turnRate: number): PlaySnapshot {
  const s = w.state;
  return {
    feet: w.drawnFeet(), yaw: s.yaw, pitch: s.pitch, vx: s.vx, vz: s.vz, vy: s.vy,
    airborne: w.airborne, crouched: w.posture === 'crouch', stance: w.posture,
    landing: w.landing?.kind ?? null, jumps,
    ground: { ...w.ground }, action: w.action && { ...w.action }, turnRate,
    traversal: moves?.pose() ?? null, peek: moves?.peeking() ?? 0,
    overlay: w.overlay && { ...w.overlay },
  };
}
