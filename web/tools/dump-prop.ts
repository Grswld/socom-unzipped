/**
 * What shape is a prop, really? Dumps a model-node's geometry and works out how many distinct planes
 * its triangles lie in -- the question "is this flare a flat quad, a cross of two, or a solid?".
 *
 *   npx tsx tools/dump-prop.ts MP2 light
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { interpretChainParts, modelNodes, walkModel } from '@s2u/mesh';

const archive = process.argv[2] ?? 'MP2';
const want = (process.argv[3] ?? '').toLowerCase();
const web = resolve(import.meta.dirname, '..');
const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
const toc = parseZdb(bytes);

/** The unit normal of a triangle, and its distance from the origin: a plane, rounded so near-equal merge. */
function planeOf(p: Float32Array, a: number, b: number, c: number): string {
  const v = (i: number): [number, number, number] => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
  const [ax, ay, az] = v(a), [bx, by, bz] = v(b), [cx, cy, cz] = v(c);
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const wx = cx - ax, wy = cy - ay, wz = cz - az;
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return 'degenerate';
  nx /= len; ny /= len; nz /= len;
  // Fold the sign away: a plane and its back are the same plane.
  if (nx < 0 || (nx === 0 && (ny < 0 || (ny === 0 && nz < 0)))) { nx = -nx; ny = -ny; nz = -nz; }
  const d = nx * ax + ny * ay + nz * az;
  const r = (x: number): string => (Math.round(x * 50) / 50).toFixed(2);
  return `${r(nx)},${r(ny)},${r(nz)} @ ${Math.round(d)}`;
}

for (const member of ['WORL_MDL.ZED', `${archive}_MDL.ZED`, 'FLIB_MDL.ZED']) {
  let zar: Zar;
  try { zar = Zar.parse(zdbMember(bytes, toc, member)); } catch { continue; }
  for (const model of zar.root.children as ZarKey[]) {
    if (!model?.name || !model.name.toLowerCase().includes(want)) continue;
    let nodes;
    try { nodes = modelNodes(zar, model); } catch { continue; }
    let chains;
    try { chains = walkModel(zar.data(model), nodes); } catch (e) { console.log(`${model.name}: ${(e as Error).message}`); continue; }
    for (const chain of chains) {
      const { meshes, lines } = interpretChainParts(chain);
      for (const m of meshes) {
        const tris = m.indices.length / 3;
        const planes = new Map<string, number>();
        for (let t = 0; t < tris; t++) {
          const k = planeOf(m.positions, m.indices[t * 3]!, m.indices[t * 3 + 1]!, m.indices[t * 3 + 2]!);
          planes.set(k, (planes.get(k) ?? 0) + 1);
        }
        console.log(`\n${member} / ${model.name} / ${chain.nodeName}  texture=${m.textureName}`);
        console.log(`  ${m.positions.length / 3} verts, ${tris} triangles, ${planes.size} distinct plane(s)`);
        for (const [k, n] of [...planes].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)} tri  plane ${k}`);
      }
      if (lines.length) console.log(`  (+ ${lines.length} line strip(s))`);
    }
  }
}
