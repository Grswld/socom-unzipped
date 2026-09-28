import {
  buildGrid, cellAt, isWallSurface, probeGround, ringCells, selectFloor, upNormal, PROBE_LIFT, SELECT_ABOVE,
  type CollisionOwner, type Grid, type GridParams, type Hit, type WorldPoly,
} from '@s2u/scene';
import { ACCEL, BRAKE, glide, type GroundWish, type Pose } from './camera';
import {
  alongSurfaceVy, contactSpeed, contactTime, fall, jumpImpulse, landingKind, sealTuning, slideAcceleration, standable,
  CROUCH_EYE_PLACEHOLDER, CROUCH_SPEED_PLACEHOLDER, SEAL_TUNING_DEFAULTS, type LandingKind, type SealTuning,
} from './physics';

/**
 * Walk mode (web sprint 1, W1.4; the seal table's physics, web sprint 2, W2.3a): a mover that stands on the floor
 * the engine's probe finds, slides along the walls research 24 names, falls, steps, slides off steep floors, crouches
 * and jumps by the seal tuning table (`./physics`: research 17 section 8's values, or the disc's `dynamics.rdr` read
 * at run time over them), and looks from the SEAL's eye height. Every rule below reads the mover's own table.
 *
 * - **The tick.** `CGame::Tick` (`FUN_001E7040`) runs the game at 60 Hz (web/docs/research/71 section 1.5). The
 *   mover steps on that clock from a fixed-step accumulator the page feeds real time into, so it takes the same
 *   steps at 30 fps and at 240 fps; the eye is drawn between the last two steps (`eye`).
 * - **The motion.** On the floor, the fly camera's velocity model (`camera.ts`, `glide`: a ramp up at `ACCEL`, a
 *   glide down at `BRAKE`, in closed form), on the ground plane, at the SEAL's run of about 40 units a second
 *   (research 18, Finding 3: "sustained forward speed is better estimated at ~40 units/s").
 * - **The floor.** After each step `probeGround` at the new (x, z) and `selectFloor` from the origin y + 5.5 with
 *   the feet at y (research 23 section 1.1-1.2, research 24 section 2): the pick's "at or under the origin + 1" is
 *   `step_height` 6.5 over the feet. A floor more than 6.5 over them refuses the step (a wall, with a face or none),
 *   one within `ground_touch_distance` 8 under them holds them, and past that they leave the floor. No floor at all,
 *   and the step is refused: the hull's edge is never left.
 * - **The fall.** Off the floor, gravity 235 in closed form (`fall`), no control in the air -- the reading; the
 *   feet meet the floor the probe picks under them on the way down, and the landing is classed by its vertical
 *   speed against `land_fall_rate` 40 and `land_hard_fall_rate` 115 (`Landing`). Stepping off Frostfire's decks is a
 *   fall in the game (research 24 section 7.4); sprint 1 refused a drop over 20 (`MAX_DROP`), the conservative
 *   reading, and this replaces it.
 * - **The slope.** A floor whose normal's y is under `max_slope` (the cosine of 50 degrees) gives no footing: the
 *   mover slides down its tangent under gravity, the keys ignored (`slideAcceleration`, the reading).
 * - **The walls.** Research 24 section 2 step 3: a polygon with bit 1 set, bit 18 clear and `|n_y| < 0.7`, met by
 *   the body's column from y + 6.5 to y + 20 at radius 3.5 (W1.R2); the mover is pushed out along the wall until it
 *   is 3.5 from it, and keeps the part of its step that runs along it. The game's movement collision is not
 *   decompiled -- that walls stop the mover is research 24's inference from the 3c trails, which stand off wall
 *   planes at 4.4-5.8 (section 4.1).
 * - **The eye.** 15.4 over the feet (W1.R2): the console's look-at target, 15.38 over the actor at rest (research
 *   17 section 1); crouched, a named placeholder fraction of it. A first-person eye; the third-person camera's own
 *   offset and smoothing are not this.
 * - **The jump.** A named placeholder rule (`jumpImpulse`): the impulse that reaches the table's `min_jump_height`
 *   under its gravity, a placeholder height without the disc's; the impulse the game computes is not in the bodies
 *   on hand (W2.3b).
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
/**
 * The top of the body's column over the feet that a wall has to reach into (research 24 section 2 step 3: the
 * actor's bounds). Its foot is the table's `step_height` (6.5; research 24 took y + 6 from the selection's window), so
 * the face of a rise the step climbs is not a wall and the face of one it does not is (`Walker.slide`).
 *
 * The mover's probe origin rides `step_height` - 1 over its feet (`Walker.floorAt`), so the selection's "highest at
 * or under the origin + 1" (research 23 section 1.1 item 9) is the step's own y + 6.5. Research 24 took the lift as 5
 * (`PROBE_LIFT`, the spawn tests' and the stand's); the console's root node lifts it 5.50391 (research 17 section 1;
 * research 23 section 1.2 reads +5.5 on the console's image), which makes the window y + 6.504 -- the step to 0.004.
 */
export const BODY_HIGH = 20;
/** Units a second at a run (research 18, Finding 3). */
export const WALK_SPEED = 40;
/** The boost's multiple on the ground: the viewer's convenience for crossing a large map, not a game speed. */
export const BOOST = 2.5;
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
  /** Per polygon, `GROUND_FIELDS` words: ptcount, ditype, material, cameratype, region. */
  fields: Uint32Array;
}
const GROUND_FIELDS = 5;

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
    fields.set([p.ptcount, p.ditype, p.material, p.cameratype, p.region >>> 0], i * GROUND_FIELDS);
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
      region: ground.fields[f + 4]!, points: ground.points.subarray(at, at + ptcount * 3),
    });
    at += ptcount * 3;
  }
  return out;
}

/** The grid the probe walks, from what the worker sent: only the collision is linked, which is all it reads. */
export function groundGrid(ground: GroundData): Grid {
  return buildGrid(ground.grid, [], [], groundPolygons(ground), ground.owners);
}

/** The mover's state: feet position, look (degrees, as `Pose`), velocity on the ground plane, and upward. */
export interface WalkState {
  x: number; y: number; z: number; yaw: number; pitch: number;
  vx: number; vz: number;
  /** Upward, units a second: 0 on the floor, the flight's own in the air. */
  vy: number;
}

/**
 * The last landing (W2.3a): its class against the table's landing rates, the vertical speed at contact (units a
 * second, downward), and the seconds from leaving the floor to the contact -- exact, not rounded to the tick.
 */
export interface Landing { kind: LandingKind; speed: number; airTime: number }

/** What the hook reports of the mover (W2.3a): in the air, sliding, crouched, and the last landing. */
export interface MoverState { airborne: boolean; sliding: boolean; crouched: boolean; landing: Landing | null }

/**
 * The mover as the body and its clips read it each frame (W2.2b, `./animator`'s `MoverSnapshot` and where to stand):
 * the drawn feet, the look, the velocity, the stance, the last landing's class, and the jumps taken.
 */
export interface PlaySnapshot {
  feet: [number, number, number];
  yaw: number; pitch: number;
  vx: number; vz: number; vy: number;
  airborne: boolean; crouched: boolean;
  landing: LandingKind | null;
  jumps: number;
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
  readonly state: WalkState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0 };
  private airborne_ = false;
  private sliding_ = false;
  private crouched_ = false;
  /** The unit normal, turned up, of the floor under the feet: what a slide runs down and a take-off leaves along. */
  private floorNormal: readonly [number, number, number] = [0, 1, 0];
  private landing_: Landing | null = null;
  /** Seconds since the feet left the floor, while airborne. */
  private airTime = 0;
  /** The feet before the last tick, for drawing the eye between ticks. */
  private prev = { x: 0, y: 0, z: 0 };
  /** Real time not yet stepped, in seconds, under one tick. */
  private accumulator = 0;
  private readonly wallsByCell = new Map<number, Wall[]>();
  /** The walls of the 3 x 3 cells around the mover's cell, kept until it changes cell. */
  private near: { cell: number; walls: Wall[] } | null = null;

  /** The table the rules read (`./physics`): the defaults, or the disc's laid over them (`setTuning`). */
  private tuning_: Readonly<SealTuning>;

  constructor(readonly grid: Grid, tuning: Readonly<SealTuning> = SEAL_TUNING_DEFAULTS) {
    this.tuning_ = tuning;
  }

  get tuning(): Readonly<SealTuning> {
    return this.tuning_;
  }

  /** A new table for every rule from the next step on: the disc's, once the worker has read it. */
  setTuning(tuning: Readonly<SealTuning>): void {
    this.tuning_ = tuning;
  }

  /** In the air: off the floor and falling (or rising), steered by nothing (`tick`). reCOM's `m_airborne`. */
  get airborne(): boolean {
    return this.airborne_;
  }

  /**
   * On a floor too steep to stand on (its normal's y under `max_slope`): the feet have no footing, the keys do not
   * steer, and the mover slides down it (`tick`) until a floor holds it or the floor falls away.
   */
  get sliding(): boolean {
    return this.sliding_;
  }

  /**
   * The crouch stance: the eye at `CROUCH_EYE_PLACEHOLDER` of 15.4 and the walk at `CROUCH_SPEED_PLACEHOLDER` of its
   * run, both named placeholders (`./physics`). The change is at once; the stance's own motion is W2.2's.
   */
  get crouched(): boolean {
    return this.crouched_;
  }

  setCrouch(on: boolean): void {
    this.crouched_ = on;
  }

  /**
   * The jump: from footing (on the floor, not sliding) the feet leave it now at `jumpImpulse` upward, keeping
   * the run's velocity across the ground (no control in the air, `tick`). A crouched mover stands to jump -- the
   * reading: reCOM's SEAL has stand, crouch and in-air as separate states (`SEAL_STATE`, `zSeal/zseal.h:57-71`) and
   * the way from the crouch into the air is not in the bodies on hand. False, and nothing changes, without footing.
   */
  jump(): boolean {
    if (this.airborne_ || this.sliding_) return false;
    this.crouched_ = false;
    this.takeOff(jumpImpulse(this.tuning_));
    return true;
  }

  /** The last landing since the feet last left the floor, or null: in the air, or not yet fallen since `place`. */
  get landing(): Landing | null {
    return this.landing_;
  }

  /**
   * Stands the mover on the floor under (x, fromY, z): the probe's highest floor at or under `fromY` + 1, else
   * the lowest within 20 over `fromY` - 5 -- the selection with the origin at `fromY`. Pass the camera's eye to
   * drop from where the camera is. False, and nothing moves, when there is no floor there.
   */
  place(x: number, fromY: number, z: number): boolean {
    const floor = selectFloor(probeGround(this.grid, x, z), fromY, fromY - PROBE_LIFT);
    if (!floor) return false;
    Object.assign(this.state, { x, y: floor.y, z, vx: 0, vz: 0, vy: 0 });
    this.prev = { x, y: floor.y, z };
    this.accumulator = 0;
    this.airborne_ = false;
    this.landing_ = null;
    this.standOn(floor);
    return true;
  }

  /** Whether the mover is falling. */
  get airborne(): boolean {
    return this.inAir;
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

  /** The feet, drawn between the last two ticks as the eye is (`eye`): where the body stands on screen (W2.2b). */
  drawnFeet(): [number, number, number] {
    const s = this.state, t = Math.max(0, Math.min(1, this.accumulator / TICK));
    return [this.prev.x + (s.x - this.prev.x) * t, this.prev.y + (s.y - this.prev.y) * t, this.prev.z + (s.z - this.prev.z) * t];
  }

  /**
   * The eye, 15.4 over the feet (the crouch's placeholder fraction of it crouched), drawn between the last two ticks
   * by the time left over in the accumulator.
   */
  eye(): [number, number, number] {
    const s = this.state, t = Math.max(0, Math.min(1, this.accumulator / TICK));
    return [
      this.prev.x + (s.x - this.prev.x) * t,
      this.prev.y + (s.y - this.prev.y) * t + EYE_HEIGHT * (this.crouched_ ? CROUCH_EYE_PLACEHOLDER : 1),
      this.prev.z + (s.z - this.prev.z) * t,
    ];
  }

  /**
   * One 60 Hz step. On the floor: the velocity model on the ground plane, then the move, the walls and the floor.
   * In the air: no control -- the horizontal velocity is the one the feet left the floor with, the keys and the stick
   * do nothing until they are down again (the reading: the decomp settles it; reCOM keeps an `m_inAirHorizVel` on the
   * SEAL, `zSeal/zseal.h:774`) -- and the fall in closed form under gravity.
   */
  tick(input: WalkInput, dt: number = TICK): void {
    const s = this.state;
    this.prev = { x: s.x, y: s.y, z: s.z };
    if (this.airborne_) {
      const mx = s.vx * dt, mz = s.vz * dt;
      const parts = Math.max(1, Math.ceil(Math.hypot(mx, mz) / MAX_SUBSTEP));
      for (let i = 0; i < parts; i++) this.step(mx / parts, mz / parts, dt / parts);
      return;
    }
    if (this.sliding_) {
      // No footing: down the floor's tangent under gravity, the keys ignored (`slideAcceleration`, the reading).
      const [ax, az] = slideAcceleration(this.floorNormal, this.tuning_.gravity);
      const mx = s.vx * dt + 0.5 * ax * dt * dt, mz = s.vz * dt + 0.5 * az * dt * dt;
      s.vx += ax * dt;
      s.vz += az * dt;
      const parts = Math.ceil(Math.hypot(mx, mz) / MAX_SUBSTEP);
      for (let i = 0; i < parts; i++) this.step(mx / parts, mz / parts, dt / parts);
      return;
    }
    const yaw = (s.yaw * Math.PI) / 180;
    // The camera looks down its own -z (`camera.ts`): forward is (-sin, -cos), right is (cos, -sin).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let forward = input.forward, right = input.right;
    const length = Math.hypot(forward, right);
    if (length > 1) { forward /= length; right /= length; }
    const moving = length > 0;
    const cruise = WALK_SPEED * (this.crouched_ ? CROUCH_SPEED_PLACEHOLDER : 1) * (input.boost ? BOOST : 1);
    const rate = moving ? ACCEL : BRAKE;
    const gx = glide(s.vx, (fx * forward + rx * right) * cruise, rate, dt);
    const gz = glide(s.vz, (fz * forward + rz * right) * cruise, rate, dt);
    s.vx = gx.velocity;
    s.vz = gz.velocity;
    if (!moving && s.vx * s.vx + s.vz * s.vz < 1e-4) { s.vx = 0; s.vz = 0; }
    const distance = Math.hypot(gx.moved, gz.moved);
    if (distance === 0) return;
    const parts = Math.ceil(distance / MAX_SUBSTEP);
    for (let i = 0; i < parts; i++) this.step(gx.moved / parts, gz.moved / parts, dt / parts);
  }

  /**
   * The floor the probe picks under (x, z) for feet at the mover's y, however far below, or null for none: the
   * highest at or under y + `step_height`, else the lowest, never more than 20 over the feet (`selectFloor`; the
   * origin rides `step_height` - 1 over the feet, see `BODY_HIGH`).
   */
  private floorAt(x: number, z: number): Hit | null {
    const s = this.state;
    return selectFloor(probeGround(this.grid, x, z), s.y + this.tuning_.step_height - SELECT_ABOVE, s.y);
  }

  /** One sub-step of `seconds`, on the floor or in the air: a mover that leaves the floor mid-tick falls the rest. */
  private step(dx: number, dz: number, seconds: number): void {
    if (this.airborne_) this.airStep(dx, dz, seconds);
    else this.groundStep(dx, dz);
  }

  /**
   * A sub-step on the floor: move, slide off the walls, then stand on the floor there. A floor more than
   * `step_height` over the feet refuses the step (a rise the step does not climb is a wall, face or none); one more
   * than `ground_touch_distance` under them does not hold them: the move is taken and the mover leaves the floor
   * at its height, to fall from there. A refused step is tried again as its part along x and its part along z, so
   * a mover pressed diagonally against an edge runs along it; refused both ways, it stays where it was.
   */
  private groundStep(dx: number, dz: number): void {
    const s = this.state, t = this.tuning_;
    for (const [ax, az] of [[dx, dz], [dx, 0], [0, dz]] as const) {
      if (ax === 0 && az === 0) continue;
      const [x, z] = this.slide(s.x + ax, s.z + az, s.x, s.z);
      const floor = this.floorAt(x, z);
      if (!floor || floor.y - s.y > t.step_height) continue;
      s.x = x; s.z = z;
      if (s.y - floor.y > t.ground_touch_distance) this.takeOff(alongSurfaceVy(this.floorNormal, s.vx, s.vz));
      else { s.y = floor.y; this.standOn(floor); }
      return;
    }
  }

  /** Off the floor, moving up at `vy`: the speed along the floor it left (0 off a flat one). */
  private takeOff(vy: number): void {
    this.airborne_ = true;
    this.sliding_ = false;
    this.landing_ = null;
    this.airTime = 0;
    this.state.vy = vy;
  }

  /** The feet on `floor`: its normal kept, and a floor past `max_slope` is slid on rather than stood on. */
  private standOn(floor: Hit): void {
    this.floorNormal = floor.normal;
    this.sliding_ = !standable(floor.normal[1], this.tuning_.max_slope);
  }

  /**
   * A sub-step in the air: the horizontal move against the walls, over a floor no more than `step_height` over the
   * feet (the hull's edge is never left, and a higher floor is a face), then the fall. The feet meet the floor the
   * probe picks under them when they reach it on the way down -- lifted onto it when it is over them by a step's rise
   * at most, as a step would be; the contact's time and vertical speed are the flight's own (`contactTime`,
   * `contactSpeed`), not the sub-step's end.
   */
  private airStep(dx: number, dz: number, seconds: number): void {
    const s = this.state, t = this.tuning_;
    for (const [ax, az] of [[dx, dz], [dx, 0], [0, dz]] as const) {
      if (ax === 0 && az === 0) continue;
      const [x, z] = this.slide(s.x + ax, s.z + az, s.x, s.z);
      const floor = this.floorAt(x, z);
      if (!floor || floor.y - s.y > t.step_height) continue;
      s.x = x; s.z = z;
      break;
    }
    const next = fall(s.y, s.vy, seconds, t.gravity);
    const floor = this.floorAt(s.x, s.z);
    if (floor && next.vy <= 0 && floor.y >= next.y) {
      const over = floor.y > s.y;                                   // met at the sub-step's start: lifted onto it
      const at = over ? 0 : Math.min(seconds, contactTime(s.y, s.vy, floor.y, t.gravity) ?? seconds);
      const speed = over ? Math.max(0, -s.vy) : contactSpeed(s.y, s.vy, floor.y, t.gravity);
      this.airTime += at;
      this.airborne_ = false;
      this.landing_ = { kind: landingKind(speed, t), speed, airTime: this.airTime };
      s.y = floor.y;
      s.vy = 0;
      this.standOn(floor);
      return;
    }
    this.airTime += seconds;
    s.y = next.y;
    s.vy = next.vy;
  }

  /**
   * Pushes (x, z) out of every wall the body's column meets until it is `BODY_RADIUS` from each, and takes the
   * velocity's part into a wall away (research 24 section 2 step 3). A mover already inside a wall's footprint is
   * pushed out to the side it came from.
   */
  private slide(x: number, z: number, fromX: number, fromZ: number): [number, number] {
    const s = this.state;
    const lo = s.y + this.tuning_.step_height, hi = s.y + BODY_HIGH, r = BODY_RADIUS;
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
  /** The seal table every mover runs on (W2.3a, W2.R6): the defaults until the disc's arrives (`setTuning`). */
  private tuning: Readonly<SealTuning> = SEAL_TUNING_DEFAULTS;
  private tuningFromDisc = false;
  /** Jumps taken (W2.2b): the animator sees a take-off by the count, whenever between two frames it came. */
  private jumps = 0;

  constructor(private readonly camera: WalkCamera, private readonly onChange: (walking: boolean) => void = () => undefined) {}

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

  /**
   * The disc's table as the worker read it (`dynamicsFromDisc`), or null when the source has no `READERC.ZAR`: the
   * mover runs on the defaults with every field the disc gave laid over them, from its next step on.
   */
  setTuning(disc: Partial<SealTuning> | null): void {
    this.tuning = sealTuning(disc);
    this.tuningFromDisc = disc !== null && Object.values(disc).some((v) => typeof v === 'number');
    this.walker?.setTuning(this.tuning);
  }

  /** Which table the mover runs on, for the hook's `stats().tuning`. */
  tuningSource(): 'disc' | 'defaults' {
    return this.tuningFromDisc ? 'disc' : 'defaults';
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

  /** Third or first person (`V`). */
  view(): WalkView {
    return this.view_;
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

  /** The mover's state while walking (W2.3a: in the air, sliding, crouched, the last landing), else null. */
  mover(): MoverState | null {
    const w = this.walker;
    if (!this.walking || !w) return null;
    return { airborne: w.airborne, sliding: w.sliding, crouched: w.crouched, landing: w.landing && { ...w.landing } };
  }

  /** Walk mode: the mover's jump (`Walker.jump`); false when flying, or with no footing to jump from. */
  jump(): boolean {
    const w = this.walker;
    if (!this.walking || !w || !w.jump()) return false;
    this.jumps++;
    this.follow();
    return true;
  }

  /** The hull the mover walks, once walk has been asked for on this map: the shoulder camera's pull-in casts through it (W2.6). */
  grid(): Grid | null {
    return this.walker?.grid ?? null;
  }

  /** The mover for the body and its clips (W2.2b), while walking; null in fly mode. */
  snapshot(): PlaySnapshot | null {
    const w = this.walker;
    if (!this.walking || !w) return null;
    const s = w.state, look = this.camera.pose();          // the look, as `frame` hands it to the mover
    return {
      feet: w.drawnFeet(), yaw: look.yaw, pitch: look.pitch, vx: s.vx, vz: s.vz, vy: s.vy,
      airborne: w.airborne, crouched: w.crouched, landing: w.landing?.kind ?? null, jumps: this.jumps,
    };
  }

  /** Walk mode: crouches (true), stands (false) or toggles (no argument); the stance after. False when flying. */
  crouch(on?: boolean): boolean {
    const w = this.walker;
    if (!this.walking || !w) return false;
    w.setCrouch(on ?? !w.crouched);
    this.follow();
    return w.crouched;
  }

  /**
   * The mode's keys on `target`, each ignored with a modifier, on auto-repeat, and while a control has the keyboard:
   * `G` walk or fly; in walk mode `Space` the jump (in fly mode it stays the camera's "up") and `C` the crouch
   * (W2.3a: C rather than Ctrl, which `camera.ts` keeps free because Ctrl+W closes the tab; C is the other key PC
   * shooters crouch on, and nothing else here uses it).
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
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.code !== 'KeyG' && !(this.walking && (e.code === 'KeyC' || e.code === 'Space'))) return;
    const target = e.target;
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    e.preventDefault();
    if (e.code === 'KeyC') this.crouch();
    else if (e.code === 'Space') this.jump();
    else this.setMode(this.walking ? 'fly' : 'walk');
  };

  /** The floor under the camera, else spawn A's. */
  private stand(): boolean {
    if (!this.walker && this.ground) this.walker = new Walker(groundGrid(this.ground), this.tuning);
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
    const look = this.camera.pose();
    w.state.yaw = look.yaw;
    w.state.pitch = look.pitch;
  }

  /** One camera tick on the mover's last tick. */
  private cameraTick(): void {
    const w = this.walker!;
    this.player?.tick([w.state.x, w.state.y, w.state.z], w.state.yaw, w.state.pitch, rootY(w.posture));
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
    if (this.view_ === 'third') {
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
