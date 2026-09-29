import { describe, expect, it } from 'vitest';
import { DEFAULT_RIFLE, HELD_RIFLE } from '@s2u/scene';
import {
  Accuracy, burstScalar, defaultFireMode, fireInterval, kickStarts, kickTicks, MAP_FOV, movementSize, nextFireMode,
  penetrate, perturb, RADIUS_FACTOR, roundsPerPull, tangentPerPixel, TICK, type AccuracyInput,
} from '../src/accuracy';

/**
 * The gunplay model (research 84) on the M4A1 SD's own record (`zweapon.rdr`, `@s2u/scene`'s `HELD_RIFLE`): every
 * expectation below is the decompilation's arithmetic on the file's numbers, worked by hand in the comment beside it.
 */

const still: AccuracyInput = {
  stance: 'stand', velocity: [0, 0, 0], airborne: false, yawRate: 0, pitchRate: 0, zoomState: 0,
};
const sd = HELD_RIFLE.stances;

describe('the reticle size (FUN_005c2670, FUN_005c3360)', () => {
  it('rests at TargetMin; a round opens it by TargetDilateUponFire; it closes at TargetConstrict a second', () => {
    const a = new Accuracy(HELD_RIFLE);
    expect(a.state().size).toBe(1);                                  // STANCE_STAND TargetMin 1
    a.round(0, 'stand');
    expect(a.state().size).toBe(8);                                  // + 7 (AccScalar_Max 0 on the SD: no growth)
    a.update(0.1, still);                                            // 6 ticks x 50/60
    expect(a.state().size).toBeCloseTo(8 - 50 * 6 * TICK, 9);
    a.update(1, still);
    expect(a.state().size).toBe(1);
    for (let i = 0; i < 10; i++) a.round(0, 'stand');
    expect(a.state().size).toBe(26);                                 // TargetMax 26
  });

  it('moving: aims at |v|^2 / 65 x Mult, opening 1 a tick; crouched the multiplier is 13', () => {
    const a = new Accuracy(HELD_RIFLE);
    const walk: AccuracyInput = { ...still, velocity: [30, 0, 0] };  // 900 / 65 = 13.85
    a.update(1, walk);
    expect(a.state().target).toBeCloseTo(900 / 65, 9);
    expect(a.state().size).toBeCloseTo(900 / 65, 9);
    const b = new Accuracy(HELD_RIFLE);
    b.update(3 * TICK, walk);
    expect(b.state().size).toBeCloseTo(1 + 3, 9);                  // TargetDilateUponMovement 1 a tick
    expect(movementSize(sd.crouch, { ...walk, velocity: [10, 0, 0] })).toBeCloseTo(100 / 65 * 13, 9);
    expect(movementSize(sd.prone, { ...walk, velocity: [3, 0, 0] })).toBeCloseTo(9 / 65 * 63, 9);
    // The standing run (65 units a second) is past TargetMax: the run opens it all the way.
    const run = new Accuracy(HELD_RIFLE);
    run.update(1, { ...still, velocity: [65, 0, 0] });
    expect(run.state().size).toBe(26);
  });

  it('turning and pitching count 158.7 x rate^2; in the air the carried speed counts twice', () => {
    expect(movementSize(sd.stand, { ...still, yawRate: 0.2 })).toBeCloseTo(5.29 * 30 * 0.04, 9);
    expect(movementSize(sd.stand, { ...still, pitchRate: 0.3 })).toBeCloseTo(5.29 * 30 * 0.09, 9);
    expect(movementSize(sd.stand, { ...still, velocity: [20, -5, 0], airborne: true })).toBeCloseTo((425 + 400) / 65, 9);
  });

  it('the M4A1 grows its bloom over a burst (AccBurstCnt 4..7, AccScalar 0..0.03); the SD does not', () => {
    expect([1, 2, 3].map((n) => burstScalar(DEFAULT_RIFLE, n))).toEqual([0, 0, 0]);
    expect(burstScalar(DEFAULT_RIFLE, 4)).toBeCloseTo(0.01, 12);    // n = 4 + 1 - 4 = 1, slope 0.03 / 3
    expect(burstScalar(DEFAULT_RIFLE, 30)).toBeCloseTo(0.07, 12);   // n capped at AccBurstCnt_Max 7 (not 3)
    expect(burstScalar(HELD_RIFLE, 30)).toBe(0);
    const wide = { ...DEFAULT_RIFLE, stances: { ...DEFAULT_RIFLE.stances, stand: { ...DEFAULT_RIFLE.stances.stand, targetMax: 100 } } };
    const a = new Accuracy(wide);
    for (let i = 0; i < 4; i++) a.round(0, 'stand');
    expect(a.state().size).toBeCloseTo(1 + 7 * 3 + 7 * 1.01, 9);
  });
});

describe('the knock (FUN_005c3360, FUN_005c2670)', () => {
  it('climbs 0.4 x 12 on the first round, 12 after, capped at 45; comes back at 70 a second', () => {
    const a = new Accuracy(HELD_RIFLE);
    a.trigger();
    a.round(0, 'stand');
    expect(a.state().offset[1]).toBeCloseTo(-4.8, 9);               // KnockCount 1 x KnockEntryStrength 0.4
    a.round(0, 'stand');
    expect(a.state().offset[1]).toBeCloseTo(-16.8, 9);
    for (let i = 0; i < 5; i++) a.round(0, 'stand');
    expect(a.state().offset[1]).toBe(-45);                            // ReticuleKnockMax
    a.update(0.5, still);                                            // 30 ticks x 70/60 = 35
    expect(a.state().offset[1]).toBeCloseTo(-10, 9);
    a.update(1, still);
    expect(a.state().offset[1]).toBe(0);
    // A new pull starts at the entry strength again.
    a.trigger();
    a.round(0, 'stand');
    expect(a.state().offset[1]).toBeCloseTo(-4.8, 9);
  });

  it('prone knocks 10 to a cap of 20 on the SD', () => {
    const a = new Accuracy(HELD_RIFLE);
    for (let i = 0; i < 6; i++) a.round(0, 'prone');
    expect(a.state().offset[1]).toBe(-20);
    expect(a.state().size).toBe(24);                                 // TargetMax prone 24
  });

  it('scoped (5+): no knock, no bloom; the first round kicks, the second drops the scope', () => {
    const a = new Accuracy(HELD_RIFLE);
    a.trigger();
    expect(a.round(5, 'stand')).toEqual({ dropZoom: false, kick: true });
    expect(a.round(5, 'stand')).toEqual({ dropZoom: true, kick: false });
    expect(a.state()).toMatchObject({ size: 1, offset: [0, 0], burst: 2 });
    expect(kickStarts(0, 1)).toBe(false);                            // unscoped: the camera never kicks
    expect(kickStarts(1, 1)).toBe(false);
    expect(kickStarts(5, 1)).toBe(true);
    expect(kickTicks(4)).toBe(true);
    expect(kickTicks(1)).toBe(false);
  });
});

describe('the cone (FUN_005bd100, FUN_00592260)', () => {
  it('turns pixels to tangents as the game does: tan(tan(hfov)) over the half frame', () => {
    const t = tangentPerPixel(MAP_FOV);
    expect(t.x).toBeCloseTo(Math.tan(Math.tan(0.6109)) / 320, 12);
    expect(t.y).toBeCloseTo(Math.tan(Math.tan(0.6109) * 448 / 640) / 224, 12);
    expect(t.y).toBeCloseTo(0.0023818, 6);
    const a = new Accuracy(HELD_RIFLE);
    a.round(0, 'stand');                                             // size 8, knock -4.8
    const c = a.cone(0, 1);
    expect(c.radius).toBeCloseTo(8 * t.y * RADIUS_FACTOR, 12);
    expect(c.offsetY).toBeCloseTo(4.8 * t.y, 12);                    // up is positive: the rounds climb with it
    expect(c.offsetX).toBe(0);
    expect(a.cone(5, 3).radius).toBe(0);                             // scoped: a point
  });

  it('spreads a round over a square, densest at its centre, never past its corners', () => {
    let i = 0;
    const seq = [0.5, 0.5, 1 - 1e-12, 0, 0.75, 0.25];
    const rand = (): number => seq[i++ % seq.length]!;
    const cone = { offsetX: 0, offsetY: 0, radius: 0.01 };
    expect(perturb([0, 0, -1], cone, rand)).toEqual([0, 0, -1]);    // u = 0 both: dead centre
    const edge = perturb([0, 0, -1], cone, rand);                   // u = +1, -1: the corner (+r, -r)
    expect(edge[0]).toBeCloseTo(0.01, 9);
    expect(edge[1]).toBeCloseTo(-0.01, 9);
    const mid = perturb([0, 0, -1], cone, rand);                    // u = 0.5, -0.5: a quarter of the way
    expect(mid[0]).toBeCloseTo(0.0025, 9);
    expect(mid[1]).toBeCloseTo(-0.0025, 9);
    // The axes: right = dir x up, up = right x dir -- for a level look along -z, +x and +y.
    const off = perturb([0, 0, -1], { offsetX: 0.02, offsetY: 0.03, radius: 0 }, () => 0.5);
    expect(off).toEqual([0.02, 0.03, -1]);
    // Looking 60 degrees down the axes shorten to cos 60 (the game does not normalise them).
    const d: [number, number, number] = [0, -Math.sin(Math.PI / 3), -Math.cos(Math.PI / 3)];
    const down = perturb(d, { offsetX: 0.02, offsetY: 0, radius: 0 }, () => 0.5);
    expect(down[0]).toBeCloseTo(0.02 * 0.5, 9);
  });

  it('a thousand rounds land inside the square, three quarters of them in its inner half', () => {
    const a = new Accuracy(HELD_RIFLE);
    for (let i = 0; i < 3; i++) a.round(0, 'stand');
    const c = a.cone(0, 1);
    let inner = 0;
    let seed = 7;
    const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 1000; i++) {
      const [x, y] = perturb([0, 0, -1], c, rand);
      expect(Math.abs(x - c.offsetX)).toBeLessThanOrEqual(c.radius + 1e-12);
      expect(Math.abs(y - c.offsetY)).toBeLessThanOrEqual(c.radius + 1e-12);
      if (Math.abs(x - c.offsetX) < c.radius / 2) inner++;
    }
    // P(|u|^2 < 1/2) = 1/sqrt(2) = 0.707 per axis.
    expect(inner / 1000).toBeGreaterThan(0.65);
    expect(inner / 1000).toBeLessThan(0.76);
  });
});

describe('the scoped sway (FUN_005b9280)', () => {
  it('drifts only scoped, within SniperDistLimit, turning at its ends', () => {
    const a = new Accuracy(HELD_RIFLE);
    a.update(1, still);
    expect(a.state().sway).toEqual([0, 0]);
    let maxX = 0;
    for (let i = 0; i < 600; i++) { a.update(TICK, { ...still, zoomState: 5 }); maxX = Math.max(maxX, Math.abs(a.state().sway[0])); }
    expect(maxX).toBe(20);                                           // SniperDistLimitX standing
    expect(Math.abs(a.state().sway[1])).toBeLessThanOrEqual(24);
    // The first tick: x += dt x (6 + 0.25) at the centre.
    const b = new Accuracy(HELD_RIFLE);
    b.update(TICK, { ...still, zoomState: 5 });
    expect(b.state().sway[0]).toBeCloseTo(6.25 * TICK, 12);
    // The cone follows it, not the size.
    expect(b.cone(5, 1).offsetX).toBeCloseTo(-6.25 * TICK * tangentPerPixel().x, 12);
  });
});

describe('the zoom on the cone (FUN_005bd100: the offsets over cam+0x474, the magnification)', () => {
  // FUN_005bd100 decomp 474236-474266: fVar9 = d_aim / (cam+0x474 x (d_aim - d_fire)) multiplies +0x5d4 and +0x5d8 (the
  // offsets: the knock unscoped, the sway scoped), not +0x5dc (the radius). cam+0x474 is the magnification on screen
  // (FUN_0029b2f0 with DAT_003dc338, x the NTSC 1.0), so a scope's rounds wander ZoomMode[state - 4] times less.
  const sd3x = HELD_RIFLE.zoomModes[1]!;                               // the SD's one scope level, 3x
  const scopedFor = (stance: AccuracyInput['stance'], seconds: number): Accuracy => {
    const a = new Accuracy(HELD_RIFLE);
    a.update(seconds, { ...still, stance, zoomState: 5 });
    return a;
  };

  it('scoped, the sway turns into tangents divided by the magnification: 3x on the SD is a third', () => {
    expect(sd3x).toBe(3);
    const a = scopedFor('stand', 2);
    const [sx, sy] = a.state().sway;
    const t = tangentPerPixel();
    const c = a.cone(5, sd3x);
    expect(c.radius).toBe(0);
    expect(c.offsetX).toBeCloseTo((-sx * t.x) / 3, 12);
    expect(c.offsetY).toBeCloseTo((-sy * t.y) / 3, 12);
    // The same sway at 1x (the zoom's run not yet started) is three times as far off the cross.
    expect(a.cone(5, 1).offsetX).toBeCloseTo(c.offsetX * 3, 12);
  });

  it('unscoped the magnification is 1: the knock and the bloom are as they were', () => {
    const a = new Accuracy(HELD_RIFLE);
    a.round(0, 'stand');
    const t = tangentPerPixel();
    const c = a.cone(0, 1);
    expect(c.offsetX).toBe(0);
    expect(c.offsetY).toBeCloseTo(4.8 * t.y, 12);
    expect(c.radius).toBeCloseTo(8 * t.y * RADIUS_FACTOR, 12);
  });

  it('a scoped round is never further off the cross than SniperDistLimit / ZoomMode, in every stance', () => {
    const t = tangentPerPixel();
    for (const stance of ['stand', 'crouch', 'prone'] as const) {
      const a = new Accuracy(HELD_RIFLE);
      let worstX = 0, worstY = 0;
      for (let i = 0; i < 1200; i++) {
        a.update(TICK, { ...still, stance, zoomState: 5 });
        const c = a.cone(5, sd3x);
        worstX = Math.max(worstX, Math.abs(c.offsetX));
        worstY = Math.max(worstY, Math.abs(c.offsetY));
      }
      expect(worstX).toBeCloseTo((sd[stance].swayLimitX * t.x) / 3, 9);
      expect(worstY).toBeLessThanOrEqual((sd[stance].swayLimitY * t.y) / 3 + 1e-12);
    }
  });

  it('measured: 600 rounds a second apart a tick -- the scope is a third of its 1x self and tighter than moving', () => {
    // The mean angle (radians) off the aim of one round a tick for 10 s, each through FUN_00592260's square.
    const spread = (input: AccuracyInput, magnification: number): number => {
      const a = new Accuracy(HELD_RIFLE);
      let seed = 11;
      const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      let sum = 0;
      for (let i = 0; i < 600; i++) {
        a.update(TICK, input);
        const [x, y] = perturb([0, 0, -1], a.cone(input.zoomState, magnification), rand);
        sum += Math.hypot(x, y);
      }
      return sum / 600;
    };
    const walking = { ...still, velocity: [30, 0, 0] as [number, number, number] };
    for (const stance of ['stand', 'crouch', 'prone'] as const) {
      const scoped = spread({ ...still, stance, zoomState: 5 }, sd3x);
      expect(scoped).toBeCloseTo(spread({ ...still, stance, zoomState: 5 }, 1) / 3, 12);
      expect(scoped).toBeLessThan(spread({ ...walking, stance }, 1));
    }
  });
});

describe('the fire modes (FUN_005c0940, FUN_005c09f0, FUN_005c4600)', () => {
  it('single 1 round a pull at FireWait, burst 3 and automatic at 0.8 x FireWait', () => {
    expect([0, 1, 2, 3].map(roundsPerPull)).toEqual([0, 1, 3, 10000]);
    expect(fireInterval(0.14, 1)).toBe(0.14);
    expect(fireInterval(0.14, 2)).toBeCloseTo(0.112, 12);
    expect(fireInterval(0.14, 3)).toBeCloseTo(0.112, 12);           // 536 rounds a minute on the SD
  });

  it('comes up on burst (FUN_005c0250); the switch goes single, burst, automatic and round; not while scoped', () => {
    expect(defaultFireMode(HELD_RIFLE)).toBe(2);
    expect(defaultFireMode({ ...HELD_RIFLE, maxFireMode: 3, fireModes: [1, 3] })).toBe(3);
    expect(nextFireMode(HELD_RIFLE, 3)).toBe(1);
    expect(nextFireMode(HELD_RIFLE, 1)).toBe(2);
    expect(nextFireMode(HELD_RIFLE, 2)).toBe(3);
    expect(nextFireMode(HELD_RIFLE, 3, true)).toBe(3);
    const m14 = { ...HELD_RIFLE, maxFireMode: 3, fireModes: [1, 3] };   // SingleMode + AutoMode, no burst
    expect(nextFireMode(m14, 1)).toBe(3);
  });
});

describe('penetrate (FUN_003c8920)', () => {
  it('passes over 1.0, strikes the rest, and cuts the range by (1 + Piercing x 0.1) x PENETRATION', () => {
    // range 100, Piercing 3: glass 0.99 -> 128.7, not less, kept 100; metal 0.35 -> 45.5.
    expect(penetrate([{ distance: 10, penetration: 1 }, { distance: 20, penetration: 0.99 }, { distance: 30, penetration: 0.35 },
      { distance: 40, penetration: 0 }], 100, 3)).toMatchObject({ struck: [1, 2, 3], through: false });
    expect(penetrate([{ distance: 30, penetration: 0.35 }, { distance: 50, penetration: 0 }], 100, 3)).toEqual({ struck: [0], through: true, range: 45.5 });   // 45.5: spent
    expect(penetrate([{ distance: 120, penetration: 0 }], 100, 3)).toEqual({ struck: [], through: true, range: 100 });   // out of range
    expect(penetrate([{ distance: 20, penetration: 0.99 }], 100, 3)).toEqual({ struck: [0], through: true, range: 100 });
    expect(penetrate([{ distance: 50, penetration: 0.35 }], 100, 0)).toEqual({ struck: [0], through: false, range: 35 });   // 35 < 50
  });
});
