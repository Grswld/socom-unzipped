import { describe, it, expect } from 'vitest';
import { parseRdr, rdrGet, type RdrNode } from '../src/rdr';
import { parseZdb, zdbMember } from '../src/zdb';
import { Zar } from '../src/zar';
import { fixture } from './fixtures';

/** 36 §6: {u32 version=1; u32 string_table_size; u32 node_array_offset}, string table, 8-byte nodes
 *  {u32 (type:8, isclone:1, packed:1, unused:6, length:16); u32 value}. Strings: value = byte offset from 12.
 *  Lists: value = byte offset from node_array_offset to the first of `length` children.
 *  Node types are the ones the scratch rdr.py decoded five maps with: 1 = i32, 2 = f32, 3 = string, 4 = list. */
const T_INT = 1, T_FLOAT = 2, T_STRING = 3, T_LIST = 4;

/** Builds `( ("description" ("FROSTFIRE") "count" (7) "scale" (0.5)) )`: the real shape of a compiled
 *  script -- a root list wrapping one record of alternating key string and value list. */
function syntheticRdr(): Uint8Array {
  const strings = ['description', 'FROSTFIRE', 'count', 'scale']; // offsets 0, 12, 22, 28
  const table = new Uint8Array(strings.reduce((n, s) => n + s.length + 1, 0));
  let p = 0;
  for (const s of strings) { for (const c of s) table[p++] = c.charCodeAt(0); table[p++] = 0; }
  const nodesAt = Math.ceil((12 + table.length) / 16) * 16;      // real files pad the table out to `padding`
  const nodes: [number, number, number][] = [                    // [type, length, value]
    [T_LIST, 1, 8],        //  0  root list: 1 child, at node byte 8
    [T_LIST, 6, 16],       //  8  the record: 6 children, at node byte 16
    [T_STRING, 0, 0],      // 16  "description"
    [T_LIST, 1, 64],       // 24  its value list
    [T_STRING, 0, 22],     // 32  "count"
    [T_LIST, 1, 72],       // 40  its value list
    [T_STRING, 0, 28],     // 48  "scale"
    [T_LIST, 1, 80],       // 56  its value list
    [T_STRING, 0, 12],     // 64  "FROSTFIRE"
    [T_INT, 0, 7],         // 72  7
    [T_FLOAT, 0, 0],       // 80  0.5, written as f32 below
  ];
  const out = new Uint8Array(nodesAt + 8 * nodes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, table.length, true); dv.setUint32(8, nodesAt, true);
  out.set(table, 12);
  nodes.forEach(([type, length, value], i) => {
    dv.setUint32(nodesAt + 8 * i, (type & 0xff) | (length << 16), true);
    dv.setUint32(nodesAt + 8 * i + 4, value, true);
  });
  dv.setFloat32(nodesAt + 8 * 10 + 4, 0.5, true);
  return out;
}

/** A root list whose only child is itself: nothing but the depth cap ends this walk. */
function selfReferentialRdr(): Uint8Array {
  const out = new Uint8Array(12 + 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, 0, true); dv.setUint32(8, 12, true);
  dv.setUint32(12, T_LIST | (1 << 16), true); dv.setUint32(16, 0, true);
  return out;
}

function unknownTypeRdr(): Uint8Array {
  const out = new Uint8Array(12 + 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, 0, true); dv.setUint32(8, 12, true);
  dv.setUint32(12, 7, true); dv.setUint32(16, 0, true);
  return out;
}

describe('parseRdr', () => {
  it('decodes a synthetic script: strings, ints, floats and nested lists', () => {
    const root = parseRdr(syntheticRdr());
    expect(root).toEqual([['description', ['FROSTFIRE'], 'count', ['7'], 'scale', ['0.5']]]);
  });

  it('rejects a file whose version is not 1', () => {
    const bad = syntheticRdr();
    new DataView(bad.buffer).setUint32(0, 2, true);
    expect(() => parseRdr(bad)).toThrow(/rdr version 2/);
  });

  it('rejects a node type it does not know instead of returning garbage', () => {
    expect(() => parseRdr(unknownTypeRdr())).toThrow(/rdr node type 7/);
  });

  it('stops at the nesting cap instead of looping forever', () => {
    expect(() => parseRdr(selfReferentialRdr())).toThrow(/nesting/);
  });
});

describe('rdrGet', () => {
  const root = parseRdr(syntheticRdr());

  it('looks through the root wrapper and returns a lone value unwrapped', () => {
    expect(rdrGet(root, 'description')).toBe('FROSTFIRE');
    expect(Number(rdrGet(root, 'count'))).toBe(7);
    expect(Number(rdrGet(root, 'scale'))).toBeCloseTo(0.5);
  });

  it('returns undefined for a key that is not there, and for a string node', () => {
    expect(rdrGet(root, 'nope')).toBeUndefined();
    expect(rdrGet('FROSTFIRE', 'description')).toBeUndefined();
  });

  it('returns the whole list when a key carries more than one value', () => {
    expect(rdrGet([['team', ['1', '2']]], 'team')).toEqual(['1', '2']);
  });
});

const mp2 = fixture('RUN/MP2.ZDB');
describe('the compiled scripts of Frostfire', () => {
  it.skipIf(!mp2)('mission.rdr names the map and mp2.rdr carries MetersPerUnit 0.1', () => {
    const toc = parseZdb(mp2!);
    const readerm = Zar.parse(zdbMember(mp2!, toc, 'READERM.ZAR'));
    // 36 §6: READERM.ZAR's root children are the scripts themselves, names kept with their .rdr suffix.
    expect(readerm.root.children.map((k) => k.name)).toContain('mission.rdr');

    const mission = parseRdr(readerm.data(readerm.find('mission.rdr')!));
    expect(rdrGet(mission, 'description')).toBe('FROSTFIRE');
    expect(rdrGet(mission, 'LoadingScreenAssets')).toBe('ui/assetlib/ld/om02');

    const mp2rdr = parseRdr(readerm.data(readerm.find('mp2.rdr')!));
    const wp = rdrGet(mp2rdr, 'world_params') as RdrNode[];
    expect(Number(rdrGet(wp, 'MetersPerUnit'))).toBeCloseTo(0.1);
    expect(rdrGet(wp, 'DefaultMaterial')).toBe('METAL_THICK');
  });
});
