/**
 * The alpha distribution of a map's textures. A glow is a *ramp* -- most of its pixels sit between
 * transparent and opaque. A cutout is a *switch* -- almost every pixel is one end or the other, and the
 * handful in between are antialiased edges. Telling those apart is what decides whether a draw has to
 * be blended (and so sorted) or can be punched through (and so not).
 *
 *   npx tsx tools/dump-alpha.ts MP72 tent
 *   npx tsx tools/dump-alpha.ts MP2            # every texture, sorted by how graded it is
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { decodeTexture, parseTextureRecord, PaletteTable } from '@s2u/gs';

const archive = process.argv[2] ?? 'MP72';
const want = (process.argv[3] ?? '').toLowerCase();
const web = resolve(import.meta.dirname, '..');
const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
const toc = parseZdb(bytes);
const txr = Zar.parse(zdbMember(bytes, toc, `${archive}_TXR.ZED`));
const palettes = PaletteTable.fromZars([Zar.parse(zdbMember(bytes, toc, `${archive}_PAL.ZED`))]);

const rows: { name: string; n: number; clear: number; mid: number; opaque: number }[] = [];
for (const key of (txr.find('textures')?.children ?? []) as ZarKey[]) {
  if (want && !key.name.toLowerCase().includes(want)) continue;
  const texdat = txr.child(key, 'texdat');
  if (!texdat) continue;
  let rgba;
  try { rgba = decodeTexture(parseTextureRecord(key.name, txr.data(texdat)), palettes).rgba; } catch { continue; }
  const a = rgba.data;
  let clear = 0, mid = 0, opaque = 0;
  for (let i = 3; i < a.length; i += 4) {
    const v = a[i]!;
    if (v <= 8) clear++;
    else if (v >= 247) opaque++;
    else mid++;
  }
  const n = a.length / 4;
  rows.push({ name: key.name, n, clear, mid, opaque });
}

rows.sort((x, y) => y.mid / y.n - x.mid / x.n);
console.log(`${archive}: ${rows.length} textures, most graded first`);
console.log('  mid%   clear%  opaque%  pixels   texture');
for (const r of rows) {
  const pc = (v: number): string => (v / r.n * 100).toFixed(1).padStart(6);
  console.log(`${pc(r.mid)} ${pc(r.clear)} ${pc(r.opaque)}  ${String(r.n).padStart(7)}   ${r.name}`);
}
