import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import {
  decodeSkinnedMesh, readMeshLibrary, skinSubMesh, SkinError, topInfluences,
  type SkinnedMeshData,
} from '../src';
import { fixture } from '../../archive/test/fixtures';

/**
 * The character-model chain form, `CMesh`/`CSubMesh` (web/redotcom/docs/research/78 §2): a count quadword whose low
 * half is the tag count, then per VU1 batch a reloc-9 matrix tag and a reloc-10 bone list for every bone
 * the batch is skinned to, and one reloc-11 draw packet; reloc-6 tags cite the texture in force.
 *
 * The buffer below is built lane for lane the way the disc lays it out, so a decode that passes here and
 * on Frostfire reads the same thing both times.
 */
interface SynthVertex { v: number; p: [number, number, number]; n: [number, number, number]; w: number }
interface SynthPass { matrix: number; flags: number; verts: SynthVertex[]; triangles?: number; count?: number; tagCount?: number }
interface SynthBatch {
  texture?: string;
  passes: SynthPass[];
  /** Omit the matrix tag before this pass index (a broken chain). */
  dropMatrixBefore?: number;
  tris: [number, number, number][];
  uvs: [number, number][];
  prim0?: number;
  /** TOP+2's vertex count, when it is to disagree with the uvs written. */
  statedVertices?: number;
}

const STCYCL = (cl: number, wl: number) => 0x01000000 | (wl << 8) | cl;
const MSCNT = 0x17000000;
const ONE15 = 32768;
/** A 1.15 lane as the exporter writes one: 1.0 has no code, so it is stored as the largest, 32767. */
const q15 = (x: number) => Math.max(-ONE15, Math.min(ONE15 - 1, Math.round(x * ONE15)));

function meshBuffer(batches: SynthBatch[], head = 0x70000000): { buffer: Uint8Array; start: number } {
  const blob: number[] = [];                       // bytes
  const align16 = () => { while (blob.length % 16) blob.push(0); };
  const u32 = (x: number) => { blob.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff); };
  const i16 = (x: number) => { const v = x & 0xffff; blob.push(v & 0xff, v >>> 8); };
  const tags: [number, number, number, number][] = [];
  for (const batch of batches) {
    if (batch.texture) {
      align16();
      const at = blob.length;
      for (const c of batch.texture) blob.push(c.charCodeAt(0));
      blob.push(0);
      tags.push([0x10060000, at, 0, 0]);
    }
    const V = batch.statedVertices ?? batch.uvs.length, T = batch.tris.length;
    batch.passes.forEach((pass, i) => {
      if (batch.dropMatrixBefore !== i) tags.push([0x30090004, pass.matrix, STCYCL(1, 1), 0x6c048000]);
      align16();
      const at = blob.length;
      const n = pass.verts.length;
      u32(STCYCL(1, 1));
      u32((0x6d << 24) | (((1 + 2 * n) & 0xff) << 16) | 0x8004);           // UNPACK V4-16 FLG addr 4
      i16(pass.flags); i16(pass.triangles ?? T); i16(pass.matrix); i16(pass.count ?? n);
      for (const x of pass.verts) {
        i16(q15(x.p[0] / 10)); i16(q15(x.p[1] / 10)); i16(q15(x.p[2] / 10)); i16(2 * x.v);
        i16(q15(x.n[0])); i16(q15(x.n[1])); i16(q15(x.n[2])); i16(q15(x.w));
      }
      u32(MSCNT);
      align16();
      tags.push([0x300a0000 | ((blob.length - at) / 16), at, pass.matrix, pass.tagCount ?? n]);
    });
    align16();
    const at = blob.length;
    const base = 4 + 3 * V;
    u32(STCYCL(2, 1));
    u32((0x6e << 24) | (T << 16) | 0xc000 | base);                          // UNPACK V4-8 USN FLG: indices
    for (const [a, b, c] of batch.tris) blob.push(a * 3, b * 3, c * 3, 3);
    u32(STCYCL(1, 1));
    u32((0x6c << 24) | (4 << 16) | 0x8000);                                 // UNPACK V4-32 FLG addr 0: header
    const gif = (prim: number) => (1 << 14) | (prim << 15) | (3 << 28);
    u32(0x8000); u32(gif(batch.prim0 ?? 125)); u32(0x412); u32(0);
    u32(0x8000 | V); u32(gif(123)); u32(0x412); u32(0);
    u32(base); u32(0); u32(V); u32(T);
    u32(0); u32(0); u32(0); u32(0);
    u32(STCYCL(3, 1));
    u32((0x65 << 24) | (batch.uvs.length << 16) | 0x8005);                  // UNPACK V2-16 FLG addr 5: uvs
    for (const [u, v] of batch.uvs) { i16(Math.round(u * 4096)); i16(Math.round(v * 4096)); }
    u32(MSCNT);
    align16();
    tags.push([0x300b0000 | ((blob.length - at) / 16), at, 2 * batch.passes.length, 0]);
  }
  align16();
  const start = blob.length;
  u32(head | tags.length); u32(0); u32(0); u32(0);
  for (const t of tags) for (const w of t) u32(w);
  return { buffer: Uint8Array.from(blob), start };
}

/** A triangle skinned to two bones: every vertex in the first pass, two of them again in the second. */
const TWO_BONE: SynthBatch = {
  texture: 'seal_scuba_glove.tif',
  passes: [
    { matrix: 16, flags: 2, verts: [
      { v: 0, p: [3, -0.5, 0.25], n: [0, 1, 0], w: 1 },
      { v: 1, p: [3.5, 0, 0], n: [0, 0, 1], w: 0.5 },
      { v: 2, p: [4, 0.5, 0], n: [1, 0, 0], w: 0.25 },
    ] },
    { matrix: 17, flags: 5, verts: [
      { v: 1, p: [0.5, 0, 0], n: [0, 0, 1], w: 0.5 },
      { v: 2, p: [1, 0.5, 0], n: [1, 0, 0], w: 0.75 },
    ] },
  ],
  tris: [[0, 1, 2]],
  uvs: [[0.25, 0.5], [0.75, 0.5], [0.5, 1]],
};
/** One bone, flags 6 (first and last), the shape 22 of seal_A_scuba's 56 batches take. */
const ONE_BONE = (texture: string, matrix: number): SynthBatch => ({
  texture,
  passes: [{ matrix, flags: 6, verts: [
    { v: 0, p: [0, 0, 0], n: [0, 1, 0], w: 1 }, { v: 1, p: [1, 0, 0], n: [0, 1, 0], w: 1 },
    { v: 2, p: [0, 0, 1], n: [0, 1, 0], w: 1 }, { v: 3, p: [1, 0, 1], n: [0, 1, 0], w: 1 },
  ] }],
  tris: [[0, 1, 2], [2, 1, 3]],
  uvs: [[0, 0], [1, 0], [0, 1], [1, 1]],
});

const IDENTITY = () => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const translate = (x: number, y: number, z: number) => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
/** A palette of `n` identities, with some slots replaced. */
const palette = (n: number, over: Record<number, Float32Array> = {}) => Array.from({ length: n }, (_, i) => over[i] ?? IDENTITY());

describe('decodeSkinnedMesh (research 78 §2)', () => {
  it('reads a two-bone batch: the bone lists become per-vertex influences, the draw packet the uvs and indices', () => {
    const { buffer, start } = meshBuffer([TWO_BONE]);
    const mesh = decodeSkinnedMesh(buffer, start, 'synthetic');
    expect(mesh.vertexCount).toBe(3);
    expect(mesh.triangleCount).toBe(1);
    expect(mesh.batches).toHaveLength(1);
    expect(mesh.batches[0]!.passes.map((p) => [p.matrix, p.flags, p.count])).toEqual([[16, 2, 3], [17, 5, 2]]);
    expect(mesh.bones).toEqual([16, 17]);
    expect(mesh.maxInfluences).toBe(2);
    const sub = mesh.subMeshes[0]!;
    expect(sub.textureName).toBe('seal_scuba_glove.tif');
    expect(sub.fog).toBe(true);                                   // PRIM 125: IIP|TME|FGE|ABE
    expect(Array.from(sub.indices)).toEqual([0, 1, 2]);
    expect(Array.from(sub.uvs)).toEqual([0.25, 0.5, 0.75, 0.5, 0.5, 1]);
    expect(Array.from(sub.influenceStart)).toEqual([0, 1, 3, 5]);
    expect(Array.from(sub.influenceBone)).toEqual([16, 16, 17, 16, 17]);
    // ITOF15 weights: 1.0 is stored as 32767, the largest a signed 16-bit lane holds.
    expect(sub.influenceWeight[0]).toBeCloseTo(32767 / 32768, 6);
    expect(Array.from(sub.influenceWeight.subarray(1)).map((w) => Math.round(w * 4) / 4)).toEqual([0.5, 0.5, 0.25, 0.75]);
    // positions ITOF15 x 10 (research 15 §4.2, `LOI 10.0`), bone-local
    expect(sub.influencePosition[0]).toBeCloseTo(3, 3);
    expect(sub.influencePosition[1]).toBeCloseTo(-0.5, 3);
    expect(sub.influencePosition[3 * 2]).toBeCloseTo(0.5, 3);        // vertex 1's second influence, bone 17
    expect(sub.influenceNormal[1]).toBeCloseTo(1, 4);
  });

  it('skins as the VU does: each bone weighs its own local position through its own matrix, the translation weighted too', () => {
    const { buffer, start } = meshBuffer([TWO_BONE]);
    const sub = decodeSkinnedMesh(buffer, start, 'synthetic').subMeshes[0]!;
    // bone 16 at the origin, bone 17 translated (3, 0, 0): vertex 1 is 0.5 (3.5,0,0) + 0.5 ((0.5,0,0)+(3,0,0)) = (3.5, 0, 0)
    const { positions, normals } = skinSubMesh(sub, palette(26, { 17: translate(3, 0, 0) }));
    expect(positions[3]).toBeCloseTo(3.5, 3);
    expect(positions[4]).toBeCloseTo(0, 3);
    // vertex 2: 0.25 (4, 0.5, 0) + 0.75 (4, 0.5, 0) = (4, 0.5, 0)
    expect(positions[6]).toBeCloseTo(4, 3);
    expect(positions[7]).toBeCloseTo(0.5, 3);
    // a normal is turned by the 3x3 alone: the translation does not reach it
    expect(normals[3 + 2]).toBeCloseTo(1, 3);
  });

  it('makes one sub-mesh per texture, re-basing each batch\'s indices onto the vertices before it', () => {
    const { buffer, start } = meshBuffer([ONE_BONE('a.tif', 1), ONE_BONE('b.tif', 2), ONE_BONE('a.tif', 3)]);
    const mesh = decodeSkinnedMesh(buffer, start, 'synthetic');
    expect(mesh.batches).toHaveLength(3);
    expect(mesh.subMeshes.map((s) => [s.textureName, s.vertexCount, s.indices.length / 3])).toEqual([['a.tif', 8, 4], ['b.tif', 4, 2]]);
    expect(Array.from(mesh.subMeshes[0]!.indices.subarray(6))).toEqual([4, 5, 6, 6, 5, 7]);
    expect(Array.from(mesh.subMeshes[0]!.influenceBone)).toEqual([1, 1, 1, 1, 3, 3, 3, 3]);
  });

  it('reduces to the four largest influences for a renderer, renormalised, and says how much weight it dropped', () => {
    const verts = (w: number[]) => w.map((x, i) => ({ matrix: i, flags: i === 0 ? 2 : i === w.length - 1 ? 5 : 1, verts: [
      { v: 0, p: [0, 0, 0] as [number, number, number], n: [0, 1, 0] as [number, number, number], w: x },
      ...(i === 0 ? [1, 2].map((v) => ({ v, p: [0, 0, 0] as [number, number, number], n: [0, 1, 0] as [number, number, number], w: 1 })) : []),
    ] }));
    const five: SynthBatch = { passes: verts([0.4, 0.05, 0.3, 0.15, 0.1]), tris: [[0, 1, 2]], uvs: [[0, 0], [1, 0], [0, 1]] };
    const { buffer, start } = meshBuffer([five]);
    const sub = decodeSkinnedMesh(buffer, start, 'synthetic').subMeshes[0]!;
    const top = topInfluences(sub, 4);
    expect(Array.from(top.index.subarray(0, 4))).toEqual([0, 2, 3, 4]);
    const kept = 0.4 + 0.3 + 0.15 + 0.1;
    expect(top.weight[0]).toBeCloseTo(0.4 / kept, 3);
    expect(top.droppedMax).toBeCloseTo(0.05, 3);
    expect(top.weight[4]! + top.weight[5]! + top.weight[6]! + top.weight[7]!).toBeCloseTo(1, 6);
  });

  it('refuses a chain whose head is not the count quadword the engine reads (research 78 §2)', () => {
    const { buffer, start } = meshBuffer([TWO_BONE], 0x10000000);
    expect(() => decodeSkinnedMesh(buffer, start, 'synthetic')).toThrow(SkinError);
  });

  it('refuses a bone list with no matrix tag in front of it', () => {
    const { buffer, start } = meshBuffer([{ ...TWO_BONE, dropMatrixBefore: 1 }]);
    expect(() => decodeSkinnedMesh(buffer, start, 'synthetic')).toThrow(/matrix/);
  });

  it('refuses a bone list whose header disagrees with its tag', () => {
    const passes = [TWO_BONE.passes[0]!, { ...TWO_BONE.passes[1]!, tagCount: 3 }];
    const { buffer, start } = meshBuffer([{ ...TWO_BONE, passes }]);
    expect(() => decodeSkinnedMesh(buffer, start, 'synthetic')).toThrow(/tag/);
  });

  it('refuses a batch whose first pass does not write every vertex: the accumulate passes would add to stale staging', () => {
    const passes = [{ ...TWO_BONE.passes[0]!, verts: TWO_BONE.passes[0]!.verts.slice(0, 2) }, TWO_BONE.passes[1]!];
    const { buffer, start } = meshBuffer([{ ...TWO_BONE, passes }]);
    expect(() => decodeSkinnedMesh(buffer, start, 'synthetic')).toThrow(/first pass/);
  });

  it('refuses an index past the vertex count', () => {
    const { buffer, start } = meshBuffer([{ ...TWO_BONE, tris: [[0, 1, 3]] }]);
    expect(() => decodeSkinnedMesh(buffer, start, 'synthetic')).toThrow(/vertex 3 of 3/);
  });
});

/** The 17 character meshes of Frostfire's `CLIB_MDL.ZED` (research 78 §1, §4). */
const FROSTFIRE = [
  'seal_A_scuba', 'seal_A_scuba_1', 'seal_A_scuba_2', 'seal_E_scuba', 'seal_D_scuba', 'seal_C_scuba',
  'al_gman01', 'al_gman01_1', 'al_gman01_2', 'al_gman02', 'al_gman02_1', 'al_gman02_2',
  'al_leader', 'al_leader_1', 'al_leader_2', 'al_captain', 'al_captain_1',
];

describe('the character libraries on disc (research 78 §4)', () => {
  const library = (archive: string): ReturnType<typeof readMeshLibrary> | null => {
    const zdb = fixture(`RUN/${archive}.ZDB`);
    return zdb ? readMeshLibrary(Zar.parse(zdbMember(zdb, parseZdb(zdb), 'CLIB_MDL.ZED'))) : null;
  };
  const mp2 = library('MP2');

  it.skipIf(!mp2)('Frostfire: all 17 meshes, in key order, each with a 26-slot palette and ref_count = its tag count', () => {
    expect(mp2!.map((e) => e.name)).toEqual(FROSTFIRE);
    for (const e of mp2!) {
      expect(e.error, e.name).toBeNull();
      expect(e.mtxCount).toBe(26);
      expect(e.refCount, e.name).toBe(e.tagCount);
    }
  });

  it.skipIf(!mp2)('decodes only the meshes asked for, when asked: a body needs one of seventeen', () => {
    const zdb = fixture('RUN/MP2.ZDB')!;
    const one = readMeshLibrary(Zar.parse(zdbMember(zdb, parseZdb(zdb), 'CLIB_MDL.ZED')), ['seal_A_scuba']);
    expect(one.map((e) => [e.name, e.mesh?.vertexCount])).toEqual([['seal_A_scuba', 2094]]);
  });

  it.skipIf(!mp2)('seal_A_scuba: 2,094 vertices, 1,523 triangles, 56 batches in 7 textures, up to 5 bones a vertex', () => {
    const seal = mp2!.find((e) => e.name === 'seal_A_scuba')!.mesh as SkinnedMeshData;
    expect(seal.vertexCount).toBe(2094);
    expect(seal.triangleCount).toBe(1523);
    expect(seal.batches).toHaveLength(56);
    expect(seal.subMeshes).toHaveLength(7);
    expect(seal.maxInfluences).toBe(5);
    expect(seal.bones.length).toBeLessThanOrEqual(26);
    expect(Math.max(...seal.bones)).toBeLessThan(26);
    // every vertex's weights sum to one, to the 1.15 lanes' last bit per influence
    for (const sub of seal.subMeshes) {
      for (let v = 0; v < sub.vertexCount; v++) {
        let sum = 0;
        for (let k = sub.influenceStart[v]!; k < sub.influenceStart[v + 1]!; k++) sum += sub.influenceWeight[k]!;
        expect(Math.abs(sum - 1)).toBeLessThan(6 / 32768);
      }
    }
  });

  for (const archive of ['MP2', 'MP6', 'MP72']) {
    const lib = archive === 'MP2' ? mp2 : library(archive);
    it.skipIf(!lib)(`${archive}: every MESH_* decodes with no diagnostic`, () => {
      expect(lib!.length).toBeGreaterThan(0);
      const failures = lib!.filter((e) => e.error !== null).map((e) => `${e.name}: ${e.error}`);
      expect(failures).toEqual([]);
      for (const e of lib!) expect(e.mesh!.vertexCount, e.name).toBeGreaterThan(0);
    });
  }
});
