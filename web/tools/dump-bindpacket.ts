/**
 * What GS registers does a texture's bind packet actually set? If ALPHA (0x42) is in there, the blend
 * mode is per-texture and on the disc, and the viewer can stop guessing.
 *
 *   npx tsx tools/dump-bindpacket.ts MP72 light_bright
 *   npx tsx tools/dump-bindpacket.ts MP72            # every texture's register set, tallied
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, Reader, type ZarKey } from '@s2u/archive';

const archive = process.argv[2] ?? 'MP72';
const want = process.argv[3]?.toLowerCase();
const web = resolve(import.meta.dirname, '..');

/** GS register ids, the ones a bind packet could plausibly carry. */
const REG: Record<number, string> = {
  0x00: 'PRIM', 0x01: 'RGBAQ', 0x06: 'TEX0_1', 0x07: 'TEX0_2', 0x08: 'CLAMP_1', 0x09: 'CLAMP_2',
  0x14: 'TEX1_1', 0x15: 'TEX1_2', 0x16: 'TEX2_1', 0x17: 'TEX2_2', 0x1a: 'TEXA', 0x3b: 'TEXCLUT',
  0x3d: 'FOGCOL', 0x40: 'SCISSOR_1', 0x42: 'ALPHA_1', 0x43: 'ALPHA_2', 0x45: 'DTHE',
  0x46: 'COLCLAMP', 0x47: 'TEST_1', 0x48: 'TEST_2', 0x4c: 'FRAME_1', 0x4e: 'ZBUF_1',
  0x50: 'BITBLTBUF', 0x51: 'TRXPOS', 0x52: 'TRXREG', 0x53: 'TRXDIR', 0x3f: 'TEXFLUSH',
};

/** ALPHA: Cv = (A - B) * C >> 7 + D. 0=Cs 1=Cd 2=zero for A/B/D; C 0=As 1=Ad 2=FIX. */
const CH = ['Cs', 'Cd', '0', '0'];
const CC = ['As', 'Ad', 'FIX', '?'];
const alpha = (v: bigint): string => {
  const a = Number(v & 3n), b = Number((v >> 2n) & 3n), c = Number((v >> 4n) & 3n), d = Number((v >> 6n) & 3n);
  const fix = Number((v >> 32n) & 0xffn);
  return `(${CH[a]} - ${CH[b]}) * ${CC[c]}${c === 2 ? `[${fix}]` : ''} + ${CH[d]}`;
};

/** TEX0 bits 35-36: how the texel combines with the vertex colour. MODULATE is `C = (Ct * Cf) >> 7`. */
const TFX = ['MODULATE', 'DECAL', 'HIGHLIGHT', 'HIGHLIGHT2'];
const tfxOf = (v: bigint): string => TFX[Number((v >> 35n) & 3n)]!;
const tfxTally = new Map<string, number>();

const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
const toc = parseZdb(bytes);
const txr = Zar.parse(zdbMember(bytes, toc, `${archive}_TXR.ZED`));
const keys = (txr.find('textures')?.children ?? []) as ZarKey[];
console.log(`${archive}: ${keys.length} texture keys`);

const tally = new Map<string, number>();
for (const key of keys) {
  const name = key.name.toLowerCase();
  if (want && !name.includes(want)) continue;
  const texdat = txr.child(key, 'texdat');
  if (!texdat) continue;
  let data: Uint8Array;
  try { data = txr.data(texdat); } catch { continue; }
  const r = new Reader(data);
  if (r.length < 16) continue;
  const size = r.u32(4);
  const at = 16 + size;
  const regs: string[] = [];
  for (let o = at; o + 16 <= Math.min(at + 9 * 16, r.length); o += 16) {
    const value = r.u64(o);
    const id = Number(r.u64(o + 8) & 0xffn);
    const label = REG[id] ?? `0x${id.toString(16)}`;
    regs.push(label);
    if (id === 0x06 || id === 0x07) tfxTally.set(tfxOf(value), (tfxTally.get(tfxOf(value)) ?? 0) + 1);
    if (want) {
      console.log(`  ${label.padEnd(10)} = 0x${value.toString(16).padStart(16, '0')}`
        + (id === 0x42 || id === 0x43 ? `   ${alpha(value)}` : '')
        + (id === 0x06 || id === 0x07 ? `   TFX=${tfxOf(value)}` : ''));
    }
  }
  if (want) console.log(`  -- ${key.name}\n`);
  const sig = regs.join(',');
  tally.set(sig, (tally.get(sig) ?? 0) + 1);
}

console.log('\nTEX0 TFX, by how many textures:');
for (const [k, n] of [...tfxTally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

if (!want) {
  console.log('\nregister sets seen, by how many textures use them:');
  for (const [sig, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${sig}`);
}
