/**
 * W1.R4's check: does each of the 44 measured spawn positions (`@s2u/scene` SPAWNS, docs/research/33 and
 * KNOWN section 1) fall inside its map's decoded `PlayerStart` -- and if not, what on the disc does it
 * stand on? One row per position, then the counts. web/redotcom/docs/research/75 §7 is this table.
 *
 *   npx tsx tools/aimaps-spawns.ts            # every RUN/MP*.ZDB under public/maps (or test-fixtures)
 *   npx tsx tools/aimaps-spawns.ts MP2 MP6
 *
 * Side 0 is A's, side 1 is B's: that is not assumed, it is the result -- the tool reports, per position,
 * the nearest slot of the *other* side too.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRdr, parseZdb, rdrGet, Zar, zdbMember } from '@s2u/archive';
import {
  aiCellCentre, aiMapsFromZdb, fitSpawn, namedPoint, spawnSlots, spawnsFor, type AiMaps,
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

const f1 = (v: number) => v.toFixed(1);
const nearestOther = (ai: AiMaps, side: 0 | 1, x: number, z: number) =>
  Math.min(...spawnSlots(ai, side === 0 ? 1 : 0).map((s) => Math.hypot(s.x - x, s.z - z)));

const tally = { rows: 0, inStart: 0, atSlot: 0, behind: 0, near: 0, sideOk: 0 };
console.log('map   name            side  measured (x, y, z)        PlayerStart cell (centre)       in?  '
  + '| slot fit: cell        flags  along   perp   dist | nearest other-side slot');
for (const stem of stems) {
  const zdb = new Uint8Array(readFileSync(resolve(dir, `${stem}.ZDB`)));
  const name = shownName(zdb);
  const measured = spawnsFor(name);
  if (!measured) { console.log(`${stem.padEnd(5)} ${name}: no measured spawns`); continue; }
  const ai = aiMapsFromZdb(zdb);
  const start = namedPoint(ai, 'playerstart', 'startplayer');
  for (const [label, side, [x, y, z]] of [['A', 0, measured.a], ['B', 1, measured.b]] as const) {
    tally.rows++;
    let startText = 'none';
    let inStart = false;
    if (start) {
      const [cx, cz] = aiCellCentre(start.sub, start.point.loc.x, start.point.loc.z);
      const h = start.sub.cellSize[0] / 2;
      inStart = Math.abs(x - cx) <= h && Math.abs(z - cz) <= start.sub.cellSize[1] / 2;
      startText = `${start.point.name} ${start.point.loc.map}:(${start.point.loc.x},${start.point.loc.z}) (${f1(cx)}, ${f1(cz)})`;
    }
    if (inStart) tally.inStart++;
    const fit = fitSpawn(ai, side, x, z);
    const same = Math.min(...spawnSlots(ai, side).map((s) => Math.hypot(s.x - x, s.z - z)));
    const other = nearestOther(ai, side, x, z);
    if (other > same) tally.sideOk++;
    let fitText = 'no slot behind within 30';
    if (fit) {
      const r = fit.slot.record;
      if (fit.distance <= 1) tally.atSlot++;
      else if (Math.abs(fit.perp) <= 5) tally.behind++;
      fitText = `${`${r.loc.map}:(${r.loc.x},${r.loc.z})`.padEnd(12)} 0x${r.flags.toString(16).padStart(2, '0')} `
        + `${f1(fit.along).padStart(6)} ${f1(fit.perp).padStart(6)} ${f1(fit.distance).padStart(6)}`;
    }
    if (!fit || (fit.distance > 1 && Math.abs(fit.perp) > 5)) tally.near++;
    console.log(`${stem.padEnd(5)} ${name.padEnd(15)} ${label} ${side}  (${[x, y, z].join(', ')})`.padEnd(49)
      + ` ${startText.padEnd(33)} ${inStart ? 'yes' : 'no '}  | ${fitText.padEnd(40)} | ${f1(other)} (nearest same-side slot ${f1(same)})`);
  }
}
console.log(`\n${tally.rows} positions: ${tally.inStart} inside their map's PlayerStart cell; `
  + `${tally.atSlot} at a slot's centre (<= 1 unit); ${tally.behind} behind a slot along its facing (|perp| <= 5; 75 §11: the orbit camera); `
  + `${tally.near} otherwise; ${tally.sideOk} nearer their own side's slots than the other side's`);
