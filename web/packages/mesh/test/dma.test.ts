import { describe, it, expect } from 'vitest';
import { walkChain, walkModel, modelNodes } from '../src/dma';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

/** A model buffer holding one chain at `headerOffset`, built from consecutive 16-byte quadwords. */
function chainBuffer(quadwords: number[][], headerOffset: number, size: number): Uint8Array {
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  quadwords.forEach((qw, i) => qw.forEach((w, j) => view.setUint32(headerOffset + 16 * i + 4 * j, w, true)));
  return buf;
}
const tagWord = (id: number, reloc: number, qwc: number) => (id << 28) | (reloc << 16) | qwc;
const name = (buf: Uint8Array, at: number, text: string) => buf.set(new TextEncoder().encode(`${text}\0`), at);

describe('walkChain', () => {
  it('assembles the tag-transfer codes and the quadwords each tag transfers', () => {
    // A 4-tag chain: a texture citation, a ref, a cnt whose payload follows it in the chain, and a second
    // ref. The tag after the cnt is the one that proves the cursor stepped over the cnt's payload instead
    // of reading it as the next tag.
    const buf = chainBuffer([
      [4, 0, 0, 0],                                      // count quadword: 4 tags
      [tagWord(1, 6, 0), 0x10, 0, 0],                    // cnt/reloc 6: the texture name at 0x10
      [tagWord(3, 2, 1), 0x30, 0xaaaaaaaa, 0xbbbbbbbb],  // ref: 1 quadword at 0x30
      [tagWord(1, 2, 1), 0, 0xcccccccc, 0xdddddddd],     // cnt: 1 quadword following the tag
      [0x11111111, 0x22222222, 0x33333333, 0x44444444],  // ... which is this one, and is not a tag
      [tagWord(3, 4, 1), 0xa0, 0xeeeeeeee, 0xffffffff],  // ref: 1 quadword at 0xA0
    ], 0x40, 0x100);
    name(buf, 0x10, 'cuba1a_sky01.tif');
    buf.fill(0x5a, 0x30, 0x40);
    buf.fill(0x77, 0xa0, 0xb0);

    const chain = walkChain(buf, 0x40, 'N000_000');
    expect(chain.nodeName).toBe('N000_000');
    expect(chain.headerOffset).toBe(0x40);
    expect(chain.tags.map((t) => [t.id, t.reloc, t.qwc, t.addr, t.tagOffset]))
      .toEqual([[1, 6, 0, 0x10, 0x50], [3, 2, 1, 0x30, 0x60], [1, 2, 1, 0, 0x70], [3, 4, 1, 0xa0, 0x90]]);
    expect(chain.textureName).toBe('cuba1a_sky01.tif');
    // Each tag's contribution is 8 bytes of codes + one quadword; the citation contributes nothing, so it
    // points at where the ref after it lands.
    expect(chain.tags.map((t) => t.vifOffset)).toEqual([0, 0, 24, 48]);
    expect([...chain.vif]).toEqual([
      0xaa, 0xaa, 0xaa, 0xaa, 0xbb, 0xbb, 0xbb, 0xbb, ...new Array(16).fill(0x5a),
      0xcc, 0xcc, 0xcc, 0xcc, 0xdd, 0xdd, 0xdd, 0xdd, 0x11, 0x11, 0x11, 0x11,
      0x22, 0x22, 0x22, 0x22, 0x33, 0x33, 0x33, 0x33, 0x44, 0x44, 0x44, 0x44,
      0xee, 0xee, 0xee, 0xee, 0xff, 0xff, 0xff, 0xff, ...new Array(16).fill(0x77),
    ]);
    expect(chain.vif.byteLength).toBe(72);
  });

  it('keeps every citation in tag order, and textureName is the first', () => {
    const buf = chainBuffer([
      [3, 0, 0, 0],
      [tagWord(1, 6, 0), 0x10, 0, 0],                    // cuba1a_sky01.tif
      [tagWord(3, 2, 1), 0x30, 0, 0],                    // the packet it names
      [tagWord(1, 6, 0), 0x24, 0, 0],                    // a_concrete01.tif, for the packet after it
    ], 0x40, 0x100);
    name(buf, 0x10, 'cuba1a_sky01.tif');
    name(buf, 0x24, 'a_concrete01.tif');

    const chain = walkChain(buf, 0x40, 'N001_000');
    expect(chain.textureNames).toEqual(['cuba1a_sky01.tif', 'a_concrete01.tif']);
    expect(chain.textureName).toBe('cuba1a_sky01.tif');
    // The second citation names the packet that would follow the ref's 24 bytes.
    expect(chain.tags.map((t) => t.vifOffset)).toEqual([0, 0, 24]);
  });

  it('throws on a texture citation that also claims a transfer', () => {
    const buf = chainBuffer([[1, 0, 0, 0], [tagWord(1, 6, 1), 0x20, 0, 0]], 0, 0x40);
    name(buf, 0x20, 'a_concrete01.tif');
    expect(() => walkChain(buf, 0, 'N000_000')).toThrow(/texture citation with QWC 1, expected 0/);
    expect(() => walkChain(buf, 0, 'N000_000')).toThrow(/chain N000_000 tag at 0x10/);
  });

  it('throws naming the id and the tag offset on a DMA id no model chain uses', () => {
    const buf = chainBuffer([[1, 0, 0, 0], [tagWord(2, 2, 0), 0, 0, 0]], 0, 0x40);
    expect(() => walkChain(buf, 0, 'N000_000')).toThrow(/DMA id 2 \(next\)/);
    expect(() => walkChain(buf, 0, 'N000_000')).toThrow(/tag at 0x10/);
  });

  it('throws when a ref address runs past the model buffer', () => {
    const buf = chainBuffer([[1, 0, 0, 0], [tagWord(3, 2, 4), 0x30, 0, 0]], 0, 0x40);
    expect(() => walkChain(buf, 0, 'N000_000')).toThrow(/outside the 64-byte model buffer/);
  });
});

describe('walkModel', () => {
  const mp2 = fixture('RUN/MP2.ZDB');
  /** Every chunk of every model key under an archive's root. */
  const archiveChains = (zar: Zar) => zar.root.children.flatMap((m) => walkModel(zar.data(m), modelNodes(zar, m)));
  const tagCount = (chains: { tags: unknown[] }[]) => chains.reduce((n, c) => n + c.tags.length, 0);

  it.skipIf(!mp2)('Frostfire worldmodel: 123 chains, 1,450 tags, reloc types {2,3,4,6}, 37 distinct texture names, first chunk cites cuba1a_sky01.tif', () => {
    const toc = parseZdb(mp2!);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    const chains = walkModel(worl.data(world), modelNodes(worl, world));
    expect(chains.length).toBe(123);
    expect(tagCount(chains)).toBe(1450);
    const relocs = new Set(chains.flatMap((c) => c.tags.map((t) => t.reloc)));
    expect([...relocs].sort()).toEqual([2, 3, 4, 6]);
    expect(chains[0]!.textureName).toBe('cuba1a_sky01.tif');
    // A chunk cites one texture per sub-packet, not one per chain: 309 citations over the 123 chunks, 37
    // distinct names (36 §3). Only 13 chunks differ in their *first* texture, so the 37 are the union.
    expect(chains.reduce((n, c) => n + c.textureNames.length, 0)).toBe(309);
    expect(new Set(chains.flatMap((c) => c.textureNames)).size).toBe(37);
    for (const c of chains) expect(c.vif.byteLength % 4).toBe(0);
  });

  it.skipIf(!mp2)("Frostfire's object models: MP2_MDL 433 chains / 2,532 tags, FLIB_MDL 12 / 82 (36 §3)", () => {
    const toc = parseZdb(mp2!);
    const objects = archiveChains(Zar.parse(zdbMember(mp2!, toc, 'MP2_MDL.ZED')));
    expect([objects.length, tagCount(objects)]).toEqual([433, 2532]);
    const flib = archiveChains(Zar.parse(zdbMember(mp2!, toc, 'FLIB_MDL.ZED')));
    expect([flib.length, tagCount(flib)]).toEqual([12, 82]);
    for (const c of [...objects, ...flib]) expect(c.vif.byteLength % 4).toBe(0);
  });
});
