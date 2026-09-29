import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import { parseSceneGraph, worldCollision } from '@s2u/scene';
import type { RenderedSound, ReverbImpulse } from '@s2u/sound';
import { GameAudio, LISTENING_GAIN_PLACEHOLDER, LOOP_SECONDS_PLACEHOLDER, panGains, WebAudioOut, type AudioOut, type LoopHandle } from '../src/audio';
import { emitterPosition, loopKey, renderAmbienceLoops, soundFromDisc, type SoundData } from '../src/soundData';
import { WalkSounds, type WalkSignals } from '../src/walkSounds';
import type { AnimStats } from '../src/animator';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const haveSound = existsSync(resolve(fixtures, 'RUN/SOUNDS/BNKSTORE.ZAR')) && existsSync(resolve(fixtures, 'RUN/MP2.ZDB'));

/** An output that records what it was handed. */
class Recorder implements AudioOut {
  unlocked = false;
  gain = -1;
  played: RenderedSound[] = [];
  reverb: ReverbImpulse | null = null;
  ramps: [number, number][] = [];
  loops: { sound: RenderedSound; gains: [number, number]; stopped: boolean }[] = [];
  get state(): string { return this.unlocked ? 'running' : 'locked'; }
  unlock(): void { this.unlocked = true; }
  setGain(gain: number): void { this.gain = gain; }
  play(sound: RenderedSound): void { this.played.push(sound); }
  setReverb(ir: ReverbImpulse | null): void { this.reverb = ir; }
  rampReverb(depth: number, seconds: number): void { this.ramps.push([depth, seconds]); }
  loop(sound: RenderedSound): LoopHandle {
    const l = { sound, gains: [0, 0] as [number, number], stopped: false };
    this.loops.push(l);
    return { setGains: (left, right) => { l.gains = [left, right]; }, stop: () => { l.stopped = true; } };
  }
}

const seeded = (seed: number) => (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
/** A camera at the origin looking down -z (three.js's identity world matrix). */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const STONE = 7;

let data: SoundData | null | undefined;
async function mp2(): Promise<SoundData> {
  if (data === undefined) data = await soundFromDisc(new FsAssetSource(fixtures), 'RUN/MP2.ZDB', 'MP2');
  if (!data) throw new Error('no sound data');
  return data;
}

describe('a tree with no sound archives', () => {
  it('says so in the stats and warns once', async () => {
    const empty = mkdtempSync(resolve(tmpdir(), 's2u-nosound-'));
    const d = await soundFromDisc(new FsAssetSource(empty), 'RUN/MP2.ZDB', 'MP2');
    expect(d.banks).toEqual([]);
    expect(d.missing[0]).toMatch(/^RUN\/SOUNDS\/BNKSTORE\.ZAR: /);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const audio = new GameAudio(new Recorder());
    audio.setData(d);
    audio.setData(d);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(audio.stats().missing[0]).toMatch(/BNKSTORE/);
    expect(audio.onFootstep(7, null)).toBeNull();
  });
});

describe('where an emitter sounds (SOUND, FUN_002659c0; research 90 item 26)', () => {
  it('takes its offset through its node, or, when the scene has no such node, as a world position', () => {
    // A node turned a quarter about y (column-major, as flattenScene gives it) at (100, 5, -40).
    const world = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 100, 5, -40, 1];
    expect(emitterPosition(world, [0, -60, 30])).toEqual([130, -55, -40]);
    expect(emitterPosition(world, undefined)).toEqual([100, 5, -40]);
    // Vigilance's `pipe`: no node -- the game's flag 4 offset is the place (0, -60, 30).
    expect(emitterPosition(null, [0, -60, 30])).toEqual([0, -60, 30]);
    // No node and no offset: the game plays it without a place, which the emitters do not model.
    expect(emitterPosition(null, undefined)).toBeNull();
  });
});

describe('the output controls', () => {
  it('sets the gain from the volume and the mute', () => {
    const out = new Recorder(), audio = new GameAudio(out);
    expect(out.gain).toBe(LISTENING_GAIN_PLACEHOLDER);
    audio.setVolume(0.5);
    expect(out.gain).toBe(LISTENING_GAIN_PLACEHOLDER / 2);
    audio.setMuted(true);
    expect(out.gain).toBe(0);
    expect(audio.stats()).toMatchObject({ muted: true, volume: 0.5, unlocked: false, state: 'locked', banks: [] });
    audio.setMuted(false);
    expect(out.gain).toBe(LISTENING_GAIN_PLACEHOLDER / 2);
  });
  it('unlocks on the first gesture', () => {
    const out = new Recorder(), audio = new GameAudio(out), target = new EventTarget();
    audio.unlockOn(target);
    target.dispatchEvent(new Event('keydown'));
    expect(audio.stats().unlocked).toBe(true);
  });
  it('makes the output at page start, off the gesture, so a click before the banks only resumes it (90 item 27)', () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const out = new (class extends Recorder {
        ready = false;
        prepare(): void { calls.push('prepare'); this.ready = true; }
        override unlock(): void { calls.push(this.ready ? 'resume' : 'make'); super.unlock(); }
      })();
      const audio = new GameAudio(out), target = new EventTarget();
      audio.unlockOn(target);
      expect(calls).toEqual([]);                          // not inside the page's first synchronous work
      vi.runAllTimers();
      expect(calls).toEqual(['prepare']);                 // before any map's banks (no setData yet)
      target.dispatchEvent(new Event('pointerdown'));
      expect(calls).toEqual(['prepare', 'resume']);
      expect(audio.stats().unlocked).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  /**
   * `unlocked` is "the context runs", not "a gesture was seen": a touch `pointerdown` or an Escape is no user activation
   * in Chromium, so its `resume()` stays pending until a later event; plays until then are counted as locked, and a
   * rejected resume is warned once and kept in the stats.
   */
  class StubContext {
    static last: StubContext | null = null;
    state = 'suspended';
    sampleRate = 48_000;
    currentTime = 0;
    destination = {};
    settle: { resolve: () => void; reject: (e: unknown) => void } | null = null;
    constructor() { StubContext.last = this; }
    private node() { return { gain: { value: 1, setTargetAtTime() {}, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createGain() { return this.node(); }
    resume(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        this.settle = { resolve: () => { this.state = 'running'; resolve(); }, reject };
      });
    }
  }
  const withContext = async (run: () => Promise<void>): Promise<void> => {
    const g = globalThis as unknown as { AudioContext?: unknown };
    const was = g.AudioContext;
    g.AudioContext = StubContext;
    try { await run(); } finally { g.AudioContext = was; }
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('is unlocked only once the context runs: a pending resume leaves it locked (web platform; 81 section 8)', () => withContext(async () => {
    const out = new WebAudioOut(), audio = new GameAudio(out), target = new EventTarget();
    audio.unlockOn(target);
    target.dispatchEvent(new Event('pointerdown'));
    expect(audio.stats()).toMatchObject({ unlocked: false, state: 'suspended' });
    StubContext.last!.settle!.resolve();
    await tick();
    expect(audio.stats()).toMatchObject({ unlocked: true, state: 'running' });
  }));

  it('warns once when a resume is refused, keeps the reason in the stats and stays locked', () => withContext(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const out = new WebAudioOut(), audio = new GameAudio(out), target = new EventTarget();
      audio.unlockOn(target);
      target.dispatchEvent(new Event('keydown'));
      StubContext.last!.settle!.reject(new Error('not allowed'));
      await tick();
      target.dispatchEvent(new Event('keydown'));
      StubContext.last!.settle!.reject(new Error('not allowed'));
      await tick();
      expect(audio.stats().unlocked).toBe(false);
      expect(audio.stats().resumeError).toMatch(/not allowed/);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  }));
});

describe.skipIf(!haveSound)('Frostfire from the fixtures (81)', () => {
  it('reads the three banks, the script, the materials, the weapons and the callbacks', async () => {
    const d = await mp2();
    // The map's three and HUDUI, which the game loads with every map (FUN_00344450: HUDUI, SMUS, TCM_ECHO, then the
    // map's; only HUDUI is on the disc): the night vision's `.NV_GOGGLES_ON/_OFF` are its (research 90 item 24).
    expect(d.banks.filter((b) => !b.only).map((b) => b.file)).toEqual(['MP2_am.bnk', 'MP2_fx.bnk', 'MP2_vc.bnk', 'HUDUI.bnk']);
    // About 1.9 MB of the store's 67 for Frostfire (81 s1: 986,408 + 687,344 + 176,088 B, and HUDUI's): never the
    // "1.1-1.4 MB" an older summary said.
    expect(d.banks.filter((b) => !b.only).reduce((n, b) => n + b.bytes.byteLength, 0)).toBeGreaterThan(1_849_840);
    // Borrowed (PLACEHOLDER): the tin steps Frostfire's METAL_THIN floors ask for, the metal bounce of a grenade.
    expect(d.banks.find((b) => b.only?.includes('.STEP_TIN'))).toBeDefined();
    expect(d.banks.some((b) => b.only?.includes('.GREN_METAL'))).toBe(true);
    // Nothing wanted is missing (research 90 item 18): the casing names go through the one name table (`@s2u/sound`) --
    // shell_eject's `.BUL_CASE_METAL` is the banks' `.BUL_CAS_METAL`, and the shotgun's `.SG_SHELL_TIN` (MP8's and
    // MP61's banks, past the borrowing's reach here) stands in as the map's `.SG_SHELL_METAL`.
    expect(d.missing).toEqual([]);
    expect(new Map(d.params).get('.STEP_STONE')?.range).toEqual([30, 200]);
    expect(d.materials[STONE]!.step).toBe('.STEP_STONE');
    expect(d.weapons.find((w) => w.name === 'M4A1 SD')).toMatchObject({ fireClose: '.M4A1_SIL', reload: '.M4A1_SIL_RLD' });
    expect(new Map(d.callbacks).get('jump_whoosh')).toEqual(['.JUMP_WHOOSH']);
    expect(new Map(d.callbacks).get('ladder_rung')).toEqual(['.STEP_LADDER']);
    expect(new Map(d.callbacks).get('RPG_impact')).toEqual(['.EXP_1', '.GREN_FAR']);
    // Load-bound, not logic-bound: the first `mp2()` reads Frostfire's ZDB and its three sound banks off the fixtures.
    // Solo 0.57 s (vitest --maxWorkers=2, 2026-09-29). It passed alone and timed out at the default 5 s in
    // full-suite runs on a loaded host: a slow-down past 8x, which solo x 6 (3.4 s) would not cover, so
    // the budget is solo x ~26 -- this test's alone; the suite keeps the default.
  }, 15_000);

  it('plays the game\'s sound for each event, once unlocked', async () => {
    const out = new Recorder(), audio = new GameAudio(out, seeded(3));
    audio.setData(await mp2());
    audio.setFallTable(235, [62, 91, 120]);
    audio.setListener(IDENTITY);
    expect(audio.onFootstep(STONE, [0, 0, -10])).toBeNull();          // locked: counted, not played
    expect(audio.stats().dropped.locked).toBe(1);
    out.unlock();
    expect(audio.onFootstep(STONE, [0, 0, -10])).toBe('.STEP_STONE');
    expect(audio.onFootstep(STONE, [0, 0, -10], { stick: 0.3 })).toBe('.STEALTH_STONE');
    expect(audio.onFootstep(STONE, [0, 0, -10], { stance: 2 })).toBe('.CRAWL_STONE');
    expect(audio.onFootstep(0, [0, 0, -10])).toBe('.STEP_METAL');      // 0: the map's DefaultMaterial, METAL_THICK
    expect(audio.onFootstep(3, [0, 0, -10])).toBeNull();               // INVISIBLE_DI: no step sound
    expect(audio.onFootstep(STONE, [0, 0, -500])).toBeNull();          // past the step's RANGE (200)
    expect(audio.onFire('M4A1 SD', [0, 0, -5])).toBe('.M4A1_SIL');
    expect(audio.onReload('M4A1 SD')).toBe('.M4A1_SIL_RLD');
    expect(audio.onJump([0, 0, -5])).toBe('.JUMP_WHOOSH');
    expect(audio.onLand(80, STONE, [0, 0, -5])).toEqual(['.STONE_JUMP']);
    expect(audio.onLand(220, STONE, [0, 0, -5])).toEqual(['.BONE_BRK_1', '.SEAL_DAMAGE']);   // hurt: the damage voice
    expect(audio.onLand(400, STONE, [0, 0, -5])).toEqual(['.STONE_JUMP', '.BONE_BRK_1', '.SEAL_DAMAGE']);
    expect(audio.onAnimCallback('shotgun_pump')).toBe('.SHOTGUN_COCK');
    const s = audio.stats();
    expect(s.map).toBe('MP2');
    expect(s.banks.filter((b) => !b.borrowed).map((b) => b.name)).toEqual(['MP2_AM', 'MP2_FX', 'MP2_VC', 'HUDUI']);
    expect(s.played).toBe(out.played.length);
    expect(s.byName['.STEP_STONE']).toBe(1);
    expect(s.dropped.range).toBe(1);
    expect(s.decoded).toBeGreaterThan(5);
    expect(out.played.every((r) => r.left.length > 0 && r.peak > 0)).toBe(true);
    // The goggles, played without a place as the game does (vtable+0xc, decomp 410944/410948).
    expect(audio.play('.NV_GOGGLES_ON')).toBe(true);
    expect(audio.play('.NV_GOGGLES_OFF')).toBe(true);
  });

  it('pans a source by its azimuth and fades it over its RANGE', async () => {
    const out = new Recorder(), audio = new GameAudio(out, seeded(5));
    audio.setData(await mp2());
    audio.setListener(IDENTITY);
    out.unlock();
    const energy = (a: Float32Array): number => a.reduce((n, v) => n + v * v, 0);
    audio.play('.M4A1_SIL', [10, 0, 0]);                                // to the right
    const right = out.played.at(-1)!;
    expect(energy(right.left)).toBe(0);
    expect(energy(right.right)).toBeGreaterThan(0);
    audio.play('.M4A1_SIL', [0, 0, -110]);                              // ahead, half way through 20-200
    const far = out.played.at(-1)!;
    audio.play('.M4A1_SIL', [0, 0, -10]);
    const near = out.played.at(-1)!;
    expect(audio.stats().recent.at(-2)).toMatchObject({ name: '.M4A1_SIL', vol: 512, pan: 0 });
    expect(far.peak / near.peak).toBeGreaterThan(0.2);                // half the volume is a quarter of the level
    expect(far.peak / near.peak).toBeLessThan(0.3);
    expect(audio.play('.NOT_IN_A_BANK')).toBe(false);
    expect(audio.stats().dropped.unknown).toBe(1);
  });

  it('turns the body events and the rifle events into footfalls, the whoosh, a landing, rounds and a reload', async () => {
    const out = new Recorder(), audio = new GameAudio(out, seeded(9));
    audio.setData(await mp2());
    audio.setFallTable(235, [62, 91, 120]);
    out.unlock();
    const signals: WalkSignals = {
      walking: () => true,
      feet: () => [0, 0, 0],
      stance: () => 'stand',
      wish: () => ({ forward: 1, right: 0 }),
      grid: () => null,                                                // no hull: material 0, silent steps
    };
    const sounds = new WalkSounds(audio, signals);
    sounds.material = () => STONE;                                     // stone under the feet
    for (let i = 0; i < 8; i++) sounds.playEvent({ kind: 'footfall', foot: i % 2 ? 'right' : 'left', clip: 'seal_run', position: [0, 0.5, 0] });
    sounds.playEvent({ kind: 'callback', clip: 'seal_jump', name: 'jump_whoosh', phase: 0.42 });
    sounds.playEvent({ kind: 'land', speed: 90, clip: 'land' });
    const weapon = { name: 'M4A1 SD', id: 62, fireAnim: 'muzzle_m4SD', sounds: { close: '.M4A1_SIL', med: null, far: null, reload: '.M4A1_SIL_RLD' } };
    for (let i = 0; i < 3; i++) sounds.fireEvent({ type: 'round', weapon, from: [0, 15, -3], to: [0, 15, -100], hit: false, rounds: 29 - i });
    sounds.fireEvent({ type: 'reloadStart', weapon, seconds: 1.6 });
    expect(sounds.counts).toEqual({ footfalls: 8, callbacks: 1, landings: 1, rounds: 3, reloads: 1 });
    const s = audio.stats();
    expect(s.byName['.STEP_STONE']).toBe(8);
    expect(s.byName['.JUMP_WHOOSH']).toBe(1);
    expect(s.byName['.STONE_JUMP']).toBe(1);
    expect(s.byName['.M4A1_SIL']).toBe(3);
    expect(s.byName['.M4A1_SIL_RLD']).toBe(1);
  });

  it('hears material 0 as the map DefaultMaterial, follows zAnim calls, and hurts on a hard landing', async () => {
    const d = await mp2();
    expect(d.materials[d.defaultMaterial]!.name).toBe('METAL_THICK');
    const out = new Recorder(), audio = new GameAudio(out, seeded(4));
    audio.setData(d);
    audio.setFallTable(235, [62, 91, 120]);
    out.unlock();
    expect(audio.onFootstep(0, null)).toBe('.STEP_METAL');
    expect(audio.stats().defaultMaterial).toBe('METAL_THICK');
    expect(new Map(d.callbacks).get('frag_grenade_stone')).toEqual(['.GREN_MED']);   // through frag_grenade
    expect(audio.onAnimCallback('frag_grenade_stone')).toBe('.GREN_MED');
    expect(d.damageVoice).toBe('.SEAL_DAMAGE');
    expect(audio.onLand(100, 0)).toEqual(['.METAL_JUMP']);
    expect(audio.onLand(190, 0)).toEqual(['.METAL_JUMP', '.SEAL_DAMAGE']);
    expect(audio.onLand(220, 0)).toEqual(['.BONE_BRK_1', '.SEAL_DAMAGE']);
  });

  it('hears a grenade on asphalt: grenade_hit_asphalt calls .GREN_ASPHALT, which no bank holds, played as .GREN_STONE', async () => {
    const d72 = await soundFromDisc(new FsAssetSource(fixtures), 'RUN/MP72.ZDB', 'MP72');
    expect(new Map(d72.callbacks).get('grenade_hit_asphalt')).toEqual(['.GREN_ASPHALT']);
    const out = new Recorder(), audio = new GameAudio(out, seeded(2));
    audio.setData(d72);
    out.unlock();
    // The name played, through the one name table (`@s2u/sound`'s `soundFor`): the stone's bounce.
    expect(audio.onAnimCallback('grenade_hit_asphalt')).toBe('.GREN_STONE');
    expect(audio.has('.BUL_CASE_METAL')).toBe(true);                               // the misspelt casing, mended
    // Load-bound, not logic-bound: it reads Crossroads' ZDB (MP72) and its banks off the fixtures.
    // Solo 0.57 s (vitest --maxWorkers=2, 2026-09-29). It passed alone and timed out at the default 5 s in
    // full-suite runs on a loaded host: a slow-down past 8x, which solo x 6 (3.4 s) would not cover, so
    // the budget is solo x ~26 -- this test's alone; the suite keeps the default.
  }, 15_000);

  it('picks a remote round by WEAPON_GLOBAL distance: close to 90 units, medium to 500, far beyond (FUN_003d2c50)', async () => {
    const d = await mp2();
    expect(d.fireDistances).toEqual({ close: 0, med: 90, far: 500 });     // 0, 9, 50 m at 10 units a metre
    const out = new Recorder(), audio = new GameAudio(out, seeded(3));
    audio.setData(d);
    audio.setListener(IDENTITY);
    out.unlock();
    expect(audio.onFire('M4A1', [0, 0, -50])).toBe('.M4A1');
    expect(audio.onFire('M4A1', [0, 0, -100])).toBe('.M4A1_M');
    expect(audio.onFire('M4A1', [0, 0, -600])).toBe('.M4A1_F');
    const range = audio.stats().dropped.range;
    expect(audio.onFire('M4A1', [0, 0, -1800])).toBeNull();             // the far sound's own RANGE (85-1700)
    expect(audio.stats().dropped.range).toBe(range + 1);
    // The M4A1 SD has no FireSoundMed/Far: its slots are empty and an empty slot plays nothing -- no fall back to the
    // close sound. PLAUSIBLE: the empty name's lookup to a null handle (FUN_00344f30) was not read to the end.
    expect(audio.onFire('M4A1 SD', [0, 0, -80])).toBe('.M4A1_SIL');
    expect(audio.onFire('M4A1 SD', [0, 0, -150])).toBeNull();
  });

  it('plays a zAnim sound at its command volume (flag 0x10, FUN_002659c0): the app volume is 0x400 x volume', async () => {
    const d = await mp2();
    const out = new Recorder(), audio = new GameAudio(out, seeded(3));
    audio.setData(d);
    audio.setListener(IDENTITY);
    out.unlock();
    audio.play('.M4A1_SIL', [0, 0, -10], 'play', 0.5);
    expect(audio.stats().recent.at(-1)).toMatchObject({ name: '.M4A1_SIL', vol: 0x200 });
    // The flashbang's zAnim plays its bang at 2.0 (common set, every map).
    expect(new Map(d.callbackVolumes).get('flashcrash_grenade')?.[new Map(d.callbacks).get('flashcrash_grenade')!.indexOf('.MARK_141_FLASH')]).toBe(2);
    expect(new Map(d.callbackVolumes).get('jump_whoosh')).toEqual([1]);
    expect(audio.onAnimCallback('flashcrash_grenade')).toBe('.MARK_141_FLASH');     // played without a place: 0x400 x 2
    expect(audio.stats().recent.at(-1)).toMatchObject({ name: '.MARK_141_FLASH', vol: 0x800 });
  });

  it('walks Frostfire\'s camera-state scripts: the beds on PLAYER_INDOORS, the wind gusts on CAMERA_INDOORS after 8 s (81 s10)', async () => {
    const d = await mp2();
    const gust = (sound: string, volume: number, base: number, range: number) =>
      ({ anim: volume === 1 ? 'wind_outside' : 'wind_inside', sound, volume, kind: 'repeat', wait: { base, range }, test: 'camera', delay: 8 });
    // The mission's scripts in its order: check_camera_inside_state (the wind), then check_camera_inside_state1 (the beds).
    expect(d.layers!.outside).toEqual([
      gust('.OUTDR_WND_GST2', 1, 5, 15), gust('.OUTDR_WND_GST3', 1, 2, 14),
      { anim: 'outside_noise', sound: '~OUTDOOR_AMB', volume: 1, kind: 'loop', test: 'player', delay: 0 },
    ]);
    expect(d.layers!.inside).toEqual([
      gust('.OUTDR_WND_GST2', Math.fround(0.6), 5, 15), gust('.OUTDR_WND_GST3', Math.fround(0.6), 2, 14),
      { anim: 'inside_noise', sound: '~INDOOR_AMB', volume: 1, kind: 'loop', test: 'player', delay: 0 },
    ]);
    expect(d.emitters.some((e) => /OUTDR_WND/.test(e.sound))).toBe(false);
    // Played: nothing for 8 s, then each gust at once and again after its wait, at its volume, without a place.
    let now = 0;
    const out = new Recorder(), audio = new GameAudio(out, () => 0.5, { now: () => now });
    audio.setData(d);
    out.unlock();
    audio.setAmbience(true);
    audio.setEnvironment(false, 0);
    audio.pump(1e9);
    const gusts = (): { name: string; vol: number }[] => audio.stats().recent.filter((r) => r.event === 'ambience');
    now = 7.9; audio.setListener(IDENTITY);
    expect(gusts()).toEqual([]);
    now = 8; audio.setListener(IDENTITY);
    expect(gusts().map((g) => [g.name, g.vol])).toEqual([['.OUTDR_WND_GST2', 0x400], ['.OUTDR_WND_GST3', 0x400]]);
    now = 8 + 2 + 14 * 0.5; audio.setListener(IDENTITY);                  // GST3's wait at U = 0.5: 9 s
    expect(gusts().length).toBe(3);
    // Indoors the script stops wind_outside and starts wind_inside: its gusts at once, at 0.6.
    audio.setEnvironment(true, 0);
    audio.setListener(IDENTITY);
    expect(gusts().slice(3).map((g) => [g.name, g.vol])).toEqual([['.OUTDR_WND_GST2', Math.round(0x400 * Math.fround(0.6))], ['.OUTDR_WND_GST3', Math.round(0x400 * Math.fround(0.6))]]);
  });

  it('resolves Desert Glory\'s indoor bed in the mission set: ~OUTDOOR_AMB at 0.6, not the common ~INDOOR_AMB (FUN_0026a250)', async () => {
    const d6 = await soundFromDisc(new FsAssetSource(fixtures), 'RUN/MP6.ZDB', 'MP6');
    expect(d6.beds).toEqual({ outside: ['~OUTDOOR_AMB'], inside: ['~OUTDOOR_AMB'] });
    expect(d6.layers!.inside).toEqual([{ anim: 'inside_noise', sound: '~OUTDOOR_AMB', volume: Math.fround(0.6), kind: 'loop', test: 'player', delay: 0 }]);
    expect((await mp2()).beds.inside).toEqual(['~INDOOR_AMB']);
    // Its fires sound at the command's 3.0 (flag 0x10), rendered at that volume: one loop per sound and volume.
    expect(d6.emitters.filter((e) => e.anim === 'flame_in_rubble1').map((e) => [e.sound.trim(), e.volume])).toEqual([['~FIRE_SM', 3]]);
    const loops = renderAmbienceLoops(d6, 1, 0.1);
    const names = loops.map((l) => l.name);
    expect(names).toContain('~OUTDOOR_AMB');
    expect(names).toContain(loopKey('~OUTDOOR_AMB', Math.fround(0.6)));
    const peak = (n: string): number => loops.find((l) => l.name === n)!.sound.peak;
    expect(peak(loopKey('~OUTDOOR_AMB', Math.fround(0.6)))).toBeLessThan(peak('~OUTDOOR_AMB'));
  }, 30_000);

  it('plays .BUL_PASSING at the nearest point of another shooter round within 20 units', async () => {
    const out = new Recorder(), audio = new GameAudio(out, seeded(6));
    audio.setData(await mp2());
    audio.setListener(IDENTITY);
    out.unlock();
    expect(audio.onRoundPast([-100, 5, 0], [100, 5, 0], [0, 0, 0])).toBe('.BUL_PASSING');
    expect(audio.stats().recent.at(-1)).toMatchObject({ name: '.BUL_PASSING', event: 'passing' });
    expect(audio.onRoundPast([-100, 30, 0], [100, 30, 0], [0, 0, 0])).toBeNull();
  });

  it('ramps the reverb to the mission zone depth and crosses the beds as the camera goes in', async () => {
    const d = await mp2();
    expect(d.reverb.preset?.slice(0, 2)).toEqual([0xb1, 0x7f]);                // libsd mode 3, "Studio Medium"
    expect(d.reverb.indoor).toEqual([[0.45, 1], [0.2, 1]]);                    // the first of the two keys
    expect(d.reverb.outdoor).toEqual([[0.07, 1], [0.2, 1]]);
    expect(d.beds).toEqual({ outside: ['~OUTDOOR_AMB'], inside: ['~INDOOR_AMB'] });
    expect(d.emitters.map((e) => [e.sound.trim(), e.node])).toEqual([['~FAN_ROTATE', 'fan1']]);
    const out = new Recorder(), audio = new GameAudio(out, seeded(8));
    out.unlock();                                                                    // the reverb is built once unlocked
    audio.setData(d);
    audio.setListener(IDENTITY);
    audio.setAmbience(true);
    audio.setEnvironment(false, 0);
    expect(out.loops.length).toBe(0);                                              // queued, not built on the gesture
    audio.pump(1e9);
    expect(audio.stats().timing.pending).toBe(0);
    expect(out.reverb!.ll.length).toBeGreaterThan(24_000);
    expect(out.ramps.at(-1)).toEqual([0.07, 1]);
    audio.setEnvironment(true, 0);
    expect(out.ramps.at(-1)).toEqual([0.45, 1]);
    audio.setEnvironment(true, 5);                                                   // no such entry: off over a second
    expect(out.ramps.at(-1)).toEqual([0, 1]);
    const [outside, inside, fan] = out.loops;
    expect(out.loops.length).toBe(3);
    expect(outside!.sound.left.length).toBe(LOOP_SECONDS_PLACEHOLDER * 48_000);
    expect(inside!.gains).toEqual([1, 1]);
    expect(outside!.gains).toEqual([0, 0]);
    expect(audio.stats().ambience).toMatchObject({ on: true, bed: 'inside' });
    // The fan: heard by its RANGE from where it stands; far away, nothing.
    const fanAt = d.emitters[0]!.position;
    audio.setListener([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, fanAt[0], fanAt[1], fanAt[2] + 10, 1]);
    expect(fan!.gains[0]).toBeGreaterThan(0.5);
    audio.setListener(IDENTITY);
    expect(fan!.gains).toEqual([0, 0]);
    audio.setAmbience(false);
    expect(out.loops.every((l) => l.stopped)).toBe(true);
    expect(panGains(90)[0]).toBe(0);
    expect(panGains(0)).toEqual([1, 1]);
  });
});

/**
 * Every map's floors step (the feel-QA's Crossroads, research 81 §4): each polygon a SEAL stands on, its material (byte 0
 * the map's DefaultMaterial), has its step, stealth, crawl and landing sound in the map's banks or a borrowed one. The
 * three fixture maps always; all 22 when the served tree is extracted.
 */
const served = resolve(fixtures, '../public/maps');
const everyMap = [
  ...['MP2', 'MP6', 'MP72'].filter((m) => existsSync(resolve(fixtures, `RUN/${m}.ZDB`))).map((m) => ({ dir: fixtures, map: m })),
  ...(existsSync(resolve(served, 'RUN/SOUNDS/BNKSTORE.ZAR'))
    ? readdirSync(resolve(served, 'RUN')).filter((f) => /^MP\d+\.ZDB$/.test(f) && !['MP2.ZDB', 'MP6.ZDB', 'MP72.ZDB'].includes(f))
      .map((f) => ({ dir: served, map: f.replace('.ZDB', '') }))
    : []),
];
describe.skipIf(!haveSound)('every map steps on every floor', () => {
  it.each(everyMap)('$map', async ({ dir, map }) => {
    const source = new FsAssetSource(dir);
    const d = await soundFromDisc(source, `RUN/${map}.ZDB`, map);
    expect(d.banks.length).toBeGreaterThanOrEqual(3);
    const out = new Recorder(), audio = new GameAudio(out, seeded(1));
    audio.setData(d);
    out.unlock();
    const zdb = new Uint8Array(readFileSync(resolve(dir, `RUN/${map}.ZDB`)));
    const polys = worldCollision(parseSceneGraph(Zar.parse(zdbMember(zdb, parseZdb(zdb), `${map}_GEO.ZED`))));
    const silent = new Map<string, number>();
    for (const m of new Set(polys.filter((p) => p.ditype & 1).map((p) => p.material))) {
      const mat = audio.materialOf(m);
      if (!mat?.step) continue;                                    // INVISIBLE_DI, BARREL ...: no step sound in SOILS
      for (const stance of [0, 2] as const) {
        const got = audio.onFootstep(m, null, { stance });
        if (!got) silent.set(`${mat.name}/${stance}`, (silent.get(`${mat.name}/${stance}`) ?? 0) + 1);
      }
      if (audio.onLand(50, m).length === 0 && mat.land) silent.set(`${mat.name}/land`, 1);
    }
    expect([...silent.keys()]).toEqual([]);
    // No casing name is missing: the data's slip is mended and a shell no bank reached stands in (research 90 item 18).
    expect(d.missing.filter((x) => /no bank holds/.test(x))).toEqual([]);
    // Nothing is missing at all (research 90 item 26): an emitter whose node the scene lacks plays where the game plays
    // it, and a DefaultMaterial no SOILS entry spells is the game's UNKNOWN (FUN_002de9e0 answers 0), not an error.
    expect(d.missing).toEqual([]);
    // The goggles' sounds are HUDUI's, a bank the game loads with every map (FUN_00344450; research 90 item 24).
    expect(audio.has('.NV_GOGGLES_ON') && audio.has('.NV_GOGGLES_OFF')).toBe(true);
  }, 60_000);
});
