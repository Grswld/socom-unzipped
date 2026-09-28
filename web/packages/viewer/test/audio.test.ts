import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import type { RenderedSound } from '@s2u/sound';
import { GameAudio, LISTENING_GAIN_PLACEHOLDER, type AudioOut } from '../src/audio';
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
  get state(): string { return this.unlocked ? 'running' : 'locked'; }
  unlock(): void { this.unlocked = true; }
  setGain(gain: number): void { this.gain = gain; }
  play(sound: RenderedSound): void { this.played.push(sound); }
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
    expect(d.banks.map((b) => b.file)).toEqual(['MP2_am.bnk', 'MP2_fx.bnk', 'MP2_vc.bnk']);
    expect(d.missing).toEqual([]);
    expect(new Map(d.params).get('.STEP_STONE')?.range).toEqual([30, 200]);
    expect(d.materials[STONE]!.step).toBe('.STEP_STONE');
    expect(d.weapons.find((w) => w.name === 'M4A1 SD')).toMatchObject({ fireClose: '.M4A1_SIL', reload: '.M4A1_SIL_RLD' });
    expect(new Map(d.callbacks).get('jump_whoosh')).toEqual(['.JUMP_WHOOSH']);
    expect(new Map(d.callbacks).get('ladder_rung')).toEqual(['.STEP_LADDER']);
    expect(new Map(d.callbacks).get('RPG_impact')).toEqual(['.EXP_1', '.GREN_FAR']);
  });

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
    expect(audio.onFootstep(0, [0, 0, -10])).toBeNull();               // UNKNOWN: no step sound
    expect(audio.onFootstep(STONE, [0, 0, -500])).toBeNull();          // past the step's RANGE (200)
    expect(audio.onFire('M4A1 SD', [0, 0, -5])).toBe('.M4A1_SIL');
    expect(audio.onReload('M4A1 SD')).toBe('.M4A1_SIL_RLD');
    expect(audio.onJump([0, 0, -5])).toBe('.JUMP_WHOOSH');
    expect(audio.onLand(80, STONE, [0, 0, -5])).toEqual(['.STONE_JUMP']);
    expect(audio.onLand(220, STONE, [0, 0, -5])).toEqual(['.BONE_BRK_1']);
    expect(audio.onLand(400, STONE, [0, 0, -5])).toEqual(['.STONE_JUMP', '.BONE_BRK_1']);
    expect(audio.onAnimCallback('shotgun_pump')).toBe('.SHOTGUN_COCK');
    const s = audio.stats();
    expect(s.map).toBe('MP2');
    expect(s.banks.map((b) => b.name)).toEqual(['MP2_AM', 'MP2_FX', 'MP2_VC']);
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

  it('turns the walk into footfalls, a jump, a landing, rounds and a reload', async () => {
    const out = new Recorder(), audio = new GameAudio(out, seeded(9));
    audio.setData(await mp2());
    audio.setFallTable(235, [62, 91, 120]);
    out.unlock();
    const state = {
      frame: 0, jumps: 0, airborne: false, landing: null as number | null,
    };
    const signals: WalkSignals = {
      walking: () => true,
      feet: () => [0, 0, 0],
      mover: () => ({ vx: 0, vz: -65, airborne: state.airborne, stance: 'stand', jumps: state.jumps }),
      landingSpeed: () => state.landing,
      wish: () => ({ forward: 1, right: 0 }),
      anim: () => ({ clip: 'seal_run', frame: state.frame, frames: 20, blend: 1, from: null, rate: 30, layer: null } as AnimStats),
      isCycle: (clip) => clip === 'seal_run',
      grid: () => null,                                                // no hull: material 0, silent steps
    };
    const sounds = new WalkSounds(audio, signals);
    sounds.material = () => STONE;                                     // stone under the feet
    for (let f = 0; f < 40; f++) { state.frame = (f * 2) % 20 + 0.5; sounds.frame(); }
    expect(sounds.counts.footfalls).toBe(8);                          // two a cycle, four cycles
    state.jumps = 1; state.airborne = true; sounds.frame();
    state.airborne = false; state.landing = 90; sounds.frame();
    const weapon = { name: 'M4A1 SD', id: 62, fireAnim: 'muzzle_m4SD', sounds: { close: '.M4A1_SIL', med: null, far: null, reload: '.M4A1_SIL_RLD' } };
    for (let i = 0; i < 3; i++) sounds.fireEvent({ type: 'round', weapon, from: [0, 15, -3], to: [0, 15, -100], hit: false, rounds: 29 - i });
    sounds.fireEvent({ type: 'reloadStart', weapon, seconds: 1.6 });
    expect(sounds.counts).toEqual({ footfalls: 8, jumps: 1, landings: 1, rounds: 3, reloads: 1 });
    const s = audio.stats();
    expect(s.byName['.STEP_STONE']).toBe(8);
    expect(s.byName['.JUMP_WHOOSH']).toBe(1);
    expect(s.byName['.STONE_JUMP']).toBe(1);
    expect(s.byName['.M4A1_SIL']).toBe(3);
    expect(s.byName['.M4A1_SIL_RLD']).toBe(1);
  });
});
