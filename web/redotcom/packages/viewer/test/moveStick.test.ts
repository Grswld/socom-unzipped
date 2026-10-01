import { describe, expect, it } from 'vitest';
import { buildGrid, type CollisionOwner, type GridParams, type WorldPoly } from '@s2u/scene';
import { FlyCamera } from '../src/camera';
import { PAD_DEAD_ZONE } from '../src/gamepad';
import { LEFT_DEAD_ZONE, moveStick } from '../src/moveStick';
import { Walker } from '../src/walk';

/**
 * The move stick as the console's pad reader hands it to the mover (web research 88 section 3): the left block of
 * `FUN_002da930` on the spawn dump -- dead zone 0.3 per axis, the rescale, the circle's x sqrt 2, no curve, no ramp --
 * and a pair that is never put back in the unit disc, so the keyboard's W+D is (1, 1) as the console's is.
 */

/** A pad byte as the reader reads it: `(127.5 - byte) x 0.007843138`, up (byte 0) positive. */
const read = (b: number): number => (127.5 - b) * 0.007843138;

describe('moveStick: FUN_002da930 on the left block', () => {
  it('0.3 a side is dead, and past it the push is rescaled and x sqrt 2 until an axis is full', () => {
    expect(LEFT_DEAD_ZONE).toBe(0.3);
    expect(moveStick(0, 0.29)).toEqual([0, 0]);
    expect(moveStick(0, -0.29)).toEqual([0, 0]);
    expect(moveStick(0, read(64))[1]).toBeCloseTo(0.4001, 4);      // research 79's half stick: 26.0 of the 65, not 32.5
    expect(moveStick(0, read(32))[1]).toBeCloseTo(0.90716, 4);     // its three quarters: 59.0, not 48.75
    expect(moveStick(0, 0.3 + 0.7 / Math.SQRT2)[1]).toBeCloseTo(1, 12);   // the run is full from 0.795 of the travel
    expect(moveStick(0, 1)).toEqual([0, 1]);                        // a full axis alone: r = 0, x 1
    expect(moveStick(-0.6, 0)[0]).toBeCloseTo(-(0.3 / 0.7) * Math.SQRT2, 12);
  });

  it('a full diagonal is (1, 1), and a rim-clamped one (0.707, 0.707) is 0.822 a side: the disc is never imposed', () => {
    expect(moveStick(1, 1)).toEqual([1, 1]);
    expect(moveStick(-1, 1)).toEqual([-1, 1]);
    const [x, y] = moveStick(Math.SQRT1_2, Math.SQRT1_2);
    expect(x).toBeCloseTo(((Math.SQRT1_2 - 0.3) / 0.7) * Math.SQRT2, 12);
    expect(y).toBe(x);
    expect(Math.hypot(x, y)).toBeGreaterThan(1);
  });
});

function canvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  return c;
}
const key = (code: string, type: 'keydown' | 'keyup' = 'keydown'): void => {
  globalThis.dispatchEvent(new KeyboardEvent(type, { code }));
};

describe('groundWish: the keys and the stick as the mover receives them', () => {
  it('the keys are a full byte on each axis they press: W+D is (1, 1), S+A is (-1, -1)', () => {
    const fly = new FlyCamera(canvas());
    fly.setWalking(true);
    key('KeyW'); key('KeyD');
    expect(fly.groundWish()).toEqual({ forward: 1, right: 1, boost: false });
    key('KeyW', 'keyup'); key('KeyD', 'keyup');
    key('KeyS'); key('KeyA');
    expect(fly.groundWish()).toEqual({ forward: -1, right: -1, boost: false });
    key('KeyS', 'keyup'); key('KeyA', 'keyup');
    expect(fly.groundWish()).toEqual({ forward: 0, right: 0, boost: false });
  });

  it('a pad pushed half way arrives dead-zoned by ./gamepad; the push is undone and read as the console reads it', () => {
    const fly = new FlyCamera(canvas());
    fly.setWalking(true);
    const raw = read(64);                                             // the byte research 79's light macro lands on
    fly.setStick(0, (raw - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE));     // what padInput hands over for that push
    expect(fly.groundWish().forward).toBeCloseTo(moveStick(0, raw)[1], 12);
    expect(fly.groundWish().right).toBe(0);
    fly.setStick(0, 0.9);                                             // past 0.795 of the travel: a full axis
    expect(fly.groundWish().forward).toBe(1);
    key('KeyS');                                                      // a key and the stick: the larger on each axis
    fly.setStick(0.2, 0.5);
    expect(fly.groundWish().forward).toBe(-1);
    key('KeyS', 'keyup');
    fly.setStick(0, 0);
  });
});

function floor(): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-400, 0, -400, 400, 0, -400, 400, 0, 400, -400, 0, 400]),
  };
}
const GRID: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 4, cellsZ: 4, originX: -400, originZ: -400 };
const OWNERS: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor', first: 0, count: 1 }];

describe('the mover takes the pair as given: no unit disc (FUN_00583350, FUN_00583500)', () => {
  const speedAfter = (stance: 'stand' | 'prone', forward: number, right: number): number => {
    const w = new Walker(buildGrid(GRID, [], [], [floor()], OWNERS));
    w.place(0, 20, 0);
    w.stance = stance;
    for (let i = 0; i < 60; i++) w.tick({ forward, right, boost: false });
    return Math.hypot(w.state.vx, w.state.vz);
  };

  it('prone, W+D crawls at the class axis\'s full 11 (it read 7.8 while the pair was put in the disc)', () => {
    expect(speedAfter('prone', 1, 1)).toBeCloseTo(11, 9);
    expect(speedAfter('prone', 1, 0)).toBeCloseTo(11, 9);
  });

  it('standing, (1, 1) still runs 65 at 45 degrees: min(1, |stick|) and the blend\'s renormalisation', () => {
    expect(speedAfter('stand', 1, 1)).toBeCloseTo(65, 6);
    expect(speedAfter('stand', 5, 0)).toBeCloseTo(65, 9);            // an axis past 1 is clamped, as the reader clamps it
  });
});
