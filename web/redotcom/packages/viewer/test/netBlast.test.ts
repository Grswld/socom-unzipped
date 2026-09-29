import { describe, expect, it } from 'vitest';
import { HE, M67 } from '@s2u/scene';
import {
  BLAST_RING_SECONDS, BLAST_RING_VOLUME, blastKnock, fragmentDamage, freshHealth, isDead, KNOCK_MASS, KNOCK_SPEED_MAX, resolveBlast,
  ROOT_HEIGHT, type BlastVictim,
} from '../src/sim';

/**
 * A grenade's blast on one SEAL (web research 85 section 7, 91 section 5): `FUN_005ac070` (who it reaches: the line to
 * the head), `FUN_005a0e70` (the reach factor, the ringing ears, the fragments, the push), `FUN_005a18b0` (how many
 * fragments), `FUN_0057ed10` / `FUN_0057e770` (the knock: an impulse and `Fall forward` / `Fall backwards`).
 */

/** A seeded draw (the Park-Miller the room tests use). */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

const M67_BLAST = { record: M67, piercing: 4, fragments: true } as const;
const standing = (x: number, z = 0): BlastVictim => ({ feet: [x, 0, z], posture: 'stand', yaw: 0 });

describe('the blast\'s reach (FUN_005a0e70 L459160-459172)', () => {
  it('reaches inside the radius only: factor 1 - d^2 / r^2 at the feet, nothing at or past 150 for the M67', () => {
    const a = resolveBlast(freshHealth(), standing(20), [0, 0, 0], M67_BLAST, seeded(), true);
    expect(a!.factor).toBeCloseTo(1 - 400 / 22500, 9);
    expect(resolveBlast(freshHealth(), standing(150), [0, 0, 0], M67_BLAST, seeded(), true)).toBeNull();
    expect(resolveBlast(freshHealth(), standing(151), [0, 0, 0], M67_BLAST, seeded(), true)).toBeNull();
  });

  it('a wall between the blast and the head: nothing at all (FUN_005ac070 queues the blast only with the line)', () => {
    const h = freshHealth();
    expect(resolveBlast(h, standing(5), [0, 0, 0], M67_BLAST, seeded(), false)).toBeNull();
    expect(h.hp).toEqual(freshHealth().hp);
  });

  it('rings the ears for 5 s at 0.35 whenever it reaches, fragments or none (L459221-459227, FUN_003412f0)', () => {
    expect(BLAST_RING_SECONDS).toBe(5);
    expect(BLAST_RING_VOLUME).toBeCloseTo(0.35, 6);
    // Past 30 units the fragments thin as 900 / d^2: at 140 units, fewer than one.
    const far = resolveBlast(freshHealth(), standing(140), [0, 0, 0], M67_BLAST, () => 0.999, true)!;
    expect(far.fragments).toBe(0);
    expect(far.ring).toBe(true);
    const smoke = resolveBlast(freshHealth(), standing(5), [0, 0, 0], { record: M67, piercing: 0, fragments: false }, seeded(), true)!;
    expect(smoke.fragments).toBe(0);
    expect(smoke.hits).toEqual([]);
  });
});

describe('the fragments on the player (FUN_005a18b0, FUN_005a0e70 L459236-459256)', () => {
  // The brief's distances as world units (2, 5, 10), and 20: all inside the 30 units of the full count.
  for (const d of [2, 5, 10, 20]) {
    it(`an M67 ${d} units from the feet: 9-15 fragments (8 + the roll) of 140 each, and the SEAL dies`, () => {
      const h = freshHealth();
      const out = resolveBlast(h, standing(d), [0, 0, 0], M67_BLAST, seeded(7), true)!;
      expect(out.fragments).toBeGreaterThanOrEqual(9);
      expect(out.fragments).toBeLessThanOrEqual(15);
      for (const hit of out.hits) expect(hit.damage).toBe(140);
      expect(out.died).toBe(true);
      expect(isDead(h)).toBe(true);
    });
  }

  it('an M67 50 units off (5 m): the close count x 900 / 2500, 3-6 fragments, each still the full 140 (inside 75)', () => {
    const out = resolveBlast(freshHealth(), standing(50), [0, 0, 0], M67_BLAST, seeded(7), true)!;
    expect(out.fragments).toBeGreaterThanOrEqual(3);
    expect(out.fragments).toBeLessThanOrEqual(6);
    for (const hit of out.hits) expect(hit.damage).toBe(140);
  });

  it('an M67 100 units off: each fragment 140 x (1 - 25/75) = 93.3, and 900/d^2 of the count (at most 2)', () => {
    expect(fragmentDamage(10, 150, 100)).toBeCloseTo(93.333, 3);
    const out = resolveBlast(freshHealth(), standing(100), [0, 0, 0], M67_BLAST, seeded(3), true)!;
    expect(out.fragments).toBeLessThanOrEqual(2);
    for (const hit of out.hits) expect(hit.damage).toBeCloseTo(93.333, 3);
  });

  it('the HE: 154 a fragment to 50, 0 at 100 (zweapon.rdr: 11, radius 10 m)', () => {
    const out = resolveBlast(freshHealth(), standing(10), [0, 0, 0], { record: HE, piercing: 1, fragments: true }, seeded(), true)!;
    for (const hit of out.hits) expect(hit.damage).toBe(154);
    expect(resolveBlast(freshHealth(), standing(100), [0, 0, 0], { record: HE, piercing: 1, fragments: true }, seeded(), true)).toBeNull();
  });

  it('the thrower is not spared: nothing in the blast asks who threw it (FUN_005ac070)', () => {
    // resolveBlast takes no thrower; the room's own test pins the suicide.
    expect(resolveBlast.length).toBe(6);
  });
});

describe('the knock (FUN_0057ed10 L441094, FUN_0057e770 L440940-441092, FUN_005807d0 L441900)', () => {
  it('stores the push only when fragments struck and the damage at the feet is over 0', () => {
    const far = resolveBlast(freshHealth(), standing(140), [0, 0, 0], M67_BLAST, () => 0.999, true)!;
    expect(far.knock).toBeNull();
  });

  it('pushes a standing SEAL from the blast: min(100, f x (dmg/14) x 120 / 90) along the line, up at least 50 f', () => {
    expect(KNOCK_MASS).toBe(90);
    expect(KNOCK_SPEED_MAX).toBe(100);
    expect(ROOT_HEIGHT).toEqual({ stand: 11.48, crouch: 5.5, prone: 2.17 });
    const v = standing(20);
    const k = blastKnock(v, [0, 0, 0], M67, fragmentDamage(10, 150, 20))!;
    const len = Math.hypot(20, 11.48), f = 1 - (len * len) / 22500, s = Math.min(100, (f * 10 * 120) / 90);
    expect(k.velocity[0]).toBeCloseTo((20 / len) * s, 6);
    expect(k.velocity[2]).toBeCloseTo(0, 9);
    expect(k.velocity[1]).toBeCloseTo(Math.max(50 * f, (11.48 / len) * s), 6);
    expect(k.velocity[1]).toBeCloseTo(50 * f, 6);                 // the rise is the 50 f floor, not the line's
  });

  it('crouched: from the crouch\'s root (5.5 over the feet); prone: no push (the game plays `Prone cover`)', () => {
    const k = blastKnock({ feet: [30, 0, 0], posture: 'crouch', yaw: 0 }, [0, 0, 0], M67, 140)!;
    const len = Math.hypot(30, 5.5), f = 1 - (len * len) / 22500;
    expect(k.velocity[1]).toBeCloseTo(50 * f, 6);
    expect(blastKnock({ feet: [30, 0, 0], posture: 'prone', yaw: 0 }, [0, 0, 0], M67, 140)).toBeNull();
  });

  it('no push when the root is at or past the radius', () => {
    expect(blastKnock(standing(149.9), [0, 0, 0], M67, 1)).toBeNull();   // the root is 11.48 up: past 150
  });

  it('falls backwards from a blast in front, forwards from one behind (KNOCK_SIDE_READING)', () => {
    // yaw 0 faces -z (`Pose`): a blast at -z is in front.
    const front = blastKnock({ feet: [0, 0, 0], posture: 'stand', yaw: 0 }, [0, 0, -20], M67, 140)!;
    const behind = blastKnock({ feet: [0, 0, 0], posture: 'stand', yaw: 0 }, [0, 0, 20], M67, 140)!;
    expect(front.fall).toBe('fallBackwards');
    expect(behind.fall).toBe('fallForward');
    expect(front.velocity[2]).toBeGreaterThan(0);                 // pushed back, away from the blast
  });

  it('the resolve carries the knock of a survivor (a blast that struck but did not kill)', () => {
    // One fragment on an arm at 120 units: 140 x 0.4 = 56 -- the arm's 30 + armour take it, the SEAL lives.
    let calls = 0;
    const draws = [0.5, 0.0, 0.65];                               // the extra roll (13), the rounding (0.81 -> 1), the part (LARM)
    const out = resolveBlast(freshHealth(), standing(120), [0, 0, 0], M67_BLAST, () => draws[calls++] ?? 0.65, true)!;
    expect(out.fragments).toBe(1);
    expect(out.died).toBe(false);
    expect(out.knock).not.toBeNull();
  });
});
