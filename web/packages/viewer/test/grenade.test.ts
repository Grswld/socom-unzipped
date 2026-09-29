import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { buildGrid, HE, M67, releaseSeconds, THROW_ANIMS, throwClipSeconds, type Grid, type GridParams, type V3, type WorldPoly } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { GrenadeThrower, KIT_ITEMS, L2_SLOT_PLACEHOLDER, RELEASE_POINT, worldToActor, type GrenadeSource } from '../src/grenade';
import { clipsFromPack, motionTableFromArchive } from '../src/motionTable';
import { whiteOut } from '../src/flash';
import { THROW_CLIPS, ThrowPose } from '../src/throwPose';
import type { PlaySnapshot } from '../src/walk';

/**
 * The grenades on the page (web/docs/research/85): the kit's slots and their controls, the release from the posed
 * hand, and the throw's clip as a one-shot pose layer. The flight itself is `@s2u/scene`'s (`test/projectile.test.ts`).
 */

const snap = (over: Partial<PlaySnapshot> = {}): PlaySnapshot => ({
  feet: [100, 50, 200], yaw: 90, pitch: 0, vx: 0, vz: 0, vy: 0, airborne: false, crouched: false, stance: 'stand',
  landing: null, jumps: 0, ...over,
} as PlaySnapshot);

function thrower(extra: Partial<GrenadeSource> = {}): { g: GrenadeThrower; events: string[] } {
  const events: string[] = [];
  const g = new GrenadeThrower({ grid: (): Grid | null => null, snapshot: () => snap(), view: () => 'third', ...extra });
  g.on('equip', (on, item) => events.push(`equip ${on} ${item}`));
  g.on('throw', (t) => events.push(`throw ${t.item} ${t.fromHand}`));
  return { g, events };
}

describe('the kit\'s slots (research 85 §9)', () => {
  it('selects by name, cycles like the inventory, and L2 goes to its slot and back', () => {
    const { g, events } = thrower();
    expect(KIT_ITEMS).toEqual(['rifle', 'M67', 'HE', 'AN-M8', 'Mark141', 'Claymore']);
    expect(g.select('HE')).toBe(true);
    expect(g.item()).toBe('HE');
    expect(g.icon()).toBe(HE.icon);
    expect(g.cycleInventory()).toBe('AN-M8');
    expect(g.icon()).toBe('grenade_smoke_icon.tif');
    expect(g.cycleInventory()).toBe('Mark141');
    expect(g.icon()).toBe('grenade_flashbang_icon.tif');
    expect(g.cycleInventory()).toBe('Claymore');
    expect(g.cycleInventory()).toBe('rifle');
    expect(g.icon()).toBeNull();
    expect(g.cycleInventory()).toBe('M67');
    expect(g.swap2()).toBe('rifle');                         // already on L2's slot: back to the rifle
    expect(g.swap2()).toBe(L2_SLOT_PLACEHOLDER);
    expect(events).toEqual([
      'equip true HE', 'equip true AN-M8', 'equip true Mark141', 'equip true Claymore', 'equip false null', 'equip true M67', 'equip false null', 'equip true M67',
    ]);
  });

  it('counts each throwable apart, and skips an empty one', () => {
    const { g } = thrower();
    g.select('HE');
    for (let i = 0; i < 3; i++) expect(g.throwNow(1)?.item).toBe('HE');
    expect(g.stats().leftByItem).toEqual({ M67: 3, HE: 0, 'AN-M8': 3, Mark141: 6, Claymore: 4 });
    expect(g.throwNow(1)).toBeNull();
    g.update(2);                                             // the last clip's tail: none left, back to the rifle
    expect(g.equipped()).toBe(false);
    expect(g.select('HE')).toBe(false);
    g.select('M67');
    expect(g.cycleInventory()).toBe('AN-M8');              // M67 -> (HE is empty) -> the smoke
  });
});

describe('the release from the posed hand (CZKit_TickExplosives 0x5c1970)', () => {
  it('takes the right hand\'s (2, 0, 0) when the body offers it, and the table\'s point when not', () => {
    const asked: string[] = [];
    const hand: V3 = [104, 69, 199];
    const { g } = thrower({ handPoint: (part, p) => { asked.push(`${part} ${p.join(',')}`); return hand; } });
    const t = g.throwNow(1)!;
    expect(asked).toEqual([`rhand ${RELEASE_POINT.join(',')}`]);
    expect(t.from).toEqual(hand);
    expect(t.fromHand).toBe(true);
    // The launch took the hand in the actor frame: its height is the hand's 19 over the feet.
    expect(t.launch.maxSpeed).toBeCloseTo(600 / (0.707107 * Math.sqrt((19 + 600) * 2 / 98)), 6);
    const plain = thrower().g.throwNow(1)!;
    expect(plain.fromHand).toBe(false);
    expect(worldToActor([100, 50, 200], 90, plain.from).map((v) => Math.round(v * 1e6) / 1e6)).toEqual(THROW_ANIMS.standThrow.offset);
  });

  it('while the lean holds, the throw is the lean toss, the left one from the left hand', () => {
    const asked: string[] = [];
    const right = thrower({ peek: () => 1 }).g;
    expect(right.throwNow(1)!.anim.clip).toBe('seal_toss_rlean');
    const left = thrower({ peek: () => -0.8, handPoint: (part) => { asked.push(part); return [0, 60, 0]; } }).g;
    expect(left.throwNow(1)!.anim.clip).toBe('seal_toss_llean');
    expect(asked).toEqual(['lhand']);
    expect(thrower({ peek: () => 0.3 }).g.throwNow(1)!.anim.clip).toBe('seal_throwgrenade');
  });

  it('hangs the grenade on the held node while it is up, and lets go of it at the release', () => {
    const node = new Group(), model = new Group();
    const { g } = thrower({ heldNode: () => node });
    g.setMap({ [M67.model]: model }, null);
    g.select('M67');
    g.update(0.016);
    expect(node.children.length).toBe(1);
    expect(g.stats().inHand).toBe(true);
    g.throwNow(1);
    g.update(0.016);
    expect(g.stats().inHand).toBe(false);
  });
});

describe('the throw\'s clip (./throwPose)', () => {
  const pack = fixture('RUN/MOTION_P.ZAR'), readerc = fixture('RUN/READERC.ZAR');
  it.skipIf(!pack || !readerc)('plays the one-shot at its playback, blends in and out, and fires throw_whoosh by its phase', () => {
    const clips = new Map(clipsFromPack(pack!, THROW_CLIPS).map((c) => [c.name, c]));
    const table = motionTableFromArchive(readerc!);
    expect(clips.size).toBe(THROW_CLIPS.length);
    const pose = new ThrowPose(() => ({ clips, table }));
    const a = THROW_ANIMS.standThrow;
    expect(pose.start(a)).toBe(true);
    const calls: string[] = [];
    let t = 0;
    for (; t < releaseSeconds(a) - 1e-9; t += 1 / 60) calls.push(...pose.step(1 / 60));
    expect(pose.stats().phase).toBeCloseTo(a.release, 1);  // the hand opens on the clip's own frame
    expect(calls).toEqual(['throw_whoosh']);                 // at phase 0.45, just before the release's 0.46
    expect(pose.stats().weight).toBe(1);                     // blended in over the default 0.4
    for (; t < throwClipSeconds(a) + 0.2; t += 1 / 60) pose.step(1 / 60);
    expect(pose.stats().weight).toBeGreaterThan(0);
    expect(pose.stats().weight).toBeLessThan(1);
    for (let i = 0; i < 60; i++) pose.step(1 / 60);
    expect(pose.playing()).toBe(false);
  });

  it('without the clip it does not play, and the grenade still flies', () => {
    const pose = new ThrowPose(() => null);
    expect(pose.start(THROW_ANIMS.standThrow)).toBe(false);
    expect(pose.step(0.1)).toEqual([]);
  });
});

describe('the smoke and the flash going off', () => {
  const run = (g: GrenadeThrower, seconds: number): void => { for (let t = 0; t < seconds; t += 1 / 60) g.update(1 / 60); };

  it('the flash whites out by the game\'s rule: facing it close is level 3, turned away level 1', () => {
    const seen: (number | null)[] = [];
    const floor: WorldPoly = {
      modelName: 'worldmodel', path: 'worldmodel/f', region: 0, ditype: 3, material: 7, ptcount: 4, cameratype: 0,
      points: Float32Array.from([-2000, 50, -2000, 2000, 50, -2000, 2000, 50, 2000, -2000, 50, 2000]),
    };
    const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 500, cellsX: 8, cellsZ: 8, originX: -2000, originZ: -2000 };
    const grid = buildGrid(params, [], [], [floor], [{ modelName: 'worldmodel', path: 'worldmodel/f0', first: 0, count: 1 }]);
    let yaw = 0;
    const { g } = thrower({ grid: () => grid, snapshot: () => snap({ yaw }) });
    g.on('explode', (e) => seen.push(e.flash));
    g.select('Mark141');
    g.throwNow(0);                                            // a weak lob: it lands a few units ahead and lies there
    run(g, 1.6);
    g.throwNow(0);
    yaw = 180;                                                // turned round once it has left the hand
    run(g, 1.6);
    expect(seen).toEqual([3, 1]);
    expect(whiteOut(3, 0)).toBe(0);
    expect(whiteOut(3, 0.2)).toBe(1);
    expect(whiteOut(3, 8)).toBe(1);
    expect(whiteOut(3, 9)).toBeCloseTo(0.5, 9);
    expect(whiteOut(1, 0.2)).toBeCloseTo(0.9 * 25 / 60, 9);
  });

  it('the smoke detonates with nothing to hurt, keeps its canister, and hands the effects smoke_grenade first', () => {
    const played: string[] = [];
    const { g } = thrower();
    g.setEffectPlayer((anim) => { played.push(anim); return false; });
    let info: { detonation: string; damageToPlayer: number; byEffects: boolean } | null = null;
    g.on('explode', (e) => { info = e; });
    g.select('AN-M8');
    g.throwNow(0.2);
    run(g, 3.1);
    expect(played).toEqual(['smoke_grenade']);
    expect(info).toMatchObject({ detonation: 'smoke', damageToPlayer: 0, byEffects: false });
    expect(g.stats().effects).toBeGreaterThan(0);             // the placeholder's puffs, since the effects said no
    g.setEffectPlayer(() => true);
    g.select('AN-M8');
    g.throwNow(0.2);
    const before = g.stats().effects;
    run(g, 3.1);
    expect(g.stats().explosions.at(-1)!.byEffects).toBe(true);
    expect(g.stats().effects).toBeLessThanOrEqual(before + 40);
  });

  it('the claymore is set down on the ground under the hand, facing the SEAL heading, and waits to be set off', () => {
    const floor: WorldPoly = {
      modelName: 'worldmodel', path: 'worldmodel/f', region: 0, ditype: 3, material: 7, ptcount: 4, cameratype: 0,
      points: Float32Array.from([-2000, 50, -2000, 2000, 50, -2000, 2000, 50, 2000, -2000, 50, 2000]),
    };
    const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 500, cellsX: 8, cellsZ: 8, originX: -2000, originZ: -2000 };
    const grid = buildGrid(params, [], [], [floor], [{ modelName: 'worldmodel', path: 'worldmodel/f0', first: 0, count: 1 }]);
    const booms: { damageToPlayer: number; anim: string }[] = [];
    const { g } = thrower({ grid: () => grid, snapshot: () => snap({ feet: [100, 50, 200], yaw: 0 }), handPoint: () => [102, 62, 192] });
    g.on('explode', (e) => booms.push(e));
    g.select('Claymore');
    g.pull();
    const set = g.stats().live[0]!;
    expect(set.pos).toEqual([102, 50.1, 192]);
    expect(set.state).toBe('rest');
    expect(g.stats().leftByItem.Claymore).toBe(3);
    run(g, 20);
    expect(booms).toEqual([]);                                // no fuse: it waits
    expect(g.detonateCharges()).toBe(1);
    run(g, 0.1);
    expect(booms[0]!.anim).toBe('claymore_stone');            // the material variant first; the effects fall back
    // The SEAL stands behind it (its cone points the way he faced): a 32nd of the damage.
    expect(booms[0]!.damageToPlayer).toBeCloseTo(16 / 32, 9);
  });
});
