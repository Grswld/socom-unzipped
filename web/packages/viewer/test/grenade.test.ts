import { describe, expect, it } from 'vitest';
import { Group, type LineSegments } from 'three';
import { arcPoint, THROW_ARC, buildGrid, CLAYMORE_RULES, HE, M67, PLACE_CLAYMORE_ANIM, releaseSeconds, THROW_ANIMS, throwClipSeconds, type Grid, type GridParams, type V3, type WorldPoly } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { equipmentSlots, GrenadeThrower, KIT_ITEMS, RELEASE_POINT, THROWABLES, worldToActor, type GrenadeSource } from '../src/grenade';
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
  it('selects by name and cycles like the inventory (L1 and L2 are the firearms: ./kit)', () => {
    const { g, events } = thrower();
    expect(KIT_ITEMS).toEqual(['rifle', 'M67', 'HE', 'AN-M8', 'Mark141', 'Claymore', 'Detonator']);
    expect(g.select('HE')).toBe(true);
    expect(g.item()).toBe('HE');
    expect(g.icon()).toBe(HE.icon);
    expect(g.cycleInventory()).toBe('AN-M8');
    expect(g.icon()).toBe('grenade_smoke_icon.tif');
    expect(g.cycleInventory()).toBe('Mark141');
    expect(g.icon()).toBe('grenade_flashbang_icon.tif');
    expect(g.cycleInventory()).toBe('Claymore');
    expect(g.select('Detonator')).toBe(false);               // no charge down: the Detonator is not offered
    expect(g.cycleInventory()).toBe('rifle');
    expect(g.icon()).toBeNull();
    expect(g.cycleInventory()).toBe('M67');
    expect(g.select('rifle')).toBe(true);                    // the firearm back in the hand
    expect(g.select('M67')).toBe(true);
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

  it('the equipment slots, in the order of the kit: 3 takes slot 1, 4 slot 2 (the owner, 2026-09-29); no per-type keys', () => {
    expect(equipmentSlots()).toEqual(['M67', 'HE', 'AN-M8', 'Mark141', 'Claymore']);
    expect(equipmentSlots({ ...THROWABLES, M67: { ...THROWABLES.M67, capacity: 0 } }).slice(0, 2)).toEqual(['HE', 'AN-M8']);
    const { g, events } = thrower();
    expect(g.selectEquipment(1)).toBe(true);
    expect(g.item()).toBe('M67');
    expect(g.selectEquipment(1)).toBe(true);                 // already up: stays (no toggle back, as the game's switch)
    expect(g.equipped()).toBe(true);
    expect(g.selectEquipment(2)).toBe(true);
    expect(g.item()).toBe('HE');
    expect(g.selectEquipment(3)).toBe(true);                 // the page binds only 3 and 4; a third slot exists
    expect(g.selectEquipment(9)).toBe(false);                // past the kit: nothing
    expect(events).toEqual(['equip true M67', 'equip true HE', 'equip true AN-M8']);
    // The digits are the page's (`./kit`'s `hotkey`): the thrower binds none of its own.
    expect('bindKey' in g).toBe(false);
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

  const claymoreFloor = (): Grid => {
    const floor: WorldPoly = {
      modelName: 'worldmodel', path: 'worldmodel/f', region: 0, ditype: 3, material: 7, ptcount: 4, cameratype: 0,
      points: Float32Array.from([-2000, 50, -2000, 2000, 50, -2000, 2000, 50, 2000, -2000, 50, 2000]),
    };
    const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 500, cellsX: 8, cellsZ: 8, originX: -2000, originZ: -2000 };
    return buildGrid(params, [], [], [floor], [{ modelName: 'worldmodel', path: 'worldmodel/f0', first: 0, count: 1 }]);
  };

  it('the claymore: the placing clip, down under the hand at 1.3 s, the Detonator up, and off only when it is fired', () => {
    const grid = claymoreFloor();
    const booms: { damageToPlayer: number; anim: string }[] = [];
    const clips: string[] = [];
    const { g, events } = thrower({ grid: () => grid, snapshot: () => snap({ feet: [100, 50, 200], yaw: 0 }), handPoint: () => [102, 62, 192] });
    g.on('explode', (e) => booms.push(e));
    g.on('throwStart', ({ anim, releaseIn }) => clips.push(`${anim.clip} ${releaseIn}`));
    g.select('Claymore');
    g.pull();                                                  // R1: the `Place claymore` action, not the charge yet
    expect(clips).toEqual([`seal_place_claymore ${CLAYMORE_RULES.placeSeconds}`]);
    expect(g.stats()).toMatchObject({ placing: true, placed: 0, held: 'Claymore' });
    run(g, 1.25);
    expect(g.stats().placed).toBe(0);
    run(g, 0.1);                                               // 1.3 s in: down
    const set = g.stats().live[0]!;
    expect(set.pos).toEqual([102, 50.1, 192]);
    expect(set.state).toBe('rest');
    expect(g.stats()).toMatchObject({ placing: false, placed: 1, held: 'Detonator', icon: 'detonator_icon.tif' });
    expect(g.stats().leftByItem.Claymore).toBe(3);
    expect(events.at(-1)).toBe('equip true Detonator');
    run(g, 20);
    expect(booms).toEqual([]);                                 // no fuse, no tripwire: it waits
    g.pull();                                                  // R1 with the Detonator: CZKit_DetonateRemoteExplosives
    expect(g.stats().held).toBe('Claymore');                   // FUN_005c8a20(0x99): the claymore back up
    run(g, 0.1);
    expect(booms[0]!.anim).toBe('claymore_stone');             // the material variant first; the effects fall back
    // The SEAL stands behind it (its cone points the way he faced): a 32nd of the damage.
    expect(booms[0]!.damageToPlayer).toBeCloseTo(16 / 32, 9);
    // The clip is the motion pack's, and the page asks for it.
    expect(THROW_CLIPS).toContain(PLACE_CLAYMORE_ANIM.clip);
  });

  it('the claymore: four down at most, none while moving, none off the ground, and the Detonator reaches 500 units', () => {
    const grid = claymoreFloor();
    let feet: V3 = [100, 50, 200], vx = 0;
    const refused: string[] = [];
    const { g } = thrower({ grid: () => grid, snapshot: () => snap({ feet, yaw: 0, vx }), handPoint: () => [feet[0] + 2, feet[1] + 12, feet[2] - 8] });
    g.on('refuse', (r) => refused.push(r.text));
    const place = (): void => { g.select('Claymore'); g.pull(); run(g, 3); };
    vx = 40;                                                   // on the move: not started
    g.select('Claymore');
    g.pull();
    expect(g.stats().placing).toBe(false);
    vx = 0;
    feet = [100, 200, 200];                                    // the hand 162 over a floor 150 below the feet: out of reach
    place();
    expect(g.stats().placed).toBe(0);
    expect(g.stats().leftByItem.Claymore).toBe(4);
    feet = [100, 50, 200];
    place();
    feet = [700, 50, 200];                                     // 600 units along
    place();
    feet = [1300, 50, 200];
    place();
    place();
    expect(g.stats().placed).toBe(4);
    expect(g.stats().leftByItem.Claymore).toBe(0);
    expect(g.stats().held).toBe('Detonator');
    // Fired at the far end: the two at its feet go, the one 600 units back is beyond the Detonator's 500.
    expect(g.detonateCharges()).toBe(2);
    expect(g.stats().held).toBeNull();                         // no claymore left: back to the rifle
    run(g, 0.1);
    expect(g.stats().placed).toBe(2);
    expect(g.select('Detonator')).toBe(true);                  // still two down
    expect(refused).toEqual([]);
  });

  it('the claymore: a fifth is refused with the game\'s message', () => {
    const grid = claymoreFloor();
    const refused: string[] = [];
    const records = { ...THROWABLES, Claymore: { ...THROWABLES.Claymore, capacity: 6 } };   // more in the pouch than may be down
    const h = new GrenadeThrower({ grid: () => grid, snapshot: () => snap({ feet: [100, 50, 200], yaw: 0 }), view: () => 'third', handPoint: () => [102, 62, 192] }, records);
    h.on('refuse', (r) => refused.push(r.text));
    for (let i = 0; i < 5; i++) { h.select('Claymore'); h.pull(); run(h, 3); }
    expect(h.stats().placed).toBe(4);
    expect(h.stats().leftByItem.Claymore).toBe(2);
    expect(refused).toEqual(['Unable To Deploy: Max Equipment Items Placed (4)']);
    expect(h.stats().message).toBeNull();                      // 2 s on screen, then gone
  });
});

describe('the yellow arc while the throw is held (FUN_005970b0, research 85 §11)', () => {
  /** Holds the trigger `frames` frames of 1/60 s. */
  const hold = (g: GrenadeThrower, frames: number): void => {
    g.pull();
    for (let i = 0; i < frames; i++) g.update(1 / 60);
  };

  it('shows from the press, grows with the power, and is gone at the let-go', () => {
    const { g } = thrower();
    g.select('M67');
    g.update(1 / 60);
    expect(g.stats().arc).toBeNull();                          // up, not held: no arc
    hold(g, 6);
    const early = g.stats().arc!;
    expect(early.visible).toBe(true);
    expect(early.segments).toBe(101);
    expect(early.color).toEqual([...THROW_ARC.color]);
    for (let i = 0; i < 30; i++) g.update(1 / 60);
    const late = g.stats().arc!;
    expect(Math.hypot(...late.velocity)).toBeGreaterThan(Math.hypot(...early.velocity));
    g.release();
    g.update(1 / 60);                                          // the let-go: the clip starts, the arc goes
    expect(g.stats().phase).toBe('throwing');
    expect(g.stats().arc).toBeNull();
  });

  it('is the throw that follows: without a posed body the toss leaves from the arc\'s point at the arc\'s velocity', () => {
    const { g } = thrower();
    g.select('M67');
    hold(g, 40);
    const arc = g.stats().arc!;
    g.release();
    g.update(1 / 60);
    for (let i = 0; i < 60 && !g.stats().lastThrow; i++) g.update(1 / 60);
    const t = g.stats().lastThrow!;
    expect(t.fromHand).toBe(false);
    t.from.forEach((c, i) => expect(c).toBeCloseTo(arc.from[i]!, 9));
    t.velocity.forEach((c, i) => expect(c).toBeCloseTo(arc.velocity[i]!, 9));
  });

  it('starts from GetThrowAnim\'s table point, as the game\'s does, even with a posed hand', () => {
    const { g } = thrower({ handPoint: () => [104, 69, 199] });
    g.select('M67');
    hold(g, 40);
    const arc = g.stats().arc!;
    expect(worldToActor([100, 50, 200], 90, arc.from).map((v) => Math.round(v * 1e6) / 1e6)).toEqual(THROW_ANIMS.standThrow.offset);
    expect(arc.start).toEqual(arcPoint(arc.from, arc.velocity, -1));
  });

  it('pale in the night vision (view mode 3), none in the 9x view or a scope (4 and up), none for the claymore', () => {
    let mode = 3;
    const { g } = thrower({ viewState: () => mode });
    g.select('M67');
    hold(g, 10);
    expect(g.stats().arc!.color).toEqual([...THROW_ARC.nightColor]);
    mode = 4;
    g.update(1 / 60);
    expect(g.stats().arc).toBeNull();
    mode = 5;
    g.update(1 / 60);
    expect(g.stats().arc).toBeNull();
    mode = 1;
    g.update(1 / 60);
    expect(g.stats().arc!.color).toEqual([...THROW_ARC.color]);
    const c = thrower().g;
    c.select('Claymore');
    hold(c, 10);
    expect(c.stats().arc).toBeNull();
  });

  it('draws the strip as line segments, each with its alpha, and hides it after the throw', () => {
    const { g } = thrower();
    g.select('M67');
    hold(g, 20);
    const line = g.object.getObjectByName('throwArc') as LineSegments;
    expect(line.visible).toBe(true);
    const pos = line.geometry.getAttribute('position'), col = line.geometry.getAttribute('color');
    expect(pos.count).toBe(202);
    expect(col.itemSize).toBe(4);
    expect(col.getW(0)).toBeCloseTo(0.75 * 0.99 + 0.1 * 0.01, 5);
    expect(col.getW(201)).toBeCloseTo(0.1, 5);
    g.release();
    g.update(1 / 60);
    expect(line.visible).toBe(false);
  });
});
