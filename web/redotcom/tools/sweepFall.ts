/**
 * The release sweep's fall-through check (release review PL-1; `./release-sweep.ts`): the feet against the floor the walk
 * picks under them, frame by frame.
 *
 * The pick is the game's: `FUN_005b5d40` (decomp 470163-470290) takes the highest candidate at or under the probe's
 * origin + 1, else the lowest, refused over 20 above the feet -- the page's `selectFloor(probeGround(x, z), from +
 * PROBE_LIFT, y)` (`@s2u/scene` probe.ts; research 86 section 6.3), with `from` the feet as they were in the air and the
 * feet themselves on the ground (`mover.ts` `fall` / `probeFloor`). `FUN_0059ad30` (456313-456322) puts the feet on that
 * floor whenever they are under it, rising or falling; only the running jump's wind-up (`actor+0x1360` > 0) lets them
 * sink, 0.98 in five ticks (`mover.ts` `fall`). So feet more than `FALL_MARGIN` under the pick after a frame are feet
 * that went through a floor the mover should have stood on: a fall through the map.
 *
 * The sweep used to file a fall-through on the descent from the spawn's floor (`minYBelowSpawn` > 150), which terrain that
 * drops away trips as readily: MP1's running jump off a bank and MP11's walk downhill (release review, the MP1/MP11
 * survivor). That descent is kept as information only (`descentBelow`).
 *
 * Pure, for `test/sweepFall.test.ts`; the page's side is `window.__viewer.floorUnder`.
 */

/** One recorded frame: when (ms), the feet (null: not walking), airborne, and the floor the walk picks under them. */
export interface FallFrame { t: number; feet: readonly number[] | null; air: boolean; floor: number | null }

/**
 * Units the feet may stand under the pick before it is a fall-through: over the wind-up's 0.98 sink (the one place the
 * game leaves the feet under the floor) and far under any floor a fall goes through (a frame's fall is units deep).
 */
export const FALL_MARGIN = 1;

/** A run of consecutive frames with the feet under the pick: its first frame's time, its length, the deepest, airborne. */
export interface FallThrough { t: number; frames: number; depth: number; air: boolean }

/** Every run of frames whose feet stand more than `FALL_MARGIN` under the floor picked under them. */
export function fallThroughs(frames: readonly FallFrame[]): FallThrough[] {
  const out: FallThrough[] = [];
  let run: FallThrough | null = null;
  for (const f of frames) {
    const y = f.feet?.[1];
    const depth = y === undefined || f.floor === null ? null : f.floor - y;
    if (depth !== null && depth > FALL_MARGIN) {
      const d = +depth.toFixed(1);
      if (run) { run.frames++; run.depth = Math.max(run.depth, d); }
      else { run = { t: f.t, frames: 1, depth: d, air: f.air }; out.push(run); }
    } else run = null;
  }
  return out;
}

/** The lowest feet under `spawnFloor` over the frames (the old `minYBelowSpawn`, information only), or null. */
export function descentBelow(spawnFloor: number, frames: readonly FallFrame[]): number | null {
  const ys = frames.flatMap((f) => (f.feet ? [f.feet[1]!] : []));
  return ys.length ? +(spawnFloor - Math.min(...ys)).toFixed(1) : null;
}
