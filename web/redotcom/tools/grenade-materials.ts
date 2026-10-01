/**
 * The grenades' bounce and explosion materials on every map (research 85 §9.9): each material byte of the map's hull
 * (`worldCollision`, what the walk's grid is built from) resolved as `gridCast` resolves it (`surfaceMaterial`: byte 0
 * is the world root's `DefaultMaterial` by name, byte i >= 2 is `materials.rdr`'s SOILS[i - 2]), the zAnim names the
 * grenade code asks for with it (`materialAnim`: `grenade_hit_<material>` on a bounce, `frag_grenade_<material>` /
 * `claymore_<material>` on a detonation), whether the map's `CZANIM.ZAR` holds each, the sounds a zAnim plays
 * directly (`callbackSounds`, the audio's door) and whether the map's banks hold them.
 *
 *   npx tsx tools/grenade-materials.ts            # every RUN/MP*.ZDB under public/maps (or test-fixtures)
 *   npx tsx tools/grenade-materials.ts MP2 MP6
 *
 * A row's `hit` / `boom` columns: the anim name when the archive holds it, `-` when it does not (the grenade code then
 * falls back to the base anim); `sounds` the direct sounds, `(calls: ...)` the other names an anim without a direct
 * sound carries (its sound is behind a call), `MISSING` a sound the map's banks lack.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRdr, parseZdb, Zar, zdbMember } from '@s2u/archive';
import {
  CLAYMORE, M67, materialAnim, materialTable, parseAnimSets, parseSceneGraph, parseWorldRoot, soilsTable, surfaceMaterial,
  worldCollision,
} from '@s2u/scene';
import { callbackSounds, parseBankFile } from '@s2u/sound';

const web = resolve(import.meta.dirname, '..');
const dir = [resolve(web, 'public/maps/RUN'), resolve(web, 'test-fixtures/RUN')].find((d) => existsSync(d));
if (!dir) throw new Error('no map archives: run npm run extract-maps');

let stems = process.argv.slice(2).map((a) => a.toUpperCase().replace(/\.ZDB$/, ''));
if (!stems.length) {
  stems = readdirSync(dir).filter((f) => /^MP\d+\.ZDB$/i.test(f)).map((f) => f.replace(/\.ZDB$/i, ''))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

const readerc = Zar.parse(new Uint8Array(readFileSync(resolve(dir, 'READERC.ZAR'))));
const matKey = readerc.root.children.find((k) => k.name.toLowerCase() === 'materials.rdr')!;
const table = materialTable(soilsTable(parseRdr(readerc.data(matKey))));
const bnkPath = resolve(dir, 'SOUNDS/BNKSTORE.ZAR');
const bnkstore = existsSync(bnkPath) ? Zar.parse(new Uint8Array(readFileSync(bnkPath))) : null;

const problems: string[] = [];
console.log('| map | default | byte | material | polys | hit | boom | claymore | sounds |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const stem of stems) {
  const zdb = new Uint8Array(readFileSync(resolve(dir, `${stem}.ZDB`)));
  const toc = parseZdb(zdb);
  const graph = parseSceneGraph(Zar.parse(zdbMember(zdb, toc, `${stem}_GEO.ZED`)));
  const root = parseWorldRoot(Zar.parse(zdbMember(zdb, toc, `${stem}.ZED`)));
  const polys = worldCollision(graph);
  const czanim = Zar.parse(zdbMember(zdb, toc, 'CZANIM.ZAR'));
  const sets = parseAnimSets(czanim);
  const anims = new Map(sets.sets.flatMap((s) => s.anims.map((a) => [a.name, a] as const)));
  // A command's payload bytes out of the animation's `Seq_Data` (the audio's `ZAnimPayload`, research 81 §6).
  const payload = (set: string, anim: string, offset: number, length: number): Uint8Array | null => {
    const key = czanim.find(`Anim_Sets/${set}/Animation_List/${anim}/Seq_Data`);
    if (!key || offset + length > key.size) return null;
    return czanim.data(key).subarray(offset, offset + length);
  };
  const sounds = callbackSounds(sets, payload);
  const bankNames = new Set<string>();
  for (const kind of ['am', 'fx', 'vc']) {
    const key = bnkstore?.root.children.find((k) => k.name.toLowerCase() === `${stem.toLowerCase()}_${kind}.bnk`);
    if (key) for (const n of parseBankFile(bnkstore!.data(key)).names.keys()) bankNames.add(n.trim());
  }
  if (!table.some((m) => m.name === root.defaultMaterial)) problems.push(`${stem}: DefaultMaterial '${root.defaultMaterial}' is not in the table`);
  const count = new Map<number, number>();
  for (const p of polys) count.set(p.material, (count.get(p.material) ?? 0) + 1);
  for (const [byte, n] of [...count].sort((a, b) => a[0] - b[0])) {
    const m = surfaceMaterial(byte, root.defaultMaterial, table);
    if (byte >= table.length) problems.push(`${stem}: byte ${byte} past the table (${table.length}) -> ${m.name}`);
    if (m.name === 'UNKNOWN' && byte !== 1) problems.push(`${stem}: byte ${byte} resolves to UNKNOWN`);
    const has = (name: string): string => (anims.has(name) ? name : '-');
    const hit = materialAnim(M67.hitAnim, m.name), boom = materialAnim(M67.materialAnim ?? M67.explosionAnim, m.name);
    const clay = materialAnim(CLAYMORE.materialAnim ?? CLAYMORE.explosionAnim, m.name);
    if (!anims.has(hit)) problems.push(`${stem}: no ${hit} (byte ${byte}, ${n} polys)`);
    const heard = (name: string): string => {
      const a = anims.get(name);
      if (!a) return '';
      const direct = sounds.get(name);
      if (direct) {
        const missing = direct.filter((s) => bankNames.size && !bankNames.has(s.trim()));
        for (const s of missing) problems.push(`${stem}: ${name} plays ${s}, not in the map's banks`);
        return direct.map((s) => (missing.includes(s) ? `${s.trim()} MISSING` : s.trim())).join(' ');
      }
      return `(calls: ${a.names.filter((x) => x !== name).join(' ') || 'nothing named'})`;
    };
    console.log(`| ${stem} | ${root.defaultMaterial} | ${byte} | ${m.name} | ${n} | ${has(hit)} | ${has(boom)} | ${has(clay)} | ${heard(hit)} |`);
  }
}
console.log(`\n${problems.length} problem(s)`);
for (const p of problems) console.log(`- ${p}`);
