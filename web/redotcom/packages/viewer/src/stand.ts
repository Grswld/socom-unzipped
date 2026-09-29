import { probeFloor, type Grid } from '@s2u/scene';

/**
 * The opening stand (web sprint 1, W1.4b): where the fly camera stands when a map with measured spawns loads.
 *
 * Spawn A's (x, z), `EYE` over the floor the ground probe finds there. A's recorded y (`spawns.ts`) is the actor's
 * feet only on Frostfire and Vigilance (`KNOWN.md` section 1); on the other 20 maps it is the third-person orbit
 * camera's, 25 over the floor on flat ground (the spec's W1.4 finding, W1.R10), so a stand at the recorded y +
 * `EYE` stood about 45 over the floor there. The probe is `probeFloor` from the recorded y: the origin y + 5 and
 * research 24 section 2's pick -- the highest candidate at or under the origin + 1, else the lowest, none more than
 * 20 over y -- which finds a floor under all 44 rows, feet and camera alike (`tools/probe-spawns.ts`: the 4 feet
 * rows 0-1.1 over theirs, the 40 camera rows 12.7-38.1). Where it finds none, or the map has no ground, the stand
 * is the recorded y + `EYE`, as it was before W1.4b.
 *
 * The (x, z) stays A's own: on the 20 camera-row maps that is where the player's camera opened, 20-28 units
 * behind the actor's slot (web/docs/research/75 §11), and the view from it toward B is the one they saw.
 */

/**
 * The fly camera's height over the floor at the opening stand, in game units: 2 m at `MetersPerUnit` 0.1, a little
 * over the walk's eye at 15.4 (W1.R2).
 */
export const EYE = 20;

/** Where the camera opens on a map, and the floor it stands over. Plain numbers: it crosses the worker's `postMessage`. */
export interface Stand {
  /** The fly camera's opening position: A's (x, z), `EYE` over `floor` -- over A's recorded y where that is null. */
  position: [number, number, number];
  /** The ground probe's floor under A, or null where it found none or the map has no ground. */
  floor: number | null;
}

/** The opening stand at spawn A (`a`, as `spawns.ts` records it) over the probe's grid, when the map has one. */
export function openingStand(a: readonly [number, number, number], ground: Grid | undefined, eye: number = EYE): Stand {
  const [x, y, z] = a;
  const hit = ground ? probeFloor(ground, x, y, z) : null;
  const floor = hit ? hit.y : null;
  return { position: [x, (floor ?? y) + eye, z], floor };
}
