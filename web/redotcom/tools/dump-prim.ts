/**
 * Do a packet's two GIFtag templates agree on the primitive? `isLineStripPacket` requires them to, so
 * a packet whose TOP+0 says LINE_STRIP and whose TOP+1 says something else takes the mesh path and
 * decodes vertex floats as a header -- which draws as enormous streaks.
 *
 *   npx tsx tools/dump-prim.ts MP5
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { modelNodes, packetPrimitive, unpackVif, walkModel } from '@s2u/mesh';

const archive = process.argv[2] ?? 'MP5';
const web = resolve(import.meta.dirname, '..');
const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
const toc = parseZdb(bytes);

const tally = new Map<string, number>();
let drawn = 0;
for (const member of ['WORL_MDL.ZED', `${archive}_MDL.ZED`, 'FLIB_MDL.ZED']) {
  let zar: Zar;
  try { zar = Zar.parse(zdbMember(bytes, toc, member)); } catch { continue; }
  for (const model of zar.root.children as ZarKey[]) {
    let chains;
    try { chains = walkModel(zar.data(model), modelNodes(zar, model)); } catch { continue; }
    for (const chain of chains) {
      let packets;
      try { packets = unpackVif(chain); } catch { continue; }
      for (const p of packets) {
        if (p.kind !== 'mscnt') continue;
        drawn++;
        const a = packetPrimitive(p, 0);
        const b = packetPrimitive(p, 1);
        const key = `TOP+0 ${a === null ? 'none' : a}   TOP+1 ${b === null ? 'none' : b}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
  }
}

console.log(`${archive}: ${drawn} drawn packets`);
console.log('prim type in each template, by how many packets (2 = LINE_STRIP):');
for (const [k, n] of [...tally].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
const disagree = [...tally].filter(([k]) => {
  const m = k.match(/TOP\+0 (\S+)\s+TOP\+1 (\S+)/);
  return m && m[1] !== m[2] && (m[1] === '2' || m[2] === '2');
});
if (disagree.length) {
  console.log('\n!! packets where exactly one template says LINE_STRIP -- these change path with the strict rule:');
  for (const [k, n] of disagree) console.log(`  ${String(n).padStart(5)}  ${k}`);
} else {
  console.log('\nno packet has the two templates disagreeing about LINE_STRIP.');
}
