import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRdr } from '@s2u/archive';
import {
  readSealTuning, rdrReal, sealDynamics, sealLocomotion, SEAL_LOCOMOTION, SEAL_TUNING, type LocomotionBand,
} from '../src/tuning';

/**
 * A compiled `.rdr` built by hand (`packages/archive/src/rdr.ts`, 36 §6): the 12-byte head
 * `{u32 version=1; u32 string_table_size; u32 node_array_offset}`, the string table, then 8-byte nodes
 * `{u32 (type:8, ..., length:16); u32 value}` -- 1 i32, 2 f32, 3 string (offset from byte 12), 4 list
 * (the node-array byte offset of its first child; the children lie together). A JS number is written
 * as an f32, `{ i }` as an i32, so the reader sees the source's floats the way the game's files hold them.
 */
type Src = string | number | { i: number } | Src[];
function compileRdr(root: Src): Uint8Array {
  const table: number[] = [];
  const at = new Map<string, number>();
  const str = (s: string): number => {
    let ofs = at.get(s);
    if (ofs === undefined) {
      ofs = table.length; at.set(s, ofs);
      for (const c of s) table.push(c.charCodeAt(0));
      table.push(0);
    }
    return ofs;
  };
  const nodes: { type: number; length: number; value: number; f32?: number }[] = [{ type: 0, length: 0, value: 0 }];
  const place = (n: Src, slot: number): void => {
    if (Array.isArray(n)) {
      const first = nodes.length;
      for (let k = 0; k < n.length; k++) nodes.push({ type: 0, length: 0, value: 0 });
      nodes[slot] = { type: 4, length: n.length, value: first * 8 };
      n.forEach((c, k) => place(c, first + k));
    } else if (typeof n === 'string') nodes[slot] = { type: 3, length: 0, value: str(n) };
    else if (typeof n === 'number') nodes[slot] = { type: 2, length: 0, value: 0, f32: n };
    else nodes[slot] = { type: 1, length: 0, value: n.i >>> 0 };
  };
  place(root, 0);
  const nodesAt = Math.ceil((12 + table.length) / 16) * 16;
  const out = new Uint8Array(nodesAt + 8 * nodes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, table.length, true); dv.setUint32(8, nodesAt, true);
  out.set(table, 12);
  nodes.forEach((n, k) => {
    dv.setUint32(nodesAt + 8 * k, n.type | (n.length << 16), true);
    if (n.f32 !== undefined) dv.setFloat32(nodesAt + 8 * k + 4, n.f32, true);
    else dv.setUint32(nodesAt + 8 * k + 4, n.value, true);
  });
  return out;
}

describe('the SEAL tuning reader over hand-built scripts', () => {
  // Three keys, the way READERC.ZAR/dynamics.rdr spells them: a raw number, a metre height the reader
  // scales by m_scale 10 (reCOM zCharacter/char_dyn.cpp:415-416), and an aim triple.
  const three = parseRdr(compileRdr(['gravity', [{ i: 235 }], 'med_climb_height', [2.15], 'cam_first_aim', [0, 20.5, -2]]));

  it('decodes three keys: raw, metres to units at x10, and a triple', () => {
    expect(rdrReal(three, 'gravity')).toBe(235);
    // 2.15 is not an f32; the reader's rounding makes x10 read back as the table's 21.5, exactly.
    expect(rdrReal(three, 'med_climb_height', 10)).toBe(21.5);
    expect(() => rdrReal(three, 'cam_first_aim')).toThrow('cam_first_aim');
    expect(() => rdrReal(three, 'step_height')).toThrow('step_height');
  });

  it('refuses a dynamics script that lacks a key, naming it', () => {
    expect(() => sealDynamics(three)).toThrow(/dynamics\.rdr has no \w+/);
  });

  it('reads the positive seal_ bands of a motion script, at x10, with the Lateral flag and the stray tokens', () => {
    const motion = parseRdr(compileRdr(['animations', [
      ['anim_name', ['seal_stand'], 'max_velocity', [-0.1], 'looped', [{ i: 1 }], 'playback', [6]],
      ['anim_name', ['guard_walk_suspicious01'], 'max_velocity', [6.5], 'looped', [{ i: 1 }], 'playback', [1]],
      // `wa` is a stray token the game's own motion.rdr carries in seal_p_jog's record.
      ['anim_name', ['seal_run'], 'max_velocity', [6.5], 'wa', 'looped', [{ i: 1 }], 'playback', [1],
        'transition_speed_A', [4.01], 'transition_speed_B', [6.5]],
      ['anim_name', ['seal_rstrafe'], 'max_velocity', [6.5], 'looped', [{ i: 1 }], 'playback', [1], 'Lateral', [],
        'transition_speed_A', [{ i: 0 }], 'transition_speed_B', [2.8]],
      ['anim_name', ['seal_prone_rstrafe'], 'Normalize', [], 'max_velocity', [0.55], 'looped', [{ i: 1 }],
        'playback', [0.6], 'transition_speed_A', [{ i: 0 }], 'transition_speed_B', [{ i: 1 }]],
    ]]));
    expect(sealLocomotion(motion)).toEqual<LocomotionBand[]>([
      { clip: 'seal_run', maxVelocity: 65, from: 40.1, to: 65, lateral: false, playback: 1, looped: true },
      { clip: 'seal_rstrafe', maxVelocity: 65, from: 0, to: 28, lateral: true, playback: 1, looped: true },
      { clip: 'seal_prone_rstrafe', maxVelocity: 5.5, from: 0, to: 10, lateral: false, playback: 0.6, looped: true },
    ]);
  });
});

// The game's own file: the served copy first (`tools/extract-maps.ts` puts it beside the maps, W2.R5),
// then the disc tree (`SOCOM_DISC`, the repository's `game/disc`, this host's main tree).
const web = resolve(import.meta.dirname, '../../..');
const READERC = [
  resolve(web, 'public/maps/RUN/READERC.ZAR'),
  ...(process.env.SOCOM_DISC ? [resolve(process.env.SOCOM_DISC, 'RUN/READERC.ZAR')] : []),
  resolve(web, '../game/disc/RUN/READERC.ZAR'),
  'C:/projects/socom_pc/game/disc/RUN/READERC.ZAR',
].find((p) => existsSync(p));

describe.skipIf(!READERC)('the SEAL tuning off the game\'s READERC.ZAR', () => {
  const file = (): ReturnType<typeof readSealTuning> => readSealTuning(new Uint8Array(readFileSync(READERC!)));

  it('reads dynamics.rdr: the raw numbers raw, the metres as units', () => {
    const { dynamics: d } = file();
    expect(d.gravity).toBe(235);
    expect(d.stepHeight).toBe(6.5);
    expect(d.groundTouchDistance).toBe(8);
    expect(d.maxSlopeDeg).toBe(50);
    expect(d.fbAccel).toBe(0.01);
    expect(d.throtExp).toBe(1);
    expect(d.turnMaxRate).toBe(2);
    expect(d.climbHeights).toEqual([13, 21.5, 26.5]);
    expect(d.minStandHeight).toBe(10);
    expect(d.minJumpHeight).toBe(20);
    expect(d.fallingDamage).toEqual([62, 91, 120]);
    expect(d.cam.first).toEqual({ height: 20.5, dist: 13, side: 0, aim: [0, 20.5, -2] });
    expect(d.cam.full.dist).toBe(30);
    expect(d.cam.side).toEqual({ height: 19, dist: 8, side: 5, aim: [5, 19, -2] });
    expect(d.cam.peekl.side).toBe(-70);
    expect(d.tetherStiff).toBe(0.95);
    expect(d.peekDecayRate).toBe(6);
  });

  it('reads motion.rdr: the SEAL bands in units a second', () => {
    const bands = new Map(file().locomotion.map((b) => [b.clip, b]));
    const band = (clip: string): LocomotionBand => {
      const b = bands.get(clip);
      if (!b) throw new Error(`no band ${clip}`);
      return b;
    };
    expect(band('seal_run')).toMatchObject({ maxVelocity: 65, from: 40.1, to: 65 });
    expect(band('seal_jog')).toMatchObject({ maxVelocity: 65, from: 19, to: 50 });
    expect(band('seal_walk')).toMatchObject({ maxVelocity: 65, from: 0, to: 26 });
    expect(band('seal_walk_bw')).toMatchObject({ maxVelocity: 37, from: 0, to: 28 });
    expect(band('seal_run_bw')).toMatchObject({ maxVelocity: 37, from: 20, to: 37 });
    expect(band('seal_rstrafe')).toMatchObject({ maxVelocity: 65, lateral: true });
    expect(band('seal_p_rstrafe').maxVelocity).toBe(55);
    expect(band('seal_p_lstrafe').maxVelocity).toBe(50);
    expect(band('seal_crouchwalk').maxVelocity).toBe(14.8);
    expect(band('seal_crouchwalk_bw').maxVelocity).toBe(13.5);
    expect(band('seal_crouchstrafe_left').maxVelocity).toBe(15);
    expect(band('seal_prone_crawl')).toMatchObject({ maxVelocity: 11, from: 0, to: 4 });
    expect(band('seal_prone_rstrafe')).toMatchObject({ maxVelocity: 5.5, playback: 0.6 });
    expect(band('seal_climbladder').maxVelocity).toBe(13.5);
    // The idles and one-shots carry a non-positive max_velocity; the table holds only the moving bands.
    expect(bands.has('seal_stand')).toBe(false);
    expect([...bands.values()].every((b) => b.maxVelocity > 0)).toBe(true);
  });

  it('is the transcription: SEAL_TUNING and SEAL_LOCOMOTION are the file\'s, proven each run that has it', () => {
    expect(file()).toEqual({ dynamics: SEAL_TUNING, locomotion: SEAL_LOCOMOTION });
  });
});
