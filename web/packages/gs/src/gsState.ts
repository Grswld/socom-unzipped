/**
 * The GS state a texture's bind packet sets, decoded from the four registers its GIF A+D block writes
 * beside `TEX0`: `ALPHA_1`, `TEST_1`, `TEX1_1` and `CLAMP_1`.
 *
 * These are the per-draw facts a renderer used to guess from the pixels. They are on the disc, in every
 * texture record of every map (`tools/dump-gsstate.ts` tallies them), and what they say is not uniform:
 * 212 textures ask for additive blending, 146 for an alpha test at half unity with no blend, about 70 for
 * mipmapped sampling, and a few hundred for clamping on one axis or both.
 */

/**
 * How a drawn texel combines with the framebuffer, from `ALPHA`'s `Cv = (A - B) * C >> 7 + D`:
 *
 * - `source`: `(Cs - Cd) * As + Cd`, the ordinary source-alpha blend (0x44, the bulk).
 * - `additive`: `(Cs - 0) * As + Cd` (0x48): glows and flares, added to what is behind them.
 * - `destination`: `(Cd - 0) * As + Cd` (0x49): the destination brightened by the texel's alpha.
 * - `none`: `(Cs - Cs) * As + Cs` = `Cs` (0): no blend, the cutouts.
 * - `fixed`: `C = FIX`, a constant factor the EE animates per frame (0x68 on one glow).
 */
export type BlendMode = 'source' | 'additive' | 'destination' | 'none' | 'fixed';

export type WrapMode = 'repeat' | 'clamp';

export interface GsState {
  blend: BlendMode;
  /** `TEST.AREF / 128` when the alpha test is enabled, else null. The cutouts test GREATER 64: 0.5. */
  alphaTest: number | null;
  /** `TEST.ZTE`: always on in the corpus, kept so a draw that switched it off would be seen. */
  depthTest: boolean;
  /** `TEX1.MMAG`: linear magnification. */
  bilinear: boolean;
  /** `TEX1.MMIN` names a mipmap mode. */
  mipmaps: boolean;
  /** `TEX1.MXL`: how many levels beyond the base the hardware was given. */
  levels: number;
  wrapS: WrapMode;
  wrapT: WrapMode;
}

/** GS register ids, as the A+D block names them. */
export const GS_REG = { ALPHA_1: 0x42, TEX1_1: 0x14, TEST_1: 0x47, CLAMP_1: 0x08 } as const;

const field = (q: bigint, lo: number, width: number): number =>
  Number((q >> BigInt(lo)) & ((1n << BigInt(width)) - 1n));

/** `ALPHA`: A bits 0-1, B 2-3, C 4-5, D 6-7 (0 = Cs, 1 = Cd, 2 = zero; C: 0 = As, 1 = Ad, 2 = FIX). */
export function decodeAlpha(q: bigint): BlendMode {
  const a = field(q, 0, 2), b = field(q, 2, 2), c = field(q, 4, 2), d = field(q, 6, 2);
  if (c === 2) return 'fixed';
  if (a === 0 && b === 0 && d === 0) return 'none';
  if (a === 0 && b === 1 && d === 1) return 'source';
  if (a === 0 && b === 2 && d === 1) return 'additive';
  if (a === 1 && b === 2 && d === 1) return 'destination';
  // Anything else is a combination the corpus does not contain; source alpha is the least wrong reading.
  return 'source';
}

/** `TEST`: ATE bit 0, ATST 1-3, AREF 4-11, ZTE 16. */
export function decodeTest(q: bigint): { alphaTest: number | null; depthTest: boolean } {
  const ate = field(q, 0, 1) === 1;
  const aref = field(q, 4, 8);
  return { alphaTest: ate ? aref / 128 : null, depthTest: field(q, 16, 1) === 1 };
}

/** `TEX1`: MXL bits 2-4, MMAG bit 5, MMIN bits 6-8. MMIN 0/1 are point/linear; 2-5 are the mipmap modes. */
export function decodeTex1(q: bigint): { bilinear: boolean; mipmaps: boolean; levels: number } {
  const mxl = field(q, 2, 3), mmag = field(q, 5, 1), mmin = field(q, 6, 3);
  const mipmaps = mmin >= 2;
  return { bilinear: mmag === 1, mipmaps, levels: mipmaps ? mxl : 0 };
}

/** `CLAMP`: WMS bits 0-1, WMT 2-3; 0 REPEAT, 1 CLAMP, 2 REGION_CLAMP, 3 REGION_REPEAT. */
export function decodeClamp(q: bigint): { wrapS: WrapMode; wrapT: WrapMode } {
  const wrap = (v: number): WrapMode => (v === 1 || v === 2 ? 'clamp' : 'repeat');
  return { wrapS: wrap(field(q, 0, 2)), wrapT: wrap(field(q, 2, 2)) };
}

/**
 * The state from a run of A+D quadwords: each is a 64-bit value then a 64-bit register id. Null when the
 * block holds none of the four, which no record in the corpus does; the caller treats that as "unknown".
 */
export function decodeGsState(quadwords: { value: bigint; register: number }[]): GsState | null {
  let alpha: bigint | null = null, tex1: bigint | null = null, test: bigint | null = null, clamp: bigint | null = null;
  for (const { value, register } of quadwords) {
    if (register === GS_REG.ALPHA_1) alpha = value;
    else if (register === GS_REG.TEX1_1) tex1 = value;
    else if (register === GS_REG.TEST_1) test = value;
    else if (register === GS_REG.CLAMP_1) clamp = value;
  }
  if (alpha === null && tex1 === null && test === null && clamp === null) return null;
  return {
    blend: alpha === null ? 'source' : decodeAlpha(alpha),
    ...(test === null ? { alphaTest: null, depthTest: true } : decodeTest(test)),
    ...(tex1 === null ? { bilinear: true, mipmaps: false, levels: 0 } : decodeTex1(tex1)),
    ...(clamp === null ? { wrapS: 'repeat' as const, wrapT: 'repeat' as const } : decodeClamp(clamp)),
  };
}
