import { afterEach, describe, expect, it } from 'vitest';
import { FloatingStick, attachTouchControls, stickInput, stickVector, sticksPad, STICK_RADIUS } from '../src/touch';
import { padInput, padStick, PAD_DEAD_ZONE } from '../src/gamepad';

/**
 * The phone's two floating sticks (owner, 2026-09-29): one on each half, each born where its thumb lands, its knob
 * clamped to the base, let go on the lift -- and read through the pad's own pipeline (`padInput`), so the dead zone,
 * the rescale and everything the walk does with a pad's stick apply to a thumb unchanged.
 */
const R = 100;

describe('FloatingStick', () => {
  it('is born where the finger lands, centred and at rest', () => {
    const s = new FloatingStick(R);
    expect(s.held).toBe(false);
    expect(s.down(1, 120, 300)).toBe(true);
    expect(s.held).toBe(true);
    expect(s.origin()).toEqual({ x: 120, y: 300 });
    expect(s.knob()).toEqual({ x: 0, y: 0 });
    expect(s.axes()).toEqual([0, 0]);
  });

  it('follows the finger inside the base, as a pad stick\'s axes (y growing down)', () => {
    const s = new FloatingStick(R);
    s.down(1, 100, 100);
    expect(s.move(1, 130, 60)).toBe(true);
    expect(s.knob()).toEqual({ x: 30, y: -40 });
    const [x, y] = s.axes();
    expect(x).toBeCloseTo(0.3, 9);
    expect(y).toBeCloseTo(-0.4, 9);
  });

  it('clamps the knob to the rim, keeping the direction', () => {
    const s = new FloatingStick(R);
    s.down(1, 0, 0);
    s.move(1, 300, -400);
    expect(Math.hypot(s.knob().x, s.knob().y)).toBeCloseTo(R, 9);
    const [x, y] = s.axes();
    expect(Math.hypot(x, y)).toBeCloseTo(1, 9);
    expect(x).toBeCloseTo(0.6, 9);
    expect(y).toBeCloseTo(-0.8, 9);
    expect(s.pushed()).toBe(1);
  });

  it('answers only its own finger, and a second finger does not take it over', () => {
    const s = new FloatingStick(R);
    s.down(1, 0, 0);
    expect(s.down(2, 50, 50)).toBe(false);
    expect(s.move(2, 80, 0)).toBe(false);
    expect(s.axes()).toEqual([0, 0]);
    expect(s.up(2)).toBe(false);
    expect(s.held).toBe(true);
  });

  it('is let go on the lift: centred, free for the next finger', () => {
    const s = new FloatingStick(R);
    s.down(1, 0, 0);
    s.move(1, 60, 0);
    expect(s.up(1)).toBe(true);
    expect(s.held).toBe(false);
    expect(s.axes()).toEqual([0, 0]);
    expect(s.down(3, 10, 10)).toBe(true);
    expect(s.origin()).toEqual({ x: 10, y: 10 });
  });

  it('the default radius is the base\'s travel', () => {
    expect(STICK_RADIUS).toBeGreaterThan(30);
    expect(new FloatingStick().radius).toBe(STICK_RADIUS);
  });
});

describe('the sticks through the pad pipeline', () => {
  const pushed = (dx: number, dy: number): FloatingStick => {
    const s = new FloatingStick(R);
    s.down(1, 0, 0);
    s.move(1, dx, dy);
    return s;
  };

  it('are a pad: the left stick the pad\'s axes 0/1, the right 2/3', () => {
    const pad = sticksPad(pushed(30, -40), pushed(-50, 0));
    expect(pad.axes).toHaveLength(4);
    expect(pad.axes[0]).toBeCloseTo(0.3, 9);
    expect(pad.axes[1]).toBeCloseTo(-0.4, 9);
    expect(pad.axes[2]).toBeCloseTo(-0.5, 9);
    expect(pad.axes[3]).toBeCloseTo(0, 9);
    expect(pad.buttons).toEqual([]);
  });

  it('hand the dead zone to the pad: a push inside it is nothing, on either stick', () => {
    const small = R * PAD_DEAD_ZONE * 0.9;
    const input = stickInput(pushed(0, -small), pushed(small, 0));
    expect([input.moveX, input.moveY, input.lookX, input.lookY]).toEqual([0, 0, 0, 0]);
  });

  it('past the dead zone read exactly as a pad\'s sticks pushed as far', () => {
    const input = stickInput(pushed(0, -50), pushed(70, 20));
    const pad = padInput({ axes: [0, -0.5, 0.7, 0.2], buttons: [] });
    expect(input.moveX).toBeCloseTo(pad.moveX, 12);
    expect(input.moveY).toBeCloseTo(pad.moveY, 12);
    expect(input.lookX).toBeCloseTo(pad.lookX, 12);
    expect(input.lookY).toBeCloseTo(pad.lookY, 12);
    const want = padStick(0, -0.5);
    expect(input.moveY).toBeCloseTo(want.y, 12);
    expect(input.moveY).toBeGreaterThan(0);                                // up the screen is forward
  });

  it('shape as the old touch stick did, pixel for pixel', () => {
    for (const [dx, dy] of [[0, -50], [30, -40], [-300, 90], [8, 3]] as const) {
      const input = stickInput(pushed(dx, dy), null);
      const old = stickVector(dx, dy, R);
      expect(input.moveX, `${dx},${dy}`).toBeCloseTo(old.x, 9);
      expect(input.moveY, `${dx},${dy}`).toBeCloseTo(old.y, 9);
    }
  });

  it('carry no buttons: a stick never presses one', () => {
    const input = stickInput(pushed(100, 100), pushed(-100, -100));
    expect(input.fire || input.jump || input.stance || input.action || input.zoom).toBe(false);
  });
});

describe('the two sticks on the page', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  const page = (): void => {
    document.body.innerHTML = `<div id="stick-zone"></div><div id="stick-base" hidden><div id="stick-knob"></div></div>
      <div id="aim-zone"></div><div id="aim-base" hidden><div id="aim-knob"></div></div>
      <button id="touch-up"></button><button id="touch-down"></button><button id="touch-stance"></button><button id="touch-fire"></button>
      <div id="touch-walk"><button id="tw-fire" data-lane="fire"></button></div>`;
  };
  const ptr = (el: EventTarget, type: string, pointerId: number, x: number, y: number): void => {
    el.dispatchEvent(new PointerEvent(type, { pointerId, clientX: x, clientY: y, pointerType: 'touch', bubbles: true, cancelable: true }));
  };
  const lane = () => {
    const seen = { move: [0, 0] as [number, number], look: [0, 0] as [number, number] };
    return {
      seen,
      target: {
        setStick: (x: number, y: number) => { seen.move = [x, y]; },
        setLook: (x: number, y: number) => { seen.look = [x, y]; },
        setLift: () => undefined,
        setStickBoost: () => undefined,
      },
    };
  };

  it('each half tracks its own finger: move and look at once, and each let go alone', () => {
    page();
    const { seen, target } = lane();
    attachTouchControls(target);
    const left = document.getElementById('stick-zone')!, right = document.getElementById('aim-zone')!;
    ptr(left, 'pointerdown', 1, 100, 300);
    ptr(right, 'pointerdown', 2, 600, 250);
    ptr(left, 'pointermove', 1, 100, 200);                                  // the left thumb pushed up: forward
    ptr(right, 'pointermove', 2, 700, 250);                                 // the right thumb pushed right: turn right
    expect(seen.move[0]).toBeCloseTo(0, 9);
    expect(seen.move[1]).toBeGreaterThan(0.9);
    expect(seen.look[0]).toBeGreaterThan(0.9);
    expect(seen.look[1]).toBeCloseTo(0, 9);
    // The bases stand where the thumbs landed.
    expect(document.getElementById('stick-base')!.hidden).toBe(false);
    expect(document.getElementById('aim-base')!.style.left).toBe('600px');
    // A finger's move on the other half's zone is not that half's.
    ptr(right, 'pointermove', 1, 0, 0);
    expect(seen.look[0]).toBeGreaterThan(0.9);
    ptr(left, 'pointerup', 1, 100, 200);
    expect(seen.move).toEqual([0, 0]);
    expect(seen.look[0]).toBeGreaterThan(0.9);                              // the look is still held
    expect(document.getElementById('stick-base')!.hidden).toBe(true);
    ptr(right, 'pointercancel', 2, 700, 250);
    expect(seen.look).toEqual([0, 0]);
    expect(document.getElementById('aim-base')!.hidden).toBe(true);
  });

  it('a press on a button starts no stick', () => {
    page();
    const { seen, target } = lane();
    attachTouchControls(target);
    const fire = document.getElementById('tw-fire')!;
    ptr(fire, 'pointerdown', 4, 700, 300);
    ptr(fire, 'pointermove', 4, 750, 300);
    expect(document.getElementById('aim-base')!.hidden).toBe(true);
    expect(seen.look).toEqual([0, 0]);
  });

  it('the sticks can be let go from outside (a pad connecting hides the layer)', () => {
    page();
    const { seen, target } = lane();
    const touch = attachTouchControls(target);
    const left = document.getElementById('stick-zone')!;
    ptr(left, 'pointerdown', 1, 100, 300);
    ptr(left, 'pointermove', 1, 100, 200);
    expect(seen.move[1]).toBeGreaterThan(0.9);
    touch.release();
    expect(seen.move).toEqual([0, 0]);
    expect(document.getElementById('stick-base')!.hidden).toBe(true);
  });
});
