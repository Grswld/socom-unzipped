/**
 * Are the first texels of a direct (non-palettised) texture actually texels?
 *
 *   npx tsx tools/probe-head.ts MP2
 *
 * Prints the first four texels of row 0 for every 16/32bpp texture in a map, beside the texture's
 * modal colour. If every such texture has the same four odd texels, the pixel block starts later than
 * the decoder thinks; if only some do, it is what the artist drew.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { parseTextureRecord } from '@s2u/gs';

const archives = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(resolve(import.meta.dirname, '..', 'public/maps/RUN'))
    .filter((f) => f.toUpperCase().endsWith('.ZDB')).map((f) => f.replace(/\.ZDB$/i, ''));
const web = resolve(import.meta.dirname, '..');

let direct = 0, odd = 0;
for (const archive of archives) {
  let txr: Zar;
  try {
    const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
    txr = Zar.parse(zdbMember(bytes, parseZdb(bytes), `${archive}_TXR.ZED`));
  } catch { continue; }
  for (const key of (txr.find('textures')?.children ?? []) as ZarKey[]) {
    const texdat = txr.child(key, 'texdat');
    if (!texdat) continue;
    let rec;
    try { rec = parseTextureRecord(key.name, txr.data(texdat)); } catch { continue; }
    if (rec.bpp !== 32) continue;
    direct++;
    const t = (x: number): string => {
      const o = x * 4;
      return `${rec.pixels[o]},${rec.pixels[o + 1]},${rec.pixels[o + 2]},${rec.pixels[o + 3]}`;
    };
    // The texture's own colour, taken from the middle of the image.
    const mid = ((rec.height >> 1) * rec.width + (rec.width >> 1)) * 4;
    const body = `${rec.pixels[mid]},${rec.pixels[mid + 1]},${rec.pixels[mid + 2]}`;
    // "Odd" = any of the first four texels has all four channels equal and non-zero, the shape
    // 175,175,175,175 has, which no glow pixel does.
    const flat = (x: number): boolean => {
      const o = x * 4;
      const v = rec.pixels[o]!;
      return v !== 0 && rec.pixels[o + 1] === v && rec.pixels[o + 2] === v && rec.pixels[o + 3] === v;
    };
    const isOdd = [0, 1, 2, 3].some(flat);
    if (isOdd) odd++;
    console.log(`${isOdd ? '!!' : '  '} ${archive.padEnd(5)} ${key.name.padEnd(28)} ${rec.width}x${rec.height}`
      + `  body ${body.padEnd(13)}  row0: ${[0, 1, 2, 3].map(t).join('  |  ')}`);
  }
}
console.log(`\n${direct} direct 32bpp textures, ${odd} with a flat all-channels-equal texel in the first four.`);
