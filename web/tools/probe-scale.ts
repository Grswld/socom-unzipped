/**
 * Does a map's packets agree with the ITOF4 position convention the decoder assumes?
 *
 *   npx tsx tools/probe-scale.ts MP5 MP2
 *
 * SEMANTICS section 9 records a "fourth family" whose packets convert positions with ITOF15 and
 * multiply by TOP+3.w instead of dividing by 16. A packet of that kind read as ITOF4 decodes 2048x
 * too large, which draws as enormous streaks and raises no diagnostic, because nothing about it is
 * out of range -- only wrong. This prints, per map, TOP+3's lanes and the spread of the decoded
 * positions, so the two conventions can be told apart by their numbers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { interpretChainParts, modelNodes, unpackVif, walkModel } from '@s2u/mesh';

const web = resolve(import.meta.dirname, '..');
const maps = process.argv.slice(2).length ? process.argv.slice(2) : ['MP5', 'MP2'];

for (const archive of maps) {
  const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
  const toc = parseZdb(bytes);
  let packets = 0, huge = 0;
  let lo = Infinity, hi = -Infinity;
  const biasW = new Map<string, number>();
  const worst: { chunk: string; span: number }[] = [];

  for (const member of ['WORL_MDL.ZED', `${archive}_MDL.ZED`, 'FLIB_MDL.ZED']) {
    let zar: Zar;
    try { zar = Zar.parse(zdbMember(bytes, toc, member)); } catch { continue; }
    for (const model of zar.root.children as ZarKey[]) {
      let chains;
      try { chains = walkModel(zar.data(model), modelNodes(zar, model)); } catch { continue; }
      for (const chain of chains) {
        // TOP+3 straight off the unpacked packet, before any interpretation.
        try {
          for (const p of unpackVif(chain)) {
            if (p.kind !== 'mscnt' || p.written[3] !== 1) continue;
            const w = p.f32[3 * 4 + 3]!;
            const k = Number.isFinite(w) ? w.toFixed(6) : String(w);
            biasW.set(k, (biasW.get(k) ?? 0) + 1);
          }
        } catch { /* a chunk that will not unpack is someone else's problem */ }

        let parts;
        try { parts = interpretChainParts(chain); } catch { continue; }
        for (const m of parts.meshes) {
          packets++;
          let a = Infinity, b = -Infinity;
          for (let i = 0; i < m.positions.length; i++) {
            const v = m.positions[i]!;
            if (v < a) a = v;
            if (v > b) b = v;
          }
          lo = Math.min(lo, a); hi = Math.max(hi, b);
          const span = b - a;
          if (span > 20000) { huge++; worst.push({ chunk: `${model.name}/${chain.nodeName}`, span }); }
        }
      }
    }
  }

  console.log(`\n=== ${archive} === ${packets} drawn mesh packets`);
  console.log(`  decoded position range: ${lo.toFixed(0)} .. ${hi.toFixed(0)}`);
  console.log(`  packets spanning more than 20,000 units: ${huge}`);
  console.log('  TOP+3 lane w, by how many packets:');
  for (const [k, n] of [...biasW].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
    console.log(`    ${String(n).padStart(5)}  ${k}`);
  }
  for (const w of worst.slice(0, 5)) console.log(`    !! ${w.chunk} spans ${w.span.toFixed(0)}`);
}
