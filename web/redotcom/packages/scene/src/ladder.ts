import { polygonNormal, type WorldPoly } from './collision';
import { probeGround, type Hit } from './probe';
import type { Grid } from './grid';

/**
 * The ladders of a map's hull (web research 86 section 2).
 *
 * **How a ladder is marked.** Not by name (the ELF has no lowercase "ladder" string; the nodes are called `ladderdown`,
 * `di_ladder`, `ladder35`, `ladders` ...) but by the collision polygon's `m_appflags` (`DI_PARAMS`, reCOM
 * `zIntersect/zintersect.h:26`; surface word bits 20-22): **2 on every ladder polygon of the 22 maps and on nothing
 * else** (a census of all 197,993 placed polygons: 94 carry it, 38 ladders on 14 maps, research 86 section 2.1). Each ladder is two `m_ditype` 2 (side-only)
 * quads in one vertical plane: the **span**, from the bottom floor to the top floor, and above it a **cap** about 10
 * tall (9.4 to 10.0) wound the other way. The exporter repeats a prototype's `di` on the node instancing it, so a
 * ladder can come twice (`worldmodel/ladder` and `worldmodel/ladder=ladder` on MP61); the copies are merged.
 *
 * **Which side is climbed.** The side the top floor is not on: the deck the climber steps off onto lies behind the
 * ladder's plane at the span's top, and the climber stands in front of it at the bottom. `findLadders` asks the
 * ground probe for a floor within `FLOOR_TOLERANCE` of the top a short step either side of the plane; with no deck
 * found (a ladder onto a roof edge the probe misses) the bottom floor's side decides.
 */

/** `m_appflags` on a ladder's polygons (the header). */
export const APP_LADDER = 2;

/** One ladder: its plane, its span, and the side it is climbed from. */
export interface Ladder {
  /** The span's centre across its width, on the plane (x, z), world space. */
  x: number;
  z: number;
  /** The span's foot and head: the bottom floor and the top floor the ladder joins. */
  bottom: number;
  top: number;
  /** The cap's head: the span's top plus the ~10 above it. */
  capTop: number;
  /** The unit horizontal normal pointing to the side the climber stands on (away from the top deck). */
  nx: number;
  nz: number;
  /** Half the span's width along the plane. */
  halfWidth: number;
  /** Whether the climbing side came from the top deck's probe (true) or the bottom floor's alone (false). */
  sided: boolean;
  /** The node path of the span's owner, for saying which ladder. */
  path: string;
}

/** How far either side of the plane the deck and the floor are looked for, and how near the probe's floor must be. */
const SIDE_STEP = 6, FLOOR_TOLERANCE = 2.5;
/** Two ladder polygons are one ladder when their planes and centres are this close. */
const SAME = 1;

interface Part { poly: WorldPoly; cx: number; cz: number; minY: number; maxY: number; nx: number; nz: number; half: number }

function partOf(poly: WorldPoly): Part | null {
  const n = polygonNormal(poly.points);
  if (!n) return null;
  const h = Math.hypot(n[0], n[2]);
  if (h < 0.7) return null;                                    // not a vertical plane
  const nx = n[0] / h, nz = n[2] / h;
  const p = poly.points, count = p.length / 3;
  let minY = Infinity, maxY = -Infinity, lo = Infinity, hi = -Infinity, cx = 0, cz = 0;
  for (let i = 0; i < count; i++) {
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    const along = -nz * x + nx * z;                             // the plane's horizontal axis
    lo = Math.min(lo, along); hi = Math.max(hi, along);
    cx += x / count; cz += z / count;
  }
  // The centre across the width, on the plane.
  const mid = (lo + hi) / 2, d = nx * cx + nz * cz;
  return { poly, cx: nx * d - nz * mid, cz: nz * d + nx * mid, minY, maxY, nx, nz, half: (hi - lo) / 2 };
}

/** The probe's floor at (x, z) nearest `y` within the tolerance, or null. */
function floorNear(grid: Grid, x: number, z: number, y: number): Hit | null {
  let best: Hit | null = null;
  for (const h of probeGround(grid, x, z)) if (Math.abs(h.y - y) <= FLOOR_TOLERANCE && (!best || Math.abs(h.y - y) < Math.abs(best.y - y))) best = h;
  return best;
}

/**
 * Every ladder of a hull: the `APP_LADDER` polygons grouped by plane and place (the span and its cap, the copies
 * merged), each sided against the ground probe's floors when `grid` is given (the header). A group with no span
 * taller than its cap is dropped.
 */
export function findLadders(polys: readonly WorldPoly[], grid?: Grid): Ladder[] {
  const parts = polys.filter((p) => (p.appflags ?? 0) === APP_LADDER).map(partOf).filter((p): p is Part => p !== null);
  const groups: Part[][] = [];
  for (const part of parts) {
    const g = groups.find((list) => list.some((o) =>
      Math.abs(Math.abs(o.nx * part.nx + o.nz * part.nz) - 1) < 1e-3 && Math.hypot(o.cx - part.cx, o.cz - part.cz) < SAME + o.half));
    if (g) g.push(part); else groups.push([part]);
  }
  const out: Ladder[] = [];
  for (const g of groups) {
    const span = g.reduce((a, b) => (b.maxY - b.minY > a.maxY - a.minY ? b : a));
    const capTop = Math.max(...g.map((p) => p.maxY));
    const ladder: Ladder = {
      x: span.cx, z: span.cz, bottom: span.minY, top: span.maxY, capTop,
      nx: span.nx, nz: span.nz, halfWidth: span.half, sided: false, path: span.poly.path,
    };
    if (grid) side(grid, ladder);
    if (!out.some((o) => Math.hypot(o.x - ladder.x, o.z - ladder.z) < SAME && Math.abs(o.top - ladder.top) < SAME)) out.push(ladder);
  }
  return out;
}

/** Turns the ladder's normal toward the side it is climbed from (the header), in place. */
function side(grid: Grid, l: Ladder): void {
  const at = (s: number, y: number): Hit | null => floorNear(grid, l.x + l.nx * SIDE_STEP * s, l.z + l.nz * SIDE_STEP * s, y);
  const deckFront = at(1, l.top) !== null, deckBack = at(-1, l.top) !== null;
  if (deckFront !== deckBack) {
    if (deckFront) { l.nx = -l.nx; l.nz = -l.nz; }
    l.sided = true;
    return;
  }
  const floorFront = at(1, l.bottom) !== null, floorBack = at(-1, l.bottom) !== null;
  if (!floorFront && floorBack) { l.nx = -l.nx; l.nz = -l.nz; }
}

/**
 * Where a body at (x, z) stands against a ladder: `out` its distance in front of the plane along the climbing side's
 * normal (negative behind), `across` its offset along the plane from the span's centre.
 */
export function ladderFrame(l: Ladder, x: number, z: number): { out: number; across: number } {
  const dx = x - l.x, dz = z - l.z;
  return { out: dx * l.nx + dz * l.nz, across: -dx * l.nz + dz * l.nx };
}
