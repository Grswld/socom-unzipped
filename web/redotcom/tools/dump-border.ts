/**
 * Does a texture's alpha reach zero at its border? A glow whose edge pixels are not clear draws a
 * visible square; so does a clear-edged one sampled with `RepeatWrapping`, because bilinear filtering
 * at u = 0 blends with u = 1.
 *
 *   npx tsx tools/dump-border.ts MP2 lightrays
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { decodeTexture, parseTextureRecord, PaletteTable } from '@s2u/gs';

const archive = process.argv[2] ?? 'MP2';
const want = (process.argv[3] ?? '').toLowerCase();
const web = resolve(import.meta.dirname, '..');
const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
const toc = parseZdb(bytes);
const txr = Zar.parse(zdbMember(bytes, toc, `${archive}_TXR.ZED`));
const palettes = PaletteTable.fromZars([Zar.parse(zdbMember(bytes, toc, `${archive}_PAL.ZED`))]);

for (const key of (txr.find('textures')?.children ?? []) as ZarKey[]) {
  if (want && !key.name.toLowerCase().includes(want)) continue;
  const texdat = txr.child(key, 'texdat');
  if (!texdat) continue;
  let rgba;
  try { rgba = decodeTexture(parseTextureRecord(key.name, txr.data(texdat)), palettes).rgba; } catch { continue; }
  const { width: w, height: h, data: d } = rgba;
  const alphaAt = (x: number, y: number): number => d[(y * w + x) * 4 + 3]!;
  const rgbAt = (x: number, y: number): string =>
    `${d[(y * w + x) * 4]!},${d[(y * w + x) * 4 + 1]!},${d[(y * w + x) * 4 + 2]!}`;

  let maxEdge = 0, sumEdge = 0, n = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) { const a = alphaAt(x, y); maxEdge = Math.max(maxEdge, a); sumEdge += a; n++; }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) { const a = alphaAt(x, y); maxEdge = Math.max(maxEdge, a); sumEdge += a; n++; }
  }
  const centre = alphaAt(w >> 1, h >> 1);
  console.log(`${key.name}  ${w}x${h}`);
  console.log(`  border alpha: max ${maxEdge}, mean ${(sumEdge / n).toFixed(1)}   centre alpha ${centre}`);
  console.log(`  corners: ${[[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => `a=${alphaAt(x!, y!)} rgb=${rgbAt(x!, y!)}`).join('  ')}`);
  // The alpha channel as a picture: '.' clear, digits rising to '#' opaque.
  const ramp = ' .:-=+*#';
  for (let y = 0; y < h; y += Math.max(1, Math.round(h / 32))) {
    let row = '  ';
    for (let x = 0; x < w; x += Math.max(1, Math.round(w / 64))) {
      row += ramp[Math.min(ramp.length - 1, Math.floor(alphaAt(x, y) / 32))];
    }
    console.log(row);
  }
  if (maxEdge > 8) console.log('  !! the border is not clear: this draws a visible square');
  else console.log('  border is clear; a visible square would come from wrapping or from the alpha test');
}
