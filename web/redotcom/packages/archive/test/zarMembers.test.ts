import { describe, it, expect } from 'vitest';
import type { AssetSource, RangedAssetSource } from '../src/assetSource';
import { readZarMembers } from '../src/zarMembers';
import { Zar, zarIndexLength } from '../src/zar';
import { fixture } from './fixtures';

/** A two-member archive: root{a.bnk, b.bnk}, 36 §1's layout with the data size left 0 as BNKSTORE writes it. */
function twoMembers(): Uint8Array {
  const names = ['a.bnk', 'b.bnk'];
  const stable = new TextEncoder().encode(names.join('\0') + '\0');
  const keys = [[0, 0, 0, 2], [0x1000, 0, 3, 0], [0x1000 + 6, 16, 2, 0]];
  const keysAt = 100 + stable.length, dataAt = Math.ceil((keysAt + 16 * keys.length) / 16) * 16;
  const out = new Uint8Array(dataAt + 32);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, keys.length, true); dv.setUint32(8, stable.length, true); dv.setUint32(12, 0x1000, true);
  dv.setUint32(16, 16, true); dv.setUint32(96, 0x20002, true);
  out.set(stable, 100);
  keys.forEach((k, i) => k.forEach((v, j) => dv.setInt32(keysAt + 16 * i + 4 * j, v, true)));
  out.set([1, 2, 3], dataAt); out.set([9, 8], dataAt + 16);
  return out;
}

/** A ranged source over one file that records the ranges it was asked for. */
function rangedOver(bytes: Uint8Array): RangedAssetSource & { asked: [number, number][] } {
  const asked: [number, number][] = [];
  return {
    asked,
    list: async () => ['X.ZAR'],
    read: async () => { throw new Error('a ranged read was expected'); },
    size: async () => bytes.byteLength,
    readRange: async (_p, offset, length) => { asked.push([offset, length]); return bytes.slice(offset, offset + length); },
  };
}

describe('readZarMembers', () => {
  it('reads the key tree, then only the members asked for, from a ranged source', async () => {
    const bytes = twoMembers(), source = rangedOver(bytes);
    const got = await readZarMembers(source, 'X.ZAR', ['b.bnk', 'missing.bnk']);
    expect([...got.keys()]).toEqual(['b.bnk']);
    expect(Array.from(got.get('b.bnk')!)).toEqual([9, 8]);
    expect(source.asked[0]).toEqual([0, 100]);
    expect(source.asked[1]).toEqual([0, zarIndexLength(bytes)]);
    expect(source.asked[2]![1]).toBe(2);
    expect(Zar.parse(bytes.subarray(0, zarIndexLength(bytes))).root.children.map((k) => k.name)).toEqual(['a.bnk', 'b.bnk']);
  });
  it('reads a whole archive from a source that has no ranges', async () => {
    const bytes = twoMembers();
    const source: AssetSource = { list: async () => [], read: async () => bytes };
    expect(Array.from((await readZarMembers(source, 'X.ZAR', ['a.bnk'])).get('a.bnk')!)).toEqual([1, 2, 3]);
  });
  const bnk = fixture('RUN/SOUNDS/BNKSTORE.ZAR');
  it.skipIf(!bnk)('BNKSTORE.ZAR: 115 banks, MP2_fx.bnk 687,344 bytes by range', async () => {
    const zar = Zar.parse(bnk!);
    expect(zar.root.children.length).toBe(115);
    const got = await readZarMembers(rangedOver(bnk!), 'RUN/SOUNDS/BNKSTORE.ZAR', ['MP2_fx.bnk']);
    expect(got.get('MP2_fx.bnk')!.byteLength).toBe(687_344);
  });
});
