import { describe, expect, it } from 'vitest';
import { parseZdb } from '@s2u/archive';
import { csm1ClutIndex, PaletteTable, parsePaletteRecord } from '@s2u/gs';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { decodeNamedTextures, readEffectBitmap, readReticle, RETICLE_TEXTURES } from '../src/hudBitmaps';

/**
 * The reticle's bitmaps (web sprint 2, W2.4): `RUN\COMMON\HUD2_TXR.ZED` in every `MP*.ZDB`, decoded with the palettes
 * of its own `HUD2_PAL.ZED` through the same `parseTextureRecord` -> `decodeTexture` path the world's textures take.
 */

const bytes = fixture('RUN/MP2.ZDB');
const absent = bytes === null;

/** Non-zero alpha texels: a bitmap that decoded to nothing has none. */
const inked = (data: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
  return n;
};

describe.skipIf(absent)(`the reticle's bitmaps off Frostfire's HUD2_TXR.ZED${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('ret_rifle_01 is 64x64, ret_rifle_02 32x32, ret_accuracy 16x16, and none is blank', () => {
    const { bitmaps, diagnostics } = readReticle(bytes!, parseZdb(bytes!));
    expect(diagnostics).toEqual([]);
    expect(bitmaps).not.toBeNull();
    const { fixed, floating, accuracy } = bitmaps!;
    expect([fixed.width, fixed.height]).toEqual([64, 64]);
    expect([floating.width, floating.height]).toEqual([32, 32]);
    expect([accuracy!.width, accuracy!.height]).toEqual([16, 16]);
    // The inked texel counts as decoded on 2026-09-28: the ring and its centre dot, one arm, the accuracy diamond.
    expect(inked(fixed.data)).toBe(1096);
    expect(inked(floating.data)).toBe(65);
    expect(inked(accuracy!.data)).toBe(16);
  });

  it.skipIf(absent)('_01 is the fixed part (a dark ring, a white dot at its centre); _02 one arm, white at its outer end', () => {
    const { fixed, floating } = readReticle(bytes!, parseZdb(bytes!)).bitmaps!;
    const at = (b: { width: number; data: Uint8ClampedArray }, x: number, y: number): number[] =>
      Array.from(b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4));
    expect(at(fixed, 31, 31)).toEqual([255, 255, 255, 215]);       // the centre dot, texels 31-32
    expect(at(fixed, 7, 31)).toEqual([0, 0, 0, 44]);               // the ring, radius 21-27, black at alpha <= 44
    expect(at(floating, 30, 30)).toEqual([255, 255, 255, 175]);    // the arm's core column 30, rows 8-30
    expect(at(floating, 30, 8)[3]).toBe(44);                       // dim at its inner end
    expect(at(floating, 20, 20)[3]).toBe(0);
  });
});

/** An 8x8 PSMT8 `texdat` as `CTexture::Read` lays it out (36 §5): the header, 16 prefix bytes, the pixels, the bind packet. */
function texdat(pixels: Uint8Array, gsaddr: number, cbp: number): Uint8Array {
  const out = new Uint8Array(16 + 16 + pixels.length + 144);
  const v = new DataView(out.buffer);
  v.setUint16(0, 8, true);
  v.setUint16(2, 8, true);
  v.setUint32(4, pixels.length, true);
  v.setUint32(8, gsaddr, true);
  v.setUint32(12, 8 | (1 << 25), true);                             // 8 bits a texel, palettised
  out.set(pixels, 32);
  // TEX0: TBP0 = gsaddr, PSM = PSMT8 (0x13), TW = TH = log2 8, CBP = the palette's id.
  const tex0 = BigInt(gsaddr) | (0x13n << 20n) | (3n << 26n) | (3n << 30n) | (BigInt(cbp) << 37n);
  v.setBigUint64(32 + pixels.length, tex0, true);
  return out;
}

/** A 16-entry PSMCT32 CLUT (`par` + `buf`), entry k = (16k, 255 - 16k, k, alpha 8k of 0x80). */
function clut16(gsaddr: number): { par: Uint8Array; buf: Uint8Array } {
  const par = new Uint8Array(8);
  const p = new DataView(par.buffer);
  p.setUint32(0, gsaddr, true);
  p.setUint32(4, 64, true);                                         // m_size 64, m_format 0 (PSMCT32)
  const buf = new Uint8Array(64);
  for (let k = 0; k < 16; k++) buf.set([16 * k, 255 - 16 * k, k, 8 * k], k * 4);
  return { par, buf };
}

describe('decodeNamedTextures (synthetic, the same path)', () => {
  it('an 8x8 PSMT8 texture through a 16-entry CLUT decodes to that CLUT\'s entries, csm1 order and alpha rescaled', () => {
    const table = new PaletteTable();
    const { par, buf } = clut16(7);
    table.add(parsePaletteRecord(par, buf));
    // Texel i shows entry i % 16; the stored index is where the csm1 block swap puts that entry (8..15 -> 16..23).
    const pixels = Uint8Array.from({ length: 64 }, (_, i) => csm1ClutIndex(i % 16));
    const { textures, diagnostics } = decodeNamedTextures(
      (name) => (name === 'ret_test.tif' ? texdat(pixels, 100, 7) : null), table, ['ret_test.tif', 'ret_missing.tif']);
    expect(diagnostics).toEqual(['ret_missing.tif: not in the library']);
    const rgba = textures['ret_test.tif']!;
    expect([rgba.width, rgba.height]).toEqual([8, 8]);
    const want: number[] = [];
    for (let i = 0; i < 64; i++) {
      const k = i % 16;
      want.push(16 * k, 255 - 16 * k, k, Math.min(255, Math.round((8 * k * 255) / 128)));
    }
    expect(Array.from(rgba.data)).toEqual(want);
  });

  it('names the three bitmaps W2.4 draws', () => {
    expect(RETICLE_TEXTURES).toEqual({ fixed: 'ret_rifle_01.tif', floating: 'ret_rifle_02.tif', accuracy: 'ret_accuracy.tif' });
  });
});

describe.skipIf(absent)(`the bullet mark off Frostfire's EFFE_TXR.ZED (W2.5)${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('decals.rdr\'s bullet_mark_stone.tif decodes 16x16 with its own EFFE_PAL: a dark hole in a lighter ring', () => {
    const { rgba, diagnostics } = readEffectBitmap(bytes!, parseZdb(bytes!), 'bullet_mark_stone.tif');
    expect(diagnostics).toEqual([]);
    expect([rgba!.width, rgba!.height]).toEqual([16, 16]);
    expect(inked(rgba!.data)).toBe(INKED_STONE);
    const at = (x: number, y: number): number[] => Array.from(rgba!.data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
    expect(at(6, 7)[0]).toBeLessThan(40);          // the hole: dark and the most opaque
    expect(at(6, 7)[3]).toBe(163);
    expect(at(0, 0)[3]).toBe(0);                   // the corner: clear
  });

  it.skipIf(absent)('a name the library does not hold is a diagnostic and no bitmap', () => {
    const { rgba, diagnostics } = readEffectBitmap(bytes!, parseZdb(bytes!), 'no_such_mark.tif');
    expect(rgba).toBeNull();
    expect(diagnostics).toEqual(['bullet mark: no_such_mark.tif: not in the library']);
  });
});

/** Non-zero alpha texels of `bullet_mark_stone.tif` as decoded on 2026-09-28. */
const INKED_STONE = 157;
