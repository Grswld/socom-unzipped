import { describe, expect, it } from 'vitest';
import { parseZdb, Reader, zdbMember, Zar } from '@s2u/archive';
import { bounds, interpretChain, interpretPacket, interpretScaledChain, mergeMeshes, modelNodes, unpackVifStream, walkModel } from '../src';
import { fixture } from '../../archive/test/fixtures';

/**
 * VU1 command `0x70` (research 15 §2): the same vertex record as `0x68`, but the position is `ITOF15` times
 * `TOP+3.w` rather than `ITOF4` plus `TOP+3.xyz`. The fittings (`FLIB_MDL.ZED`) and the weapons
 * (`WEAP_MDL.ZED`) are stored that way (web/docs/research/78 §5); map geometry never is (SEMANTICS §9).
 */
function scaledPacket(scale: number, verts: [number, number, number][]): Uint8Array {
  const words: number[] = [];
  const u32 = (x: number) => words.push(x >>> 0);
  const V = verts.length;
  const i16pair = (a: number, b: number) => ((a & 0xffff) | ((b & 0xffff) << 16)) >>> 0;
  u32(0x01000101); u32((0x6c << 24) | (4 << 16) | 0x8000);                // STCYCL 1,1; UNPACK V4-32 addr 0
  const f = new DataView(new ArrayBuffer(4));
  const float = (x: number) => { f.setFloat32(0, x, true); return f.getUint32(0, true); };
  u32(0x8000); u32((1 << 14) | (125 << 15) | (3 << 28)); u32(0x412); u32(0);
  u32(0x8000 | V); u32((1 << 14) | (123 << 15) | (3 << 28)); u32(0x412); u32(0);
  u32(4 + 3 * V); u32(0); u32(V); u32(1);
  u32(0); u32(0); u32(0); u32(float(scale));
  u32(0x01000203); u32((0x6d << 24) | ((2 * V) << 16) | 0x8004);          // STCYCL 3,2; UNPACK V4-16 addr 4
  for (const [x, y, z] of verts) { u32(i16pair(x, y)); u32(i16pair(z, 0)); u32(i16pair(0, 0)); u32(i16pair(0, 0)); }
  u32(0x01000103); u32((0x6e << 24) | (V << 16) | 0xc006);                // STCYCL 3,1; UNPACK V4-8 USN addr 6
  for (let k = 0; k < V; k++) u32(0x80808080);
  u32(0x01000102); u32((0x6e << 24) | (1 << 16) | 0xc000 | (4 + 3 * V));  // the index entry
  u32(0x03060300);
  u32(0x01000102); u32((0x69 << 24) | (1 << 16) | 0x8000 | (5 + 3 * V));  // V3-16: the face normal
  u32(0); u32(0);                                                          // 6 bytes, padded
  u32(0x17000000);
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w, true));
  return out;
}

describe("interpretPacket's scaled form (VU1 0x70, research 15 §2)", () => {
  it('reads a position as int16 / 32768 times TOP+3.w, and leaves the offset form alone', () => {
    const packet = unpackVifStream(scaledPacket(2.5, [[32767, 0, -16384], [0, 16384, 0], [0, 0, 32767]]))[0]!;
    const scaled = interpretPacket(packet, 'scaled');
    expect(scaled.positions[0]).toBeCloseTo(2.5 * 32767 / 32768, 5);
    expect(scaled.positions[2]).toBeCloseTo(-1.25, 5);
    expect(scaled.positions[4]).toBeCloseTo(1.25, 5);
    // the default is still 0x68's ITOF4 plus the bias: 32767 / 16
    expect(interpretPacket(packet).positions[0]).toBeCloseTo(32767 / 16, 3);
  });
});

describe("Frostfire's fittings are the scaled form (research 78 §5)", () => {
  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)("every FLIB_MDL model decodes inside its FLIB_GEO bounding box read as 0x70, and far outside it read as 0x68", () => {
    const toc = parseZdb(mp2!);
    const mdl = Zar.parse(zdbMember(mp2!, toc, 'FLIB_MDL.ZED'));
    const geo = Zar.parse(zdbMember(mp2!, toc, 'FLIB_GEO.ZED'));
    expect(mdl.root.children.map((k) => k.name)).toEqual(
      ['right_eye', 'left_eye', 'gear_holster', 'seal_scuba_aslt_gear', 'seal_scuba_knife', 'Satchel', 'seal_goggles']);
    for (const model of mdl.root.children) {
      const chains = walkModel(mdl.data(model), modelNodes(mdl, model));
      const r = new Reader(geo.data(geo.find(`models/${model.name}/nparams`)!));
      const box = Array.from({ length: 6 }, (_, i) => r.f32(64 + i * 4));
      const extent = (form: 'offset' | 'scaled') => bounds(mergeMeshes(chains.flatMap(form === 'scaled' ? interpretScaledChain : interpretChain)));
      const scaled = extent('scaled');
      // a child node's own offset (the eyelids sit 0.03 forward of their eyeball) is the only slack
      for (let a = 0; a < 3; a++) {
        expect(scaled.min[a]!, `${model.name} min ${a}`).toBeGreaterThanOrEqual(box[a]! - 0.05);
        expect(scaled.max[a]!, `${model.name} max ${a}`).toBeLessThanOrEqual(box[3 + a]! + 0.05);
      }
      const offset = extent('offset');
      const span = (e: typeof offset) => Math.max(...[0, 1, 2].map((a) => e.max[a]! - e.min[a]!));
      expect(span(offset), model.name).toBeGreaterThan(20 * span(scaled));
    }
  });
});
