import { describe, expect, it } from 'vitest';
import { boostFromRim, DEAD_ZONE, knobOffset, stickVector } from '../src/touch';

/**
 * The stick's one piece of arithmetic: a thumb's offset in CSS pixels turned into an axis pair the
 * camera can add to its wish vector. Everything else about the touch controls is DOM plumbing; this
 * is the part that can be wrong in a way nobody would see until the camera drifted.
 */
const R = 100;                                  // a round radius, so the numbers below read by eye

describe('stickVector', () => {
  it('is zero at rest, and zero anywhere inside the dead zone', () => {
    expect(stickVector(0, 0, R)).toEqual({ x: 0, y: 0 });
    // A thumb resting on glass wanders a few pixels; that must not move the camera.
    expect(stickVector(0, R * DEAD_ZONE * 0.99, R)).toEqual({ x: 0, y: 0 });
    expect(stickVector(R * DEAD_ZONE, 0, R)).toEqual({ x: 0, y: 0 });
  });

  it('pushed up the screen is forward: the y axis flips', () => {
    // A pointer's dy grows downwards, so up the screen is negative, and forward is positive.
    const forward = stickVector(0, -R, R);
    expect(forward.y).toBeCloseTo(1, 6);
    expect(forward.x).toBe(0);
    const back = stickVector(0, R, R);
    expect(back.y).toBeCloseTo(-1, 6);
  });

  it('pushed across the screen strafes, right positive', () => {
    expect(stickVector(R, 0, R).x).toBeCloseTo(1, 6);
    expect(stickVector(-R, 0, R).x).toBeCloseTo(-1, 6);
    expect(stickVector(R, 0, R).y).toBe(-0);     // no forward component from a pure strafe
  });

  it('clamps at the rim: dragging past the base is fully pushed, not faster', () => {
    const far = stickVector(0, -R * 4, R);
    expect(far.y).toBeCloseTo(1, 6);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(1, 6);
  });

  it('never leaves the unit disc, whatever the offset', () => {
    for (const [dx, dy] of [[R, R], [-R * 3, R * 2], [7, -9], [R * 0.7, -R * 0.7]]) {
      const v = stickVector(dx!, dy!, R);
      expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('rescales past the dead zone instead of jumping to it', () => {
    // Just outside the zone the magnitude is near zero, not near DEAD_ZONE: leaving the zone must not
    // start the camera at a tenth of full speed.
    const justOut = stickVector(0, -(R * DEAD_ZONE + 1), R);
    expect(Math.hypot(justOut.x, justOut.y)).toBeLessThan(0.02);
    // And halfway between the zone's edge and the rim is halfway up the range.
    const half = stickVector(0, -(R * (DEAD_ZONE + (1 - DEAD_ZONE) / 2)), R);
    expect(Math.hypot(half.x, half.y)).toBeCloseTo(0.5, 6);
  });

  it('keeps the direction the thumb was pushed, whatever the shaping does to the magnitude', () => {
    const v = stickVector(30, -40, R);           // a 3-4-5 triangle: up and to the right
    expect(v.x / v.y).toBeCloseTo(30 / 40, 6);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBeGreaterThan(0);
  });
});

describe('knobOffset', () => {
  it('follows the thumb inside the base', () => {
    expect(knobOffset(10, -20, R)).toEqual({ x: 10, y: -20 });
  });

  it('sticks to the rim outside it, keeping the direction', () => {
    const at = knobOffset(300, -400, R);         // 3-4-5 again, five times the radius
    expect(Math.hypot(at.x, at.y)).toBeCloseTo(R, 6);
    expect(at.x).toBeCloseTo(60, 6);
    expect(at.y).toBeCloseTo(-80, 6);
  });
});

/**
 * The boost gesture on a phone: the thumb pushed to the stick's rim and held there. A moment at the rim
 * is ordinary steering; holding it is the ask.
 */
describe('boostFromRim', () => {
  it('needs the stick at the rim and held there a while', () => {
    expect(boostFromRim(1, 400)).toBe(true);
    expect(boostFromRim(0.98, 1000)).toBe(true);
  });
  it('is not a boost short of the rim, however long', () => {
    expect(boostFromRim(0.8, 5000)).toBe(false);
  });
  it('is not a boost at the rim for a moment', () => {
    expect(boostFromRim(1, 100)).toBe(false);
  });
});
