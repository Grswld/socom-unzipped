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
  /** `m_ditype`, two bits; only 2 and 3 occur on any of the three fixtures (36 section 6). */
  ditype: number;
  material: number;
  ptcount: number;
  /** xyz per point, world space, `ptcount` of them. */
  points: Float32Array;
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
 * than the archive stores distinct ones -- an instanced crate collides wherever the crate stands.
 */
export function worldCollision(models: SceneNode[], rootName = 'worldmodel'): WorldPoly[] {
  return placeCollision(models, rootName).map((p) => ({
    modelName: p.modelName,
    path: p.path,
    region: p.poly.region,
    ditype: p.poly.ditype,
    material: p.poly.material,
    ptcount: p.poly.ptcount,
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
