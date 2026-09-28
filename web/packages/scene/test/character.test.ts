import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRdr, parseZdb, Zar, zdbMember, type RdrNode } from '@s2u/archive';
import { interpretScaledChain, modelNodes, readMeshLibrary, skinSubMesh, walkModel } from '@s2u/mesh';
import { gearMatrix, multiply, parseCharacterTable, playerCharacter, readSkeleton, transformPoint } from '../src';
import { fixture } from '../../archive/test/fixtures';

/**
 * The character types (web/docs/research/78 §5): `READERC.ZAR`'s `character.rdr` -- the part list, the gear with
 * the part each piece hangs from and its offset, and every character's model and default gear, a character
 * inheriting what it does not state from the one after its `:` -- and the map's own `chartype.rdr`, which names
 * the SEALs a map fields.
 */

/** A `character.rdr` in miniature, as `parseRdr` returns it: a flat record of keys and value lists. */
const TABLE: RdrNode = [[
  'AngleUnits', ['DEG'],
  'body_items', ['head', 'hips', 'rcalf', 'gear_nodes', ['right_lid', 'left_lid']],
  'gear', [
    ['name', ['seal_goggles'], 'model', ['seal_goggles.flt'], 'ofs', ['head', ['0', '0', '0'], ['90', '0', '0']]],
    ['name', ['seal_scuba_knife'], 'model', ['seal_scuba_knife.flt'], 'ofs', ['rcalf', ['1.61', '0.388', '-0.93'], ['0', '90', '0']]],
  ],
  'characters', [
    'basic_seal', ['anim_set', ['Seal anim set'], 'default_gear', ['seal_goggles']],
    'mp_seal1', ':', 'basic_seal', ['strength', ['6']],
    'mp2_seal1', ':', 'mp_seal1', ['model_name', ['seal_A_scuba.xsi'], 'default_gear', ['seal_scuba_knife', 'seal_goggles']],
  ],
]];

describe('parseCharacterTable (research 78 §5)', () => {
  it('reads the gear and the characters, a character taking from its base what it does not state', () => {
    const t = parseCharacterTable(TABLE);
    expect(t.bodyItems).toEqual(['head', 'hips', 'rcalf']);
    expect(t.gear.get('seal_scuba_knife')).toEqual({ name: 'seal_scuba_knife', model: 'seal_scuba_knife', part: 'rcalf', translation: [1.61, 0.388, -0.93], rotation: [0, 90, 0] });
    expect(t.model('mp2_seal1')).toBe('seal_A_scuba');
    expect(t.defaultGear('mp2_seal1')).toEqual(['seal_scuba_knife', 'seal_goggles']);
    expect(t.defaultGear('mp_seal1')).toEqual(['seal_goggles']);            // from basic_seal
    expect(t.model('basic_seal')).toBeNull();
    expect(t.model('nobody')).toBeNull();
  });

  it('builds the offset as the engine stores a matrix: x, then y, then z, about the fixed axes, then the translation', () => {
    const t = parseCharacterTable(TABLE);
    // (90, 0, 0): a quarter turn about x takes y to z -- row 1, the image of y, is (0, 0, 1)
    const g = gearMatrix(t.gear.get('seal_goggles')!, t.angleUnits);
    expect(Array.from(g).map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
    // (0, 90, 0): a quarter turn about y takes z to x, and the translation is the fourth row
    const k = gearMatrix(t.gear.get('seal_scuba_knife')!, t.angleUnits);
    expect(Array.from(k).map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1.61, 0.388, -0.93, 1]);
  });

  it("reads the player's character off the map's chartype.rdr: the first of the navyseals", () => {
    const chartype: RdrNode = [['navyseals', [['character', ['mp2_seal1'], 'name', ['Seal1']], ['character', ['mp2_seal2'], 'name', ['Seal2']]],
      'terrorists', [['character', ['mp2_terror1'], 'name', ['Terrorist1']]]]];
    expect(playerCharacter(chartype)).toBe('mp2_seal1');
    expect(playerCharacter([['terrorists', []]])).toBeNull();
  });
});

/** `READERC.ZAR` is not in a map archive: the extractor copies it beside them (78 §5). */
const here = dirname(fileURLToPath(import.meta.url));
const readerc = ['../../../test-fixtures/RUN/READERC.ZAR', '../../../public/maps/RUN/READERC.ZAR']
  .map((p) => resolve(here, p)).find((p) => existsSync(p));
const table = readerc ? (() => {
  const z = Zar.parse(new Uint8Array(readFileSync(readerc)));
  return parseCharacterTable(parseRdr(z.data(z.root.children.find((k) => k.name === 'character.rdr')!)));
})() : null;
const mp2 = fixture('RUN/MP2.ZDB');

describe("Frostfire's SEAL as the game dresses it (research 78 §5)", () => {
  it.skipIf(!table || !mp2)('mp2_seal1 is seal_A_scuba, in its eyes, holster, belt, knife and satchel -- no goggles', () => {
    const toc = parseZdb(mp2!);
    const readerm = Zar.parse(zdbMember(mp2!, toc, 'READERM.ZAR'));
    const who = playerCharacter(parseRdr(readerm.data(readerm.root.children.find((k) => k.name === 'chartype.rdr')!)));
    expect(who).toBe('mp2_seal1');
    expect(table!.model(who!)).toBe('seal_A_scuba');
    expect(table!.defaultGear(who!)).toEqual(['seal_A_right_eye', 'seal_A_left_eye', 'seal_holster', 'seal_scuba_aslt_gear', 'seal_scuba_knife', 'Satchel']);
    expect(table!.defaultGear(who!).map((g) => [table!.gear.get(g)!.model, table!.gear.get(g)!.part])).toEqual([
      ['right_eye', 'head'], ['left_eye', 'head'], ['gear_holster', 'rthigh'], ['seal_scuba_aslt_gear', 'hips'],
      ['seal_scuba_knife', 'rcalf'], ['Satchel', 'spinehi'],
    ]);
  });

  it.skipIf(!table || !mp2)("each worn gear's turn undoes its part's bind turn: the gear is modelled in the character's own axes", () => {
    const s = readSkeleton(Zar.parse(zdbMember(mp2!, parseZdb(mp2!), 'CLIB_GEO.ZED')), 'seal_A_scuba');
    let worst = 0;
    for (const name of table!.defaultGear('mp2_seal1')) {
      const g = table!.gear.get(name)!;
      const placed = multiply(gearMatrix(g, table!.angleUnits), s.bindWorld[s.indexOf(g.part)]!);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(placed[i * 4 + j]! - (i === j ? 1 : 0)));
    }
    // a few hundredths: the gear set a degree or two off square by hand; the wrong axis order misses by 0.7 to 1
    expect(worst).toBeLessThan(0.05);
  });

  it.skipIf(!table || !mp2)('the gear sits on the bind-pose body where the offsets put it: on its surface, not sunk in it', () => {
    const toc = parseZdb(mp2!);
    const s = readSkeleton(Zar.parse(zdbMember(mp2!, toc, 'CLIB_GEO.ZED')), 'seal_A_scuba');
    const seal = readMeshLibrary(Zar.parse(zdbMember(mp2!, toc, 'CLIB_MDL.ZED'))).find((e) => e.name === 'seal_A_scuba')!.mesh!;
    const flib = Zar.parse(zdbMember(mp2!, toc, 'FLIB_MDL.ZED'));
    const verts: number[][] = [];
    for (const sub of seal.subMeshes) {
      const { positions: p } = skinSubMesh(sub, s.bindWorld);
      for (let i = 0; i < p.length; i += 3) verts.push([p[i]!, p[i + 1]!, p[i + 2]!]);
    }
    const nearest = (q: number[]) => Math.min(...verts.map((v) => Math.hypot(q[0]! - v[0]!, q[1]! - v[1]!, q[2]! - v[2]!)));
    const worn = (gear: string): number[][] => {
      const g = table!.gear.get(gear)!;
      const m = multiply(gearMatrix(g, table!.angleUnits), s.bindWorld[s.indexOf(g.part)]!);
      const key = flib.find(g.model)!;
      return walkModel(flib.data(key), modelNodes(flib, key)).flatMap(interpretScaledChain)
        .flatMap((mesh) => Array.from({ length: mesh.positions.length / 3 }, (_, i) => transformPoint(m, mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!) as number[]));
    };
    for (const gear of ['seal_holster', 'seal_scuba_aslt_gear', 'seal_scuba_knife', 'Satchel']) {
      const d = worn(gear).map(nearest).sort((a, b) => a - b);
      // Each touches the body -- nearest *vertex*, so a hand's width of mesh spacing is slack -- and most of it
      // lies within a vertex's spacing of the skin: the belt round the waist, 0.52 at the median, the holster on
      // the right thigh 0.65, the knife on the outside of the right calf 0.43. The satchel is a pack on the back,
      // 2.5 thick, so its median is its middle.
      expect(d[0]!, gear).toBeLessThan(0.3);
      expect(d[Math.floor(d.length / 2)]!, gear).toBeLessThan(gear === 'Satchel' ? 1.3 : 0.7);
    }
    const pack = worn('Satchel');
    expect(pack.reduce((z, p) => z + p[2]!, 0) / pack.length).toBeGreaterThan(1.5);   // behind: the model faces -z
    // the eyes: 0.53 up the head from its joint, 1.01 forward, 0.33 to each side
    const eyes = ['seal_A_right_eye', 'seal_A_left_eye'].map((g) => {
      const v = worn(g);
      return [0, 1, 2].map((a) => v.reduce((sum, p) => sum + p[a]!, 0) / v.length);
    });
    expect(eyes[0]![0]!).toBeGreaterThan(0.2);                    // the right eye on the model's right, +x
    expect(eyes[1]![0]!).toBeLessThan(-0.2);
    for (const e of eyes) {
      expect(e[1]!).toBeCloseTo(18.16, 1);
      expect(e[2]!).toBeLessThan(-0.7);                           // forward, -z
    }
  });
});
