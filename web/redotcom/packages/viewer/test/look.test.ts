import { describe, expect, it } from 'vitest';
import { SEAL_TUNING } from '@s2u/scene';
import { FlyCamera } from '../src/camera';
import { PAD_DEAD_ZONE } from '../src/gamepad';
import {
  aimTwist, circle, deadZone, EXPLOSION_SHAKES, explosionShake, ViewBob, FULL_AXIS, LOOK_GAIN, LookLaw,
  MAX_PITCH_RATE, MAX_YAW_RATE, MOUSE_RADIANS_PER_COUNT, nudgePitch, PITCH_PER_YAW, RAMP_PER_SECOND, ramp, rampStep,
  runningLean, ScreenShake, stepPitch, stickCurve, throttle, viewOffset, zoomScale,
} from '../src/look';
import { WalkMode } from '../src/walk';

const DEG = 180 / Math.PI;
const TICK = 1 / 60;
/** A pad byte (0..255, 0x80 at rest) as `FUN_002da930` reads it, with the viewer's sign: right and up positive. */
const byte = (b: number): number => -(127.5 - b) / 127.5;
/** The turn axis a byte settles to: the pad reader's curve x the look gain (research 22's `actor+0x23c`, unsigned). */
const settled = (b: number): number => Math.abs(stickCurve(byte(b), 0)[0] * LOOK_GAIN);

describe('the pad reader and the look gain against research 22\'s measured turn axis', () => {
  it('full push: 0.65 x 1.72 = 1.118, 128.1 deg/s at turn_maxrate 2', () => {
    expect(FULL_AXIS).toBeCloseTo(1.118, 3);
    expect(settled(255)).toBeCloseTo(1.118, 3);
    expect(settled(0)).toBeCloseTo(1.118, 3);
    expect(MAX_YAW_RATE * DEG).toBeCloseTo(128.11, 1);            // research 22's peak omega 128.11 deg/s
    expect(MAX_PITCH_RATE * DEG).toBeCloseTo(54.45, 1);
  });

  it('rx - 0x80 = +96 reads 0.879 and +-64 reads 0.080 / 0.072: the circle\'s sqrt 2 and the cube', () => {
    expect(settled(0x80 + 96)).toBeCloseTo(0.879, 3);                // both runs: -0.879
    expect(settled(0x80 + 64)).toBeCloseTo(0.080, 3);                // run 3: -0.080
    expect(settled(0x80 - 64)).toBeCloseTo(0.072, 3);                // both runs: +0.072
    expect(settled(0x80 - 48)).toBeCloseTo(0.0035, 3);               // run 3: +0.004 (run 2: 0)
    expect(settled(0x80 + 16)).toBe(0);                              // the dead zone
  });

  it('the dead zone is 0.3 a side and rescales to the rim; the circle is x sqrt 2 below full push', () => {
    expect(deadZone(0.29)).toBe(0);
    expect(deadZone(0.65)).toBeCloseTo(0.5, 9);
    expect(deadZone(-1)).toBe(-1);
    expect(circle(0.5, 0)).toEqual([Math.SQRT2 * 0.5, 0]);
    expect(circle(1, 0.5)).toEqual([1, 0.5 * Math.sqrt(1.5)]);        // one axis whole: sqrt(1 + minor / major)
    expect(circle(0.9, 0.9)).toEqual([1, 1]);
  });

  it('the throttle (off on the console) is linear to (0.9, 0.4), then to (1, 1)', () => {
    expect(throttle(0.45, SEAL_TUNING.turnThrottle)).toBeCloseTo(0.2, 9);
    expect(throttle(-0.95, SEAL_TUNING.turnThrottle)).toBeCloseTo(-0.7, 9);
  });
});

describe('the ramp: a push grows to full over 0.28 s and lets go at once', () => {
  it('the game frame\'s step at 60 Hz is 0.0389, 2.33 a second', () => {
    expect(rampStep(1 / 60)).toBeCloseTo(0.0389, 4);
    expect(RAMP_PER_SECOND).toBeCloseTo(2.334, 3);
  });

  it('grows by the step, falls at once, and a reversal starts from 0', () => {
    expect(ramp(0, 0.65, 0.04)).toBeCloseTo(0.04, 9);
    expect(ramp(0.3, 0.65, 0.04)).toBeCloseTo(0.34, 9);
    expect(ramp(0.64, 0.65, 0.04)).toBe(0.65);
    expect(ramp(0.65, 0.1, 0.04)).toBe(0.1);
    expect(ramp(0.65, -0.65, 0.04)).toBeCloseTo(-0.04, 9);
  });

  it('the right arrow (a full push) turns right at 128 deg/s after 17 ticks, and stops the tick it is let go', () => {
    const law = new LookLaw();
    const rates: number[] = [];
    for (let i = 0; i < 30; i++) rates.push(law.frame(TICK, 1, 0).yaw);
    expect(rates[0]!).toBeCloseTo(-SEAL_TUNING.turnMaxRate * RAMP_PER_SECOND * TICK * LOOK_GAIN, 9);
    expect(rates[15]!).toBeGreaterThan(-MAX_YAW_RATE);
    expect(rates[16]!).toBeCloseTo(-MAX_YAW_RATE, 9);
    expect(law.frame(TICK, 0, 0).yaw).toBe(0);
  });

  it('the zoom divides the look (the M4A1\'s 2.5x), and view mode 4 by 5 more', () => {
    expect(zoomScale(2.5)).toBeCloseTo(0.4, 9);
    expect(zoomScale(9, true)).toBeCloseTo(0.2 / 9, 9);
    const law = new LookLaw();
    law.setZoom(2.5);
    for (let i = 0; i < 30; i++) law.frame(TICK, 0, 1);
    expect(law.frame(TICK, 0, 1).pitch).toBeCloseTo(MAX_PITCH_RATE / 2.5, 9);
  });
});

describe('the pitch (FUN_00594600)', () => {
  const lo = -70 / DEG, hi = 60 / DEG;
  it('moves toward the limit it points at and stops on it', () => {
    expect(stepPitch(0, 1, 0.5, lo, hi)).toBeCloseTo(0.5, 9);
    expect(stepPitch(hi - 0.01, 1, 0.5, lo, hi)).toBe(hi);
    expect(stepPitch(lo, -1, 0.5, lo, hi)).toBe(lo);
  });

  it('outside the limits (a stance change) it comes back at 0.5 rad/s, and a push outward does not move it', () => {
    const plo = -20 / DEG, phi = 25 / DEG;
    expect(stepPitch(lo, 0, 0.1, plo, phi)).toBeCloseTo(lo + 0.05, 9);
    expect(stepPitch(lo, -1, 0.1, plo, phi)).toBeCloseTo(lo + 0.05, 9);
    expect(stepPitch(plo - 0.01, 0, 0.1, plo, phi)).toBe(plo);
    expect(nudgePitch(lo, -0.1, plo, phi)).toBe(lo);
    expect(nudgePitch(lo, 0.1, plo, phi)).toBeCloseTo(lo + 0.1, 9);
  });
});

describe('the mouse (the viewer\'s mapping, research 83 section 7)', () => {
  it('raw: one inch at 800 DPI turns as far as a second of full stick; the pitch at 0.425 of it', () => {
    const law = new LookLaw();
    const [yaw, pitch] = law.mouse(800, -800);
    expect(yaw).toBeCloseTo(-MAX_YAW_RATE, 9);
    expect(pitch).toBeCloseTo(MAX_YAW_RATE * PITCH_PER_YAW, 9);
    expect(MOUSE_RADIANS_PER_COUNT * DEG).toBeCloseTo(0.160, 3);
  });

  it('raw: the sensitivity, the uniform ratio, the invert and the zoom', () => {
    const law = new LookLaw();
    law.setOptions({ sensitivity: 2, pitchRatio: 'uniform', invertPitch: true });
    law.setZoom(2);
    const [yaw, pitch] = law.mouse(10, 10);
    expect(yaw).toBeCloseTo(-10 * MOUSE_RADIANS_PER_COUNT, 9);
    expect(pitch).toBeCloseTo(10 * MOUSE_RADIANS_PER_COUNT, 9);
  });

  it('stick: 800 counts a second is a full push, capped at 128 deg/s; 400 is half a push through the curve', () => {
    const turnAt = (countsPerSecond: number): number => {
      const law = new LookLaw();
      law.setOptions({ mouse: 'stick' });
      let rate = 0;
      for (let i = 0; i < 120; i++) { expect(law.mouse(countsPerSecond * TICK, 0)).toEqual([0, 0]); rate = law.frame(TICK, 0, 0).yaw; }
      return rate;
    };
    expect(turnAt(800)).toBeCloseTo(-MAX_YAW_RATE, 6);
    expect(turnAt(4000)).toBeCloseTo(-MAX_YAW_RATE, 6);
    expect(turnAt(400)).toBeCloseTo(-SEAL_TUNING.turnMaxRate * 0.65 * Math.pow(Math.SQRT1_2, 3) * LOOK_GAIN, 4);
  });
});

describe('the screen shake (FUN_002994e0, FUN_00299c40)', () => {
  it('an explosion\'s preset by distance: 100, 200, 600', () => {
    expect(explosionShake(50)).toBe(EXPLOSION_SHAKES[2]);
    expect(explosionShake(150)).toBe(EXPLOSION_SHAKES[1]);
    expect(explosionShake(599)).toBe(EXPLOSION_SHAKES[0]);
    expect(explosionShake(600)).toBeNull();
  });

  it('starts centred, swings at its rate, falls by decr a frame and ends', () => {
    const shake = new ScreenShake(() => 0);                          // phases 270 / 180; the random part 0
    shake.start(EXPLOSION_SHAKES[2]!);
    expect(shake.amplitude()).toEqual([60, 55]);
    const [x, y] = shake.step(TICK);
    expect(x).toBeCloseTo(60 * Math.cos(((270 + 1000 * TICK) * Math.PI) / 180), 9);
    expect(y).toBeCloseTo(55 * Math.sin(((180 + 1150 * TICK) * Math.PI) / 180), 9);
    expect(shake.amplitude()).toEqual([56, 51]);
    for (let i = 0; i < 14; i++) shake.step(TICK);
    expect(shake.amplitude()).toEqual([0, 0]);
    expect(shake.step(TICK)).toEqual([0, 0]);
  });

  it('a smaller shake does not take over a running one', () => {
    const shake = new ScreenShake(() => 0);
    shake.start(EXPLOSION_SHAKES[2]!);
    shake.start(EXPLOSION_SHAKES[0]!);
    expect(shake.amplitude()).toEqual([60, 55]);
  });
});

describe('the view bob (BOBBING_FIRSTPERSON), in the views from the eye', () => {
  it('moving, 6 x cos(phase) pixels, the phase at 15 rad/s x the push; still, 0; prone, 4 at 8', () => {
    const bob = new ViewBob();
    expect(bob.step(TICK, 0, 1, false)).toBeCloseTo(SEAL_TUNING.bobbing.walkAmplitude, 9);
    expect(bob.step(TICK, 0, 1, false)).toBeCloseTo(6 * Math.cos(15 * TICK), 9);
    expect(bob.step(TICK, 0, 0, false)).toBe(0);
    expect(bob.step(TICK, 0.5, 1, true)).toBeCloseTo(4 * Math.cos(30 * TICK), 9);
  });

  it('as a view offset: 6 pixels down on a 448-high frame; x at 4:3 of 640', () => {
    expect(viewOffset(0, 6)).toEqual([-0, -6]);
    expect(viewOffset(150, 0)[0]).toBeCloseTo(-150 * (4 / 3) * 448 / 640, 9);   // 140 of the frame's 448
    expect(viewOffset(0, 900)).toEqual([-0, -200]);
  });
});

describe('the body and the look', () => {
  it('the aim cone: 85 deg standing, 45 prone; the aim pitch limits', () => {
    expect(aimTwist(120, -80, false)).toEqual({ yaw: 85, pitch: -70 });
    expect(aimTwist(-60, 30, true)).toEqual({ yaw: -45, pitch: 25 });
  });

  it('the run\'s bank: 3.1 deg into a full turn at 65', () => {
    expect(runningLean(-MAX_YAW_RATE, 65) * DEG).toBeCloseTo(3.12, 2);
  });
});

function canvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  return c;
}

describe('FlyCamera, walking: the look law', () => {
  const walking = (): FlyCamera => {
    const fly = new FlyCamera(canvas());
    fly.setPose({ yaw: 0, pitch: 0 });
    fly.setWalking(true);
    fly.setPitchLimits(-70, 60);
    return fly;
  };

  it('the pad\'s push arrives dead-zoned by ./gamepad; the camera undoes it, so +96 still turns at 0.879', () => {
    const fly = walking();
    const raw = byte(0x80 + 96);
    fly.setLook((raw - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE), 0);    // what padInput hands over for that push
    for (let i = 0; i < 60; i++) fly.update(TICK);
    const state = fly.lookState();
    expect(state.axis[0]).toBeCloseTo(0.879, 3);
    expect(state.turnRate).toBeCloseTo(-SEAL_TUNING.turnMaxRate * 0.879, 2);
    expect(state.bodyYaw).toBe(state.lookYaw);
    expect(state.turning).toBe(true);
  });

  it('the arrow held a second turns 128 deg less the ramp\'s first 0.28 s', () => {
    const fly = walking();
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft' }));
    for (let i = 0; i < 60; i++) fly.update(TICK);
    globalThis.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowLeft' }));
    const yaw = fly.pose().yaw;
    expect(yaw).toBeGreaterThan(128.1 - 20);
    expect(yaw).toBeLessThan(128.1 - 15);
    fly.update(TICK);
    expect(fly.pose().yaw).toBe(yaw);                                 // let go: at once
  });

  it('scoped and moving, the bob shifts the view; the shake too, and neither in fly mode', () => {
    const fly = walking();
    fly.setAspect(4 / 3);
    fly.setBody(true, false);                                         // the eye's view (the night vision: no slow)
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    fly.update(TICK);
    expect(fly.lookState().screen[1]).toBeCloseTo(6, 9);
    expect(fly.camera.view?.enabled).toBe(true);
    expect(fly.screenShift()[1]).toBeCloseTo(6 / 448, 9);
    globalThis.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    fly.update(TICK);
    expect(fly.lookState().screen).toEqual([0, 0]);
    expect(fly.camera.view?.enabled ?? false).toBe(false);
    fly.shakeScreen(EXPLOSION_SHAKES[1]!);
    fly.update(TICK);
    expect(fly.lookState().screen).not.toEqual([0, 0]);
    fly.setWalking(false);
    expect(fly.lookState().screen).toEqual([0, 0]);
  });

  it('WalkMode still reads the look\'s yaw as the body\'s', () => {
    const fly = walking();
    const mode = new WalkMode(fly);
    expect(mode.mode()).toBe('fly');                                  // no ground: the look law is the camera's alone
    expect(fly.lookState().bodyYaw).toBe(fly.pose().yaw);
  });
});
