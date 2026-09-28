import { parseRdr, rdrGet, Zar, type AssetSource, type RdrNode } from '@s2u/archive';

/**
 * The seal tuning table and the mover's physics from it (web sprint 2, W2.3a; rulings W2.R2: every number is the
 * game's or a placeholder named as one, and W2.R6: no value of a game file is written into the source).
 *
 * **The table.** Research 17 section 8: the seal tuning table at `0x44c250`, loaded by `FUN_0059ba80` through the
 * by-name getter `FUN_0032ea80`, at the offsets the note gives (`SEAL_TUNING_OFFSETS`). reCOM's `CharacterDynamics`
 * (`zCharacter/zchar.h:145-249`) laid out as four-byte floats puts every field research 17 names at research 17's
 * offset, `m_gravity` +0x00 through `m_minJumpHeight` +0x188; its own defaults are SOCOM 1's and are not used.
 *
 * **The defaults.** `SEAL_TUNING_DEFAULTS` holds the nine values research 17 section 8 prints -- read out of the
 * console's memory, already in the project's notes -- and `null` for every other field. A `null` is never used as a
 * number: the type says so, and the mover falls back to a named placeholder where it needs one.
 *
 * **The disc.** At run time the worker reads `dynamics.rdr` out of the disc's `RUN/READERC.ZAR` (`dynamicsFromDisc`),
 * from the served tree when it has the file or from the player's own disc image, and the mover runs on the defaults
 * with every field the disc gave laid over them (`sealTuning`). `readDynamics` takes each field by the file's own
 * name -- the names are the format's, and reCOM's loader reads the same ones (`CharacterDynamics::Load`,
 * `zCharacter/char_dyn.cpp:3-35, 408-425`) -- and keeps it as the loader does. The loader's body is not in the tree,
 * so its conversions are reCOM's: `max_slope` is read in degrees and kept as its cosine (`char_dyn.cpp:18-19`;
 * reCOM's `RAD_TO_DEG` is pi/180, `zMath/zmath.h:18`), which research 17's 0.642788 in memory confirms for SOCOM II;
 * the falling-damage distances, the climb heights, `min_stand_height` and `min_jump_height` are read in metres and
 * kept times `CWorld::m_scale` (`char_dyn.cpp:26-28, 412-425`), which is **the reading** for SOCOM II: no value
 * research 17 printed tests it.
 *
 * **Why here and not beside `@s2u/scene`'s readers.** Those read a map's archive for the scene graph; this one's only
 * consumers are the mover and the worker that feeds it, and the table's type, offsets and unit rules are the mover's.
 */

/** The seal table as the mover reads it: the nine research 17 prints are always numbers, the rest may be absent. */
export interface SealTuning {
  /** +0x00 `gravity`: units a second squared. */
  gravity: number;
  /** +0x04 `DamageToNewtons`. */
  DamageToNewtons: number;
  /** +0x08 `jump_factor`: the jump's impulse is this times what the decomp computes (the spec's W2.3). */
  jump_factor: number;
  /** +0x0c `land_fall_rate`: the landing threshold, units a second (the reading: the vertical speed at contact). */
  land_fall_rate: number;
  /** +0x10 `land_hard_fall_rate`: the hard landing's threshold, units a second (the same reading). */
  land_hard_fall_rate: number;
  /** +0x14 `ground_touch_distance`: a floor this far under the feet still holds them; further, they fall. */
  ground_touch_distance: number;
  /** +0x18 `max_slope`: a cosine; a floor whose normal's y is under it is not stood on. */
  max_slope: number;
  /** +0x1c `step_height`: the rise one step climbs. */
  step_height: number;
  /** +0x20 `vertical_blast_boost`. */
  vertical_blast_boost: number;
  /** +0x24 `FALLING_DAMAGE_LIGHT`, units. (+0x30..0x38 are no reader's: reCOM's computed `m_landSpeed[3]`.) */
  FALLING_DAMAGE_LIGHT: number | null;
  /** +0x28 `FALLING_DAMAGE_HEAVY`, units. */
  FALLING_DAMAGE_HEAVY: number | null;
  /** +0x2c `FALLING_DAMAGE_DEATH`, units. */
  FALLING_DAMAGE_DEATH: number | null;
  /** +0x3c `stand_turn_factor`. */
  stand_turn_factor: number | null;
  /** +0x40 `turn_maxrate`. */
  turn_maxrate: number | null;
  /** +0x44 `lower_x_accel` (research 17: "+0x44..0x50 accel limits"; the four names are the reader's). */
  lower_x_accel: number | null;
  /** +0x48 `upper_x_accel`. */
  upper_x_accel: number | null;
  /** +0x4c `lower_z_accel`. */
  lower_z_accel: number | null;
  /** +0x50 `upper_z_accel`. */
  upper_z_accel: number | null;
  /** +0x110 `fb_accel`. */
  fb_accel: number | null;
  /** +0x114 `lr_accel`. */
  lr_accel: number | null;
  /** +0x118 `throt_exp` (reCOM's loader reads it, `char_dyn.cpp:41`). */
  throt_exp: number | null;
  /** +0x178 `low_climb_height`, units. */
  low_climb_height: number | null;
  /** +0x17c `med_climb_height`, units. */
  med_climb_height: number | null;
  /** +0x180 `high_climb_height`, units. */
  high_climb_height: number | null;
  /** +0x184 `min_stand_height`, units; what it bounds is not in the bodies on hand. */
  min_stand_height: number | null;
  /** +0x188 `min_jump_height`, units; what it bounds is not in the bodies on hand (see `jumpImpulse`). */
  min_jump_height: number | null;
}

/** Research 17 section 8's nine printed values; every other field `null` until the disc's table is read. */
export const SEAL_TUNING_DEFAULTS: Readonly<SealTuning> = Object.freeze({
  gravity: 235,                   // research 17 section 8's printed value
  DamageToNewtons: 360,           // research 17 section 8's printed value
  jump_factor: 0.85,              // research 17 section 8's printed value
  land_fall_rate: 40,             // research 17 section 8's printed value
  land_hard_fall_rate: 115,       // research 17 section 8's printed value
  ground_touch_distance: 8,       // research 17 section 8's printed value
  max_slope: 0.642788,            // research 17 section 8's printed value (in memory: the cosine of 50 degrees)
  step_height: 6.5,               // research 17 section 8's printed value
  vertical_blast_boost: 3,        // research 17 section 8's printed value
  FALLING_DAMAGE_LIGHT: null, FALLING_DAMAGE_HEAVY: null, FALLING_DAMAGE_DEATH: null,
  stand_turn_factor: null, turn_maxrate: null,
  lower_x_accel: null, upper_x_accel: null, lower_z_accel: null, upper_z_accel: null,
  fb_accel: null, lr_accel: null, throt_exp: null,
  low_climb_height: null, med_climb_height: null, high_climb_height: null,
  min_stand_height: null, min_jump_height: null,
});

/** Each field's byte offset in the table at `0x44c250` (research 17 section 8). */
export const SEAL_TUNING_OFFSETS: Readonly<Record<keyof SealTuning, number>> = Object.freeze({
  gravity: 0x00, DamageToNewtons: 0x04, jump_factor: 0x08, land_fall_rate: 0x0c, land_hard_fall_rate: 0x10,
  ground_touch_distance: 0x14, max_slope: 0x18, step_height: 0x1c, vertical_blast_boost: 0x20,
  FALLING_DAMAGE_LIGHT: 0x24, FALLING_DAMAGE_HEAVY: 0x28, FALLING_DAMAGE_DEATH: 0x2c,
  stand_turn_factor: 0x3c, turn_maxrate: 0x40,
  lower_x_accel: 0x44, upper_x_accel: 0x48, lower_z_accel: 0x4c, upper_z_accel: 0x50,
  fb_accel: 0x110, lr_accel: 0x114, throt_exp: 0x118,
  low_climb_height: 0x178, med_climb_height: 0x17c, high_climb_height: 0x180,
  min_stand_height: 0x184, min_jump_height: 0x188,
});

/** How the loader keeps a field the file writes: as written, metres times the world's scale, degrees as a cosine. */
export type DynamicsUnit = 'as-is' | 'metres' | 'degrees';

/**
 * Every table field by the name `dynamics.rdr` gives it (the table's own names), with its unit rule (reCOM's
 * loader, see the file's comment). Names and rules only: the format's, not the file's values (W2.R6).
 */
export const DYNAMICS_FIELDS: Readonly<Record<keyof SealTuning, DynamicsUnit>> = Object.freeze({
  gravity: 'as-is', DamageToNewtons: 'as-is', jump_factor: 'as-is', land_fall_rate: 'as-is',
  land_hard_fall_rate: 'as-is', ground_touch_distance: 'as-is', max_slope: 'degrees', step_height: 'as-is',
  vertical_blast_boost: 'as-is',
  FALLING_DAMAGE_LIGHT: 'metres', FALLING_DAMAGE_HEAVY: 'metres', FALLING_DAMAGE_DEATH: 'metres',
  stand_turn_factor: 'as-is', turn_maxrate: 'as-is',
  lower_x_accel: 'as-is', upper_x_accel: 'as-is', lower_z_accel: 'as-is', upper_z_accel: 'as-is',
  fb_accel: 'as-is', lr_accel: 'as-is', throt_exp: 'as-is',
  low_climb_height: 'metres', med_climb_height: 'metres', high_climb_height: 'metres',
  min_stand_height: 'metres', min_jump_height: 'metres',
});

/** `CWorld::m_scale`, 1 / `MetersPerUnit`: every map's `mp<N>.rdr` says 0.1 (pinned in `archive/test/rdr.test.ts`). */
export const WORLD_SCALE = 10;

/** Where the disc keeps the table's reader: `dynamics.rdr` among `RUN/READERC.ZAR`'s root children. */
export const DYNAMICS_PATH = 'RUN/READERC.ZAR';
const DYNAMICS_READER = 'dynamics.rdr';

/**
 * The table's fields out of a decoded `dynamics.rdr`, looked up by name (`rdrGet`) and kept as the loader keeps
 * them. A field the script does not carry, or carries as something other than a number, is left out.
 */
export function readDynamics(rdr: RdrNode): Partial<SealTuning> {
  const out: Partial<Record<keyof SealTuning, number>> = {};
  for (const [name, unit] of Object.entries(DYNAMICS_FIELDS) as [keyof SealTuning, DynamicsUnit][]) {
    const value = rdrGet(rdr, name);
    if (typeof value !== 'string') continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    out[name] = unit === 'metres' ? n * WORLD_SCALE : unit === 'degrees' ? Math.cos((n * Math.PI) / 180) : n;
  }
  return out;
}

/** The table out of a `READERC.ZAR`'s bytes, or null when the archive has no `dynamics.rdr`. */
export function dynamicsFromArchive(bytes: Uint8Array): Partial<SealTuning> | null {
  const zar = Zar.parse(bytes);
  const key = zar.find(DYNAMICS_READER);
  return key ? readDynamics(parseRdr(zar.data(key))) : null;
}

/**
 * The disc's table from `source`: `RUN/READERC.ZAR` read once and its `dynamics.rdr` decoded. Null, and nothing
 * said, when the source has no such file (a served tree without it answers 404; a disc image always has it) or it
 * will not parse: the mover runs on the defaults then.
 */
export async function dynamicsFromDisc(source: AssetSource): Promise<Partial<SealTuning> | null> {
  try {
    return dynamicsFromArchive(await source.read(DYNAMICS_PATH));
  } catch {
    return null;
  }
}

/** The table the mover runs on: the defaults, with every field the disc gave (a finite number) laid over them. */
export function sealTuning(disc?: Partial<SealTuning> | null): Readonly<SealTuning> {
  const out: SealTuning = { ...SEAL_TUNING_DEFAULTS };
  if (disc) {
    for (const k of Object.keys(out) as (keyof SealTuning)[]) {
      const v = disc[k];
      if (typeof v === 'number' && Number.isFinite(v)) (out as Record<keyof SealTuning, number | null>)[k] = v;
    }
  }
  return Object.freeze(out);
}

/** Gravity on the defaults, the pure steps' default `g`. */
const G = SEAL_TUNING_DEFAULTS.gravity;

/**
 * Free flight over `dt` seconds under gravity `g`, in closed form: y + vy t - g t^2 / 2 and vy - g t. Exact for any
 * cut of the time, as `camera.ts`'s `glide` is for the walk, so a fall covers the same ground at 30 fps and 240.
 */
export function fall(y: number, vy: number, dt: number, g: number = G): { y: number; vy: number } {
  return { y: y + vy * dt - 0.5 * g * dt * dt, vy: vy - g * dt };
}

/**
 * The speed, downward and positive, at which a body at height `y` moving up at `vy` meets a floor at `floorY` under
 * gravity: the energy's sqrt(vy^2 + 2 g (y - floorY)), whenever in the flight that is. 0 for a floor it never falls
 * to (over its apex).
 */
export function contactSpeed(y: number, vy: number, floorY: number, g: number = G): number {
  return Math.sqrt(Math.max(0, vy * vy + 2 * g * (y - floorY)));
}

/** The time from now at which that body meets the floor on the way down, or null when it never reaches it. */
export function contactTime(y: number, vy: number, floorY: number, g: number = G): number | null {
  const d = vy * vy + 2 * g * (y - floorY);
  if (d < 0) return null;
  const t = (vy + Math.sqrt(d)) / g;
  return t >= 0 ? t : null;
}

/** A landing's class: under `land_fall_rate`, from it, and from `land_hard_fall_rate`. */
export type LandingKind = 'soft' | 'hard' | 'harder';

type LandingRates = Pick<SealTuning, 'land_fall_rate' | 'land_hard_fall_rate'>;

/**
 * The class of a landing at `speed` (units a second, downward, at contact): `land_fall_rate` and
 * `land_hard_fall_rate` (+0x0c and +0x10) as thresholds on the vertical speed, a speed at or over one taking its
 * class -- the reading, since the body that compares them is not in the tree (reCOM declares
 * `CZSealBody::HandleLanding(f32 impactForce)` and `HandleFallingDamage`, `zSeal/zseal.h:448-452`, without bodies).
 * The mover only exposes it; nothing else happens on a landing yet.
 */
export function landingKind(speed: number, t: LandingRates = SEAL_TUNING_DEFAULTS): LandingKind {
  if (speed >= t.land_hard_fall_rate) return 'harder';
  if (speed >= t.land_fall_rate) return 'hard';
  return 'soft';
}

/**
 * Whether a floor with this normal's y (turned up) is stood on: at or over `max_slope`, the cosine of 50 degrees
 * (+0x18). Past it the feet have no footing and the mover slides (`slideAcceleration`).
 */
export function standable(normalY: number, maxSlope: number = SEAL_TUNING_DEFAULTS.max_slope): boolean {
  return normalY >= maxSlope;
}

/**
 * The across-the-ground part of a slide down a floor with the up normal `n`: gravity's component along the plane,
 * g (n_y n - y), whose horizontal part is g n_y (n_x, n_z) -- g sin(a) down the fall line of a slope of a.
 * **The reading**, named as one: the engine slides a SEAL off a slope past `max_slope` (reCOM declares
 * `CZSealBody::HandleSliding(f32 delta)` and keeps `m_slide_descent` and `m_ground_normal`, `zSeal/zseal.h:458,
 * 772-773`), but the body of the rule is not in the tree, so the slide is the natural one: along the tangent under
 * gravity, with no friction and no control.
 */
export function slideAcceleration(n: readonly [number, number, number], g: number = G): [number, number] {
  return [g * n[1] * n[0] + 0, g * n[1] * n[2] + 0];               // + 0: a flat floor's -0 is 0
}

/** The upward speed of feet moving (vx, vz) across the ground along a plane with the up normal `n`. */
export function alongSurfaceVy(n: readonly [number, number, number], vx: number, vz: number): number {
  return n[1] > 1e-6 ? -(n[0] * vx + n[2] * vz) / n[1] + 0 : 0;
}

/**
 * PLACEHOLDER (W2.R2): the crouched eye as a fraction of the standing one. Research 17 section 1's 15.38 is the
 * look-at of a SEAL at rest standing; nothing on hand gives the crouch's -- the seal's tick (`decomp
 * CZSealBody_Tick_0_0x57a330`) reads no field of the table, and the table has no crouch height. 0.65 puts the eye at
 * 10.01, a metre at the maps' scale: a crouching adult's, not the game's.
 */
export const CROUCH_EYE_PLACEHOLDER = 0.65;

/**
 * PLACEHOLDER (W2.R2, W2.R6): the crouched walk's speed as a fraction of the standing run's (40 units a second,
 * research 18 Finding 3). A half is a round number, not the game's. The seal's tick sets the model velocity from the
 * throttles times two per-stance limits (`decomp CZSealBody_Tick_0_0x57a330` lines 4999-5255: `func_58BB50` and
 * `func_58BC00`, whose bodies are not supplied; reCOM's `CZSealBody::GetMaxZMotion` takes them from the anim set's
 * per-stance `m_crouch_max_fwd` and the like, `zSeal/seal_anim.cpp:47-76`). The disc's motion clips carry speeds
 * that may be those limits; they are a measurement for the spec's section 6, not a number for the source (W2.R6).
 */
export const CROUCH_SPEED_PLACEHOLDER = 0.5;

/** The upward speed that rises `height` under gravity before it turns: sqrt(2 g h). */
export function jumpSpeed(height: number, g: number = G): number {
  return Math.sqrt(2 * g * height);
}

/**
 * PLACEHOLDER (W2.R2): the height the jump reaches when the table has no `min_jump_height` -- the defaults, before
 * or without the disc's table. A round metre at the maps' scale, over `step_height` so a jump clears what a step
 * does not; no source.
 */
export const MIN_JUMP_HEIGHT_PLACEHOLDER = 10;

/**
 * PLACEHOLDER (W2.R2), the jump's rule: the upward impulse that reaches the table's `min_jump_height` under its
 * gravity, sqrt(2 g h) -- `MIN_JUMP_HEIGHT_PLACEHOLDER` when the table has none. **Why a placeholder:** the spec's
 * W2.3 has the impulse as `jump_factor` (0.85) times what the decomp computes, and the bodies on hand do not compute
 * it. The seal's tick reads no field of the table (`decomp CZSealBody_Tick_0_0x57a330`, 0x57a330-0x57b510: no load
 * addresses 0x44c250..0x44c3dc -- its absolute loads are other constants, its pointer loads the SEAL's own fields,
 * the motion's and the root bone's, and there is no `$gp` load), and `SealProcessAltitude` is the probe's selection
 * only (`decomp CZSealBody_SealProcessAltitude`, 0x5b5d40); so neither `jump_factor` nor what `min_jump_height`
 * bounds is settled. reCOM keeps an `m_jumpImpulse` on the SEAL (`zSeal/zseal.h:777`) without the code that sets it.
 * W2.3b replaces this once the function that writes the impulse, or a 60 Hz trace of a standing jump, is on hand.
 */
export function jumpImpulse(t: Pick<SealTuning, 'gravity' | 'min_jump_height'>): number {
  return jumpSpeed(t.min_jump_height ?? MIN_JUMP_HEIGHT_PLACEHOLDER, t.gravity);
}

/** The jump's impulse on the defaults (`jumpImpulse`): sqrt(2 x 235 x 10), 68.56 units a second. PLACEHOLDER. */
export const JUMP_PLACEHOLDER = jumpImpulse(SEAL_TUNING_DEFAULTS);
