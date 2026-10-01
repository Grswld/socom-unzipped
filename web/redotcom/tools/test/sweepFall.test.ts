import { describe, expect, it } from 'vitest';
import { descentBelow, FALL_MARGIN, fallThroughs, type FallFrame } from '../sweepFall';

/**
 * The release sweep's fall-through check (release review PL-1, the MP1/MP11 survivor): the feet against the floor the
 * walk picks under them (`selectFloor(probeGround(x, z), from + PROBE_LIFT, y)`, FUN_005b5d40 470163-470290), not the
 * descent from the spawn. FUN_0059ad30 (456313-456322) puts the feet on that floor whenever they are under it, on the
 * ground and in the air; only the running jump's wind-up (actor+0x1360 > 0) lets them sink, 0.98 in five ticks
 * (`mover.ts` `fall`). So feet more than `FALL_MARGIN` under the pick is a floor the mover went through.
 */
const frame = (t: number, y: number, floor: number | null, air = false): FallFrame => ({ t, feet: [0, y, t], air, floor });

describe('fallThroughs: feet under the floor the walk picks under them', () => {
  it('a 160-unit descent with the floor under the feet all the way is no fall (MP1, MP11: terrain)', () => {
    const walk = Array.from({ length: 161 }, (_, i) => frame(i * 16, 200 - i, 200 - i));
    expect(fallThroughs(walk)).toEqual([]);
    expect(descentBelow(200, walk)).toBe(160);                   // kept as information: minYBelowSpawn
  });

  it('a 30-unit walk with the floor 8 over the feet for three grounded frames is one fall-through', () => {
    const walk = Array.from({ length: 30 }, (_, i) => frame(i * 16, 50, i >= 10 && i < 13 ? 58 : 50));
    const found = fallThroughs(walk);
    expect(found).toEqual([{ t: 160, frames: 3, depth: 8, air: false }]);
  });

  it('a running jump off a bank landing 122 down on the floor there is no fall (MP1: a death-class landing, not a fall-through)', () => {
    const walk: FallFrame[] = [frame(0, 208.6, 208.6)];
    for (let i = 1; i <= 90; i++) { const y = 208.6 - (i * 122) / 90; walk.push(frame(i * 16, y, 86.7, true)); }
    walk.push(frame(91 * 16, 86.7, 86.7));
    expect(fallThroughs(walk)).toEqual([]);
  });

  it('the wind-up\'s sink (0.98, airborne) is under the margin; feet through a floor in the air are found', () => {
    expect(FALL_MARGIN).toBe(1);
    const windUp = [frame(0, 10, 10), frame(16, 9.02, 10, true), frame(32, 13, 10, true), frame(48, 10, 10)];
    expect(fallThroughs(windUp)).toEqual([]);
    const through = [frame(0, 40, 40), frame(16, 30, 38, true), frame(32, 20, 38, true), frame(48, 10, 38, true)];
    expect(fallThroughs(through)).toEqual([{ t: 16, frames: 3, depth: 28, air: true }]);
  });

  it('frames with no feet or no floor (the pick refused: nothing within 20 over the feet) are not read', () => {
    const walk: FallFrame[] = [{ t: 0, feet: null, air: false, floor: 30 }, frame(16, 0, null, true), frame(32, 0, 0)];
    expect(fallThroughs(walk)).toEqual([]);
    expect(descentBelow(10, [{ t: 0, feet: null, air: false, floor: null }])).toBeNull();
  });
});
