import { describe, expect, it } from 'vitest';
import { DEFAULT_RIFLE, HELD_RIFLE } from '@s2u/scene';
import { Zoom, ZOOM_NIGHT } from '../src/zoom';

/**
 * The view states and the zoom (research 84 §7): `FUN_005445b0` in, `FUN_00544400` out, `FUN_005448a0` the set -- with
 * the first-person state (1) taken out by the owner's ruling of 2026-09-29: the views are third person and scoped.
 */

const pistol = { ...DEFAULT_RIFLE, zoomModes: [1.5] };               // every sidearm: NumZoomModes 1
const sniper = { ...DEFAULT_RIFLE, zoomModes: [1.5, 6, 12] };        // the M40A1

describe('the zoom steps', () => {
  it('the M4A1 SD: third -> 3x, and in stays there; out goes straight back to third, never first person', () => {
    const z = new Zoom(HELD_RIFLE);
    expect([z.state(), z.view()]).toEqual([0, 'third']);
    expect(z.zoomIn()).toBe(5);
    expect(z.target()).toBe(3);                                      // ZoomMode[5 - 4]: ZoomMode1
    expect(z.zoomIn()).toBe(5);                                      // 5 - 3 < 2 is false: no more levels
    expect(z.zoomOut()).toBe(0);
    expect(z.zoomOut()).toBe(0);
  });

  it('the M4A1 scopes at 2.5; its ZoomMode0 1.5 is never a magnification', () => {
    const z = new Zoom(DEFAULT_RIFLE);
    z.zoomIn();
    expect(z.target()).toBe(2.5);
  });

  it('a sniper steps 6 then 12; a pistol, with one zoom mode, goes to the 9x view', () => {
    const s = new Zoom(sniper);
    s.zoomIn();
    expect(s.target()).toBe(6);
    expect(s.zoomIn()).toBe(6);
    expect(s.target()).toBe(12);
    expect(s.zoomOut()).toBe(5);
    expect(s.zoomOut()).toBe(0);
    const p = new Zoom(pistol);
    expect(p.zoomIn()).toBe(4);
    expect([p.view(), p.target()]).toEqual(['binoculars', 9]);
    expect(p.lookScale()).toBeCloseTo((1 / 1.5) * 0.2, 12);        // ZoomMode0, x 0.2 in state 4
    expect(p.zoomOut()).toBe(0);
  });

  it('night maps: third person zooms into the night vision, then the scope, and back out the same way', () => {
    const z = new Zoom(HELD_RIFLE, true);
    expect(z.zoomIn()).toBe(3);
    expect(z.target()).toBe(ZOOM_NIGHT);
    expect(z.zoomIn()).toBe(5);
    expect(z.zoomOut()).toBe(3);
    expect(z.zoomOut()).toBe(0);
  });

  it('no state is first person: every step lands on third person or a lens view', () => {
    for (const night of [false, true]) {
      for (const w of [HELD_RIFLE, DEFAULT_RIFLE, pistol, sniper]) {
        const z = new Zoom(w, night);
        for (let i = 0; i < 6; i++) {
          expect(z.view()).not.toBe('first');
          expect(z.state() === 1 || z.state() === 2).toBe(false);
          if (i < 3) z.zoomIn(); else z.zoomOut();
        }
      }
    }
  });

  it('the view from the eye is every state but third person (the scope, the 9x view, the night vision)', () => {
    const z = new Zoom(HELD_RIFLE, true);
    expect(z.lens()).toBe(false);
    z.zoomIn();
    expect(z.lens()).toBe(true);
    z.zoomIn();
    expect(z.lens()).toBe(true);
    z.reset();
    expect(z.lens()).toBe(false);
  });

  it('the mouse cycle wraps from the last level to third person', () => {
    const z = new Zoom(HELD_RIFLE);
    expect([z.cycle(), z.cycle(), z.cycle()]).toEqual([5, 0, 5]);
  });

  it('runs to the magnification at 3 x the target a second, and the FOV and the look follow it', () => {
    const z = new Zoom(HELD_RIFLE);
    z.zoomIn();                                                      // 1 -> 3 at 9 a second
    z.update(0.1);
    expect(z.magnification()).toBeCloseTo(1 + 0.9, 9);
    z.update(1);
    expect(z.magnification()).toBe(3);
    expect(z.fov(49)).toBeCloseTo((360 / Math.PI) * Math.atan(Math.tan((49 * Math.PI) / 360) / 3), 9);
    expect(z.lookScale()).toBeCloseTo(1 / 3, 12);
    expect(z.moveScale()).toBe(0.2);
    z.zoomOut();                                                     // back out at 3 x the old target: 9 a second
    z.update(0.1);
    expect(z.magnification()).toBeCloseTo(2.1, 9);
    const night = new Zoom(HELD_RIFLE, true);
    night.zoomIn();
    expect(night.lookScale()).toBe(1);                               // the night vision changes nothing in the look
  });

  it('a weapon switch drops the night vision to third person, and only it (FUN_005c4b10)', () => {
    const night = new Zoom(HELD_RIFLE, true);
    night.zoomIn();
    expect(night.state()).toBe(3);
    night.setWeapon(DEFAULT_RIFLE);
    expect(night.state()).toBe(0);
    const z = new Zoom(HELD_RIFLE);
    z.zoomIn();
    z.setWeapon(DEFAULT_RIFLE);
    expect(z.state()).toBe(5);
  });
});
