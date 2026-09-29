import type { Stance } from '../mover';
import { CROUCH_HEIGHT, HEAD_HEIGHT, PRONE_HEIGHT, STANDING_HEIGHT } from '../stature';
import { PART } from './damage';

/**
 * A SEAL's hit volumes on the server (web sprint 3, M6; W3.R4). The game hits the skeleton node the round's collision
 * meets (`FUN_005abbc0`, research 91 section 1.3): head/neck, arms, spine and hips, legs; hands, feet and scapulas take
 * nothing. HIT_VOLUMES_PLACEHOLDER: until the server poses the skeleton, each part is a capsule laid on the stance's
 * measured heights (`./stature`: 19.6 standing, 12.4 crouched, 3 prone, the head 18.3), turned by the facing.
 */

export type V3 = [number, number, number];
export interface Capsule { part: number; a: V3; b: V3; r: number }

/** Body-frame points: x right, y up, z forward (the facing), to the world at the feet and yaw (forward is (-sin, -cos)). */
function toWorld(feet: readonly number[], yaw: number, p: V3): V3 {
  const y = (yaw * Math.PI) / 180, fx = -Math.sin(y), fz = -Math.cos(y), rx = Math.cos(y), rz = -Math.sin(y);
  return [feet[0]! + p[0] * rx + p[2] * fx, feet[1]! + p[1], feet[2]! + p[0] * rz + p[2] * fz];
}

const UPRIGHT: readonly [number, V3, V3, number][] = [
  // part, a, b (body frame, heights as fractions of the standing body), radius
  [PART.HEAD, [0, HEAD_HEIGHT / STANDING_HEIGHT, 0], [0, HEAD_HEIGHT / STANDING_HEIGHT, 0], 1.4],
  [PART.BODY, [0, 0.47, 0], [0, 0.84, 0], 2.4],
  [PART.RARM, [2.6, 0.84, 0.3], [2.9, 0.58, 1.2], 1.0],
  [PART.LARM, [-2.6, 0.84, 0.3], [-2.9, 0.58, 1.2], 1.0],
  [PART.RLEG, [1.1, 0.47, 0], [1.2, 0.04, 0], 1.2],
  [PART.LLEG, [-1.1, 0.47, 0], [-1.2, 0.04, 0], 1.2],
];

/** The capsules of a SEAL at `feet`, facing `yaw` (degrees), in `posture`. */
export function bodyVolumes(feet: readonly number[], yaw: number, posture: Stance): Capsule[] {
  if (posture === 'prone') {
    const y = PRONE_HEIGHT / 2;
    const v = (part: number, a: V3, b: V3, r: number): Capsule => ({ part, a: toWorld(feet, yaw, a), b: toWorld(feet, yaw, b), r });
    return [
      v(PART.HEAD, [0, y, 8], [0, y, 8], 1.4),
      v(PART.BODY, [0, y, -1], [0, y, 6], 1.6),
      v(PART.RARM, [1.8, y, 6], [1.4, y, 10], 0.9),
      v(PART.LARM, [-1.8, y, 6], [-1.4, y, 10], 0.9),
      v(PART.RLEG, [0.9, y, -1], [1.3, y, -9], 1.1),
      v(PART.LLEG, [-0.9, y, -1], [-1.3, y, -9], 1.1),
    ];
  }
  const height = posture === 'crouch' ? CROUCH_HEIGHT : STANDING_HEIGHT;
  return UPRIGHT.map(([part, a, b, r]) => ({
    part, r,
    a: toWorld(feet, yaw, [a[0], a[1] * height, a[2]]),
    b: toWorld(feet, yaw, [b[0], b[1] * height, b[2]]),
  }));
}

/** The body's reach from the feet: a ray that misses this cylinder misses every capsule (a cheap first test). */
export const BODY_REACH = 12, BODY_TOP = STANDING_HEIGHT + 2;

/**
 * Where a ray from `o` along the unit `d` first enters a capsule, as the distance along it; null when it misses within
 * `reach` (or starts inside: a round leaves its own shooter).
 */
export function rayCapsule(o: V3, d: V3, reach: number, c: Capsule): number | null {
  const ba: V3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]];
  const oa: V3 = [o[0] - c.a[0], o[1] - c.a[1], o[2] - c.a[2]];
  const baba = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2];
  const bard = ba[0] * d[0] + ba[1] * d[1] + ba[2] * d[2];
  const baoa = ba[0] * oa[0] + ba[1] * oa[1] + ba[2] * oa[2];
  const rdoa = d[0] * oa[0] + d[1] * oa[1] + d[2] * oa[2];
  const oaoa = oa[0] * oa[0] + oa[1] * oa[1] + oa[2] * oa[2];
  const r2 = c.r * c.r;
  const sphere = (cx: V3): number | null => {
    const oc: V3 = [o[0] - cx[0], o[1] - cx[1], o[2] - cx[2]];
    const b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2];
    const cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r2;
    const h = b * b - cc;
    if (h < 0) return null;
    const t = -b - Math.sqrt(h);
    return t >= 0 && t <= reach ? t : null;
  };
  if (baba < 1e-12) return sphere(c.a);
  const a = baba - bard * bard;
  const b = baba * rdoa - baoa * bard;
  const cc = baba * oaoa - baoa * baoa - r2 * baba;
  const h = b * b - a * cc;
  if (h < 0) return null;
  if (Math.abs(a) > 1e-12) {
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 && t <= reach ? t : null;
  }
  const ends = [sphere(c.a), sphere(c.b)].filter((t): t is number => t !== null);
  return ends.length ? Math.min(...ends) : null;
}

/** The nearest part a ray enters on a body, or null. */
export function rayBody(o: V3, d: V3, reach: number, capsules: readonly Capsule[]): { part: number; t: number } | null {
  let best: { part: number; t: number } | null = null;
  for (const c of capsules) {
    const t = rayCapsule(o, d, reach, c);
    if (t !== null && (!best || t < best.t)) best = { part: c.part, t };
  }
  return best;
}
