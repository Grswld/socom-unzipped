/**
 * The spawn overlay's slots against the 44 measured spawns (W1.5b; the spec's W1.R9): per map and side,
 * the slots `placeSpawnSlots` places -- the function the viewer's worker runs on `AIMAPS.MPS`, here over the
 * same ground probe, so each slot's y is the floor under its centre (W1.4b) -- and the one that accounts for
 * the measured position (`fitSlot`, `accountsFor`: at its centre -- the actor's feet -- or up to 30 units
 * behind it along its facing within half a cell -- the orbit camera behind the actor, research 75 §11). One
 * row per measured position, then the counts. `on floor` is how many of the side's slots the probe found a
 * floor under; the rest keep the estimate (the side's measured y held inside the sub-map's height range).
 *
 *   npx tsx tools/spawn-slots.ts            # every RUN/MP*.ZDB under public/maps (or test-fixtures)
 *   npx tsx tools/spawn-slots.ts MP2 MP6
 *
 * `tools/aimaps-spawns.ts` is research 75 §7's table over the raw records; this one is what is drawn.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRdr, parseZdb, rdrGet, Zar, zdbMember } from '@s2u/archive';
import {
  accountsFor, aiMapsFromZdb, buildGrid, collisionOwners, fitSlot, parseSceneGraph, parseWorldRoot, placeSpawnSlots,
  spawnsFor, worldCollision, type Grid,
} from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');
const dir = [resolve(web, 'public/maps/RUN'), resolve(web, 'test-fixtures/RUN')].find((d) => existsSync(d));
if (!dir) throw new Error('no map archives: run npm run extract-maps');

let stems = process.argv.slice(2).map((a) => a.toUpperCase().replace(/\.ZDB$/, ''));
if (!stems.length) {
  stems = readdirSync(dir).filter((f) => /^MP\d+\.ZDB$/i.test(f)).map((f) => f.replace(/\.ZDB$/i, ''))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/** The name the game shows: `mission.rdr`'s `description` (web/redotcom/docs/research/72 §0). */
function shownName(zdb: Uint8Array): string {
  const readerm = Zar.parse(zdbMember(zdb, parseZdb(zdb), 'READERM.ZAR'));
  const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr');
  const name = mission && rdrGet(parseRdr(readerm.data(mission)), 'description');
  if (typeof name !== 'string') throw new Error('no mission.rdr description');
  return name;
}

/** The ground probe's grid as the viewer's worker has it: the world's polygons, their nodes, `grid_params` (W1.4). */
function probeGrid(zdb: Uint8Array, stem: string): Grid {
  const toc = parseZdb(zdb);
  const graph = parseSceneGraph(Zar.parse(zdbMember(zdb, toc, `${stem}_GEO.ZED`)));
  const root = parseWorldRoot(Zar.parse(zdbMember(zdb, toc, `${stem}.ZED`)));
  return buildGrid(root.grid, [], [], worldCollision(graph), collisionOwners(graph));
}

const f1 = (v: number) => v.toFixed(1);
const tally = { rows: 0, at: 0, behind: 0, missed: 0, slots: 0, held: 0, floor: 0 };
console.log('| map | side | measured (x, y, z) | slots | on floor | slot | cell | step | along | perp | dist | W1.R9 | slot y |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const stem of stems) {
  const zdb = new Uint8Array(readFileSync(resolve(dir, `${stem}.ZDB`)));
  const name = shownName(zdb);
  const measured = spawnsFor(name);
  const ai = aiMapsFromZdb(zdb);
  const slots = placeSpawnSlots(ai, measured, probeGrid(zdb, stem));
  tally.slots += slots.length;
  tally.floor += slots.filter((s) => s.onFloor).length;
  if (!measured) { console.log(`| ${stem} ${name} | no measured spawns | | ${slots.length} | ${slots.filter((s) => s.onFloor).length} | | | | | | | | |`); continue; }
  // The estimate the probe's floor replaces, and how often the sub-map's height range held it (W1.5b).
  for (const s of placeSpawnSlots(ai, measured)) if (s.position[1] !== (s.side === 0 ? measured.a : measured.b)[1]) tally.held++;
  for (const [label, side, [x, y, z]] of [['A', 0, measured.a], ['B', 1, measured.b]] as const) {
    tally.rows++;
    const count = slots.filter((s) => s.side === side).length;
    const grounded = slots.filter((s) => s.side === side && s.onFloor).length;
    const fit = fitSlot(slots, side, x, z);
    const ok = accountsFor(fit);
    const how = !ok ? 'MISSED' : fit!.distance <= 1 ? 'at' : 'behind';
    if (how === 'at') tally.at++;
    else if (how === 'behind') tally.behind++;
    else tally.missed++;
    const map = label === 'A' ? `${stem} ${name}` : '';
    if (!fit) { console.log(`| ${map} | ${label} ${side} | ${x}, ${y}, ${z} | ${count} | ${grounded} | none within 30 | | | | | | ${how} | |`); continue; }
    const { slot } = fit;
    console.log(`| ${map} | ${label} ${side} | ${x}, ${y}, ${z} | ${count} | ${grounded} | #${slot.index} | ${slot.loc.map}:(${slot.loc.x},${slot.loc.z}) `
      + `| ${slot.step} | ${f1(fit.along)} | ${f1(fit.perp)} | ${f1(fit.distance)} | ${how} | ${f1(slot.position[1])}${slot.onFloor ? '' : ' (estimate)'} |`);
  }
}
console.log(`\n${tally.rows} measured positions: ${tally.at} at a slot's centre, ${tally.behind} behind one, `
  + `${tally.missed} missed (W1.R9: at, or up to 30 behind along the facing within 5 across). `
  + `${tally.slots} slots placed; ${tally.floor} of them on the probe's floor under their centre (W1.4b), the rest at the estimate; `
  + `${tally.held} of the estimates held inside their sub-map's height range.`);
