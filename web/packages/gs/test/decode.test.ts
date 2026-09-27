import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import {
  decodeTexture, PaletteTable, parseTextureRecord, psmt8Offset, type PaletteRecord, type TextureRecord,
} from '../src';
import { fixture } from '../../archive/test/fixtures';
import goldens from './goldens/frostfire-textures.json';

/** A 2x2 PSMT8 record whose pixels are the indices 0..3 and whose TEX0 cites palette 5. */
function synthetic(over: Partial<TextureRecord> = {}): TextureRecord {
  return {
    name: 't', width: 2, height: 2, size: 4, gsaddr: 1, bpp: 8, selectQwc: 0, palOffset: 0,
    transparent: false, palettized: true, isMipChild: false, bumpmap: false, bilinear: false,
    transp1bit: false, dynamic: false, context: false, pixels: new Uint8Array([0, 1, 2, 3]),
    tex0: { tbp0: 1, tbw: 1, psm: 0x13, tw: 1, th: 1, tcc: 0, tfx: 0, cbp: 5, cpsm: 0, csm: 0, csa: 0, cld: 0 },
    gs: null,
    ...over,
  };
}

/** 256 CT32 entries whose red is the entry's own number, so a decoded pixel names the entry it came from. */
function ramp(gsaddr = 5): PaletteRecord {
  const rgba = new Uint8ClampedArray(1024);
  for (let i = 0; i < 256; i++) rgba.set([i, 0, 255 - i, 255], i * 4);
  return { gsaddr, format: 0, size: 256, rgba, combo: false, dynamic: false };
}

const reds = (data: Uint8ClampedArray): number[] => Array.from(data).filter((_, i) => i % 4 === 0);

describe('decodeTexture', () => {
  it('maps a synthetic 2x2 PSMT8 through a CT32 palette', () => {
    const table = new PaletteTable();
    table.add(ramp());
    const out = decodeTexture(synthetic(), table, 'raster');
    expect(out.diagnostics).toEqual([]);
    expect({ width: out.rgba.width, height: out.rgba.height }).toEqual({ width: 2, height: 2 });
    // The indices 0..3 sit in a block of 32's first 8-entry group, which the csm1 swap leaves where it found it.
    expect(Array.from(out.rgba.data)).toEqual([0, 0, 255, 255, 1, 0, 254, 255, 2, 0, 253, 255, 3, 0, 252, 255]);
  });

  it('undoes the csm1 CLUT block swap: index 8 reads entry 16 and index 16 entry 8', () => {
    const table = new PaletteTable();
    table.add(ramp());
    const rec = synthetic({ pixels: new Uint8Array([8, 16, 24, 40]) });
    expect(reds(decodeTexture(rec, table, 'raster').rgba.data)).toEqual([16, 8, 24, 48]);
    expect(reds(decodeTexture(rec, table, 'raster', 'linear').rgba.data)).toEqual([8, 16, 24, 40]);
  });

  it('reads a swizzled PSMT8 texture through the GS page layout', () => {
    // The 16x16 block is four 16x4 columns; (4,0) is byte 32, (0,2) byte 33, (8,0) byte 2.
    expect([psmt8Offset(4, 0, 16), psmt8Offset(0, 2, 16), psmt8Offset(8, 0, 16)]).toEqual([32, 33, 2]);
    // Pages hold 8 blocks across by 4 down, 256 bytes each: the block right of the first is 256 bytes on.
    expect([psmt8Offset(16, 0, 32), psmt8Offset(0, 16, 32), psmt8Offset(0, 64, 128)]).toEqual([256, 512, 8192]);
    const table = new PaletteTable();
    table.add(ramp());
    const rec = synthetic({
      width: 16, height: 16, size: 256, pixels: Uint8Array.from({ length: 256 }, (_, i) => i),
      tex0: { ...synthetic().tex0!, tw: 4, th: 4 },
    });
    const out = decodeTexture(rec, table, 'swizzled', 'linear');
    expect(reds(out.rgba.data).slice(0, 9)).toEqual([0, 4, 16, 20, 32, 36, 48, 52, 2]);
    // Every byte of the block is used exactly once: the layout is a permutation, not a resampling.
    expect(new Set(reds(out.rgba.data)).size).toBe(256);
  });

  it('reports a missing palette and falls back to the first one', () => {
    const table = new PaletteTable();
    table.add(ramp(9));
    const out = decodeTexture(synthetic(), table, 'raster');
    expect(out.diagnostics).toEqual(['t: CBP 5 names no loaded palette; decoded with 9']);
    expect(reds(out.rgba.data)).toEqual([0, 1, 2, 3]);
  });

  it('reports a record whose bind packet held no TEX0 and reads it by m_texelBitSize', () => {
    const table = new PaletteTable();
    table.add(ramp());
    const out = decodeTexture(synthetic({ tex0: null }), table, 'raster');
    expect(out.diagnostics).toEqual([
      't: no TEX0 in the bind packet; read as 8-bit from m_texelBitSize',
      't: CBP 0 names no loaded palette; decoded with 5',
    ]);
    expect(reds(out.rgba.data)).toEqual([0, 1, 2, 3]);
  });

  const mp2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!mp2)('every Frostfire texture decodes and matches the frozen goldens', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const table = PaletteTable.fromZars([Zar.parse(zdbMember(mp2!, toc, 'MP2_PAL.ZED'))]);
    const textures = txr.find('textures')!.children;
    expect(textures).toHaveLength(65);
    expect(table.size).toBe(53);
    for (const k of textures) {
      const rec = parseTextureRecord(k.name, txr.data(txr.child(k, 'texdat')!));
      const out = decodeTexture(rec, table);
      expect({ name: k.name, diagnostics: out.diagnostics }).toEqual({ name: k.name, diagnostics: [] });
      expect(out.rgba.data).toHaveLength(rec.width * rec.height * 4);
      const hash = createHash('sha256').update(out.rgba.data).digest('hex').slice(0, 16);
      expect({ name: k.name, hash }).toEqual({ name: k.name, hash: (goldens as Record<string, string>)[k.name] });
    }
  });
});
