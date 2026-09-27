import { describe, it, expect } from 'vitest';
import { Zar } from '../src/zar';
import { parseZdb, zdbMember } from '../src/zdb';
import { fixture } from './fixtures';

/** 36 §1: 100-byte head, string table, 16-byte pre-order keys, align to padding, data blob. version 0x20002. */
function syntheticZar(): Uint8Array {
  const names = ['textures', 'a.tif', 'texdat'];
  const stable = new Uint8Array(names.join('\0').length + 1);
  let p = 0; for (const n of names) { for (const c of n) stable[p++] = c.charCodeAt(0); stable[p++] = 0; }
  const nameOfs: number[] = []; p = 0; for (const n of names) { nameOfs.push(p); p += n.length + 1; }
  const keys = [ // name_ptr, offset, size, child_count  (pre-order: root{textures{a.tif{texdat}}})
    [0, 0, 0, 1],                                   // the root record: the null name pointer retail writes
    [0x1000 + nameOfs[0]!, 0, 0, 1], [0x1000 + nameOfs[1]!, 0, 0, 1], [0x1000 + nameOfs[2]!, 0x10, 4, 0],
  ];
  const head = 100, stableAt = head, keysAt = stableAt + stable.length, padding = 16;
  const dataAt = Math.ceil((keysAt + 16 * keys.length) / padding) * padding;
  const out = new Uint8Array(dataAt + 0x20);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0, true);                 // flags
  dv.setUint32(4, keys.length, true);       // key_count
  dv.setUint32(8, stable.length, true);     // stable_size
  dv.setUint32(12, 0x1000, true);           // stable_ofs (the address the table was packed at; name_ofs is relative to it)
  dv.setUint32(16, padding, true);          // padding
  dv.setUint32(84, 0x20, true);             // data_size
  dv.setUint32(96, 0x20002, true);          // version
  out.set(stable, stableAt);
  keys.forEach((k, i) => { const o = keysAt + i * 16;
    dv.setInt32(o, k[0]!, true); dv.setUint32(o + 4, k[1]!, true); dv.setUint32(o + 8, k[2]!, true); dv.setInt32(o + 12, k[3]!, true); });
  out.set([0xde, 0xad, 0xbe, 0xef], dataAt + 0x10);
  return out;
}

describe('Zar', () => {
  it('parses a synthetic v2 archive and resolves paths', () => {
    const z = Zar.parse(syntheticZar());
    expect(z.keyCount).toBe(4);
    expect(z.root.name).toBe('');   // the root record's name pointer is null (zar_main.cpp:57-62)
    const texdat = z.find('textures/a.tif/texdat');
    expect(texdat?.size).toBe(4);
    expect(Array.from(z.data(texdat!))).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(z.find('textures/missing')).toBeUndefined();
  });
  it('rejects a key tree that does not consume exactly key_count records', () => {
    const bad = syntheticZar(); new DataView(bad.buffer).setUint32(4, 5, true);
    expect(() => Zar.parse(bad)).toThrow(/key_count/);
  });
  it('rejects a key tree that overruns key_count', () => {
    const bad = syntheticZar(); new DataView(bad.buffer).setUint32(4, 3, true);
    expect(() => Zar.parse(bad)).toThrow(/key_count/);
  });
  it('rejects a zero padding rather than reading an empty data blob', () => {
    const bad = syntheticZar(); new DataView(bad.buffer).setUint32(16, 0, true);
    expect(() => Zar.parse(bad)).toThrow(/padding/);
  });
  it('rejects a name pointer outside the string table, naming the key', () => {
    const bad = syntheticZar();
    const dv = new DataView(bad.buffer);
    const keysAt = 100 + dv.getUint32(8, true);
    dv.setInt32(keysAt + 16 * 3, 0x1000 + dv.getUint32(8, true), true); // key 3's name one byte past the table
    expect(() => Zar.parse(bad)).toThrow(/key 3: name offset/);
  });
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('Frostfire: MP2_GEO.ZED has 10,433 keys, MP2_TXR.ZED lists 65 textures, WORL_MDL.ZED has worldmodel with 123 chunks', () => {
    const toc = parseZdb(mp2!);
    const geo = Zar.parse(zdbMember(mp2!, toc, 'MP2_GEO.ZED'));
    expect(geo.keyCount).toBe(10_433);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    expect(txr.find('textures')!.children.length).toBe(65);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    expect(world.size).toBe(485_600);
    expect(world.children.length).toBe(123);
    expect(world.children[0]!.name).toBe('N000_000');
  });
});
