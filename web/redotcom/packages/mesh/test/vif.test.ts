import { describe, it, expect } from 'vitest';
import { unpackVif, unpackVifStream, vifHistogram, VifError } from '../src/vif';
import { walkModel, modelNodes, type Chain } from '../src/dma';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

/** A VIF stream from literal 32-bit code words, little-endian as the DMAC delivers them. */
function words(...w: number[]): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  const dv = new DataView(out.buffer);
  w.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, true));
  return out;
}
const stcycl = (cl: number, wl: number) => 0x01000000 | (wl << 8) | cl;
/** An UNPACK code word: CMD = 0x60 | m | (vn << 2) | vl, NUM in bits 16-23, ADDR/USN/FLG in the immediate. */
const unpack = (vn: number, vl: number, num: number, addr: number, opts: { usn?: boolean; flg?: boolean; m?: boolean } = {}) =>
  (0x60 | (opts.m ? 0x10 : 0) | (vn << 2) | vl) * 0x1000000 + (num << 16) + ((opts.flg === false ? 0 : 0x8000) | (opts.usn ? 0x4000 : 0) | addr);
const MSCNT = 0x17000000;
const MSCAL = (imm: number) => 0x14000000 | imm;
const NOP = 0x00000000;
const bytes = (...parts: (Uint8Array | ArrayBufferView)[]) => {
  const chunks = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p.buffer, p.byteOffset, p.byteLength)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
};
/** What `VifError` a call throws, or null if it does not throw one. */
function thrown(run: () => unknown): VifError | null {
  try { run(); } catch (e) { return e instanceof VifError ? e : null; }
  return null;
}

describe('unpackVifStream', () => {
  it('skipping-write V4-16 at CL=3 WL=2 lands elements at 0,1,3,4 and sign-extends', () => {
    const data = new Int16Array([1, 2, 3, -4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, -16]);
    const stream = bytes(words(stcycl(3, 2), unpack(3, 1, 4, 0)), data, words(MSCNT));
    const [pkt] = unpackVifStream(stream);
    expect(pkt!.kind).toBe('mscnt');
    expect(pkt!.entry).toBe(-1);
    expect(Array.from(pkt!.mem.subarray(0, 4))).toEqual([1, 2, 3, -4]);
    expect(Array.from(pkt!.mem.subarray(4, 8))).toEqual([5, 6, 7, 8]);
    expect(pkt!.written[2]).toBe(0);
    expect(Array.from(pkt!.mem.subarray(12, 16))).toEqual([9, 10, 11, 12]);
    expect(Array.from(pkt!.mem.subarray(16, 20))).toEqual([13, 14, 15, -16]);
    expect(pkt!.unpacks).toEqual([{ addr: 0, num: 4, vn: 3, vl: 1, usn: false, flg: true, cl: 3, wl: 2, dataOffset: 8 }]);
    expect(pkt!.textureName).toBe(null);
  });

  it('USN leaves 16- and 8-bit lanes unsigned', () => {
    const halves = new Int16Array([-2, -2, -2, -2]);
    const octets = new Uint8Array([0xff, 0x80, 0x01, 0x00]);
    const [pkt] = unpackVifStream(bytes(
      words(stcycl(1, 1), unpack(3, 1, 1, 0, { usn: true })), halves,
      words(unpack(3, 2, 1, 1, { usn: true })), octets,
      words(unpack(3, 2, 1, 2)), octets,
      words(MSCNT),
    ));
    expect(Array.from(pkt!.mem.subarray(0, 4))).toEqual([65534, 65534, 65534, 65534]);
    expect(Array.from(pkt!.mem.subarray(4, 8))).toEqual([255, 128, 1, 0]);
    expect(Array.from(pkt!.mem.subarray(8, 12))).toEqual([-1, -128, 1, 0]);
  });

  it('V4-32 lanes keep their raw bits, readable as floats through f32', () => {
    const floats = new Float32Array([1.5, -2.25, 0, 0.0625]);
    const [pkt] = unpackVifStream(bytes(words(stcycl(1, 1), unpack(3, 0, 1, 7)), floats, words(MSCNT)));
    expect(Array.from(pkt!.f32.subarray(28, 32))).toEqual([1.5, -2.25, 0, 0.0625]);
    expect(pkt!.mem[28]).toBe(0x3fc00000);
    expect(pkt!.written[7]).toBe(1);
  });

  it('leaves the lanes a V3 or S unpack does not name as an earlier unpack wrote them', () => {
    const header = new Int32Array([1, 2, 3, 4]);
    const triple = new Uint8Array([7, 8, 9, 0 /* pad to the 4-byte boundary */]);
    const scalar = new Int32Array([42]);
    const [pkt] = unpackVifStream(bytes(
      words(stcycl(1, 1), unpack(3, 0, 1, 0)), header,
      words(unpack(2, 2, 1, 0)), triple.subarray(0, 3), new Uint8Array(1),
      words(unpack(0, 0, 1, 1)), scalar,
      words(MSCNT),
    ));
    expect(Array.from(pkt!.mem.subarray(0, 4))).toEqual([7, 8, 9, 4]);
    expect(Array.from(pkt!.mem.subarray(4, 8))).toEqual([42, 0, 0, 0]);
  });

  it('NUM of 0 means 256 elements', () => {
    const data = new Int32Array(256 * 4).map((_, i) => i);
    const [pkt] = unpackVifStream(bytes(words(stcycl(1, 1), unpack(3, 0, 0, 0)), data, words(MSCNT)));
    expect(pkt!.unpacks[0]!.num).toBe(256);
    expect(pkt!.written.reduce((n, f) => n + f, 0)).toBe(256);
    expect(pkt!.mem[255 * 4 + 3]).toBe(1023);
  });

  it('splits at every MSCAL and MSCNT, each packet starting from a fresh VU memory', () => {
    const one = new Int32Array([1, 1, 1, 1]);
    const two = new Int32Array([2, 2, 2, 2]);
    const pkts = unpackVifStream(bytes(
      words(stcycl(1, 1), unpack(3, 0, 1, 0)), one, words(MSCAL(4), NOP),
      words(unpack(3, 0, 1, 3)), two, words(MSCNT, NOP, NOP),
    ));
    expect(pkts.map((p) => [p.kind, p.entry])).toEqual([['mscal', 32], ['mscnt', -1]]);
    expect(Array.from(pkts[0]!.mem.subarray(0, 4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(pkts[1]!.mem.subarray(0, 4))).toEqual([0, 0, 0, 0]);   // not carried over
    expect(Array.from(pkts[1]!.mem.subarray(12, 16))).toEqual([2, 2, 2, 2]);
    expect(pkts[1]!.written[0]).toBe(0);
    expect(pkts[1]!.written[3]).toBe(1);
  });

  it('throws on a command outside the five', () => {
    expect(() => unpackVifStream(words(0x4a000000))).toThrow(/MPG|0x4a/i);
    for (const [name, word] of [['STMASK', 0x20000000], ['STROW', 0x30000000], ['STCOL', 0x31000000],
                                ['DIRECT', 0x50000000], ['MSCALF', 0x15000000]] as const) {
      const err = thrown(() => unpackVifStream(words(word)));
      expect(err?.code).toBe('unsupported-command');
      expect(err?.message).toContain(name);
      expect(err?.offset).toBe(0);
    }
  });

  it('throws on a masked unpack, and on the V4-5 format', () => {
    const masked = thrown(() => unpackVifStream(words(stcycl(1, 1), unpack(3, 0, 1, 0, { m: true }))));
    expect(masked?.code).toBe('masked-unpack');
    expect(masked?.offset).toBe(4);
    const v45 = thrown(() => unpackVifStream(words(unpack(3, 3, 1, 0))));
    expect(v45?.code).toBe('unsupported-format');
    expect(v45?.message).toMatch(/V4-5/);
  });

  it('throws on a filling write, on an unterminated packet, and on data past the end of the stream', () => {
    const filling = thrown(() => unpackVifStream(bytes(words(stcycl(1, 2), unpack(3, 0, 2, 0)), new Int32Array(8), words(MSCNT))));
    expect(filling?.code).toBe('filling-write');
    const open = thrown(() => unpackVifStream(bytes(words(stcycl(1, 1), unpack(3, 0, 1, 0)), new Int32Array(4), words(NOP))));
    expect(open?.code).toBe('unterminated-packet');
    expect(open?.offset).toBe(4);                                 // the unpack left open, not the trailing NOP
    const short = thrown(() => unpackVifStream(bytes(words(stcycl(1, 1), unpack(3, 0, 4, 0)), new Int32Array(4))));
    expect(short?.code).toBe('truncated-data');
  });

  it('throws when an unpack would write past the end of VU data memory', () => {
    const err = thrown(() => unpackVifStream(bytes(words(stcycl(1, 1), unpack(3, 0, 2, 1023)), new Int32Array(8), words(MSCNT))));
    expect(err?.code).toBe('vu-memory-overflow');
    expect(err?.message).toMatch(/1024/);
  });

  it('ignores trailing NOPs and a stream with no packets at all', () => {
    expect(unpackVifStream(words(NOP, NOP, stcycl(1, 1)))).toEqual([]);
    expect(unpackVifStream(new Uint8Array(0))).toEqual([]);
  });
});

describe('vifHistogram', () => {
  it('counts the commands of a stream without unpacking it', () => {
    const stream = bytes(words(NOP, stcycl(1, 1), unpack(3, 0, 1, 0)), new Int32Array(4), words(MSCAL(0), NOP, MSCNT));
    expect(vifHistogram(stream)).toEqual({ NOP: 2, STCYCL: 1, UNPACK: 1, MSCAL: 1, MSCNT: 1 });
  });
});

describe('unpackVif', () => {
  it('carries the texture the last citation before the packet named', () => {
    const one = new Int32Array([1, 1, 1, 1]);
    const vif = bytes(words(stcycl(1, 1), unpack(3, 0, 1, 0)), one, words(MSCNT),
                      words(stcycl(1, 1), unpack(3, 0, 1, 0)), one, words(MSCNT));
    // Tag offsets are not read here; only reloc and vifOffset are. The second citation lands at 28, the
    // byte where the second packet's codes begin.
    const tag = (reloc: number, vifOffset: number) =>
      ({ qwc: 0, reloc, id: 1, addr: 0, vif0: 0, vif1: 0, tagOffset: 0, vifOffset });
    const chain: Chain = {
      nodeName: 'N000_000', headerOffset: 0, tags: [tag(6, 0), tag(2, 0), tag(6, 28), tag(2, 28)],
      textureName: 'first.tif', textureNames: ['first.tif', 'second.tif'], vif,
    };
    expect(unpackVif(chain).map((p) => p.textureName)).toEqual(['first.tif', 'second.tif']);
  });

  it('reports no texture for a packet no citation precedes', () => {
    const vif = bytes(words(stcycl(1, 1), unpack(3, 0, 1, 0)), new Int32Array(4), words(MSCNT));
    const chain: Chain = {
      nodeName: 'N000_000', headerOffset: 0,
      tags: [{ qwc: 0, reloc: 2, id: 1, addr: 0, vif0: 0, vif1: 0, tagOffset: 0, vifOffset: 0 }],
      textureName: null, textureNames: [], vif,
    };
    expect(unpackVif(chain)[0]!.textureName).toBe(null);
  });
});

describe('Frostfire (MP2) worldmodel', () => {
  const mp2 = fixture('RUN/MP2.ZDB');
  const worldChains = () => {
    const toc = parseZdb(mp2!);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    return walkModel(worl.data(world), modelNodes(worl, world));
  };

  it.skipIf(!mp2)('histogram NOP 2953 STCYCL 2389 UNPACK 2389 MSCNT 416 MSCAL 309; every MSCAL is entry 0', () => {
    const total: Record<string, number> = {};
    let mscnt = 0, mscal = 0;
    for (const c of worldChains()) {
      for (const [k, v] of Object.entries(vifHistogram(c.vif))) total[k] = (total[k] ?? 0) + v;
      for (const p of unpackVif(c)) { if (p.kind === 'mscnt') mscnt++; else { mscal++; expect(p.entry).toBe(0); } }
    }
    expect(total).toEqual({ NOP: 2953, STCYCL: 2389, UNPACK: 2389, MSCNT: 416, MSCAL: 309 });
    expect(mscnt).toBe(416);
    expect(mscal).toBe(309);
  });

  it.skipIf(!mp2)('uses exactly the five unpack formats section 3 lists, every one FLG=1', () => {
    const formats = new Map<string, number>();
    for (const c of worldChains()) {
      for (const p of unpackVif(c)) {
        for (const u of p.unpacks) {
          expect(u.flg).toBe(true);
          const key = `V${u.vn + 1}-${[32, 16, 8][u.vl]}${u.usn ? ' USN' : ''}`;
          formats.set(key, (formats.get(key) ?? 0) + 1);
        }
      }
    }
    expect(Object.fromEntries([...formats].sort()))
      .toEqual({ 'V3-16': 416, 'V4-16': 416, 'V4-32': 725, 'V4-8 USN': 832 });
  });

  it.skipIf(!mp2)('the first MSCNT packet of chunk N000_000 has its header at qw 0-3, vertex triples from qw 4, and a 12-entry tail at qw 112..135', () => {
    const [chain] = worldChains();
    const pkts = unpackVif(chain!);
    const first = pkts.find((p) => p.kind === 'mscnt')!;
    expect(first.unpacks.map((u) => [u.vn, u.vl, u.num, u.addr, u.cl, u.wl])).toEqual([
      [3, 2, 36, 6, 3, 1], [3, 0, 4, 0, 1, 1], [3, 1, 72, 4, 3, 2], [3, 2, 12, 112, 2, 1], [2, 1, 12, 113, 2, 1],
    ]);
    for (let q = 0; q < 136; q++) expect(first.written[q]).toBe(1);
    expect(first.written.reduce((n, f) => n + f, 0)).toBe(136);
    // The V4-8 colours at CL=3 WL=1 and the V4-16 positions at CL=3 WL=2 interleave into 36 triples.
    expect(first.unpacks[0]!.usn).toBe(true);
    expect(first.unpacks[2]!.usn).toBe(false);
  });

  it.skipIf(!mp2)('the MSCAL-0 packet before it carries the V4-32 num=2 addr=2 parameter unpack', () => {
    const [chain] = worldChains();
    const [first] = unpackVif(chain!);
    expect(first!.kind).toBe('mscal');
    expect(first!.entry).toBe(0);
    expect(first!.unpacks.map((u) => [u.vn, u.vl, u.num, u.addr, u.cl, u.wl])).toEqual([[3, 0, 2, 2, 1, 1]]);
    expect(Array.from(first!.written.subarray(0, 5))).toEqual([0, 0, 1, 1, 0]);
  });

  it.skipIf(!mp2)('every one of the 725 packets names the texture in force, 37 distinct across the chunk set', () => {
    const chains = worldChains();
    const names: (string | null)[] = [];
    for (const c of chains) for (const p of unpackVif(c)) names.push(p.textureName);
    expect(names.length).toBe(725);
    expect(names.filter((n) => n === null)).toEqual([]);
    expect(new Set(names).size).toBe(37);
    expect(unpackVif(chains[0]!).map((p) => p.textureName))
      .toEqual(new Array(10).fill('cuba1a_sky01.tif'));
    // N004_000 cites two textures and draws two (MSCAL, MSCNT) pairs, one per texture.
    expect(unpackVif(chains[4]!).map((p) => [p.kind, p.textureName])).toEqual([
      ['mscal', 'wallsidingdull.tif'], ['mscnt', 'wallsidingdull.tif'],
      ['mscal', 'floor_oilgrime.tif'], ['mscnt', 'floor_oilgrime.tif'],
    ]);
  });

  it.skipIf(!mp2)("Frostfire's object models unpack too: MP2_MDL 1266 packets, FLIB_MDL 41", () => {
    const toc = parseZdb(mp2!);
    const count = (member: string) => {
      const zar = Zar.parse(zdbMember(mp2!, toc, member));
      const chains = zar.root.children.flatMap((m) => walkModel(zar.data(m), modelNodes(zar, m)));
      return chains.reduce((n, c) => n + unpackVif(c).length, 0);
    };
    expect(count('MP2_MDL.ZED')).toBe(636 + 630);
    expect(count('FLIB_MDL.ZED')).toBe(24 + 17);
  });
});
