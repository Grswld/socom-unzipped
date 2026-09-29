import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { HE, M67, releaseSeconds, THROW_ANIMS, throwClipSeconds, type Grid, type V3 } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { GrenadeThrower, KIT_ITEMS, L2_SLOT_PLACEHOLDER, RELEASE_POINT, worldToActor, type GrenadeSource } from '../src/grenade';
import { clipsFromPack, motionTableFromArchive } from '../src/motionTable';
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
    expect(KIT_ITEMS).toEqual(['rifle', 'M67', 'HE']);
    expect(g.select('HE')).toBe(true);
    expect(g.item()).toBe('HE');
    expect(g.icon()).toBe(HE.icon);
    expect(g.cycleInventory()).toBe('rifle');
    expect(g.icon()).toBeNull();
    expect(g.cycleInventory()).toBe('M67');
    expect(g.icon()).toBe('grenade_frag_icon.tif');
    expect(g.cycleInventory()).toBe('HE');
    expect(g.swap2()).toBe(L2_SLOT_PLACEHOLDER);
    expect(g.swap2()).toBe('rifle');
    expect(events).toEqual(['equip true HE', 'equip false null', 'equip true M67', 'equip true HE', 'equip true M67', 'equip false null']);
  });

  it('counts each throwable apart, and skips an empty one', () => {
    const { g } = thrower();
    g.select('HE');
    for (let i = 0; i < 3; i++) expect(g.throwNow(1)?.item).toBe('HE');
    expect(g.stats().leftByItem).toEqual({ M67: 3, HE: 0 });
    expect(g.throwNow(1)).toBeNull();
    g.update(2);                                             // the last clip's tail: none left, back to the rifle
    expect(g.equipped()).toBe(false);
    expect(g.select('HE')).toBe(false);
    g.select('M67');
    expect(g.cycleInventory()).toBe('rifle');              // M67 -> (HE is empty) -> rifle
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
