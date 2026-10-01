import { polygonNormal, surfaceWord, SURFACE_SIDE, type WorldPoly } from './collision';
import { cellsCovering, type CollisionObject, type CollisionOwner, type Grid } from './grid';
import { modelGate, ALL_LAYERS } from './probe';

/**
 * A segment against the hull (web sprint 2, W2.1; W2.5's shot reuses it): the nearest polygon a segment crosses,
 * over the grid's collision owners in every cell the segment's ground-plane box covers.
 *
 * The engine's segment records are type 2 (`DAT_00416050 = 2` in `FUN_0029bf70`; the camera's four probes) and
 * run through the same `FUN_002d3030` loop the ground probe does (research 23 section 1.1): the model gate, then
 * the surfaces with bit 1 set (`(*(byte *)(surf + 8) & 2) != 0`, `FUN_002d2890` at decomp line 174845). Which count is
 * `DAT_0044d758`'s, which `FUN_002d4fd0` sets:
 *
 * - `0` (the movement's probes): a surface with bit 18 (`m_cameratype` bit 0) is skipped -- `SURFACE_SKIP`.
 * - `1` (the camera's probes when not peeking: `FUN_0029bf70` calls `FUN_002d4fd0(DAT_004161c0 == 0)`): a surface
 *   with **bit 19** (`m_cameratype` bit 1) is skipped instead (`((byte10 & 0xf) >> 2) & 2`: `FUN_002d2890` decomp
 *   174852, `FUN_002d3030` 175304; `FUN_002d4fd0` at 176016 is the setter) and the material's flag word
 *   (`0x44f358[m]`) is consulted -- so the bit-18 polygons the mover walks through reach the camera's probes. The
 *   main probe's picker `FUN_0029cd20` then passes over one whose `m_cameratype` is exactly 1 within 2.75 of the
 *   probe's start (the target): those stop the camera only further out (`playerCamera.ts`). `isCameraSurface` is
 *   the surface test; the material half is not modelled (the SOILS table is not in a map's archive, as `probe.ts`
 *   says of its own material test).
 *
 * `FUN_002d4cc0` (decomp 175904) hands back the record's hit nearest its start (its loop over the hit list by
 * squared distance from `rec+4`); `segmentHit` returns that one, `segmentHits` the whole list nearest first, for a
 * picker of its own (`FUN_0029cd20`). The list here is every polygon crossed; the engine's keeps the first per model
 * in surface order (research 23 section 1.1) -- the same nearest hit, a shorter list [reading]. Polygons are taken as convex, as `probe.ts` takes them.
 */

/** Surface word bit 19 (`m_cameratype` bit 1): what the camera's probes skip (`DAT_0044d758 == 1`). */
export const CAMERA_SKIP = 1 << 19;

/** A surface the camera's segment probes test: bit 1 set, bit 19 clear (the header). */
export const isCameraSurface = (p: WorldPoly): boolean =>
  (surfaceWord(p) & (SURFACE_SIDE | CAMERA_SKIP)) === SURFACE_SIDE;

/** Where a segment first meets the hull. */
export interface SegmentHit {
  /** The crossing point, world space. */
  point: [number, number, number];
  /** How far along the segment, 0 at `a` and 1 at `b`. */
  t: number;
  /** The polygon's unit normal (as Newell's sum gives it: either side). */
  normal: [number, number, number];
  poly: WorldPoly;
  owner: CollisionOwner;
}

type V3 = readonly [number, number, number];

/** Whether `q` (on the polygon's plane) is inside the convex polygon, edges included, tested on the plane's widest projection. */
function inside(points: Float32Array, n: V3, q: V3): boolean {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  // Drop the normal's largest axis: (u, v) are the other two.
  const [iu, iv]: [0 | 1 | 2, 0 | 1 | 2] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [0, 2] : [0, 1];
  const count = points.length / 3;
  let left = false, right = false;
  for (let i = 0; i < count; i++) {
    const a = i * 3, b = ((i + 1) % count) * 3;
    const eu = points[b + iu]! - points[a + iu]!, ev = points[b + iv]! - points[a + iv]!;
    const cross = eu * (q[iv] - points[a + iv]!) - ev * (q[iu] - points[a + iu]!);
    if (cross > 1e-7) left = true;
    else if (cross < -1e-7) right = true;
    if (left && right) return false;
  }
  return true;
}

/** The segment's crossing of one polygon, as a fraction along a->b, or null. */
function crossing(poly: WorldPoly, a: V3, d: V3): { t: number; normal: [number, number, number] } | null {
  const n = polygonNormal(poly.points);
  if (n === null) return null;
  const denom = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
  if (Math.abs(denom) < 1e-12) return null;                                  // parallel: the plane is never crossed
  const p = poly.points;
  const t = (n[0] * (p[0]! - a[0]) + n[1] * (p[1]! - a[1]) + n[2] * (p[2]! - a[2])) / denom;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  const q: V3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
  return inside(p, n, q) ? { t: Math.min(1, Math.max(0, t)), normal: n } : null;
}

/**
 * The nearest polygon the segment a->b crosses, or null: every collision owner linked into the cells the segment's
 * ground-plane box covers, gated (`modelGate`, all layers), its footprint against the segment's box, then each
 * polygon `accept` passes (every polygon by default; the camera passes `isCameraSurface`).
 */
export function segmentHit(
  grid: Grid, a: V3, b: V3, accept: (p: WorldPoly) => boolean = () => true, layers: number = ALL_LAYERS,
): SegmentHit | null {
  return segmentHits(grid, a, b, accept, layers)[0] ?? null;
}

/** Every polygon the segment a->b crosses, nearest `a` first (`segmentHit`'s candidates). */
export function segmentHits(
  grid: Grid, a: V3, b: V3, accept: (p: WorldPoly) => boolean = () => true, layers: number = ALL_LAYERS,
): SegmentHit[] {
  const box = { minX: Math.min(a[0], b[0]), minZ: Math.min(a[2], b[2]), maxX: Math.max(a[0], b[0]), maxZ: Math.max(a[2], b[2]) };
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const seen = new Set<CollisionObject>();
  const out: SegmentHit[] = [];
  for (const cell of cellsCovering(grid, box)) {
    for (const atom of cell.atoms) {
      const object = atom.object;
      if (object.kind !== 'collision' || seen.has(object)) continue;
      seen.add(object);
      const f = object.footprint;
      if (f.maxX < box.minX || f.minX > box.maxX || f.maxZ < box.minZ || f.minZ > box.maxZ) continue;
      if (!modelGate(object.owner, layers)) continue;
      for (const poly of object.polys) {
        if (!accept(poly)) continue;
        const c = crossing(poly, a, d);
        if (c === null) continue;
        out.push({ point: [a[0] + d[0] * c.t, a[1] + d[1] * c.t, a[2] + d[2] * c.t], t: c.t, normal: c.normal, poly, owner: object.owner });
      }
    }
  }
  return out.sort((x, y) => x.t - y.t);
}
