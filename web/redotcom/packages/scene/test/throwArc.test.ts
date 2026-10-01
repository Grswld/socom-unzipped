import { describe, expect, it } from 'vitest';
import {
  actorToWorldDir, actorToWorldPoint, arcPoint, launchGrenade, stepGrenade, THROW_ANIMS, THROW_ARC, throwArc,
  throwArcTime, throwVelocity, type V3,
} from '../src/index';

/**
 * The yellow arc a held grenade shows (web/redotcom/docs/research/85 §11): `CSealCtrl`'s draw `FUN_005970b0` and
 * `ai::DrawFunc<CDynGrenade>` (`FUN_00598860`). The arc is the throw's own parabola, so it must be the path the
 * flight (`stepGrenade`) takes from the same launch, up to the flight's per-frame integration.
 */

const TICK = 1 / 60;

describe('the arc\'s numbers (.data 0x6505f0-0x650608, 0x597498, 0x59743c-0x59747c)', () => {
  it('100 segments from a second before the hand to twice the fall to the feet, 0.75 -> 0.1, yellow', () => {
    expect(THROW_ARC.segments).toBe(100);
    expect(THROW_ARC.start).toBe(-1);
    expect(THROW_ARC.endScale).toBe(2);
    expect(THROW_ARC.alpha).toEqual([0.75, 0.1]);
    expect(THROW_ARC.color[0]).toBeCloseTo(0.78, 6);
    expect(THROW_ARC.color[1]).toBeCloseTo(0.78, 6);
    expect(THROW_ARC.color[2]).toBe(0);
    expect(THROW_ARC.nightColor[0]).toBe(1);
    expect(THROW_ARC.nightColor[2]).toBeCloseTo(0.8, 6);
  });
});

describe('the arc (FUN_00598860)', () => {
  const hand = THROW_ANIMS.standThrow.offset;
  const launch = throwVelocity(0.8, 0.1, hand, 600);
  const from = actorToWorldPoint([100, 50, 200], 30, hand);
  const vel = actorToWorldDir(30, launch.velocity);

  it('ends at twice the later root of -49 t^2 + vy t + h', () => {
    const t = throwArcTime(vel[1], hand[1]);
    expect(-49 * t * t + vel[1] * t + hand[1]).toBeCloseTo(0, 6);
    expect(t).toBeGreaterThan(0);
    const arc = throwArc(from, vel, hand[1]);
    expect(arc.t0).toBe(-1);
    expect(arc.t1).toBeCloseTo(2 * t, 9);
    // The fall to the feet's level lands at the feet's height.
    expect(arcPoint(from, vel, t)[1]).toBeCloseTo(50, 6);
  });

  it('its float step runs 100 inside the loop and one closing segment: 101 segments, alpha by the step', () => {
    const arc = throwArc(from, vel, hand[1]);
    expect(arc.points.length).toBe(102);
    expect(arc.alphas.length).toBe(101);
    expect(arc.points[0]).toEqual(arcPoint(from, vel, -1));
    const last = arc.points[arc.points.length - 1]!;
    arcPoint(from, vel, arc.t1).forEach((c, i) => expect(last[i]).toBeCloseTo(c, 9));
    expect(arc.alphas[0]).toBeCloseTo(0.75 * 0.99 + 0.1 * 0.01, 6);
    expect(arc.alphas[100]).toBeCloseTo(0.1, 9);
    for (let i = 1; i < arc.alphas.length; i++) expect(arc.alphas[i]!).toBeLessThanOrEqual(arc.alphas[i - 1]!);
  });

  it('no arc when the start is not before the end', () => {
    expect(throwArc(from, vel, hand[1], { ...THROW_ARC, start: 1e6 }).points).toEqual([]);
  });

  it('is the flight\'s own path: every simulated frame lies on it, but the integration\'s g t dt / 2', () => {
    const g = launchGrenade(from, vel);
    const nothing = (): [] => [];
    for (let k = 1; k <= 90; k++) {
      stepGrenade(g, TICK, nothing);
      const t = k * TICK;
      const on = arcPoint(from, vel, t);
      expect(g.pos[0]).toBeCloseTo(on[0], 6);
      expect(g.pos[2]).toBeCloseTo(on[2], 6);
      // Symplectic Euler (PreTick: the velocity first, then the position) sits g t dt / 2 under the parabola.
      expect(g.pos[1]).toBeCloseTo(on[1] - (98 * t * TICK) / 2, 6);
    }
  });

  it('the arc\'s drawn points are the parabola: between two of them the flight passes within a frame\'s drop', () => {
    const arc = throwArc(from, vel, hand[1]);
    const g = launchGrenade(from, vel);
    const nothing = (): [] => [];
    const span = arc.t1 - arc.t0;
    let worst = 0;
    for (let k = 1; k * TICK < throwArcTime(vel[1], hand[1]); k++) {
      stepGrenade(g, TICK, nothing);
      const t = k * TICK;
      // The polyline's point at t: the segment around it, linearly.
      const u = ((t - arc.t0) / span) * THROW_ARC.segments;
      const i = Math.min(arc.points.length - 2, Math.floor(u));
      const a = arc.points[i]!, b = arc.points[i + 1]!, f = u - i;
      const p: V3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      worst = Math.max(worst, Math.hypot(g.pos[0] - p[0], g.pos[1] - p[1], g.pos[2] - p[2]));
    }
    // Under a unit on a 600-unit throw: the chords' sag and the integration's offset.
    expect(worst).toBeLessThan(1.5);
  });
});
