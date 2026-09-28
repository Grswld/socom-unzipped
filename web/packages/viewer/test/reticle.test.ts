import { describe, expect, it } from 'vitest';
import { CONSOLE_RETICLE, reticleLayout } from '../src/reticle';

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

  it('follows the aim point, and the spread pushes the arms out to 1.5x the rest reach', () => {
    const moved = reticleLayout(PS2, [0.25, 0.75], 0).rect;
    expect([moved.x, moved.y]).toEqual([160 - 32, 336 - 32]);
    const wide = reticleLayout(PS2, [0.5, 0.5], 1).rect;
    expect(wide).toEqual({ x: 320 - 48, y: 224 - 48, width: 96, height: 96 });
    const half = reticleLayout(PS2, [0.5, 0.5], 0.5).rect;
    expect(half.width).toBe(80);
    expect(reticleLayout(PS2, [0.5, 0.5], 7).rect).toEqual(wide);   // clamped to 0..1
  });

  it('keeps the console\'s proportion on any frame: the PS2 pixel scaled by the frame height / 448', () => {
    const { rect, scale } = reticleLayout({ width: 1920, height: 1080 }, [0.5, 0.5], 0);
    expect(scale).toBeCloseTo(1080 / 448, 12);
    expect(rect.width).toBeCloseTo(64 * scale, 9);
    expect(rect.x + rect.width / 2).toBeCloseTo(960, 9);
    expect(rect.y + rect.height / 2).toBeCloseTo(540, 9);
  });
});
