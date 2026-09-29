import { surfaceWord, SURFACE_SKIP, type WorldPoly } from './collision';
import { cellByCoord, type CollisionObject, type CollisionOwner, type Grid } from './grid';
import { modelGate, upNormal, ALL_LAYERS } from './probe';
import type { Pnt3D } from './firePoint';

/**
 * A ray against the hull (W2.4; web/docs/research/79 §4): the first collision polygon a segment meets, found
 * through the grid the probe walks (`grid.ts`, `probe.ts`) -- the cells the segment crosses in the order it crosses
 * them, each cell's collision atoms, each owner's polygons.
 *
 * **Not the engine's routine.** The shot's own intersection -- `CZProjectile_PostTick` 0x3c9fb0,
 * `CZSealBody_HandleWeaponIntersect` 0x549f30, the `DiIntersect` records they fill -- is named but not decompiled
 * here, and `CDIPoly::GetIntersect`'s VU0 edge tests are not decoded (the probe's file says the same of the vertical
 * line). What this takes from the engine is its data and its gate: the hull the probe reads, owned per node and
 * linked into the grid as `CGrid` links it, `modelGate`'s per-model test, and the probe's skip of a surface with
 * bit 18 set (`m_cameratype` bit 0, the doorway volumes: research 23 §1.1, 24 §2). Both faces of a polygon count.
 *
 * **The walk.** The segment's footprint on the ground plane steps from cell to cell (a 2D DDA over the grid's
 * `m_InvCellDim`); a cell off the grid is the edge cell it clamps to, as `CGrid` clamps an object that lies off it,
 * so a polygon filed there is still met. An owner filed in several cells is tested once, at the first, for all of
 * its polygons; the walk stops once the nearest hit so far is no further than the cell being left, since every
 * polygon of a later cell lies further along. That makes the answer the nearest hit whatever order a cell lists
 * its atoms in.
 */

/** What a ray met: how far along it (a distance, whatever length `dir` had), where, and what. */
export interface RayHit {
  t: number;
  point: Pnt3D;
  /** The polygon's unit normal, turned up (`upNormal`): a wall's is horizontal, a floor's +y. */
  normal: Pnt3D;
  poly: WorldPoly;
  owner: CollisionOwner;
}

/** The surfaces a shot meets by default: every polygon but the probe's skipped ones (surface bit 18). */
export const isShotSurface = (p: WorldPoly): boolean => (surfaceWord(p) & SURFACE_SKIP) === 0;

/** An edge's tolerance, in the units of the projected plane: a hit on an edge is a hit. */
const EDGE_EPSILON = 1e-7;
/** A direction this close to parallel with a plane does not cross it. */
const PARALLEL = 1e-12;

/**
 * Whether a point on a convex polygon's plane is inside it, edges included: the polygon and the point projected
 * onto the coordinate plane the normal is most along, and every edge turning the same way round the point.
 */
function inside(points: Float32Array, n: Pnt3D, x: number, y: number, z: number): boolean {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  // Drop the axis the normal is most along; keep the other two as (u, v).
  const [iu, iv] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
  const p = [x, y, z], pu = p[iu]!, pv = p[iv]!;
  const count = points.length / 3;
  let left = false, right = false;
  for (let i = 0; i < count; i++) {
    const a = i * 3, b = ((i + 1) % count) * 3;
    const eu = points[b + iu]! - points[a + iu]!, ev = points[b + iv]! - points[a + iv]!;
    const cross = eu * (pv - points[a + iv]!) - ev * (pu - points[a + iu]!);
    if (cross > EDGE_EPSILON) left = true;
    else if (cross < -EDGE_EPSILON) right = true;
    if (left && right) return false;
  }
  return true;
}

/** Where a unit ray crosses one polygon, as a distance, or null: behind, beyond `limit`, parallel or outside. */
function crossing(poly: WorldPoly, o: Pnt3D, d: Pnt3D, limit: number): { t: number; normal: Pnt3D } | null {
  const n = upNormal(poly);
  if (n === null) return null;
  const denom = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
  if (Math.abs(denom) < PARALLEL) return null;
  const q = poly.points;
  const t = (n[0] * (q[0]! - o[0]) + n[1] * (q[1]! - o[1]) + n[2] * (q[2]! - o[2])) / denom;
  if (!(t >= 0 && t <= limit)) return null;
  if (!inside(q, n, o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2])) return null;
  return { t, normal: [n[0], n[1], n[2]] };
}

/**
 * The first polygon of the hull along the segment from `origin` in direction `dir` (any length) out to `maxDistance`,
 * or null. `accept` picks the surfaces (`isShotSurface` by default); `layers` is the probe's layer mask for the
 * model gate.
 */
export function castRay(
  grid: Grid, origin: Pnt3D, dir: Pnt3D, maxDistance: number,
  accept: (p: WorldPoly) => boolean = isShotSurface, layers: number = ALL_LAYERS,
): RayHit | null {
  const length = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(length > 0) || !(maxDistance >= 0)) return null;
  const d: Pnt3D = [dir[0] / length, dir[1] / length, dir[2] / length];
  const { originX, originZ, cellDim } = grid.params;
  const inv = grid.invCellDim;

  // The DDA on the ground plane, in cell units: where the segment starts, which way it steps, and at what distance
  // it crosses the next cell boundary on each axis.
  let cx = Math.floor((origin[0] - originX) * inv), cz = Math.floor((origin[2] - originZ) * inv);
  const stepX = d[0] > 0 ? 1 : d[0] < 0 ? -1 : 0, stepZ = d[2] > 0 ? 1 : d[2] < 0 ? -1 : 0;
  const boundary = (c: number, step: number, o: number, base: number, dc: number): number =>
    step === 0 ? Infinity : ((base + (c + (step > 0 ? 1 : 0)) * cellDim) - o) / dc;
  let nextX = boundary(cx, stepX, origin[0], originX, d[0]);
  let nextZ = boundary(cz, stepZ, origin[2], originZ, d[2]);
  const deltaX = stepX === 0 ? Infinity : cellDim / Math.abs(d[0]);
  const deltaZ = stepZ === 0 ? Infinity : cellDim / Math.abs(d[2]);

  const tested = new Set<CollisionObject>();
  let best = null as RayHit | null;                             // widened: it is set inside the nested loops
  // Enough steps to cross the segment's footprint cell by cell, and a floor so a short one still walks its cell.
  const maxSteps = Math.ceil((maxDistance * Math.hypot(d[0], d[2])) / cellDim) * 2 + 4;
  for (let step = 0; step < maxSteps; step++) {
    const cell = cellByCoord(grid, cx, cz);                   // clamped: a cell off the grid is its edge cell
    const limit = best ? best.t : maxDistance;
    for (const atom of cell.atoms) {
      const object = atom.object;
      if (object.kind !== 'collision' || tested.has(object)) continue;
      tested.add(object);
      if (!modelGate(object.owner, layers)) continue;
      for (const poly of object.polys) {
        if (!accept(poly)) continue;
        const hit = crossing(poly, origin, d, best ? best.t : limit);
        if (hit && (!best || hit.t < best.t)) {
          best = {
            t: hit.t, normal: hit.normal, poly, owner: object.owner,
            point: [origin[0] + hit.t * d[0], origin[1] + hit.t * d[1], origin[2] + hit.t * d[2]],
          };
        }
      }
    }
    const leave = Math.min(nextX, nextZ);                      // where the segment leaves this cell
    if (leave > maxDistance || (best && best.t <= leave)) break;
    if (nextX < nextZ) { cx += stepX; nextX += deltaX; } else { cz += stepZ; nextZ += deltaZ; }
  }
  return best;
}
