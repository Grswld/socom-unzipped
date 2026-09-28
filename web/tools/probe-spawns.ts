/**
 * The ground probe at every measured spawn: all 22 maps, 44 points, one row each (web sprint 1, W1.4 step 3).
 *
 * For each spawn the probe asks the map's grid for the candidates under (x, z) and picks the floor from the
 * origin y + 5, the way the engine does (`@s2u/scene`'s `probe.ts`; research 23 section 1.1, research 24
 * section 2). The residual is the floor's y less the spawn's measured y; the spec's bar item 3 is every residual
 * inside research 24 section 3's window, [-3, +1]. The foot gives the median, p99 and max of |residual| over the
 * points that found a floor, and the count inside the window -- over all 44, and over the actor-measured ones.
 * Ruling W1.R10 reads bar item 3 as the window at the actor-measured rows (and Frostfire's walkway column, a unit
 * test), and at the camera rows the offset of the recorded y over the floor, with its median, p99 and max.
 *
 * **What the table's y is.** Two maps' rows are the actor block (KNOWN section 1: Frostfire, Vigilance). The other
 * twenty are research 33's sweep, whose spawn column is `online_match_ours`'s `[peek] @416054` row, "the local
 * player's ORBITING CAMERA record" (tools_py/parity/online_match_ours.py:42-45) -- about 23 behind the player and,
 * on flat ground, 25 over its feet. The `src` column says which; a camera row cannot land in the window. The
 * `ring` column tests that reading: of 72 points on a circle of research 18's orbit radius (23.1) round the row,
 * how many stand on a floor at the recorded y - 25 (within 1.5) -- where the camera's player would be.
 *
 * **The opening stand** (W1.4b): the `stand` column, on A's row, is the y the viewer's fly camera opens at --
 * `openingStand` (`packages/viewer/src/stand.ts`), `EYE` (20) over this row's floor, or over the recorded y where
 * the probe found none.
 *
 *   npx tsx tools/probe-spawns.ts            all 22, from public/maps/
 *   npx tsx tools/probe-spawns.ts MP2 MP6    just these
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type MapInfo } from '@s2u/archive';
import {
  buildGrid, collisionOwners, parseSceneGraph, parseWorldRoot, probeGround, probeFloor, spawnsFor, worldCollision,
} from '@s2u/scene';
import { openingStand } from '../packages/viewer/src/stand';

const maps = resolve(import.meta.dirname, '../public/maps');
/** Research 24 section 3's window: a floor this far under or over the actor's y is the actor's floor. */
const WINDOW: [number, number] = [-3, 1];
/** The maps whose spawn rows were read off the actor block (`spawns.ts`, KNOWN section 1), not the camera record. */
const ACTOR_MEASURED = new Set(['FROSTFIRE', 'VIGILANCE']);
/** The third-person camera's orbit radius (research 18, "camera orbit radius, units", mean 23.09). */
const ORBIT = 23.1;
/** The camera's height over the feet the camera rows suggest: the modal offset on flat ground. */
const CAMERA_HEIGHT = 25;

const index = JSON.parse(readFileSync(resolve(maps, 'index.json'), 'utf8')) as MapInfo[];
const wanted = process.argv.slice(2).map((a) => a.toUpperCase());
const residuals: number[] = [];
const actorResiduals: number[] = [];
const cameraOffsets: number[] = [];
let points = 0, inside = 0, actorPoints = 0, actorInside = 0, ringed = 0;

console.log('archive  name              spawn  src     x        y       z        polys  cands  floor     residual  in   ring   stand');
for (const map of index) {
  if (wanted.length && !wanted.includes(map.archive)) continue;
  const bytes = readFileSync(resolve(maps, map.path));
  const toc = parseZdb(bytes);
  const graph = parseSceneGraph(Zar.parse(zdbMember(bytes, toc, `${map.archive}_GEO.ZED`)));
  const root = parseWorldRoot(Zar.parse(zdbMember(bytes, toc, `${map.archive}.ZED`)));
  const polys = worldCollision(graph);
  const grid = buildGrid(root.grid, [], [], polys, collisionOwners(graph));
  const spawns = spawnsFor(map.name);
  if (!spawns) { console.log(`${map.archive.padEnd(8)} ${map.name.padEnd(17)} no measured spawns`); continue; }
  for (const [label, [x, y, z]] of [['A', spawns.a], ['B', spawns.b]] as const) {
    points++;
    const actor = ACTOR_MEASURED.has(map.name);
    if (actor) actorPoints++;
    const candidates = probeGround(grid, x, z).length;
    const floor = probeFloor(grid, x, y, z);
    const residual = floor === null ? null : floor.y - y;
    const ok = residual !== null && residual >= WINDOW[0] && residual <= WINDOW[1];
    if (ok) inside++;
    if (ok && actor) actorInside++;
    if (residual !== null) residuals.push(Math.abs(residual));
    if (residual !== null && actor) actorResiduals.push(Math.abs(residual));
    if (residual !== null && !actor) cameraOffsets.push(-residual);
    let ring = 0;
    for (let a = 0; a < 360; a += 5) {
      const r = (a * Math.PI) / 180;
      const f = probeFloor(grid, x + ORBIT * Math.cos(r), y - CAMERA_HEIGHT, z + ORBIT * Math.sin(r));
      if (f && Math.abs(f.y - (y - CAMERA_HEIGHT)) <= 1.5) ring++;
    }
    if (!actor && ring > 0) ringed++;
    const row = `${map.archive.padEnd(8)} ${map.name.padEnd(17)} ${label.padEnd(6)} ${(actor ? 'actor' : 'camera').padEnd(7)} `
      + `${String(x).padEnd(8)} ${String(y).padEnd(7)} `
      + `${String(z).padEnd(8)} ${String(polys.length).padStart(5)}  ${String(candidates).padStart(5)}  `
      + `${(floor === null ? '-' : floor.y.toFixed(3)).padStart(8)}  ${(residual === null ? '-' : residual.toFixed(3)).padStart(8)}  ${(ok ? 'yes' : 'NO').padEnd(3)}`
      + `  ${String(ring).padStart(2)}/72`
      + `  ${label === 'A' ? openingStand([x, y, z], grid).position[1].toFixed(3).padStart(8) : '       -'}`;
    console.log(row);
  }
}

/** Median, p99 and max of some magnitudes, nearest-rank. */
function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? NaN;
  return `median ${at(0.5).toFixed(3)}, p99 ${at(0.99).toFixed(3)}, max ${(sorted.at(-1) ?? NaN).toFixed(3)}`;
}
console.log(`\n${inside} of ${points} inside [${WINDOW[0]}, +${WINDOW[1]}]; ${residuals.length} found a floor. |residual|: ${summary(residuals)}`);
console.log(`actor-measured rows: ${actorInside} of ${actorPoints} inside; |residual|: ${summary(actorResiduals)}`);
const near25 = cameraOffsets.filter((o) => Math.abs(o - CAMERA_HEIGHT) <= 3).length;
console.log(`camera rows: recorded y over the floor ${summary(cameraOffsets)}, min ${Math.min(...cameraOffsets).toFixed(3)}; `
  + `${near25} of ${cameraOffsets.length} within ${CAMERA_HEIGHT} +- 3; ${ringed} of ${cameraOffsets.length} with a floor at y - ${CAMERA_HEIGHT} on the ${ORBIT} ring`);
