import { placeCollision } from './buildScene';
import type { SceneNode } from './sceneGraph';

/**
 * The map's collision hull in the world frame: every `di` polygon of every realised node, carried out of
 * model space by the same composed matrices `placeInstances` draws the chunks with (36 section 6).
 *
 * This is the layer a viewer draws and queries. `placeCollision` does the placement and keeps the whole
 * `CollisionPoly` beside its world points; `worldCollision` flattens that into the handful of fields an
 * overlay and a ground probe actually use, and the line builder below turns it into one segment per
 * polygon side.
 */

/** One placed collision polygon: its points in world space, and the fields that classify it. */
export interface WorldPoly {
  /** The model whose node carries it; `worldmodel` for the map's own hull. */
  modelName: string;
  /** The node path from the root, for saying *which* crate a polygon belongs to. */
  path: string;
  region: number;
  /**
   * `m_ditype`, two bits; only 2 and 3 occur on any of the three fixtures (36 section 6). They are bits 0 and 1 of
   * the surface word (`surfaceWord`): bit 0 is what the vertical ground probe asks for, bit 1 what the column
   * probe asks for (research 23 section 1.1, research 24 section 1.2) -- so 3 is ground, 2 is not.
   */
  ditype: number;
  material: number;
  ptcount: number;
  /**
   * `m_cameratype`, bits 18-19 of the surface word. Its low bit is research 23/24's "bit 18": the probe skips a
   * surface with it set (`FUN_002d3030` with `DAT_0044d758 == 0`) and research 24 section 2 leaves it out of the
   * walls. On Frostfire 19 polygons carry it, the doorway volume at x 676-680 among them (research 24 section 4.1).
   */
  cameratype: number;
  /**
   * `m_appflags`, the three bits after `m_cameratype` (surface word bits 20-22; reCOM `zIntersect/zintersect.h:26`).
   * Web research 86 section 2: 2 on every ladder polygon of the 22 maps and on nothing else (`APP_LADDER`,
   * `./ladder`); 4 and 5 on props, fences and terrain. Absent (0) where a caller built the polygon by hand.
   */
  appflags?: number;
  /** xyz per point, world space, `ptcount` of them. */
  points: Float32Array;
}

/**
 * The surface word: the packed third word of a `di`'s params (web/docs/research/72 section 6, `DI_PARAMS` in reCOM
 * `zIntersect/zintersect.h:21-28`) -- `m_ditype:2, m_ptcount:8, m_material:8, m_cameratype:2, ...` -- which is the
 * live `CDIPoly`'s `+8` word research 23 section 1.3 reads its bits from ("ptcount at bits 2-9, material at bits
 * 10-17", section 8). Rebuilt from the fields `WorldPoly` keeps, up to and including `m_cameratype`, so the bits
 * the probe tests can be named by number as the research names them.
 */
export function surfaceWord(p: Pick<WorldPoly, 'ditype' | 'ptcount' | 'material' | 'cameratype'>): number {
  return ((p.ditype & 3) | ((p.ptcount & 0xff) << 2) | ((p.material & 0xff) << 10) | ((p.cameratype & 3) << 18)) >>> 0;
}

/** Surface word bit 0 (`m_ditype` bit 0): the type-1 vertical probe tests only these (research 23 section 1.1). */
export const SURFACE_GROUND = 1 << 0;
/** Surface word bit 1 (`m_ditype` bit 1): the type-2 column probe's; set on all 3,318 of Frostfire's (research 24 section 1.2). */
export const SURFACE_SIDE = 1 << 1;
/** Surface word bit 18 (`m_cameratype` bit 0): skipped by the probe, and not a wall (research 23 section 1.1, 24 section 2). */
export const SURFACE_SKIP = 1 << 18;

/** A ground candidate for the vertical probe: bit 0 set, bit 18 clear. */
export const isGroundSurface = (p: WorldPoly): boolean =>
  (surfaceWord(p) & (SURFACE_GROUND | SURFACE_SKIP)) === SURFACE_GROUND;

/**
 * The unit normal of a polygon's plane from Newell's sum, the way research 24 section 2 takes it, or null for a
 * polygon of no area. Its sign follows the winding; the tests that use it (`|n_y|`) do not care.
 */
export function polygonNormal(points: Float32Array): [number, number, number] | null {
  const n = points.length / 3;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    nx += (points[a + 1]! - points[b + 1]!) * (points[a + 2]! + points[b + 2]!);
    ny += (points[a + 2]! - points[b + 2]!) * (points[a]! + points[b]!);
    nz += (points[a]! - points[b]!) * (points[a + 1]! + points[b + 1]!);
  }
  const length = Math.hypot(nx, ny, nz);
  return length > 1e-9 ? [nx / length, ny / length, nz / length] : null;
}

/** Research 24 section 2 step 3: a wall is steeper than this in `|n_y|`. */
export const WALL_NY = 0.7;

/**
 * A wall for the mover (research 24 section 2 step 3): bit 1 set, bit 18 clear, and `|n_y| < 0.7`. That these
 * stop the game's mover is research 24's inference (section 7.1: the movement routine is not decompiled; the
 * launch 3c trails stand off such planes at 4.4-5.8 and cross only bit-18 or high polygons, section 4.1).
 */
export function isWallSurface(p: WorldPoly): boolean {
  if ((surfaceWord(p) & (SURFACE_SIDE | SURFACE_SKIP)) !== SURFACE_SIDE) return false;
  const n = polygonNormal(p.points);
  return n !== null && Math.abs(n[1]) < WALL_NY;
}

/**
 * A colour per `m_ditype`. reCOM declares the field as two bits and never names its values
 * (`zIntersect/zintersect.h:21`), so these are told apart rather than labelled: on the fixtures 2 and 3
 * are the two kinds that occur, and drawing them differently is what shows a reader there are two.
 */
export const DITYPE_COLOURS: readonly number[] = [0x7fb2ff, 0xffb347, 0x4fe08a, 0xff4d7d];

/**
 * Every collision polygon of the scene, in world space, rooted at `rootName` the way the drawn chunks
 * are. A prototype's polygons are realised once per instance context, so a map has more placed polygons
 * than the archive stores distinct ones -- an instanced crate collides wherever the crate stands. The set is
 * the one the engine holds (`worldDi`): 3,318 on Frostfire, research 24 section 1.1's count and bounds.
 */
export function worldCollision(models: SceneNode[], rootName = 'worldmodel'): WorldPoly[] {
  return placeCollision(models, rootName).map((p) => ({
    modelName: p.modelName,
    path: p.path,
    region: p.poly.region,
    ditype: p.poly.ditype,
    material: p.poly.material,
    ptcount: p.poly.ptcount,
    cameratype: p.poly.cameratype,
    appflags: p.poly.appflags,
    points: p.points,
  }));
}

/** Line-segment endpoints and their colours: what a `LineSegments` overlay uploads, nothing more. */
export interface CollisionLines {
  /** Two xyz endpoints per polygon side. */
  positions: Float32Array;
  /** rgb per endpoint, 0..255, to be uploaded as a normalised byte attribute. */
  colors: Uint8Array;
  /** How many polygons went in, for the status line. */
  polygons: number;
}

/**
 * One segment per polygon side, the polygon closed (its last point back to its first), coloured by
 * `ditype`. Edges are drawn rather than faces because a collision hull is mostly coplanar with the
 * geometry it guards: filled, it would z-fight the floor it sits on and hide the map underneath.
 */
export function collisionLines(polys: WorldPoly[]): CollisionLines {
  let edges = 0;
  for (const p of polys) edges += p.ptcount;
  const positions = new Float32Array(edges * 6);
  const colors = new Uint8Array(edges * 6);
  let at = 0;
  for (const poly of polys) {
    const colour = DITYPE_COLOURS[poly.ditype] ?? DITYPE_COLOURS[0]!;
    const r = (colour >> 16) & 0xff, g = (colour >> 8) & 0xff, b = colour & 0xff;
    for (let i = 0; i < poly.ptcount; i++) {
      const from = i * 3, to = ((i + 1) % poly.ptcount) * 3;
      positions[at] = poly.points[from]!;
      positions[at + 1] = poly.points[from + 1]!;
      positions[at + 2] = poly.points[from + 2]!;
      positions[at + 3] = poly.points[to]!;
      positions[at + 4] = poly.points[to + 1]!;
      positions[at + 5] = poly.points[to + 2]!;
      colors[at] = r; colors[at + 1] = g; colors[at + 2] = b;
      colors[at + 3] = r; colors[at + 4] = g; colors[at + 5] = b;
      at += 6;
    }
  }
  return { positions, colors, polygons: polys.length };
}

/**
 * The height of a polygon's plane over (x, z), or null when the polygon is vertical there and has no
 * single height. Newell's normal, so it holds for any convex polygon, three points or twelve.
 */
export function planeHeightAt(points: Float32Array, x: number, z: number): number | null {
  const n = points.length / 3;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    nx += (points[a + 1]! - points[b + 1]!) * (points[a + 2]! + points[b + 2]!);
    ny += (points[a + 2]! - points[b + 2]!) * (points[a]! + points[b]!);
    nz += (points[a]! - points[b]!) * (points[a + 1]! + points[b + 1]!);
  }
  if (Math.abs(ny) < 1e-6) return null;
  const d = nx * points[0]! + ny * points[1]! + nz * points[2]!;
  return (d - nx * x - nz * z) / ny;
}

/** How far (x, z) lies from a polygon's footprint: 0 inside it, the nearest edge distance outside. */
export function footprintDistance(points: Float32Array, x: number, z: number): number {
  const n = points.length / 3;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = i * 3, b = j * 3;
    if ((points[a + 2]! > z) !== (points[b + 2]! > z) &&
        x < (points[b]! - points[a]!) * (z - points[a + 2]!) / (points[b + 2]! - points[a + 2]!) + points[a]!) {
      inside = !inside;
    }
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    const dx = points[b]! - points[a]!, dz = points[b + 2]! - points[a + 2]!;
    const len = dx * dx + dz * dz;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - points[a]!) * dx + (z - points[a + 2]!) * dz) / len)) : 0;
    best = Math.min(best, Math.hypot(x - (points[a]! + t * dx), z - (points[a + 2]! + t * dz)));
  }
  return best;
}
