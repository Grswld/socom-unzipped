import { polygonNormal, probeGround, ringCells, surfaceWord, SURFACE_SKIP, type Grid, type WorldPoly } from '@s2u/scene';

/**
 * The climb onto and over obstacles (web research 86 section 3), the geometry half: which wall is climbable, the
 * contact the game keeps, and the plan a press of the action button would run. Pure; `./traversal` runs the plan.
 *
 * **What is climbable is the polygon's, not the height's** (`FUN_005b2620`, decomp 468288; `FUN_005b3ce0`, 469088;
 * `FUN_0059d9f0`, 457413): `m_appflags` -- `(byte[poly+0xA] & 0x7f) >> 4`, surface word bits 20-22 --
 *
 * | appflags | the climb                                                        |
 * |----------|------------------------------------------------------------------|
 * | 1, 3     | by the height (`FUN_00580b70`'s table below)                     |
 * | 2        | the ladder (`./traversal`)                                       |
 * | 4        | the crates: by the height, only for 5 < h <= 32; 5 < h <= 10 steps up with no press |
 * | 5        | always "Climb over" (`FUN_00580a80`)                             |
 * | 0        | never: an ordinary wall is not climbed                           |
 *
 * **The contact** (`FUN_005483d0`, 413610-413670, via `FUN_005b0d30`): the wall polygon the move last pushed against,
 * at `actor+0x1090` (point, polygon, normal), replaced by a new climbable one, dropped past 24 across the ground, behind
 * the face, or facing away (`FUN_005b3890`, 468959).
 *
 * **The height** `h` = the polygon's top (`FUN_002dbfb0`) - the feet (the material's `FOOT_STEP_OFFSET` term
 * `DAT_0044f358[mat] + 0x38` is left out: unverified which field it is). From the feet as they are -- in the air too,
 * which is the jump-grab: a jump lowers `h` while the contact holds.
 *
 * **The table** (`FUN_00580b70`, 442174; all literals), standing or crouched (prone does not climb, `FUN_005b4340`):
 *
 * | h           | the clip                                                                     |
 * |-------------|------------------------------------------------------------------------------|
 * | <= 5        | nothing                                                                      |
 * | 5 .. 10     | "Step up" (`seal_step_up`)                                                   |
 * | 10 .. 12    | "Climb crate" (`seal_climbcrate`)                                            |
 * | 12 .. 26.5  | crate at weight 1 - (h - 12) / 14.5, medium the rest (`FUN_00581110`)        |
 * | 26.5 .. 28  | "Climb medium" (`seal_climb_medium`)                                         |
 * | 28 .. 32    | "Stand -> Hang", "Hang", then "Hang -> Climb" (`seal_stand2hang` ...)        |
 * | > 32        | nothing                                                                      |
 *
 * `dynamics.rdr`'s `low/med/high_climb_height` 13 / 21.5 / 26.5 have **no reader** (the loader `FUN_0059ba80` stores them
 * at `0x44c250 +0x178..+0x184`, 456970-456979, and nothing reads them): 13 and 21.5 are the heights the crate and medium
 * clips were authored for -- their `refPt.y` is exactly that less the root's 11.52 -- and 26.5 is the table's own.
 * The blend of the two clips is played here as the heavier one, its path stretched to the height (a named
 * simplification: the animator plays one clip at a time).
 *
 * **The facing** (469208, `FUN_005b2620`): the facing dotted with the wall's normal (into the wall) >= 0.3, and the
 * direction from the contact to the mover within 0.3 of the normal.
 */

/** A climbable wall the mover has touched: the polygon, its horizontal normal toward the mover, its top edge. */
export interface ClimbContact {
  poly: WorldPoly;
  /** `m_appflags`. */
  app: number;
  /** The point of contact, on the plane (x, z). */
  x: number;
  z: number;
  /** The unit horizontal normal on the mover's side. */
  nx: number;
  nz: number;
  /** The polygon's top and bottom. */
  top: number;
  bottom: number;
  /** The top edge's ends (x, z). */
  edge: [number, number, number, number];
}

/** The climb's height classes, as the HUD's icon and the audio read them. */
export type ClimbClass = 'step' | 'low' | 'med' | 'high' | 'over';

/** A climb the action button would run. */
export interface ClimbPlan {
  kind: ClimbClass;
  /** The clip (`motion.rdr`'s name); for 'high' the first of three. */
  clip: string;
  /** The height over the feet. */
  h: number;
  /** The point on the top edge the move aims at (`FUN_005b3a60`), and the yaw facing the wall (-normal). */
  target: [number, number, number];
  yaw: number;
  /** Whether the press is not needed (appflags 4 at 5 < h <= 10). */
  automatic: boolean;
  contact: ClimbContact;
}

/** `m_appflags` values that climb (the header's table; 2 is the ladder's). */
export const CLIMBABLE = new Set([1, 3, 4, 5]);
/** `FUN_005b3890` / `FUN_005483d0`: the contact is kept this far across the ground (576 = 24^2). */
export const CONTACT_KEEP = 24;
/** 469208 / `FUN_005b2620`: the facing and the direction dots. */
export const CLIMB_FACING = 0.3;
/** `FUN_005b3a60`: the target is kept this far from the top edge's ends. */
const EDGE_END = 3;

/** `FUN_00580b70`'s table (the header): the class and the clip for a height, or null outside it. */
export function climbClass(h: number, app: number): { kind: ClimbClass; clip: string } | null {
  if (app === 5) return { kind: 'over', clip: 'seal_climb_over' };
  if (app === 4 && !(h > 5 && h <= 32)) return null;
  if (h <= 5 || h > 32) return null;
  if (h <= 10) return { kind: 'step', clip: 'seal_step_up' };
  if (h <= 12) return { kind: 'low', clip: 'seal_climbcrate' };
  if (h <= 26.5) {
    const crate = 1 - (h - 12) / 14.5;                   // FUN_00581110's weight
    return crate >= 0.5 ? { kind: 'low', clip: 'seal_climbcrate' } : { kind: 'med', clip: 'seal_climb_medium' };
  }
  if (h <= 28) return { kind: 'med', clip: 'seal_climb_medium' };
  return { kind: 'high', clip: 'seal_stand2hang' };
}

/** The wall a band of the body (feet + `low` .. feet + `high`) touches within `reach`, climbable ones only; the nearest. */
export function touchClimbable(grid: Grid, x: number, y: number, z: number, reach: number, low = 1, high = 34): ClimbContact | null {
  let best: { c: ClimbContact; d: number } | null = null;
  const seen = new Set<WorldPoly>();
  for (const { cell } of ringCells(grid, x, z, 1, 'square')) {
    for (const atom of cell.atoms) {
      if (atom.object.kind !== 'collision') continue;
      for (const poly of atom.object.polys) {
        if (seen.has(poly)) continue;
        seen.add(poly);
        const app = poly.appflags ?? 0;
        if (!CLIMBABLE.has(app) || (surfaceWord(poly) & SURFACE_SKIP) !== 0) continue;
        const c = contactOf(poly, app, x, z);
        if (!c) continue;
        if (c.top <= y + low || c.bottom >= y + high) continue;
        const d = Math.hypot(x - c.x, z - c.z);
        if (d <= reach && (!best || d < best.d)) best = { c, d };
      }
    }
  }
  return best?.c ?? null;
}

/** A wall polygon as a contact seen from (x, z): the nearest point of its footprint, its normal to that side, its top edge. */
export function contactOf(poly: WorldPoly, app: number, x: number, z: number): ClimbContact | null {
  const n = polygonNormal(poly.points);
  if (!n) return null;
  const h = Math.hypot(n[0], n[2]);
  if (h < 0.7) return null;                                   // not a wall
  let nx = n[0] / h, nz = n[2] / h;
  const p = poly.points, count = p.length / 3;
  let top = -Infinity, bottom = Infinity;
  for (let i = 0; i < count; i++) { top = Math.max(top, p[i * 3 + 1]!); bottom = Math.min(bottom, p[i * 3 + 1]!); }
  const d = nx * p[0]! + nz * p[2]!;                          // the plane: nx x + nz z = d
  let side = nx * x + nz * z - d;
  if (side < 0) { nx = -nx; nz = -nz; side = -side; }
  const plane = nx * p[0]! + nz * p[2]!;
  // The top edge: the points within 0.01 of the top (FUN_005b1c80's |dy| < 0.01), their extent along the plane.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < count; i++) {
    if (top - p[i * 3 + 1]! > 0.01) continue;
    const along = -nz * p[i * 3]! + nx * p[i * 3 + 2]!;
    lo = Math.min(lo, along); hi = Math.max(hi, along);
  }
  // The whole footprint's extent along the plane, for the contact point.
  let flo = Infinity, fhi = -Infinity;
  for (let i = 0; i < count; i++) { const a = -nz * p[i * 3]! + nx * p[i * 3 + 2]!; flo = Math.min(flo, a); fhi = Math.max(fhi, a); }
  const along = Math.max(flo, Math.min(fhi, -nz * x + nx * z));
  const at = (a: number): [number, number] => [nx * plane - nz * a, nz * plane + nx * a];
  const [cx, cz] = at(along);
  const [ax, az] = at(lo), [bx, bz] = at(hi);
  return { poly, app, x: cx, z: cz, nx, nz, top, bottom, edge: [ax, az, bx, bz] };
}

/** Whether a kept contact still holds (`FUN_005b3890`): within 24, in front of the face, and not faced away from. */
export function contactHolds(c: ClimbContact, x: number, z: number, fx: number, fz: number): boolean {
  const dx = x - c.x, dz = z - c.z;
  if (dx * dx + dz * dz > CONTACT_KEEP * CONTACT_KEEP) return false;
  if (dx * c.nx + dz * c.nz <= 0) return false;
  return -(fx * c.nx + fz * c.nz) > 0;
}

/**
 * The plan a press would run from the feet at (x, y, z) facing (fx, fz) against a kept contact, or null: the facing and
 * the direction within 0.3 (`FUN_005b2620`), the height's class for the polygon's appflags, a top to stand on (the
 * probe's floor at the top within 1.5, except for a climb over, whose far side's floor is looked for), the target on
 * the top edge kept 3 from its ends.
 */
export function planClimb(grid: Grid, c: ClimbContact, x: number, y: number, z: number, fx: number, fz: number): ClimbPlan | null {
  if (-(fx * c.nx + fz * c.nz) < CLIMB_FACING) return null;
  const dx = x - c.x, dz = z - c.z, dl = Math.hypot(dx, dz);
  if (dl > 1e-6 && (dx * c.nx + dz * c.nz) / dl < CLIMB_FACING) return null;
  const h = c.top - y;
  const cls = climbClass(h, c.app);
  if (!cls) return null;
  // The target: the contact point on the top edge, 3 from the ends, or the edge's midpoint when it is short.
  const [ax, az, bx, bz] = c.edge;
  const len = Math.hypot(bx - ax, bz - az);
  let t = 0.5;
  if (len > 2 * EDGE_END) {
    const u = ((c.x - ax) * (bx - ax) + (c.z - az) * (bz - az)) / (len * len);
    t = Math.max(EDGE_END / len, Math.min(1 - EDGE_END / len, u));
  }
  const target: [number, number, number] = [ax + (bx - ax) * t, c.top, az + (bz - az) * t];
  if (cls.kind !== 'over' && topFloor(grid, target, c) === null) return null;
  const yaw = (Math.atan2(c.nx, c.nz) * 180) / Math.PI;
  return { ...cls, h, target, yaw, automatic: c.app === 4 && h > 5 && h <= 10, contact: c };
}

/** How far past the edge the top's floor is looked for, and how near the top it must be. */
const TOP_IN = 4, TOP_TOLERANCE = 1.5;

/** The floor on top, `TOP_IN` past the edge: the probe's hit within `TOP_TOLERANCE` of the top, or null. */
export function topFloor(grid: Grid, target: readonly number[], c: ClimbContact, past = TOP_IN): number | null {
  const x = target[0]! - c.nx * past, z = target[2]! - c.nz * past;
  let best: number | null = null;
  for (const hit of probeGround(grid, x, z)) if (Math.abs(hit.y - c.top) <= TOP_TOLERANCE && (best === null || Math.abs(hit.y - c.top) < Math.abs(best - c.top))) best = hit.y;
  return best;
}

/** The highest floor at (x, z) at or under `y` + `above`, or null: where a climb over lands. */
export function floorUnder(grid: Grid, x: number, y: number, z: number, above = 1): number | null {
  let best: number | null = null;
  for (const hit of probeGround(grid, x, z)) if (hit.y <= y + above && (best === null || hit.y > best)) best = hit.y;
  return best;
}
