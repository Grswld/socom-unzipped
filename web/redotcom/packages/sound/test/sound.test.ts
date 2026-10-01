import { describe, it, expect } from 'vitest';
import { readZarMembers, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';
import {
  bankTone, callbackSounds, closestOnSegment, decodeVag, findReverbPresets, landingHurts, passingSound, reverbImpulse,
  SOCOM_REVERB_MODE, zanimEmitters, zanimSounds, renderLoop, renderLoopAtLeastOneVoice, globalRegister2, FootfallClock, footfallMoving, footstepSound, GRAIN, HARD_LANDING_SOUND,
  landingClass, landingSounds, landSpeeds, makeVolume, materialsFromArchive, note2Pitch, panDegrees, parseBankFile,
  parseSoils, rangeGain, renderSound, SampleCache, sdNote2Pitch, soundHash, soundNameHash, soundParams,
  soundScriptFromArchive, voiceLevel, weaponScriptFromArchive, weaponSounds, type Material, type SoundBank,
  ambienceLayers, callbackPlays, commandVolume, fireVariant, weaponGlobals, ZANIM_CAMERA_INDOORS, ZANIM_ELSEIF, ZANIM_IF,
  ZANIM_LOOP, ZANIM_PLAYER_INDOORS, ZANIM_WAIT,
} from '../src/index';

/** A deterministic `rand()` source. */
const seeded = (seed: number) => (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };

describe('decodeVag (SPU ADPCM, 81 §2)', () => {
  it('decodes the filter recurrence and stops at the end flag', () => {
    const blocks = new Uint8Array(48);
    blocks[0] = 0x0c; blocks[2] = 0x01;                     // shift 12, filter 0: first nibble 1 -> 1
    blocks[16] = 0x1c; blocks[17] = 0x04;                   // filter 1 (60/64), loop start
    blocks[32] = 0x00; blocks[33] = 0x03;                   // end, repeat
    const s = decodeVag(blocks);
    expect(s.pcm.length).toBe(84);
    expect(s.pcm[0]).toBe(1);
    expect(s.pcm[1]).toBe(0);
    expect(s.loops).toBe(true);
    expect(s.loopStart).toBe(28);
    expect(s.bytes).toBe(48);
    const neg = new Uint8Array(16); neg[0] = 0x00; neg[1] = 0x01; neg[2] = 0x08;   // shift 0: nibble 8 is -8 << 12
    expect(decodeVag(neg).pcm[0]).toBe(-32768);
    expect(decodeVag(neg).loops).toBe(false);
  });
});

describe('989snd arithmetic (research/32 §3)', () => {
  it('pitches: the centre note plays at the output rate, an octave up doubles, a PS1 tone is 44.1/48', () => {
    expect(sdNote2Pitch(60, 0, 60, 0)).toBe(0x1000);
    expect(sdNote2Pitch(60, 0, 72, 0)).toBe(0x2000);
    expect(sdNote2Pitch(60, 0, 48, 0)).toBe(0x800);
    expect(note2Pitch(-60, 0, 60, 0)).toBe(0x1000);
    expect(note2Pitch(60, 0, 60, 0)).toBe(Math.trunc((44100 * 0x1000) / 48000));
    // .STEP_STONE's tone, centre -80 fine 124: its sample is 16 kHz.
    expect((note2Pitch(-80, 124, 60, 0) / 4096) * 48000).toBeCloseTo(16000, -2);
  });
  it('makes the stereo pair and the square law', () => {
    const [l, r] = makeVolume(127, 0, 127, 0, 127, 0);
    expect(l).toBe(r);
    expect(l).toBeGreaterThan(0x5a00);
    expect(makeVolume(127, 0, 127, 90, 127, 0)[0]).toBe(0);      // 90: hard right
    expect(makeVolume(127, 0, 127, 270, 127, 0)[1]).toBe(0);     // 270: hard left
    expect(voiceLevel(0x7ffe)).toBe(0x3fff);
    expect(voiceLevel(0x3fff)).toBe(0xfff);                      // half the amplitude is a quarter of the level
  });
});

describe('the rules (81 §4-§6)', () => {
  const stone: Material = {
    index: 9, name: 'STONE', step: '.STEP_STONE', stealthStep: '.STEALTH_STONE', crawl: '.CRAWL_STONE',
    land: '.STONE_JUMP', fall: '.FALL_STONE', stealthFactor: 0.5, footStepOffset: null,
  };
  it('picks the step, the stealth step and the crawl', () => {
    expect(footstepSound(stone, 0, 1)).toBe('.STEP_STONE');
    expect(footstepSound(stone, 1, -0.8)).toBe('.STEP_STONE');
    expect(footstepSound(stone, 0, 0.5)).toBe('.STEALTH_STONE');
    expect(footstepSound(stone, 2, 1)).toBe('.CRAWL_STONE');
    expect(footstepSound(undefined, 0, 1)).toBeNull();
  });
  it('fires each foot once a cycle, the left entering the first half and the right the second', () => {
    const clock = new FootfallClock();
    const feet = [0.1, 0.2, 0.55, 0.9, 1.05, 1.3, 1.6].map((p) => clock.update(p, true));
    expect(feet).toEqual(['left', null, 'right', null, 'left', null, 'right']);
    expect(clock.update(1.7, false)).toBeNull();
    expect(clock.update(1.8, true)).toBeNull();                  // still in the half it fell in
    expect(footfallMoving(0.6, 0)).toBe(true);
    expect(footfallMoving(0.4, 0)).toBe(false);
    expect(footfallMoving(0, 0.1)).toBe(true);
  });
  it('classes a landing by its speed against sqrt(2 g d) and names its sounds', () => {
    const speeds = landSpeeds(235, [62, 91, 120]);
    expect(speeds[0]).toBeCloseTo(Math.sqrt(2 * 235 * 62), 6);
    expect(landingClass(50, speeds)).toBe(0);
    expect(landingClass(speeds[0] + 1, speeds)).toBe(1);
    expect(landingClass(speeds[1] + 1, speeds)).toBe(2);
    expect(landingClass(speeds[2], speeds)).toBe(3);
    expect(landingSounds(stone, 0)).toEqual(['.STONE_JUMP']);
    expect(landingSounds(stone, 1)).toEqual(['.STONE_JUMP']);
    expect(landingSounds(stone, 2)).toEqual([HARD_LANDING_SOUND]);
    expect(landingSounds(stone, 3)).toEqual(['.STONE_JUMP', HARD_LANDING_SOUND]);
  });
  it('falls off linearly across RANGE and pans by azimuth', () => {
    expect(rangeGain(10, [20, 200])).toBe(1);
    expect(rangeGain(110, [20, 200])).toBeCloseTo(0.5, 9);
    expect(rangeGain(201, [20, 200])).toBe(0);
    expect(panDegrees(0, 1)).toBe(0);
    expect(panDegrees(1, 0)).toBe(90);
    expect(panDegrees(-1, 0)).toBe(270);
    expect(panDegrees(0, -1)).toBe(180);
  });
  it('reads the callbacks that play a sound, through the animations they start', () => {
    // Two archives' animations; a command's bytes: play-sound (30) names its sound at +6 and its node at +16, a start
    // (45) its animation at +7, a stop (46) at +4.
    const bytes: Record<string, Uint8Array> = {};
    const cmd = (anim: string, offset: number, b: number[]): { offset: number; set: number; cmd: number } => {
      const key = `${anim}:${offset}`; const d = new Uint8Array(32); b.forEach((v, i) => { d[i] = v; }); bytes[key] = d;
      return { offset, set: 0, cmd: d[0]! };
    };
    const common = { sets: [{ name: 'common', anims: [
      { name: 'jump_whoosh', names: ['NA', 'jump_whoosh', 'dummy_node', '.JUMP_WHOOSH', 'spinehi'],
        params: { flags: 162, rootNodeIndex: 1 }, nodeRefs: [{ name: 'NA' }, { name: 'dummy_node' }, { name: 'spinehi' }],
        sequences: [{ commands: [cmd('jump_whoosh', 28, [30, 0, 0x82, 0, 0x82, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2])] }] },
      { name: 'frag_grenade', names: ['NA', 'frag_grenade', 'FRAG_sparks', '.GREN_MED'], params: { flags: 162, rootNodeIndex: 1 },
        sequences: [{ commands: [cmd('frag_grenade', 28, [45, 0, 0x52, 0, 4, 0, 0, 2]), cmd('frag_grenade', 48, [30, 0, 0x82, 0, 0x88, 0, 3, 0])] }] },
      { name: 'frag_grenade_stone', names: ['NA', 'frag_grenade_stone', 'flash', 'frag_grenade'], params: { flags: 162, rootNodeIndex: 1 },
        sequences: [{ commands: [cmd('frag_grenade_stone', 28, [45, 0, 0x52, 0, 1, 0, 0, 3])] }] },
      { name: 'seal_thud', names: ['NA', 'seal_thud', 'dummy_node'], sequences: [{ commands: [{ offset: 28, set: 0, cmd: 60 }] }] },
    ] }] };
    const mission = { sets: [{ name: 'mission', anims: [
      { name: 'fanblade1_start', names: ['NA', 'fan1', 'fanblade1_start', '~FAN_ROTATE', 'fanblade1'], params: { flags: 33, rootNodeIndex: 1 },
        nodeRefs: [{ name: 'NA' }, { name: 'fan1' }, { name: 'fanblade1' }],
        sequences: [{ commands: [cmd('fanblade1_start', 28, [30, 0, 0x82, 0, 0x82, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xf9])] }] },
      { name: 'check_camera_inside_state1', names: ['NA', 'check_camera_inside_state1', 'outside_noise', 'inside_noise'],
        params: { flags: 33, rootNodeIndex: 0 },
        sequences: [{ commands: [cmd('check_camera_inside_state1', 8, [46, 0, 0x22, 0, 2, 0, 0, 0]), cmd('check_camera_inside_state1', 16, [45, 0, 0x52, 0, 0, 0, 0, 3])] }] },
    ] }] };
    const payload = (_set: string, anim: string, offset: number, length: number): Uint8Array | null =>
      bytes[`${anim}:${offset}`]?.subarray(0, length) ?? null;
    const map = callbackSounds([common, mission], payload);
    expect(map.get('jump_whoosh')).toEqual(['.JUMP_WHOOSH']);
    expect(map.get('frag_grenade_stone')).toEqual(['.GREN_MED']);              // through frag_grenade
    expect(map.has('seal_thud')).toBe(false);
    const infos = zanimSounds([common, mission], payload);
    expect(infos.get('jump_whoosh')!.sounds).toEqual([{ sound: '.JUMP_WHOOSH', flags: 0x82, node: 'spinehi' }]);
    expect(infos.get('check_camera_inside_state1')).toMatchObject({ activation: 1, stops: ['outside_noise'], calls: ['inside_noise'] });
    expect(zanimEmitters(infos)).toEqual([{ anim: 'fanblade1_start', sound: '~FAN_ROTATE', node: 'fan1', flags: 0x282 }]);
    // Without the bytes: the first sigiled name, no calls.
    expect(callbackSounds(common).get('frag_grenade_stone')).toBeUndefined();
  });
  it('reads a play-sound command\'s offset (flag 4, the f32 triple at +0x14) and keeps it on the emitter (90 item 26)', () => {
    // Vigilance's water_drain: `30 0 0x82 0 | 0x86 0 | 5 0 | ... | node 1 at +16 | (0, -60, 30) at +0x14` -- a copy of
    // Crossroads' (whose node is `waterpipe`) naming a node `pipe` the map has not.
    const d = new Uint8Array(32);
    [30, 0, 0x82, 0, 0x86, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1].forEach((v, i) => { d[i] = v; });
    const f = new DataView(d.buffer);
    f.setFloat32(0x14, 0, true); f.setFloat32(0x18, -60, true); f.setFloat32(0x1c, 30, true);
    const mission = { sets: [{ name: 'mission', anims: [
      { name: 'water_drain', names: ['NA', 'pipe', 'water_drain', '~WATER_LEAK'], params: { flags: 33, rootNodeIndex: 2 },
        nodeRefs: [{ name: 'NA' }, { name: 'pipe' }], sequences: [{ commands: [{ offset: 8, set: 0, cmd: 30 }] }] },
    ] }] };
    const payload = (_s: string, _a: string, offset: number, length: number): Uint8Array | null => (offset === 8 ? d.subarray(0, length) : null);
    const infos = zanimSounds([mission], payload);
    expect(infos.get('water_drain')!.sounds).toEqual([{ sound: '~WATER_LEAK', flags: 0x86, node: 'pipe', offset: [0, -60, 30] }]);
    expect(zanimEmitters(infos)).toEqual([{ anim: 'water_drain', sound: '~WATER_LEAK', node: 'pipe', flags: 0x86, offset: [0, -60, 30] }]);
  });
  it('resolves a name both sets carry in the mission set first, the first of the name within a set (FUN_0026a250, FUN_0026c600)', () => {
    // Desert Glory's bytes: the common set's inside_noise loops ~INDOOR_AMB (flags 0x280); the mission set carries two
    // inside_noise, the first ~OUTDOOR_AMB at 0.6 (0x290: the volume at +8), the second ~INDOOR_AMB.
    const bytes: Record<string, Uint8Array> = {};
    const sound = (key: string, nameIndex: number, flags: number, volume: number): { offset: number; set: number; cmd: number } => {
      const d = new Uint8Array(32); d[0] = 30; d[4] = flags & 0xff; d[5] = flags >> 8; d[6] = nameIndex;
      new DataView(d.buffer).setFloat32(8, volume, true);
      bytes[key] ??= d;                                   // the ZAR's first key of the name
      return { offset: Number(key.split(':')[2]), set: 0, cmd: 30 };
    };
    const noise = (set: string, snd: string, flags: number, volume: number, at: number) => ({
      name: 'inside_noise', names: ['NA', 'inside_noise', snd], params: { flags: 0x22, rootNodeIndex: 0 },
      sequences: [{ commands: [sound(`${set}:inside_noise:${at}`, 2, flags, volume)] }],
    });
    const common = { sets: [{ name: 'common', anims: [noise('common', '~INDOOR_AMB', 0x280, 0, 72)] }] };
    const mission = { sets: [{ name: 'mission', anims: [noise('mission', '~OUTDOOR_AMB', 0x290, 0.6, 72), noise('mission', '~INDOOR_AMB', 0x280, 0, 72)] }] };
    // The payload by set: the first inside_noise's Seq_Data in each (as the ZAR's first key of the name).
    const payload = (set: string, anim: string, offset: number, length: number): Uint8Array | null =>
      bytes[`${set}:${anim}:${offset}`]?.subarray(0, length) ?? null;
    const infos = zanimSounds([common, mission], payload);
    expect(infos.get('inside_noise')!.set).toBe('mission');
    expect(infos.get('inside_noise')!.sounds).toEqual([{ sound: '~OUTDOOR_AMB', flags: 0x290, node: null, volume: Math.fround(0.6) }]);
    // A name only the common set has falls through to it; one set alone resolves in itself.
    expect(zanimSounds([common], payload).get('inside_noise')!.sounds).toEqual([{ sound: '~INDOOR_AMB', flags: 0x280, node: null }]);
  });
  it('reads a play-sound command\'s own volume (flag 0x10, the f32 at +8; FUN_002659c0) onto the callbacks and the emitters', () => {
    const d = (flags: number, nameIndex: number, volume: number, node = 0): Uint8Array => {
      const b = new Uint8Array(32); b[0] = 30; b[4] = flags & 0xff; b[5] = flags >> 8; b[6] = nameIndex; b[16] = node;
      new DataView(b.buffer).setFloat32(8, volume, true);
      return b;
    };
    const bytes: Record<string, Uint8Array> = {
      'satchel:8': d(0x92, 2, 0.5), 'flame_in_rubble1:8': d(0x292, 3, 3, 1), 'jump_whoosh:8': d(0x82, 2, 7),   // 7: no flag 0x10, ignored
    };
    const mission = { sets: [{ name: 'mission', anims: [
      { name: 'satchel', names: ['NA', 'satchel', '.MK138_SAT_CHRG'], sequences: [{ commands: [{ offset: 8, set: 0, cmd: 30 }] }] },
      { name: 'flame_in_rubble1', names: ['NA', 'fire_coals', 'flame_in_rubble1', '~FIRE_SM'], params: { flags: 33, rootNodeIndex: 1 },
        nodeRefs: [{ name: 'NA' }, { name: 'fire_coals' }], sequences: [{ commands: [{ offset: 8, set: 0, cmd: 30 }] }] },
      { name: 'jump_whoosh', names: ['NA', 'jump_whoosh', '.JUMP_WHOOSH'], sequences: [{ commands: [{ offset: 8, set: 0, cmd: 30 }] }] },
    ] }] };
    const payload = (_s: string, anim: string, offset: number, length: number): Uint8Array | null => bytes[`${anim}:${offset}`]?.subarray(0, length) ?? null;
    expect(callbackPlays([mission], payload).get('satchel')).toEqual([{ sound: '.MK138_SAT_CHRG', volume: 0.5 }]);
    expect(callbackPlays([mission], payload).get('jump_whoosh')).toEqual([{ sound: '.JUMP_WHOOSH', volume: 1 }]);
    expect(callbackSounds([mission], payload).get('satchel')).toEqual(['.MK138_SAT_CHRG']);
    expect(zanimEmitters(zanimSounds([mission], payload))).toEqual([{ anim: 'flame_in_rubble1', sound: '~FIRE_SM', node: 'fire_coals', flags: 0x292, volume: 3 }]);
    expect(commandVolume({})).toBe(1);
  });
  it('walks the camera-state scripts: the sides a script starts its animations on, their sounds, volumes and waits (81 §10)', () => {
    // Frostfire's mission check_camera_inside_state, command for command: START snd_wind_outside (no such animation),
    // WAIT 8, WHILE, IF CAMERA_INDOORS { START wind_inside, STOP wind_outside } ELSEIF !CAMERA_INDOORS { START
    // wind_outside, STOP wind_inside } ENDIF END_WHILE; and its wind_outside / wind_inside: a gust sequence each,
    // SOUND, WAIT (random: 5 + 15 U), LOOP -1.
    const bytes: Record<string, Uint8Array> = {};
    let at = 0;
    const cmd = (anim: string, b: number[], floats: [number, number][] = []): { offset: number; set: number; cmd: number; size: number } => {
      const size = Math.max(b.length, ...floats.map(([o]) => o + 4));
      const d = new Uint8Array(size); b.forEach((v, i) => { d[i] = v; });
      for (const [o, v] of floats) new DataView(d.buffer).setFloat32(o, v, true);
      const offset = (at += 32);
      bytes[`${anim}:${offset}`] = d;
      return { offset, set: 0, cmd: d[0]!, size };
    };
    const script = 'check_camera_inside_state';
    const cam = { name: script, names: ['NA', script, 'snd_wind_outside', 'windblowing', 'wind_inside', 'wind_outside'],
      params: { flags: 0x21, rootNodeIndex: 0 },
      sequences: [{ commands: [
        cmd(script, [45, 0, 0x52, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        cmd(script, [15, 0, 0x30, 0, 9, 0, 0, 0], [[8, 8]]),
        cmd(script, [39, 0, 0x22, 0, 1, 0, 0xe4, 0]),
        cmd(script, [2, 0, 0x32, 0, 1, 0, 0, 0, 66, 0, 0x12, 0]),
        cmd(script, [45, 0, 0x52, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        cmd(script, [46, 0, 0x22, 0, 5, 0, 0, 0]),
        cmd(script, [3, 0, 0x52, 0, 1, 0, 0, 0, 43, 0, 0x22, 0, 1, 0, 0, 0, 66, 0, 0x12, 0]),
        cmd(script, [45, 0, 0x52, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        cmd(script, [46, 0, 0x22, 0, 4, 0, 0, 0]),
        cmd(script, [5, 0, 0x22, 0, 1, 0, 0, 0]),
        cmd(script, [40, 0, 0x22, 0, 0, 0, 0x4c, 0]),
      ] }] };
    const wind = (name: string, volume: number) => ({
      name, names: ['NA', name, 'SND_OUTDOOR_WIND_GUST_LOOP', '.OUTDR_WND_GST2'], params: { flags: 0x22, rootNodeIndex: 0 },
      sequences: [
        { commands: [cmd(name, [30, 0, 0x82, 0, 0x90, 2, 2, 0], [[8, volume], [28, 0]])] },   // no sigil: in no bank
        { commands: [
          cmd(name, [30, 0, 0x82, 0, 0x90, 2, 3, 0], [[8, volume], [28, 0]]),
          cmd(name, [15, 0, 0x50, 0, 0x29, 0, 0, 0], [[8, 5], [12, 5], [16, 15]]),
          cmd(name, [14, 0, 0x32, 0, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]),
        ] },
      ],
    });
    const mission = { sets: [{ name: 'mission', anims: [cam, wind('wind_outside', 1), wind('wind_inside', 0.6)] }] };
    const payload = (_s: string, anim: string, offset: number, length: number): Uint8Array | null => bytes[`${anim}:${offset}`]?.subarray(0, length) ?? null;
    const layers = ambienceLayers([mission], payload);
    const gust = { sound: '.OUTDR_WND_GST2', kind: 'repeat', wait: { base: 5, range: 15 }, test: 'camera', delay: 8 };
    expect(layers.outside).toEqual([{ anim: 'wind_outside', volume: 1, ...gust }]);
    expect(layers.inside).toEqual([{ anim: 'wind_inside', volume: Math.fround(0.6), ...gust }]);
    // Without an indoors test a self-starting animation is not the ambience's.
    expect(ambienceLayers([{ sets: [{ name: 'mission', anims: [wind('wind_outside', 1)] }] }], payload)).toEqual({ outside: [], inside: [] });
    expect([ZANIM_IF, ZANIM_ELSEIF, ZANIM_LOOP, ZANIM_WAIT, ZANIM_CAMERA_INDOORS, ZANIM_PLAYER_INDOORS]).toEqual([2, 3, 14, 15, 66, 72]);
  });
  it('picks a remote round\'s fire sound by the squared distance against WEAPON_GLOBAL\'s (FUN_003d2c50)', () => {
    const med = 90 ** 2, far = 500 ** 2;                                // 9 and 50 metres at 10 units a metre
    expect(fireVariant(89.9 ** 2, med, far)).toBe(0);
    expect(fireVariant(90 ** 2, med, far)).toBe(0);                     // not over: still close
    expect(fireVariant(90.1 ** 2, med, far)).toBe(1);
    expect(fireVariant(499.9 ** 2, med, far)).toBe(1);
    expect(fireVariant(500.1 ** 2, med, far)).toBe(2);
    // The light landing's LANDSOUND carries no voice: the hurt voice is landingHurts' (the FUN_00578150 call is a meter).
    expect(landingSounds({ index: 7, name: 'STONE', step: null, stealthStep: null, crawl: null, land: '.STONE_JUMP', fall: null, stealthFactor: 1, footStepOffset: null }, 1)).toEqual(['.STONE_JUMP']);
  });
  it('hears another shooter round passing within 20 units, never the player own', () => {
    expect(passingSound([0, 0, 0], [-50, 10, 0], [50, 10, 0])).toEqual({ sound: '.BUL_PASSING', at: [0, 10, 0] });
    expect(passingSound([0, 0, 0], [-50, 25, 0], [50, 25, 0])).toBeNull();
    expect(passingSound([0, 0, 0], [-50, 60, 0], [50, 60, 0], true)?.sound).toBe('.ROCKET_BY');
    expect(closestOnSegment([5, 5, 0], [0, 0, 0], [0, 0, 0]).distance).toBeCloseTo(Math.hypot(5, 5), 9);
    expect(landingHurts(0)).toBe(false);
    expect(landingHurts(1)).toBe(true);
  });
  it('hashes names as the script files them', () => {
    expect(soundHash('.STEP_STONE')).toBe(1440126871);
    expect(soundHash('.M4A1_SIL')).toBe(-1181866505);
  });
});

const store = fixture('RUN/SOUNDS/BNKSTORE.ZAR');
const readerc = fixture('RUN/READERC.ZAR');
const soundrdr = fixture('RUN/SOUNDRDR.ZAR');
const zweapon = fixture('RUN/ZWEAPON.ZAR');

describe.skipIf(!store)('BNKSTORE.ZAR (81 §1)', () => {
  const banks = new Map<string, SoundBank>();
  const bank = (name: string): SoundBank => {
    let b = banks.get(name);
    if (!b) {
      const zar = Zar.parse(store!);
      b = parseBankFile(zar.data(zar.find(name)!));
      banks.set(name, b);
    }
    return b;
  };
  it('MP2_fx.bnk: 187 named sounds, the M4A1 SD at 101 and 102', () => {
    const fx = bank('MP2_fx.bnk');
    expect(fx.name).toBe('MP2_FX');
    expect(fx.sounds.length).toBe(187);
    expect(fx.names.size).toBe(187);
    expect(fx.names.get('.M4A1_SIL')).toBe(101);
    expect(fx.names.get('.M4A1_SIL_RLD')).toBe(102);
    expect(fx.vag.byteLength).toBe(655_072);
    // Every name sits in the bucket its hash names (snd_FindSoundByName could find it).
    for (const name of fx.names.keys()) expect(soundNameHash(name)).toBeGreaterThanOrEqual(0);
    const sil = fx.sounds[101]!;
    expect(sil.vol).toBe(80);
    expect(sil.grains.map((g) => g.type)).toEqual([GRAIN.TONE, GRAIN.TONE]);
    expect(bankTone(fx, sil.grains[0]!)).toMatchObject({ vol: 120, centerNote: -59, centerFine: 66, sampleOffset: 415_408 });
  });
  it('MP2_am.bnk: the steps, the landings and the jump', () => {
    const am = bank('MP2_am.bnk');
    expect(am.name).toBe('MP2_AM');
    for (const n of ['.JUMP_WHOOSH', '.STEP_STONE', '.STEALTH_STONE', '.STONE_JUMP', '.CRAWL_STONE', '.STEP_METAL', '.METAL_JUMP', '.STEP_GRATING', '.BONE_BRK_1']) {
      expect(am.names.has(n), n).toBe(true);
    }
    expect(am.names.get('.JUMP_WHOOSH')).toBe(0);
  });
  it('renders .M4A1_SIL: two voices, a short sharp report, not silence and not clipping', () => {
    const fx = bank('MP2_fx.bnk');
    const r = renderSound(fx, 101, new SampleCache(fx.vag), { random: seeded(1) });
    expect(r.voices).toBe(2);
    expect(r.samples).toEqual([415_408, 468_816]);
    expect(r.left.length / r.sampleRate).toBeGreaterThan(0.1);
    expect(r.left.length / r.sampleRate).toBeLessThan(1);
    expect(r.peak).toBeGreaterThan(0.02);
    expect(r.peak).toBeLessThan(1);
    // Half the volume is a quarter of the level: 989snd's square law.
    const half = renderSound(fx, 101, new SampleCache(fx.vag), { random: seeded(1), vol: 0x200 });
    expect(half.peak / r.peak).toBeGreaterThan(0.2);
    expect(half.peak / r.peak).toBeLessThan(0.3);
    // Hard right: nothing on the left.
    const right = renderSound(fx, 101, new SampleCache(fx.vag), { random: seeded(1), pan: 90 });
    expect(Math.max(...right.left.map(Math.abs))).toBe(0);
  });
  it('renders .STEP_STONE as one of its ten takes, never the same take twice running', () => {
    const am = bank('MP2_am.bnk');
    const cache = new SampleCache(am.vag), state = new Map<string, number>(), random = seeded(7);
    const picks: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = renderSound(am, am.names.get('.STEP_STONE')!, cache, { random, state });
      expect(r.voices).toBe(1);
      picks.push(r.samples[0]!);
    }
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
    expect(new Set(picks).size).toBeGreaterThan(5);
    expect(cache.size).toBe(new Set(picks).size);
  });
  it('renders a loop to its length and the reverb send of the voices that ask for it', () => {
    const am = bank('MP2_am.bnk');
    const bed = renderSound(am, am.names.get('~INDOOR_AMB')!, new SampleCache(am.vag), { random: seeded(2), loop: true, maxSeconds: 3 });
    expect(bed.left.length).toBe(3 * 48_000);
    expect(bed.sendLeft).not.toBeNull();                                        // its tones carry flags bit 0
    expect(Math.max(...bed.left.subarray(2 * 48_000).map(Math.abs))).toBeGreaterThan(0);   // still sounding at the end
    const fx = bank('MP2_fx.bnk');
    const dry = renderSound(fx, fx.names.get('.M4A1')!, new SampleCache(fx.vag), { random: seeded(2) });
    expect(dry.sendLeft).not.toBeNull();
  });
  it('renders the crickets over a long loop: their first chirp can wait 16.7 s (a local register counts the burst)', () => {
    const am = bank('MP73_am.bnk');
    const i = am.names.get('~CRICKET_1') ?? am.names.get('~CRICKET_1 ')!;
    const short = renderLoop(am, i, new SampleCache(am.vag), 12, 1, { random: () => 3900 / 32768 });
    expect(short.voices).toBe(0);
    const long = renderLoopAtLeastOneVoice(am, i, new SampleCache(am.vag), 12, 1, 40, { random: () => 3900 / 32768 });
    expect(long.voices).toBeGreaterThan(0);
    expect(long.sampleRate).toBe(24_000);
    expect(long.left.length).toBe(40 * 24_000);
    expect(long.sendLeft).toBeNull();
  });
  it('maps the camera height through the mission elevation into global register 2', () => {
    expect(globalRegister2(100, [100, 142])).toBe(-128);
    expect(globalRegister2(142, [100, 142])).toBe(127);
    expect(globalRegister2(130, [142, 100])).toBe(54);
    expect(globalRegister2(0, [50, 50])).toBe(-128);
  });
  it('reads a bank out of the store by range', async () => {
    const source = {
      list: async () => [], read: async () => store!, size: async () => store!.byteLength,
      readRange: async (_p: string, o: number, n: number) => store!.slice(o, o + n),
    };
    const got = await readZarMembers(source, 'RUN/SOUNDS/BNKSTORE.ZAR', ['MP6_am.bnk', 'MP6_fx.bnk']);
    expect(parseBankFile(got.get('MP6_am.bnk')!).names.has('.STEP_SAND')).toBe(true);
    expect(parseBankFile(got.get('MP6_fx.bnk')!).names.has('.M4A1_SIL')).toBe(true);
  });
});

describe.skipIf(!readerc)('materials.rdr (81 §4)', () => {
  it('is the engine\'s two, then SOILS in order: STONE 7, SNOW 17, SAND 5, METAL_THICK 25', () => {
    const m = materialsFromArchive(readerc!);
    expect(m.slice(0, 2).map((x) => x.name)).toEqual(['UNKNOWN', 'PARTICLE_SYSTEM']);
    expect(m[7]).toMatchObject({ name: 'STONE', step: '.STEP_STONE', stealthStep: '.STEALTH_STONE', crawl: '.CRAWL_STONE', land: '.STONE_JUMP' });
    expect(m[17]!.name).toBe('SNOW');
    expect(m[5]!.step).toBe('.STEP_SAND');
    expect(m[25]).toMatchObject({ name: 'METAL_THICK', step: '.STEP_METAL' });
    expect(m[22]).toMatchObject({ name: 'ASPHALT', step: '.STEP_STONE' });
    expect(parseSoils(['SOILS', [['OPACITY', ['1']], ['NAME', ['X'], 'STEPSOUND', ['.STEP_X']]]]).map((x) => x.name))
      .toEqual(['UNKNOWN', 'PARTICLE_SYSTEM', 'X']);            // an entry with no NAME is dropped, not a hole
  });
});

describe.skipIf(!soundrdr)('sounds.rdr (81 §3)', () => {
  it('files .STEP_STONE and .M4A1_SIL under their CRC-32 with their RANGE', () => {
    const script = soundScriptFromArchive(soundrdr!);
    expect(script.has('MP2_AM')).toBe(true);
    expect(soundParams(script, ['MP2_AM'], '.STEP_STONE')).toMatchObject({ oneShot: true, range: [30, 200] });
    expect(soundParams(script, ['MP2_AM'], '.JUMP_WHOOSH')?.range).toEqual([30, 130]);
    expect(soundParams(script, ['MP2_FX'], '.M4A1_SIL')?.range).toEqual([20, 200]);
    expect(soundParams(script, ['MP2_FX'], '.M4A1_M')).toMatchObject({ med: true });
    expect(soundParams(script, ['MP2_FX'], '.NOT_A_SOUND')).toBeNull();
  });
});

describe.skipIf(!zweapon)('zweapon.rdr sounds (81 §5)', () => {
  it('names the M4A1 SD\'s round and reload, and the M4A1\'s three distances', () => {
    const script = weaponScriptFromArchive(zweapon!);
    expect(weaponSounds(script, 'M4A1 SD')).toEqual({ name: 'M4A1 SD', fireClose: '.M4A1_SIL', fireMed: null, fireFar: null, reload: '.M4A1_SIL_RLD' });
    expect(weaponSounds(script, 'M4A1')).toMatchObject({ fireClose: '.M4A1', fireMed: '.M4A1_M', fireFar: '.M4A1_F', reload: '.M4A1_RLD' });
    expect(weaponSounds(script, 'NOPE')).toBeNull();
  });
  it('reads WEAPON_GLOBAL\'s fire sound distances: close 0, medium 9 and far 50 metres (FUN_003cd810)', () => {
    expect(weaponGlobals(weaponScriptFromArchive(zweapon!))).toEqual({ soundDistanceClose: 0, soundDistanceMed: 9, soundDistanceFar: 50 });
  });
});

const libsd = fixture('RUN/IRX/LIBSD.IRX');
describe.skipIf(!libsd)('the SPU2 reverb (81 §9)', () => {
  it('finds the libsd nine presets and rings mode 3 for about a second', () => {
    const presets = findReverbPresets(libsd!)!;
    expect(presets.length).toBe(9);
    expect(Array.from(presets[0]!.slice(0, 2))).toEqual([0x7d, 0x5b]);          // Room
    expect(Array.from(presets[SOCOM_REVERB_MODE - 1]!.slice(0, 2))).toEqual([0xb1, 0x7f]);
    const ir = reverbImpulse(presets[SOCOM_REVERB_MODE - 1]!);
    expect(ir.ll.length).toBe(ir.rr.length);
    expect(ir.ll.length / ir.sampleRate).toBeGreaterThan(0.5);
    expect(ir.ll.length / ir.sampleRate).toBeLessThan(3);
    const first = ir.ll.findIndex((x) => x !== 0);
    expect(first / 48_000).toBeGreaterThan(0.01);                               // the comb taps' pre-delay
    const energy = (x: Float32Array, a: number, b: number): number => x.subarray(a, b).reduce((n, v) => n + v * v, 0);
    expect(energy(ir.ll, 0, 9600)).toBeGreaterThan(100 * energy(ir.ll, 38_400, 48_000));   // it decays
    expect(energy(ir.lr, 0, 48_000)).toBeGreaterThan(0);                          // and crosses to the other side
    expect(findReverbPresets(new Uint8Array(4096))).toBeNull();
  });
});

describe('the one sound-name table (research 89 §11, 90 items 12 and 18)', () => {
  it('mends the data\'s slips and stands in for the casing names a map lacks', async () => {
    const { fixSoundName, soundFor, SOUND_FALLBACKS } = await import('../src/index');
    expect(fixSoundName('.BUL_CASE_METAL')).toBe('.BUL_CAS_METAL');
    expect(fixSoundName('.GREN_ASPHALT')).toBe('.GREN_STONE');
    const blood = (n: string): boolean => ['.BUL_CAS_GRASS', '.BUL_CAS_STONE', '.BUL_CAS_METAL'].includes(n);
    expect(soundFor('.BUL_CASE_METAL', blood)).toBe('.BUL_CAS_METAL');
    expect(soundFor('.BUL_CAS_DIRT', blood)).toBe('.BUL_CAS_GRASS');
    expect(soundFor('.BUL_CAS_WOOD', blood)).toBe('.BUL_CAS_WOOD');       // none held, none stood in
    expect(soundFor('.GREN_ASPHALT', (n) => n === '.GREN_STONE')).toBe('.GREN_STONE');
    expect(SOUND_FALLBACKS['.SG_SHELL_TIN']).toEqual(['.SG_SHELL_METAL']);
    expect(SOUND_FALLBACKS['.SG_SHELL_SAND']).toEqual(['.BUL_CAS_SAND', '.SG_SHELL_STONE']);
  });
});
