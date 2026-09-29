/**
 * The character libraries of every map (web/docs/research/78 §4): each `CLIB_MDL.ZED` mesh decoded
 * (`readMeshLibrary`), its skeleton read out of `CLIB_GEO.ZED` (`readSkeleton`), and the bind palette checked
 * against the mesh (`influenceSpread`: how far apart a vertex's per-bone copies land). One line per map, then
 * the totals; `--models` adds a line per model. Exits non-zero when anything fails to decode.
 *
 *   npx tsx tools/dump-characters.ts [--models] [RUN/MP2.ZDB ...]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRdr, parseZdb, zdbMember, Zar } from '@s2u/archive';
import { influenceSpread, readMeshLibrary, RELOC_BONE, RELOC_DRAW, RELOC_MATRIX, RELOC_TEXTURE, meshChainTags } from '@s2u/mesh';
import { characterModelNames, parseCharacterTable, playerCharacter, readSkeleton, type CharacterTable } from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const perModel = args.includes('--models');
const named = args.filter((a) => !a.startsWith('--'));
const dir = resolve(web, 'public/maps/RUN');
const files = named.length ? named.map((a) => resolve(web, 'public/maps', a)) : readdirSync(dir).filter((f) => /^MP\d+\.ZDB$/i.test(f))
  .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))).map((f) => resolve(dir, f));

// The character types, beside the archives (78 §5): who each map's player is, and the gear it wears.
const readercPath = resolve(dir, 'READERC.ZAR');
let table: CharacterTable | null = null;
if (existsSync(readercPath)) {
  const z = Zar.parse(new Uint8Array(readFileSync(readercPath)));
  table = parseCharacterTable(parseRdr(z.data(z.root.children.find((k) => k.name === 'character.rdr')!)));
}

let failures = 0;
const totals = { maps: 0, meshes: 0, vertices: 0, triangles: 0, batches: 0, tags: 0, worstSpread: 0, maxInfluences: 0 };
const relocs: Record<string, number> = {};
const palettes = new Set<string>();
const skeletons = new Map<string, number>();
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const toc = parseZdb(bytes);
  const stem = file.replace(/^.*[\\/]/, '').replace(/\.ZDB$/i, '');
  const mdl = Zar.parse(zdbMember(bytes, toc, 'CLIB_MDL.ZED'));
  const geo = Zar.parse(zdbMember(bytes, toc, 'CLIB_GEO.ZED'));
  const lib = readMeshLibrary(mdl);
  const geoNames = new Set(characterModelNames(geo));
  let v = 0, t = 0, b = 0, worst = 0, inf = 0;
  const errors: string[] = [];
  for (const e of lib) {
    if (!geoNames.has(e.name)) errors.push(`${e.name}: no CLIB_GEO model`);
    if (e.error || !e.mesh) { errors.push(`${e.name}: ${e.error}`); continue; }
    for (const tag of meshChainTags(mdl.data(mdl.find(`MESH_${e.name}`)!), e.start, e.name)) {
      const k = `reloc ${tag.reloc}`;
      relocs[k] = (relocs[k] ?? 0) + 1;
    }
    let spread = 0;
    try {
      const s = readSkeleton(geo, e.name);
      if (s.size !== e.mtxCount) errors.push(`${e.name}: ${s.size} parts, mtx_count ${e.mtxCount}`);
      palettes.add(s.parts.map((p) => `${p.name}<${p.parent}`).join(','));
      skeletons.set(s.parts.map((p) => p.name).join(' '), (skeletons.get(s.parts.map((p) => p.name).join(' ')) ?? 0) + 1);
      for (const sub of e.mesh.subMeshes) spread = Math.max(spread, influenceSpread(sub, s.bindWorld));
      if (spread >= 0.002) errors.push(`${e.name}: the bind palette misses by ${spread.toFixed(4)}`);
    } catch (err) {
      errors.push(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    v += e.mesh.vertexCount; t += e.mesh.triangleCount; b += e.mesh.batches.length;
    worst = Math.max(worst, spread); inf = Math.max(inf, e.mesh.maxInfluences);
    totals.tags += e.tagCount;
    if (perModel) {
      console.log(`  ${stem} ${e.name}: ${e.mesh.vertexCount} v, ${e.mesh.triangleCount} t, ${e.mesh.batches.length} batches, `
        + `${e.mesh.subMeshes.length} textures, ${e.tagCount} tags, up to ${e.mesh.maxInfluences} bones, spread ${spread.toFixed(5)}`);
    }
  }
  let player = '';
  if (table) {
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const who = playerCharacter(parseRdr(readerm.data(readerm.root.children.find((k) => k.name === 'chartype.rdr')!)));
    const model = who ? table.model(who) : null;
    let flib: string[] = [];
    try { flib = Zar.parse(zdbMember(bytes, toc, 'FLIB_MDL.ZED')).root.children.map((k) => k.name); } catch { /* none */ }
    const gear = who ? table.defaultGear(who) : [];
    const absent = gear.filter((g) => !flib.includes(table!.gear.get(g)?.model ?? ''));
    if (!model || !lib.some((e) => e.name === model)) errors.push(`player ${who}: model ${model} not in CLIB_MDL`);
    player = `; player ${who} = ${model}, ${gear.length - absent.length}/${gear.length} gear${absent.length ? ` (no ${absent.join(', ')})` : ''}`;
  }
  failures += errors.length;
  totals.maps++; totals.meshes += lib.length; totals.vertices += v; totals.triangles += t; totals.batches += b;
  totals.worstSpread = Math.max(totals.worstSpread, worst); totals.maxInfluences = Math.max(totals.maxInfluences, inf);
  console.log(`${stem.padEnd(5)} ${String(lib.length).padStart(2)} meshes ${String(v).padStart(6)} v ${String(t).padStart(6)} t `
    + `${String(b).padStart(5)} batches, up to ${inf} bones, spread ${worst.toFixed(5)}, ${errors.length} diagnostics${player}`
    + (errors.length ? `\n    ${errors.join('\n    ')}` : ''));
}
console.log(`\n${totals.maps} maps, ${totals.meshes} meshes, ${totals.vertices} vertices, ${totals.triangles} triangles, `
  + `${totals.batches} batches, ${totals.tags} tags; up to ${totals.maxInfluences} bones a vertex; worst spread ${totals.worstSpread.toFixed(5)}`);
console.log(`tags by relocation: ${Object.entries(relocs).map(([k, n]) => `${k} ${n}`).join(', ')} `
  + `(texture ${RELOC_TEXTURE}, matrix ${RELOC_MATRIX}, bone ${RELOC_BONE}, draw ${RELOC_DRAW})`);
console.log(`distinct skeletons (names and parents): ${palettes.size}`);
for (const [names, n] of skeletons) console.log(`  ${n} meshes: ${names}`);
if (failures) {
  console.log(`${failures} diagnostics`);
  process.exitCode = 1;
}
