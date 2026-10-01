/**
 * The zAnim effect animations of a map, straight off the disc -- the dump web/redotcom/docs/research/89 was written from.
 * Archives are looked up in `public/maps/RUN`, then `test-fixtures/RUN`.
 *
 *   npx tsx tools/dump-effects.ts MP2                          # CZANIM: every animation, its command count
 *   npx tsx tools/dump-effects.ts MP2 --mission                # the same for the map's MZANIM (the bullet impacts)
 *   npx tsx tools/dump-effects.ts MP2 muzzle_m4SD shell_eject  # those animations: names, node refs, every command's bytes
 *   npx tsx tools/dump-effects.ts MP2 'bullet_hit_*' --mission # a trailing * matches a prefix
 *   npx tsx tools/dump-effects.ts MP2 shell_eject --decoded    # the decoded program (`@s2u/scene`'s decodeEffectProgram)
 *
 * A command prints as its offset, set, number and name (`ZANIM_COMMAND_NAMES`), its size and flags (T timeless,
 * Q quad-aligned), its bytes, and the bytes after the header read as f32 where they look like floats.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { decodeEffectProgram, parseAnimSets, ZANIM_COMMAND_NAMES } from '@s2u/scene';

const web = resolve(import.meta.dirname, '..');
const DIRS = [resolve(web, 'public/maps/RUN'), resolve(web, 'test-fixtures/RUN')];
const args = process.argv.slice(2);
const stem = (args.find((a) => /^MP\d+$/i.test(a)) ?? 'MP2').toUpperCase();
const wanted = args.filter((a) => !/^MP\d+$/i.test(a) && !a.startsWith('--'));
const decoded = args.includes('--decoded');
const dir = DIRS.find((d) => existsSync(resolve(d, `${stem}.ZDB`)));
if (!dir) throw new Error(`${stem}.ZDB is in neither ${DIRS.join(' nor ')}: run npm run extract-maps`);
const bytes = new Uint8Array(readFileSync(resolve(dir, `${stem}.ZDB`)));
const member = args.includes('--mission') ? 'MZANIM.ZAR' : 'CZANIM.ZAR';
const zar = Zar.parse(zdbMember(bytes, parseZdb(bytes), member));
const archive = parseAnimSets(zar);
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const matches = (name: string): boolean =>
  wanted.some((w) => name === w || (w.endsWith('*') && name.startsWith(w.slice(0, -1))));

for (const set of archive.sets) {
  for (const a of set.anims) {
    if (!wanted.length) { console.log(set.name, a.name, a.sequences.reduce((n, s) => n + s.commands.length, 0)); continue; }
    if (!matches(a.name)) continue;
    if (decoded) { console.log(JSON.stringify(decodeEffectProgram(a), null, 1)); continue; }
    console.log(`== ${set.name}/${a.name} params`, JSON.stringify(a.params));
    console.log('  names', a.names.map((n, i) => `${i}:${n}`).join(' '));
    console.log('  refs', a.nodeRefs.map((r) => `${r.name}(p${r.parent},s${r.search},f${r.flags.toString(16)})`).join(' '));
    for (const s of a.sequences) {
      console.log(`  seq@${s.offset} ${s.name} word=${s.word.toString(16)} size=${s.size}`);
      for (const c of s.commands) {
        const dv = new DataView(c.bytes.buffer, c.bytes.byteOffset, c.bytes.byteLength);
        const f: string[] = [];
        for (let i = 4; i + 4 <= c.bytes.length; i += 4) {
          const v = dv.getFloat32(i, true);
          f.push(Math.abs(v) > 1e-6 && Math.abs(v) < 1e7 ? v.toPrecision(5) : `0x${dv.getUint32(i, true).toString(16)}`);
        }
        const name = c.set === 0 ? ZANIM_COMMAND_NAMES[c.cmd] ?? '?' : `set ${c.set}`;
        console.log(`    @${c.offset} ${c.set}:${c.cmd} ${name} ${c.size}B${c.timeless ? ' T' : ''}${c.quadAlign ? ' Q' : ''}`);
        console.log(`      ${hex(c.bytes)}`);
        console.log(`      f: ${f.join(' ')}`);
      }
    }
  }
}
