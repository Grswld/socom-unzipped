import { PSM } from './tex0';
import type { PaletteRecord } from './palette';
import type { PaletteTable } from './paletteTable';
import type { TextureRecord } from './texture';

/**
 * A decoded texture: straight RGBA8, `width * height * 4` bytes, rows in the order the record stores them.
 * Row 0 of `data` is row 0 of the stored pixels, which is what GL and glTF both call V = 0 -- so a consumer
 * uploads it with `flipY = false` and uses the UVs unflipped (spec §9, M3; R36 §5's "a viewer flips V" is
 * superseded). Nothing here is re-ordered top to bottom.
 */
export interface Rgba { width: number; height: number; data: Uint8ClampedArray }

/** The decode plus everything it had to work around, for the viewer to report (never thrown). */
export interface DecodedTexture { rgba: Rgba; diagnostics: string[] }

/** How the stored bytes are laid out: plain rows, or the GS PSMT8 page layout. */
export type PixelOrder = 'raster' | 'swizzled';

/** How a 256-entry 8-bit CLUT is laid out: the GS `csm1` block order, or plain ascending indices. */
export type ClutOrder = 'csm1' | 'linear';

/**
 * Both settled in M2 (2026-09-20) by decoding all 65 Frostfire textures each way and looking at the
 * contact sheets: the stored bytes are plain rows, and the CLUT does carry the `csm1` block swap.
 * `sign04.tif` and `cuba1a_sky01.tif` are the two witnesses; see the spec's section 9.
 */
export const DEFAULT_PIXEL_ORDER: PixelOrder = 'raster';
export const DEFAULT_CLUT_ORDER: ClutOrder = 'csm1';

const PAGE_W = 128, PAGE_H = 64, PAGE_BYTES = PAGE_W * PAGE_H;   // one PSMT8 page: 8,192 texels
const BLOCK_W = 16, BLOCK_H = 16, BLOCK_BYTES = BLOCK_W * BLOCK_H;
const PS2_ALPHA_FULL = 128;   // PS2 alpha is 0..0x80, not 0..0xff

/**
 * A 256-entry 8-bit CLUT is read out of GS memory in blocks of 32 whose two middle 8-entry groups are
 * swapped. Undoing that is a swap of bits 3 and 4 of the index.
 */
export function csm1ClutIndex(i: number): number {
  return (i & ~0x18) | ((i & 0x08) << 1) | ((i & 0x10) >> 1);
}

const bit = (v: number, n: number): number => (v >>> n) & 1;

/*
 * The three functions below undo the GS PSMT8 page layout. The reference is the **GS User's Manual**'s
 * description of PSMT8 local-memory addressing -- 128x64-texel pages, 32 blocks a page in the 8x4
 * interleave, 16x16 texels a block laid out as four 16x4 columns -- and the cross-check is the runtime's
 * own table in `third_party/ps2recomp/ps2xRuntime/include/runtime/gs/ps2_gs_psmt8.h`, which these
 * reproduce. Written from the layout; no code copied from either.
 *
 * `DEFAULT_PIXEL_ORDER` is `'raster'`, so none of this runs on the shipped path (M2, above); it stays
 * reachable as `decodeTexture(..., 'swizzled')` because a map whose pixels *are* swizzled would otherwise
 * be undecodable, and because it is the evidence the raster reading was chosen over.
 */

/**
 * Where texel (x, y) of a 16x16 PSMT8 block sits among that block's 256 bytes. The block is four 16x4
 * columns stacked downwards; inside a column the byte index is the texel's bits dealt out as
 * x0 -> 2, x1 -> 4, x2 -> 5, x3 -> 1, y0 -> 3, y1 -> 0, and bit 5 flipped again by y1 ^ y2 -- the
 * half-column swap. Written from the layout, not from the runtime's table, and checked to reproduce it.
 */
function blockOffset(x: number, y: number): number {
  return (((y >>> 2) & 3) << 6)
    | (bit(y, 1) << 0) | (bit(x, 3) << 1) | (bit(x, 0) << 2) | (bit(y, 0) << 3) | (bit(x, 1) << 4)
    | ((bit(x, 2) ^ bit(y, 1) ^ bit(y, 2)) << 5);
}

/** Which of a page's 32 blocks holds texel (x, y): 8 blocks across by 4 down, the two counts interleaved. */
function pageBlock(x: number, y: number): number {
  const bx = (x >>> 4) & 7, by = (y >>> 4) & 3;
  return (bx & 1) | ((by & 1) << 1) | ((bx & 2) << 1) | ((by & 2) << 2) | ((bx & 4) << 2);
}

/**
 * The byte index of texel (x, y) in a PSMT8 surface of `width` texels stored from block 0 of a page.
 * Pages tile left to right then top to bottom, 128x64 texels each.
 */
export function psmt8Offset(x: number, y: number, width: number): number {
  const pagesPerRow = Math.max(1, Math.ceil(width / PAGE_W));
  const page = (y / PAGE_H | 0) * pagesPerRow + (x / PAGE_W | 0);
  return page * PAGE_BYTES + pageBlock(x, y) * BLOCK_BYTES + blockOffset(x % BLOCK_W, y % BLOCK_H);
}

/**
 * A texture record to RGBA8. PSMT8 indexes the palette its `TEX0.CBP` names; PSMCT16 (`abgr1555`) and
 * PSMCT32 are read straight, with PS2 alpha rescaled. Nothing throws: what could not be honoured comes
 * back as a diagnostic string beside the pixels.
 */
export function decodeTexture(
  rec: TextureRecord,
  palettes: PaletteTable,
  order: PixelOrder = DEFAULT_PIXEL_ORDER,
  clut: ClutOrder = DEFAULT_CLUT_ORDER,
): DecodedTexture {
  const diagnostics: string[] = [];
  const data = new Uint8ClampedArray(rec.width * rec.height * 4);
  const rgba: Rgba = { width: rec.width, height: rec.height, data };
  let psm = rec.tex0?.psm;
  if (psm === undefined) {
    psm = psmOfBpp(rec.bpp);
    diagnostics.push(`${rec.name}: no TEX0 in the bind packet; read as ${rec.bpp}-bit from m_texelBitSize`);
  }
  switch (psm) {
    case PSM.T8: palettized(rec, palettes, order, clut, data, diagnostics); break;
    case PSM.CT16: case PSM.CT16S: direct16(rec, data); break;
    case PSM.CT32: case PSM.CT24: direct32(rec, data); break;
    default:
      diagnostics.push(`${rec.name}: no decoder for ${psm === undefined ? `${rec.bpp} bits per texel`
        : `PSM 0x${psm.toString(16)}`}; left transparent`);
  }
  return { rgba, diagnostics };
}

function psmOfBpp(bpp: number): number | undefined {
  return bpp === 8 ? PSM.T8 : bpp === 16 ? PSM.CT16 : bpp === 32 ? PSM.CT32 : undefined;
}

function palettized(
  rec: TextureRecord, palettes: PaletteTable, order: PixelOrder, clut: ClutOrder,
  data: Uint8ClampedArray, diagnostics: string[],
): void {
  const cbp = rec.tex0?.cbp ?? 0;
  let palette = palettes.get(cbp);
  if (!palette) {
    palette = palettes.first;
    if (!palette) { diagnostics.push(`${rec.name}: CBP ${cbp} has no palette and none are loaded`); return; }
    diagnostics.push(`${rec.name}: CBP ${cbp} names no loaded palette; decoded with ${palette.gsaddr}`);
  }
  const lut = clutEntries(palette, clut);
  const swizzled = order === 'swizzled';
  for (let y = 0; y < rec.height; y++) {
    for (let x = 0; x < rec.width; x++) {
      const src = swizzled ? psmt8Offset(x, y, rec.width) : y * rec.width + x;
      const entry = ((rec.pixels[src] ?? 0) & 0xff) * 4;
      data.set(lut.subarray(entry, entry + 4), (y * rec.width + x) * 4);
    }
  }
}

/** The palette's 256 entries in index order, the `csm1` block swap undone unless it was never applied. */
function clutEntries(palette: PaletteRecord, clut: ClutOrder): Uint8ClampedArray {
  if (clut === 'linear') return palette.rgba;
  const out = new Uint8ClampedArray(palette.rgba.length);
  for (let i = 0; i < 256; i++) {
    const from = csm1ClutIndex(i) * 4;
    out.set(palette.rgba.subarray(from, from + 4), i * 4);
  }
  return out;
}

function direct16(rec: TextureRecord, data: Uint8ClampedArray): void {
  for (let i = 0; i < rec.width * rec.height; i++) {
    const v = (rec.pixels[i * 2] ?? 0) | ((rec.pixels[i * 2 + 1] ?? 0) << 8);   // 36 §5: abgr1555
    data[i * 4] = (v & 31) << 3;
    data[i * 4 + 1] = ((v >>> 5) & 31) << 3;
    data[i * 4 + 2] = ((v >>> 10) & 31) << 3;
    data[i * 4 + 3] = v >>> 15 ? 255 : 0;
  }
}

function direct32(rec: TextureRecord, data: Uint8ClampedArray): void {
  for (let i = 0; i < rec.width * rec.height; i++) {
    data[i * 4] = rec.pixels[i * 4] ?? 0;
    data[i * 4 + 1] = rec.pixels[i * 4 + 1] ?? 0;
    data[i * 4 + 2] = rec.pixels[i * 4 + 2] ?? 0;
    data[i * 4 + 3] = Math.min(255, Math.round(((rec.pixels[i * 4 + 3] ?? 0) * 255) / PS2_ALPHA_FULL));
  }
}
