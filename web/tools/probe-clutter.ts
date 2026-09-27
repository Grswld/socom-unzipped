/**
 * The raw clutter instance matrices, before anything is composed on top of them.
 *
 *   npx tsx tools/probe-clutter.ts MP5 MP6
 *
 * MP6's clutter places correctly and MP5's draws streaks radiating from the origin, so the two side by
 * side say whether `CLUTTER.ZAR` is being read wrongly or composed wrongly.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { parseClutter, type ClutterInstance } from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');

const rows = (m: Float32Array): string[] => [0, 1, 2, 3].map(
  (r) => [0, 1, 2, 3].map((c) => m[r * 4 + c]!.toFixed(3).padStart(10)).join(' '));

for (const archive of process.argv.slice(2).length ? process.argv.slice(2) : ['MP5', 'MP6']) {
  let instances: ClutterInstance[];
  try {
    const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
    instances = parseClutter(Zar.parse(zdbMember(bytes, parseZdb(bytes), 'CLUTTER.ZAR')));
  } catch (e) { console.log(`${archive}: ${(e as Error).message}`); continue; }

  const byModel = new Map<string, ClutterInstance[]>();
  for (const i of instances) {
    const list = byModel.get(i.modelName);
    if (list) list.push(i); else byModel.set(i.modelName, [i]);
  }
  console.log(`\n=== ${archive} === ${instances.length} instances over ${byModel.size} models`);

  // A row-major row-vector matrix has its translation in row 3 and unit-ish basis rows.
  let zeroT = 0, wild = 0;
  for (const i of instances) {
    const m = i.matrix;
    const t = Math.hypot(m[12]!, m[13]!, m[14]!);
    const s = [0, 1, 2].map((r) => Math.hypot(m[r * 4]!, m[r * 4 + 1]!, m[r * 4 + 2]!));
    if (t === 0) zeroT++;
    if (Math.max(...s) > 50 || Math.min(...s) < 1e-6) wild++;
  }
  console.log(`  ${zeroT} with zero translation, ${wild} with a basis row longer than 50 or shorter than 1e-6`);

  for (const [name, list] of [...byModel].slice(0, 3)) {
    console.log(`  --- ${name} (${list.length} instances), first one, scale_inverse ${list[0]!.scaleInverse} ---`);
    for (const r of rows(list[0]!.matrix)) console.log(`      ${r}`);
    console.log(`      m[15] (should be 1 for an affine row-vector matrix): ${list[0]!.matrix[15]}`);
  }
}
