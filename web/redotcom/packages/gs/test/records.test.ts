import { describe, it, expect } from 'vitest';
import { decodeTex0, parseTextureRecord, parsePaletteRecord, PSM } from '../src';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

describe('TEX0', () => {
  it('decodes a_floor.tif bind word from 36 §5', () => {
    const t = decodeTex0(0x201026e599304001n);
    expect(t).toMatchObject({ tbp0: 1, tbw: 1, psm: PSM.T8, tw: 6, th: 6, cbp: 311, cpsm: 2 });
  });

  it('decodes every field of an all-ones word to its field maximum', () => {
    const t = decodeTex0(0xffffffffffffffffn);
    expect(t).toEqual({ tbp0: 16383, tbw: 63, psm: 63, tw: 15, th: 15, tcc: 1, tfx: 3,
      cbp: 16383, cpsm: 15, csm: 1, csa: 31, cld: 7 });
  });
});

describe('records', () => {
  const mp2 = fixture('RUN/MP2.ZDB');

  it.skipIf(!mp2)('a_floor.tif is 64x64 PSMT8 palettized bilinear, pixels 4096 bytes, palette 311 exists as CT16', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const key = txr.find('textures/a_floor.tif/texdat')!;
    const rec = parseTextureRecord('a_floor.tif', txr.data(key));
    expect(rec).toMatchObject({ name: 'a_floor.tif', width: 64, height: 64, size: 4096, gsaddr: 1, bpp: 8,
      selectQwc: 6, palOffset: 0, palettized: true, bilinear: true,
      transparent: false, isMipChild: false, bumpmap: false, transp1bit: false, dynamic: false, context: false });
    expect(rec.pixels.byteLength).toBe(4096);
    expect(rec.tex0).toMatchObject({ tbp0: 1, psm: PSM.T8, cbp: 311, cpsm: 2 });

    const pal = Zar.parse(zdbMember(mp2!, toc, 'MP2_PAL.ZED'));
    const p311 = pal.find('palettes/texpal_311')!;
    const prec = parsePaletteRecord(pal.data(pal.child(p311, 'par')!), pal.data(pal.child(p311, 'buf')!));
    expect(prec.gsaddr).toBe(311);
    expect(prec.format).toBe(2);
    expect(prec.size).toBe(512);
    expect(prec.rgba.length).toBe(1024);
  });

  it.skipIf(!mp2)('all 65 Frostfire textures parse with size == w*h*bpp/8 and 53 palettes parse', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const texKeys = txr.find('textures')!.children;
    expect(texKeys.length).toBe(65);
    let withTex0 = 0;
    for (const k of texKeys) {
      const rec = parseTextureRecord(k.name, txr.data(txr.child(k, 'texdat')!));
      expect(rec.size).toBe((rec.width * rec.height * rec.bpp) / 8);
      expect(rec.pixels.byteLength).toBe(rec.size);
      if (rec.tex0) withTex0++;
    }
    expect(withTex0).toBe(65);

    const pal = Zar.parse(zdbMember(mp2!, toc, 'MP2_PAL.ZED'));
    const palKeys = pal.find('palettes')!.children;
    expect(palKeys.length).toBe(53);
    const formats = new Map<number, number>();
    for (const k of palKeys) {
      const prec = parsePaletteRecord(pal.data(pal.child(k, 'par')!), pal.data(pal.child(k, 'buf')!));
      expect(k.name).toBe(`texpal_${prec.gsaddr}`);              // 36 §5: the key suffix is the palette gsaddr
      expect(prec.rgba.length).toBe(1024);
      formats.set(prec.format, (formats.get(prec.format) ?? 0) + 1);
    }
    expect(formats.get(2)).toBe(48);                             // 36 §5 table: Frostfire is 48 CT16 / 5 CT32
    expect(formats.get(0)).toBe(5);
  });

  it.skipIf(!mp2)('every texture that cites a palette cites one MP2_PAL.ZED holds', () => {
    const toc = parseZdb(mp2!);
    const txr = Zar.parse(zdbMember(mp2!, toc, 'MP2_TXR.ZED'));
    const pal = Zar.parse(zdbMember(mp2!, toc, 'MP2_PAL.ZED'));
    const ids = new Set(pal.find('palettes')!.children.map((k) => parsePaletteRecord(
      pal.data(pal.child(k, 'par')!), pal.data(pal.child(k, 'buf')!)).gsaddr));
    for (const k of txr.find('textures')!.children) {
      const rec = parseTextureRecord(k.name, txr.data(txr.child(k, 'texdat')!));
      if (!rec.palettized) continue;
      expect({ name: rec.name, known: ids.has(rec.tex0!.cbp) }).toEqual({ name: rec.name, known: true });
    }
  });
});

describe('the TEX0 word in a bind packet', () => {
  /**
   * A 4x2 8-bit record: header, the 16-byte pixel prefix, 8 pixel bytes, then a 9-quadword packet the
   * caller fills. The prefix is the block every shipped texture carries between TEXTURE_PARAMS and its
   * pixels (see `PIXEL_PREFIX` in `texture.ts`); the fixture carries it so the bind packet lands where
   * a real record puts it.
   */
  const PREFIX = 16;
  const record = (gsaddr: number, words: bigint[]): Uint8Array => {
    const b = new Uint8Array(16 + PREFIX + 8 + 9 * 16);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, 4, true); dv.setUint16(2, 2, true);
    dv.setUint32(4, 8, true); dv.setUint32(8, gsaddr, true);
    dv.setUint32(12, 8 | (6 << 8) | (1 << 25), true);   // 8 bpp, selectQwc 6, palettized
    words.forEach((w, i) => dv.setBigUint64(16 + PREFIX + 8 + i * 8, w, true));
    return b;
  };
  const tex0 = 0x201026e599304001n;                     // a_floor.tif: TBP0 1, T8, TW 6, TH 6

  it('takes the word matching the size this record declares, not an earlier lookalike', () => {
    // 0x...0001 reads as PSMCT32 at TBP0 1: a plausible VU1 parameter word, a 1x1 texture.
    const resized = (tex0 & ~(0xffn << 26n)) | (2n << 26n) | (1n << 30n);   // TW 2, TH 1 for a 4x2 texture
    const rec = parseTextureRecord('decoy.tif', record(1, [0x0000000000000001n, resized]));
    expect(rec.tex0).toMatchObject({ tbp0: 1, psm: PSM.T8, tw: 2, th: 1, cbp: 311 });
  });

  it('is null when the packet holds no word that fits the record', () => {
    expect(parseTextureRecord('none.tif', record(1, [0x0000000000000001n, 7n])).tex0).toBeNull();
  });
});

describe('palette entries', () => {
  const par = (gsaddr: number, size: number, format: number): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint32(0, gsaddr, true);
    new DataView(b.buffer).setUint32(4, size | (format << 16), true);
    return b;
  };

  it('expands a CT16 entry as abgr1555', () => {
    const buf = new Uint8Array(512);
    // red 31, green 1, blue 0, alpha bit set
    new DataView(buf.buffer).setUint16(0, 31 | (1 << 5) | (1 << 15), true);
    const rec = parsePaletteRecord(par(94, 512, 2), buf);
    expect([...rec.rgba.slice(0, 8)]).toEqual([248, 8, 0, 255, 0, 0, 0, 0]);
  });

  it('scales the CT32 alpha from 0x80 to 255', () => {
    const buf = new Uint8Array(1024);
    buf.set([10, 20, 30, 0x80, 1, 2, 3, 0x40], 0);
    const rec = parsePaletteRecord(par(95, 1024, 0), buf);
    expect([...rec.rgba.slice(0, 8)]).toEqual([10, 20, 30, 255, 1, 2, 3, 128]);
  });
});
