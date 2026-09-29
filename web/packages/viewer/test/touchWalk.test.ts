import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PAD_FLAGS, PAD_LAYOUT, type PadFlag } from '../src/gamepad';
import { attachWalkTouch } from '../src/touch';
import { removePlayUi } from '../src/features';

/**
 * Walk mode's touch layout (round 3): each button holds the lane a pad's button holds, so the page merges them and
 * the pad's behaviour is the touch's.
 */
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const css = readFileSync(resolve(here, '../src/styles.css'), 'utf-8');
const load = (): void => { document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML; };
const button = (id: string): HTMLElement => document.getElementById(id)!;
const ptr = (el: EventTarget, type: string, pointerId = 1): void => {
  el.dispatchEvent(new PointerEvent(type, { pointerId, pointerType: 'touch', bubbles: true, cancelable: true }));
};

describe('the layout in the page', () => {
  beforeEach(load);

  it('is the play\'s: one wrapper that carries data-play, and the rotate hint too', () => {
    expect(button('touch-walk').hasAttribute('data-play')).toBe(true);
    expect(button('rotate-hint').hasAttribute('data-play')).toBe(true);
    expect(button('touch-walk').closest('#touch')).not.toBeNull();
  });

  it('has a button for each of the pad\'s walking actions, each carrying a real lane', () => {
    const lanes = [...document.querySelectorAll<HTMLElement>('#touch-walk button[data-lane]')].map((b) => b.dataset['lane']!);
    expect(lanes.sort()).toEqual(['action', 'fire', 'fireMode', 'inventory', 'jump', 'leanLeft', 'leanRight', 'scoreboard', 'stance', 'swap1', 'swap2', 'zoom', 'zoomOut'].sort());
    for (const lane of lanes) expect(PAD_FLAGS.includes(lane as PadFlag), lane).toBe(true);
    expect(document.querySelectorAll('#touch-walk button[data-do="reload"]')).toHaveLength(1);
  });

  it('covers every walking action of the pad layout but the ones a phone has by other means', () => {
    const lanes = new Set([...document.querySelectorAll<HTMLElement>('#touch-walk button[data-lane]')].map((b) => b.dataset['lane']));
    const skipped = PAD_LAYOUT.filter((r) => r.action !== 'move' && r.action !== 'look' && !lanes.has(r.action)).map((r) => r.action);
    // The stick and the drag move and look; the mode is the panel's switch; the boost is the fly camera's alone; the
    // reload (the pad's R3) is the touch's own `data-do="reload"` button, not a lane.
    expect(skipped.sort()).toEqual(['boost', 'mode', 'reload']);
  });

  it('every button is named, and the face buttons wear the pad\'s glyphs', () => {
    for (const b of document.querySelectorAll('#touch-walk button')) expect(b.getAttribute('aria-label'), b.id).toBeTruthy();
    expect(button('tw-stance').querySelector('svg.s2u-hint__glyph--triangle')).not.toBeNull();
    expect(button('tw-jump').querySelector('svg.s2u-hint__glyph--square')).not.toBeNull();
    expect(button('tw-action').querySelector('svg.s2u-hint__glyph--cross')).not.toBeNull();
  });

  it('shows only while walking on a touch screen, and lifts the fullscreen button off the HUD\'s corner', () => {
    expect(css).toMatch(/#touch-walk, #rotate-hint\s*{\s*display:\s*none/);
    expect(css).toMatch(/body\.touch\.is-walking #touch-walk\s*{\s*display:\s*block/);
    expect(css).toMatch(/body\.touch\.is-walking #touch-lift[^{]*#touch-fire\s*{\s*display:\s*none/);
    expect(css).toMatch(/body\.is-walking #fullscreen\s*{[^}]*right:\s*auto[^}]*left:/);
    expect(css).toMatch(/@media \(orientation: portrait\)\s*{[^}]*#rotate-hint/);
  });

  it('is taken out with the rest of the play when it is off, and nothing is wired', () => {
    removePlayUi();
    expect(document.getElementById('touch-walk')).toBeNull();
    expect(document.getElementById('rotate-hint')).toBeNull();
    expect(attachWalkTouch(() => undefined, () => undefined)).toBe(0);
  });

  it('says nothing about a walk in its words when the play is off', () => {
    removePlayUi();
    expect(document.body.textContent).not.toMatch(/sideways/);
  });
});

describe('attachWalkTouch', () => {
  const log: string[] = [];
  beforeEach(() => {
    load(); log.length = 0;
    attachWalkTouch((lane, down) => log.push(`${lane}:${down ? 'down' : 'up'}`), () => log.push('reload'));
  });

  it('wires every button', () => {
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    expect(attachWalkTouch(() => undefined, () => undefined)).toBe(14);
  });

  it('a press holds the lane and a release lets it go, once', () => {
    ptr(button('tw-jump'), 'pointerdown');
    expect(log).toEqual(['jump:down']);
    expect(button('tw-jump').classList.contains('is-down')).toBe(true);
    ptr(button('tw-jump'), 'pointerup');
    ptr(button('tw-jump'), 'lostpointercapture');                    // the browser's own follow-up: not a second release
    expect(log).toEqual(['jump:down', 'jump:up']);
    expect(button('tw-jump').classList.contains('is-down')).toBe(false);
  });

  it('holds many at once, each by its own pointer: the thumb on fire and jump together', () => {
    ptr(button('tw-fire'), 'pointerdown', 1);
    ptr(button('tw-stance'), 'pointerdown', 2);
    ptr(button('tw-peek-left'), 'pointerdown', 3);
    expect(log).toEqual(['fire:down', 'stance:down', 'leanLeft:down']);
    ptr(button('tw-fire'), 'pointerup', 1);
    expect(log.at(-1)).toBe('fire:up');
    expect(button('tw-stance').classList.contains('is-down')).toBe(true);
  });

  it('ignores a second finger on a button already held, and a release by another pointer', () => {
    ptr(button('tw-fire'), 'pointerdown', 1);
    ptr(button('tw-fire'), 'pointerdown', 2);
    ptr(button('tw-fire'), 'pointerup', 2);
    expect(log).toEqual(['fire:down']);
    ptr(button('tw-fire'), 'pointercancel', 1);
    expect(log).toEqual(['fire:down', 'fire:up']);
  });

  it('a cancelled touch is a release', () => {
    ptr(button('tw-swap1'), 'pointerdown');
    ptr(button('tw-swap1'), 'pointercancel');
    expect(log).toEqual(['swap1:down', 'swap1:up']);
  });

  it('reload has no lane: a press calls it, a release does nothing', () => {
    ptr(button('tw-reload'), 'pointerdown');
    ptr(button('tw-reload'), 'pointerup');
    expect(log).toEqual(['reload']);
  });

  it('a pointer the browser will not capture is let go when it slides off', () => {
    const b = button('tw-zoom-in') as HTMLButtonElement;
    b.setPointerCapture = () => { throw new DOMException('gone', 'NotFoundError'); };
    expect(() => ptr(b, 'pointerdown')).not.toThrow();
    ptr(b, 'pointerleave');
    expect(log).toEqual(['zoom:down', 'zoom:up']);
  });

  it('a long press does not open the browser\'s menu', () => {
    const e = new Event('contextmenu', { bubbles: true, cancelable: true });
    button('tw-fire').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
