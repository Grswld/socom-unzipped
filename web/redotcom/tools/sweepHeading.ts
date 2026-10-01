/**
 * The release sweep's mark heading (release review PL-1; `./release-sweep.ts`): of the eight headings from the spawn,
 * the one whose first STRIKABLE surface is nearest, so the magazine it fires there has something to mark.
 *
 * Strikable is the rounds' own rule: a surface whose `PENETRATION` (`materials.rdr` SOILS) is exactly 1 is passed over
 * with no mark and no impact (`HandleIntersections` FUN_003c9b70, decomp 320028-320030: `if (fVar15 != 1.0)`; research 84
 * section 13; the page's `accuracy.ts` `penetrate`); every other one is struck. The sweep used to take the heading the
 * walk got least far along, which on MP71 is blocked only by INVISIBLE_DI (PENETRATION 1): the round met nothing there
 * by rule, and the sweep reported "no mark" (release review, the MP71 survivor).
 *
 * Pure, for `test/sweepHeading.test.ts`; the page's side is `window.__viewer.surfacesAlong` (`Fire.surfacesAlong`).
 */

/** A surface down a heading: how far from the eye, and its material's `PENETRATION`. */
export interface HeadingSurface { distance: number; penetration: number }
/** One heading's surfaces, nearest first. */
export interface HeadingCandidate { yaw: number; surfaces: readonly HeadingSurface[] }

/** The eight headings the sweep tries from the spawn, in the order it tries them (degrees, the page's yaw). */
export const SWEEP_YAWS: readonly number[] = [0, 45, 90, 135, 180, 225, 270, 315];

/** The first surface a round down this line would strike (PENETRATION not exactly 1), or null. */
export function firstStrikable(surfaces: readonly HeadingSurface[]): HeadingSurface | null {
  return surfaces.find((s) => s.penetration !== 1) ?? null;
}

/**
 * The heading whose first strikable surface is nearest, and how far that surface is; null when no heading has one
 * (then the sweep fires no "no mark" finding: a round that meets nothing strikable marks nothing, by the game's rule).
 * A tie keeps the earlier heading.
 */
export function sweepHeading(candidates: readonly HeadingCandidate[]): { yaw: number; distance: number } | null {
  let best: { yaw: number; distance: number } | null = null;
  for (const c of candidates) {
    const s = firstStrikable(c.surfaces);
    if (s && (best === null || s.distance < best.distance)) best = { yaw: c.yaw, distance: s.distance };
  }
  return best;
}

/**
 * The level unit direction the page's camera looks down at `yaw` degrees: `camera.ts` reads a pose's yaw as
 * `atan2(-dx, -dz)` (the camera looks down its own -z), so forward is `(-sin yaw, 0, -cos yaw)`.
 */
export function levelDirection(yaw: number): [number, number, number] {
  const r = (yaw * Math.PI) / 180;
  return [-Math.sin(r), 0, -Math.cos(r)];
}
