/**
 * The coordinate range of a map's LINE_STRIP points, against the range of its meshes.
 *
 *   npx tsx tools/dump-strips.ts MP5
 *
 * If the strips already span the map while the meshes of the same chunk sit near the origin, the strip
 * positions are world space and must NOT be put through the placement matrix a second time.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { interpretChainParts, modelNodes, walkModel } from '@s2u/mesh';

const archive = process.argv[2] ?? 'MP5';
const web = resolve(import.meta.dirname, '..');
const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
const toc = parseZdb(bytes);

const span = (p: Float32Array): string => {
  if (!p.length) return '(none)';
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p[i + k]!); hi[k] = Math.max(hi[k]!, p[i + k]!); }
  }
  return `[${lo.map((v) => v.toFixed(0)).join(',')}] .. [${hi.map((v) => v.toFixed(0)).join(',')}]`;
};

let strips = 0, points = 0;
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
const meshLo = [Infinity, Infinity, Infinity], meshHi = [-Infinity, -Infinity, -Infinity];

for (const member of ['WORL_MDL.ZED', `${archive}_MDL.ZED`, 'FLIB_MDL.ZED']) {
  let zar: Zar;
  try { zar = Zar.parse(zdbMember(bytes, toc, member)); } catch { continue; }
  for (const model of zar.root.children as ZarKey[]) {
    let chains;
    try { chains = walkModel(zar.data(model), modelNodes(zar, model)); } catch { continue; }
    for (const chain of chains) {
      let parts;
      try { parts = interpretChainParts(chain); } catch { continue; }
      for (const s of parts.lines) {
        strips++; points += s.positions.length / 3;
        for (let i = 0; i < s.positions.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, s.positions[i + k]!); hi[k] = Math.max(hi[k]!, s.positions[i + k]!);
          }
        }
        if (strips <= 3) console.log(`  strip in ${model.name}/${chain.nodeName}: ${s.positions.length / 3} pts ${span(s.positions)} texture=${s.textureName}`);
      }
      for (const m of parts.meshes) {
        for (let i = 0; i < m.positions.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            meshLo[k] = Math.min(meshLo[k]!, m.positions[i + k]!); meshHi[k] = Math.max(meshHi[k]!, m.positions[i + k]!);
          }
        }
      }
    }
  }
}

console.log(`\n${archive}: ${strips} strips, ${points} points`);
console.log(`  strip points span  [${lo.map((v) => v.toFixed(0)).join(',')}] .. [${hi.map((v) => v.toFixed(0)).join(',')}]`);
console.log(`  mesh  points span  [${meshLo.map((v) => v.toFixed(0)).join(',')}] .. [${meshHi.map((v) => v.toFixed(0)).join(',')}]`);
console.log('\nA strip range far wider than the mesh range means the strips are already placed.');
