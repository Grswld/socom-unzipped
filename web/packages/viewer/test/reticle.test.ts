import { describe, expect, it } from 'vitest';
import { ARM_TINT, CONSOLE_RETICLE, RETICLE_SETS, reticleLayout, reticleTint, reticleType, scopeLayout } from '../src/reticle';

/**
 * The reticle's place and size (web sprint 2, W2.4), against the console frame at spawn
 * (`scripts/parity/refs/console_spawn_slot8.png`, 640x448): the yellow-green cross's pixels span x 288-352 and
 * y 192-256 (65 x 65, the faint ends included), its centre (320.5, 224.5) -- the frame's centre within a pixel.
 */

const PS2 = { width: 640, height: 448 };
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;

describe('reticleLayout', () => {
  it('at 640x448 with the aim point at the centre, the quads cover the console frame\'s cross within a pixel', () => {
    const { rect, scale } = reticleLayout(PS2, [0.5, 0.5], 0);
    expect(scale).toBe(1);
    const m = CONSOLE_RETICLE.rect;
    expect(m).toEqual({ x: 288, y: 192, width: 65, height: 65 });
    expect(near(rect.x, m.x) && near(rect.y, m.y) && near(rect.width, m.width) && near(rect.height, m.height),
      JSON.stringify(rect)).toBe(true);
    expect(near(rect.x + rect.width / 2, CONSOLE_RETICLE.centre[0])).toBe(true);
    expect(near(rect.y + rect.height / 2, CONSOLE_RETICLE.centre[1])).toBe(true);
  });

  it('the fixed part is ret_rifle_01 at its own 64 pixels; the four arms are ret_rifle_02 turned a quarter each', () => {
    const { quads } = reticleLayout(PS2, [0.5, 0.5], 0);
    const fixed = quads.filter((q) => q.part === 'fixed');
    const arms = quads.filter((q) => q.part === 'floating');
    expect(fixed).toEqual([{ part: 'fixed', x: 320, y: 224, width: 64, height: 64, turns: 0 }]);
    expect(arms.map((q) => q.turns)).toEqual([0, 1, 2, 3]);
    for (const a of arms) expect([a.width, a.height]).toEqual([32, 32]);
    // The arm's core (texel column 30) lies on the axis through the aim point; its outer end 32 pixels out.
    const [down, left, up, right] = arms;
    expect([down!.x, down!.y]).toEqual([320 - 14.5, 224 + 16]);
    expect([left!.x, left!.y]).toEqual([320 - 16, 224 - 14.5]);
    expect([up!.x, up!.y]).toEqual([320 + 14.5, 224 - 16]);
    expect([right!.x, right!.y]).toEqual([320 + 16, 224 + 14.5]);
  });

  it('follows the aim point; the HUD size pushes each arm out by its own pixels; the knock moves the whole reticle', () => {
    const moved = reticleLayout(PS2, [0.25, 0.75], 0).rect;
    expect([moved.x, moved.y]).toEqual([160 - 32, 336 - 32]);
    // FUN_00215250: each arm's quad starts `size` pixels from the centre, so the outer ends sit at 32 + size.
    const wide = reticleLayout(PS2, [0.5, 0.5], 16).rect;
    expect(wide).toEqual({ x: 320 - 48, y: 224 - 48, width: 96, height: 96 });
    // TargetMax 26, drawn full in first person: the outer ends 58 out.
    expect(reticleLayout(PS2, [0.5, 0.5], 26).rect.width).toBe(116);
    expect(reticleLayout(PS2, [0.5, 0.5], -3).rect.width).toBe(64);       // never inside the rest
    // The knock (FUN_00216770: centre + kit+0x20/+0x24): 12 pixels up moves ring and arms alike.
    const { centre, quads } = reticleLayout(PS2, [0.5, 0.5], 0, [0, -12]);
    expect(centre).toEqual([320, 212]);
    expect(quads.find((q) => q.part === 'fixed')).toMatchObject({ x: 320, y: 212 });
  });

  it('the rest in third person: TargetMin 1 halved is the console frame within its pixel', () => {
    const { rect } = reticleLayout(PS2, [0.5, 0.5], 0.5);
    const m = CONSOLE_RETICLE.rect;
    expect(near(rect.x, m.x) && near(rect.width, m.width)).toBe(true);
  });

  it('keeps the console\'s proportion on any frame: the PS2 pixel scaled by the frame height / 448', () => {
    const { rect, scale } = reticleLayout({ width: 1920, height: 1080 }, [0.5, 0.5], 0);
    expect(scale).toBeCloseTo(1080 / 448, 12);
    expect(rect.width).toBeCloseTo(64 * scale, 9);
    expect(rect.x + rect.width / 2).toBeCloseTo(960, 9);
    expect(rect.y + rect.height / 2).toBeCloseTo(540, 9);
  });
});

describe('the reticle set, colour and scope (research 84)', () => {
  it('picks the set by the view, then the weapon ID (FUN_005be300)', () => {
    expect(reticleType(62, 0, 1)).toBe(1);        // the M4A1 SD: a rifle
    expect(reticleType(54, 1, 1.01)).toBe(1);     // first person is still the rifle's
    expect(reticleType(62, 5, 3)).toBe(5);        // scoped: the scope
    expect(reticleType(62, 4, 9)).toBe(7);        // the 9x view
    expect(reticleType(5, 0, 1)).toBe(0);         // the M9: the sidearm's
    expect(reticleType(84, 0, 1)).toBe(2);        // the 870: the shotgun's
    expect(reticleType(101, 0, 1)).toBe(1);       // the M82A1A unscoped: a rifle's
    expect(reticleType(121, 0, 1)).toBe(4);       // the M67: the grenade's
    expect(reticleType(11, 0, 1)).toBe(9);        // the designator
    expect(reticleType(0x98, 0, 1)).toBe(-1);
    expect(RETICLE_SETS[1]).toEqual({ fixed: 'ret_rifle_01.tif', floating: 'ret_rifle_02.tif' });
  });

  it('colours the arms as FUN_00215c10 does, the rest one the measured tint', () => {
    expect(reticleTint('rest')).toEqual(ARM_TINT);
    const [r, g, b] = reticleTint('friendly');
    expect(g).toBeCloseTo(ARM_TINT[1], 9);
    expect(r).toBeLessThan(0.15);
    expect(b).toBeGreaterThan(ARM_TINT[2]);
    expect(reticleTint('hostile')[1]).toBeLessThan(0.15);
  });

  it('lays the scope as four 320-pixel quads around the frame centre, mirrored to meet there', () => {
    const { quads, bars } = scopeLayout(PS2);
    expect(quads.map((q) => [q.x, q.y, q.size])).toEqual([[160, 64, 320], [480, 64, 320], [160, 384, 320], [480, 384, 320]]);
    expect(quads.map((q) => [q.flipX, q.flipY])).toEqual([[false, true], [true, true], [false, false], [true, false]]);
    expect(bars).toEqual([]);
    const wide = scopeLayout({ width: 1920, height: 1080 });
    const s = 1080 / 448;
    expect(wide.quads[0]!.size).toBeCloseTo(320 * s, 9);
    expect(wide.bars[0]!.width).toBeCloseTo(960 - 320 * s, 9);
  });
});
