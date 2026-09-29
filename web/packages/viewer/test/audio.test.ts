import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import { parseSceneGraph, worldCollision } from '@s2u/scene';
import type { RenderedSound, ReverbImpulse } from '@s2u/sound';
import { GameAudio, LISTENING_GAIN_PLACEHOLDER, LOOP_SECONDS_PLACEHOLDER, panGains, type AudioOut, type LoopHandle } from '../src/audio';
import { soundFromDisc, type SoundData } from '../src/soundData';
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
});

describe.skipIf(!haveSound)('Frostfire from the fixtures (81)', () => {
  it('reads the three banks, the script, the materials, the weapons and the callbacks', async () => {
    const d = await mp2();
    expect(d.banks.filter((b) => !b.only).map((b) => b.file)).toEqual(['MP2_am.bnk', 'MP2_fx.bnk', 'MP2_vc.bnk']);
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
    expect(s.banks.filter((b) => !b.borrowed).map((b) => b.name)).toEqual(['MP2_AM', 'MP2_FX', 'MP2_VC']);
    expect(s.played).toBe(out.played.length);
    expect(s.byName['.STEP_STONE']).toBe(1);
    expect(s.dropped.range).toBe(1);
    expect(s.decoded).toBeGreaterThan(5);
    expect(out.played.every((r) => r.left.length > 0 && r.peak > 0)).toBe(true);
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
  }, 60_000);
});
