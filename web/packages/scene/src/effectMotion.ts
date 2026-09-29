import type { CmdBytes, Vec3 } from './effects';

/**
 * `OBJECT_MOTION` (21): a node thrown -- the ejected casing (`shell_eject`), the chunks, a dropped item -- decoded from
 * its begin `FUN_00262690` (decomp 110463) and tick `FUN_00261370` (decomp 109820); web/docs/research/89 §2.
 *
 * Launch (flag 0x10): an azimuth and a zenith in degrees, a speed and an acceleration, each plus its range times a
 * random in [0, 1) (block A at the s16 offset +0x20, block B at +0x22). The direction is `FUN_0025cb00`'s (decomp
 * 107097), with `e = zenith / 90`: `(-sin(az) (1 - |e|), e, -cos(az) (1 - |e|))` -- **not normalised** -- times the
 * speed, in the frame of the node at +9 (the caller's node for the casing), plus the caller's velocity times +0x18
 * (flag 0x800). Gravity is +0x10 times the zAnim main gravity (-98 on every archive), with a terminal-velocity table
 * while falling (flag 0x2, k at +0x14). The tick is explicit Euler: the position moves by `v dt`, then `v += a dt`.
 *
 * Collision (flags 0x40, a floor probe; 0x80, a swept line probe): at a hit the velocity is reflected about the
 * surface normal and scaled -- the floor's by `1 - (1 - e) |v̂.n|`, the line's by `e` -- where `e` is the material
 * table's bounce coefficient for the polygon's material, or the default at +0x60. At each bounce the entry's sound
 * plays (flag 0x20). **It is done** -- and the casing, whose sequence hides it next, is gone -- when the speed falls
 * under `0.08 |a|` at a bounce, or at the lifetime (+0x7c, flag 0x1).
 *
 * Tumble (flag 0x400): the euler angles (+0x68, from 0: the node's copied rotation is overwritten) grow by
 * `dt rate (n̂z, 0, -n̂x)`, n̂ the velocity's direction, the rate by its acceleration each tick (the s16 at +0x74).
 */

export const MOTION = {
  LIFETIME: 0x1, TERMINAL: 0x2, FIXED_LAUNCH: 0x8, RANDOM_LAUNCH: 0x10, IMPACT_SOUND: 0x20, FLOOR_PROBE: 0x40,
  LINE_PROBE: 0x80, ANGULAR: 0x100, ROLL: 0x200, TUMBLE: 0x400, CALLER_VELOCITY: 0x800,
} as const;

/** One material's bounce: the polygon's material index, its sound (or null) and its coefficient (or null: the default). */
export interface MotionMaterial { material: number; sound: string | null; bounce: number | null; refSpeed: number | null; sequence: string | null }

export interface ObjectMotion {
  flags: number;
  /** The node moved: 0xF9 (-7) the animation's root instance, 0xFA (-6) the caller's node, else a node reference. */
  node: number;
  /** The launch frame's node, 0 the world. */
  frame: number;
  /** Block A: azimuth and zenith (degrees), speed (units/s), acceleration; block B: their random ranges. */
  launch: { azimuth: number; zenith: number; speed: number; accel: number };
  range: { azimuth: number; zenith: number; speed: number; accel: number };
  /** +0x10: times the main gravity (-98). */
  gravityScale: number;
  /** +0x14: the terminal-velocity table's k (flag 0x2). */
  terminal: number;
  /** +0x18: times the caller's velocity (flag 0x800). */
  callerVelocity: number;
  /** +0x60: the bounce coefficient when the material table has none. */
  bounce: number;
  /** +0x64: the ground tolerance, a fraction of the object's height. */
  tolerance: number;
  /** +0x7c: seconds (flag 0x1). */
  lifetime: number;
  /** +0x0c: the impact speed at which a bounce's sound is at full volume (0: always full). */
  refSpeed: number;
  /** +0x0b: the bounce sound when the material has none. */
  sound: string | null;
  /** The s16 at +0x74's block: the tumble rate (rad/s) and its acceleration (rad/s²). */
  tumble: { rate: number; accel: number } | null;
  /** The s16 at +0x76's block: an angular velocity (rad/s, xyz) and its acceleration (flag 0x100). */
  angular: { w: Vec3; accel: Vec3 } | null;
  materials: MotionMaterial[];
}

const nameOr = (names: readonly string[], i: number): string | null => (i > 0 && names[i] ? names[i]! : null);

export function decodeObjectMotion(c: CmdBytes, names: readonly string[]): ObjectMotion {
  const a = c.i16(0x20), b = c.i16(0x22), spin = c.i16(0x74), ang = c.i16(0x76);
  const block = (o: number) => ({ azimuth: c.f32(o), zenith: c.f32(o + 4), speed: c.f32(o + 8), accel: c.f32(o + 12) });
  const zero = { azimuth: 0, zenith: 0, speed: 0, accel: 0 };
  const count = c.i8(0x1d), table = c.i16(0x1e);
  const materials: MotionMaterial[] = [];
  for (let i = 0; i < count && table > 0; i++) {
    const o = table + 12 * i, code = c.u32(o);
    const material = (code >>> 2) & 0xff;
    if (materials.some((m) => m.material === material)) continue;          // the first match wins
    materials.push({
      material, sound: nameOr(names, (code >>> 10) & 0xff), sequence: nameOr(names, (code >>> 18) & 0xff),
      refSpeed: (code & 1) !== 0 ? c.f32(o + 4) : null, bounce: (code & 2) !== 0 ? c.f32(o + 8) : null,
    });
  }
  return {
    flags: c.u32(4), node: c.i8(8), frame: c.i8(9),
    launch: a > 0 ? block(a) : zero, range: b > 0 ? block(b) : zero,
    gravityScale: c.f32(0x10), terminal: c.f32(0x14), callerVelocity: c.f32(0x18),
    bounce: c.f32(0x60), tolerance: c.f32(0x64), lifetime: c.f32(0x7c), refSpeed: c.f32(0x0c),
    sound: nameOr(names, c.u8(0x0b)),
    tumble: spin > 0 ? { rate: c.f32(spin), accel: c.f32(spin + 4) } : null,
    angular: ang > 0 ? { w: c.vec3(ang), accel: c.vec3(ang + 12) } : null,
    materials,
  };
}

/** `FUN_0025cb00`: the launch direction of an azimuth and a zenith in degrees -- not normalised. */
export function launchDirection(azimuthDeg: number, zenithDeg: number): Vec3 {
  const e = zenithDeg / 90, h = 1 - Math.abs(e), az = (azimuthDeg * Math.PI) / 180;
  return [-Math.sin(az) * h, e, -Math.cos(az) * h];
}

/** The terminal-velocity factor (`FUN_0026b0d0`, table built by `FUN_0026b1a0`): 41 steps of `1 - (e^x - 1)/(e^10 - 1)`. */
export function terminalFactor(vy: number, k: number): number {
  const i = Math.min(40, Math.max(0, Math.trunc(40 * vy * k)));
  return 1 - (Math.exp(0.25 * i) - 1) / (Math.exp(10) - 1);
}

/** What a probe found: the point, the surface normal (unit, facing the mover) and the polygon's material. */
export interface MotionHit { point: Vec3; normal: Vec3; material: number }

/** The world a thrown node moves in: a swept segment test, and the first surface under a point. */
export interface MotionWorld {
  segment(a: Vec3, b: Vec3): MotionHit | null;
  floor(from: Vec3, depth: number): MotionHit | null;
}

/** A thrown node's state, stepped by `stepMotion`. */
export interface MotionState {
  position: Vec3;
  velocity: Vec3;
  accel: Vec3;
  /** Euler angles (radians), the tumble's. */
  euler: Vec3;
  tumbleRate: number;
  /** The gravity's acceleration, `+0x10` times the main gravity: what a floor bounce resets `accel.y` to. */
  gravityY: number;
  elapsed: number;
  done: boolean;
  /** Half the object's height and the ground tolerance (`+0x64` of the height). */
  halfHeight: number;
  tolerance: number;
}

/** The launch (begin): `random` answers [0, 1). `frame` rotates a local direction into the world (row-major 3x3 rows). */
export function launchMotion(
  m: ObjectMotion, at: Vec3, frame: readonly Vec3[] | null, random: () => number, gravity: number, height: number,
  callerVelocity: Vec3 = [0, 0, 0],
): MotionState {
  let v: Vec3 = [0, 0, 0];
  if ((m.flags & MOTION.RANDOM_LAUNCH) !== 0) {
    const az = m.launch.azimuth + m.range.azimuth * random();
    const zen = m.launch.zenith + m.range.zenith * random();
    const speed = m.launch.speed + m.range.speed * random();
    const d = launchDirection(az, zen);
    const local: Vec3 = [d[0] * speed, d[1] * speed, d[2] * speed];
    v = frame ? rotate(frame, local) : local;
  }
  if ((m.flags & MOTION.CALLER_VELOCITY) !== 0) {
    v = [v[0] + callerVelocity[0] * m.callerVelocity, v[1] + callerVelocity[1] * m.callerVelocity, v[2] + callerVelocity[2] * m.callerVelocity];
  }
  return {
    position: [...at], velocity: v, accel: [0, m.gravityScale * gravity, 0], euler: [0, 0, 0],
    tumbleRate: m.tumble?.rate ?? 0, gravityY: m.gravityScale * gravity, elapsed: 0, done: false,
    halfHeight: 0.5 * Math.abs(height), tolerance: Math.abs(height) * m.tolerance,
  };
}

/** `v` through the rows of a row-vector 3x3 (`v * M`, the engine's convention). */
function rotate(rows: readonly Vec3[], v: Vec3): Vec3 {
  return [
    v[0] * rows[0]![0] + v[1] * rows[1]![0] + v[2] * rows[2]![0],
    v[0] * rows[0]![1] + v[1] * rows[1]![1] + v[2] * rows[2]![1],
    v[0] * rows[0]![2] + v[1] * rows[1]![2] + v[2] * rows[2]![2],
  ];
}

const len = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const reflect = (v: Vec3, n: Vec3): Vec3 => { const d = 2 * dot(v, n); return [v[0] - d * n[0], v[1] - d * n[1], v[2] - d * n[2]]; };

/** What a step did: the bounces, each with its material and the impact speed (for the sound). */
export interface MotionBounce { point: Vec3; material: number; speed: number; entry: MotionMaterial | null }

/**
 * One tick of `dt` seconds (`FUN_00261370`): the lifetime clip, the probes and bounces, the Euler step, the tumble.
 * Mutates `s`; returns the bounces.
 */
export function stepMotion(m: ObjectMotion, s: MotionState, dt: number, world: MotionWorld | null): MotionBounce[] {
  const bounces: MotionBounce[] = [];
  if (s.done) return bounces;
  if ((m.flags & MOTION.LIFETIME) !== 0 && m.lifetime < s.elapsed + dt) {
    dt = Math.max(0, m.lifetime - s.elapsed);
    s.done = true;
  }
  s.elapsed += dt;
  const moves = (m.flags & (MOTION.FIXED_LAUNCH | MOTION.RANDOM_LAUNCH | MOTION.CALLER_VELOCITY)) !== 0;
  if (!moves) return bounces;
  let remaining = dt;
  let disp: Vec3 = [s.velocity[0] * dt, s.velocity[1] * dt, s.velocity[2] * dt];
  const entryOf = (material: number): MotionMaterial | null => m.materials.find((e) => e.material === material) ?? null;
  const coefficient = (material: number): number => entryOf(material)?.bounce ?? m.bounce;
  const atRest = (): boolean => len(s.velocity) < 0.08 * len(s.accel);
  let guard = 4;
  if (world && (m.flags & (MOTION.FLOOR_PROBE | MOTION.LINE_PROBE)) !== 0) {
    while (remaining > 0.01 && guard-- > 0 && !s.done) {
      const horiz2 = disp[0] * disp[0] + disp[2] * disp[2];
      const line = (m.flags & MOTION.LINE_PROBE) !== 0 && (s.velocity[1] > 0 || Math.sqrt(horiz2) > Math.abs(disp[1]) || horiz2 > 0.1);
      if (line) {
        const end: Vec3 = [s.position[0] + disp[0], s.position[1] + disp[1], s.position[2] + disp[2]];
        const hit = world.segment(s.position, end);
        if (!hit) break;
        const speed = len(s.velocity), e = coefficient(hit.material);
        const r = reflect(s.velocity, hit.normal);
        s.velocity = [r[0] * e, r[1] * e, r[2] * e];
        const span = len(disp);
        const back = span > 1e-9 ? s.halfHeight / span : 0;
        const travelled = span > 1e-9 ? Math.hypot(hit.point[0] - s.position[0], hit.point[1] - s.position[1], hit.point[2] - s.position[2]) / span : 1;
        s.position = [hit.point[0] - disp[0] * back, hit.point[1] - disp[1] * back, hit.point[2] - disp[2] * back];
        bounces.push({ point: [...hit.point], material: hit.material, speed, entry: entryOf(hit.material) });
        const falling = s.velocity[1] <= 0 || r[1] <= 0;
        if (hit.normal[1] > 0.3 && falling && atRest()) { s.done = true; disp = [0, 0, 0]; break; }
        remaining *= Math.max(0, 1 - travelled);
        disp = [s.velocity[0] * remaining, s.velocity[1] * remaining, s.velocity[2] * remaining];
        continue;
      }
      if ((m.flags & MOTION.FLOOR_PROBE) === 0 || s.velocity[1] >= 0) break;
      const hit = world.floor([s.position[0], s.position[1] + s.halfHeight, s.position[2]], s.halfHeight + Math.abs(disp[1]) + 1);
      if (!hit) break;
      if (s.position[1] < hit.point[1]) { s.position = [...hit.point]; s.done = true; disp = [0, 0, 0]; break; }
      const ground = hit.point[1] + s.tolerance;
      if (s.position[1] + disp[1] > ground) break;
      remaining *= disp[1] !== 0 ? 1 - (ground - s.position[1]) / disp[1] : 0;
      const speed = len(s.velocity), e = coefficient(hit.material);
      const r = reflect(s.velocity, hit.normal);
      const lr = len(r) || 1;
      const k = 1 - (1 - e) * Math.abs(dot(r, hit.normal) / lr);
      s.velocity = [r[0] * k, r[1] * k, r[2] * k];
      s.position = [hit.point[0], hit.point[1] + s.tolerance, hit.point[2]];
      bounces.push({ point: [...hit.point], material: hit.material, speed, entry: entryOf(hit.material) });
      if (atRest()) { s.done = true; disp = [0, 0, 0]; break; }
      disp = [s.velocity[0] * remaining, s.velocity[1] * remaining, s.velocity[2] * remaining];
      s.accel = [s.accel[0], s.gravityY, s.accel[2]];
    }
  }
  s.position = [s.position[0] + disp[0], s.position[1] + disp[1], s.position[2] + disp[2]];
  const t = bounces.length > 0 ? remaining : dt;
  if ((m.flags & MOTION.TERMINAL) === 0 || s.velocity[1] >= 0) {
    s.velocity = [s.velocity[0] + s.accel[0] * t, s.velocity[1] + s.accel[1] * t, s.velocity[2] + s.accel[2] * t];
  } else {
    s.velocity = [s.velocity[0] + s.accel[0] * dt, s.velocity[1] + dt * s.accel[1] * terminalFactor(s.velocity[1], m.terminal), s.velocity[2] + s.accel[2] * dt];
  }
  if ((m.flags & MOTION.TUMBLE) !== 0) {
    const l = len(s.velocity);
    if (l > 1e-9) {
      s.euler = [s.euler[0] + dt * s.tumbleRate * (s.velocity[2] / l), s.euler[1], s.euler[2] - dt * s.tumbleRate * (s.velocity[0] / l)];
    }
    s.tumbleRate += (m.tumble?.accel ?? 0) * dt;
  }
  return bounces;
}
