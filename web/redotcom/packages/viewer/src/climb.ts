import {
  cellAt, isLiquidSurface, polygonNormal, probeGround, ringCells, segmentHits, surfaceWord, SEAL_TUNING, SURFACE_SKIP, type Grid, type WorldPoly,
} from '@s2u/scene';

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
 * Between 12 and 26.5 both clips play as the two nodes of one play sharing a phase (`FUN_00581110`, decomp
 * 442306-442340): the crate at `1 - (h - 12) / 14.5`, the medium the rest (`ClimbPlan.blend`).
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
  /** The clip (`motion.rdr`'s name); for 'high' the first of three; for a blend the first node, the crate. */
  clip: string;
  /** Between 12 and 26.5 the second node, the medium, and the crate's weight (`FUN_00581110`); null otherwise. */
  blend: { clip: string; weight: number } | null;
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

/** `FUN_00580b70`'s table (the header): the class and the clip (and the blend) for a height, or null outside it. */
export function climbClass(h: number, app: number): { kind: ClimbClass; clip: string; blend: ClimbPlan['blend'] } | null {
  if (app === 5) return { kind: 'over', clip: 'seal_climb_over', blend: null };
  if (app === 4 && !(h > 5 && h <= 32)) return null;
  if (h <= 5 || h > 32) return null;
  if (h <= 10) return { kind: 'step', clip: 'seal_step_up', blend: null };
  if (h <= 12) return { kind: 'low', clip: 'seal_climbcrate', blend: null };
  if (h <= 26.5) {
    const crate = 1 - (h - 12) / 14.5;                   // FUN_00581110's weight
    return { kind: crate >= 0.5 ? 'low' : 'med', clip: 'seal_climbcrate', blend: { clip: 'seal_climb_medium', weight: crate } };
  }
  if (h <= 28) return { kind: 'med', clip: 'seal_climb_medium', blend: null };
  return { kind: 'high', clip: 'seal_stand2hang', blend: null };
}

/**
 * The contact polygon's material's `FOOT_STEP_OFFSET` (`DAT_0044f358[mat] + 0x38`, the parser at decomp 181399-181401;
 * 0 by default, `FUN_002deb30`): -0.8 on GRASS, BROKEN GLASS, LEAVES, ICE, SNOW and GRAVEL -- the hull's 4, 14, 15, 16,
 * 17, 18 (the SOILS order + 2, research 86 section 5.1) -- added to the climb's height.
 */
export function footStepOffset(material: number): number {
  return material >= 14 && material <= 18 || material === 4 ? -0.8 : 0;
}

/**
 * `FUN_0054e430` (decomp 416696-416790), run by the climb offer each frame: a level segment at the contact's top + 0.5
 * (when that is under the feet + 21.1), from over the feet to 1.1 of the way past the contact; its first hit steeper
 * than `max_slope` (`|n_y| <= 0.6428`), of no LIQUID material, on another object replaces the contact -- a wall behind
 * the ledge, or the next step of a stack, is what the press then climbs. Null when nothing replaces it.
 */
export function obstacleRay(grid: Grid, c: ClimbContact, x: number, y: number, z: number): ClimbContact | null {
  const Y = c.top + 0.5;
  if (!(Y < y + OBSTACLE_REACH)) return null;
  const to: [number, number, number] = [x + (c.x - x) * 1.1, Y, z + (c.z - z) * 1.1];
  for (const hit of segmentHits(grid, [x, Y, z], to)) {
    if (hit.poly === c.poly || hit.poly.path === c.poly.path) continue;
    if (Math.abs(hit.normal[1]) > MAX_SLOPE_COS || isLiquidSurface(hit.poly)) continue;
    return contactOf(hit.poly, hit.poly.appflags ?? 0, x, z);
  }
  return null;
}

/** `FUN_0054e430`: 19.1 + 2.0 over the feet (the standing cylinder and its margin). */
const OBSTACLE_REACH = 21.1;
/** `DAT_0044c268`: `max_slope`'s cosine, 0.6428. */
const MAX_SLOPE_COS = Math.cos((SEAL_TUNING.maxSlopeDeg * Math.PI) / 180);

/** The wall a band of the body (feet + `low` .. feet + `high`) touches within `reach`, climbable ones only; the nearest. */
export function touchClimbable(grid: Grid, x: number, y: number, z: number, reach: number, low = 1, high = 34): ClimbContact | null {
  let best: { c: ClimbContact; d: number } | null = null;
  for (const poly of climbablesAround(grid, x, z)) {
    const app = poly.appflags ?? 0;
    // PERFORMANCE (web sprint 3): exact rejects before the contact -- the polygon's heights outside the band, or
    // its footprint's box farther than `reach` (the contact lies on the footprint, so it could only be farther).
    const b = boundsOf(poly);
    if (b.top <= y + low || b.bottom >= y + high) continue;
    const bx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0, bz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
    if (bx * bx + bz * bz > reach * reach) continue;
    const c = contactOf(poly, app, x, z);
    if (!c) continue;
    if (c.top <= y + low || c.bottom >= y + high) continue;
    const d = Math.hypot(x - c.x, z - c.z);
    if (d <= reach && (!best || d < best.d)) best = { c, d };
  }
  return best?.c ?? null;
}

/**
 * The climbable polygons of the collision objects in the 3 x 3 cells round (x, z), each once, in the ring's order --
 * what the search walks. PERFORMANCE (web sprint 3): kept per grid and per cell (the hull does not move), so a tick no
 * longer walks every cell of the grid (`ringCells`) and every polygon of every object near it; the list and its order
 * are the same, so the contact found is the same.
 */
const CLIMBABLES = new WeakMap<Grid, Map<number, WorldPoly[]>>();
function climbablesAround(grid: Grid, x: number, z: number): WorldPoly[] {
  let byCell = CLIMBABLES.get(grid);
  if (!byCell) CLIMBABLES.set(grid, byCell = new Map());
  const key = cellAt(grid, x, z).index;
  let list = byCell.get(key);
  if (list) return list;
  list = [];
  const seen = new Set<WorldPoly>();
  for (const { cell } of ringCells(grid, x, z, 1, 'square')) {
    for (const atom of cell.atoms) {
      if (atom.object.kind !== 'collision') continue;
      for (const poly of atom.object.polys) {
        if (seen.has(poly)) continue;
        seen.add(poly);
        const app = poly.appflags ?? 0;
        if (!CLIMBABLE.has(app) || (surfaceWord(poly) & SURFACE_SKIP) !== 0) continue;
        list.push(poly);
      }
    }
  }
  byCell.set(key, list);
  return list;
}

/** A polygon's heights and footprint box, once per polygon (the hull does not move). */
interface PolyBounds { top: number; bottom: number; minX: number; maxX: number; minZ: number; maxZ: number }
const BOUNDS = new WeakMap<WorldPoly, PolyBounds>();
function boundsOf(poly: WorldPoly): PolyBounds {
  let b = BOUNDS.get(poly);
  if (b) return b;
  const p = poly.points;
  b = { top: -Infinity, bottom: Infinity, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    const px = p[i]!, py = p[i + 1]!, pz = p[i + 2]!;
    if (py > b.top) b.top = py;
    if (py < b.bottom) b.bottom = py;
    if (px < b.minX) b.minX = px;
    if (px > b.maxX) b.maxX = px;
    if (pz < b.minZ) b.minZ = pz;
    if (pz > b.maxZ) b.maxZ = pz;
  }
  BOUNDS.set(poly, b);
  return b;
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
  const h = c.top + footStepOffset(c.poly.material) - y;
  const cls = climbClass(h, c.app);
  if (!cls) return null;
  // The target (`FUN_005b3a60`, decomp 469016-469080): the contact point on the top edge pulled in to 3 from an end
  // it is nearer, the midpoint when both are; appflags 1 always takes the midpoint.
  const [ax, az, bx, bz] = c.edge;
  const len = Math.hypot(bx - ax, bz - az);
  let t = 0.5;
  if (len > 2 * EDGE_END && c.app !== 1) {
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
