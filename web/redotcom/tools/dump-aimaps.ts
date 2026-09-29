/**
 * Every field of a map's `AIMAPS.MPS` the reader knows, per sub-map, straight off the disc -- the dump
 * web/docs/research/75 was written from. Archives are looked up in `public/maps/RUN`, then
 * `test-fixtures/RUN`; with no names it runs the three fixtures and the two one-sub-map maps.
 *
 *   npx tsx tools/dump-aimaps.ts                 # MP2 MP6 MP72 MP9 MP64
 *   npx tsx tools/dump-aimaps.ts MP2 --hex       # plus a hex window around every named record
 *   npx tsx tools/dump-aimaps.ts MP2 --strings   # plus every printable run, and the section it lies in
 *   npx tsx tools/dump-aimaps.ts --all           # all 22, the summary lines only
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember } from '@s2u/archive';
import {
  aiCellCentre, aiCellMarker, aiZoneRect, dosDateTime, parseAiMaps, spawnSlots, type AiLoc, type AiMaps,
} from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');
const DIRS = [resolve(web, 'public/maps/RUN'), resolve(web, 'test-fixtures/RUN')];

const args = process.argv.slice(2);
const hex = args.includes('--hex'), strings = args.includes('--strings'), all = args.includes('--all');
let names = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase().replace(/\.ZDB$/, ''));
if (all) {
  const dir = DIRS.find((d) => existsSync(d))!;
  names = readdirSync(dir).filter((f) => /^MP\d+\.ZDB$/i.test(f)).map((f) => f.replace(/\.ZDB$/i, ''))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}
if (!names.length) names = ['MP2', 'MP6', 'MP72', 'MP9', 'MP64'];

function mps(stem: string): Uint8Array {
  for (const dir of DIRS) {
    const p = resolve(dir, `${stem}.ZDB`);
    if (existsSync(p)) { const zdb = new Uint8Array(readFileSync(p)); return zdbMember(zdb, parseZdb(zdb), 'AIMAPS.MPS'); }
  }
  throw new Error(`${stem}.ZDB not found under ${DIRS.join(' or ')}`);
}

const n = (v: number, d = 2) => v.toFixed(d);
const at = (l: AiLoc) => `${l.map}:(${l.x},${l.z})`;
const h8 = (v: number) => (v >>> 0).toString(16).padStart(8, '0');

/** Where each part of the file lies, rebuilt from the parsed counts -- 75 §2-§6. */
function layout(ai: AiMaps): { from: number; to: number; label: string }[] {
  const out: { from: number; to: number; label: string }[] = [];
  let o = 0;
  const put = (size: number, label: string) => { out.push({ from: o, to: o + size, label }); o += size; };
  put(0x28, 'file head');
  for (const s of ai.maps) {
    const tag = `[${s.index}] ${s.name}`;
    put(0x78, `${tag} header`);
    put(4, `${tag} header +0x78 (unread)`);
    put(0x0c, `${tag} header +0x7c stamps, +0x84`);
    put(0x20, `${tag} header +0x88 pad (unread)`);
    put(8 * s.cells.length, `${tag} cells`);
    put(12 * s.cellsZ, `${tag} rows`);
    put(4 + 24 * s.points.length, `${tag} named points`);
    put(4 + 40 * s.markers.length, `${tag} markers (40 B each; +8..+39 unread)`);
    put(4 + 12 * s.links.length, `${tag} links`);
    put(4 + 28 * s.zones.length, `${tag} zones`);
    put(4 + 12 * s.spawns.length, `${tag} spawn records`);
    put(4 + s.lines.reduce((t, l) => t + 8 + 4 * l.locs.length, 0), `${tag} polylines`);
    put(8, `${tag} two empty tables`);
    put(4 * s.cellsB.length, `${tag} second cell words`);
  }
  put(16 + 4 * ai.links.words + 16 * ai.links.records, 'trailer link block');
  put(4 + 12 * ai.spawns.length, 'trailer spawn list');
  return out;
}

function window(bytes: Uint8Array, from: number, to: number): string {
  const lines: string[] = [];
  for (let o = from & ~15; o < to; o += 16) {
    const row = bytes.subarray(o, Math.min(o + 16, bytes.length));
    const words: string[] = [];
    for (let i = 0; i + 4 <= row.length; i += 4) words.push(h8(row[i]! | row[i + 1]! << 8 | row[i + 2]! << 16 | row[i + 3]! << 24));
    const text = [...row].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
    lines.push(`        ${o.toString(16).padStart(6, '0')}  ${words.join(' ').padEnd(35)}  ${text}`);
  }
  return lines.join('\n');
}

for (const stem of names) {
  let bytes: Uint8Array, ai: AiMaps;
  try { bytes = mps(stem); ai = parseAiMaps(bytes); } catch (e) { console.log(`${stem}: ${(e as Error).message}`); continue; }
  const slots = [0, 1].map((side) => spawnSlots(ai, side as 0 | 1).length);
  console.log(`${stem.padEnd(5)} AIMAPS.MPS ${bytes.length} B, version ${ai.version}, ${ai.maps.length} sub-maps; `
    + `trailer: link block ${ai.links.words} words + ${ai.links.records} records, ${ai.spawns.length} spawn records `
    + `(slots ${slots[0]} side 0 / ${slots[1]} side 1); parsed to the last byte`);
  if (all) continue;
  const parts = layout(ai);
  for (const s of ai.maps) {
    const start = parts.find((p) => p.label === `[${s.index}] ${s.name} header`)!.from;
    const rows = s.rows.filter((r) => r.x1 > r.x0);
    const marks = new Map<number, number>();
    for (const w of s.cells) { const m = aiCellMarker(w); if (m) marks.set(m, (marks.get(m) ?? 0) + 1); }
    console.log(`  [${s.index}] ${JSON.stringify(s.name)} @0x${start.toString(16)} id ${s.id} flags 0x${s.flags.toString(16)} `
      + `param ${Number(s.param.toPrecision(7))} stamp ${dosDateTime(s.stamp)}`);
    console.log(`      bbox (${s.min.map((v) => n(v)).join(', ')}) - (${s.max.map((v) => n(v)).join(', ')}); `
      + `${s.cellsX} x ${s.cellsZ} cells of ${s.cellSize.join(' x ')}; ${s.cells.length} stored in ${rows.length} rows, `
      + `x ${Math.min(...rows.map((r) => r.x0))}-${Math.max(...rows.map((r) => r.x1)) - 1}, `
      + `z ${s.rows.findIndex((r) => r.x1 > r.x0)}-${s.rows.length - 1 - [...s.rows].reverse().findIndex((r) => r.x1 > r.x0)}; `
      + `cell markers ${[...marks].sort().map(([m, c]) => `${m}:${c}`).join(' ') || 'none'}`);
    const byFlags = new Map<string, number>();
    for (const r of s.spawns) { const k = `${r.side}${r.twin ? 't' : 's'}`; byFlags.set(k, (byFlags.get(k) ?? 0) + 1); }
    console.log(`      tables: ${s.points.length} named points, ${s.markers.length} markers, ${s.links.length} links, `
      + `${s.zones.length} zones, ${s.spawns.length} spawn records (${[...byFlags].sort().map(([k, c]) => `${k}:${c}`).join(' ') || '-'}), `
      + `${s.lines.length} polylines (${s.lines.reduce((t, l) => t + l.locs.length, 0)} locs)`);
    for (const p of s.points) {
      const [x, z] = aiCellCentre(s, p.loc.x, p.loc.z);
      console.log(`      point  ${p.name.padEnd(14)} ${at(p.loc).padEnd(14)} kind ${p.kind} word ${h8(p.word)} centre (${n(x)}, ${n(z)})`);
    }
    for (const m of s.markers) console.log(`      marker ${at(m.loc).padEnd(14)} word ${h8(m.word)}`);
    for (const k of s.links) console.log(`      link   ${at(k.from)} -> ${at(k.to)} word ${h8(k.word)}`);
    for (const zn of s.zones) {
      const r = aiZoneRect(s, zn);
      console.log(`      zone   ${zn.name.padEnd(10)} corner ${at(zn.corner)} ${zn.width} x ${zn.height} cells kind ${zn.kind} `
        + `-> x ${n(r.minX)}-${n(r.maxX)}, z ${n(r.minZ)}-${n(r.maxZ)}`);
    }
    if (hex) {
      const named = parts.find((p) => p.label === `[${s.index}] ${s.name} named points`)!;
      const zones = parts.find((p) => p.label === `[${s.index}] ${s.name} zones`)!;
      if (s.points.length) console.log(`      named points @0x${named.from.toString(16)}: u32 count; {u32 loc; char name[16]; u32 word} x ${s.points.length}\n${window(bytes, named.from, named.to)}`);
      if (s.zones.length) console.log(`      zones @0x${zones.from.toString(16)}: u32 count; {u32 corner; u16 width; u16 height; u32 kind; char name[16]} x ${s.zones.length}\n${window(bytes, zones.from, zones.to)}`);
      console.log(`      header @0x${start.toString(16)}:\n${window(bytes, start, start + 0xa8)}`);
    }
  }
  if (strings) {
    console.log('  printable runs of 6+ bytes, by section:');
    let run = -1;
    for (let o = 0; o <= bytes.length; o++) {
      const c = o < bytes.length ? bytes[o]! : 0;
      if (c >= 32 && c < 127) { if (run < 0) run = o; continue; }
      if (run >= 0 && o - run >= 6) {
        const part = parts.find((p) => run >= p.from && run < p.to);
        console.log(`      0x${run.toString(16).padStart(6, '0')} ${JSON.stringify(String.fromCharCode(...bytes.subarray(run, o)))}  <- ${part?.label ?? '?'}`);
      }
      run = -1;
    }
  }
}
