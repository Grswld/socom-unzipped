/**
 * Which packets clear `FGE` -- the fog-enable bit of the GIFtag `PRIM` template -- and what they draw.
 *
 * SEMANTICS §11.4 left it open whether the 33 Frostfire packets that clear `FGE` on the family-B template
 * (water, sky, a ceiling, two monitors) are a deliberate per-surface "no fog" flag or exporter noise. This
 * answers it over every map: for each archive, the textures whose packets clear the bit in `TOP+0`, in
 * `TOP+1`, or in both, with packet counts.
 *
 *   npx tsx tools/dump-fge.ts            # all 22 maps
 *   npx tsx tools/dump-fge.ts MP2        # one
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { modelNodes, unpackVif, walkModel } from '@s2u/mesh';

const only = process.argv[2];
const web = resolve(import.meta.dirname, '..');
const dir = resolve(web, 'public/maps/RUN');
const archives = only ? [only] : readdirSync(dir).filter((f) => /\.ZDB$/i.test(f)).map((f) => f.replace(/\.ZDB$/i, ''))
  .sort((a, b) => (Number(a.replace(/\D/g, '')) || 0) - (Number(b.replace(/\D/g, '')) || 0));

/** GIFtag bits 47-57 land in lane y bits 15-25; inside PRIM, FGE is bit 5 and ABE bit 6. */
const PRIM_SHIFT = 15, PRIM_MASK = 0x7ff, FGE = 1 << 5, ABE = 1 << 6;
const prim = (mem: Int32Array, qw: number): number => (mem[qw * 4 + 1]! >>> PRIM_SHIFT) & PRIM_MASK;

for (const archive of archives) {
  const bytes = readFileSync(resolve(dir, `${archive}.ZDB`));
  const toc = parseZdb(bytes);
  const members = toc.map((e) => e.name).filter((n) => /_MDL\.ZED$/i.test(n) && !/CLIB_MDL/i.test(n));
  /** texture -> [packets with FGE clear in TOP+0, in TOP+1, total packets, ABE clear anywhere] */
  const byTexture = new Map<string, { fge0: number; fge1: number; total: number; abe0: number }>();
  let packets = 0;
  for (const member of members) {
    let zar: Zar;
    try { zar = Zar.parse(zdbMember(bytes, toc, member)); } catch { continue; }
    for (const model of zar.root.children as ZarKey[]) {
      let chains;
      try { chains = walkModel(zar.data(model), modelNodes(zar, model)); } catch { continue; }
      for (const chain of chains) {
        let ps;
        try { ps = unpackVif(chain); } catch { continue; }
        for (const p of ps) {
          if (p.kind !== 'mscnt' || p.written[0] !== 1 || p.written[1] !== 1) continue;
          packets++;
          const name = (p.textureName ?? '(none)').toLowerCase();
          const t = byTexture.get(name) ?? { fge0: 0, fge1: 0, total: 0, abe0: 0 };
          t.total++;
          const p0 = prim(p.mem, 0), p1 = prim(p.mem, 1);
          if (!(p0 & FGE)) t.fge0++;
          if (!(p1 & FGE)) t.fge1++;
          if (!(p0 & ABE) || !(p1 & ABE)) t.abe0++;
          byTexture.set(name, t);
        }
      }
    }
  }
  const unfogged = [...byTexture.entries()].filter(([, t]) => t.fge0 > 0 || t.fge1 > 0 || t.abe0 > 0);
  console.log(`${archive}: ${packets} drawn packets, ${byTexture.size} textures, ${unfogged.length} with FGE or ABE clear somewhere`);
  for (const [name, t] of unfogged.sort((a, b) => b[1].total - a[1].total)) {
    console.log(`   ${name.padEnd(30)} TOP+0 FGE clear ${String(t.fge0).padStart(3)}/${String(t.total).padEnd(3)}  TOP+1 FGE clear ${String(t.fge1).padStart(3)}  ABE clear ${t.abe0}`);
  }
}
