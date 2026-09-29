import { THROW_GRAVITY, type V3 } from './projectile';

/**
 * The yellow arc SOCOM II draws while a grenade is held (web/docs/research/85 §11). `CSealCtrl`'s draw method
 * (`FUN_005970b0`, the player controller's vtable slot at 0x6694ec) works out the throw exactly as the release will
 * (`GetThrowAnim`'s table point, `ComputeMaxVel`, the aim plus `ComputeElevOfs`, the power's speed, the aimed
 * correction) and hands the hand's world point and the velocity to `ai::DrawFunc<CDynGrenade>` (`FUN_00598860`),
 * which draws the analytic parabola `p + v t + (0, -49 t^2, 0)` as a strip of line segments. It is not a trace: no
 * hull query, no bounce, no impact marker (the impact point `FUN_005970b0` works out at sp+0xb0 is never read).
 */

/**
 * The arc's `.data` and literals:
 * - `segments`: `DAT_006505f0` = 100 (and the arc is drawn only while it is not 0);
 * - `start`: the first time, seconds, the `lui 0xbf80` at 0x597498 (`-1.0`): the arc begins a second *before* the
 *   hand, back down the parabola (under the ground behind the SEAL, where the depth test hides it);
 * - `endScale`: `DAT_00650608` = 2, times `ComputeTimeToImpact`'s time to fall to the feet's level;
 * - `alpha`: `DAT_006505f8` 0.75 at the start to `DAT_00650600` 0.1 at the end (`FUN_006000f0`, `FUN_006000a0`),
 *   clamped to 0..1 (0x650d70, 0x650d78);
 * - `color`: (0.78, 0.78, 0) (`0x3f47ae14`, 0x59743c) -- the yellow; `nightColor` (1, 1, 0.8) in view mode 3, the
 *   night vision (`FUN_005c80f0`).
 */
export const THROW_ARC = {
  segments: 100,
  start: -1,
  endScale: 2,
  alpha: [0.75, 0.1] as readonly [number, number],
  color: [Math.fround(0.78), Math.fround(0.78), 0] as readonly [number, number, number],
  nightColor: [1, 1, Math.fround(0.8)] as readonly [number, number, number],
};
export type ThrowArcParams = typeof THROW_ARC;

/** The arc's point `t` seconds from the hand: `p + v t + (0, -49 t^2, 0)` (the `-49` is `0xc2440000`). */
export function arcPoint(from: readonly number[], vel: readonly number[], t: number): V3 {
  return [from[0]! + vel[0]! * t, from[1]! + vel[1]! * t - (THROW_GRAVITY / 2) * t * t, from[2]! + vel[2]! * t];
}

/**
 * `ComputeTimeToImpact`'s time (`FUN_0050de20` with -49, `FUN_00575c50` the max): the later root of
 * `-49 t^2 + vy t + h = 0`, the fall from the hand `h` up to the feet's level; 0 when there is none.
 */
export function throwArcTime(vy: number, h: number): number {
  const a = -THROW_GRAVITY / 2, disc = vy * vy - 4 * a * h;
  if (disc < 0) return 0;
  const r = Math.sqrt(disc);
  return Math.max((-vy + r) / (2 * a), (-vy - r) / (2 * a));
}

export interface ThrowArc {
  /** The strip's points: the first at `t0`, then one a step, the last at `t1` (empty when `t0 >= t1`). */
  points: V3[];
  /** Each segment's alpha (`points[i]` to `points[i + 1]`): both ends take the alpha of its far end's step. */
  alphas: number[];
  t0: number;
  t1: number;
}

/**
 * `ai::DrawFunc<CDynGrenade>` (`FUN_00598860`) over `FUN_005970b0`'s times: from `start` to `endScale` times the fall
 * to the feet (`h` the hand's height over them), `segments` steps. The step is a float added up (`add.s` at
 * 0x598a9c) while under 1, so 100 steps of 0.01 stop at 0.99999934 and a last segment closes on `t1`: 101 segments.
 * Each segment is one colour, the alpha of its far end (`FUN_006000a0(f)` before `FUN_005fff40`).
 */
export function throwArc(from: readonly number[], vel: readonly number[], h: number, params: ThrowArcParams = THROW_ARC): ThrowArc {
  const t0 = params.start, t1 = throwArcTime(vel[1]!, h) * params.endScale;
  const out: ThrowArc = { points: [], alphas: [], t0, t1 };
  if (params.segments === 0 || !(t0 < t1)) return out;
  const alpha = (f: number): number => Math.min(1, Math.max(0, params.alpha[1] * f + params.alpha[0] * (1 - f)));
  out.points.push(arcPoint(from, vel, t0));
  const step = Math.fround(1 / params.segments);
  for (let f = step; f < 1; f = Math.fround(f + step)) {
    out.points.push(arcPoint(from, vel, t1 * f + t0 * (1 - f)));
    out.alphas.push(alpha(f));
  }
  out.points.push(arcPoint(from, vel, t1));
  out.alphas.push(alpha(1));
  return out;
}
