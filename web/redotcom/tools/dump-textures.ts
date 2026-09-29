import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import {
  decodeTexture, parseTextureRecord, PaletteTable,
  DEFAULT_CLUT_ORDER, DEFAULT_PIXEL_ORDER, type ClutOrder, type PixelOrder, type Rgba,
} from '@s2u/gs';
import { encodePng } from './png';

/**
 * Decodes every texture of one map archive to PNG, both pixel orders and both CLUT orders, plus one
 * contact sheet per combination -- the evidence M2 settles the swizzle question by looking at.
 * Usage: npm run dump-textures [RUN/MP2.ZDB] [--write-goldens]
 */
const web = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const writeGoldens = args.includes('--write-goldens');
const archive = args.find((a) => !a.startsWith('--')) ?? 'RUN/MP2.ZDB';
const stem = basename(archive, '.ZDB');            // MP2, MP6, ... -- the prefix its members are named with

const zdbPath = join(web, 'test-fixtures', archive);
if (!existsSync(zdbPath)) { console.error(`no ${archive} at ${zdbPath} (run npm run extract-maps)`); process.exit(2); }
const zdb = new Uint8Array(readFileSync(zdbPath));
const toc = parseZdb(zdb);
const txr = Zar.parse(zdbMember(zdb, toc, `${stem}_TXR.ZED`));
const palettes = PaletteTable.fromZars([Zar.parse(zdbMember(zdb, toc, `${stem}_PAL.ZED`))]);
const keys = txr.find('textures')?.children ?? [];
const records = keys.map((k: ZarKey) => parseTextureRecord(k.name, txr.data(txr.child(k, 'texdat')!)));

const CELL = 256, GAP = 4, PITCH = CELL + GAP;
const out = join(web, 'test-fixtures/textures', stem);

/** One cell per texture, native size in the cell's top-left, on mid-grey. Alpha is ignored here: the
 *  question the sheets answer is about the colour bytes, and a keyed texture would otherwise vanish. */
function contactSheet(images: Rgba[]): Rgba {
  const cols = Math.ceil(Math.sqrt(images.length)), rows = Math.ceil(images.length / cols);
  const width = cols * PITCH - GAP, height = rows * PITCH - GAP;
  const data = new Uint8ClampedArray(width * height * 4).fill(64);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  images.forEach((img, i) => {
    const ox = (i % cols) * PITCH, oy = Math.floor(i / cols) * PITCH;
    for (let y = 0; y < Math.min(img.height, CELL); y++) {
      for (let x = 0; x < Math.min(img.width, CELL); x++) {
        const s = (y * img.width + x) * 4, d = ((oy + y) * width + ox + x) * 4;
        data[d] = img.data[s]!; data[d + 1] = img.data[s + 1]!; data[d + 2] = img.data[s + 2]!; data[d + 3] = 255;
      }
    }
  });
  return { width, height, data };
}

const label = (order: PixelOrder, clut: ClutOrder): string => (clut === 'linear' ? `${order}-linear-clut` : order);
const diagnostics: string[] = [];

for (const order of ['raster', 'swizzled'] as const) {
  for (const clut of ['csm1', 'linear'] as const) {
    const dir = join(out, label(order, clut));
    mkdirSync(dir, { recursive: true });
    const images = records.map((rec) => {
      const d = decodeTexture(rec, palettes, order, clut);
      diagnostics.push(...d.diagnostics);
      writeFileSync(join(dir, `${rec.name.replace(/\.tif$/, '').replace(/[\\/]|\.\./g, '_')}.png`), encodePng(d.rgba.width, d.rgba.height, d.rgba.data));
      return d.rgba;
    });
    const sheet = contactSheet(images);
    writeFileSync(join(out, `sheet-${label(order, clut)}.png`), encodePng(sheet.width, sheet.height, sheet.data));
  }
}

const cols = Math.ceil(Math.sqrt(records.length));
console.log(`${records.length} textures, ${palettes.size} palettes -> ${out}`);
console.log(`contact sheets ${cols} cells across, row-major:`);
records.forEach((r, i) => {
  process.stdout.write(`${String(i).padStart(3)} ${r.name.padEnd(24)} ${r.width}x${r.height} ${r.bpp}bpp${i % cols === cols - 1 ? '\n' : '  |  '}`);
});
process.stdout.write('\n');
for (const d of new Set(diagnostics)) console.log(`diagnostic: ${d}`);

if (writeGoldens) {
  const goldens: Record<string, string> = {};
  for (const rec of records) {
    const d = decodeTexture(rec, palettes, DEFAULT_PIXEL_ORDER, DEFAULT_CLUT_ORDER);
    goldens[rec.name] = createHash('sha256').update(d.rgba.data).digest('hex').slice(0, 16);
  }
  const map = stem === 'MP2' ? 'frostfire' : stem.toLowerCase();   // 36 §0 names MP2 Frostfire
  const file = join(web, 'packages/gs/test/goldens', `${map}-textures.json`);
  writeFileSync(file, `${JSON.stringify(goldens, null, 2)}\n`);
  console.log(`froze ${records.length} goldens (${DEFAULT_PIXEL_ORDER}, ${DEFAULT_CLUT_ORDER} CLUT) -> ${file}`);
}
