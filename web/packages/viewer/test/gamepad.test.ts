import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { FlyCamera } from '../src/camera';
import {
  ACTION_WORDS, mergeInput, noInput, OWNER, PAD_BUTTON, PAD_DEAD_ZONE, PAD_FLAGS, PAD_LAYOUT, PAD_STICK, padInput, padRaw,
  PadWatch, pressedSince, releasedSince, shortSource,
  type GamepadLike, type Input, type PadLike, type PadRow,
} from '../src/gamepad';
import { TOAST_MS, Ui } from '../src/ui';

/**
 * W2.7, the controller: the Gamepad API's standard mapping read as the PS2 pad (W2.R5). The mapping is pure and
 * pinned here on a synthetic pad -- each stick to its axes through the dead zone, each button to its action, the
 * table's documented and assumed rows counted -- then the watcher that says when a pad comes and goes, the look the
 * right stick drives on the fly camera, and the page's toast and layout table.
 */

/** A synthetic standard-mapping pad (W3C Gamepad, "Remapping": 17 buttons, 4 axes), everything at rest. */
function pad(over: { axes?: number[]; press?: number[]; values?: Record<number, number> } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const pressed = over.press?.includes(i) ?? false;
    return { pressed, value: over.values?.[i] ?? (pressed ? 1 : 0) };
  });
  return { axes: over.axes ?? [0, 0, 0, 0], buttons };
}

/** The same with an identity, as `navigator.getGamepads()` hands it back. */
function seen(index: number, id: string, mapping = 'standard', connected = true): PadLike {
  return { ...pad(), index, id, mapping, connected };
}

const REST = noInput();

describe('the standard mapping, named as the PS2 pad', () => {
  it('numbers the buttons as the W3C standard layout does, by position', () => {
    expect(PAD_BUTTON).toEqual({
      Cross: 0, Circle: 1, Square: 2, Triangle: 3, L1: 4, R1: 5, L2: 6, R2: 7,
      Select: 8, Start: 9, L3: 10, R3: 11, Up: 12, Down: 13, Left: 14, Right: 15,
    });
    expect(PAD_STICK).toEqual({ 'L-stick': [0, 1], 'R-stick': [2, 3] });
  });

  it('takes the launcher\'s own dead zone, 0.15', () => {
    expect(PAD_DEAD_ZONE).toBe(0.15);
  });
});

describe('padInput: the sticks', () => {
  it('is the rest input with no pad, and with a pad at rest', () => {
    expect(padInput(null)).toEqual(REST);
    expect(padInput(undefined)).toEqual(REST);
    expect(padInput(pad())).toEqual(REST);
  });

  it('the left stick moves: up the stick is forward (the standard\'s y grows down), right is right', () => {
    expect(padInput(pad({ axes: [0, -1, 0, 0] }))).toEqual({ ...REST, moveY: 1 });
    expect(padInput(pad({ axes: [0, 1, 0, 0] }))).toEqual({ ...REST, moveY: -1 });
    expect(padInput(pad({ axes: [1, 0, 0, 0] }))).toEqual({ ...REST, moveX: 1 });
    expect(padInput(pad({ axes: [-1, 0, 0, 0] }))).toEqual({ ...REST, moveX: -1 });
  });

  it('the right stick looks: up the stick is up, right is right; neither stick does the other\'s job', () => {
    expect(padInput(pad({ axes: [0, 0, 1, 0] }))).toEqual({ ...REST, lookX: 1 });
    expect(padInput(pad({ axes: [0, 0, 0, -1] }))).toEqual({ ...REST, lookY: 1 });
    expect(padInput(pad({ axes: [0, 0, -1, 0] }))).toEqual({ ...REST, lookX: -1 });
    expect(padInput(pad({ axes: [0, 0, 0, 1] }))).toEqual({ ...REST, lookY: -1 });
  });

  it('is exactly zero inside the dead zone', () => {
    expect(padInput(pad({ axes: [0.1, 0.1, -0.1, 0.05] }))).toEqual(REST);      // hypot 0.141 and 0.112
    expect(padInput(pad({ axes: [0, PAD_DEAD_ZONE, PAD_DEAD_ZONE, 0] }))).toEqual(REST);
  });

  it('is radial: a diagonal past the zone moves although each axis alone is inside it', () => {
    const v = padInput(pad({ axes: [0.12, -0.12, 0, 0] }));                   // hypot 0.170
    expect(v.moveX).toBeGreaterThan(0);
    expect(v.moveY).toBeGreaterThan(0);
    expect(v.moveX).toBeCloseTo(v.moveY, 12);                                 // the direction is kept
  });

  it('rescales past the zone: its edge is 0, the rim 1, half way between them 0.5', () => {
    const half = PAD_DEAD_ZONE + (1 - PAD_DEAD_ZONE) / 2;
    expect(padInput(pad({ axes: [0, -half, 0, 0] })).moveY).toBeCloseTo(0.5, 12);
    expect(padInput(pad({ axes: [0, -(PAD_DEAD_ZONE + 0.01), 0, 0] })).moveY).toBeLessThan(0.02);
  });

  it('keeps a square gate\'s corner past the rim, on the diagonal, so padRaw gives the walk each axis full (research 88)', () => {
    const v = padInput(pad({ axes: [1, -1, 0, 0] }));
    const k = (Math.SQRT2 - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE) / Math.SQRT2;
    expect(v.moveX).toBeCloseTo(k, 12);
    expect(v.moveY).toBeCloseTo(k, 12);
    const [x, y] = padRaw(v.moveX, v.moveY);
    expect(x).toBeCloseTo(1, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(padRaw(0, 0)).toEqual([0, 0]);
    const part = padInput(pad({ axes: [0, 0, 0.6, 0] }));
    expect(padRaw(part.lookX, part.lookY)[0]).toBeCloseTo(0.6, 12);    // an axis alone comes back as the pad gave it
  });

  it('reads a missing or non-finite axis as centred', () => {
    expect(padInput({ axes: [], buttons: [] })).toEqual(REST);
    expect(padInput({ axes: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN], buttons: [] })).toEqual(REST);
    expect(padInput({ axes: [Number.NaN, -1], buttons: [] })).toEqual({ ...REST, moveY: 1 });
  });
});

describe('padInput: the buttons', () => {
  const EXPECT: [keyof typeof PAD_BUTTON, keyof Input][] = [
    ['Square', 'jump'], ['L3', 'crouch'], ['Triangle', 'stance'], ['R1', 'fire'], ['L1', 'aim'],
    ['L2', 'leanLeft'], ['R2', 'leanRight'], ['Start', 'mode'], ['R3', 'boost'], ['Up', 'zoom'],
  ];
  it.each(EXPECT)('%s alone is %s alone', (button, action) => {
    expect(padInput(pad({ press: [PAD_BUTTON[button]] }))).toEqual({ ...REST, [action]: true });
  });

  it('leaves Cross, Circle, Select, the d-pad but Up and the home button free (Cross no longer jumps)', () => {
    for (const free of [0, 1, 8, 13, 14, 15, 16]) expect(padInput(pad({ press: [free] })), `button ${free}`).toEqual(REST);
  });

  it('counts a trigger by its value when the browser does not say pressed: past half is down', () => {
    expect(padInput(pad({ values: { 6: 0.8 } }))).toEqual({ ...REST, leanLeft: true });
    expect(padInput(pad({ values: { 7: 0.3 } }))).toEqual(REST);
  });

  it('holds every button at once, and a stick with them', () => {
    const all = padInput(pad({ axes: [0, -1, 1, 0], press: EXPECT.map(([b]) => PAD_BUTTON[b]) }));
    expect(all).toEqual({
      moveX: 0, moveY: 1, lookX: 1, lookY: 0,
      jump: true, crouch: true, stance: true, boost: true, fire: true, aim: true, zoom: true, leanLeft: true, leanRight: true, mode: true,
    });
  });

  it('is driven by the table it is given, not by a table of its own', () => {
    const layout: PadRow[] = [{ control: 'Circle', action: 'jump', documented: 'assumed', note: 'a test layout' }];
    expect(padInput(pad({ press: [PAD_BUTTON.Circle] }), layout)).toEqual({ ...REST, jump: true });
    expect(padInput(pad({ press: [PAD_BUTTON.Square], axes: [0, -1, 0, 0] }), layout)).toEqual(REST);
  });
});

describe('PAD_LAYOUT: the owner\'s layout (2026-09-28), each row stated, documented or assumed', () => {
  const owner = PAD_LAYOUT.filter((r) => r.documented.startsWith(OWNER));
  const documented = PAD_LAYOUT.filter((r) => r.documented !== 'assumed' && !r.documented.startsWith(OWNER));
  const assumed = PAD_LAYOUT.filter((r) => r.documented === 'assumed');
  const row = (control: string): PadRow => PAD_LAYOUT.find((r) => r.control === control)!;

  it('has twelve rows: six the owner stated, three documented, two assumed lean rows and the fly boost', () => {
    expect(PAD_LAYOUT).toHaveLength(12);
    expect(owner.map((r) => r.control)).toEqual(['Square', 'R1', 'Triangle', 'L1', 'Up', 'Start']);
    expect(documented.map((r) => r.control)).toEqual(['L-stick', 'R-stick', 'L3']);
    expect(assumed.map((r) => r.control)).toEqual(['L2', 'R2', 'R3']);
  });

  it('is the owner\'s: Square jumps, R1 fires, Triangle is the stance, L1 aims, Start switches mode, d-pad Up zooms, Cross is free', () => {
    expect([row('Square').action, row('R1').action, row('Triangle').action, row('L1').action, row('Start').action, row('Up').action])
      .toEqual(['jump', 'fire', 'stance', 'aim', 'mode', 'zoom']);
    expect(PAD_LAYOUT.some((r) => r.control === 'Cross')).toBe(false);
    expect(OWNER).toBe('owner, 2026-09-28');
  });

  it('cites a file and a line or a section for every row the repository documents', () => {
    for (const r of documented) expect(r.documented, r.control).toMatch(/[\w/.-]+\.(md|cpp|h)(:\d|\s§|\sstep\s\d)/);
    expect(row('L3').documented).toMatch(/docs\/INSTALL\.md §6/);
    expect(row('L3').documented).toMatch(/docs\/PLAYTEST\.md step 8/);
    expect(row('Triangle').documented).toMatch(/host_crouch_shortcut\.h:4-7/);
  });

  it('says why in every row, and names the game\'s own meaning where the repository gives one that differs', () => {
    for (const r of PAD_LAYOUT) expect(r.note.length, r.control).toBeGreaterThan(20);
    expect(row('L3').note).toMatch(/fire mode/);
    expect(row('L2').note).toMatch(/second-weapon swap/);
    expect(row('Triangle').note).toMatch(/prone/);
    expect(row('Triangle').note).toMatch(/guess/);          // the hold's length is named as one
  });

  it('gives every action a control, and each control one row', () => {
    const actions = new Set(PAD_LAYOUT.map((r) => r.action));
    for (const a of ['move', 'look', ...PAD_FLAGS]) expect(actions.has(a as PadRow['action']), a).toBe(true);
    expect(new Set(PAD_LAYOUT.map((r) => r.control)).size).toBe(PAD_LAYOUT.length);
  });

  it('words each action per mode: the same button is jump on foot and up in the air; no sprint on foot', () => {
    expect(ACTION_WORDS.jump).toEqual({ walk: 'jump', fly: 'up' });
    expect(ACTION_WORDS.move.walk).toMatch(/move/);
    expect(ACTION_WORDS.move.fly).toMatch(/fly/);
    expect(ACTION_WORDS.stance.walk).toMatch(/tap crouch, hold prone/);
    expect(ACTION_WORDS.boost.walk).toBeNull();
    expect(ACTION_WORDS.boost.fly).toBe('boost');
    expect(ACTION_WORDS.fire.fly).toBeNull();               // fire and aim are the walk's
    expect(ACTION_WORDS.aim.fly).toBeNull();
    expect(ACTION_WORDS.zoom).toEqual({ walk: 'zoom (scope)', fly: null });
    for (const r of PAD_LAYOUT) {
      const w = ACTION_WORDS[r.action];
      if (r.action !== 'leanLeft' && r.action !== 'leanRight') expect(w.walk ?? w.fly, r.control).toBeTruthy();
    }
  });

  it('shortens a citation to its files\' names for the panel', () => {
    expect(shortSource('docs/INSTALL.md §6; third_party/a/b/launcher_config.cpp:568')).toBe('INSTALL.md §6; launcher_config.cpp:568');
    expect(shortSource('assumed')).toBe('assumed');
    expect(shortSource(`${OWNER}; docs/KNOWN.md (R139 row)`)).toBe('owner, 2026-09-28; KNOWN.md (R139 row)');
  });
});

describe('mergeInput and the edges', () => {
  const touch: Input = { ...REST, moveX: 0.3, moveY: -0.9, jump: true };
  const stick: Input = { ...REST, moveX: -0.5, moveY: 0.2, lookX: 0.4, fire: true };

  it('takes the larger magnitude on each axis and ORs the actions', () => {
    expect(mergeInput(touch, stick)).toEqual({ ...REST, moveX: -0.5, moveY: -0.9, lookX: 0.4, jump: true, fire: true });
    expect(mergeInput(stick, touch)).toEqual(mergeInput(touch, stick));
    expect(mergeInput()).toEqual(REST);
    expect(mergeInput(touch)).toEqual(touch);
  });

  it('names what went down and what came up since the last frame', () => {
    const before: Input = { ...REST, mode: true, crouch: true };
    const after: Input = { ...REST, crouch: false, jump: true, mode: true };
    expect(pressedSince(before, after)).toEqual(['jump']);
    expect(releasedSince(before, after)).toEqual(['crouch']);
    expect(pressedSince(after, after)).toEqual([]);
  });
});

describe('PadWatch: a pad coming and going, from the events and from the poll', () => {
  const log: string[] = [];
  const watch = (): PadWatch => new PadWatch({ connected: (id) => log.push(`+${id}`), disconnected: (id) => log.push(`-${id}`) });
  beforeEach(() => { log.length = 0; });

  it('says connected once, whether the poll or the event sees it first', () => {
    const w = watch();
    const a = seen(0, 'pad A');
    expect(w.poll({ getGamepads: () => [a, null, null, null] })).toBe(a);
    expect(w.poll({ getGamepads: () => [a, null, null, null] })).toBe(a);
    const target = new EventTarget();
    w.attach(target);
    target.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: a }));
    expect(log).toEqual(['+pad A']);
    expect(w.id()).toBe('pad A');
    expect(w.count()).toBe(1);
  });

  it('says disconnected when the poll loses it, or on the event, once', () => {
    const w = watch();
    const target = new EventTarget();
    w.attach(target);
    const a = seen(1, 'pad B');
    target.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: a }));
    expect(w.poll({ getGamepads: () => [null, null, null, null] })).toBeNull();
    target.dispatchEvent(Object.assign(new Event('gamepaddisconnected'), { gamepad: a }));
    expect(log).toEqual(['+pad B', '-pad B']);
    expect(w.count()).toBe(0);
    expect(w.id()).toBeNull();
    // Firefox keeps the entry with connected false.
    const w2 = watch();
    w2.poll({ getGamepads: () => [a] });
    w2.poll({ getGamepads: () => [{ ...a, connected: false }] });
    expect(log.slice(2)).toEqual(['+pad B', '-pad B']);
  });

  it('prefers a pad with the standard mapping, whose indices the layout is written in', () => {
    const odd = seen(0, 'odd pad', '');
    const std = seen(1, 'std pad');
    expect(watch().poll({ getGamepads: () => [odd, std] })).toBe(std);
    expect(watch().poll({ getGamepads: () => [odd] })).toBe(odd);
  });

  it('treats another pad at the same index as a disconnect and a connect', () => {
    const w = watch();
    w.poll({ getGamepads: () => [seen(0, 'first')] });
    w.poll({ getGamepads: () => [seen(0, 'second')] });
    expect(log).toEqual(['+first', '-first', '+second']);
  });

  it('with no getGamepads, reads nothing and drops nothing the events said', () => {
    const w = watch();
    const target = new EventTarget();
    w.attach(target);
    target.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: seen(0, 'events only') }));
    expect(w.poll({})).toBeNull();
    expect(w.poll({ getGamepads: () => { throw new Error('refused by a permissions policy'); } })).toBeNull();
    expect(log).toEqual(['+events only']);
  });

  it('ignores an event that carries no pad', () => {
    const w = watch();
    const target = new EventTarget();
    w.attach(target);
    target.dispatchEvent(new Event('gamepadconnected'));
    target.dispatchEvent(new Event('gamepaddisconnected'));
    expect(log).toEqual([]);
  });
});

describe('the right stick on the fly camera: the arrows\' rate, scaled by the push', () => {
  const canvas = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.requestPointerLock = (() => undefined) as unknown as HTMLCanvasElement['requestPointerLock'];
    return c;
  };
  const run = (fly: FlyCamera, seconds: number): void => { for (let i = 0; i < 60; i++) fly.update(seconds / 60); };
  /** Short of the pitch limit (89.9 degrees): half a second at 1.6 rad a second is 45.8. */
  const SECONDS = 0.5;
  const hold = (code: string): void => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { code })); };
  const release = (code: string): void => { globalThis.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const turned = (setup: (fly: FlyCamera) => void, after: (fly: FlyCamera) => void = () => undefined): { yaw: number; pitch: number } => {
    const fly = new FlyCamera(canvas());
    fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    setup(fly);
    run(fly, SECONDS);
    after(fly);
    const p = fly.pose();
    return { yaw: p.yaw, pitch: p.pitch };
  };

  it('pushed full right turns as far as the right arrow held as long', () => {
    const arrow = turned(() => hold('ArrowRight'), () => release('ArrowRight'));
    expect(arrow.yaw).toBeCloseTo(-1.6 * SECONDS * 180 / Math.PI, 9);           // ARROW_LOOK, 1.6 rad a second
    expect(turned((f) => f.setLook(1, 0)).yaw).toBeCloseTo(arrow.yaw, 9);
    expect(turned((f) => f.setLook(0.5, 0)).yaw).toBeCloseTo(arrow.yaw / 2, 9);
  });

  it('pushed up looks up, as the up arrow does', () => {
    const arrow = turned(() => hold('ArrowUp'), () => release('ArrowUp'));
    expect(arrow.pitch).toBeCloseTo(1.6 * SECONDS * 180 / Math.PI, 9);
    expect(turned((f) => f.setLook(0, 1)).pitch).toBeCloseTo(arrow.pitch, 9);
  });

  it('with an arrow held as well, the larger of the two turns, not their sum', () => {
    const arrow = turned(() => hold('ArrowRight'), () => release('ArrowRight'));
    expect(turned((f) => { hold('ArrowRight'); f.setLook(0.5, 0); }, () => release('ArrowRight')).yaw).toBeCloseTo(arrow.yaw, 9);
  });

  it('moves nothing: the look alone leaves the camera where it stood', () => {
    const fly = new FlyCamera(canvas());
    fly.setPose({ x: 1, y: 2, z: 3, yaw: 0, pitch: 0 });
    fly.setLook(1, 1);
    run(fly, 1);
    expect(fly.pose()).toMatchObject({ x: 1, y: 2, z: 3 });
  });
});

describe('the page: the toast and the layout table', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
  const css = readFileSync(resolve(here, '../src/styles.css'), 'utf-8');

  it('has a toast in the system\'s status pill, announced politely, hidden at rest', () => {
    const doc = new JSDOM(html).window.document;
    const toast = doc.getElementById('toast')!;
    expect(toast).not.toBeNull();
    expect([...toast.classList]).toEqual(['s2u-status', 's2u-status--pill']);
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(toast.hidden).toBe(true);
  });

  it('places the toast top centre, fixed by the pill, and lets a drag through it', () => {
    expect(css).toMatch(/#toast\s*{[^}]*left:\s*50%[^}]*transform:\s*translateX\(-50%\)/);
    expect(css).toMatch(/#toast\s*{[^}]*pointer-events:\s*none/);
  });

  it('has the layout table in a disclosure under the hint line, hidden until a pad connects', () => {
    const doc = new JSDOM(html).window.document;
    const box = doc.getElementById('pad-box')!;
    expect(box.tagName).toBe('DETAILS');
    expect(box.classList.contains('s2u-disclosure')).toBe(true);
    expect(box.hidden).toBe(true);
    expect(box.querySelector('table#pad-layout > thead')).not.toBeNull();
    expect(doc.getElementById('hint')!.nextElementSibling).toBe(box);
  });

  describe('Ui', () => {
    let ui: Ui;
    beforeEach(() => {
      document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
      vi.useFakeTimers();
      ui = new Ui();
    });
    afterEach(() => { vi.useRealTimers(); });

    it('toast shows the text for a few seconds, then goes', () => {
      const toast = document.getElementById('toast')!;
      ui.toast('Controller connected: Test pad');
      expect(toast.textContent).toBe('Controller connected: Test pad');
      expect(toast.hidden).toBe(false);
      expect(TOAST_MS).toBeGreaterThanOrEqual(2000);
      expect(TOAST_MS).toBeLessThanOrEqual(6000);
      vi.advanceTimersByTime(TOAST_MS - 1);
      expect(toast.hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(toast.hidden).toBe(true);
    });

    it('shows one toast at a time: the next replaces the last and has its own few seconds', () => {
      const toast = document.getElementById('toast')!;
      ui.toast('Controller connected: Test pad');
      vi.advanceTimersByTime(TOAST_MS - 100);
      ui.toast('Controller disconnected');
      expect(toast.textContent).toBe('Controller disconnected');
      vi.advanceTimersByTime(200);
      expect(toast.hidden).toBe(false);
      vi.advanceTimersByTime(TOAST_MS);
      expect(toast.hidden).toBe(true);
    });

    /** The table's rows as [control, does, source-cell text]. */
    const table = (): string[][] => [...document.querySelectorAll('#pad-layout tbody tr')]
      .map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent ?? ''));

    it('lists only the flying controls in fly mode, and marks the assumed rows', () => {
      ui.showPadLayout(PAD_LAYOUT);
      ui.showPadLayout(PAD_LAYOUT);
      const box = document.getElementById('pad-box')!;
      expect(box.hidden).toBe(false);
      const rows = [...box.querySelectorAll('#pad-layout tbody tr')];
      expect(table().map((r) => r[0])).toEqual(['L-stick', 'R-stick', 'Square', 'Triangle', 'Start', 'L3', 'R3']);
      expect(document.getElementById('pad-mode')!.textContent).toBe('flying');
      const marked = rows.filter((r) => r.classList.contains('is-assumed'));
      expect(marked.map((r) => r.textContent)).toHaveLength(1);                // R3 alone, of the rows a flyer sees
      for (const r of marked) expect(r.querySelector('.s2u-label--warn')?.textContent).toBe('assumed');
      expect(rows[0]!.textContent).toMatch(/L-stick/);
      expect(rows.find((r) => /Square/.test(r.textContent ?? ''))!.querySelector('svg.s2u-hint__glyph--square')).not.toBeNull();
      expect(rows.find((r) => /L3/.test(r.textContent ?? ''))!.textContent).toMatch(/INSTALL\.md §6/);
      expect(table().find((r) => r[0] === 'R3')![1]).toBe('boost');
      expect(table().find((r) => r[0] === 'Square')![2]).toMatch(/^owner, 2026-09-28/);
    });

    it('lists only the walking controls in walk mode: fire, aim and the stance, no boost', () => {
      ui.showPadLayout(PAD_LAYOUT);
      ui.setWalk(true);
      expect(table().map((r) => r[0])).toEqual(['L-stick', 'R-stick', 'Square', 'R1', 'Triangle', 'L1', 'Up', 'Start', 'L3']);
      expect(document.getElementById('pad-mode')!.textContent).toBe('on foot');
      expect(table().find((r) => r[0] === 'R1')![1]).toBe('fire (held)');
      expect(table().find((r) => r[0] === 'Up')![1]).toBe('zoom (scope)');
      expect(table().find((r) => r[0] === 'Triangle')![1]).toBe('stance: tap crouch, hold prone');
      expect(table().flat().join(' ')).not.toMatch(/boost/);
      ui.setWalk(false);
      expect(table().map((r) => r[0])).toContain('R3');
      expect(table().map((r) => r[0])).not.toContain('R1');
    });

    it('the Fly / Walk switch is the picture switch markup, drives the hidden box and follows setWalk', () => {
      const group = document.getElementById('mode')!;
      const look = document.getElementById('look')!;
      expect(group.className).toBe(look.className);
      expect(group.getAttribute('role')).toBe('radiogroup');
      const buttons = [...group.querySelectorAll('button')];
      expect(buttons.map((b) => b.dataset['mode'])).toEqual(['fly', 'walk']);
      for (const b of buttons) {
        expect(b.className).toBe('s2u-tab');
        expect(b.querySelector('.s2u-tab__what')).not.toBeNull();
      }
      const seen: boolean[] = [];
      ui.onWalkSwitch((on) => seen.push(on));
      const pressed = (): string[] => buttons.map((b) => b.getAttribute('aria-pressed')!);
      expect(pressed()).toEqual(['true', 'false']);
      buttons[1]!.click();
      expect(seen).toEqual([true]);
      expect((document.getElementById('walk') as HTMLInputElement).checked).toBe(true);
      expect(pressed()).toEqual(['false', 'true']);
      buttons[1]!.click();                                                        // already on: nothing
      expect(seen).toEqual([true]);
      ui.setWalk(false);                                                          // G or Start: the switch follows, no handler call
      expect(pressed()).toEqual(['true', 'false']);
      expect((document.getElementById('walk') as HTMLInputElement).checked).toBe(false);
      expect(seen).toEqual([true]);
      buttons[0]!.click();                                                        // already fly
      expect(seen).toEqual([true]);
    });

    it('the hint line names only the mode you are in, rebuilt on every change, F and the backtick in both', () => {
      const hint = document.getElementById('hint')!;
      ui.setCameraHint(1, false);
      expect(hint.textContent).toBe('click to look · WASD fly · space/shift up/down · double-tap W to boost · wheel speed 1.0× · arrows look · G walk · F fullscreen · ` hides this');
      ui.setWalk(true);
      expect(hint.textContent).toBe('click to look · WASD move · mouse look/turn · space jump · C stance · V first person · right button aim · d-pad Up zoom · click fire · R reload · G fly · F fullscreen · ` hides this');
      expect(hint.textContent).not.toMatch(/boost|wheel|arrows|WASD fly/);
      ui.setCameraHint(2, true);
      expect(hint.textContent).toMatch(/^esc to release · WASD move/);
      ui.setWalk(false);
      expect(hint.textContent).toMatch(/^esc to release · WASD fly .* wheel speed 2\.0× .* G walk · F fullscreen · ` hides this$/);
      expect(hint.textContent).not.toMatch(/jump|stance|fire|reload/);
    });

    it('says "pad: connected" on the hint line while one is, whatever rebuilds the line', () => {
      const hint = document.getElementById('hint')!;
      ui.setPadConnected(true);
      expect(hint.textContent).toMatch(/ · pad: connected$/);
      ui.setCameraHint(2, true);
      expect(hint.textContent).toMatch(/^esc to release/);
      expect(hint.textContent).toMatch(/ · pad: connected$/);
      ui.setPadConnected(false);
      expect(hint.textContent).not.toMatch(/pad: connected/);
      expect(hint.textContent).toMatch(/^esc to release/);
    });
  });
});
