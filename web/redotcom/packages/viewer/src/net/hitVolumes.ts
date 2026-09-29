import { sampleClip, transformPoint, type MotionClip, type Skeleton } from '@s2u/scene';
import { writePose } from '../animator';
import type { Stance } from '../mover';
import { CROUCH_HEIGHT, HEAD_HEIGHT, PRONE_HEIGHT, STANDING_HEIGHT } from '../stature';
import { PART } from './damage';

/**
 * A SEAL's hit volumes on the server (web sprint 3, M6; W3.R4). The game hits the skeleton node the round's collision
 * meets (`FUN_005abbc0`, research 91 section 1.3): head/neck -> HEAD; rbicep, rforearm -> RARM; lbicep, lforearm -> LARM;
 * spinehi, spinelo, hips -> BODY; rthigh, rcalf -> RLEG; lthigh, lcalf -> LLEG; hands, feet and scapulas take nothing.
 *
 * `skeletonVolumes` poses the SEAL's own skeleton (`CLIB_GEO.ZED`, research 78 section 3) at a stance's idle key, the
 * animator's way (`writePose`), and makes each damage bone a capsule from its joint to the next joint of its chain, kept
 * inside the part's bbox along the bone. The
 * radius is measured: each part's `nparams` bbox is the extent of the mesh vertices it moves most (78 section 3), so the
 * capsule's radius is the larger half-extent across the bone and its axis is offset to the bbox's middle. `spinelo`
 * moves no vertex most (an empty bbox): its radius is `SPINELO_RADIUS_PLACEHOLDER`. The body frame is the model's:
 * x right, y up, z behind (the model faces -z), the soles at the origin -- `play.ts` `actorToWorld`'s frame.
 *
 * `placeholderVolumes` is the hand-laid set the server used before (HIT_VOLUMES_PLACEHOLDER): capsules on the stance's
 * measured heights (`./stature`), kept as the fallback when a map's skeleton did not load.
 */

export type V3 = [number, number, number];
export interface Capsule { part: number; a: V3; b: V3; r: number }
/** A body's capsules per posture, in the body frame (`skeletonVolumes` at each idle). */
export type StanceVolumes = Readonly<Record<Stance, readonly Capsule[]>>;

/**
 * `spinelo`'s radius: its bbox is empty (it moves no vertex most), so none is measured. 2.0 sits between the hips'
 * measured half-depth (1.65) and `spinehi`'s (2.1), the two parts it joins. A placeholder.
 */
export const SPINELO_RADIUS_PLACEHOLDER = 2.0;

/** A damage bone: its part, and the next joint of its chain (none: the capsule is the bbox's own long axis). */
interface DamageBone { part: number; bone: string; to?: string; radius?: number }
export const DAMAGE_BONES: readonly DamageBone[] = [
  { part: PART.HEAD, bone: 'neck', to: 'head' },
  { part: PART.HEAD, bone: 'head' },
  { part: PART.BODY, bone: 'hips' },
  { part: PART.BODY, bone: 'spinelo', to: 'spinehi', radius: SPINELO_RADIUS_PLACEHOLDER },
  { part: PART.BODY, bone: 'spinehi', to: 'neck' },
  { part: PART.RARM, bone: 'rbicep', to: 'rforearm' },
  { part: PART.RARM, bone: 'rforearm', to: 'rhand' },
  { part: PART.LARM, bone: 'lbicep', to: 'lforearm' },
  { part: PART.LARM, bone: 'lforearm', to: 'lhand' },
  { part: PART.RLEG, bone: 'rthigh', to: 'rcalf' },
  { part: PART.RLEG, bone: 'rcalf', to: 'rfoot' },
  { part: PART.LLEG, bone: 'lthigh', to: 'lcalf' },
  { part: PART.LLEG, bone: 'lcalf', to: 'lfoot' },
];

/** Poses `skeleton` at `clip`'s key `frame` (the bind pose without a clip), runs `read`, and puts the bind back. */
function posed<T>(skeleton: Skeleton, clip: MotionClip | null, frame: number, read: () => T): T {
  if (clip) writePose(skeleton, sampleClip(clip, frame / clip.rate, { loop: false }).parts);
  else skeleton.resetToBind();
  try { return read(); } finally { skeleton.resetToBind(); }
}

/** A bone's capsule in its own frame: [a, b, r], from its bbox and the axis to its next joint (null: the bbox's). */
function fit(bbox: Float32Array, axis: V3 | null, radius: number | undefined): [V3, V3, number] {
  const ext = [0, 1, 2].map((i) => bbox[3 + i]! - bbox[i]!), mid = [0, 1, 2].map((i) => (bbox[3 + i]! + bbox[i]!) / 2);
  const along = (v: readonly number[]): number => v.reduce((k, x, i) => (Math.abs(x) > Math.abs(v[k]!) ? i : k), 0);
  const k = axis ? along(axis) : along(ext);
  const r = radius ?? Math.max(...ext.map((e, i) => (i === k ? 0 : e / 2)));
  if (axis) {
    const o: V3 = [mid[0]!, mid[1]!, mid[2]!];
    o[k] = 0;
    // Joint to next joint, kept inside the bbox along the bone (the caps included): the chest's wide radius must not
    // round over the neck into the head's height. A part with an empty bbox is not clamped.
    let t0 = 0, t1 = 1;
    const ak = axis[k]!;
    if (ext[k]! > 0 && Math.abs(ak) > 1e-9) {
      let lo = (bbox[k]! + r) / ak, hi = (bbox[3 + k]! - r) / ak;
      if (lo > hi) [lo, hi] = [hi, lo];
      t0 = Math.max(0, lo);
      t1 = Math.min(1, hi);
      if (t0 > t1) t0 = t1 = Math.min(1, Math.max(0, mid[k]! / ak));
    }
    const at = (t: number): V3 => [o[0] + axis[0] * t, o[1] + axis[1] * t, o[2] + axis[2] * t];
    return [at(t0), at(t1), r];
  }
  const half = Math.max(0, ext[k]! / 2 - r);
  const a: V3 = [mid[0]!, mid[1]!, mid[2]!], b: V3 = [mid[0]!, mid[1]!, mid[2]!];
  a[k] = a[k]! - half;
  b[k] = b[k]! + half;
  return [a, b, r];
}

const cache = new WeakMap<Skeleton, Map<MotionClip | null, Map<number, Capsule[]>>>();

/**
 * The body-frame capsules of `skeleton` posed at `clip`'s key `frame` (0 by default; the bind pose when `clip` is
 * null), one per damage bone the skeleton has. Cached per skeleton, clip and frame: the result is shared, do not mutate.
 */
export function skeletonVolumes(skeleton: Skeleton, clip: MotionClip | null, frame = 0): Capsule[] {
  let byClip = cache.get(skeleton);
  if (!byClip) cache.set(skeleton, byClip = new Map());
  let byFrame = byClip.get(clip);
  if (!byFrame) byClip.set(clip, byFrame = new Map());
  const have = byFrame.get(frame);
  if (have) return have;
  const out = posed(skeleton, clip, frame, () => {
    const caps: Capsule[] = [];
    for (const d of DAMAGE_BONES) {
      const i = skeleton.indexOf(d.bone);
      if (i < 0) continue;
      const to = d.to ? skeleton.indexOf(d.to) : -1;
      const t = to >= 0 ? skeleton.local[to]! : null;
      const [a, b, r] = fit(skeleton.parts[i]!.bbox, t ? [t[12]!, t[13]!, t[14]!] : null, d.radius);
      const w = skeleton.world[i]!;
      caps.push({ part: d.part, a: transformPoint(w, ...a), b: transformPoint(w, ...b), r });
    }
    return caps;
  });
  byFrame.set(frame, out);
  return out;
}

/** A bone's bbox middle, body frame, posed at `clip`'s key `frame`: where a part's mesh is (the test's hand). */
export function boneCentre(skeleton: Skeleton, clip: MotionClip | null, bone: string, frame = 0): V3 {
  const p = skeleton.part(bone);
  return posed(skeleton, clip, frame, () => transformPoint(skeleton.world[p.index]!,
    (p.bbox[0]! + p.bbox[3]!) / 2, (p.bbox[1]! + p.bbox[4]!) / 2, (p.bbox[2]! + p.bbox[5]!) / 2));
}

/** Each posture's volumes: the skeleton at its idle (`SimSkeleton.idles`; the bind pose where the idle is missing). */
export function stanceVolumes(body: { skeleton: Skeleton; idles: Readonly<Record<Stance, MotionClip | null>> }): StanceVolumes {
  return {
    stand: skeletonVolumes(body.skeleton, body.idles.stand),
    crouch: skeletonVolumes(body.skeleton, body.idles.crouch),
    prone: skeletonVolumes(body.skeleton, body.idles.prone),
  };
}

/** A body-frame point (x right, y up, z behind) to the world at the feet and yaw: `play.ts` `actorToWorld`. */
function actorToWorld(feet: readonly number[], yaw: number, v: V3): V3 {
  const r = (yaw * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [feet[0]! + v[0] * c + v[2] * s, feet[1]! + v[1], feet[2]! - v[0] * s + v[2] * c];
}

/**
 * The capsules of a SEAL at `feet`, facing `yaw` (degrees), in `posture`: the skeleton's (`volumes`, from
 * `stanceVolumes`) placed at the feet and turned by the yaw, or `placeholderVolumes` when no skeleton was loaded.
 */
export function bodyVolumes(feet: readonly number[], yaw: number, posture: Stance, volumes?: StanceVolumes | null): Capsule[] {
  if (!volumes) return placeholderVolumes(feet, yaw, posture);
  return volumes[posture].map((c) => ({ part: c.part, r: c.r, a: actorToWorld(feet, yaw, c.a), b: actorToWorld(feet, yaw, c.b) }));
}

/** Body-frame points: x right, y up, z forward (the facing), to the world at the feet and yaw (forward is (-sin, -cos)). */
function toWorld(feet: readonly number[], yaw: number, p: V3): V3 {
  const y = (yaw * Math.PI) / 180, fx = -Math.sin(y), fz = -Math.cos(y), rx = Math.cos(y), rz = -Math.sin(y);
  return [feet[0]! + p[0] * rx + p[2] * fx, feet[1]! + p[1], feet[2]! + p[0] * rz + p[2] * fz];
}

const UPRIGHT: readonly [number, V3, V3, number][] = [
  // HIT_VOLUMES_PLACEHOLDER: part, a, b (body frame, z forward, heights as fractions of the standing body), radius
  [PART.HEAD, [0, HEAD_HEIGHT / STANDING_HEIGHT, 0], [0, HEAD_HEIGHT / STANDING_HEIGHT, 0], 1.4],
  [PART.BODY, [0, 0.47, 0], [0, 0.84, 0], 2.4],
  [PART.RARM, [2.6, 0.84, 0.3], [2.9, 0.58, 1.2], 1.0],
  [PART.LARM, [-2.6, 0.84, 0.3], [-2.9, 0.58, 1.2], 1.0],
  [PART.RLEG, [1.1, 0.47, 0], [1.2, 0.04, 0], 1.2],
  [PART.LLEG, [-1.1, 0.47, 0], [-1.2, 0.04, 0], 1.2],
];

/** HIT_VOLUMES_PLACEHOLDER: the hand-laid capsules on the stance heights, the fallback without a skeleton. */
export function placeholderVolumes(feet: readonly number[], yaw: number, posture: Stance): Capsule[] {
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
