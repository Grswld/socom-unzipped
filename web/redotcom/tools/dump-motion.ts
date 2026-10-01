/**
 * The skeletal motion clips of a map's `MOTION_S.ZAR` and its three zAnim archives, straight off the disc -- the
 * dump web/redotcom/docs/research/77 was written from. Archives are looked up in `public/maps/RUN`, then `test-fixtures/RUN`.
 *
 *   npx tsx tools/dump-motion.ts                     # MP2: every clip's head, layout, tracks and word histogram
 *   npx tsx tools/dump-motion.ts MP2 --hex           # plus a hex window per object record and per track head
 *   npx tsx tools/dump-motion.ts MP2 --strings       # plus every printable run, and the section it lies in
 *   npx tsx tools/dump-motion.ts --all               # all 22: the clips, sizes and frames, and the payload beside MP2's
 *   npx tsx tools/dump-motion.ts MP2 --zanim         # CZANIM, MZANIM, LDZANIM: sets, name tables, scripts, commands
 *   npx tsx tools/dump-motion.ts MP2 --zanim --names # plus every name of every table and every animation's streams
 *   npx tsx tools/dump-motion.ts --pack              # RUN/MOTION_P.ZAR, the player's 334 clips: one line each
 *   npx tsx tools/dump-motion.ts --pack seal_run     # the named clips in full (tracks, histogram; --hex, --strings)
 *
 * The histogram is the discovery pass the layout came from: it classifies every word of a clip as a count, a frame
 * number, a unit quaternion (four f32, or four int16 over 32767) or an orthonormal 3x3 (nine f32), by section.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, Reader, zdbMember, Zar } from '@s2u/archive';
import {
  MOTION_CONST_ROTATION, MOTION_CONST_TRANSLATION, parseAnimSets, parseMotionClip, type MotionClip, type ZAnimArchive,
} from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');
const DIRS = [resolve(web, 'public/maps/RUN'), resolve(web, 'test-fixtures/RUN')];

const args = process.argv.slice(2);
const flag = (f: string): boolean => args.includes(f);
const hex = flag('--hex'), strings = flag('--strings'), all = flag('--all'), zanim = flag('--zanim'), everyName = flag('--names');
const pack = flag('--pack');
/** With --pack the bare arguments are clip names to show in full; otherwise they are map stems. */
const packClips = pack ? args.filter((a) => !a.startsWith('--')) : [];
let stems = pack ? [] : args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase().replace(/\.ZDB$/, ''));
if (all) {
  const dir = DIRS.find((d) => existsSync(d))!;
  stems = readdirSync(dir).filter((f) => /^MP\d+\.ZDB$/i.test(f)).map((f) => f.replace(/\.ZDB$/i, ''))
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}
if (!stems.length && !pack) stems = ['MP2'];

function archive(stem: string): Uint8Array {
  for (const dir of DIRS) {
    const p = resolve(dir, `${stem}.ZDB`);
    if (existsSync(p)) return new Uint8Array(readFileSync(p));
  }
  throw new Error(`${stem}.ZDB not found under ${DIRS.join(' or ')}`);
}

const h8 = (v: number): string => (v >>> 0).toString(16).padStart(8, '0');
const x = (v: number): string => `0x${v.toString(16)}`;

function window(bytes: Uint8Array, from: number, to: number, indent = '        '): string {
  const lines: string[] = [];
  for (let o = from & ~15; o < to; o += 16) {
    const row = bytes.subarray(o, Math.min(o + 16, bytes.length));
    const words: string[] = [];
    for (let i = 0; i + 4 <= row.length; i += 4) words.push(h8(row[i]! | row[i + 1]! << 8 | row[i + 2]! << 16 | row[i + 3]! << 24));
    const text = [...row].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
    lines.push(`${indent}${o.toString(16).padStart(6, '0')}  ${words.join(' ').padEnd(35)}  ${text}`);
  }
  return lines.join('\n');
}

/** Where each part of a clip lies, rebuilt from the parsed counts (77 §2-§5). */
function layout(bytes: Uint8Array, clip: MotionClip): { from: number; to: number; label: string }[] {
  const r = new Reader(bytes);
  const out: { from: number; to: number; label: string }[] = [];
  const namesAt = r.u32(0x18), dataAt = r.u32(0x1c);
  out.push({ from: 0, to: 0x20, label: 'head' });
  out.push({ from: 0x20, to: namesAt, label: `${clip.parts.length} object records (writer residue)` });
  out.push({ from: namesAt, to: dataAt, label: 'name table' });
  let o = dataAt;
  const keys = clip.frameCount + 1;
  for (const p of clip.parts) {
    const tag = `[${p.index}] ${p.name}`;
    out.push({ from: o, to: o + 4, label: `${tag} flags` });
    o += 4;
    if (p.flags & MOTION_CONST_TRANSLATION) { out.push({ from: o, to: o + 8, label: `${tag} T const` }); o += 8; }
    else {
      out.push({ from: o, to: o + 6 * keys, label: `${tag} T x${keys}` });
      o += 6 * keys;
      if (o % 4) { out.push({ from: o, to: (o + 3) & ~3, label: `${tag} T pad` }); o = (o + 3) & ~3; }
    }
    const rk = p.flags & MOTION_CONST_ROTATION ? 1 : keys;
    out.push({ from: o, to: o + 8 * rk, label: `${tag} R ${rk === 1 ? 'const' : `x${rk}`}` });
    o += 8 * rk;
  }
  return out;
}

/** The discovery histogram: every word classified, by section. */
function histogram(bytes: Uint8Array, clip: MotionClip, parts: { from: number; to: number; label: string }[]): string[] {
  const r = new Reader(bytes);
  const section = (o: number): string => {
    const label = parts.find((p) => o >= p.from && o < p.to)?.label ?? '?';
    return label.replace(/^\[\d+\] \S+ /, 'track ');            // fold the 26 tracks together
  };
  const tally = new Map<string, Map<string, number>>();
  const add = (kind: string, o: number): void => {
    const m = tally.get(kind) ?? new Map<string, number>();
    const s = section(o);
    m.set(s, (m.get(s) ?? 0) + 1);
    tally.set(kind, m);
  };
  for (let o = 0; o + 4 <= bytes.length; o += 4) {
    const u = r.u32(o);
    if (u === clip.frameCount || u === clip.frameCount + 1) add(`u32 = frame count ${clip.frameCount} or +1`, o);
    else if (u === clip.parts.length) add(`u32 = part count ${clip.parts.length}`, o);
    else if (u > 0 && u < 0x400) add('u32 in 1..1023 (count-like)', o);
    const f = r.f32(o);
    if (Number.isFinite(f) && f !== 0 && Math.abs(f) > 1e-6 && Math.abs(f) < 1e5) add('f32 plausible (1e-6..1e5)', o);
    if (o + 16 <= bytes.length) {
      const q = [0, 4, 8, 12].map((k) => r.f32(o + k));
      if (q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) < 1e-3) add('4 x f32 of unit length', o);
    }
    if (o + 36 <= bytes.length) {
      const m = Array.from({ length: 9 }, (_, k) => r.f32(o + 4 * k));
      const row = (i: number) => m.slice(3 * i, 3 * i + 3);
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      if (m.every(Number.isFinite) && [0, 1, 2].every((i) => Math.abs(dot(row(i), row(i)) - 1) < 1e-3)
        && Math.abs(dot(row(0), row(1))) < 1e-3 && Math.abs(dot(row(1), row(2))) < 1e-3) add('9 x f32 orthonormal (a 3x3)', o);
    }
  }
  for (let o = 0; o + 8 <= bytes.length; o += 2) {
    const q = [0, 2, 4, 6].map((k) => r.i16(o + k) / 32767);
    if (Math.abs(Math.hypot(...q) - 1) < 1e-3) add(`4 x i16 of unit length over 32767 (${o % 4 ? '2' : '4'}-aligned)`, o);
  }
  return [...tally].map(([kind, m]) => `      ${kind.padEnd(48)} ${[...m].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}:${c}`).join('  ')}`);
}

/** Every clip of a motion archive: one line each in `summary` mode (or for clips not in `detail`), else in full. */
function dumpClips(label: string, zar: Zar, summary: boolean, detail?: string[]): void {
  console.log(`${label}: ${zar.root.children.length} clips, ${zar.keyCount} keys`);
  for (const key of zar.root.children) {
    const b = zar.data(key);
    let clip: MotionClip;
    try { clip = parseMotionClip(b, key.name); } catch (e) { console.log(`  ${key.name}: ${(e as Error).message}`); continue; }
    const r = new Reader(b);
    const payload = createHash('sha1').update(b.subarray(0, 0x20)).update(b.subarray(r.u32(0x18))).digest('hex').slice(0, 12);
    console.log(`  ${key.name} @${key.offset} ${key.size} B, ${key.children.length} children: version ${clip.version}, `
      + `duration ${clip.duration.toFixed(6)} s, ${clip.frameCount} frames (${clip.frameCount + 1} keys a channel), `
      + `rate ${clip.rate.toFixed(4)}/s, ${clip.parts.length} parts, +0x10 ${clip.unknown10} +0x14 ${clip.unknown14}, `
      + `names @${x(r.u32(0x18))} data @${x(r.u32(0x1c))}; payload sha1 ${payload}; read to the last byte`);
    if (summary || (detail && !detail.includes(key.name))) continue;
    const parts = layout(b, clip);
    const n = clip.frameCount;
    for (const p of clip.parts) {
      const at = parts.find((s) => s.label === `[${p.index}] ${p.name} flags`)!.from;
      const tKeys = p.translations.length / 3, rKeys = p.rotations.length / 4;
      const fmt = (a: Float32Array, i: number, k: number, d: number) => Array.from(a.subarray(k * i, k * i + k)).map((v) => v.toFixed(d)).join(' ');
      const closed = (a: Float32Array, k: number) => a.length === k || fmt(a, 0, k, 7) === fmt(a, n, k, 7);
      const record = new Reader(b.subarray(0x20 + 16 * p.index, 0x30 + 16 * p.index));
      const residue = p.flags & MOTION_CONST_TRANSLATION ? ` lane4 ${new Reader(b).i16(at + 10)}` : '';
      console.log(`    [${String(p.index).padStart(2)}] ${p.name.padEnd(14)} @${x(at).padEnd(6)} flags ${x(p.flags)} T ${tKeys === 1 ? 'const' : `x${tKeys}`} R ${rKeys === 1 ? 'const' : `x${rKeys}`}`
        + ` T0 (${fmt(p.translations, 0, 3, 3)}) R0 (${fmt(p.rotations, 0, 4, 4)})`
        + `${tKeys > 1 || rKeys > 1 ? ` key n = key 0: ${closed(p.translations, 3) && closed(p.rotations, 4)}` : ''}${residue}`
        + `  record ${h8(record.u32(0))} ${h8(record.u32(4))} ${h8(record.u32(8))} ${h8(record.u32(12))} (w1-w0 ${record.u32(4) - record.u32(0)})`);
      if (hex) console.log(window(b, at, Math.min(at + 32, b.length)));
    }
    if (hex) {
      console.log(`      head and object records @0:\n${window(b, 0, parts[2]!.from)}`);
      console.log(`      name table @${x(parts[2]!.from)}:\n${window(b, parts[2]!.from, parts[2]!.to)}`);
    }
    console.log('      word histogram, by section:');
    for (const line of histogram(b, clip, parts)) console.log(line);
    if (strings) {
      console.log('      printable runs of 4+ bytes, by section:');
      let run = -1;
      for (let o = 0; o <= b.length; o++) {
        const c = o < b.length ? b[o]! : 0;
        if (c >= 32 && c < 127) { if (run < 0) run = o; continue; }
        if (run >= 0 && o - run >= 4) {
          const s = parts.find((p) => run >= p.from && run < p.to);
          console.log(`        ${x(run).padEnd(8)} ${JSON.stringify(String.fromCharCode(...b.subarray(run, o)))}  <- ${s?.label ?? '?'}`);
        }
        run = -1;
      }
    }
  }
}

/** reCOM's `DATATYPE_*` numbering (zAnim/zanim.h:15-52): a hint for set 0's command types, not checked against SOCOM II. */
const RECOM_TYPES: Record<number, string> = {
  0x01: 'QUAD_ALIGN', 0x02: 'IF', 0x04: 'GO_TO_ENDIF', 0x05: 'END_IF', 0x06: 'NODE_ACTIVE', 0x08: 'RANGE_TEST',
  0x09: 'RANDOM_WEIGHT', 0x0a: 'FAIL', 0x0d: 'LOOP', 0x0e: 'WAIT', 0x10: 'OBJECT_ACTIVE_STATE', 0x11: 'OBJECT_TRANSLATE_STATE',
  0x12: 'OBJECT_ROTATE_STATE', 0x13: 'OBJECT_MOTION', 0x14: 'OBJECT_MOTION_FROM_TO', 0x15: 'OBJECT_OPACITY_FROM_TO',
  0x17: 'PARTICLE_SOURCE', 0x18: 'CAMERA', 0x19: 'DESTRUCTION_SOURCE', 0x1a: 'SOUND', 0x1b: 'LIGHT', 0x1c: 'WHILE',
  0x1d: 'END_WHILE', 0x20: 'CALL_ANIMATION', 0x21: 'STOP_ANIMATION', 0x22: 'PAUSE_ANIMATION', 0x23: 'RESUME_ANIMATION',
  0x24: 'INVALIDATE_ANIMATION', 0x25: 'CALL_SEQUENCE', 0x26: 'STOP_SEQUENCE', 0x2a: 'MESSAGE', 0x2d: 'VALVE',
  0x2e: 'CAM_CONTROL_SWITCH', 0x30: 'CAM_INDOORS_TEST', 0x31: 'CAM_SET_REGIONS', 0x33: 'CAM_SET_PARAMS', 0x34: 'CAM_3RD_PERSON',
  0x37: 'IS_PLAYER_NODE',
};

function dumpZAnim(stem: string, bytes: Uint8Array): void {
  const toc = parseZdb(bytes);
  for (const member of ['CZANIM.ZAR', 'MZANIM.ZAR', 'LDZANIM.ZAR']) {
    let z: ZAnimArchive;
    try { z = parseAnimSets(Zar.parse(zdbMember(bytes, toc, member))); } catch (e) { console.log(`${stem} ${member}: ${(e as Error).message}`); continue; }
    const types = new Map<number, number>();
    let anims = 0, seqs = 0, cmds = 0;
    for (const s of z.sets) for (const a of s.anims) { anims++; for (const q of a.sequences) { seqs++; for (const c of q.commands) { cmds++; types.set(c.type, (types.get(c.type) ?? 0) + 1); } } }
    console.log(`${stem} ${member}: version ${z.main.version}, gravity ${z.main.gravity}, flags ${z.main.flags}, user action ${z.main.userActionAnimIndex}; `
      + `${z.names.length} top-level names; ${z.sets.length} sets, ${anims} animations, ${seqs} sequences, ${cmds} commands; read to the byte`);
    for (const s of z.sets) {
      if (!s.names.length && !s.anims.length) continue;                 // the loading screen's empty Anim_Sets
      console.log(`  set ${JSON.stringify(s.name)}: ${s.names.length} names, ${s.rdrPaths.length} script paths, ${s.siScripts.length} SoftImage scripts, ${s.anims.length} animations`);
      const shown = everyName ? s.names : s.names.slice(0, 40);
      console.log(`    names: ${shown.map((n, i) => `${i}:${JSON.stringify(n)}`).join(' ')}${shown.length < s.names.length ? ` ... (${s.names.length - shown.length} more; --names for all)` : ''}`);
      for (const p of s.rdrPaths) console.log(`    script path ${JSON.stringify(p)}`);
      for (const si of s.siScripts) console.log(`    SoftImage script ${si.path} object ${si.object}: ${si.frameCount} frames of ${si.frameTime.toFixed(5)} s, ${si.dataSize} B, word ${x(si.word)}`);
      console.log(`    animations: ${s.anims.map((a) => a.name).join(' ')}`);
      if (everyName) {
        for (const a of s.anims) {
          console.log(`    ${a.name}: priority ${a.params.priority} state ${a.params.state} flags ${x(a.params.flags)} root ${a.params.rootNodeIndex} `
            + `offsets ${a.params.seqOffsets.join('/')} health ${a.health}; names ${a.names.join(', ')}; `
            + `nodes ${a.nodeRefs.map((r) => `${r.name}<${r.parent}`).join(' ') || '-'}`);
          for (const q of a.sequences) console.log(`      sequence @${q.offset} ${q.name} ${x(q.word)} ${q.size} B: ${q.commands.map((c) => `${x(c.type)}${c.timeless ? 't' : ''}/${c.size}`).join(' ')}`);
        }
      }
    }
    console.log(`  command types (type:count, reCOM zanim.h name for set 0 as a hint): ${[...types].sort((a, b) => a[0] - b[0])
      .map(([t, c]) => `${x(t)}${t < 0x100 && RECOM_TYPES[t] ? `(${RECOM_TYPES[t]})` : ''}:${c}`).join(' ')}`);
  }
}

for (const stem of stems) {
  let bytes: Uint8Array;
  try { bytes = archive(stem); } catch (e) { console.log(`${stem}: ${(e as Error).message}`); continue; }
  if (zanim) dumpZAnim(stem, bytes);
  else dumpClips(`${stem} MOTION_S.ZAR`, Zar.parse(zdbMember(bytes, parseZdb(bytes), 'MOTION_S.ZAR')), all);
}
if (pack) {
  // The player's pack is a loose file beside the maps (the owner's; git-ignored like them), not a ZDB member.
  const path = DIRS.map((d) => resolve(d, 'MOTION_P.ZAR')).find((p) => existsSync(p));
  if (!path) console.log(`MOTION_P.ZAR not found under ${DIRS.join(' or ')}`);
  else dumpClips('RUN/MOTION_P.ZAR', Zar.parse(new Uint8Array(readFileSync(path))), packClips.length === 0, packClips);
}
