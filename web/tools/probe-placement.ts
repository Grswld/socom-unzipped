/**
 * Are a map's placement matrices sane? Streaks radiating from a point are what a degenerate or
 * enormous matrix draws: the geometry is fine, the transform is not.
 *
 *   npx tsx tools/probe-placement.ts MP5 MP2
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { parseClutter, parseSceneGraph, placeClutter, placeInstances, type PlacedModel } from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');

/** The 3x3 scale a matrix applies, as the length of each basis row, plus its translation. */
function shape(m: Float32Array): { sx: number; sy: number; sz: number; tx: number; ty: number; tz: number } {
  return {
    sx: Math.hypot(m[0]!, m[1]!, m[2]!),
    sy: Math.hypot(m[4]!, m[5]!, m[6]!),
    sz: Math.hypot(m[8]!, m[9]!, m[10]!),
    tx: m[12]!, ty: m[13]!, tz: m[14]!,
  };
}

for (const archive of process.argv.slice(2).length ? process.argv.slice(2) : ['MP5', 'MP2']) {
  const bytes = readFileSync(resolve(web, 'public/maps/RUN', `${archive}.ZDB`));
  const toc = parseZdb(bytes);
  let placed: PlacedModel[] = [];
  let clutter: PlacedModel[] = [];
  try {
    const geo = Zar.parse(zdbMember(bytes, toc, `${archive}_GEO.ZED`));
    const models = parseSceneGraph(geo);
    placed = placeInstances(models, 'worldmodel');
    try {
      clutter = placeClutter(models, parseClutter(Zar.parse(zdbMember(bytes, toc, 'CLUTTER.ZAR')))).placed;
    } catch (e) { console.log(`${archive}: clutter: ${(e as Error).message}`); }
  } catch (e) { console.log(`${archive}: ${(e as Error).message}`); continue; }

  for (const [label, list] of [['scene graph', placed], ['clutter', clutter]] as const) {
    let bad = 0, n = 0;
    let maxScale = 0, maxT = 0;
    const examples: string[] = [];
    for (const p of list) {
      const m = p.rowMajor;
      n++;
      const s = shape(m);
      const finite = [...m].every((v) => Number.isFinite(v));
      const scale = Math.max(s.sx, s.sy, s.sz);
      const t = Math.max(Math.abs(s.tx), Math.abs(s.ty), Math.abs(s.tz));
      maxScale = Math.max(maxScale, scale);
      maxT = Math.max(maxT, t);
      const degenerate = Math.min(s.sx, s.sy, s.sz) < 1e-6;
      if (!finite || scale > 50 || t > 20000 || degenerate) {
        bad++;
        if (examples.length < 5) {
          examples.push(`${p.modelName} scale ${s.sx.toFixed(2)},${s.sy.toFixed(2)},${s.sz.toFixed(2)}`
            + ` t ${s.tx.toFixed(0)},${s.ty.toFixed(0)},${s.tz.toFixed(0)}${finite ? '' : ' NON-FINITE'}`);
        }
      }
    }
    console.log(`${archive} ${label.padEnd(12)} ${String(n).padStart(5)} placements, `
      + `${bad} suspect; max scale ${maxScale.toFixed(2)}, max |translation| ${maxT.toFixed(0)}`);
    for (const e of examples) console.log(`    !! ${e}`);
  }
}
