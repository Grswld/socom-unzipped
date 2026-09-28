import { rdrGet, type RdrNode } from '@s2u/archive';
import { rdrReal } from './tuning';
import { segmentHits } from './segment';
import { isShotSurface } from './ray';
import type { Grid } from './grid';

/**
 * SOCOM II's thrown frag grenade, pure (the grenades workstream; web/docs/research/85). Every number is the game's:
 * the M67's record in `RUN/ZWEAPON.ZAR/zweapon.rdr`, the `THROW_PARAMS` defaults the dynamics loader keeps
 * (`CharacterDynamics_Load` 0x59ba80; `dynamics.rdr` carries no `THROW_PARAMS`, so `FUN_002ce1a0`'s defaults stand),
 * the throw's own constants in `.data`, and the projectile's bounce and timers (`CZProjectile` 0x3c8f50, 0x3c99a0,
 * 0x3c9b70, 0x3c9fb0, 0x3ca5a0). Research 85 cites every function and address; the comments here name them.
 *
 * Frames: the **actor frame** is the game's -- x to the SEAL's right, y up, z behind him (the throw's direction is
 * `(0, sin p, -cos p)` in it: `CZKit_TickExplosives` 0x5c1970); world positions are the viewer's (y up).
 */

export type V3 = [number, number, number];

/** `CWorld::m_scale` = 1 / `MetersPerUnit` 0.1: `DAT_003dfe10`, set from the map's `MetersPerUnit` (decomp 217166). */
export const WORLD_SCALE = 10;

// ---- the weapon record ------------------------------------------------------------------------------------------

/** A throwable's record, the fields the throw and the projectile read; distances in world units (x `WORLD_SCALE`). */
export interface ThrowableRecord {
  /** `InternalName`. */
  name: string;
  /** `ID`: 121 for the M67 -- the type byte (`weapon+0x7c`) `HandleIntersections` sends to `HandleBounce` (`'y'`). */
  id: number;
  /** `Timer1`: the fuse, seconds from the release (`SetProjectile` puts it at `+0x8c`; `HandleTimers` detonates at 0). */
  fuse: number;
  /** `Timer2`: seconds from the release until the projectile is removed (`+0x90`). */
  removal: number;
  /** `Muzzle_Velocity` x10: the throw velocity's scale in `SetProjectile` (`vel = velscale * this + vel`); 1 for the M67. */
  muzzleVelocity: number;
  /** `Gravity_Acceleration` x10, or 9.8 x10 = 98 when absent (the loader, decomp 322410-322415): units/s^2. */
  gravity: number;
  /** `ImpactRadius` x10 (`weapon+0x4c`). */
  impactRadius: number;
  /** `Effective_Range` x10 (`weapon+0x40`). */
  effectiveRange: number;
  /** `Maximum_Range` x10 (`weapon+0x3c`, the projectile's `+0x94`). */
  maximumRange: number;
  /** `Ammo_Capacity`: grenades carried. */
  capacity: number;
  /** `NumMags`. */
  mags: number;
  /** `Sound_Radius`, raw. */
  soundRadius: number;
  /** `ModelName`: the `WEAP_GEO` model drawn in the hand and in flight. */
  model: string;
  /** `FireAnimName`: the zAnim played at the throw (`frag_start` -> the sound `.THROW_OBJECT`). */
  fireAnim: string;
  /** `HitAnimName`: the bounce's zAnim stem (`grenade_hit` -> `grenade_hit_<material>`). */
  hitAnim: string;
  /** `DefaultSpecialAnimName`: the explosion's zAnim (`frag_grenade`: sparks, dust, the flash, smoke, `.GREN_MED`). */
  explosionAnim: string;
  /** `DecalSet`: the scorch (`GRENADE_BLAST` in `decals.rdr`). */
  decalSet: string;
  /** `AMMO_TYPES`' `NAME` and that round's `ZAMMO` record. */
  ammo: string;
  ammoId: number;
  /** `Explosion_Damage`, raw (the ammo's `+0x18`). */
  explosionDamage: number;
  /** `Explosion_Radius` x10 (the ammo's `+0x1c`): the damage sphere's radius, units. */
  explosionRadius: number;
}

/** `zweapon.rdr`'s M67 (the frag) and its `M67 Ammo`, transcribed; `test/projectile.test.ts` proves it equals the file. */
export const M67: ThrowableRecord = {
  name: 'M67', id: 121, fuse: 3, removal: 3.1, muzzleVelocity: 1, gravity: 98,
  impactRadius: 450, effectiveRange: 400, maximumRange: 100000, capacity: 3, mags: 1, soundRadius: 700,
  model: 'grenade', fireAnim: 'frag_start', hitAnim: 'grenade_hit', explosionAnim: 'frag_grenade', decalSet: 'GRENADE_BLAST',
  ammo: 'M67 Ammo', ammoId: 11, explosionDamage: 10, explosionRadius: 150,
};

const text = (node: RdrNode, key: string, where: string): string => {
  const v = rdrGet(node, key);
  if (typeof v !== 'string') throw new Error(`${where} has no ${key}`);
  return v;
};
const records = (script: RdrNode, key: string): RdrNode[][] => {
  const list = rdrGet(script, key);
  if (!Array.isArray(list)) throw new Error(`zweapon.rdr has no ${key}`);
  return list.filter((r): r is RdrNode[] => Array.isArray(r));
};

/** `zweapon.rdr` -> the throwable `name`'s record, scaled as the weapon loader (decomp 322406-322700) scales it. */
export function throwableRecord(script: RdrNode, name = 'M67'): ThrowableRecord {
  const record = records(script, 'ZWEAPON').find((r) => rdrGet(r, 'InternalName') === name);
  if (!record) throw new Error(`zweapon.rdr has no weapon ${name}`);
  const where = `zweapon.rdr ${name}`;
  const n = (key: string, scale = 1, node: RdrNode = record, at = where): number => rdrReal(node, key, scale, at);
  const optional = (key: string, fallback: number, scale = 1): number => (rdrGet(record, key) === undefined ? fallback * scale : n(key, scale));
  const ammoTypes = rdrGet(record, 'AMMO_TYPES');
  if (ammoTypes === undefined) throw new Error(`${where} has no AMMO_TYPES`);
  const ammo = text(ammoTypes, 'NAME', `${where} AMMO_TYPES`);
  const round = records(script, 'ZAMMO').find((r) => rdrGet(r, 'InternalName') === ammo);
  if (!round) throw new Error(`zweapon.rdr ZAMMO has no ${ammo}`);
  const at = `zweapon.rdr ZAMMO ${ammo}`;
  return {
    name, id: n('ID'), fuse: n('Timer1'), removal: n('Timer2'),
    muzzleVelocity: n('Muzzle_Velocity', WORLD_SCALE),
    gravity: Math.round(optional('Gravity_Acceleration', 9.8, WORLD_SCALE) * 1e6) / 1e6,
    impactRadius: n('ImpactRadius', WORLD_SCALE), effectiveRange: n('Effective_Range', WORLD_SCALE),
    maximumRange: n('Maximum_Range', WORLD_SCALE), capacity: n('Ammo_Capacity'), mags: n('NumMags'),
    soundRadius: n('Sound_Radius'), model: text(record, 'ModelName', where), fireAnim: text(record, 'FireAnimName', where),
    hitAnim: text(record, 'HitAnimName', where), explosionAnim: text(record, 'DefaultSpecialAnimName', where),
    decalSet: text(record, 'DecalSet', where), ammo, ammoId: n('ID', 1, round, at),
    explosionDamage: n('Explosion_Damage', 1, round, at), explosionRadius: n('Explosion_Radius', WORLD_SCALE, round, at),
  };
}

// ---- the surface materials ----------------------------------------------------------------------------------------

/**
 * One entry of the engine's material table (`DAT_0044f358`, `DAT_0044f354` entries), as the SOILS loader `FUN_002dde40`
 * (decomp 181300-181460) fills it: `+0x20` OPACITY, `+0x24` PENETRATION, `+0x28` RICOCHET, `+0x2c`
 * ELASTICITY_COEFF, `+0x30` IMPACT_RADIUS_MOD, `+0x3c` bit 0 VOLUMETRIC, bit 1 LIQUID, bit 2 UNDERWATER.
 */
export interface SurfaceMaterial {
  name: string;
  penetration: number;
  /** The bounce's restitution (`HandleBounce` scales the reflected velocity by it). */
  elasticity: number;
  impactRadiusMod: number;
  volumetric: boolean;
  liquid: boolean;
  underwater: boolean;
}

/** The constructor's defaults (`FUN_002deb30`): PENETRATION 0, ELASTICITY_COEFF 0, IMPACT_RADIUS_MOD 1, no flags. */
const blank = (name: string): SurfaceMaterial => ({
  name, penetration: 0, elasticity: 0, impactRadiusMod: 1, volumetric: false, liquid: false, underwater: false,
});

/**
 * The two entries `FUN_002de4b0` puts first, before `materials.rdr`'s SOILS: `UNKNOWN` (ELASTICITY 0.3) and
 * `PARTICLE_SYSTEM` (PENETRATION 1, VOLUMETRIC). A polygon's material byte (surface bits 10-17) indexes the table,
 * so byte `i >= 2` is SOILS entry `i - 2`; byte 0 is the map's `DefaultMaterial` (`FUN_002dc1d0`, `DAT_0044f310`).
 */
export const BUILTIN_MATERIALS: readonly SurfaceMaterial[] = [
  { ...blank('UNKNOWN'), elasticity: 0.3 },
  { ...blank('PARTICLE_SYSTEM'), penetration: 1, volumetric: true },
];

/** `READERC.ZAR/materials.rdr`'s SOILS, in file order, the fields the grenade reads (transcribed; the test checks the file). */
export const SOILS: readonly SurfaceMaterial[] = ([
  ['ACTION', 1, 0.15, 0.5], ['INVISIBLE_DI', 1, 0.15, 0.5], ['GRASS', 0, 0.2, 0.7], ['SAND', 0, 0.1, 0.5],
  ['MUD', 0, 0.1, 0.5], ['STONE', 0, 0.5, 1], ['DIRT', 0, 0.3, 0.7], ['GLASS', 0.99, 0.8, 1], ['GLASS_THICK', 0, 0.8, 1],
  ['WATER', 0.6, 0.25, 0.3, 'l'], ['UNDERWATER', 0, 0.3, 1, 'u'], ['PERSON', 0.97, 0.3, 0], ['BROKEN GLASS', 0, 0.15, 0.5],
  ['LEAVES', 0, 0.15, 0.5], ['ICE', 0, 0.15, 0.5], ['SNOW', 0, 0.15, 0.25], ['GRAVEL', 0, 0.15, 0.5],
  ['WOOD_THICK', 0, 0.3, 1], ['WOOD_THIN', 0.25, 0.3, 1], ['RUBBER', 0.8, 0.6, 0.5], ['ASPHALT', 0, 0.45, 1],
  ['LEAFY_TREE', 0.8, 0.2, 1, 'v'], ['SNOWY_TREE', 0.7, 0.1, 1], ['METAL_THICK', 0, 0.5, 1.2], ['METAL_THIN', 0.35, 0.5, 1.2],
  ['METAL_RAILING', 0.95, 0.1, 1.2], ['METAL_GRATE', 0.4, 0.5, 1.2], ['METAL_GRATE_THIN', 0.985, 0.5, 1.2],
  ['FABRIC_HEAVY', 0.85, 0.25, 0.2], ['PIPE_STEAM', 0.35, 0.5, 1.2], ['GASTANK', 0, 0.15, 1.2], ['ITEM', 1, 0.15, 1],
  ['CAMO_NET', 0.98, 0.25, 0.2], ['THATCH', 0.8, 0.1, 1], ['CHAINLINK_FENCE', 0.98, 0.1, 1], ['LEATHER', 0.9, 0.5, 0.2],
  ['BARREL', 0.5, 0.5, 1.2], ['PLASTER', 0, 0.5, 1], ['CARPET', 0, 0.5, 0.2], ['GRASS_VOL', 1, 0, 1, 'v'],
  ['BUSH_VOL', 1, 0, 1, 'v'], ['SNOWY_GRASS_VOL', 1, 0, 1, 'v'], ['GLASS_OPAQUE', 0, 0.8, 1], ['GLASS_MEDIUM', 0.985, 0.8, 1],
] as const).map(([name, penetration, elasticity, impactRadiusMod, flag]) => ({
  name, penetration, elasticity, impactRadiusMod,
  volumetric: flag === 'v', liquid: flag === 'l', underwater: flag === 'u',
}));

/** `materials.rdr` -> its SOILS, as the loader reads them (absent keys keep the constructor's defaults). */
export function soilsTable(script: RdrNode): SurfaceMaterial[] {
  const list = rdrGet(script, 'SOILS');
  if (!Array.isArray(list)) throw new Error('materials.rdr has no SOILS');
  return list.filter((r): r is RdrNode[] => Array.isArray(r)).map((r) => {
    const name = text(r, 'NAME', 'materials.rdr SOILS');
    const num = (key: string, fallback: number): number => (rdrGet(r, key) === undefined ? fallback : rdrReal(r, key, 1, `materials.rdr ${name}`));
    // The flags are keys with no value: present or not (`FUN_0032f0d0`).
    const has = (key: string): boolean => r.includes(key);
    return {
      name, penetration: num('PENETRATION', 0), elasticity: num('ELASTICITY_COEFF', 0), impactRadiusMod: num('IMPACT_RADIUS_MOD', 1),
      volumetric: has('VOLUMETRIC'), liquid: has('LIQUID'), underwater: has('UNDERWATER'),
    };
  });
}

/** The whole table as the engine indexes it: the two built-ins, then SOILS. */
export function materialTable(soils: readonly SurfaceMaterial[] = SOILS): SurfaceMaterial[] {
  return [...BUILTIN_MATERIALS, ...soils];
}

/**
 * A polygon's material byte to its material (`FUN_002dc1d0` then `DAT_0044f358[i]`, index past the end -> 0): byte 0
 * is the map's `DefaultMaterial` (its world root names it; `FUN_002ddc30` looks it up by name), `UNKNOWN` when the
 * name is not in the table.
 */
export function surfaceMaterial(index: number, defaultMaterial = '', table: readonly SurfaceMaterial[] = materialTable()): SurfaceMaterial {
  if (index === 0) return table.find((m) => m.name === defaultMaterial) ?? table[0]!;
  return table[index] ?? table[0]!;
}

/** `HandleIntersections` (0x3c9b70) passes over a hit whose PENETRATION is exactly 1 (`fVar15 != 1.0`). */
export const ignoredBy = (m: SurfaceMaterial): boolean => m.penetration === 1;
/** `HandleBounce` (0x3c8f50) bounces off a material that is not LIQUID and whose PENETRATION is under 0.99. */
export const bouncesOff = (m: SurfaceMaterial): boolean => !m.liquid && m.penetration < 0.99;

// ---- the throw's power -------------------------------------------------------------------------------------------

/**
 * The power a held throw builds (the player controller's update `FUN_00594cf0`, 0x595ea0-0x595f28): the fire
 * button's **pressure** (0..255, `FUN_002c6350` reads the pad's pressure byte) times `1/255` (`DAT_00650660`) is
 * chased by the power at `THROW_POWER_RISE` a second while it is higher, `THROW_POWER_FALL` while lower:
 * `power += (pressure - power) * rate * dt`. The throw goes when the pressure falls to `THROW_RELEASE_FRACTION` of
 * the power (`DAT_00650668`) -- the button let go. A digital button is pressure 1 held, so the power is
 * `1 - (1 - 3 dt)^n`: how long it was held.
 */
export const THROW_POWER_RISE = 3;      // DAT_006505e0
export const THROW_POWER_FALL = 1.5;    // DAT_006505d8
export const THROW_RELEASE_FRACTION = 0.15;   // DAT_00650668
export const PRESSURE_SCALE = 1 / 255;  // DAT_00650660

/** One controller tick of the held throw: the new power, or `release` when the button has been let go. */
export function stepThrowPower(power: number, pressure: number, dt: number): { power: number; release: boolean } {
  if (pressure <= power * THROW_RELEASE_FRACTION) return { power, release: true };
  const f = dt * (pressure <= power ? THROW_POWER_FALL : THROW_POWER_RISE);
  return { power: power * (1 - f) + pressure * f, release: false };
}

/** The power after `seconds` held at full pressure, stepped at `dt` from 0 (the hook's `throwGrenade(holdSeconds)`). */
export function heldPower(seconds: number, dt = 1 / 60): number {
  let power = 0;
  for (let t = 0; t < seconds - 1e-9; t += dt) power = stepThrowPower(power, 1, Math.min(dt, seconds - t)).power;
  return power;
}

// ---- the throw's clip ---------------------------------------------------------------------------------------------

/**
 * `dynamics.rdr`'s `THROW_PARAMS` (loaded into the dynamics block at `+0x198..+0x1a8`, `CharacterDynamics_Load`
 * decomp 456874-456884). The shipped file has no `THROW_PARAMS`, so the constructor's defaults (`FUN_002ce1a0`) are
 * the game's: `toss_aim_threshold` is compared with `sin(aim pitch)` (a loaded value goes through `sin`).
 */
export const THROW_PARAMS = {
  abortThreshold: 0.15,
  maxDistanceStand: 600,
  maxDistanceCrouch: 300,
  tossPowerThreshold: 0.6,
  tossAimThreshold: 0.3,
} as const;

/** The body's state short at `+0x174` as the throw reads it: 0 stand, 1 crouch, 2 prone, 3 peek (lean). */
export type ThrowStance = 'stand' | 'crouch' | 'prone' | 'peek-right' | 'peek-left';

/** One of `GetThrowAnim`'s answers: the clip, when in it the grenade leaves the hand, and where the hand is then. */
export interface ThrowAnim {
  /** The animset type (`animset.rdr`'s `type_name`). */
  type: string;
  /** Its clip in `MOTION_P.ZAR`. */
  clip: string;
  /** The clip's length, seconds (`MOTION_P.ZAR`: frames / 30). */
  duration: number;
  /** `motion.rdr`'s `playback` for the clip. */
  playback: number;
  /** The release, as a fraction of the clip. */
  release: number;
  /** The release point in the actor frame (x right, y up, z behind). */
  offset: V3;
  /** An underhand toss rather than a throw. */
  toss: boolean;
}

const anim = (type: string, clip: string, duration: number, playback: number, release: number, offset: V3, toss: boolean): ThrowAnim =>
  ({ type, clip, duration, playback, release, offset, toss });

/** `GetThrowAnim`'s table (0x57fce0): the `.data` offsets at 0x66b310-0x66b3a8 and its release fractions. */
export const THROW_ANIMS = {
  standThrow: anim('Throw grenade', 'seal_throwgrenade', 28 / 30, 1.6, 0.46, [3.343816, 19.34775, 3.913763], false),
  standToss: anim('Toss grenade', 'seal_tossgrenade', 30 / 30, 1.6, 0.69, [3.13, 13.8, -10.5], true),
  crouchThrow: anim('Crouch throw grenade', 'seal_crouch_throwgrenade', 19 / 30, 1.1, 0.7, [6.05, 15.59, 1.96], false),
  proneThrow: anim('Prone throw grenade', 'seal_prone_throwgrenade', 27 / 30, 1.6, 0.66, [6.29, 15.05, -0.97], false),
  proneToss: anim('Prone toss grenade', 'seal_prone_tossgrenade', 27 / 30, 1.1, 0.56, [2.39, 7.87, -8.53], true),
  peekRightToss: anim('Peek right toss', 'seal_toss_rlean', 35 / 30, 1.25, 0.55, [7.8, 10.13, -5.31], true),
  peekLeftToss: anim('Peek left toss', 'seal_toss_llean', 28 / 30, 1.2, 0.87, [-8.83, 11.47, -6.48], true),
} as const satisfies Record<string, ThrowAnim>;

/** `DAT_00650578`: a crouched SEAL moving faster than 15 units a second (225 squared) throws the standing throw. */
export const CROUCH_MOVING_SPEED_SQ = 225;

/** Whether `GetThrowAnim` picks a toss: power under 0.6 and the aim's sine under 0.3 (0x57fce0, :20-23). */
export const isToss = (power: number, aimSin: number): boolean =>
  power < THROW_PARAMS.tossPowerThreshold && aimSin < THROW_PARAMS.tossAimThreshold;

/**
 * `GetThrowAnim__10CZSealBodyFfR8AnimTypeRfRfR6CPnt3D` (0x57fce0; the demo's name, its body SOCOM II's): the clip,
 * the release and the hand for a throw at `power` with the aim's sine `aimSin`, from `stance`, moving at `speedSq`
 * (units^2/s^2 over the ground). Null where the game has no throw.
 */
export function throwAnim(power: number, aimSin: number, stance: ThrowStance, speedSq = 0): ThrowAnim {
  const toss = isToss(power, aimSin);
  switch (stance) {
    case 'stand': return toss ? THROW_ANIMS.standToss : THROW_ANIMS.standThrow;
    case 'crouch': return speedSq <= CROUCH_MOVING_SPEED_SQ ? THROW_ANIMS.crouchThrow : THROW_ANIMS.standThrow;
    case 'prone': return toss ? THROW_ANIMS.proneToss : THROW_ANIMS.proneThrow;
    case 'peek-right': return THROW_ANIMS.peekRightToss;
    case 'peek-left': return THROW_ANIMS.peekLeftToss;
  }
}

/**
 * Seconds from the throw's start to the release: the fraction of the clip, at the clip's playback [reading:
 * `FUN_005802b0` computes `release x clip(+0x10) x FUN_0028ada0(clip)`, the two factors not decoded; `motion.rdr`'s
 * `throw_whoosh` callback at 0.45 beside the stand throw's 0.46 says the fraction is of the clip].
 */
export const releaseSeconds = (a: ThrowAnim): number => (a.release * a.duration) / a.playback;

/** The farthest a throw reaches from `stance`: `max_distance_stand` standing, `max_distance_crouch` otherwise (0x5c1970). */
export const maxThrowDistance = (stance: ThrowStance): number =>
  stance === 'stand' ? THROW_PARAMS.maxDistanceStand : THROW_PARAMS.maxDistanceCrouch;

// ---- the launch ---------------------------------------------------------------------------------------------------

/** `ComputeElevOfs`' two ends (0x5976a0; `DAT_006505a8`, `DAT_006505b0`): 10 degrees at power 0, 12 at power 1. */
export const THROW_ELEVATION_DEG: readonly [number, number] = [10, 12];
/** The aim pitch's clamp before the elevation is added (0x65e630, 0x65e638): 0 to 0.959931 rad (55 degrees). */
export const THROW_AIM_CLAMP: readonly [number, number] = [0, 0.959931];
/** The slowest throw, as a fraction of the fastest (`0x3d4ccccd`, 0x5c21a0). */
export const THROW_MIN_SPEED_FRACTION = 0.05;
/** `ComputeMaxVel`'s gravity (0x5976e0, the literal 98.0) and `ComputeTimeToImpact`'s half of it (-49, `0xc2440000`). */
export const THROW_GRAVITY = 98;
/** `ComputeMaxVel`'s two `.data` factors: the range's weight (`DAT_006505b8` = 1) and cos 45 (`DAT_006505c0`). */
const MAXVEL_RANGE_WEIGHT = 1, MAXVEL_COS = 0.707107;

/**
 * `CDynGrenade::ComputeMaxVel` (0x5976e0): the speed that carries a 45-degree throw from `height` to the ground
 * `distance` away -- `t = sqrt(2 (height + distance) / 98)`, `speed = distance / (cos 45 t)`.
 */
export function maxThrowSpeed(distance: number, height: number): { speed: number; time: number } {
  const time = Math.sqrt(((height + MAXVEL_RANGE_WEIGHT * distance) * 2) / THROW_GRAVITY);
  return { speed: distance / (MAXVEL_COS * time), time };
}

/** `CDynGrenade::ComputeElevOfs` (0x5976a0): the elevation added to the aim, radians. */
export const throwElevation = (power: number): number =>
  ((THROW_ELEVATION_DEG[1] * power + THROW_ELEVATION_DEG[0] * (1 - power)) * Math.PI) / 180;

/**
 * `ComputeTimeToImpact` (0x5975d0) times the horizontal speed: the later root of `-49 t^2 + vy t + h = 0`
 * (`FUN_0050de20`, `FUN_00575c50`), times `vh` -- how far the throw lands, over the ground, from the release. 0 when
 * there is no root.
 */
export function impactRange(vh: number, vy: number, h: number): number {
  const a = -THROW_GRAVITY / 2;
  const disc = vy * vy - 4 * a * h;
  if (disc < 0) return 0;
  const r = Math.sqrt(disc), t1 = (-vy + r) / (2 * a), t2 = (-vy - r) / (2 * a);
  return vh * Math.max(t1, t2);
}

/** What `throwVelocity` worked out, for the hook and the tests. */
export interface ThrowLaunch {
  /** The velocity in the actor frame, units/s. */
  velocity: V3;
  speed: number;
  /** The launch pitch, radians: the clamped aim plus the elevation. */
  pitch: number;
  /** `ComputeMaxVel`'s speed for this stance and hand height. */
  maxSpeed: number;
  /** The power's speed before the aimed correction (`lerp(0.05 max, max, power)`). */
  powerSpeed: number;
  /** `ComputeTimeToImpact`'s range for the power's speed. */
  range: number;
}

/**
 * The throw's velocity (`CZKit_TickExplosives` 0x5c2134-0x5c22d8, `DAT_006505c8` = 1: the aimed branch), in the
 * actor frame, from the release point `release` (actor frame; its y is the height `ComputeMaxVel` takes):
 *
 * 1. `max` = `ComputeMaxVel(maxDistance, release.y)`; the pitch = `asin(aimSin)` clamped to 0..55 degrees, plus
 *    10..12 degrees by power; the power's speed = `lerp(0.05 max, max, power)`.
 * 2. `range` = where that throw would land, over the ground from the release.
 * 3. The aimed correction: the target is `range` straight ahead of the **actor's origin**, `(0, -range)` on the
 *    ground plane; the direction turns from the hand toward it, and the speed becomes the hand's distance to it,
 *    clamped to `max` -- `sqrt(range^2 + 2 range z + x^2 + z^2)` (0x5c21f4-0x5c2230, `ADDA.S`/`MADD.S`).
 */
export function throwVelocity(power: number, aimSin: number, release: V3, maxDistance: number): ThrowLaunch {
  const [x, h, z] = release;
  const { speed: maxSpeed } = maxThrowSpeed(maxDistance, h);
  const aim = Math.min(THROW_AIM_CLAMP[1], Math.max(THROW_AIM_CLAMP[0], Math.asin(Math.max(-1, Math.min(1, aimSin)))));
  const pitch = aim + throwElevation(power);
  const sin = Math.sin(pitch), cos = Math.cos(pitch);
  const powerSpeed = maxSpeed * power + maxSpeed * THROW_MIN_SPEED_FRACTION * (1 - power);
  const range = impactRange(powerSpeed * cos, powerSpeed * sin, h);
  const speed = Math.min(maxSpeed, Math.max(0, Math.sqrt(Math.max(0, range * range + 2 * range * z + x * x + z * z))));
  let dx = -x, dz = -(range + z);
  const l = Math.hypot(dx, dz);
  if (l > 0) { dx /= l; dz /= l; } else { dx = 0; dz = -1; }
  return { velocity: [dx * cos * speed, sin * speed, dz * cos * speed], speed, pitch, maxSpeed, powerSpeed, range };
}

/**
 * The actor frame to the world (the viewer's `play.ts` `actorToWorld`, repeated so this module stays pure): x right,
 * y up, z behind, at `feet`, turned by `yawDeg` (yaw 0 faces -z).
 */
export function actorToWorldPoint(feet: readonly number[], yawDeg: number, v: readonly number[]): V3 {
  const r = (yawDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [feet[0]! + v[0]! * c + v[2]! * s, feet[1]! + v[1]!, feet[2]! - v[0]! * s + v[2]! * c];
}

/** A direction in the actor frame to the world (no translation). */
export function actorToWorldDir(yawDeg: number, v: readonly number[]): V3 {
  return actorToWorldPoint([0, 0, 0], yawDeg, v);
}

// ---- the flight ---------------------------------------------------------------------------------------------------

/** The bounce's push off the surface along its normal (`0x3dcccccd`, 0x3c8f50): units. */
export const BOUNCE_LIFT = 0.1;
/** A pass-through's nudge along the new velocity (`0x38d1b717`): seconds of it. */
export const PASS_NUDGE = 0.0001;
/** The first bounce's extra damping (`* 0.75`, flag bit 1 of `+4`, set by `SetProjectile` and cleared by the bounce). */
export const FIRST_BOUNCE_DAMPING = 0.75;
/** Under this speed after a bounce that turned the fall upward, the grenade stops (`fVar15 < 5.0`). */
export const REST_SPEED = 5;
/** A bounce plays its sound (the material's `grenade_hit_*` zAnim) only faster than this (`10.0 < fVar15`). */
export const BOUNCE_SOUND_SPEED = 10;

/** `PROJECTILE_STATE` as the viewer needs it (reCOM `zWeapon/zweapon.h:218-227`: 1 FLYOUT, 2 AT_REST, 3 TO_BE_DETONATED). */
export type GrenadeState = 'flight' | 'rest' | 'detonated' | 'removed';

export interface Grenade {
  pos: V3;
  vel: V3;
  state: GrenadeState;
  /** `+0x8c`: seconds to the detonation. */
  fuse: number;
  /** `+0x90`: seconds to the removal. */
  removal: number;
  /** `+4` bit 1: the first bounce is still to come. */
  firstBounce: boolean;
  bounces: number;
  /** Seconds since the release. */
  age: number;
}

/** What the hull answered along a segment: the crossing, the polygon's normal (either side) and its material. */
export interface HullHit { point: V3; normal: V3; material: SurfaceMaterial; t: number }
/** Every polygon the segment a->b crosses, nearest `a` first (`segment.ts`'s `segmentHits`, with the material). */
export type HullCast = (a: V3, b: V3) => HullHit[];

/**
 * A `HullCast` over the map's grid (`segment.ts`): every polygon but the probe's skipped ones (surface bit 18, the
 * doorway volumes the mover walks through) [reading: the projectile's own `DiIntersect` class is not traced], each
 * hit's material out of the table by its byte, byte 0 the map's `DefaultMaterial`.
 */
export function gridCast(grid: Grid, defaultMaterial = '', table: readonly SurfaceMaterial[] = materialTable()): HullCast {
  return (a, b) => segmentHits(grid, a, b, isShotSurface).map((h) => ({
    point: h.point, normal: h.normal, t: h.t, material: surfaceMaterial(h.poly.material, defaultMaterial, table),
  }));
}

export type GrenadeEvent =
  | { kind: 'bounce'; point: V3; normal: V3; material: string; speed: number; sound: boolean }
  | { kind: 'pass'; point: V3; material: string }
  | { kind: 'rest'; point: V3; material: string }
  | { kind: 'explode'; point: V3 }
  | { kind: 'remove' };

/** A grenade leaving the hand at `pos` with `vel` (world), its timers the record's (`SetProjectile` 0x3cb1a0). */
export function launchGrenade(pos: V3, vel: V3, record: ThrowableRecord = M67): Grenade {
  const s = record.muzzleVelocity;
  return {
    pos: [...pos], vel: [vel[0] * s, vel[1] * s, vel[2] * s], state: 'flight',
    fuse: record.fuse, removal: record.removal, firstBounce: true, bounces: 0, age: 0,
  };
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * `CZProjectile::HandleBounce` (0x3c8f50) for a bouncing material: the velocity reflected about the normal
 * (`FUN_00308ef0`: `v - 2 (v.n) n`) and scaled by the material's ELASTICITY_COEFF (0.75 more on the first bounce);
 * slower than 5 after a bounce that turned a fall upward, it stops (`AT_REST`); the new position is the hit point
 * lifted 0.1 off the surface. The normal is taken facing the grenade [reading: the engine's `DiIntersect` normal].
 */
function bounce(g: Grenade, hit: HullHit): GrenadeEvent[] {
  const n0 = hit.normal, nl = len(n0) || 1;
  let n: V3 = [n0[0] / nl, n0[1] / nl, n0[2] / nl];
  if (dot(n, g.vel) > 0) n = [-n[0], -n[1], -n[2]];
  const vyBefore = g.vel[1];
  const k = -2 * dot(g.vel, n);
  const reflected: V3 = [g.vel[0] + n[0] * k, g.vel[1] + n[1] * k, g.vel[2] + n[2] * k];
  const e = hit.material.elasticity * (g.firstBounce ? FIRST_BOUNCE_DAMPING : 1);
  g.firstBounce = false;
  g.vel = [reflected[0] * e, reflected[1] * e, reflected[2] * e];
  g.bounces++;
  const speed = len(g.vel);
  const events: GrenadeEvent[] = [{
    kind: 'bounce', point: [...hit.point], normal: n, material: hit.material.name, speed,
    sound: speed > BOUNCE_SOUND_SPEED && !hit.material.underwater,
  }];
  if (speed < REST_SPEED) {
    if (hit.material.name === 'PERSON') {
      // `DAT_003e14f8` (PERSON): the damping is undone rather than the grenade stopped.
      const u = hit.material.elasticity > 0 ? 1 / hit.material.elasticity : 1;
      g.vel = [g.vel[0] * u, g.vel[1] * u, g.vel[2] * u];
    } else if (vyBefore < 0 && g.vel[1] > 0) {
      g.vel = [0, 0, 0];
      g.state = 'rest';
    }
  }
  g.pos = [hit.point[0] + n[0] * BOUNCE_LIFT, hit.point[1] + n[1] * BOUNCE_LIFT, hit.point[2] + n[2] * BOUNCE_LIFT];
  if (g.state === 'rest') events.push({ kind: 'rest', point: [...g.pos], material: hit.material.name });
  return events;
}

/**
 * One frame of a thrown grenade, as `PreTick` (0x3ca5a0), the intersection pass and `PostTick` (0x3c9fb0) run it:
 *
 * 1. In flight, gravity: `vel.y -= g dt`, and the frame's segment from the position to `pos + vel dt` (symplectic
 *    Euler, `FUN_00309180`/`FUN_00309240`). At rest nothing moves.
 * 2. The timers count down (`PostTick`).
 * 3. `HandleIntersections` (0x3c9b70): the hits along the segment nearest first, a material with PENETRATION 1
 *    passed over; a bouncing material ends the frame at the bounce (one a frame); a LIQUID or PENETRATION >= 0.99
 *    one scales the velocity by its elasticity and the search goes on past it; no bounce, the segment's end.
 * 4. `HandleTimers` (0x3c99a0): the fuse run out detonates it where it is; `Timer2` run out removes it.
 */
export function stepGrenade(g: Grenade, dt: number, cast: HullCast, record: ThrowableRecord = M67): GrenadeEvent[] {
  const events: GrenadeEvent[] = [];
  if (g.state === 'removed') return events;
  g.age += dt;
  if (g.state === 'flight') {
    g.vel = [g.vel[0], g.vel[1] - record.gravity * dt, g.vel[2]];
    const start: V3 = [...g.pos];
    const end: V3 = [start[0] + g.vel[0] * dt, start[1] + g.vel[1] * dt, start[2] + g.vel[2] * dt];
    let moved = false;
    for (const hit of cast(start, end)) {
      if (ignoredBy(hit.material)) continue;
      if (bouncesOff(hit.material)) {
        events.push(...bounce(g, hit));
        moved = true;
        break;
      }
      // Through: water, glass, a railing, a tree's leaves.
      const e = hit.material.elasticity;
      g.vel = [g.vel[0] * e, g.vel[1] * e, g.vel[2] * e];
      events.push({ kind: 'pass', point: [...hit.point], material: hit.material.name });
    }
    if (!moved) g.pos = end;
  }
  g.fuse -= dt;
  g.removal -= dt;
  if (g.state !== 'detonated' && g.fuse <= 0) {
    g.state = 'detonated';
    g.vel = [0, 0, 0];
    events.push({ kind: 'explode', point: [...g.pos] });
  }
  if (g.state === 'detonated' && g.removal <= 0) {
    g.state = 'removed';
    events.push({ kind: 'remove' });
  }
  return events;
}

// ---- the explosion ------------------------------------------------------------------------------------------------

/**
 * The explosion's damage at `distance` (`CZProjectile::GetDamage`, 0x3c7600, decomp 318709-318728): the ammo's
 * `Explosion_Damage` (plus the weapon's `+0x64` term, 0 unless its record sets it) in full to half the radius,
 * falling linearly to 0 at `Explosion_Radius`; nothing beyond. Nothing in the viewer takes damage.
 */
export function explosionDamage(distance: number, record: ThrowableRecord = M67, bonus = 0): number {
  const r = distance / record.explosionRadius;
  const full = record.explosionDamage + bonus;
  if (r > 1) return 0;
  if (r > 0.5) return full * (1 - (r - 0.5) * 2);
  return full;
}

/** The explosion's sound-anim per material: `<explosionAnim>_<material>` (`frag_grenade_stone` ...), as the zAnims are named. */
export const materialAnim = (stem: string, material: string): string => `${stem}_${material.toLowerCase().replace(/ /g, '_')}`;

/**
 * `READERC.ZAR/decals.rdr`'s `GRENADE_BLAST` (the M67's `DecalSet`): the scorch, per material, `grenade_mark.tif`
 * between `MIN_SIZE` and `MAX_SIZE` units across (transcribed; the test reads the file). A material not listed
 * takes no mark [reading: `decalEntry` finds no row].
 */
export const GRENADE_BLAST: Readonly<Record<string, readonly [number, number]>> = {
  SAND: [30, 50], DIRT: [20.2, 30.9], STONE: [20.2, 30.9], SNOW: [10.2, 20.9], METAL_THICK: [10.2, 20.9],
  METAL_THIN: [10.2, 20.9], WOOD_THICK: [10.2, 20.9], WOOD_THIN: [10.2, 16], ASPHALT: [10.2, 16], GLASS: [10, 13],
};
