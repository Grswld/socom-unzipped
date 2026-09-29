import type { CmdBytes, Vec3 } from './effects';

/**
 * `PARTICLE_SOURCE` (27): an emitter's configuration, decoded from its tick `FUN_00266830` (decomp 112759) and the
 * particle manager it drives (`FUN_00329b40` the emission, 226782; `FUN_00327cd0` a particle's spawn; `FUN_003282b0`
 * its step; `FUN_003251b0` its draw, 223925); web/docs/research/89 §3. Every field is an override that applies only
 * when its bit of `flagsA` (+4) is set; the rest keep the source's defaults (`FUN_0032ab20`, decomp 227362).
 *
 * **Active or not** (flag A 0x1): the source is switched to flag A 0x2 (`FUN_00329ac0`), and a source that is off
 * emits nothing (`FUN_00329b40` returns at once). `shell_smoke_med`, the rifles' muzzle smoke, carries `0x37ffbfd1`:
 * a whole configuration, switched **off** -- the retail game draws no smoke from it (89 §3).
 *
 * A particle is a GS sprite, a screen-aligned square `2 size` across (PRIM 0x0F6, decomp 224013), coloured by its
 * colour keys times 128 (`MODULATE`: 1.0 leaves the texel), sized by its scale keys, faded by the camera's squared
 * distance between the near and far pairs, drawn back to front with no depth write, blended by its texture's own bind
 * packet (`cloudpuff01.tif` source alpha, `effect_spark01.tif` additive).
 */

export const PARTICLE_A = {
  SET_ACTIVE: 0x1, ACTIVE: 0x2, OFFSET: 0x4, AT_CONTEXT: 0x8, FOLLOW: 0x10, AT_NODE: 0x20, BASE_VELOCITY: 0x40, WORLD_VELOCITY: 0x80,
  RANDOM_VX: 0x100, RANDOM_VY: 0x200, RANDOM_VZ: 0x400, BOX_X: 0x800, BOX_Y: 0x1000, BOX_Z: 0x2000,
  PER_DISTANCE: 0x4000, PER_SECOND: 0x8000, PER_EVENT: 0x10000, ACCEL: 0x20000, FRICTION: 0x40000, WIND: 0x80000,
  SIZE: 0x100000, START_AGE: 0x200000, LIFETIME: 0x400000, NEAR_FADE: 0x800000, FAR_FADE: 0x1000000,
  PRIORITY: 0x2000000, TEXTURE_RANDOM: 0x4000000, TEXTURE_LIFE: 0x8000000, COLOURS: 0x10000000, SCALES: 0x20000000,
} as const;

export const PARTICLE_B = {
  EVENTS: 0x1, BASE_NORMAL: 0x2, WORLD_NORMAL: 0x4, POSITION_BLOCK: 0x8, BASE_VELOCITY: 0x40, WORLD_VELOCITY: 0x80,
  BASE_REFLECT: 0x100, WORLD_REFLECT: 0x200, BASE_UNIT: 0x400, WORLD_UNIT: 0x800, LOCAL_RANDOM: 0x80000,
} as const;

/**
 * Where a velocity comes from (`FUN_00266830`, decomp 112975-113120), for the base (+0x20, flags B 0x2 / 0x40 / 0x100
 * / 0x400) and the world one (+0x2c, B 0x4 / 0x80 / 0x200 / 0x800): the xyz at the offset (flag A 0x40 / 0x80); the
 * context's normal (type 7) times the f32 at the offset; the context's velocity (type 6, made a unit when asked) times
 * it; or that, reflected about the normal (`FUN_00308ef0`).
 */
export type VelocityFrom = 'fixed' | 'normal' | 'velocity' | 'reflected';

/** A min/max pair; the particle takes `min + (max - min) rand()`. */
export type Range = [number, number];

export interface ParticleSource {
  flagsA: number;
  flagsB: number;
  /** The source's name (`blue_smoke01`): one source an animation and name, kept across its commands. */
  name: string;
  /** Flag A 0x1: switch the source to `active`; null leaves it. */
  setActive: boolean | null;
  /** The node the source is at (+0x0d): `-6` the caller, `-7` the root. */
  node: number;
  follow: boolean;
  /** Particles per emission event (+0x0e), and the events allowed (+0xc6; -1 unlimited). */
  perEvent: number;
  events: number;
  /** Seconds (or units moved) between events (+0x80), null when neither flag is set. */
  interval: number | null;
  perDistance: boolean;
  /** Sprite 0, rotated 1, xz 2, streaked 3 (+0x13 low nibble; 4 leaves it). */
  type: number;
  /** A streaked source's two numbers (the u16 offset at +0xd0: the tail's reach and its alpha), null for the defaults. */
  streak: [number, number] | null;
  /**
   * A rotated source's spin (type 1; the u16 offset at +0xce, decomp 112853-112867): the spin (rad/s) and its
   * acceleration, each a min/max; none when the block is absent (no spin).
   */
  spin: { spin: Range; accel: Range } | null;
  offset: Vec3;
  /** In the node's frame (rotation only). */
  baseVelocity: Vec3;
  worldVelocity: Vec3;
  /** Where each comes from, the scalar at +0x20 / +0x2c for the context forms, and whether the context velocity is made a unit. */
  baseFrom: VelocityFrom;
  worldFrom: VelocityFrom;
  baseScale: number;
  worldScale: number;
  baseUnit: boolean;
  worldUnit: boolean;
  /**
   * The source's place (decomp 112876-112933): the context position (type 5, flag A 0x8), plus the offset (A 0x4),
   * plus the node's world origin (A 0x20), plus a random block (B 0x8: base xyz + range xyz x rand); with none of the
   * three it follows its node (A 0x10).
   */
  atContext: boolean;
  atNode: boolean;
  positionBlock: { base: Vec3; range: Vec3 } | null;
  /** Per axis, world space (local with flag B 0x80000). */
  randomVelocity: [Range, Range, Range];
  box: [Range, Range, Range];
  accel: Vec3;
  friction: number;
  size: Range;
  startAge: Range;
  lifetime: Range;
  /** Distances (not squared), null when the flag is clear. */
  nearFade: Range | null;
  farFade: Range | null;
  /** Textures by name, with the life fraction each starts at (a list to pick from, or to step through). */
  textures: { name: string; t: number }[];
  textureMode: 'random' | 'life' | 'first';
  /** The first texture's name (what the loader fetches first). */
  texture: string | null;
  /** `t, r, g, b, a` keys (1.0 = 0x80, no clamp). */
  colours: [number, number, number, number, number][];
  /** `t, multiplier` keys on the size. */
  scales: [number, number][];
}

const has = (flags: number, bit: number): boolean => (flags & bit) !== 0;

export function decodeParticleSource(c: CmdBytes, names: readonly string[]): ParticleSource {
  const a = c.u32(4), b = c.u32(8);
  const name = (i: number): string => names[i] ?? `#${i}`;
  const pair = (o: number): Range => [c.f32(o), c.f32(o + 4)];
  const opt = (bit: number, o: number): Range | null => (has(a, bit) ? pair(o) : null);
  const textures: ParticleSource['textures'] = [];
  const tex = c.u16(0xc8);
  if (tex > 0) for (let i = 0; i < c.u8(0x10); i++) textures.push({ name: name(c.u16(tex + 8 * i)), t: c.f32(tex + 8 * i + 4) });
  const colours: ParticleSource['colours'] = [];
  const col = c.u16(0xca);
  if (col > 0 && has(a, PARTICLE_A.COLOURS)) for (let i = 0; i < c.u8(0x11); i++) { const o = col + 20 * i; colours.push([c.f32(o), c.f32(o + 4), c.f32(o + 8), c.f32(o + 12), c.f32(o + 16)]); }
  const scales: ParticleSource['scales'] = [];
  const sc = c.u16(0xcc);
  if (sc > 0 && has(a, PARTICLE_A.SCALES)) for (let i = 0; i < c.u8(0x12); i++) scales.push([c.f32(sc + 8 * i), c.f32(sc + 8 * i + 4)]);
  const zero: Range = [0, 0];
  const axis = (bit: number, o: number): Range => (has(a, bit) ? pair(o) : zero);
  const interval = has(a, PARTICLE_A.PER_SECOND) || has(a, PARTICLE_A.PER_DISTANCE) ? c.f32(0x80) : null;
  const baseFrom: VelocityFrom = has(b, PARTICLE_B.BASE_NORMAL) ? 'normal'
    : has(b, PARTICLE_B.BASE_VELOCITY) ? (has(b, PARTICLE_B.BASE_REFLECT) ? 'reflected' : 'velocity')
      : has(b, PARTICLE_B.BASE_REFLECT) ? 'reflected' : 'fixed';
  const worldFrom: VelocityFrom = has(b, PARTICLE_B.WORLD_NORMAL) ? 'normal'
    : has(b, PARTICLE_B.WORLD_VELOCITY) ? 'velocity' : has(b, PARTICLE_B.WORLD_REFLECT) ? 'reflected' : 'fixed';
  const block = c.u16(0xc4);
  return {
    flagsA: a, flagsB: b, name: name(c.u8(0x0c)),
    setActive: has(a, PARTICLE_A.SET_ACTIVE) ? has(a, PARTICLE_A.ACTIVE) : null,
    node: c.i8(0x0d), follow: has(a, PARTICLE_A.FOLLOW),
    perEvent: has(a, PARTICLE_A.PER_EVENT) ? c.u8(0x0e) : 1,
    events: has(b, PARTICLE_B.EVENTS) ? c.i16(0xc6) : -1,
    interval, perDistance: !has(a, PARTICLE_A.PER_SECOND) && has(a, PARTICLE_A.PER_DISTANCE),
    type: c.u8(0x13) & 0xf,
    streak: (c.u8(0x13) & 0xf) === 3 && c.u16(0xd0) > 0 ? [c.f32(c.u16(0xd0)), c.f32(c.u16(0xd0) + 4)] : null,
    spin: (c.u8(0x13) & 0xf) === 1 && c.u16(0xce) > 0
      ? { spin: [c.f32(c.u16(0xce)), c.f32(c.u16(0xce) + 4)], accel: [c.f32(c.u16(0xce) + 8), c.f32(c.u16(0xce) + 12)] } : null,
    offset: has(a, PARTICLE_A.OFFSET) ? c.vec3(0x14) : [0, 0, 0],
    baseVelocity: has(a, PARTICLE_A.BASE_VELOCITY) ? c.vec3(0x20) : [0, 0, 0],
    worldVelocity: has(a, PARTICLE_A.WORLD_VELOCITY) ? c.vec3(0x2c) : [0, 0, 0],
    baseFrom, worldFrom, baseScale: c.f32(0x20), worldScale: c.f32(0x2c),
    baseUnit: has(b, PARTICLE_B.BASE_UNIT), worldUnit: has(b, PARTICLE_B.WORLD_UNIT),
    atContext: has(a, PARTICLE_A.AT_CONTEXT), atNode: has(a, PARTICLE_A.AT_NODE),
    positionBlock: has(b, PARTICLE_B.POSITION_BLOCK) && block > 0 ? { base: c.vec3(block), range: c.vec3(block + 12) } : null,
    randomVelocity: [axis(PARTICLE_A.RANDOM_VX, 0x38), axis(PARTICLE_A.RANDOM_VY, 0x40), axis(PARTICLE_A.RANDOM_VZ, 0x48)],
    box: [axis(PARTICLE_A.BOX_X, 0x50), axis(PARTICLE_A.BOX_Y, 0x58), axis(PARTICLE_A.BOX_Z, 0x60)],
    accel: has(a, PARTICLE_A.ACCEL) ? c.vec3(0x84) : [0, 0, 0],
    friction: has(a, PARTICLE_A.FRICTION) ? c.f32(0x90) : 0,
    size: opt(PARTICLE_A.SIZE, 0x9c) ?? [1, 1],
    startAge: opt(PARTICLE_A.START_AGE, 0xa4) ?? [0, 0],
    lifetime: opt(PARTICLE_A.LIFETIME, 0xac) ?? [1, 1],
    nearFade: opt(PARTICLE_A.NEAR_FADE, 0xb4), farFade: opt(PARTICLE_A.FAR_FADE, 0xbc),
    textures,
    textureMode: has(a, PARTICLE_A.TEXTURE_RANDOM) ? 'random' : has(a, PARTICLE_A.TEXTURE_LIFE) ? 'life' : 'first',
    texture: textures[0]?.name ?? null,
    colours, scales,
  };
}

/** Linear keys at `t`, clamped at both ends (`FUN_00328750` for the scale, `FUN_00328860` for the colour). */
export function keyAt<K extends number[]>(keys: readonly K[], t: number, lane: number): number {
  if (keys.length === 0) return Number.NaN;
  if (t <= keys[0]![0]!) return keys[0]![lane]!;
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i]!, p = keys[i - 1]!;
    if (t <= k[0]!) {
      const span = k[0]! - p[0]!;
      const f = span > 0 ? (t - p[0]!) / span : 1;
      return p[lane]! + (k[lane]! - p[lane]!) * f;
    }
  }
  return keys[keys.length - 1]![lane]!;
}

/** A particle's colour at life fraction `t`: the keys, or white with alpha `1 - t` when there are none. */
export function particleColour(s: Pick<ParticleSource, 'colours'>, t: number): [number, number, number, number] {
  if (s.colours.length === 0) return [1, 1, 1, 1 - t];
  return [keyAt(s.colours, t, 1), keyAt(s.colours, t, 2), keyAt(s.colours, t, 3), keyAt(s.colours, t, 4)];
}

/** The size multiplier at `t`: the keys, or 1. */
export function particleScale(s: Pick<ParticleSource, 'scales'>, t: number): number {
  return s.scales.length === 0 ? 1 : keyAt(s.scales, t, 1);
}

/**
 * The camera-distance fade (`FUN_003286d0`) on squared distance: 1 inside, falling linearly in d² to 0 across the far
 * pair; rising across the near pair when there is one (near start is where it is 0).
 */
export function particleFade(s: Pick<ParticleSource, 'nearFade' | 'farFade'>, distance2: number): number {
  let f = 1;
  if (s.farFade) {
    const [a, b] = [s.farFade[0] ** 2, s.farFade[1] ** 2];
    if (distance2 >= b) return 0;
    if (distance2 > a) f *= b > a ? (b - distance2) / (b - a) : 0;
  }
  if (s.nearFade && s.nearFade[1] > 0) {
    const [a, b] = [s.nearFade[0] ** 2, s.nearFade[1] ** 2];
    if (distance2 <= a) return 0;
    if (distance2 < b) f *= (distance2 - a) / (b - a);
  }
  return f;
}

/**
 * The friction factor over `dt` (`FUN_003282b0`): `1 / P(k dt)`, `P(x) = 1 + x/2 + x²/3 + x³/4 + x⁴/5 + x⁵/6 + x⁶`,
 * with `x` halved until it is at most 0.5 and the result squared back as many times.
 */
export function frictionFactor(k: number, dt: number): number {
  let x = k * dt, halvings = 0;
  while (Math.abs(x) > 0.5 && halvings < 30) { x /= 2; halvings++; }
  const p = 1 + x / 2 + x * x / 3 + x ** 3 / 4 + x ** 4 / 5 + x ** 5 / 6 + x ** 6;
  let d = 1 / p;
  for (let i = 0; i < halvings; i++) d *= d;
  return d;
}

/** The context an effect runs in (`FUN_00272bb0`'s typed arguments): 5 a position, 6 a velocity, 7 a direction (a hit's normal). */
export interface EffectContext {
  position?: Vec3 | null;
  velocity?: Vec3 | null;
  normal?: Vec3 | null;
}

const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
const unitOf = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? scale(v, 1 / l) : [0, 0, 0]; };
const reflectOf = (v: Vec3, n: Vec3): Vec3 => { const d = 2 * (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]); return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]]; };

/** A source's velocity of one kind at emission, from its form and the context (`VelocityFrom`); null: the context lacks it. */
export function sourceVelocity(from: VelocityFrom, fixed: Vec3, k: number, unit: boolean, ctx: EffectContext): Vec3 {
  if (from === 'fixed') return fixed;
  if (from === 'normal') return ctx.normal ? scale(ctx.normal, k) : [0, 0, 0];
  if (!ctx.velocity) return [0, 0, 0];
  const v = scale(unit ? unitOf(ctx.velocity) : ctx.velocity, k);
  return from === 'reflected' && ctx.normal ? reflectOf(v, ctx.normal) : v;
}
