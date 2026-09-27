/** The GS TEX0 register: where a texture lives in GS memory and how its texels are read. */
export interface Tex0 {
  tbp0: number; tbw: number; psm: number; tw: number; th: number; tcc: number; tfx: number;
  cbp: number; cpsm: number; csm: number; csa: number; cld: number;
}

/** GS pixel storage modes. The values a SOCOM texture record is allowed to carry. */
export const PSM = {
  CT32: 0x00, CT24: 0x01, CT16: 0x02, CT16S: 0x0a,
  T8: 0x13, T4: 0x14, T8H: 0x1b, T4HL: 0x24, T4HH: 0x2c,
} as const;

/** The same values as a set, for recognising a TEX0 word among the other words of a bind packet. */
export const TEXTURE_PSM: ReadonlySet<number> = new Set(Object.values(PSM));

const field = (q: bigint, lo: number, width: number): number =>
  Number((q >> BigInt(lo)) & ((1n << BigInt(width)) - 1n));

/**
 * TEX0 bit layout: TBP0 0-13, TBW 14-19, PSM 20-25, TW 26-29, TH 30-33, TCC 34, TFX 35-36,
 * CBP 37-50, CPSM 51-54, CSM 55, CSA 56-60, CLD 61-63 (36 §5).
 */
export function decodeTex0(q: bigint): Tex0 {
  return {
    tbp0: field(q, 0, 14), tbw: field(q, 14, 6), psm: field(q, 20, 6),
    tw: field(q, 26, 4), th: field(q, 30, 4), tcc: field(q, 34, 1), tfx: field(q, 35, 2),
    cbp: field(q, 37, 14), cpsm: field(q, 51, 4), csm: field(q, 55, 1),
    csa: field(q, 56, 5), cld: field(q, 61, 3),
  };
}
