import { describe, it, expect } from 'vitest';
import { readZarMembers, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';
import {
  bankTone, callbackSounds, closestOnSegment, decodeVag, findReverbPresets, landingHurts, passingSound, reverbImpulse,
  SOCOM_REVERB_MODE, zanimEmitters, zanimSounds, FootfallClock, footfallMoving, footstepSound, GRAIN, HARD_LANDING_SOUND,
  landingClass, landingSounds, landSpeeds, makeVolume, materialsFromArchive, note2Pitch, panDegrees, parseBankFile,
  parseSoils, rangeGain, renderSound, SampleCache, sdNote2Pitch, soundHash, soundNameHash, soundParams,
  soundScriptFromArchive, voiceLevel, weaponScriptFromArchive, weaponSounds, type Material, type SoundBank,
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
