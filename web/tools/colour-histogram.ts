/**
 * What brightness did the artists actually write? Dumps the vertex-colour distribution of a map's
 * worldmodel as the disc holds it. 128 is unity on every lane (TEX0.TFX is MODULATE on all 241
 * textures, and MODULATE is `(Ct * Cf) >> 7`), so a raw byte of 128 leaves the texel unchanged.
 *
 *   npx tsx tools/colour-histogram.ts [MP2 MP6 MP72 ...]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { interpretChain, modelNodes, walkModel } from '@s2u/mesh';

const MAPS = process.argv.slice(2).length ? process.argv.slice(2) : ['MP2', 'MP6', 'MP72'];
const web = resolve(import.meta.dirname, '..');
const LABELS = ['0-31', '32-63', '64-95', '96-127', '128-159', '160-191', '192-223', '224-255'];

for (const archive of MAPS) {
  let parts;
  try {
    const zdb = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
    const toc = parseZdb(zdb);
    const worl = Zar.parse(zdbMember(zdb, toc, 'WORL_MDL.ZED'));
    const world = worl.find('worldmodel');
    if (!world) { console.log(`${archive}: no 'worldmodel' key`); continue; }
    parts = walkModel(worl.data(world), modelNodes(worl, world)).flatMap(interpretChain);
  } catch (e) {
    console.log(`${archive}: ${(e as Error).message}`);
    continue;
  }

  const bins = new Array<number>(LABELS.length).fill(0);
  let n = 0, sum = 0, over = 0, max = 0;
  for (const part of parts) {
    const c = part.colors;
    for (let i = 0; i < c.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const raw = c[i + k]! * 128;                       // back to the byte the disc holds
        n++; sum += raw;
        if (raw > 128) over++;
        if (raw > max) max = raw;
        bins[Math.min(LABELS.length - 1, Math.floor(raw / 32))]! += 1;
      }
    }
  }
  if (!n) { console.log(`${archive}: no vertices`); continue; }
  console.log(`\n=== ${archive} === ${n} rgb lanes over ${parts.length} parts`);
  console.log(`mean ${(sum / n).toFixed(1)}/128 = ${(sum / n / 128).toFixed(2)}x unity   `
    + `max ${max.toFixed(0)} (${(max / 128).toFixed(2)}x)   above unity: ${(over / n * 100).toFixed(1)}%`);
  for (let b = 0; b < bins.length; b++) {
    const pct = bins[b]! / n * 100;
    if (pct < 0.05) continue;
    console.log(`  ${LABELS[b]!.padStart(8)}  ${pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pct / 2))}`);
  }
}
