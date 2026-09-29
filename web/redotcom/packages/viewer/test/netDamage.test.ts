import { describe, expect, it } from 'vitest';
import { DEFAULT_RIFLE, HELD_RIFLE, HELD_SIDEARM } from '@s2u/scene';
import { applyFall, applyHit, bulletDamage, fragmentCount, fragmentDamage, freshHealth, isDead, overall, PART } from '../src/net/damage';

/** The game's damage (web research 91 sections 1-5): the table's shots to kill, the falloff, the falls, the blasts. */

function shotsToKill(w: typeof DEFAULT_RIFLE, part: number): number {
  const h = freshHealth();
  for (let n = 1; n <= 20; n++) if (applyHit(h, part, bulletDamage(w, 0)!, w.piercing)) return n;
  return Infinity;
}

describe('bullets (research 91 section 1.2)', () => {
  it('does the table\'s damage a round', () => {
    expect(bulletDamage(DEFAULT_RIFLE, 0)).toBeCloseTo(36.4, 6);   // M4A1
    expect(bulletDamage(HELD_RIFLE, 0)).toBeCloseTo(34.3, 6);      // M4A1 SD
    expect(bulletDamage(HELD_SIDEARM, 0)).toBeCloseTo(42, 6);      // Mark 23
  });

  it('kills in the table\'s shots: M4A1 and SD 1 head / 3 body, Mark 23 1 / 2', () => {
    expect(shotsToKill(DEFAULT_RIFLE, PART.HEAD)).toBe(1);
    expect(shotsToKill(DEFAULT_RIFLE, PART.BODY)).toBe(3);
    expect(shotsToKill(HELD_RIFLE, PART.HEAD)).toBe(1);
    expect(shotsToKill(HELD_RIFLE, PART.BODY)).toBe(3);
    expect(shotsToKill(HELD_SIDEARM, PART.BODY)).toBe(2);
  });

  it('a limb never kills by itself until it is spent; then it spills into the body', () => {
    const h = freshHealth();
    expect(applyHit(h, PART.RLEG, 36.4, 3)).toBe(false);
    expect(applyHit(h, PART.RLEG, 36.4, 3)).toBe(false);
    expect(h.hp[PART.RLEG]).toBe(0);
    expect(h.hp[PART.BODY]).toBe(50);
    applyHit(h, PART.RLEG, 36.4, 3);
    expect(h.hp[PART.BODY]).toBeLessThan(50);                      // LIMB_SPILL_PLACEHOLDER
  });

  it('falls off from Effective_Range to nothing at Maximum_Range, and ignores a round past it', () => {
    const e = DEFAULT_RIFLE.effectiveRange * 10, m = DEFAULT_RIFLE.maximumRange * 10;
    expect(bulletDamage(DEFAULT_RIFLE, e)).toBeCloseTo(36.4, 6);
    expect(bulletDamage(DEFAULT_RIFLE, (e + m) / 2)).toBeCloseTo(18.2, 6);
    expect(bulletDamage(DEFAULT_RIFLE, m + 1)).toBeNull();
  });

  it('caps the limbs by the body\'s share after a body hit, and the bar weights the head 3x', () => {
    const h = freshHealth();
    expect(overall(h)).toBe(1);
    applyHit(h, PART.BODY, 36.4, 3);
    const share = h.hp[PART.BODY]! / 50;
    expect(h.hp[PART.RARM]).toBeCloseTo(30 * share, 9);
    expect(h.hp[PART.HEAD]).toBe(8);
    expect(overall(h)).toBeLessThan(1);
  });
});

describe('falls and blasts (research 91 section 5)', () => {
  it('hurts from 170.7 u/s (a 62-unit fall) and kills at 237.5 (120 units)', () => {
    const g = 235, v = (h: number): number => Math.sqrt(2 * g * h);
    const a = freshHealth();
    expect(applyFall(a, v(60))).toBe(false);
    expect(a.hp).toEqual(freshHealth().hp);
    const b = freshHealth();
    expect(applyFall(b, v(90))).toBe(false);
    expect(b.hp[PART.BODY]).toBeLessThan(50);
    expect(applyFall(freshHealth(), v(121))).toBe(true);
  });

  it('an M67 fragment is 140 to 75 units and 0 at 150; one on the head or body kills', () => {
    expect(fragmentDamage(10, 150, 10)).toBe(140);
    expect(fragmentDamage(10, 150, 75)).toBe(140);
    expect(fragmentDamage(10, 150, 112.5)).toBeCloseTo(70, 9);
    expect(fragmentDamage(10, 150, 150)).toBe(0);
    const h = freshHealth();
    expect(applyHit(h, PART.BODY, 140, 4)).toBe(true);
    expect(isDead(h)).toBe(true);
  });

  it('sends 9-15 fragments close, fewer crouched and prone, thinning past 30 units', () => {
    const r = (v: number) => () => v;
    expect(fragmentCount(10, 'stand', r(0))).toBe(9);
    expect(fragmentCount(10, 'stand', r(0.99))).toBe(15);
    expect(fragmentCount(10, 'crouch', r(0))).toBe(8);
    expect(fragmentCount(10, 'prone', r(0))).toBe(6);
    expect(fragmentCount(60, 'stand', r(0.99))).toBeLessThanOrEqual(4);
  });
});
