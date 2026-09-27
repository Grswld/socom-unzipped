import { describe, expect, it } from 'vitest';
import { decodeAlpha, decodeClamp, decodeTest, decodeTex1, parseTextureRecord } from '../src';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

/**
 * The GS state a texture's bind packet sets, as the disc holds it. The words below are the ones
 * `tools/dump-gsstate.ts` tallied over all 22 maps; each decoder is pinned on a real value.
 */
describe('ALPHA', () => {
  it('0x44 is (Cs - Cd) * As + Cd, source-alpha blending', () => {
    expect(decodeAlpha(0x44n)).toBe('source');
  });
  it('0x48 is (Cs - 0) * As + Cd, additive', () => {
    expect(decodeAlpha(0x48n)).toBe('additive');
  });
  it('0x49 is (Cd - 0) * As + Cd, a brighten of the destination', () => {
    expect(decodeAlpha(0x49n)).toBe('destination');
  });
  it('0 is (Cs - Cs) * As + Cs, no blending at all', () => {
    expect(decodeAlpha(0n)).toBe('none');
  });
  it('0x68 is (Cs - 0) * FIX + Cd with FIX = 0: a fixed factor the EE animates', () => {
    expect(decodeAlpha(0x68n)).toBe('fixed');
  });
});

describe('TEST', () => {
  it('0x5000c is no alpha test, depth test GEQUAL', () => {
    expect(decodeTest(0x5000cn)).toEqual({ alphaTest: null, depthTest: true });
  });
  it('a cutout tests GREATER than 64 of the 128 unity: a 0.5 threshold', () => {
    // ATE=1, ATST=6 (GREATER) in bits 1-3, AREF=64 in bits 4-11, ZTE=1 bit 16, ZTST=2 bits 17-18.
    const word = BigInt(1 | (6 << 1) | (64 << 4) | (1 << 16) | (2 << 17));
    expect(decodeTest(word)).toEqual({ alphaTest: 0.5, depthTest: true });
  });
  it('an alpha test with a method other than GREATER/GEQUAL still yields its reference as a threshold', () => {
    const word = BigInt(1 | (5 << 1) | (32 << 4) | (1 << 16) | (2 << 17));   // GEQUAL 32
    expect(decodeTest(word)).toEqual({ alphaTest: 0.25, depthTest: true });
  });
});

describe('TEX1', () => {
  it('0x60 is bilinear with no mipmaps', () => {
    expect(decodeTex1(0x60n)).toEqual({ bilinear: true, mipmaps: false, levels: 0 });
  });
  it('MMIN = LINEAR_MIPMAP_LINEAR with MXL = 1 is one mip level of trilinear', () => {
    // LCM 0, MXL bits 2-4, MMAG bit 5, MMIN bits 6-8, K bits 32-43.
    const word = BigInt((1 << 2) | (1 << 5) | (5 << 6)) | (3992n << 32n);
    expect(decodeTex1(word)).toEqual({ bilinear: true, mipmaps: true, levels: 1 });
  });
  it('MMAG = NEAREST reads as not bilinear', () => {
    expect(decodeTex1(0n)).toEqual({ bilinear: false, mipmaps: false, levels: 0 });
  });
});

describe('CLAMP', () => {
  it('0 repeats on both axes', () => {
    expect(decodeClamp(0n)).toEqual({ wrapS: 'repeat', wrapT: 'repeat' });
  });
  it('5 clamps on both axes', () => {
    expect(decodeClamp(5n)).toEqual({ wrapS: 'clamp', wrapT: 'clamp' });
  });
  it('1 clamps S and repeats T', () => {
    expect(decodeClamp(1n)).toEqual({ wrapS: 'clamp', wrapT: 'repeat' });
  });
  it('the region modes fall back to their base mode', () => {
    expect(decodeClamp(BigInt(2 | (3 << 2)))).toEqual({ wrapS: 'clamp', wrapT: 'repeat' });
  });
});

describe('a texture record carries its bind packet state', () => {
  const mp2 = fixture('RUN/MP2.ZDB');

  it.skipIf(!mp2)('lightrays.tif: source blend, no alpha test, bilinear, repeat', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const key = txr.find('textures/lightrays.tif/texdat')!;
    const rec = parseTextureRecord('lightrays.tif', txr.data(key));
    expect(rec.gs).toEqual({
      blend: 'source', alphaTest: null, depthTest: true, bilinear: true, mipmaps: false, levels: 0,
      wrapS: 'repeat', wrapT: 'repeat',
    });
  });

  it.skipIf(!mp2)('every Frostfire texture has a state block, and the cutouts are the ones that alpha-test', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    let tested = 0, oneBit = 0;
    for (const k of txr.find('textures')!.children) {
      const rec = parseTextureRecord(k.name, txr.data(txr.child(k, 'texdat')!));
      expect(rec.gs, k.name).not.toBeNull();
      if (rec.gs!.alphaTest !== null) tested++;
      if (rec.transp1bit && rec.gs!.alphaTest !== null) oneBit++;
    }
    expect(tested).toBeGreaterThan(0);
    expect(oneBit).toBe(tested);        // an alpha test is only ever asked for by a one-bit texture
  });
});
