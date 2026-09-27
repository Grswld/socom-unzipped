/**
 * Is a glow texture's odd alpha the artwork, or the CLUT swap?
 *
 *   npx tsx tools/probe-clut.ts MP2 lightrays
 *
 * Prints, for one texture: the raw palette indices of the pixels in question, the palette entry each
 * index resolves to under `csm1` and under `linear`, and where the low-alpha entries sit in the
 * palette. If an opaque entry lands exactly where the swap would have moved a transparent one, the
 * decode is at fault; if the same entries are opaque either way, it is the artwork.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { csm1ClutIndex, decodeTexture, parseTextureRecord, PaletteTable } from '@s2u/gs';

const archive = process.argv[2] ?? 'MP2';
const want = (process.argv[3] ?? 'lightrays').toLowerCase();
const web = resolve(import.meta.dirname, '..');
const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
const toc = parseZdb(bytes);
const txr = Zar.parse(zdbMember(bytes, toc, `${archive}_TXR.ZED`));
const palettes = PaletteTable.fromZars([Zar.parse(zdbMember(bytes, toc, `${archive}_PAL.ZED`))]);

for (const key of (txr.find('textures')?.children ?? []) as ZarKey[]) {
  if (!key.name.toLowerCase().includes(want)) continue;
  const texdat = txr.child(key, 'texdat');
  if (!texdat) continue;
  const rec = parseTextureRecord(key.name, txr.data(texdat));
  const palette = palettes.get(rec.tex0?.cbp ?? 0) ?? palettes.first;
  console.log(`\n=== ${rec.name}  ${rec.width}x${rec.height}  ${rec.bpp}bpp  palOffset=${rec.palOffset} ===`);
  if (!palette) { console.log('  no palette'); continue; }
  console.log(`  palette format ${palette.format === 0 ? 'PSMCT32 (1024 B)' : 'PSMCT16 (512 B)'}`);

  // The raw 8-bit indices, straight out of the record's pixel bytes (DEFAULT_PIXEL_ORDER is raster).
  const px = rec.pixels;
  const idxAt = (x: number, y: number): number => px[y * rec.width + x]!;

  const entry = (i: number, order: 'csm1' | 'linear'): string => {
    const j = order === 'csm1' ? csm1ClutIndex(i) : i;
    const p = palette.rgba;
    return `#${j.toString().padStart(3)} rgba(${p[j * 4]},${p[j * 4 + 1]},${p[j * 4 + 2]},${p[j * 4 + 3]})`;
  };

  if (rec.bpp === 32) {
    // No CLUT on this path at all: PSMCT32 is direct RGBA, with PS2 alpha 0..0x80 rescaled on the way
    // out. So the suspect pixels are raw bytes, and the question is whether the first row is pixels.
    console.log('  DIRECT PSMCT32 -- no palette involved. First 12 texels of row 0, raw bytes:');
    for (let x = 0; x < 12; x++) {
      const o = x * 4;
      console.log(`    (${x},0) rgba raw ${rec.pixels[o]},${rec.pixels[o + 1]},${rec.pixels[o + 2]},${rec.pixels[o + 3]}`
        + `   -> alpha ${Math.round(Math.min((rec.pixels[o + 3] ?? 0) / 128, 1) * 255)}`);
    }
    const last = (rec.height - 1) * rec.width * 4;
    console.log('  and the first 4 texels of the LAST row, for comparison:');
    for (let x = 0; x < 4; x++) {
      const o = last + x * 4;
      console.log(`    (${x},${rec.height - 1}) rgba raw ${rec.pixels[o]},${rec.pixels[o + 1]},${rec.pixels[o + 2]},${rec.pixels[o + 3]}`);
    }
    console.log(`  record: size=${rec.size}  w*h*4=${rec.width * rec.height * 4}  pixels.length=${rec.pixels.length}`);
    // If the 16 bytes at the front are a prefix, the real image runs 16 bytes past `size` -- so the
    // bytes immediately after the slice decide it: image-coloured means `size` undercounts.
    const raw = txr.data(texdat);
    console.log('  the 8 texels straddling the end of the slice (record offset 16+size onward):');
    for (let k = 0; k < 8; k++) {
      const o = 16 + rec.size - 16 + k * 4;
      console.log(`    +${(o - 16).toString().padStart(5)}  ${raw[o]},${raw[o + 1]},${raw[o + 2]},${raw[o + 3]}`);
    }
    continue;
  }
  console.log('  the suspect pixels and their neighbours on row 0:');
  for (let x = 0; x < 8; x++) {
    const i = idxAt(x, 0);
    console.log(`    (${x},0) index ${String(i).padStart(3)}   csm1 -> ${entry(i, 'csm1')}   linear -> ${entry(i, 'linear')}`);
  }

  // Where the transparent and the opaque entries live in the palette, both ways.
  for (const order of ['csm1', 'linear'] as const) {
    const clear: number[] = [], opaque: number[] = [], low: number[] = [];
    for (let i = 0; i < 256; i++) {
      const j = order === 'csm1' ? csm1ClutIndex(i) : i;
      const a = palette.rgba[j * 4 + 3]!;
      if (a <= 8) clear.push(i); else if (a >= 247) opaque.push(i); else if (a <= 31) low.push(i);
    }
    console.log(`  ${order}: ${clear.length} clear, ${low.length} alpha 1..31, ${opaque.length} opaque`);
    console.log(`    opaque at indices: ${opaque.slice(0, 16).join(',')}${opaque.length > 16 ? ' ...' : ''}`);
    console.log(`    alpha 1..31 at   : ${low.slice(0, 16).join(',')}${low.length > 16 ? ' ...' : ''}`);
  }

  // And the alpha picture both ways, to see whether the plateau moves.
  for (const clut of ['csm1', 'linear'] as const) {
    const { rgba } = decodeTexture(rec, palettes, 'raster', clut);
    const ramp = ' .:-=+*#';
    console.log(`  --- alpha with clut=${clut} ---`);
    for (let y = 0; y < rgba.height; y += Math.max(1, Math.round(rgba.height / 24))) {
      let row = '    ';
      for (let x = 0; x < rgba.width; x += Math.max(1, Math.round(rgba.width / 48))) {
        row += ramp[Math.min(7, Math.floor(rgba.data[(y * rgba.width + x) * 4 + 3]! / 32))];
      }
      console.log(row);
    }
  }
}
