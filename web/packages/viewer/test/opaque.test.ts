import { describe, expect, it } from 'vitest';
import { isOpaque } from '../src/loadMap';

/**
 * `isOpaque` decides backface culling (`world.ts`): a solid texture skins a closed thing and its back
 * faces are culled, anything with a hole is a sheet and keeps both faces. Getting it wrong either
 * empties Bitter Jungle's canopies or puts Crossroads' awning back into a z-fighting plaid, so the
 * threshold and the sampling are pinned here.
 */
const rgba = (alphas: number[]): { data: Uint8ClampedArray; width: number; height: number } => {
  const data = new Uint8ClampedArray(alphas.length * 4);
  alphas.forEach((a, i) => { data[i * 4] = 200; data[i * 4 + 1] = 100; data[i * 4 + 2] = 50; data[i * 4 + 3] = a; });
  return { data, width: alphas.length, height: 1 };
};

describe('isOpaque', () => {
  it('is true when every pixel is solid', () => {
    expect(isOpaque(rgba(Array<number>(64).fill(255)))).toBe(true);
  });

  it('accepts the 247..255 band the graded test also treats as solid', () => {
    expect(isOpaque(rgba(Array<number>(64).fill(247)))).toBe(true);
  });

  it('is false for a single punched-out texel: one hole makes it a sheet', () => {
    const a = Array<number>(64).fill(255);
    a[40] = 0;
    expect(isOpaque(rgba(a))).toBe(false);
  });

  it('is false for a soft edge as well as a hard hole', () => {
    const a = Array<number>(64).fill(255);
    a[7] = 246;
    expect(isOpaque(rgba(a))).toBe(false);
  });

  it('samples a large texture rather than every pixel, and still catches a whole clear region', () => {
    // 256x256: the step is 16 pixels, so a hole has to be wider than that to be seen -- a cutout is.
    const a = Array<number>(256 * 256).fill(255);
    for (let i = 1000; i < 9000; i++) a[i] = 0;
    expect(isOpaque(rgba(a))).toBe(false);
  });
});
