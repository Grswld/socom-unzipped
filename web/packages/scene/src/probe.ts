import { isGroundSurface, isLiquidSurface, planeHeightAt, polygonNormal, surfaceWord, SURFACE_GROUND, SURFACE_SKIP, type WorldPoly } from './collision';
import { cellAt, type CollisionObject, type CollisionOwner, type Grid } from './grid';

/**
 * The engine's ground probe, over the grid (`grid.ts`): what stands under a point, and which of it is the floor.
 *
 * The call chain is research 23 section 1.1's, read off the decomp and replayed against 1,152 recorded actor rows
 * by research 24 section 3 (median residual 0.004):
 *
 * 1. **The query** (`FUN_002d3cf0` -> `FUN_002d3030`). A type-1 record is a vertical line `(x, +-50000, z)`. It
 *    marks the one cell holding `(x, z)` and walks that cell's atoms, testing each model: the gate (`m_active`,
 *    `m_hasDI`, the layer against the record's mask), the model's bbox, then its surfaces in order -- a surface
 *    with bit 18 set is skipped, a type-1 probe wants bit 0 -- and **the loop stops at the model's first hit**.
 *    The recursion into children (`+0x70`) is the grid's collision owners here: `collisionOwners` gives every
 *    realised node that carries polygons its own owner, linked into the cells its polygons cover.
 * 2. **The selection** (`FUN_005b5d40`): the highest candidate at or under the origin's y + 1, else the lowest;
 *    rejected when it is more than 20 over the actor's feet. The origin is the actor's x, z and its y plus the
 *    root bone's lift, about 5 (research 23 section 1.2: +4.7 / +5.5 in the images; research 24 takes 5). Only x
 *    and z reach the query; y only feeds this window.
 *
 * **World space, not model space.** The engine carries the line into each model's space with the inverse of the
 * model's matrix (`FUN_00308160`, `FUN_003085c0`), tests it there, and carries the hit back (`vcallms 0x80`). The
 * viewer keeps its polygons in world space (`worldCollision`, the same composed matrices) and tests the world line
 * against them. An invertible affine map preserves which polygon a line crosses and where, so the two find the
 * same polygons at the same points; what differs is float rounding, far below the selection window. The line's
 * +-50000 is every height on every map either way.
 *
 * **The bbox reject** (`FUN_003124f0`, the model-space line against the node's bbox) is the owner's footprint
 * here: every `di` polygon of all 22 maps lies inside its own node's `nparams` bbox in x and z (measured
 * 2026-09-28), so the reject can only drop a line that misses every polygon of the node, and the footprint test
 * drops the same lines and no others.
 *
 * **What is not modelled**, because the viewer has none of it: the self skip (`+0x3c`) and the characters flag
 * (`*(top+0xa1) & 4`), which concern actors; the material table's VOLUMETRIC and LIQUID candidates
 * (`0x44f358[m]+0x3c`, from the SOILS reader, which is not in a map's archive -- no Frostfire ground polygon uses
 * one, research 24 section 1.2); and `CDIBBox` surfaces, which on disc do not exist (web/docs/research/72 section 6).
 */

/** One candidate (research 23 section 1.3's 0x20-byte slot): the hit, its surface, its normal and its model. */
export interface Hit {
  x: number;
  /** The height of the surface's plane at (x, z). */
  y: number;
  z: number;
  /** The surface's unit normal, world space, turned up (`n_y >= 0`). */
  normal: [number, number, number];
  poly: WorldPoly;
  owner: CollisionOwner;
}

/** The record's layer mask when the actor has no last hit: every layer (research 23 section 1.3, `+0x44`). */
export const ALL_LAYERS = 0xffffffff;
/** The probe origin over the feet (research 24 section 2; research 23 section 1.2 reads +4.7 and +5.5). */
export const PROBE_LIFT = 5;
/** A candidate this far over the origin still counts as under it (`FUN_005b5d40`, research 23 section 1.1). */
export const SELECT_ABOVE = 1;
/** A pick more than this over the actor's feet is rejected (`FUN_005b5d40`, research 23 section 1.1). */
export const REJECT_ABOVE = 20;

/** `tag_NODE_PARAMS` (`zNode/znode.h:78-90`): `m_active` bit 0, `m_hasDI` bit 12, `m_region_shift` bits 13-17. */
const NODE_ACTIVE = 1 << 0, NODE_HAS_DI = 1 << 12, REGION_SHIFT_AT = 13;

/**
 * `FUN_002d3030`'s model gate (research 23 section 1.1): `+0x5c` bit 0 and `+0x5d` bit 4 -- `m_active` and
 * `m_hasDI` of the node's flag word, which sits at `+0x5c` in memory as at +92 in `nparams` -- and the layer
 * test `FUN_002dc620(rec, 1 << m_region_shift)` against the record's mask. An owner inferred without the graph
 * has no flags, and passes. Every node that carries polygons on all 22 maps is active with `m_hasDI` set
 * (counted 2026-09-28), so on the disc's data the gate is the layer test alone.
 */
export function modelGate(owner: CollisionOwner, layers: number = ALL_LAYERS): boolean {
  const flags = owner.flags;
  if (flags === undefined) return true;
  if ((flags & NODE_ACTIVE) === 0 || (flags & NODE_HAS_DI) === 0) return false;
  const layer = (flags >>> REGION_SHIFT_AT) & 31;
  return ((layers >>> layer) & 1) === 1;
}

/**
 * Whether (x, z) is inside a polygon's footprint, edges included: the vertical line crosses it. A convex
 * polygon's edges all turn one way round a point inside it; either winding is taken, as research 24 section 2
 * took it (`CDIPoly::GetIntersect`'s VU0 edge tests, `FUN_002dd150`, are not decoded far enough to say more).
 */
function lineCrosses(points: Float32Array, x: number, z: number): boolean {
  const n = points.length / 3;
  let left = false, right = false;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    const cross = (points[b]! - points[a]!) * (z - points[a + 2]!) - (points[b + 2]! - points[a + 2]!) * (x - points[a]!);
    if (cross > 1e-7) left = true;
    else if (cross < -1e-7) right = true;
    if (left && right) return false;
  }
  return left || right;
}

/** The cached per-polygon facts the probe and the mover read, so a tick does not redo Newell's sum. */
const normals = new WeakMap<WorldPoly, [number, number, number] | null>();
/** A polygon's unit normal, turned up, computed once. */
export function upNormal(poly: WorldPoly): [number, number, number] | null {
  let n = normals.get(poly);
  if (n === undefined) {
    const raw = polygonNormal(poly.points);
    n = raw === null ? null : raw[1] < 0 ? [-raw[0], -raw[1], -raw[2]] : raw;
    normals.set(poly, n);
  }
  return n;
}

/** The first hit of one model's polygons in surface order, or null: `FUN_002d3030`'s surface loop. */
function firstHit(object: CollisionObject, x: number, z: number): Hit | null {
  for (const poly of object.polys) {
    if (!isGroundSurface(poly)) continue;                 // bit 18 skipped, bit 0 wanted (type 1)
    const normal = upNormal(poly);
    if (normal === null || normal[1] < 1e-6) continue;    // a vertical polygon has no one height under a line
    if (!lineCrosses(poly.points, x, z)) continue;
    const y = planeHeightAt(poly.points, x, z);
    if (y === null) continue;
    return { x, y: y + 0, z, normal, poly, owner: object.owner };      // + 0: a plane through the origin gives -0
  }
  return null;
}

/**
 * Every candidate under (x, z): the cell's collision atoms in link order, each model gated, its first hit in
 * surface order (research 23 section 1.1). `layers` is the record's mask (`ALL_LAYERS` when the actor has no last
 * hit). The order is the grid's, which the selection does not depend on.
 */
export function probeGround(grid: Grid, x: number, z: number, layers: number = ALL_LAYERS): Hit[] {
  const out: Hit[] = [];
  for (const atom of cellAt(grid, x, z).atoms) {
    const object = atom.object;
    if (object.kind !== 'collision') continue;
    const f = object.footprint;
    if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;   // the bbox reject (see the file's comment)
    if (!modelGate(object.owner, layers)) continue;
    const hit = firstHit(object, x, z);
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * `FUN_005b5d40`'s pick (research 23 section 1.1 item 9, research 24 section 2): the highest candidate at or under
 * `originY + 1`, else the lowest; null when there is none, or when the pick is more than 20 over `actorY` (the
 * actor matrix's y, the feet; the origin less the lift by default). The window bounds a pick *over* the feet: a
 * floor below is taken however far below it is, which in the game is a fall (research 24 section 7.4).
 */
export function selectFloor(hits: readonly Hit[], originY: number, actorY: number = originY - PROBE_LIFT): Hit | null {
  let under: Hit | null = null, lowest: Hit | null = null;
  for (const h of hits) {
    if (h.y <= originY + SELECT_ABOVE && (under === null || h.y > under.y)) under = h;
    if (lowest === null || h.y < lowest.y) lowest = h;
  }
  const pick = under ?? lowest;
  if (pick === null || pick.y > actorY + REJECT_ABOVE) return null;
  return pick;
}

/**
 * The water surfaces over (x, z), highest first: the water polygons (`MATERIAL_WATER`, bit 0, bit 18 clear) whose
 * footprint holds the point -- `FUN_005b52b0`'s water line (web research 86 section 5).
 */
export function probeWater(grid: Grid, x: number, z: number): number[] {
  const out: number[] = [];
  for (const atom of cellAt(grid, x, z).atoms) {
    const object = atom.object;
    if (object.kind !== 'collision') continue;
    const f = object.footprint;
    if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
    for (const poly of object.polys) {
      if (!isLiquidSurface(poly) || (surfaceWord(poly) & (SURFACE_GROUND | SURFACE_SKIP)) !== SURFACE_GROUND) continue;
      const normal = upNormal(poly);
      if (normal === null || normal[1] < 1e-6 || !lineCrosses(poly.points, x, z)) continue;
      const y = planeHeightAt(poly.points, x, z);
      if (y !== null) out.push(y);
    }
  }
  return out.sort((a, b) => b - a);
}

/** The floor an actor with its feet at (x, y, z) stands on: the probe, then the pick from the origin y + 5. */
export function probeFloor(grid: Grid, x: number, y: number, z: number, layers: number = ALL_LAYERS): Hit | null {
  return selectFloor(probeGround(grid, x, z, layers), y + PROBE_LIFT, y);
}
