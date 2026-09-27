/**
 * Every map's fog, straight off the disc. Verifies the `cameras/camera` parser against all 22
 * multiplayer archives at once.
 *
 *   npx tsx tools/dump-fog.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { parseCameraParams } from '@s2u/scene';

const dir = resolve(import.meta.dirname, '..', 'public/maps/RUN');
const archives = readdirSync(dir).filter((f) => f.toUpperCase().endsWith('.ZDB'))
  .sort((a, b) => (Number(a.replace(/\D/g, '')) || 0) - (Number(b.replace(/\D/g, '')) || 0));

console.log('archive   fogRGB            near    far   fogEn alt dir   top     bottom');
for (const file of archives) {
  const stem = file.replace(/\.ZDB$/i, '');
  try {
    const bytes = readFileSync(resolve(dir, file));
    const zed = Zar.parse(zdbMember(bytes, parseZdb(bytes), `${stem}.ZED`));
    const c = parseCameraParams(zed);
    if (!c) { console.log(`${stem.padEnd(9)} no cameras/camera key`); continue; }
    console.log(
      `${stem.padEnd(9)} ${c.fogColor.join(',').padEnd(13)} ${String(c.fogNear).padStart(6)} `
      + `${String(c.fogFar).padStart(6)}   ${c.fogEnabled ? 1 : 0}    ${c.fogAltitude ? 1 : 0}   `
      + `${c.fogDirectional ? 1 : 0}  ${String(c.fogTop).padStart(7)} ${String(c.fogBottom).padStart(7)}`,
    );
  } catch (e) {
    console.log(`${stem.padEnd(9)} ${(e as Error).message}`);
  }
}
