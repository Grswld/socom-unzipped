import { describe, it, expect } from 'vitest';
import { parseRdr } from '../src/rdr';
import { readTexManifest } from '../src/texManifest';
import { parseZdb, zdbMember } from '../src/zdb';
import { Zar, type ZarKey } from '../src/zar';
import { Reader } from '../src/bytes';
import { fixture, FIXTURES_ABSENT } from './fixtures';

/**
 * `mp<N>_lib.rdr`, the texture manifest inside `READERM.ZAR` (web/redotcom/docs/research/72 §6): one record per
 * library -- `libname`, `locked`, `gearlib`, `renderphase`, `textures`, `palettes` -- whose `textures` list
 * holds one entry per texture: `name`, `dim2 (w h bpp)`, `typeU`/`typeV`, the bare flags `pal`,
 * `16bitpal`, `32bitpal`, and on the few ground and wall textures that have one a `detail` record
 * `(name uv range bmode)`. Frostfire's first entry, as the compiled file decodes:
 *
 *   ("name" ("a_floor.tif") "dim2" ("64" "64" "8") "typeU" ("1") "typeV" ("1") "pal"
 *    "detail" ("name" ("a_floordetail.tif") "uv" ("8") "range" ("90000") "bmode" ("ADDITIVE")))
 *
 * `pal` is a key with no value list after it, so a reader that takes "the next node" as every key's
 * value reads `pal` as `"detail"` and loses the detail record. That is the trap the synthetic twin sets.
 */

/** A tree to compile: a string, an integer (i32 node), a `{ f }` float (f32 node), or a list. */
type Tree = string | number | { f: number } | Tree[];

const T_INT = 1, T_FLOAT = 2, T_STRING = 3, T_LIST = 4;

/**
 * Compiles a tree into the on-disc form `parseRdr` reads (36 §6): `{u32 version=1; u32
 * string_table_size; u32 node_array_offset}`, the string table, then 8-byte nodes `{u32 (type:8, ...,
 * length:16); u32 value}` -- a list's children contiguous, its `value` the byte offset of the first.
 */
function compileRdr(root: Tree[]): Uint8Array {
  const strings: number[] = [];
  const stringAt = new Map<string, number>();
  const intern = (s: string): number => {
    const known = stringAt.get(s);
    if (known !== undefined) return known;
    const at = strings.length;
    for (const c of s) strings.push(c.charCodeAt(0));
    strings.push(0);
    stringAt.set(s, at);
    return at;
  };
  const nodes: { type: number; length: number; value: number; float?: number }[] = [];
  const queue: { index: number; tree: Tree }[] = [];
  const place = (tree: Tree): number => { nodes.push({ type: 0, length: 0, value: 0 }); const index = nodes.length - 1; queue.push({ index, tree }); return index; };
  place(root);
  while (queue.length) {
    const { index, tree } = queue.shift()!;
    const node = nodes[index]!;
    if (typeof tree === 'string') Object.assign(node, { type: T_STRING, value: intern(tree) });
    else if (typeof tree === 'number') Object.assign(node, { type: T_INT, value: tree >>> 0 });
    else if (!Array.isArray(tree)) Object.assign(node, { type: T_FLOAT, float: tree.f });
    else {
      const first = nodes.length;
      for (const child of tree) place(child);
      Object.assign(node, { type: T_LIST, length: tree.length, value: first * 8 });
    }
  }
  const nodesAt = Math.ceil((12 + strings.length) / 16) * 16;
  const out = new Uint8Array(nodesAt + 8 * nodes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, strings.length, true); dv.setUint32(8, nodesAt, true);
  out.set(strings, 12);
  nodes.forEach((n, i) => {
    dv.setUint32(nodesAt + 8 * i, (n.type & 0xff) | (n.length << 16), true);
    if (n.float !== undefined) dv.setFloat32(nodesAt + 8 * i + 4, n.float, true);
    else dv.setUint32(nodesAt + 8 * i + 4, n.value, true);
  });
  return out;
}

/** One library record, wrapped in the root list every compiled file has. */
const library = (entries: Tree[]): Tree[] => [[
  'libname', ['mp9'], 'locked', [0], 'gearlib', [0], 'renderphase', [0], 'textures', entries, 'palettes', [],
]];

const detailed: Tree = [
  'name', ['Ground.tif'], 'dim2', [128, 128, 8], 'typeU', [1], 'typeV', [0], 'pal', 'detail',
  ['name', ['ground_grassy_det.tif'], 'uv', [{ f: 4 }], 'range', [202500], 'bmode', ['COLORBLEND']],
];

describe('readTexManifest (synthetic)', () => {
  it('reads one entry: name, dim2, typeU/typeV, the bare pal flag, and its detail record', () => {
    const manifest = readTexManifest(parseRdr(compileRdr(library([detailed]))));
    expect([...manifest.keys()]).toEqual(['ground.tif']);          // keyed as the chains cite, lower-cased
    expect(manifest.get('ground.tif')).toEqual({
      name: 'Ground.tif',
      dim2: { width: 128, height: 128, bpp: 8 },
      typeU: 1, typeV: 0,
      pal: true,
      detail: { name: 'ground_grassy_det.tif', uv: 4, range: 202500, bmode: 'COLORBLEND' },
    });
  });

  it('an entry without a detail record has none, and a bare flag never swallows the key after it', () => {
    const plain: Tree = ['name', ['sky.tif'], 'dim2', [256, 256, 8], 'typeU', [1], 'typeV', [1], 'pal', '16bitpal', 'blendmode', ['ALPHACLIP']];
    const manifest = readTexManifest(parseRdr(compileRdr(library([plain, detailed]))));
    expect(manifest.get('sky.tif')).toMatchObject({ name: 'sky.tif', pal: true, detail: undefined });
    expect(manifest.get('ground.tif')?.detail?.name).toBe('ground_grassy_det.tif');
  });

  it('keeps the first entry of a name listed twice, as the engine does', () => {
    // Blizzard's mp1_lib.rdr lists alaska4d_snow02.tif twice with two different detail records; every one
    // of the 56 visuals drawn with it carries the first one's uv and range (`detail_buff`, see below).
    const second: Tree = ['name', ['ground.tif'], 'detail', ['name', ['other.tif'], 'uv', [{ f: 8 }], 'range', [250000], 'bmode', ['ADDITIVE']]];
    const manifest = readTexManifest(parseRdr(compileRdr(library([detailed, second]))));
    expect(manifest.size).toBe(1);
    expect(manifest.get('ground.tif')?.detail).toMatchObject({ uv: 4, bmode: 'COLORBLEND' });
  });

  it('a script with no textures list is an empty manifest, and an unnamed entry is skipped', () => {
    expect(readTexManifest(parseRdr(compileRdr([['libname', ['mp9']]]))).size).toBe(0);
    expect(readTexManifest(parseRdr(compileRdr(library([['dim2', [8, 8, 8]]])))).size).toBe(0);
  });
});

const mp2 = fixture('RUN/MP2.ZDB');
/** Every key of an archive whose name matches, depth first, beside its parent. */
function keysNamed(zar: Zar, name: string): { key: ZarKey; parent: ZarKey }[] {
  const out: { key: ZarKey; parent: ZarKey }[] = [];
  const walk = (k: ZarKey): void => {
    for (const c of k.children) { if (c.name === name) out.push({ key: c, parent: k }); walk(c); }
  };
  walk(zar.root);
  return out;
}

describe(`Frostfire's texture manifest${mp2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it.skipIf(!mp2)('mp2_lib.rdr names every texture of MP2_TXR.ZED, and two of them carry a detail record', () => {
    const toc = parseZdb(mp2!);
    const readerm = Zar.parse(zdbMember(mp2!, toc, 'READERM.ZAR'));
    const manifest = readTexManifest(parseRdr(readerm.data(readerm.find('mp2_lib.rdr')!)));
    expect(manifest.size).toBe(65);
    // Research 72 §7: the 37 names the world's chains cite all resolve inside MP2_TXR.ZED, so a manifest
    // naming every texture of that library names every one the chains cite (the viewer's own test checks
    // the 37 against the decoded chains, `viewer/test/detailPass.test.ts`).
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const names = txr.find('textures')!.children.map((k) => k.name.toLowerCase());
    for (const name of names) expect(manifest.has(name), name).toBe(true);
    expect(manifest.get('floor_oilgrime.tif')).toMatchObject({
      dim2: { width: 256, height: 256, bpp: 8 }, typeU: 1, typeV: 1, pal: true,
      detail: { name: 'flooroil_detail.tif', uv: 8, range: 250000, bmode: 'ADDITIVE' },
    });
    expect(manifest.get('a_floor.tif')?.detail).toEqual({ name: 'a_floordetail.tif', uv: 8, range: 90000, bmode: 'ADDITIVE' });
    expect([...manifest.values()].filter((e) => e.detail).length).toBe(2);
  });

  it.skipIf(!mp2)('SEMANTICS 11.6: the S,T scale on Frostfire is the manifest\'s uv, 8 -- not the 4.0 of the mission dumps', () => {
    // The 0x30/0x32 commands are in the EE's command list, not the map file (SEMANTICS §9), so no packet
    // tool can show where they apply. Every visual that draws the pass carries a `detail_buff` instead
    // (`CVisual::Read`, `research/recom/src/gamez/zVisual/vis_main.cpp:276-296`): 28 bytes per record,
    // `m_range_sqd_to_camera` first (`zvis.h:96-99`), the pass's ALPHA_1 selector in the byte at +20, the
    // scale at +24. Every one of Frostfire's 61 is floor_oilgrime.tif's: range 250000, ALPHA 0x48
    // (`(Cs - 0) * As + Cd`, ADDITIVE), scale 8 -- the manifest's uv. The 4.0 was the mission dumps' value.
    const toc = parseZdb(mp2!);
    const readerm = Zar.parse(zdbMember(mp2!, toc, 'READERM.ZAR'));
    const oil = readTexManifest(parseRdr(readerm.data(readerm.find('mp2_lib.rdr')!))).get('floor_oilgrime.tif')!.detail!;
    const geo = Zar.parse(zdbMember(mp2!, toc, 'MP2_GEO.ZED'));
    const records = keysNamed(geo, 'detail_buff');
    expect(records.length).toBe(61);
    for (const { key, parent } of records) {
      expect(new Reader(geo.data(geo.child(parent, 'detail_cnt')!)).u32(0)).toBe(1);
      const r = new Reader(geo.data(key));
      expect(r.length).toBe(28);
      expect(r.f32(0)).toBe(oil.range);
      expect(r.u8(20)).toBe(0x48);
      expect(r.f32(24)).toBe(oil.uv);
      expect(r.f32(24)).not.toBe(4);
    }
  });
});
