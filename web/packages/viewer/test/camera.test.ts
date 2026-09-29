import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlyCamera } from '../src/camera';

/**
 * The camera is the one part of the viewer a player feels rather than reads, so what is pinned here is
 * the *motion model* — ramp, glide, frame-rate independence, the axes each key moves along — and not
 * the numbers themselves, which are tuning and are meant to be tuned.
 */

const canvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  // jsdom has neither pointer capture nor pointer lock; the camera must not require them.
  c.setPointerCapture = () => undefined;
  c.releasePointerCapture = () => undefined;
  c.hasPointerCapture = () => false;
  return c;
};

const press = (code: string): void => {
  globalThis.dispatchEvent(new KeyboardEvent('keydown', { code }));
};
const release = (code: string): void => {
  globalThis.dispatchEvent(new KeyboardEvent('keyup', { code }));
};

/** Run `seconds` of simulated time in `steps` equal frames. */
const run = (fly: FlyCamera, seconds: number, steps: number): void => {
  for (let i = 0; i < steps; i++) fly.update(seconds / steps);
};

describe('FlyCamera', () => {
  let fly: FlyCamera;

  beforeEach(() => {
    fly = new FlyCamera(canvas());
    fly.setScale(0.1);
    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  });

  it('starts still and stays still with no input', () => {
    run(fly, 1, 60);
    expect(fly.pose()).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('ramps rather than snapping: the first frame moves much less than the steady state', () => {
    press('KeyW');
    fly.update(1 / 60);
    const first = -fly.pose().z;
    run(fly, 1, 60);              // let it reach cruise
    const before = -fly.pose().z;
    fly.update(1 / 60);
    const steady = -fly.pose().z - before;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(steady * 0.5);
    release('KeyW');
  });

  it('glides to a stop after the key comes up, then stops for good', () => {
    press('KeyW');
    run(fly, 1, 60);
    release('KeyW');
    const atRelease = -fly.pose().z;
    fly.update(1 / 60);
    expect(-fly.pose().z).toBeGreaterThan(atRelease);   // still coasting

    run(fly, 2, 120);
    const settled = -fly.pose().z;
    run(fly, 2, 120);
    expect(-fly.pose().z).toBeCloseTo(settled, 6);      // and then truly stopped
  });

  it('travels the same distance at 30 fps as at 240 fps', () => {
    press('KeyW');
    run(fly, 2, 60);
    const slow = -fly.pose().z;

    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    run(fly, 2, 480);
    const fast = -fly.pose().z;
    release('KeyW');

    expect(fast).toBeCloseTo(slow, 4);
  });

  it('W follows the pitch: looking down and flying forward descends', () => {
    fly.setPose({ pitch: -45 });
    press('KeyW');
    run(fly, 1, 60);
    release('KeyW');
    expect(fly.pose().y).toBeLessThan(0);
  });

  it('A and D stay level however far the camera is pitched', () => {
    fly.setPose({ pitch: -80 });
    press('KeyD');
    run(fly, 1, 60);
    release('KeyD');
    const p = fly.pose();
    expect(p.x).toBeGreaterThan(0);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('space goes up and shift goes down, in world space, whatever the look', () => {
    fly.setPose({ pitch: -60, yaw: 123 });
    press('Space');
    run(fly, 1, 60);
    release('Space');
    expect(fly.pose().y).toBeGreaterThan(0);

    fly.setPose({ x: 0, y: 0, z: 0, pitch: -60, yaw: 123 });
    press('ShiftLeft');
    run(fly, 1, 60);
    release('ShiftLeft');
    expect(fly.pose().y).toBeLessThan(0);
  });

  it('keeps Q and E bound to down and up for the old fingers', () => {
    press('KeyE');
    run(fly, 1, 60);
    release('KeyE');
    expect(fly.pose().y).toBeGreaterThan(0);

    fly.setPose({ x: 0, y: 0, z: 0 });
    press('KeyQ');
    run(fly, 1, 60);
    release('KeyQ');
    expect(fly.pose().y).toBeLessThan(0);
  });

  it('a double-tapped W boosts, and a single held W does not', () => {
    press('KeyW');
    run(fly, 2, 120);
    const plain = -fly.pose().z;
    release('KeyW');

    // Tap, release, tap again inside the window and hold: Minecraft's sprint gesture.
    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    press('KeyW');
    release('KeyW');
    press('KeyW');
    run(fly, 2, 120);
    const boosted = -fly.pose().z;
    release('KeyW');
    expect(boosted).toBeGreaterThan(plain * 2);
  });

  it('releasing forward ends the sprint: the next single press is not still boosting', () => {
    press('KeyW');
    release('KeyW');
    press('KeyW');
    run(fly, 1, 60);
    release('KeyW');

    // Move the clock past the double-tap window rather than burning 400 ms of wall time in a loop.
    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    const real = performance.now.bind(performance);
    const skew = 400;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => real() + skew);
    press('KeyW');
    run(fly, 2, 120);
    const plain = -fly.pose().z;
    release('KeyW');
    spy.mockRestore();

    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    press('KeyW');
    release('KeyW');
    press('KeyW');
    run(fly, 2, 120);
    release('KeyW');
    expect(-fly.pose().z).toBeGreaterThan(plain * 2);
  });

  it('nothing is bound to ctrl: Ctrl+W would close the tab and no page can stop it', () => {
    press('ControlLeft');
    run(fly, 1, 60);
    release('ControlLeft');
    expect(fly.pose()).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('prevents the browser chord on every key it consumes', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft']) {
      const e = new KeyboardEvent('keydown', { code, cancelable: true });
      globalThis.dispatchEvent(e);
      expect(e.defaultPrevented, `${code} must not reach the browser`).toBe(true);
      release(code);
    }
    // A key it does not consume is left alone.
    const other = new KeyboardEvent('keydown', { code: 'KeyP', cancelable: true });
    globalThis.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    release('KeyP');
  });

  it('a diagonal is no faster than a straight line', () => {
    press('KeyW');
    run(fly, 2, 120);
    const straight = Math.hypot(fly.pose().x, -fly.pose().z);

    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    press('KeyD');
    run(fly, 2, 120);
    const diagonal = Math.hypot(fly.pose().x, -fly.pose().z);
    release('KeyW');
    release('KeyD');

    expect(diagonal).toBeCloseTo(straight, 1);
  });

  it('setPose kills the glide, so a driven pose is exactly the pose that renders', () => {
    press('KeyW');
    run(fly, 1, 60);
    release('KeyW');
    fly.setPose({ x: 5, y: 6, z: 7, yaw: 10, pitch: 20 });
    run(fly, 1, 60);
    const p = fly.pose();
    expect(p.x).toBeCloseTo(5, 6);
    expect(p.y).toBeCloseTo(6, 6);
    expect(p.z).toBeCloseTo(7, 6);
    expect(p.yaw).toBeCloseTo(10, 6);
    expect(p.pitch).toBeCloseTo(20, 6);
  });

  it('losing focus drops the keys and the momentum', () => {
    press('KeyW');
    run(fly, 1, 60);
    globalThis.dispatchEvent(new Event('blur'));
    const parked = -fly.pose().z;
    run(fly, 1, 60);
    expect(-fly.pose().z).toBeCloseTo(parked, 6);
  });

  it('pitch cannot pass straight up or straight down', () => {
    fly.setPose({ pitch: 200 });
    expect(fly.pose().pitch).toBeLessThan(90);
    fly.setPose({ pitch: -200 });
    expect(fly.pose().pitch).toBeGreaterThan(-90);
  });

  it('the wheel trims the speed within bounds and reports it', () => {
    const seen: number[] = [];
    const wheeled = new FlyCamera(canvas(), { onSpeedChange: (m) => seen.push(m) });
    const c = wheeled as unknown as { canvas: HTMLCanvasElement };
    for (let i = 0; i < 3; i++) c.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    expect(wheeled.multiplier()).toBeGreaterThan(1);
    expect(seen).toHaveLength(3);

    for (let i = 0; i < 200; i++) c.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
    expect(wheeled.multiplier()).toBeGreaterThanOrEqual(0.1);

    for (let i = 0; i < 400; i++) c.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    expect(wheeled.multiplier()).toBeLessThanOrEqual(16);
  });

  it('a faster speed trim covers more ground', () => {
    const c = fly as unknown as { canvas: HTMLCanvasElement };
    press('KeyW');
    run(fly, 2, 120);
    const normal = -fly.pose().z;

    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    for (let i = 0; i < 5; i++) c.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    run(fly, 2, 120);
    release('KeyW');
    expect(-fly.pose().z).toBeGreaterThan(normal);
  });

  it('a click on the canvas takes focus back off a panel control', () => {
    // The regression: click a checkbox, and every later keydown is aimed at the checkbox, which
    // `onKeyDown` ignores -- so the camera went dead until the page was reloaded.
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.append(box);
    box.focus();
    expect(document.activeElement).toBe(box);

    const c = fly as unknown as { canvas: HTMLCanvasElement };
    c.canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', bubbles: true }));
    expect(document.activeElement).not.toBe(box);

    press('KeyW');
    run(fly, 1, 60);
    release('KeyW');
    expect(-fly.pose().z).toBeGreaterThan(0);
    box.remove();
  });

  it('setFov sets the vertical field the map authored, and the boost widens from that', () => {
    fly.setFov(49);
    expect(fly.camera.fov).toBe(49);
    press('KeyW'); release('KeyW'); press('KeyW');      // the sprint gesture
    run(fly, 2, 120);
    expect(fly.camera.fov).toBeGreaterThan(49);
    expect(fly.camera.fov).toBeLessThan(49 * 1.3);
    release('KeyW');
    run(fly, 2, 120);
    expect(fly.camera.fov).toBeCloseTo(49, 2);           // and eases back to the map's own, not to a constant
  });

  it('the arrow keys look, at a steady rate, for a keyboard without a mouse', () => {
    press('ArrowLeft');
    run(fly, 0.5, 30);
    const half = fly.pose().yaw;
    run(fly, 0.5, 30);
    expect(half).toBeGreaterThan(5);                     // left is a positive yaw: the camera looks down -z
    expect(fly.pose().yaw).toBeCloseTo(half * 2, 3);     // twice the time, twice the turn
    release('ArrowLeft');
    press('ArrowUp');
    run(fly, 0.25, 15);
    expect(fly.pose().pitch).toBeGreaterThan(0);
    release('ArrowUp');
  });

  it('a touch drag turns further than a mouse drag of the same length: a thumb has less room', () => {
    const turn = (pointerType: string): number => {
      fly.setPose({ yaw: 0, pitch: 0 });
      const c = fly['canvas'];
      c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType, clientX: 100, clientY: 100, bubbles: true }));
      c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, pointerType, clientX: 0, clientY: 100, bubbles: true }));
      c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType, clientX: 0, clientY: 100, bubbles: true }));
      return fly.pose().yaw;
    };
    const mouse = turn('mouse');
    const touch = turn('touch');
    expect(mouse).toBeGreaterThan(0);
    expect(touch / mouse).toBeCloseTo(2, 3);
  });

  it('the stick held at its rim boosts, the way a double-tapped W does', () => {
    const distance = (boost: boolean): number => {
      fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
      fly.setStick(0, 1);
      fly.setStickBoost(boost);
      run(fly, 2, 120);
      fly.setStick(0, 0);
      fly.setStickBoost(false);
      return -fly.pose().z;
    };
    const plain = distance(false);
    expect(distance(true)).toBeGreaterThan(plain * 3);
  });

  it('lookFrom faces the target', () => {
    fly.lookFrom([0, 0, 0], [0, 0, -100]);
    expect(fly.pose().yaw).toBeCloseTo(0, 4);
    expect(fly.pose().pitch).toBeCloseTo(0, 4);

    fly.lookFrom([0, 0, 0], [100, 0, 0]);
    expect(fly.pose().yaw).toBeCloseTo(-90, 4);
  });
});
