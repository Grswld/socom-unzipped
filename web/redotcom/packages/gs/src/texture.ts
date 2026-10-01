import { Reader } from '@s2u/archive';
import { decodeGsState, type GsState } from './gsState';
import { decodeTex0, TEXTURE_PSM, type Tex0 } from './tex0';

/** One `textures/<name>.tif/texdat` key, read exactly as `CTexture::Read` reads it (36 §5). */
export interface TextureRecord {
  name: string;
  width: number; height: number;
  size: number;                 // pixel bytes; always w * height * bpp / 8
  gsaddr: number;               // GS TBP0 in 64-word blocks, assigned by the exporter
  bpp: number;                  // m_texelBitSize
  selectQwc: number; palOffset: number;
  transparent: boolean; palettized: boolean; isMipChild: boolean; bumpmap: boolean;
  bilinear: boolean; transp1bit: boolean; dynamic: boolean; context: boolean;
  pixels: Uint8Array;
  tex0: Tex0 | null;            // recovered from the record's own bind packet; null when it holds none
  /** The blend, alpha test, filtering and wrap the same packet sets -- see `./gsState`. */
  gs: GsState | null;
}

const HEADER = 16;              // 36 §5: TEXTURE_PARAMS is 16 bytes
/**
 * Sixteen more bytes between TEXTURE_PARAMS and the pixels, which 36 §5 does not name.
 *
 * **[data]** Every texture of every extracted map begins them identically —
 * `08 00 00 00  00 00 00 00  AF AF AF AF  AF AF AF AF` — measured over all 83 direct 32bpp textures
 * across the 22 maps (`tools/probe-head.ts`) and all 53 palettised ones in MP2. Sixteen bytes that do
 * not vary with the map, the size, the format or the content are not image data.
 *
 * Read as pixels they shifted every texture by 16 bytes: four texels at 32bpp, sixteen at 8bpp. That
 * is a fraction of one row, which is why the M2 contact sheets passed — but on a 32x32 flare the four
 * stray texels land on the top edge as two fully opaque dots, which is what made the lamp glows look
 * like squares with a bright corner.
 *
 * The bytes after `size` settle it: for `lightrays.tif` they continue the image's own colour
 * (`199,203,181,0`) rather than starting the bind packet, so the image really does run to
 * `HEADER + PREFIX + size`.
 */
const PIXEL_PREFIX = 16;
const BIND_QWC = 9;             // 36 §5: a 144-byte, 9-quadword prebuilt bind packet follows the pixels

/**
 * TEXTURE_PARAMS then the pixels then the bind packet (36 §5):
 * `u16 w; u16 h; u32 size; u32 gsaddr; u32 { texelBitSize:8, selectQwc:8, pal_offset:8, 8x 1-bit flags }`.
 */
export function parseTextureRecord(name: string, texdat: Uint8Array): TextureRecord {
  const r = new Reader(texdat);
  const width = r.u16(0);       // 36 §5
  const height = r.u16(2);      // 36 §5
  const size = r.u32(4);        // 36 §5
  const gsaddr = r.u32(8);      // 36 §5
  const flags = r.u32(12);      // 36 §5
  const bpp = flags & 0xff;                       // 36 §5: m_texelBitSize, bits 0-7
  const selectQwc = (flags >>> 8) & 0xff;         // 36 §5: m_selectQwc, bits 8-15
  const palOffset = (flags >>> 16) & 0xff;        // 36 §5: m_pal_offset, bits 16-23
  const bit = (n: number): boolean => ((flags >>> (24 + n)) & 1) === 1;  // 36 §5: eight 1-bit flags from bit 24
  return {
    name, width, height, size, gsaddr, bpp, selectQwc, palOffset,
    transparent: bit(0), palettized: bit(1), isMipChild: bit(2), bumpmap: bit(3),
    bilinear: bit(4), transp1bit: bit(5), dynamic: bit(6), context: bit(7),
    pixels: r.slice(HEADER + PIXEL_PREFIX, size),   // after the header and the 16-byte prefix
    tex0: findTex0(r, HEADER + PIXEL_PREFIX + size, gsaddr, width, height),
    gs: findGsState(r, HEADER + PIXEL_PREFIX + size),
  };
}

/**
 * The bind packet's words are VU1 parameters and one GS TEX0 register value. The TEX0 word is the one
 * whose PSM names a texture format, whose TBP0 is this texture's own gsaddr, and whose TW and TH are the
 * log2 of this texture's own width and height (36 §5). The size agreement is what keeps a small VU1
 * parameter word out: `0x...000e` alone reads as PSMCT32 at TBP0 14, and three Frostfire textures sit at
 * exactly those addresses.
 */
function findTex0(r: Reader, at: number, gsaddr: number, width: number, height: number): Tex0 | null {
  const end = Math.min(at + BIND_QWC * 16, r.length);
  for (let o = at; o + 8 <= end; o += 8) {        // each quadword's low u64 then its high u64
    const t = decodeTex0(r.u64(o));
    if (TEXTURE_PSM.has(t.psm) && t.tbp0 === gsaddr && 1 << t.tw === width && 1 << t.th === height) return t;
  }
  return null;
}

/**
 * The A+D block of the same packet, read quadword by quadword: the low u64 is the register value and
 * the low byte of the high u64 is the register id. Words that are not one of the four wanted registers
 * (the GIFtag itself, the VU1 parameters, `TEX0`) are simply not matched.
 */
function findGsState(r: Reader, at: number): GsState | null {
  const end = Math.min(at + BIND_QWC * 16, r.length);
  const quadwords: { value: bigint; register: number }[] = [];
  for (let o = at; o + 16 <= end; o += 16) {
    quadwords.push({ value: r.u64(o), register: Number(r.u64(o + 8) & 0xffn) });
  }
  return decodeGsState(quadwords);
}
