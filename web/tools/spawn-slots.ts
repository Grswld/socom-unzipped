/**
 * The spawn overlay's slots against the 44 measured spawns (W1.5b; the spec's W1.R9): per map and side,
 * the slots `placeSpawnSlots` places -- the function the viewer's worker runs on `AIMAPS.MPS` -- and the
 * one that accounts for the measured position (`fitSlot`, `accountsFor`: at its centre, or up to 30 units
 * ahead along its facing within half a cell). One row per measured position, then the counts.
 *
 *   npx tsx tools/spawn-slots.ts            # every RUN/MP*.ZDB under public/maps (or test-fixtures)
 *   npx tsx tools/spawn-slots.ts MP2 MP6
 *
 * `tools/aimaps-spawns.ts` is research 75 §7's table over the raw records; this one is what is drawn.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRdr, parseZdb, rdrGet, Zar, zdbMember } from '@s2u/archive';
import { accountsFor, aiMapsFromZdb, fitSlot, placeSpawnSlots, spawnsFor } from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');
const dir = [resolve(web, 'public/maps/RUN'), resolve(web, 'test-fixtures/RUN')].find((d) => existsSync(d));
if (!dir) throw new Error('no map archives: run npm run extract-maps');

let stems = process.argv.slice(2).map((a) => a.toUpperCase().replace(/\.ZDB$/, ''));
if (!stems.length) {
  stems = readdirSync(dir).filter((f) => /^MP\d+\.ZDB$/i.test(f)).map((f) => f.replace(/\.ZDB$/i, ''))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/** The name the game shows: `mission.rdr`'s `description` (web/docs/research/72 §0). */
function shownName(zdb: Uint8Array): string {
  const readerm = Zar.parse(zdbMember(zdb, parseZdb(zdb), 'READERM.ZAR'));
  const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr');
  const name = mission && rdrGet(parseRdr(readerm.data(mission)), 'description');
  if (typeof name !== 'string') throw new Error('no mission.rdr description');
  return name;
}

const f1 = (v: number) => v.toFixed(1);
const tally = { rows: 0, at: 0, ahead: 0, missed: 0, slots: 0, held: 0 };
console.log('| map | side | measured (x, y, z) | slots | slot | cell | step | along | perp | dist | W1.R9 | slot y |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const stem of stems) {
  const zdb = new Uint8Array(readFileSync(resolve(dir, `${stem}.ZDB`)));
  const name = shownName(zdb);
  const measured = spawnsFor(name);
  const slots = placeSpawnSlots(aiMapsFromZdb(zdb), measured);
  tally.slots += slots.length;
  if (!measured) { console.log(`| ${stem} ${name} | no measured spawns | | ${slots.length} | | | | | | | | |`); continue; }
  for (const s of slots) if (s.position[1] !== (s.side === 0 ? measured.a : measured.b)[1]) tally.held++;
  for (const [label, side, [x, y, z]] of [['A', 0, measured.a], ['B', 1, measured.b]] as const) {
    tally.rows++;
    const count = slots.filter((s) => s.side === side).length;
    const fit = fitSlot(slots, side, x, z);
    const ok = accountsFor(fit);
    const how = !ok ? 'MISSED' : fit!.distance <= 1 ? 'at' : 'ahead';
    if (how === 'at') tally.at++;
    else if (how === 'ahead') tally.ahead++;
    else tally.missed++;
    const map = label === 'A' ? `${stem} ${name}` : '';
    if (!fit) { console.log(`| ${map} | ${label} ${side} | ${x}, ${y}, ${z} | ${count} | none within 30 | | | | | | ${how} | |`); continue; }
    const { slot } = fit;
    console.log(`| ${map} | ${label} ${side} | ${x}, ${y}, ${z} | ${count} | #${slot.index} | ${slot.loc.map}:(${slot.loc.x},${slot.loc.z}) `
      + `| ${slot.step} | ${f1(fit.along)} | ${f1(fit.perp)} | ${f1(fit.distance)} | ${how} | ${f1(slot.position[1])} |`);
  }
}
console.log(`\n${tally.rows} measured positions: ${tally.at} at a slot's centre, ${tally.ahead} ahead of one, `
  + `${tally.missed} missed (W1.R9: at, or up to 30 ahead along the facing within 5 across). `
  + `${tally.slots} slots placed; ${tally.held} of them with the y held inside their sub-map's height range.`);
