import { describe, it, expect } from 'vitest';
import {
  interpretPacket, interpretChain, interpretChainLines, interpretChainParts, interpretLinePacket,
  isLineStripPacket, mergeMeshes, bounds, MeshError, type MeshData,
} from '../src';
import { walkChain, walkModel, modelNodes, type Chain } from '../src/dma';
import { unpackVif, unpackVifStream } from '../src/vif';
import { parseZdb, zdbMember, Zar, Reader, type ZarKey } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

/** A VIF stream from literal 32-bit code words, little-endian as the DMAC delivers them. */
function words(...w: number[]): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  const dv = new DataView(out.buffer);
  w.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, true));
  return out;
}
const stcycl = (cl: number, wl: number) => 0x01000000 | (wl << 8) | cl;
const unpack = (vn: number, vl: number, num: number, addr: number, usn = false) =>
  (0x60 | (vn << 2) | vl) * 0x1000000 + (num << 16) + (0x8000 | (usn ? 0x4000 : 0) | addr);
const MSCNT = 0x17000000;
/** Concatenates stream parts, padding each unpack's data to the 4-byte boundary VIF1 re-aligns to. */
const bytes = (...parts: ArrayBufferView[]) => {
  const chunks = parts.map((p) => {
    const raw = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
    if (raw.byteLength % 4 === 0) return raw;
    const padded = new Uint8Array((raw.byteLength + 3) & ~3);
    padded.set(raw);
    return padded;
  });
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
};

/**
 * One synthetic MSCNT packet in exactly the shape SEMANTICS §2 lays out: a V4-32 header at TOP+0, `V`
 * vertex triples from TOP+4 (V4-16 positions/UV/normal at CL=3 WL=2, V4-8 USN colours at CL=3 WL=1), and
 * `P` two-quadword tail entries at TOP+4+3V (V4-8 USN indices, V3-16 face normals, both CL=2 WL=1).
 */
function packet(o: {
  bias: [number, number, number];
  verts: { a: [number, number, number, number]; b: [number, number, number, number]; c: [number, number, number, number] }[];
  tris: { e0: [number, number, number, number]; fn: [number, number, number] }[];
  /** The counts the header states, when they are to differ from the blocks actually written. */
  counts?: [indexBase: number, vertices: number, triangles: number];
  /** The `PRIM` field of the TOP+0 GIFtag template (SEMANTICS §3): `IIP|TME|FGE|ABE` on a fan is 125. */
  prim0?: number;
}): Uint8Array {
  const V = o.verts.length, P = o.tris.length, indexBase = 4 + 3 * V;
  const head = new ArrayBuffer(64);
  const hi = new Int32Array(head), hf = new Float32Array(head);
  const [statedBase, statedV, statedP] = o.counts ?? [indexBase, V, P];
  hi[2 * 4 + 0] = statedBase; hi[2 * 4 + 2] = statedV; hi[2 * 4 + 3] = statedP;   // TOP+2 .x .z .w (SEMANTICS §3)
  hi[0 * 4 + 1] = (1 << 14) | ((o.prim0 ?? 0) << 15) | (3 << 28);                   // TOP+0 .y: PRE, PRIM, NREG
  hf[3 * 4 + 0] = o.bias[0]; hf[3 * 4 + 1] = o.bias[1]; hf[3 * 4 + 2] = o.bias[2];
  const ab = new Int16Array(o.verts.flatMap((v) => [...v.a, ...v.b]));
  const col = new Uint8Array(o.verts.flatMap((v) => v.c));
  const idx = new Uint8Array(o.tris.flatMap((t) => t.e0));
  const fn = new Int16Array(o.tris.flatMap((t) => t.fn));
  return bytes(
    words(stcycl(1, 1), unpack(3, 0, 4, 0)), new Uint8Array(head),
    words(stcycl(3, 2), unpack(3, 1, 2 * V, 4)), ab,
    words(stcycl(3, 1), unpack(3, 2, V, 6, true)), col,
    words(stcycl(2, 1), unpack(3, 2, P, indexBase, true)), idx,
    words(stcycl(2, 1), unpack(2, 1, P, indexBase + 1)), fn,
    words(MSCNT),
  );
}

/** The synthetic stream wrapped as a chain, so `interpretChain` sees the texture a chain would name. */
function chainOf(vif: Uint8Array, textureName: string | null): Chain {
  const tags = textureName === null ? [] : [{ qwc: 0, reloc: 6, id: 1, addr: 0, vif0: 0, vif1: 0, tagOffset: 0, vifOffset: 0 }];
  return { nodeName: 'N000_000', headerOffset: 0, tags, textureName, textureNames: textureName === null ? [] : [textureName], vif };
}

/** A unit square in the y plane: raw positions 0/16 apart, so `/16` lands them one unit apart. */
const QUAD = {
  bias: [100, 5, -20] as [number, number, number],
  verts: [
    { a: [0, 0, 0, 0] as const, b: [0, 0, 0, 32767] as const, c: [255, 128, 0, 128] as const },
    { a: [16, 0, 0, 0] as const, b: [2048, 4096, 0, 32767] as const, c: [10, 20, 30, 64] as const },
    { a: [0, 0, 16, 0] as const, b: [-4096, 8192, 0, 32767] as const, c: [1, 2, 3, 255] as const },
    { a: [16, 0, 16, 16384] as const, b: [0, 0, -16384, 0] as const, c: [4, 5, 6, 0] as const },
  ].map((v) => ({ a: [...v.a] as [number, number, number, number], b: [...v.b] as [number, number, number, number], c: [...v.c] as [number, number, number, number] })),
  tris: [
    { e0: [0, 6, 3, 3] as [number, number, number, number], fn: [0, 32767, 0] as [number, number, number] },
    { e0: [3, 6, 9, 3] as [number, number, number, number], fn: [0, -32767, 0] as [number, number, number] },
  ],
};

const only = (vif: Uint8Array): MeshData => interpretPacket(unpackVifStream(vif)[0]!);

describe('interpretPacket', () => {
  it('converts every lane the way SEMANTICS names it', () => {
    const m = only(packet(QUAD));
    // §4 quadword a: position = int16/16 + bias
    expect(Array.from(m.positions)).toEqual([100, 5, -20, 101, 5, -20, 100, 5, -19, 101, 5, -19]);
    // §4 quadword b x,y: UV = int16/4096, normalised, no flip
    expect(Array.from(m.uvs)).toEqual([0, 0, 0.5, 1, -1, 2, 0, 0]);
    // §4 normal = (a.w, b.z, b.w)/32768
    expect(Array.from(m.normals!).map((v) => +v.toFixed(5)))
      .toEqual([0, 0, 0.99997, 0, 0, 0.99997, 0, 0, 0.99997, 0.5, -0.5, 0]);
    // §4 quadword c: 128 is unity on every lane (TEX0.TFX is MODULATE everywhere, and MODULATE is
    // `(Ct * Cf) >> 7`). RGB is left unclamped -- the first vertex's red is raw 255, which doubles
    // the texel -- while alpha clamps, so the third vertex's raw 255 is still just opaque.
    expect(Array.from(m.colors)).toEqual([
      1.9921875, 1, 0, 1,
      0.078125, 0.15625, 0.234375, 0.5,
      0.0078125, 0.015625, 0.0234375, 1,
      0.03125, 0.0390625, 0.046875, 0,
    ]);
    // §5/§6: one triangle per tail pair, index = byte/3, emitted in stored order
    expect(Array.from(m.indices)).toEqual([0, 2, 1, 1, 2, 3]);
    expect(Array.from(m.faceNormals!).map((v) => +v.toFixed(5))).toEqual([0, 0.99997, 0, 0, -0.99997, 0]);
    expect(m.textureName).toBe(null);
  });

  it('drops a degenerate triangle and keeps its face normal out of the mesh (§6)', () => {
    const m = only(packet({ ...QUAD, tris: [QUAD.tris[0]!, { e0: [3, 6, 3, 3], fn: [0, 0, 0] }, QUAD.tris[1]!] }));
    expect(Array.from(m.indices)).toEqual([0, 2, 1, 1, 2, 3]);
    expect(m.faceNormals!.length).toBe(6);
  });

  it('rejects an index that is not a multiple of 3', () => {
    const bad = () => only(packet({ ...QUAD, tris: [{ e0: [0, 4, 6, 3], fn: [0, 32767, 0] }] }));
    expect(bad).toThrow(MeshError);
    expect(bad).toThrow(/multiple of 3/);
  });

  it('rejects an index past the vertex count', () => {
    expect(() => only(packet({ ...QUAD, tris: [{ e0: [0, 3, 12, 3], fn: [0, 32767, 0] }] }))).toThrow(/vertex 4 of 4/);
  });

  it('rejects a count no VU memory could hold, before allocating for it', () => {
    expect(() => only(packet({ ...QUAD, counts: [16, 1000, 2] }))).toThrow(/past the 1024 quadwords/);
    expect(() => only(packet({ ...QUAD, counts: [16, 4, 600] }))).toThrow(/past the 1024 quadwords/);
  });

  it('rejects a packet whose header was never unpacked', () => {
    const vif = bytes(words(stcycl(1, 1), unpack(3, 1, 2, 4)), new Int16Array(8), words(MSCNT));
    expect(() => only(vif)).toThrow(/TOP\+0/);
  });
});

describe('the FGE bit of the TOP+0 template', () => {
  it('a packet whose template sets FGE is fogged', () => {
    expect(only(packet({ ...QUAD, prim0: 125 })).fog).toBe(true);        // IIP|TME|FGE|ABE, fan
  });
  it('a packet whose template clears FGE is not: the sky, the water, the glows', () => {
    expect(only(packet({ ...QUAD, prim0: 93 })).fog).toBe(false);         // the same with FGE off
  });
});

describe('interpretChain', () => {
  it('returns one mesh per MSCNT packet, carrying the texture in force (ruling b)', () => {
    const meshes = interpretChain(chainOf(packet(QUAD), 'floor_oilgrime.tif'));
    expect(meshes.length).toBe(1);
    expect(meshes[0]!.textureName).toBe('floor_oilgrime.tif');
  });

  it('names the chunk and packet when a packet does not decode', () => {
    const vif = bytes(words(stcycl(1, 1), unpack(3, 1, 2, 4)), new Int16Array(8), words(MSCNT));
    expect(() => interpretChain(chainOf(vif, null))).toThrow(/chunk N000_000 packet 0/);
  });
});

// ---------------------------------------------------------------------------------------------------
// Relocation type 1: the LINE_STRIP packet (36 §3; the layout table on `interpretLinePacket`).
// ---------------------------------------------------------------------------------------------------

const MSCAL0 = 0x14000000;
/** GS primitive types, as the low three bits of a GIFtag template's `PRIM`. */
const PRIM_LINE_STRIP = 2;
/**
 * A GIFtag template quadword as the disc holds it: `NLOOP` and `EOP` in lane x, then `PRE`, `PRIM` and
 * `NREG` packed into lane y, and `REGS = 0x412` (ST, RGBAQ, XYZF2) in lane z. Desert Glory's real
 * templates read back as exactly `[0x8000 | nloop, 0x303d4000, 0x412, 0]` with `PRIM = 122`.
 */
const giftag = (nloop: number, primType: number, fge = true): number[] => {
  const prim = (primType & 7) | (1 << 3) | (1 << 4) | (fge ? 1 << 5 : 0) | (1 << 6);     // IIP|TME|FGE|ABE
  return [0x8000 | nloop, (1 << 14) | (prim << 15) | (3 << 28), 0x412, 0];
};

interface StripPoint {
  p: [number, number, number]; n: [number, number, number]; uv: [number, number];
  c: [number, number, number, number];
}

/**
 * The two payloads a line-strip sub-packet is split across on disc: the colours a relocation-type-4 tag
 * transfers under its own tag-transfer codes, then the self-contained stream a relocation-type-1 tag
 * transfers under `NOP NOP` — two GIFtag templates at TOP+0, the float point pairs at TOP+2 CL=3 WL=2,
 * and the `MSCNT` that runs them.
 */
function lineStripPayloads(points: StripPoint[], statedCount = points.length, primType = PRIM_LINE_STRIP, fge = true) {
  const P = points.length;
  const head = new ArrayBuffer(32);
  new Int32Array(head).set([...giftag(0, primType, fge), ...giftag(statedCount, primType, fge)]);
  const ab = new Float32Array(points.flatMap((v) => [...v.p, v.n[0], ...v.uv, v.n[1], v.n[2]]));
  return {
    colours: bytes(new Uint8Array(points.flatMap((v) => v.c))),
    colourCodes: [stcycl(3, 1), unpack(3, 2, P, 4, true)] as [number, number],
    strip: bytes(
      words(stcycl(1, 1), unpack(3, 0, 2, 0)), new Uint8Array(head),
      words(stcycl(3, 2), unpack(3, 0, 2 * P, 2)), ab,
      words(MSCNT, 0, 0, 0),
    ),
  };
}

/**
 * A model buffer holding one chain, laid out the way an `MP*_MDL.ZED` model is: every tag's payload (or
 * texture name) first, quadword-aligned, then the count quadword and the 16-byte tags (36 §3). `walkChain`
 * is what reads it back, so the chain under test really goes through the relocation-type-1 tag path.
 */
function modelBuffer(tags: { id: number; reloc: number; codes?: [number, number]; payload?: Uint8Array; text?: string }[]) {
  const encoder = new TextEncoder();
  const blobs = tags.map((t) => (t.text !== undefined ? encoder.encode(`${t.text}\0`) : t.payload ?? new Uint8Array(0)));
  const addr: number[] = [];
  let at = 0;
  for (const b of blobs) { addr.push(at); at = (at + b.byteLength + 15) & ~15; }
  const headerOffset = at;
  const buffer = new Uint8Array(headerOffset + 16 * (tags.length + 1));
  blobs.forEach((b, i) => buffer.set(b, addr[i]!));
  const dv = new DataView(buffer.buffer);
  dv.setUint32(headerOffset, tags.length, true);                      // 36 §3: m_dmaQwc = *tag[0].u8
  tags.forEach((t, i) => {
    const o = headerOffset + 16 * (i + 1);
    const qwc = t.text !== undefined ? 0 : Math.ceil(blobs[i]!.byteLength / 16);
    dv.setUint32(o, ((t.id << 28) | (t.reloc << 16) | qwc) >>> 0, true);
    dv.setUint32(o + 4, addr[i]!, true);
    dv.setUint32(o + 8, t.codes?.[0] ?? 0, true);
    dv.setUint32(o + 12, t.codes?.[1] ?? 0, true);
  });
  return { buffer, headerOffset };
}

/** The three-tag preamble every real chain of these opens with, then the colour/strip pair. */
function lineChain(points: StripPoint[], statedCount?: number, primType?: number, fge?: boolean): Chain {
  const { colours, colourCodes, strip } = lineStripPayloads(points, statedCount, primType, fge);
  const mscal = bytes(new Float32Array(8), words(MSCAL0, 0, 0, 0));   // the reloc-3 parameter packet
  const { buffer, headerOffset } = modelBuffer([
    { id: 1, reloc: 6, text: 'tent_top.tif' },                        // 36 §3: the texture citation
    { id: 3, reloc: 3, codes: [stcycl(1, 1), unpack(3, 0, 2, 2)], payload: mscal },
    { id: 3, reloc: 4, codes: colourCodes, payload: colours },
    { id: 3, reloc: 1, payload: strip },                              // NOP NOP; the stream is the payload
  ]);
  return walkChain(buffer, headerOffset, 'N000_I000_V01');
}

const STRIP: StripPoint[] = [
  { p: [1, 2, 3], n: [0, 0, -1], uv: [0, 0], c: [255, 128, 0, 128] },
  { p: [4, 5, 6], n: [0, 1, 0], uv: [3.5, -1.25], c: [10, 20, 30, 64] },
  { p: [7, 8, 9], n: [0.6, 0.8, 0], uv: [12.375, 4.25], c: [1, 2, 3, 255] },
];

describe('relocation type 1: the LINE_STRIP packet', () => {
  it('carries the FGE bit of the template as `fog`', () => {
    expect(interpretChainLines(lineChain(STRIP))[0]!.fog).toBe(true);
    expect(interpretChainLines(lineChain(STRIP, undefined, undefined, false))[0]!.fog).toBe(false);
  });

  it('walks the type-1 tag and finds a LINE_STRIP where a mesh packet would have a counts quadword', () => {
    const chain = lineChain(STRIP);
    expect(chain.tags.map((t) => t.reloc)).toEqual([6, 3, 4, 1]);
    const drawn = unpackVif(chain).filter((p) => p.kind === 'mscnt');
    expect(drawn.length).toBe(1);
    expect(isLineStripPacket(drawn[0]!)).toBe(true);
    // The lanes a mesh decode would read as "the counts" are point 0's float position: that is exactly
    // how this used to come out as a header claiming billions of vertices.
    expect(drawn[0]!.f32[2 * 4]).toBe(1);
  });

  it('decodes the points lane for lane: float position, float UV, the split normal, the two colour scales', () => {
    const [strip, ...rest] = interpretChainLines(lineChain(STRIP));
    expect(rest).toEqual([]);
    // Positions are the stored floats: no /16 and no TOP+3 bias, there being no TOP+3.
    expect(Array.from(strip!.positions)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // UV is the stored float, unnormalised on purpose -- the texture repeats along the strip.
    expect(Array.from(strip!.uvs)).toEqual([0, 0, 3.5, -1.25, 12.375, 4.25]);
    // The normal is (a.w, b.z, b.w) as in §4, but already float, so nothing is divided by 32768.
    expect(Array.from(strip!.normals).map((v) => +v.toFixed(5))).toEqual([0, 0, -1, 0, 1, 0, 0.6, 0.8, 0]);
    // Colours keep the mesh contract: RGB on a full of 255, alpha on 128, alpha clamped.
    // 128 is unity on every lane, RGB included: the first point's red is raw 255, which doubles the
    // texel. Alpha clamps, because nothing is more opaque than opaque.
    expect(Array.from(strip!.colors)).toEqual([
      1.9921875, 1, 0, 1,
      0.078125, 0.15625, 0.234375, 0.5,
      0.0078125, 0.015625, 0.0234375, 1,
    ]);
    expect(strip!.textureName).toBe('tent_top.tif');
  });

  it('is not a mesh: interpretChain returns no triangles for it and no longer throws', () => {
    const chain = lineChain(STRIP);
    expect(interpretChain(chain)).toEqual([]);
    expect(interpretChainParts(chain).lines.length).toBe(1);
  });

  it('decodes a chunk that mixes both primitives, each packet by its own GIFtag', () => {
    const { colours, colourCodes, strip } = lineStripPayloads(STRIP);
    const mesh = packet(QUAD);
    const { buffer, headerOffset } = modelBuffer([
      { id: 1, reloc: 6, text: 'tent_top.tif' },
      { id: 3, reloc: 4, codes: colourCodes, payload: colours },
      { id: 3, reloc: 1, payload: strip },
      { id: 3, reloc: 2, payload: bytes(mesh, new Uint8Array((16 - (mesh.byteLength % 16)) % 16)) },
    ]);
    const parts = interpretChainParts(walkChain(buffer, headerOffset, 'N000_I000_V01'));
    expect(parts.lines.length).toBe(1);
    expect(parts.meshes.length).toBe(1);
    expect(parts.meshes[0]!.indices.length / 3).toBe(2);
  });

  it('rejects a GIFtag claiming more points than the packet unpacked, naming the point', () => {
    const bad = () => interpretChainLines(lineChain(STRIP, 5));
    expect(bad).toThrow(MeshError);
    expect(bad).toThrow(/point 3's position quadword at TOP\+11 was never unpacked/);
    expect(bad).toThrow(/chunk N000_I000_V01 packet 1/);
  });

  it('rejects a strip too short to draw a segment', () => {
    expect(() => interpretLinePacket(unpackVifStream(lineStripPayloads([STRIP[0]!]).strip)[0]!))
      .toThrow(/claims 1 points, too few/);
  });

  const mdl = (zdb: Uint8Array, member: string) => {
    const zar = Zar.parse(zdbMember(zdb, parseZdb(zdb), member));
    const models: ZarKey[] = [];
    zar.walk((k) => { if (k.children.length && k.size > 64) models.push(k); });
    return models.flatMap((m) => walkModel(zar.data(m), modelNodes(zar, m)));
  };
  const relocTags = (chains: Chain[], reloc: number) => chains.reduce((n, c) => n + c.tags.filter((t) => t.reloc === reloc).length, 0);
  /** The whole archive decoded: every chunk, both primitives, nothing thrown. */
  const decodeAll = (chains: Chain[]) => chains.map(interpretChainParts);

  const [mp2, mp6, mp72] = ['MP2', 'MP6', 'MP72'].map((m) => fixture(`RUN/${m}.ZDB`));

  it.skipIf(!mp6)('Desert Glory: 31 type-1 tags, 31 strips, 221 points, no chunk left undecoded (36 §3)', () => {
    const chains = mdl(mp6!, 'MP6_MDL.ZED');
    expect(relocTags(chains, 1)).toBe(31);
    const strips = decodeAll(chains).flatMap((p) => p.lines);
    expect(strips.length).toBe(31);                                   // one strip per type-1 tag, exactly
    expect(strips.reduce((n, s) => n + s.positions.length / 3, 0)).toBe(221);
    for (const s of strips) {
      expect(s.positions.length / 3).toBeGreaterThanOrEqual(2);
      for (const v of s.positions) expect(Number.isFinite(v)).toBe(true);
      // §4's invariant holds on a strip point too: the normal is unit length or exactly zero.
      for (let i = 0; i < s.normals.length; i += 3) {
        const len = Math.hypot(s.normals[i]!, s.normals[i + 1]!, s.normals[i + 2]!);
        if (len !== 0) expect(len).toBeCloseTo(1, 4);
      }
    }
  });

  it.skipIf(!mp72)('Crossroads: 163 type-1 tags, 163 strips, 850 points, and the tents keep their canvas', () => {
    const chains = mdl(mp72!, 'MP72_MDL.ZED');
    expect(relocTags(chains, 1)).toBe(163);
    const parts = decodeAll(chains);
    expect(parts.flatMap((p) => p.lines).length).toBe(163);
    expect(parts.flatMap((p) => p.lines).reduce((n, s) => n + s.positions.length / 3, 0)).toBe(850);
    // tent_beige/N000_I000_V01 is the chunk the diagnostics panel used to name: nine guy ropes, no mesh.
    const tent = chains.find((c) => c.nodeName === 'N000_I000_V01' && c.tags.some((t) => t.reloc === 1))!;
    const tentParts = interpretChainParts(tent);
    expect(tentParts.meshes).toEqual([]);
    expect(tentParts.lines.map((s) => s.positions.length / 3)).toEqual([4, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(tentParts.lines[0]!.textureName).toBe('tent_top.tif');
  });

  it.skipIf(!mp2)('Frostfire has no type-1 tag and no strip: the line primitive is a Desert Glory / Crossroads thing', () => {
    const chains = [...mdl(mp2!, 'MP2_MDL.ZED'), ...mdl(mp2!, 'WORL_MDL.ZED')];
    expect(relocTags(chains, 1)).toBe(0);
    expect(decodeAll(chains).flatMap((p) => p.lines)).toEqual([]);
  });

  it('a prim type that is not LINE_STRIP still takes the mesh decode', () => {
    // prim type 3 = TRIANGLE: the packet is not a strip, so it goes to interpretPacket and fails there
    // the way any malformed mesh packet does.
    expect(() => interpretChain(lineChain(STRIP, STRIP.length, 3))).toThrow(/the header claims/);
  });
});

describe('mergeMeshes and bounds', () => {
  const a = only(packet(QUAD));
  it('concatenates and re-bases indices', () => {
    const m = mergeMeshes([a, a]);
    expect(m.positions.length).toBe(24);
    expect(Array.from(m.indices)).toEqual([0, 2, 1, 1, 2, 3, 4, 6, 5, 5, 6, 7]);
    expect(m.uvs.length).toBe(16);
    expect(m.colors.length).toBe(32);
    expect(m.normals!.length).toBe(24);
    expect(m.faceNormals!.length).toBe(12);
    expect(m.textureName).toBe(null);
  });

  it('keeps a texture every part shares and drops one they do not', () => {
    const tex = (name: string | null): MeshData => ({ ...a, textureName: name });
    expect(mergeMeshes([tex('x.tif'), tex('x.tif')]).textureName).toBe('x.tif');
    expect(mergeMeshes([tex('x.tif'), tex('y.tif')]).textureName).toBe(null);
  });

  it('drops the normals when a part has none', () => {
    expect(mergeMeshes([a, { ...a, normals: null }]).normals).toBe(null);
  });

  it('keeps fog off only when every part is unfogged', () => {
    const fog = (on: boolean): MeshData => ({ ...a, fog: on });
    expect(mergeMeshes([fog(false), fog(false)]).fog).toBe(false);
    expect(mergeMeshes([fog(false), fog(true)]).fog).toBe(true);
    expect(mergeMeshes([]).fog).toBe(true);
  });

  it('measures the extent, and an empty mesh has none', () => {
    expect(bounds(a)).toEqual({ min: [100, 5, -20], max: [101, 5, -19] });
    expect(bounds(mergeMeshes([]))).toEqual({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  });
});

/** SEMANTICS §8: a node's `nparams` is 96 B = a 64-byte 4x4 matrix + a 32-byte bbox (36 §2). */
const NPARAMS_SIZE = 96;
/** Row-vector convention: the translation is the matrix's fourth row, floats 12, 13, 14 (ruling a). */
const TRANSLATION_AT = 12 * 4;

/**
 * Where Frostfire's world sits. `interpretChain` stays in model space by design (no `MP*_GEO.ZED` knowledge
 * in this package), so the test does the placement: it reads every direct child of `MP2_GEO.ZED`'s
 * `models/worldmodel/children` key, takes each one's `nparams` translation, and returns them by frequency.
 */
function worldTranslations(mp2: Uint8Array): { translation: [number, number, number]; nodes: number }[] {
  const geo = Zar.parse(zdbMember(mp2, parseZdb(mp2), 'MP2_GEO.ZED'));
  const children = geo.find('models/worldmodel/children');
  if (!children) throw new Error('MP2_GEO.ZED has no models/worldmodel/children key');
  const counts = new Map<string, { translation: [number, number, number]; nodes: number }>();
  for (const node of children.children) {
    const nparams = geo.child(node, 'nparams');
    if (!nparams || nparams.size !== NPARAMS_SIZE) continue;
    const r = new Reader(geo.data(nparams));
    const translation: [number, number, number] = [r.f32(TRANSLATION_AT), r.f32(TRANSLATION_AT + 4), r.f32(TRANSLATION_AT + 8)];
    const key = translation.join(',');
    const seen = counts.get(key) ?? { translation, nodes: 0 };
    seen.nodes++;
    counts.set(key, seen);
  }
  return [...counts.values()].sort((x, y) => y.nodes - x.nodes);
}

const translate = (m: MeshData, t: [number, number, number]): MeshData => {
  const positions = new Float32Array(m.positions);
  for (let i = 0; i < positions.length; i += 3) { positions[i]! += t[0]; positions[i + 1]! += t[1]; positions[i + 2]! += t[2]; }
  return { ...m, positions };
};

describe('Frostfire (MP2) worldmodel', () => {
  const mp2 = fixture('RUN/MP2.ZDB');
  const worldChains = () => {
    const toc = parseZdb(mp2!);
    const worl = Zar.parse(zdbMember(mp2!, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel')!;
    return walkModel(worl.data(world), modelNodes(worl, world));
  };
  const decoded = () => worldChains().flatMap(interpretChain);

  it.skipIf(!mp2)('33 of the 416 packets clear FGE (§11.4): the water and half the sky, every one of them', () => {
    const meshes = decoded();
    const unfogged = meshes.filter((m) => !m.fog);
    expect(unfogged.length).toBe(33);
    expect(meshes.filter((m) => m.textureName === 'a_water.tif').every((m) => !m.fog)).toBe(true);
    expect(meshes.filter((m) => m.textureName === 'a_floor.tif').every((m) => m.fog)).toBe(true);
  });

  it.skipIf(!mp2)('decodes all 416 drawn packets: 15,071 vertices, 8,765 triangles less the one degenerate (§10)', () => {
    const chains = worldChains();
    const meshes = chains.flatMap(interpretChain);
    expect(meshes.length).toBe(416);
    const stated = chains.flatMap(unpackVif).filter((p) => p.kind === 'mscnt')
      .reduce((n, p) => n + (p.mem[2 * 4 + 3]! >>> 0), 0);    // TOP+2.w, the packet's own triangle count
    expect(stated).toBe(8765);
    const world = mergeMeshes(meshes);
    expect(world.positions.length / 3).toBe(15071);
    expect(world.indices.length / 3).toBe(8764);
    expect(world.uvs.length / 2).toBe(15071);
    expect(world.colors.length / 4).toBe(15071);
    expect(world.normals!.length / 3).toBe(15071);
    expect(world.faceNormals!.length / 3).toBe(8764);
    for (const v of world.positions) expect(Number.isFinite(v)).toBe(true);
    for (const i of world.indices) expect(i).toBeLessThan(world.positions.length / 3);
  });

  it.skipIf(!mp2)('every vertex normal is unit length or exactly zero, and the stored face normal is the CCW cross product (§4, §6)', () => {
    const world = mergeMeshes(decoded());
    let zero = 0, unit = 0;
    for (let i = 0; i < world.normals!.length; i += 3) {
      const n = world.normals!.subarray(i, i + 3);
      const len = Math.hypot(n[0]!, n[1]!, n[2]!);
      if (len === 0) zero++; else { expect(len).toBeCloseTo(1, 3); unit++; }
    }
    expect(zero).toBe(16);
    expect(unit).toBe(15071 - 16);
    let worst = 1;
    for (let t = 0; t < world.indices.length / 3; t++) {
      const [i0, i1, i2] = [world.indices[3 * t]!, world.indices[3 * t + 1]!, world.indices[3 * t + 2]!];
      const p = (i: number) => world.positions.subarray(3 * i, 3 * i + 3);
      const [a, b, c] = [p(i0), p(i1), p(i2)];
      const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const len = Math.hypot(cr[0]!, cr[1]!, cr[2]!);
      const f = world.faceNormals!.subarray(3 * t, 3 * t + 3);
      const flen = Math.hypot(f[0]!, f[1]!, f[2]!);
      if (len === 0 || flen === 0) continue;
      worst = Math.min(worst, (cr[0]! * f[0]! + cr[1]! * f[1]! + cr[2]! * f[2]!) / (len * flen));
    }
    expect(worst).toBeGreaterThan(0.99);      // §6: the RH cross product in index order IS the face normal
  });

  it.skipIf(!mp2)('the worldmodel nodes share one placement, a pure translation of (960, 0, 800) (§8)', () => {
    const [first, ...rest] = worldTranslations(mp2!);
    expect(first!.translation).toEqual([960, 0, 800]);
    expect(first!.nodes).toBeGreaterThan(rest.reduce((n, r) => n + r.nodes, 0) / 2);
  });

  it.skipIf(!mp2)('placed by that node translation the world encloses both measured spawns and its floors sit under their feet', () => {
    const world = translate(mergeMeshes(decoded()), worldTranslations(mp2!)[0]!.translation);
    const b = bounds(world);
    for (const [x, y, z] of [[796, 100, 614], [536, 143, 1254]] as const) {
      expect(x).toBeGreaterThan(b.min[0]); expect(x).toBeLessThan(b.max[0]);
      expect(z).toBeGreaterThan(b.min[2]); expect(z).toBeLessThan(b.max[2]);
      // a triangle vertex within 40 units horizontally and 30 units below the spawn's feet: the floor it stands on
      let found = false;
      for (let i = 0; i < world.positions.length; i += 3) {
        const dx = world.positions[i]! - x, dz = world.positions[i + 2]! - z, dy = y - world.positions[i + 1]!;
        if (dx * dx + dz * dz < 40 * 40 && dy >= -5 && dy <= 30) { found = true; break; }
      }
      expect(found).toBe(true);
    }
    expect(world.indices.length / 3).toBeGreaterThan(2000);
  });
});
