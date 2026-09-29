import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import type { AssetSource, RdrNode } from '@s2u/archive';
import { PLAY_CLIPS, SEAL_CLIPS } from '../src/animator';
import {
  clipsFromPack, motionTableFromArchive, playFromDisc, readMotionTable, MOTION_PACK_PATH, MOTION_TABLE_PATH,
} from '../src/motionTable';

/**
 * `motion.rdr`, the playback table (web/docs/research/77 §7): each clip's `looped`, `playback`, `max_velocity`,
 * `BlendTime`, transition speeds and `NoInterrupt`, read at run time out of `RUN/READERC.ZAR` (W2.R6: none of its
 * values is in the source; the synthetic entries below are made up). And the player's pack, `RUN/MOTION_P.ZAR`, read
 * for the clips the play mode asks for.
 */

describe('reading motion.rdr by name (W2.R6)', () => {
  it('reads each entry\'s fields by the file\'s names, numbers or absent; a flag with no value is absent', () => {
    const rdr: RdrNode = ['animations', [
      ['anim_name', ['clip_a'], 'BlendTime', ['0.25'], 'max_velocity', ['-3'], 'looped', ['1'], 'playback', ['7'],
        'transition_speed_A', ['0'], 'transition_speed_B', ['0.5'], 'zanim_callback', ['name', ['whoosh'], 'time', ['0.2']]],
      ['anim_name', ['clip_b'], 'NoInterrupt', ['0.4'], 'max_velocity', ['9'], 'looped', ['0'], 'playback', ['1'], 'Lateral', []],
      ['anim_name', ['clip_c'], 'NoInterrupt', [], 'playback', ['not a number']],
      ['no_name', ['x']],
    ]];
    const table = readMotionTable(rdr);
    expect([...table.keys()]).toEqual(['clip_a', 'clip_b', 'clip_c']);
    expect(table.get('clip_a')).toEqual({
      looped: true, playback: 7, maxVelocity: -3, blendTime: 0.25, transitionA: 0, transitionB: 0.5, noInterrupt: null,
    });
    expect(table.get('clip_b')).toEqual({
      looped: false, playback: 1, maxVelocity: 9, blendTime: null, transitionA: null, transitionB: null, noInterrupt: 0.4,
    });
    expect(table.get('clip_c')).toEqual({
      looped: null, playback: null, maxVelocity: null, blendTime: null, transitionA: null, transitionB: null, noInterrupt: null,
    });
    expect(readMotionTable([]).size).toBe(0);
    expect(readMotionTable(['animations', 'not a list']).size).toBe(0);
  });

  it('names the two disc files it reads, beside the maps', () => {
    expect(MOTION_TABLE_PATH).toBe('RUN/READERC.ZAR');
    expect(MOTION_PACK_PATH).toBe('RUN/MOTION_P.ZAR');
  });

  it('is null, silently, from a source without the pack: the body stands in its bind pose then', async () => {
    const none: AssetSource = { list: async () => [], read: async (p) => { throw new Error(`HTTP 404 ${p}`); } };
    expect(await playFromDisc(none, PLAY_CLIPS)).toBeNull();
    expect(motionTableFromArchive(new Uint8Array(64))).toBeNull();
  });
});

const SERVED = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps');
const noTable = !existsSync(resolve(SERVED, MOTION_TABLE_PATH));
const noPack = !existsSync(resolve(SERVED, MOTION_PACK_PATH));

describe.skipIf(noTable)(`motion.rdr on the disc${noTable ? ' (READERC.ZAR absent from public/maps/RUN)' : ''}`, () => {
  const table = () => motionTableFromArchive(new Uint8Array(readFileSync(resolve(SERVED, MOTION_TABLE_PATH))))!;

  it('holds research 77 §7\'s 398 entries, 150 looped and 248 not, and the values it prints', () => {
    const t = table();
    expect(t.size).toBe(398);
    const looped = [...t.values()].map((e) => e.looped);
    expect([looped.filter((l) => l === true).length, looped.filter((l) => l === false).length]).toEqual([150, 248]);
    // research 77 §7: seal_run and seal_stand loop, seal_jump and seal_land_hard do not; seal_crouch_step plays in 0.4
    expect([t.get('seal_run')!.looped, t.get('seal_stand')!.looped, t.get('seal_jump')!.looped, t.get('seal_land_hard')!.looped])
      .toEqual([true, true, false, false]);
    expect(t.get('seal_crouch_step')!.playback).toBeCloseTo(0.4, 6);
    expect(t.get('seal_run')!.playback).toBe(1);
    expect([t.get('seal_walk')!.maxVelocity, t.get('seal_run')!.maxVelocity]).toEqual([6.5, 6.5]);
  });

  it('names every clip the play mode picks, each consistent: a playback, a locomotion band that runs upward', () => {
    const t = table();
    for (const name of Object.values(SEAL_CLIPS)) {
      const e = t.get(name);
      expect(e, name).toBeTruthy();
      expect(e!.looped, name).not.toBeNull();
      expect(e!.playback! > 0, name).toBe(true);
      expect(e!.maxVelocity, name).not.toBeNull();
      if (e!.transitionA !== null && e!.transitionB !== null) expect(e!.transitionA <= e!.transitionB, name).toBe(true);
      if (e!.blendTime !== null) expect(e!.blendTime > 0, name).toBe(true);
    }
  });
});

describe.skipIf(noPack || noTable)(`the play data from the served tree${noPack ? ' (MOTION_P.ZAR absent)' : ''}`, () => {
  it('reads the asked-for clips out of MOTION_P.ZAR with research 77 §12\'s frame counts, and the table beside them', async () => {
    const data = (await playFromDisc(new FsAssetSource(SERVED), PLAY_CLIPS))!;
    expect(data).not.toBeNull();
    const frames = new Map(data.clips.map((c) => [c.name, c.frameCount]));
    const { seal_crouchwalk_bw: back, ...printed } = Object.fromEntries(Object.values(SEAL_CLIPS).map((n) => [n, frames.get(n)]));
    expect(printed).toEqual({
      seal_stand: 16, seal_walk: 25, seal_jog: 22, seal_run: 19, seal_walk_bw: 16, seal_run_bw: 18, seal_lstrafe: 22,
      seal_rstrafe: 23, seal_crouch: 21, seal_crouchwalk: 28, seal_jump: 20,
      seal_runningjump_launch: 25, seal_runningjump_in_air: 14, seal_land_soft: 20, seal_land_hard: 20,
    });
    expect(back! > 0).toBe(true);                     // research 77 §12 does not print its count
    // only what was asked for, each once; the table only for those
    expect(data.clips.every((c) => PLAY_CLIPS.includes(c.name))).toBe(true);
    expect(new Set(data.clips.map((c) => c.name)).size).toBe(data.clips.length);
    expect(data.table!.every(([n]) => PLAY_CLIPS.includes(n))).toBe(true);
    expect(data.table!.map(([n]) => n)).toEqual(expect.arrayContaining(Object.values(SEAL_CLIPS)));
    // a name the pack does not carry is left out, not an error
    expect(clipsFromPack(new Uint8Array(readFileSync(resolve(SERVED, MOTION_PACK_PATH))), ['seal_walk', 'no_such_clip']).map((c) => c.name))
      .toEqual(['seal_walk']);
  });
});
