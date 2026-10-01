import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { influenceSpread, readMeshLibrary, skinSubMesh } from '@s2u/mesh';
import { characterModelNames, readSkeleton, SkeletonError } from '../src';
import { fixture } from '../../archive/test/fixtures';
import { nparams, u32, writeZar, type ZarTree } from './skeletonZar';

/**
 * The skeleton of a character model: `CLIB_GEO.ZED`'s `models/<name>` node tree, where every node under the
 * model carries one visual of `vtype` 2 (a `CSubMesh`, reCOM `zVisual/vis_main.cpp:246-265`) whose
 * `matrix_id` names its slot in the mesh's matrix palette (web/redotcom/docs/research/78 §3).
 */
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const T = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** A quarter turn about z, row-vector convention: x goes to y. */
const RZ90 = (x: number, y: number, z: number) => [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, x, y, z, 1];

function node(name: string, matrix: number[], matrixId: number | null, children: ZarTree[] = []): ZarTree {
  const vis: ZarTree[] = [{ name: 'vtype', data: u32(matrixId === null ? 1 : 2) }];
  if (matrixId !== null) vis.push({ name: 'matrix_id', data: u32(matrixId) });
  vis.push({ name: 'vparams', data: new Uint8Array(24) });
  const out: ZarTree[] = [{ name: 'nparams', data: nparams(matrix) }, { name: 'visuals', children: [{ name: 'vis', children: vis }] }];
  if (children.length) out.push({ name: 'children', children });
  return { name, children: out };
}

function toyGeo(ids: [number, number, number, number] = [0, 1, 2, 3]): Zar {
  const model = node('toy', I, null, [
    node('skel_root', T(0, 10, 0), ids[0], [
      node('hips', RZ90(1, 0, 0), ids[1], [node('head', T(2, 0, 0), ids[2])]),
    ]),
    node('body', I, ids[3]),
  ]);
  return Zar.parse(writeZar([{ name: 'models', children: [model, { name: 'other', children: [{ name: 'nparams', data: nparams(I) }] }] }]));
}

const at = (m: Float32Array): number[] => [m[12]!, m[13]!, m[14]!].map((x) => Math.round(x * 1e4) / 1e4 + 0);

describe('readSkeleton (research 78 §3)', () => {
  it('reads the parts in palette order, with their parents, and composes the bind pose local x parent', () => {
    const s = readSkeleton(toyGeo(), 'toy');
    expect(s.parts.map((p) => p.name)).toEqual(['skel_root', 'hips', 'head', 'body']);
    expect(s.parts.map((p) => p.parent)).toEqual([-1, 0, 1, -1]);
    expect(s.size).toBe(4);
    expect(s.indexOf('head')).toBe(2);
    expect(s.indexOf('nope')).toBe(-1);
    expect(at(s.bindWorld[1]!)).toEqual([1, 10, 0]);
    // head: (2,0,0) turned a quarter about z by hips is (0,2,0), then hips' own (1,10,0)
    expect(at(s.bindWorld[2]!)).toEqual([1, 12, 0]);
    expect(at(s.bindWorld[3]!)).toEqual([0, 0, 0]);
  });

  it('lets a pose drive it by name or by index, the bind pose kept beside the current one', () => {
    const s = readSkeleton(toyGeo(), 'toy');
    s.setLocal('hips', Float32Array.from(T(1, 0, 0)));          // straighten the hips
    s.update();
    expect(at(s.world[2]!)).toEqual([3, 10, 0]);
    expect(at(s.bindWorld[2]!)).toEqual([1, 12, 0]);
    expect(at(s.palette()[2]!)).toEqual([3, 10, 0]);
    s.setLocal(0, Float32Array.from(T(0, 20, 0)));
    s.update();
    expect(at(s.world[2]!)).toEqual([3, 20, 0]);
    s.resetToBind();
    expect(at(s.world[2]!)).toEqual([1, 12, 0]);
    expect(() => s.setLocal('nope', Float32Array.from(I))).toThrow(SkeletonError);
  });

  it('refuses a palette that is not the pre-order 0..n-1 the mesh indexes', () => {
    expect(() => readSkeleton(toyGeo([0, 2, 1, 3]), 'toy')).toThrow(/matrix_id/);
    expect(() => readSkeleton(toyGeo(), 'missing')).toThrow(SkeletonError);
  });

  it('lists the models that are characters: a model visual of vtype 1', () => {
    expect(characterModelNames(toyGeo())).toEqual(['toy']);
  });
});

/** Frostfire's SEAL, as `CLIB_GEO.ZED` names its 26 palette slots (research 78 §3). */
const SEAL_PARTS = [
  'skel_root', 'hips', 'rthigh', 'rcalf', 'rfoot', 'rtoe', 'lthigh', 'lcalf', 'lfoot', 'ltoe',
  'aimnodes', 'spinelo', 'spinehi', 'rshoulder_wgt', 'rscap', 'rbicep', 'rforearm', 'rhand',
  'neck', 'head', 'lshoulder_wgt', 'lscap', 'lbicep', 'lforearm', 'lhand', 'body',
];

describe("the characters' skeletons on disc (research 78 §3, §4)", () => {
  const load = (archive: string) => {
    const zdb = fixture(`RUN/${archive}.ZDB`);
    if (!zdb) return null;
    const toc = parseZdb(zdb);
    return { geo: Zar.parse(zdbMember(zdb, toc, 'CLIB_GEO.ZED')), mdl: Zar.parse(zdbMember(zdb, toc, 'CLIB_MDL.ZED')) };
  };
  const mp2 = load('MP2');

  it.skipIf(!mp2)("seal_A_scuba: 26 parts, the skeleton's 25 under skel_root and `body` beside it", () => {
    const s = readSkeleton(mp2!.geo, 'seal_A_scuba');
    expect(s.parts.map((p) => p.name)).toEqual(SEAL_PARTS);
    const parent = (n: string) => { const p = s.parts[s.indexOf(n)]!.parent; return p < 0 ? null : s.parts[p]!.name; };
    expect(parent('skel_root')).toBeNull();
    expect(parent('body')).toBeNull();
    expect(parent('rthigh')).toBe('hips');
    expect(parent('rtoe')).toBe('rfoot');
    expect(parent('spinelo')).toBe('aimnodes');
    expect(parent('head')).toBe('neck');
    expect(parent('lhand')).toBe('lforearm');
    expect(s.parts.filter((p) => p.name !== 'body' && p.name !== 'skel_root').every((p) => p.parent >= 0)).toBe(true);
    expect(at(s.bindWorld[s.indexOf('skel_root')]!)).toEqual([0, 11.67, 0.5334]);
    expect(at(s.bindWorld[s.indexOf('head')]!)[1]).toBeCloseTo(17.625, 2);
  });

  it.skipIf(!mp2)('seal_A_scuba stands in its bind pose from y 0 to 19.431, 16 wide, facing -z', () => {
    const s = readSkeleton(mp2!.geo, 'seal_A_scuba');
    const seal = readMeshLibrary(mp2!.mdl).find((e) => e.name === 'seal_A_scuba')!.mesh!;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const sub of seal.subMeshes) {
      const { positions } = skinSubMesh(sub, s.bindWorld);
      for (let i = 0; i < positions.length; i++) {
        min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
        max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
      }
    }
    const r3 = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000 + 0);
    expect(r3(min)).toEqual([-8.005, 0, -1.702]);
    expect(r3(max)).toEqual([7.974, 19.431, 2.174]);
    // the toes are ahead of the ankles along -z: the model faces -z, facing step 0 (research 75 §11)
    expect(s.bindWorld[s.indexOf('rtoe')]![14]!).toBeLessThan(s.bindWorld[s.indexOf('rfoot')]![14]! - 1);
  });

  for (const archive of ['MP2', 'MP6', 'MP72']) {
    const lib = archive === 'MP2' ? mp2 : load(archive);
    it.skipIf(!lib)(`${archive}: the palette is the bind pose -- every bone's own copy of a vertex lands on the same point`, () => {
      const names = characterModelNames(lib!.geo);
      const meshes = readMeshLibrary(lib!.mdl);
      expect(meshes.map((m) => m.name).sort()).toEqual([...names].sort());
      for (const entry of meshes) {
        const s = readSkeleton(lib!.geo, entry.name);
        expect(s.size, entry.name).toBe(entry.mtxCount);
        let worst = 0;
        for (const sub of entry.mesh!.subMeshes) worst = Math.max(worst, influenceSpread(sub, s.bindWorld));
        // three 1.15 lanes times 10 carry 3e-4 of rounding each: a wrong palette misses by whole units
        expect(worst, entry.name).toBeLessThan(0.002);
      }
    });
  }
});
