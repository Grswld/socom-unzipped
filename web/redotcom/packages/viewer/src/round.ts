import { segmentHits, type Grid } from '@s2u/scene';
import { penetrate } from './accuracy';

/**
 * One round's path through the world, headless (web sprint 3, M2: the shared sim). The page's `Fire` (`./fire`) and the
 * multiplayer server both walk a round with it: from where it leaves, along its direction, the whole range, every
 * surface in order through research 84 section 13's penetration (`penetrate`, `HandleIntersections` 0x3c9b70). The
 * server adds the other players' hit volumes as surfaces of their own (`extra`), so a body behind a thin wall is struck
 * by the same rule that marks the wall.
 */

export type Vec3 = [number, number, number];

/** A surface the round struck: where, its normal turned toward the shooter, how far along, and what it is. */
export interface RoundSurface {
  point: Vec3; normal: Vec3; distance: number;
  /** The polygon's `material` byte (the SOILS table), when it is the world's. */
  material?: number;
  /** An extra surface's tag (the server's body hits), when it is not the world's. */
  tag?: unknown;
}

/** A surface the caller adds to the world's (a body's hit volume): distance along the round, and its `PENETRATION`. */
export interface ExtraSurface { distance: number; penetration: number; point: Vec3; normal: Vec3; tag: unknown }

/** Where the round went: the surfaces struck in order, where it stopped (null: in the air) and the segment's end. */
export interface RoundPath { struck: RoundSurface[]; hit: RoundSurface | null; through: RoundSurface[]; end: Vec3 }

/**
 * The round from `from` along the unit `dir` for `reach` units: the world's polygons (`segmentHits`) with their
 * `PENETRATION` (`penetrationOf`), plus `extra`, walked nearest first by `penetrate` with the weapon's `piercing`.
 */
export function roundPath(
  grid: Grid, from: Vec3, dir: Vec3, reach: number,
  penetrationOf: (material: number | undefined) => number, piercing: number,
  extra: readonly ExtraSurface[] = [],
): RoundPath {
  const far: Vec3 = [from[0] + dir[0] * reach, from[1] + dir[1] * reach, from[2] + dir[2] * reach];
  const world = segmentHits(grid, from, far).map((h): RoundSurface & { penetration: number } => {
    // Newell's normal points either way: the surface faces the shooter.
    const d = h.normal[0]! * dir[0] + h.normal[1]! * dir[1] + h.normal[2]! * dir[2];
    const normal: Vec3 = d > 0 ? [-h.normal[0]!, -h.normal[1]!, -h.normal[2]!] : [h.normal[0]!, h.normal[1]!, h.normal[2]!];
    return {
      point: [h.point[0]!, h.point[1]!, h.point[2]!], normal, distance: h.t * reach, material: h.poly.material,
      penetration: penetrationOf(h.poly.material),
    };
  });
  const all = extra.length
    ? [...world, ...extra.map((e) => ({ point: e.point, normal: e.normal, distance: e.distance, tag: e.tag, penetration: e.penetration }))]
      .sort((a, b) => a.distance - b.distance)
    : world;
  const path = penetrate(all, reach, piercing);
  const struck = path.struck.map((i) => {
    const { penetration: _, ...surface } = all[i]!;
    return surface as RoundSurface;
  });
  if (path.through) {
    const end: Vec3 = [from[0] + dir[0] * path.range, from[1] + dir[1] * path.range, from[2] + dir[2] * path.range];
    return { struck, hit: null, through: struck, end };
  }
  const hit = struck[struck.length - 1] ?? null;
  return { struck, hit, through: struck.slice(0, -1), end: hit ? [...hit.point] : far };
}
