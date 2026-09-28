import {
  buildGrid, cellAt, footprintDistance, isWallSurface, planeHeightAt, probeGround, ringCells, selectFloor, surfaceWord, upNormal,
  PROBE_LIFT, SEAL_LOCOMOTION, SEAL_TUNING, SURFACE_SKIP,
  type CollisionOwner, type Grid, type GridParams, type Hit, type WorldPoly,
} from '@s2u/scene';
import type { GroundWish, Pose } from './camera';
import { firstPersonHeight, pitchLimits, PlayerCamera, INIT_AIM_PITCH, type Vec3 } from './playerCamera';
import { jumpImpulse, landingKind, sealTuning, type LandingKind } from './physics';
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
 *   `actor+0x240` (forward, `MoveLong`), and `FUN_005870e0` (decomp 445164-445169) runs the ground state by the
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
 * - **Stances.** `C` cycles stand, crouch, prone (the game's d-pad; nothing on Ctrl -- `camera.ts` says why); each
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
 *   mover's and drawn between ticks. `V` switches to first person at the head (`firstPersonHeight`). The mouse turns
 *   the body's yaw and the camera's pitch (`camera.ts`). Sprint 1's first-person eye 15.4 (`EYE_HEIGHT`, W1.R2) is
 *   retired as a view; it stays the height a pose drops the mover from.
 * - **The jump.** The game's jump is a clip (`seal_jump`, `seal_runningjump_launch` in `motion.rdr`) whose rise is
 *   root motion, not a formula of `jump_factor` -- `jump_factor x gravity x -0.4` (`FUN_0057e1b0`, `FUN_005880e0`)
 *   seeds `actor+0x1364`, the landing-speed record the fall damage reads (`FUN_005ac1f0`), not a launch speed. Until
 *   the clip's root drives it, `Walker.jump` is the cloud sprint's named placeholder (`./physics` `jumpImpulse`): the
 *   impulse that reaches `min_jump_height` under the table's gravity. Landings are classed by the contact speed
 *   against `land_fall_rate` / `land_hard_fall_rate` (`./physics` `landingKind`) for the landing clips.
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

/** The SEAL's three stances, in the order `C` cycles them (`zSeal/zseal.h`'s `SEAL_STANCE`). */
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
    fields.set([p.ptcount, p.ditype, p.material, p.cameratype, p.region >>> 0, p.appflags ?? 0], i * GROUND_FIELDS);
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
      region: ground.fields[f + 4]!, appflags: ground.fields[f + 5]!, points: ground.points.subarray(at, at + ptcount * 3),
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
export interface Landing { kind: LandingKind; speed: number; airTime: number }

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
  /** TRAVERSAL SEAM: the traversal move's clip, or null (`./animator` `MoverSnapshot.traversal`). */
  traversal?: TraversalPose | null;
}

/** The table's jump and landing fields (`./physics`, the cloud sprint's reader): the placeholder jump, the landings. */
const JUMP_TABLE = sealTuning(null);

/** TRAVERSAL SEAM: what `Walker.driver` is (`./traversal`'s `Traversal`). */
export interface TickDriver {
  tick(walker: Walker, input: WalkInput, dt: number): boolean;
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
  action(): void;
  lean(side: -1 | 0 | 1): void;
  reset(walker?: Walker): void;
}

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

  /** The stance (`actor+0x174`): which ground state runs and which bands it reads (`STANCE`). */
  get stance(): Stance {
    return this.stance_;
  }

  set stance(stance: Stance) {
    this.stance_ = stance;
    this.posture_ = stance;
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
   * TRAVERSAL SEAM: puts the mover on the floor where it is (`on` false: `vy` zeroed, no landing recorded) or in the
   * air at `vy` -- a ladder's slide and a climb's end hand the mover back through it.
   */
  setAirborne(on: boolean, vy = 0): void {
    if (on) { this.takeOff(vy); return; }
    this.inAir = false;
    this.state.vy = 0;
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
   * The jump (PLACEHOLDER, see the header): from the floor, the feet leave it at `jumpImpulse` upward keeping the
   * run's velocity across the ground; a crouched or prone mover stands to jump. False, and nothing changes, in the air.
   */
  jump(): boolean {
    if (this.inAir) return false;
    if (this.stance_ !== 'stand') this.stance = 'stand';
    this.takeOff(jumpImpulse(JUMP_TABLE));
    return true;
  }

  private takeOff(vy: number): void {
    this.inAir = true;
    this.landing_ = null;
    this.airTime = 0;
    this.state.vy = vy;
  }

  /** Feeds `seconds` of real time in and runs the whole ticks it makes, `afterTick` after each; returns how many ran. */
  advance(seconds: number, input: WalkInput, afterTick?: () => void): number {
    this.accumulator += Math.max(0, seconds);
    let ticks = 0;
    while (this.accumulator >= TICK - 1e-9 && ticks < MAX_TICKS) {
      this.tick(input);
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
   * One 60 Hz step. On the ground: the stick through the throttle ramp (`throttleStep`), the velocity from the
   * stance's bands (`locomotion`), then the move in sub-steps, each sliding off the walls and standing on the floor.
   * Airborne: the fall (`fall`). The boost of `GroundWish` is not read: the ground has none (W2.R2).
   */
  tick(input: WalkInput, dt: number = TICK): void {
    const s = this.state;
    this.prev = { x: s.x, y: s.y, z: s.z };
    if (this.driver?.tick(this, input, dt)) return;               // TRAVERSAL SEAM: a ladder or a climb has the tick
    if (this.inAir) { this.fall(dt); return; }
    let forward = input.forward, right = input.right;
    const length = Math.hypot(forward, right);
    if (length > 1) { forward /= length; right /= length; }
    const v = this.locomote(forward, right, dt);
    const yaw = (s.yaw * Math.PI) / 180;
    // The camera looks down its own -z (`camera.ts`): forward is (-sin, -cos), right is (cos, -sin).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    s.vx = fx * v.forward + rx * v.right;
    s.vz = fz * v.forward + rz * v.right;
    this.move(s.vx * dt, s.vz * dt);
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
      return still;
    }
    if (this.stance === 'prone') {                               // FUN_005845c0 -> FUN_00583500: no ramp
      s.stickForward = forward; s.stickRight = right;
      this.cls = moveClass(right, forward, this.cls);
      this.posture_ = 'prone';
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
   * One airborne tick: gravity on `vy`, the horizontal velocity carried as it left the ground, the walls, and the
   * landing on the highest floor at or under the feet as they were -- the feet on it, `vy` zero, the run on.
   */
  private fall(dt: number): void {
    const s = this.state;
    s.vy -= SEAL_TUNING.gravity * dt;
    this.airTime += dt;
    this.move(s.vx * dt, s.vz * dt);
    const from = s.y;
    s.y += s.vy * dt;
    let floor: Hit | null = null;
    for (const h of probeGround(this.grid, s.x, s.z)) if (h.y <= from + 1e-9 && (floor === null || h.y > floor.y)) floor = h;
    if (floor && s.vy <= 0 && s.y <= floor.y) {
      const speed = Math.max(0, -s.vy);
      this.landing_ = { kind: landingKind(speed, JUMP_TABLE), speed, airTime: this.airTime };
      s.y = floor.y;
      s.vy = 0;
      this.inAir = false;
    }
  }

  /** An airborne sub-step: the walls push, and a column with no floor under the feet at all is not entered. */
  private airStep(dx: number, dz: number): void {
    const s = this.state;
    const [x, z] = this.slide(s.x + dx, s.z + dz, s.x, s.z);
    if (!probeGround(this.grid, x, z).some((h) => h.y <= s.y + 1e-9)) return;
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
        this.takeOff(0);
      } else {
        s.y = floor.y;
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

/** The half of `FlyCamera` walk mode drives: the look it reads, the view it places, the wish it steps by. */
export interface WalkCamera {
  pose(): Pose;
  setPose(pose: Partial<Pose>): void;
  moveTo(x: number, y: number, z: number): void;
  setWalking(on: boolean): void;
  setPitchLimits(minDegrees: number, maxDegrees: number): void;
  placeView(eye: readonly [number, number, number], target: readonly [number, number, number] | null): void;
  groundWish(): GroundWish;
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

  /** Sets the stance, walking or not; false, and nothing changes, for a name that is not one. */
  setStance(stance: Stance): boolean {
    if (!STANCES.includes(stance)) return false;
    this.stance_ = stance;
    if (this.walker) this.walker.stance = stance;
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
    if (!this.walking || !w || !w.jump()) return false;
    this.stance_ = w.stance;
    this.jumps++;
    return true;
  }

  /** Walk mode: crouches (true), stands (false) or toggles stand and crouch (no argument); crouched after. */
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
    const s = w.state;
    return {
      feet: w.drawnFeet(), yaw: s.yaw, pitch: s.pitch, vx: s.vx, vz: s.vz, vy: s.vy,
      airborne: w.airborne, crouched: w.posture === 'crouch', stance: w.posture,
      landing: w.landing?.kind ?? null, jumps: this.jumps, traversal: this.moves?.pose() ?? null,
    };
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
    w.advance(dt, this.camera.groundWish(), () => this.cameraTick());
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

  /** One camera tick on the mover's last tick. */
  private cameraTick(): void {
    const w = this.walker!;
    if (this.player) this.player.peek = this.moves?.peek() ?? 0;  // TRAVERSAL SEAM: the lean's peek, the move's root
    this.player?.tick([w.state.x, w.state.y, w.state.z], w.state.yaw, w.state.pitch, this.moves?.rootY() ?? rootY(w.posture));
  }

  /** A new camera on the mover where it now stands (entering walk, a pose from the hook, a new map). */
  private restart(): void {
    const w = this.walker!;
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
    const eye: Vec3 = [x, y + firstPersonHeight(w.posture), z];
    const look = this.camera.pose(), yaw = (look.yaw * Math.PI) / 180, pitch = (look.pitch * Math.PI) / 180;
    const ahead: Vec3 = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const far: Vec3 = [eye[0] + ahead[0] * 1000, eye[1] + ahead[1] * 1000, eye[2] + ahead[2] * 1000];
    this.placed = { eye, target: [eye[0] + ahead[0], eye[1] + ahead[1], eye[2] + ahead[2]], far };
    this.camera.placeView(eye, null);
  }
}
