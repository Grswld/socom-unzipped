import { describe, expect, it } from 'vitest';
import { firstStrikable, levelDirection, SWEEP_YAWS, sweepHeading } from '../sweepHeading';

/**
 * The release sweep's mark heading (release review PL-1, the MP71 "no mark" survivor): the magazine goes down the heading
 * whose first STRIKABLE surface is nearest -- a surface whose `PENETRATION` is not exactly 1, the rounds' own rule
 * (`HandleIntersections` FUN_003c9b70, decomp 320028-320030: `if (fVar15 != 1.0)`; `accuracy.ts` `penetrate`) -- not the
 * heading the walk gets least far along, which on MP71 is blocked only by INVISIBLE_DI (PENETRATION 1).
 */
describe('sweepHeading: the nearest strikable surface of the eight headings', () => {
  // MP71 from the sweep's spawn (1199, 45.7, 1450), read off the disc (review.json, the MP71 survivor's verdict):
  // yaw 135 meets only INVISIBLE_DI (1) at 72.1, 124.1 and 147.4; yaw 315 INVISIBLE_DI at 68.1, then WOOD_THICK (0) at 120.
  const INVISIBLE = 1, WOOD_THICK = 0;
  const mp71 = [
    { yaw: 135, surfaces: [{ distance: 72.1, penetration: INVISIBLE }, { distance: 124.1, penetration: INVISIBLE }, { distance: 147.4, penetration: INVISIBLE }] },
    { yaw: 315, surfaces: [{ distance: 68.1, penetration: INVISIBLE }, { distance: 120, penetration: WOOD_THICK }] },
  ];

  it('MP71: skips the heading blocked only by invisible collision and takes yaw 315 (the wood at 120)', () => {
    expect(sweepHeading(mp71)).toEqual({ yaw: 315, distance: 120 });
  });

  it('a heading with only PENETRATION 1 surfaces, or none at all, is never the mark heading; all such is null', () => {
    expect(sweepHeading([mp71[0]!])).toBeNull();
    expect(sweepHeading([{ yaw: 0, surfaces: [] }, mp71[0]!])).toBeNull();
    expect(sweepHeading([])).toBeNull();
  });

  it('glass (0.99) is struck -- only exactly 1 is passed over -- and the nearest struck surface wins', () => {
    const glass = { yaw: 45, surfaces: [{ distance: 90, penetration: 0.99 }] };
    const stone = { yaw: 90, surfaces: [{ distance: 40, penetration: 1 }, { distance: 95, penetration: 0 }] };
    expect(firstStrikable(glass.surfaces)).toEqual({ distance: 90, penetration: 0.99 });
    expect(sweepHeading([stone, glass])).toEqual({ yaw: 45, distance: 90 });
    expect(sweepHeading([...mp71, glass])).toEqual({ yaw: 45, distance: 90 });
  });

  it('a tie keeps the earlier heading (the sweep lists them 0, 45, ... 315)', () => {
    const a = { yaw: 0, surfaces: [{ distance: 50, penetration: 0 }] }, b = { yaw: 180, surfaces: [{ distance: 50, penetration: 0.5 }] };
    expect(sweepHeading([a, b])).toEqual({ yaw: 0, distance: 50 });
    expect(SWEEP_YAWS).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });

  it('levelDirection is the page camera\'s forward: yaw = atan2(-dx, -dz) (camera.ts), level', () => {
    const near = (a: readonly number[], b: readonly number[]): void => { for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 12); };
    near(levelDirection(0), [0, 0, -1]);
    near(levelDirection(90), [-1, 0, 0]);
    near(levelDirection(135), [-Math.SQRT1_2, 0, Math.SQRT1_2]);
    for (const yaw of SWEEP_YAWS) {
      const d = levelDirection(yaw);
      expect(Math.hypot(...d)).toBeCloseTo(1, 12);
      expect(((Math.atan2(-d[0], -d[2]) * 180) / Math.PI + 360) % 360).toBeCloseTo(yaw, 9);
    }
  });
});
