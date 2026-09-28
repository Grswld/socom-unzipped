import { describe, expect, it } from 'vitest';
import {
  Body, CROUCH_HEIGHT, HEAD_HEIGHT, PRONE_HEIGHT, SHOULDER_WIDTH, STANDING_HEIGHT, bodyForward, strideCadence,
} from '../src/body';

/**
 * The stand-in body (web sprint 2, W2.3). The numbers are `body.ts`'s header's: the standing height 19.6 over the
 * feet (the skeleton's head joint at 17.37 on the console dump's standing actors, plus the head's 2.23 measured on
 * the console frame), the crouch 12.4 (the console frame at spawn, the SEAL crouched), the shoulders 5.1 wide (the
 * frame), the prone 3.0 (an estimate).
 */

const FEET: [number, number, number] = [100, -50, 200];
const DT = 1 / 60;
/** A body stood at `FEET`, facing `yaw` degrees, at rest, seen from 25 units behind (outside it). */
function standing(yaw = 0): Body {
  const b = new Body(() => 1);
  b.update(FEET, yaw, DT, [FEET[0], FEET[1] + 20, FEET[2] + 25]);
  b.update(FEET, yaw, DT, [FEET[0], FEET[1] + 20, FEET[2] + 25]);
  return b;
}

describe('the measured dimensions', () => {
  it('stands 19.6 over the feet -- 1.96 m at MetersPerUnit 0.1 -- with the eye 18.3 inside the head', () => {
    expect(STANDING_HEIGHT).toBe(19.6);
    expect(STANDING_HEIGHT * 0.1).toBeGreaterThan(1.6);
    expect(STANDING_HEIGHT * 0.1).toBeLessThan(2.0);
    expect(HEAD_HEIGHT).toBe(18.3);
    const b = standing();
    const s = b.state();
    expect(s.height).toBeCloseTo(STANDING_HEIGHT, 1);
    expect(s.bounds!.min[1]).toBeCloseTo(FEET[1], 0);          // the soles on the feet's floor
    const head = b.headSphere();
    expect(head.centre[1] - head.radius).toBeLessThan(HEAD_HEIGHT + FEET[1]);
    expect(head.centre[1] + head.radius).toBeCloseTo(STANDING_HEIGHT + FEET[1], 5);
    expect(HEAD_HEIGHT + FEET[1]).toBeLessThan(head.centre[1] + head.radius);
  });

  it('is the shoulders\' 5.1 wide across its facing, and within the 3.5 body radius front to back', () => {
    const s = standing(0).state();
    expect(SHOULDER_WIDTH).toBe(5.1);
    expect(s.bounds!.max[0] - s.bounds!.min[0]).toBeCloseTo(SHOULDER_WIDTH, 1);
    expect(s.bounds!.max[2] - s.bounds!.min[2]).toBeLessThan(2 * 3.5);
  });

  it('crouches to the console frame\'s 12.4 and lies prone at 3.0 [estimate], longer than it is tall', () => {
    const b = standing();
    b.setStance('crouch');
    b.update(FEET, 0, DT, [FEET[0], FEET[1] + 20, FEET[2] + 25]);
    expect(CROUCH_HEIGHT).toBe(12.4);
    expect(b.state().height).toBeCloseTo(CROUCH_HEIGHT, 1);
    expect(b.state().bounds!.min[1]).toBeGreaterThan(FEET[1] - 0.2);
    b.setStance('prone');
    b.update(FEET, 0, DT, [FEET[0], FEET[1] + 20, FEET[2] + 25]);
    expect(PRONE_HEIGHT).toBe(3);
    const p = b.state();
    expect(p.height).toBeCloseTo(PRONE_HEIGHT, 1);
    expect(p.bounds!.max[2] - p.bounds!.min[2]).toBeGreaterThan(15);
    b.setStance('stand');
    b.update(FEET, 0, DT, [FEET[0], FEET[1] + 20, FEET[2] + 25]);
    expect(b.state().height).toBeCloseTo(STANDING_HEIGHT, 1);
  });
});

describe('the facing', () => {
  it('faces (-sin yaw, -cos yaw): -z at yaw 0, -x at yaw 90 (walk.ts, the camera looks down its own -z)', () => {
    const f0 = bodyForward(0), f90 = bodyForward(90);
    expect(f0[0]).toBeCloseTo(0, 6); expect(f0[1]).toBeCloseTo(-1, 6);
    expect(f90[0]).toBeCloseTo(-1, 6); expect(f90[1]).toBeCloseTo(0, 6);
    const b = standing(90);
    const f = b.forward();
    expect(f[0]).toBeCloseTo(-1, 6); expect(f[1]).toBeCloseTo(0, 6);
    // Prone, the body lies along its facing: its length runs along x at yaw 90.
    b.setStance('prone');
    b.update(FEET, 90, DT, [FEET[0] + 25, FEET[1] + 20, FEET[2]]);
    const s = b.state();
    expect(s.bounds!.max[0] - s.bounds!.min[0]).toBeGreaterThan(15);
    expect(s.bounds!.min[0]).toBeLessThan(FEET[0] - 5);          // the head ahead, towards -x
  });
});

describe('the stride', () => {
  it('at 65 units/s (the run, motion.rdr 6.5 m/s) cycles 1.52 times a second: a 42.6-unit stride', () => {
    expect(strideCadence(65)).toBeCloseTo(65 / (STANDING_HEIGHT * (0.55 + 0.025 * 65)), 6);
    expect(strideCadence(65)).toBeCloseTo(1.525, 2);
    expect(strideCadence(0)).toBe(0);
    expect(strideCadence(14.8)).toBeLessThan(strideCadence(65));
  });

  it('takes the speed from the feet it is given, and swings the legs only when they move', () => {
    const b = standing();
    const still = b.legAngles();
    for (let i = 1; i <= 30; i++) b.update([FEET[0], FEET[1], FEET[2] - (65 * i) / 60], 0, DT, [0, 1000, 0]);
    expect(b.speed()).toBeCloseTo(65, 3);
    expect(b.phase()).toBeCloseTo(2 * Math.PI * strideCadence(65) * 30 / 60, 3);
    const moving = b.legAngles();
    expect(moving[0]).not.toBeCloseTo(still[0], 2);
    expect(Math.sign(moving[0] - still[0])).toBe(-Math.sign(moving[1] - still[1]));   // the legs swing opposite
  });
});

describe('what is drawn', () => {
  it('hides the head and torso while the eye is inside them (the first-person walk), shows them from outside', () => {
    const b = standing();
    b.update(FEET, 0, DT, [FEET[0], FEET[1] + 15.4, FEET[2]]);
    expect(b.upperShown()).toBe(false);
    b.update(FEET, 0, DT, [FEET[0], FEET[1] + 20.107, FEET[2] + 24.2]);
    expect(b.upperShown()).toBe(true);
  });

  it('is shown only when asked, and has no bounds before it is stood anywhere', () => {
    const fresh = new Body(() => 1);
    expect(fresh.state()).toEqual({ visible: false, height: 0, bounds: null });
    const b = standing();
    expect(b.state().visible).toBe(false);
    b.setVisible(true);
    expect(b.state().visible).toBe(true);
    b.update(null, 0, DT, [0, 0, 0]);                              // fly mode: no feet
    expect(b.state().visible).toBe(false);
  });
});
