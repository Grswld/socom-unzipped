import { Reader } from '@s2u/archive';

/** One `palettes/texpal_<id>` key pair: its 8-byte `par` header and its `buf` of 256 entries (36 §5). */
export interface PaletteRecord {
  gsaddr: number;               // == the numeric suffix in the key name, and the TEX0.CBP that cites it
  format: number;               // 2 = PSMCT16 (512-byte buf), 0 = PSMCT32 (1,024-byte buf)
  size: number;                 // buf bytes as the header declares them
  combo: boolean; dynamic: boolean;
  rgba: Uint8ClampedArray;      // 256 * 4, straight RGBA8, CT32 alpha rescaled from 0..0x80
}

export const PALETTE_ENTRIES = 256;
const CT16 = 2, CT32 = 0;       // 36 §5: m_format

/** `PALETTE_PARAMS`: `u32 m_gsaddr; u32 { m_size:16, m_format:8, m_combo_pal:1, m_dynamic:1 }` (36 §5). */
export function parsePaletteRecord(par: Uint8Array, buf: Uint8Array): PaletteRecord {
  const p = new Reader(par);
  const gsaddr = p.u32(0);                        // 36 §5
  const packed = p.u32(4);                        // 36 §5
  const size = packed & 0xffff;                   // 36 §5: m_size, bits 0-15
  const format = (packed >>> 16) & 0xff;          // 36 §5: m_format, bits 16-23
  const combo = ((packed >>> 24) & 1) === 1;      // 36 §5: m_combo_pal, bit 24
  const dynamic = ((packed >>> 25) & 1) === 1;    // 36 §5: m_dynamic, bit 25
  return { gsaddr, format, size, combo, dynamic, rgba: expand(buf, format) };
}

function expand(buf: Uint8Array, format: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(PALETTE_ENTRIES * 4);
  const b = new Reader(buf);
  if (format === CT16) {
    const n = Math.min(PALETTE_ENTRIES, Math.floor(b.length / 2));
    for (let i = 0; i < n; i++) {
      const v = b.u16(i * 2);                     // 36 §5: 16-bit PSMCT16, abgr1555
      rgba[i * 4] = (v & 31) << 3;
      rgba[i * 4 + 1] = ((v >> 5) & 31) << 3;
      rgba[i * 4 + 2] = ((v >> 10) & 31) << 3;
      rgba[i * 4 + 3] = v >> 15 ? 255 : 0;
    }
    return rgba;
  }
  if (format !== CT32) throw new Error(`palette format ${format}: only PSMCT16 (2) and PSMCT32 (0) are stored`);
  const n = Math.min(PALETTE_ENTRIES, Math.floor(b.length / 4));
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = b.u8(i * 4);                    // 36 §5: 32-bit PSMCT32, alpha pre-scaled to 0..0x80
    rgba[i * 4 + 1] = b.u8(i * 4 + 1);
    rgba[i * 4 + 2] = b.u8(i * 4 + 2);
    rgba[i * 4 + 3] = Math.min(255, Math.round((b.u8(i * 4 + 3) * 255) / 128));
  }
  return rgba;
}
