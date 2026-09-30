import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { parseAnimSets, type ZAnimArchive } from '../src/index';
import { buildZar, cat, f32, u16, u32, type KeySpec } from './syntheticZar';

/**
 * The zAnim command archives -- `RUN/CZANIM.ZAR`, the map's `MZANIM.ZAR`, `RUN/LDZANIM.ZAR` -- read to their name
 * tables, sets, animations and command streams (web/redotcom/docs/research/77 §9): a hand-built archive first, then the
 * fixture's three, then every map's.
 */

const leaf = (name: string, data?: Uint8Array): KeySpec => ({ name, data });
const list = (name: string, names: string[]): KeySpec => ({ name, children: names.map((n) => leaf(n)) });

/** `_zanim_cmd_hdr` (reCOM zAnim/zanim.h:342-348): type in 16 bits, quad_align, timeless, then the size in bytes. */
const cmd = (type: number, timeless: boolean, ...payload: number[]): Uint8Array =>
  cat(u32((type | (timeless ? 1 << 17 : 0) | ((4 + 4 * payload.length) << 18)) >>> 0), u32(...payload));
/** A 28-byte `_zsequence` head (zanim.h:463-481) and its commands; the size covers both. */
const seq = (nameIndex: number, word: number, ...cmds: Uint8Array[]): Uint8Array => {
  const body = cat(...cmds);
  return cat(u16(nameIndex, 0), u32(word, 0, 28 + body.length), f32(0, 0, 0), body);
};

interface Opts { nameCount?: number; animNameIndex?: number; seqB?: Uint8Array; siDataSize?: number }

/** A CZANIM-shaped archive: one set `common`, one SI script, one animation with two sequences. */
function synthetic(o: Opts = {}): Uint8Array {
  const names = ['NA', 'muzzle_m4', 'flash_fire', 'muzzle_node', 'data/common/zanim/rot.anm'];
  const seqA = seq(1, 0x102, cmd(0x2d, false, 0x03000000, 0, 0, 0), cmd(0x27, true, 0x00b40001));
  const seqB = o.seqB ?? seq(0, 0x104, cmd(0x1e, false, 0x00020280, 0, 0, 0, 0, 0, 0));
  const data = cat(seqA, seqB);
  const params = cat(Uint8Array.from([o.animNameIndex ?? 1, 1, 0, 1]), u32(0x21), f32(0, 3), u16(0, 0, seqA.length, 0));
  const anim: KeySpec = {
    name: 'muzzle_m4', children: [
      leaf('Anim_Params', params),
      leaf('Name_Index_Table_Count', u32(4)), leaf('Name_Index_Table', u16(0, 1, 2, 3)),
      leaf('Node_Ref_Count', u32(2)), leaf('Node_Ref_List', u32(0, 0, 0x00080300, 0)),
      leaf('Seq_Data_Size', u32(data.length)), leaf('Seq_Data', data),
    ],
  };
  const si: KeySpec = {
    name: 'SoftImage_Script', children: [
      leaf('Script_Params', cat(u16(4, 3), u32(0x19), f32(1 / 30), u32(40, o.siDataSize ?? 8, 0x133ada50))),
      leaf('Script_Data', new Uint8Array(8)),
    ],
  };
  const set: KeySpec = {
    name: 'common', children: [
      leaf('Name_Table_Count', u32(o.nameCount ?? names.length)), list('Name_Table', names),
      leaf('RdrPath_Count', u32(1)), list('RdrPath_List', ['data/common/zrdr']),
      leaf('SoftImage_Script_Count', u32(1)), { name: 'SoftImage_Script_List', children: [si] },
      leaf('Animation_List_Count', u32(1)), { name: 'Animation_List', children: [anim] },
    ],
  };
  return buildZar([
    leaf('Anim_Main_Params', cat(u32(72), f32(-98), u32(0, 0))),
    leaf('Name_Table_Count', u32(0)), list('Name_Table', []),
    leaf('Anim_Set_Count', u32(1)), { name: 'Anim_Sets', children: [set] },
  ]);
}

describe('parseAnimSets on a hand-built archive (77 §9)', () => {
  const zanim = parseAnimSets(Zar.parse(synthetic()));
  const set = zanim.sets[0]!, anim = set.anims[0]!;

  it('reads the main params (_zanim_main_params, zanim.h:357-364) and the sets', () => {
    expect(zanim.main).toEqual({ version: 72, gravity: -98, flags: 0, userActionAnimIndex: 0 });
    expect(zanim.names).toEqual([]);
    expect(zanim.sets.map((s) => s.name)).toEqual(['common']);
    expect(set.names).toEqual(['NA', 'muzzle_m4', 'flash_fire', 'muzzle_node', 'data/common/zanim/rot.anm']);
    expect(set.rdrPaths).toEqual(['data/common/zrdr']);
  });

  it('resolves a SoftImage script\'s path and object through the set\'s name table', () => {
    expect(set.siScripts).toEqual([{ path: 'data/common/zanim/rot.anm', object: 'muzzle_node', word: 0x19, frameTime: Math.fround(1 / 30), frameCount: 40, dataSize: 8 }]);
  });

  it('reads an animation: its params, its local name table, its node references', () => {
    expect(anim.name).toBe('muzzle_m4');
    expect(anim.names).toEqual(['NA', 'muzzle_m4', 'flash_fire', 'muzzle_node']);
    expect(anim.params).toEqual({ nameIndex: 1, rootNodeIndex: 1, paused: 0, state: 1, flags: 0x21, timer: 0, priority: 3, seqOffsets: [0, 0, 56, 0] });
    expect(anim.nodeRefs).toEqual([
      { parent: 0, name: 'NA', search: 0, word: 0, flags: 0 },
      { parent: 0, name: 'muzzle_node', search: 1, word: 0x00080300, flags: 0 },
    ]);
    expect(anim.health).toBe(0);
  });

  it('splits the command stream into sequences and each sequence into its commands, to the byte', () => {
    expect(anim.sequences.map((s) => [s.offset, s.name, s.word, s.size])).toEqual([[0, 'muzzle_m4', 0x102, 56], [56, 'NA', 0x104, 60]]);
    expect(anim.sequences[0]!.commands.map(({ bytes: _, ...c }) => c)).toEqual([
      { offset: 28, type: 0x2d, set: 0, cmd: 0x2d, quadAlign: false, timeless: false, size: 20 },
      { offset: 48, type: 0x27, set: 0, cmd: 0x27, quadAlign: false, timeless: true, size: 8 },
    ]);
    // Each command carries its own bytes, header first, as a view of the stream.
    for (const c of anim.sequences.flatMap((s) => s.commands)) {
      expect(c.bytes.length).toBe(c.size);
      expect(new DataView(c.bytes.buffer, c.bytes.byteOffset).getUint32(0, true) & 0xffff).toBe(c.type);
    }
    expect(anim.sequences[1]!.commands.map((c) => [c.offset, c.type, c.size])).toEqual([[84, 0x1e, 32]]);
  });

  it('refuses a count that disagrees with its list, a name that is not the key\'s, and a stream that does not tile', () => {
    expect(() => parseAnimSets(Zar.parse(synthetic({ nameCount: 6 })))).toThrow(/Name_Table_Count 6/);
    expect(() => parseAnimSets(Zar.parse(synthetic({ animNameIndex: 2 })))).toThrow(/names itself flash_fire/);
    expect(() => parseAnimSets(Zar.parse(synthetic({ siDataSize: 9 })))).toThrow(/Script_Data/);
    const long = seq(0, 0x104, cmd(0x1e, false, 0));
    new DataView(long.buffer).setUint32(12, 400, true);
    expect(() => parseAnimSets(Zar.parse(synthetic({ seqB: long })))).toThrow(/sequence at 56/);
    const zero = seq(0, 0x104, cmd(0x1e, false, 0));
    new DataView(zero.buffer).setUint32(28, 0x1e, true);          // a command of size 0
    expect(() => parseAnimSets(Zar.parse(synthetic({ seqB: zero })))).toThrow(/command at 84/);
  });
});

const MP2 = fixture('RUN/MP2.ZDB');
const absent = !MP2;
const open = (bytes: Uint8Array, member: string): ZAnimArchive => parseAnimSets(Zar.parse(zdbMember(bytes, parseZdb(bytes), member)));

describe(`the zAnim archives on Frostfire${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('CZANIM.ZAR: one set, common -- 624 names, 10 script paths, no SoftImage script, 288 animations', () => {
    const cz = open(MP2!, 'CZANIM.ZAR');
    expect(cz.main).toEqual({ version: 72, gravity: -98, flags: 0, userActionAnimIndex: 0 });
    expect(cz.names).toEqual([]);
    expect(cz.sets.map((s) => s.name)).toEqual(['common']);
    const common = cz.sets[0]!;
    expect(common.names.length).toBe(624);
    expect(common.names.slice(0, 4)).toEqual(['NA', 'check_camera_inside_state1', 'outside_noise', 'inside_noise']);
    for (const n of ['jump_whoosh', 'seal_thud', 'dive_prone', 'ladder_rung', 'land_sound', 'big_ripple_anim_walk',
      'small_ripple_anim_run', 'seal_fall_in_water', 'muzzle_m4SD', 'muzzle_Beretta_M9', 'shell_eject', 'tracer']) {
      expect(common.names, n).toContain(n);
    }
    expect(common.rdrPaths.length).toBe(10);
    expect(common.rdrPaths).toContain('data/common/zanim/footfalls');
    expect(common.siScripts).toEqual([]);
    expect(common.anims.length).toBe(288);
    const first = common.anims[0]!;
    expect(first.name).toBe('check_camera_inside_state1');
    expect(first.names).toEqual(['NA', 'check_camera_inside_state1', 'outside_noise', 'inside_noise']);
    expect(first.params).toMatchObject({ nameIndex: 1, rootNodeIndex: 0, state: 1, priority: 3 });
    expect(first.sequences.map((s) => s.size)).toEqual([188]);
  });

  it.skipIf(absent)('MZANIM.ZAR holds the map\'s set, mission; LDZANIM.ZAR the loading screen\'s 95', () => {
    const mz = open(MP2!, 'MZANIM.ZAR'), ld = open(MP2!, 'LDZANIM.ZAR');
    expect(mz.sets.map((s) => [s.name, s.names.length, s.rdrPaths.length, s.siScripts.length, s.anims.length])).toEqual([['mission', 281, 6, 0, 76]]);
    expect(ld.sets.length).toBe(95);
    expect([ld.sets[0]!.name, ld.sets[0]!.names.length, ld.sets[0]!.anims.length]).toEqual(['dlgLoad.rdr', 32, 6]);
    expect(ld.main).toEqual(mz.main);
  });

  it.skipIf(absent)('names no body motion: no set carries a MOTION_S clip or a SoftImage script on Frostfire (77 §9)', () => {
    const clips = Zar.parse(zdbMember(MP2!, parseZdb(MP2!), 'MOTION_S.ZAR')).root.children.map((k) => k.name);
    expect(clips.length).toBe(7);
    for (const member of ['CZANIM.ZAR', 'MZANIM.ZAR', 'LDZANIM.ZAR']) {
      for (const set of open(MP2!, member).sets) {
        expect(set.siScripts, `${member} ${set.name}`).toEqual([]);
        for (const c of clips) expect(set.names, `${member} ${set.name}`).not.toContain(c);
      }
    }
  });
});

const MAPS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps/RUN');
const noMaps = !existsSync(MAPS);

describe.skipIf(noMaps)(`the zAnim archives on every map${noMaps ? ' (public/maps absent: run npm run extract-maps)' : ''}`, () => {
  it.skipIf(noMaps)('reads all 66 to the byte: 9,912 animations, 18,642 sequences, 73,634 commands, 30 SoftImage scripts, no motion clip named', () => {
    const files = readdirSync(MAPS).filter((f) => /^MP\d+\.ZDB$/i.test(f)).sort((a, b) => Number(a.slice(2, -4)) - Number(b.slice(2, -4)));
    expect(files.length).toBe(22);
    // The player's 334 clip names too, where the owner's MOTION_P.ZAR sits beside the maps.
    const pack = resolve(MAPS, 'MOTION_P.ZAR');
    const packNames = existsSync(pack) ? Zar.parse(new Uint8Array(readFileSync(pack))).root.children.map((k) => k.name) : [];
    const total = { anims: 0, sequences: 0, commands: 0, si: 0 };
    const rows = ['map    CZANIM sets/names/anims   MZANIM sets/names/anims/si   LDZANIM sets/anims'];
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(resolve(MAPS, file)));
      const [cz, mz, ld] = ['CZANIM.ZAR', 'MZANIM.ZAR', 'LDZANIM.ZAR'].map((m) => open(bytes, m)) as [ZAnimArchive, ZAnimArchive, ZAnimArchive];
      const clips = new Set([...Zar.parse(zdbMember(bytes, parseZdb(bytes), 'MOTION_S.ZAR')).root.children.map((k) => k.name), ...packNames]);
      for (const a of [cz, mz, ld]) {
        expect(a.main, file).toEqual({ version: 72, gravity: -98, flags: 0, userActionAnimIndex: 0 });
        for (const s of a.sets) {
          expect(s.names.filter((n) => clips.has(n)), `${file} ${s.name}: a motion clip in a zAnim name table`).toEqual([]);
          total.si += s.siScripts.length;
          for (const anim of s.anims) {
            total.anims++;
            total.sequences += anim.sequences.length;
            for (const q of anim.sequences) total.commands += q.commands.length;
          }
        }
      }
      const sum = (a: ZAnimArchive, f: (s: ZAnimArchive['sets'][number]) => number): number => a.sets.reduce((t, s) => t + f(s), 0);
      rows.push(`${file.replace('.ZDB', '').padEnd(6)} ${`${cz.sets.length}/${sum(cz, (s) => s.names.length)}/${sum(cz, (s) => s.anims.length)}`.padEnd(26)}`
        + `${`${mz.sets.length}/${sum(mz, (s) => s.names.length)}/${sum(mz, (s) => s.anims.length)}/${sum(mz, (s) => s.siScripts.length)}`.padEnd(29)}`
        + `${ld.sets.length}/${sum(ld, (s) => s.anims.length)}`);
    }
    console.log(`zAnim archives, 22 maps:\n${rows.join('\n')}`);
    expect(total).toEqual({ anims: 9912, sequences: 18642, commands: 73634, si: 30 });
  }, 60_000);
});
