import { describe, expect, it } from 'vitest';
import { nightColour, nightRow, nightVisionRow, setNightVision } from '../src/nightVision';

/** `LensFX_NVG` on every night map. */
const LENS: [number, number, number, number] = [0.2, 0.898, 0.2, 0.24];

describe('nightVision: VU1 command 0x5c (research 84 section 14)', () => {
  it('builds FUN_003b78d0\'s row: 0.33 x the lens\'s colour, 3.0303 x its alpha', () => {
    const r = nightRow(LENS);
    expect(r[0]).toBeCloseTo(0.066, 6);
    expect(r[1]).toBeCloseTo(0.29634, 6);
    expect(r[2]).toBeCloseTo(0.066, 6);
    expect(r[3]).toBeCloseTo(0.727273, 5);
  });

  it('turns a lit colour into row.rgb x (R + G + B + row.a), alpha kept (the 0x4d8 routine)', () => {
    // A night-lit grey at a third of unity: the green channel near its old brightness, red and blue a fifth of it.
    const [r, g, b, a] = nightColour([1 / 3, 1 / 3, 1 / 3, 0.5], LENS);
    const sum = 1 + 0.727273 / 128;
    expect(g).toBeCloseTo(0.29634 * sum, 6);
    expect(r).toBeCloseTo(0.066 * sum, 6);
    expect(b).toBe(r);
    expect(a).toBe(0.5);
    // Monochrome: two colours of the same sum come out the same.
    expect(nightColour([0.9, 0.05, 0.05, 1], LENS)).toEqual(nightColour([0.05, 0.05, 0.9, 1], LENS));
  });

  it('reports the row while the goggles are on, and none after', () => {
    setNightVision(LENS);
    const row = nightVisionRow()!;
    expect(row[1]).toBeCloseTo(0.29634, 5);
    expect(row[3]).toBeCloseTo(0.727273, 4);
    setNightVision(null);
    expect(nightVisionRow()).toBeNull();
  });
});
