import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PAD_LAYOUT, padGroup } from '../src/gamepad';
import { controlGroups } from '../src/controlsList';
import type { LookOptions } from '../src/look';
import { PLAY_ATTRIBUTE, PLAY_PARAM, playEnabled, removePlayUi } from '../src/features';
import { POPOVER_GRACE_MS, Ui } from '../src/ui';

/**
 * The play (walk mode, the SEAL, the rifle) is behind `?redotcom` (owner, 2026-09-28), and the settings panel starts
 * folded with the Controls popover in the bar.
 */
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const load = (): void => { document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML; };

describe('playEnabled: the URL parameter', () => {
  it('names the parameter redotcom', () => {
    expect(PLAY_PARAM).toBe('redotcom');
  });
  it('is on when the parameter is there, with or without a value or a leading ?', () => {
    for (const q of ['?redotcom', '?redotcom=1', 'redotcom', '?redotcom=', '?redotcom=0', '?map=MP2&redotcom', '?redotcom&map=MP2', '?map=MP2&redotcom=yes&x=1']) {
      expect(playEnabled(q), q).toBe(true);
    }
  });
  it('is off without it: nothing, other parameters, near misses, the value of another', () => {
    for (const q of ['', '?', '?map=MP2', '?redot', '?redotcoms', '?Redotcom', '?x=redotcom', '?map=redotcom', '?walk']) {
      expect(playEnabled(q), q).toBe(false);
    }
  });
});

describe('removePlayUi: the play markup is taken out, not hidden', () => {
  beforeEach(load);

  it('removes every element that carries data-play, and says how many', () => {
    const marked = document.querySelectorAll(`[${PLAY_ATTRIBUTE}]`).length;
    expect(marked).toBeGreaterThanOrEqual(5);     // the ammo pill went to the HUD (`./hud`)
    expect(removePlayUi()).toBe(marked);
    expect(document.querySelectorAll(`[${PLAY_ATTRIBUTE}]`)).toHaveLength(0);
    expect(removePlayUi()).toBe(0);
  });

  it('takes out the Fly / Walk switch, its box, the body row and the touch stance and fire buttons', () => {
    removePlayUi();
    for (const id of ['mode', 'walk', 'body-row', 'player-body', 'touch-stance', 'touch-fire']) {
      expect(document.getElementById(id), id).toBeNull();
    }
    // What is not the play: the fly camera's own touch buttons, the look switch, the panel.
    for (const id of ['look', 'touch-up', 'touch-down', 'maps', 'controls', 'panel-toggle']) expect(document.getElementById(id), id).not.toBeNull();
  });

  it('leaves no word about walking in the page text or tooltips', () => {
    removePlayUi();
    const words = (document.body.textContent ?? '') + [...document.querySelectorAll('[title],[aria-label]')]
      .map((e) => `${e.getAttribute('title')} ${e.getAttribute('aria-label')}`).join(' ');
    expect(words.match(/.{0,40}\b(walk\w*|stance|crouch\w*|prone)\b.{0,40}/gi)).toBeNull();
  });

  describe('the Ui over that page', () => {
    let ui: Ui;
    beforeEach(() => { removePlayUi(); ui = new Ui(); });

    it('builds without the play elements, and its setters do nothing to them', () => {
      expect(() => { ui.setWalk(true); ui.setWalk(false); ui.onWalkSwitch(() => undefined); }).not.toThrow();
      expect(ui.toggles().body).toBe(false);
    });

    it('the hint line and both lists name the fly camera alone, and no walk, no Start', () => {
      ui.setCameraHint(1, false);
      expect(document.getElementById('hint')!.textContent).toBe('click to look · wheel speed 1.0×');
      const keys = [...document.querySelectorAll('#keys-list tbody tr')].map((r) => r.textContent).join(' | ');
      expect(keys).toMatch(/W A S Dfly/);
      expect(keys).toMatch(/Ffullscreen/);
      expect(keys).not.toMatch(/walk|jump|stance|fire|reload|peek|grenade|zoom/i);
      const rows = [...document.querySelectorAll('#pad-list tbody tr:not(.pad-group)')].map((r) => r.querySelector('td')!.textContent);
      expect(rows).toEqual(['Left stick', 'Right stick', 'Square', 'Triangle', 'Circle']);
      for (const id of ['sound-section', 'look-section', 'mute', 'volume', 'mouselaw', 'sensitivity']) expect(document.getElementById(id), id).toBeNull();
    });
  });
});

describe('the page with the play on', () => {
  it('keeps the play markup, and the keys list has G walk', () => {
    load();
    const ui = new Ui();
    const keys = (): string => [...document.querySelectorAll('#keys-list tbody tr')].map((r) => r.textContent).join(' | ');
    expect(document.getElementById('mode')).not.toBeNull();
    expect(keys()).toMatch(/Gwalk/);
    ui.setWalk(true);
    expect(keys()).toMatch(/Gfly/);
  });
});

describe('the Sound section (round 2): mute and volume, remembered', () => {
  let ui: Ui;
  const heard: string[] = [];
  const handler = { volume: (v: number): void => { heard.push(`v${v}`); }, muted: (m: boolean): void => { heard.push(`m${m}`); } };
  const mute = (): HTMLInputElement => document.getElementById('mute') as HTMLInputElement;
  const volume = (): HTMLInputElement => document.getElementById('volume') as HTMLInputElement;
  const input = (el: HTMLInputElement, value: string): void => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
  beforeEach(() => { localStorage.clear(); heard.length = 0; load(); ui = new Ui(); });
  afterEach(() => { localStorage.clear(); });

  it('is a panel section with a switch and a slider, and it is the play\'s (data-play)', () => {
    expect(document.getElementById('sound-section')!.hasAttribute(PLAY_ATTRIBUTE)).toBe(true);
    expect(mute().closest('label')!.classList.contains('s2u-check')).toBe(true);
    expect(volume().type).toBe('range');
    expect(document.getElementById('sound-section')!.closest('#panel')).not.toBeNull();
  });

  it('starts at full volume, not muted, and tells the handlers', () => {
    ui.onSound(handler);
    expect(heard).toEqual(['v1', 'mfalse']);
    expect(document.getElementById('volume-out')!.textContent).toBe('100%');
  });

  it('drives the handlers from the controls and remembers both', () => {
    ui.onSound(handler);
    heard.length = 0;
    input(volume(), '0.4');
    mute().checked = true;
    mute().dispatchEvent(new Event('change', { bubbles: true }));
    expect(heard).toEqual(['v0.4', 'mtrue']);
    expect(document.getElementById('volume-out')!.textContent).toBe('40%');
    expect(localStorage.getItem('s2u.viewer.volume')).toBe('0.4');
    expect(localStorage.getItem('s2u.viewer.muted')).toBe('1');
  });

  it('comes back as it was left, and ignores a stored value that is not a number', () => {
    localStorage.setItem('s2u.viewer.volume', '0.25');
    localStorage.setItem('s2u.viewer.muted', '1');
    ui.onSound(handler);
    expect(heard).toEqual(['v0.25', 'mtrue']);
    expect(mute().checked).toBe(true);
    heard.length = 0; load(); localStorage.setItem('s2u.viewer.volume', 'loud');
    new Ui().onSound(handler);
    expect(heard[0]).toBe('v1');
  });

  it('is not wired, and does not throw, when the play is off', () => {
    load(); removePlayUi();
    expect(() => new Ui().onSound(handler)).not.toThrow();
    expect(heard).toEqual([]);
  });
});

describe('the Mouse look section (round 2): the law, the sensitivity, the pitch, remembered', () => {
  let ui: Ui;
  const seen: Partial<LookOptions>[] = [];
  const handler = (o: Partial<LookOptions>): void => { seen.push(o); };
  const sens = (): HTMLInputElement => document.getElementById('sensitivity') as HTMLInputElement;
  const law = (l: string): HTMLButtonElement => document.querySelector(`#mouselaw button[data-law="${l}"]`) as HTMLButtonElement;
  beforeEach(() => { localStorage.clear(); seen.length = 0; load(); ui = new Ui(); });
  afterEach(() => { localStorage.clear(); });

  it('is the play\'s, in the panel, as the same segmented markup as the picture switch', () => {
    expect(document.getElementById('look-section')!.hasAttribute(PLAY_ATTRIBUTE)).toBe(true);
    expect(document.getElementById('mouselaw')!.className).toBe(document.getElementById('look')!.className);
    expect(document.getElementById('mouselaw')!.getAttribute('role')).toBe('radiogroup');
  });

  it('starts at the raw default the look law ships with, and tells the handler', () => {
    ui.onLookControls(handler);
    expect(seen).toEqual([{ mouse: 'raw', sensitivity: 1, pitchRatio: 'game', invertPitch: false }]);
    expect(law('raw').getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('sensitivity-out')!.textContent).toBe('1.00×');
  });

  it('every control changes the options the handler hears, and they are remembered', () => {
    ui.onLookControls(handler);
    law('stick').click();
    expect(seen.at(-1)!.mouse).toBe('stick');
    expect(law('stick').getAttribute('aria-pressed')).toBe('true');
    expect(law('raw').getAttribute('aria-pressed')).toBe('false');
    sens().value = '2.5';
    sens().dispatchEvent(new Event('input', { bubbles: true }));
    expect(seen.at(-1)!.sensitivity).toBe(2.5);
    expect(document.getElementById('sensitivity-out')!.textContent).toBe('2.50×');
    const invert = document.getElementById('invertpitch') as HTMLInputElement;
    invert.checked = true; invert.dispatchEvent(new Event('change', { bubbles: true }));
    const uniform = document.getElementById('uniformpitch') as HTMLInputElement;
    uniform.checked = true; uniform.dispatchEvent(new Event('change', { bubbles: true }));
    expect(seen.at(-1)).toEqual({ mouse: 'stick', sensitivity: 2.5, pitchRatio: 'uniform', invertPitch: true });
    const n = seen.length;
    law('stick').click();                                                        // already chosen: nothing
    expect(seen).toHaveLength(n);
    expect(JSON.parse(localStorage.getItem('s2u.viewer.mouseLook')!)).toEqual(seen.at(-1));
  });

  it('comes back as it was left, and falls back to the defaults on a stored value that is not ours', () => {
    localStorage.setItem('s2u.viewer.mouseLook', JSON.stringify({ mouse: 'stick', sensitivity: 3, pitchRatio: 'uniform', invertPitch: true }));
    ui.onLookControls(handler);
    expect(seen).toEqual([{ mouse: 'stick', sensitivity: 3, pitchRatio: 'uniform', invertPitch: true }]);
    seen.length = 0; load();
    localStorage.setItem('s2u.viewer.mouseLook', '{not json');
    new Ui().onLookControls(handler);
    expect(seen).toEqual([{ mouse: 'raw', sensitivity: 1, pitchRatio: 'game', invertPitch: false }]);
    seen.length = 0; load();
    localStorage.setItem('s2u.viewer.mouseLook', JSON.stringify({ mouse: 'wobble', sensitivity: 99 }));
    new Ui().onLookControls(handler);
    expect(seen[0]).toEqual({ mouse: 'raw', sensitivity: 4, pitchRatio: 'game', invertPitch: false });    // clamped to the slider
  });

  it('is not wired, and does not throw, when the play is off', () => {
    load(); removePlayUi();
    expect(() => new Ui().onLookControls(handler)).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('the Controls popover list (round 2; simplified 2026-09-29)', () => {
  it('groups the walk keys as move, combat, stance and action, weapons, general; the fly keys as move and general', () => {
    expect(controlGroups('walk', true).map((g) => g.name)).toEqual(['Move', 'Combat', 'Stance & action', 'Weapons', 'General']);
    expect(controlGroups('fly', true).map((g) => g.name)).toEqual(['Move', 'General']);
  });
  it('names every key the page binds on foot', () => {
    const keys = controlGroups('walk', true).flatMap((g) => g.rows.map((r) => r.keys)).join(' ');
    for (const k of ['W A S D', 'Space', 'Left click', 'Right click', 'R', 'B', 'C', 'X', 'Q / E', '1', '2', '3 / 4', 'Tab', 'M', 'G', 'F']) expect(keys, k).toContain(k);
    // The number keys (the owner, 2026-09-29): 1 main, 2 sidearm, 3 and 4 the equipment slots -- no per-grenade keys.
    const weapons = controlGroups('walk', true).find((g) => g.name === 'Weapons')!.rows;
    expect(weapons.map((r) => r.keys)).toEqual(['1', '2', '3 / 4']);
    expect(weapons.map((r) => r.does)).toEqual(['main weapon', 'sidearm', 'grenades and equipment']);
  });
  it('lists no first-person key, and C as a tap and a hold (owner, 2026-09-29)', () => {
    const rows = controlGroups('walk', true).flatMap((g) => g.rows);
    expect(rows.find((r) => r.keys === 'V')).toBeUndefined();
    expect(rows.some((r) => /first/i.test(r.does))).toBe(false);
    expect(rows.find((r) => r.keys === 'C')?.does).toBe('crouch (tap), prone (hold)');
  });
  it('lists no walk in the flying list without the play, and every group has rows', () => {
    const fly = controlGroups('fly', false);
    expect(JSON.stringify(fly)).not.toMatch(/walk/i);
    for (const g of [...controlGroups('walk', true), ...fly]) expect(g.rows.length, g.name).toBeGreaterThan(0);
  });
  it('groups every pad action, walking and flying, under one of those names', () => {
    const names = new Set(controlGroups('walk', true).map((g) => g.name));
    for (const r of PAD_LAYOUT) for (const mode of ['walk', 'fly'] as const) expect(names.has(padGroup(r.action, mode)), `${r.control} ${mode}`).toBe(true);
    expect(padGroup('fire', 'walk')).toBe('Combat');
    expect(padGroup('leanLeft', 'walk')).toBe('Stance & action');
    expect(padGroup('swap2', 'walk')).toBe('Weapons');
    expect(padGroup('jump', 'fly')).toBe('Move');
  });
  it('the popover holds the two tabs, then the Controller list, then the hint and the keys list', () => {
    load();
    const pop = document.getElementById('controls')!;
    const order = [...pop.querySelectorAll('#controls-tabs, #pad-list, #hint, #keys-list')].map((e) => e.id);
    expect(order).toEqual(['controls-tabs', 'pad-list', 'hint', 'keys-list']);
  });
});

describe('the settings panel starts folded, and the cog remembers the visitor choice', () => {
  let ui: Ui;
  const panel = (): HTMLElement => document.getElementById('panel')!;
  const cog = (): HTMLButtonElement => document.getElementById('panel-toggle') as HTMLButtonElement;
  beforeEach(() => { localStorage.clear(); load(); ui = new Ui(); });
  afterEach(() => { localStorage.clear(); });

  it('the markup itself is folded, so nothing flashes open before the script runs', () => {
    expect(panel().classList.contains('is-folded')).toBe(true);
    expect(new DOMParser().parseFromString(html, 'text/html').body.classList.contains('panel-collapsed')).toBe(true);
    expect(cog().getAttribute('aria-expanded')).toBe('false');
  });

  it('a first visit is folded on every device, a coarse pointer or not', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    ui.onPanelToggle();
    expect(ui.panelCollapsed()).toBe(true);
    vi.unstubAllGlobals();
    load(); ui = new Ui(); ui.onPanelToggle();
    expect(ui.panelCollapsed()).toBe(true);
    expect(panel().classList.contains('is-folded')).toBe(true);
    expect(cog().getAttribute('aria-expanded')).toBe('false');
  });

  it('the cog opens and folds it, keeps aria-expanded and a title honest, and remembers', () => {
    ui.onPanelToggle();
    cog().click();
    expect(ui.panelCollapsed()).toBe(false);
    expect(cog().getAttribute('aria-expanded')).toBe('true');
    expect(cog().title).toBe('hide the settings');
    expect(cog().classList.contains('is-on')).toBe(true);
    expect(localStorage.getItem('s2u.viewer.panelOpen')).toBe('1');
    load(); ui = new Ui(); ui.onPanelToggle();                     // the next visit
    expect(ui.panelCollapsed()).toBe(false);
    document.getElementById('panel-toggle')!.click();
    expect(ui.panelCollapsed()).toBe(true);
    expect(localStorage.getItem('s2u.viewer.panelOpen')).toBe('0');
  });

  it('an old remembered choice from when open was the default does not open it', () => {
    localStorage.setItem('s2u.viewer.panelCollapsed', '0');
    ui.onPanelToggle();
    expect(ui.panelCollapsed()).toBe(true);
  });

  it('a failed load unfolds it so the error is seen, without remembering that', () => {
    ui.onPanelToggle();
    ui.setStatus('failed while fetching: nope', 'error');
    expect(ui.panelCollapsed()).toBe(false);
    expect(localStorage.getItem('s2u.viewer.panelOpen')).toBeNull();
  });

  it('the status line keeps its whole text as its tooltip', () => {
    ui.setStatus('FROSTFIRE (MP2) · webgl2 · 16,931 triangles');
    expect(document.getElementById('status')!.title).toBe('FROSTFIRE (MP2) · webgl2 · 16,931 triangles');
  });

  it('the load progress is the overlay, outside the panel, so it shows while the panel is folded', () => {
    ui.onPanelToggle();
    ui.setLoading(true, 'fetching the archive', 0.5);
    const loading = document.getElementById('loading')!;
    expect(loading.hidden).toBe(false);
    expect(loading.closest('#panel')).toBeNull();
    expect(document.getElementById('loading-what')!.textContent).toBe('fetching the archive 50%');
  });
});

describe('the Controls popover', () => {
  let ui: Ui;
  const tab = (): HTMLElement => document.getElementById('controls-toggle')!;
  const pop = (): HTMLElement => document.getElementById('controls')!;
  const fire = (el: EventTarget, type: string, extra: Record<string, unknown> = {}): void => {
    const e = new Event(type, { bubbles: type !== 'pointerenter' && type !== 'pointerleave' });
    Object.assign(e, extra);
    el.dispatchEvent(e);
  };
  beforeEach(() => { vi.useFakeTimers(); load(); ui = new Ui(); ui.onControlsPopover(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is closed to start with, and the tab says so', () => {
    expect(pop().hidden).toBe(true);
    expect(tab().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens while a mouse is over the tab, and closes a moment after it leaves', () => {
    fire(tab(), 'pointerenter', { pointerType: 'mouse' });
    expect(pop().hidden).toBe(false);
    expect(tab().getAttribute('aria-expanded')).toBe('true');
    fire(tab(), 'pointerleave', { pointerType: 'mouse' });
    expect(pop().hidden).toBe(false);                               // the grace, to cross the gap
    vi.advanceTimersByTime(POPOVER_GRACE_MS + 1);
    expect(pop().hidden).toBe(true);
    expect(tab().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open while the pointer is on the popover itself, and coming back in cancels the close', () => {
    fire(tab(), 'pointerenter', { pointerType: 'mouse' });
    fire(tab(), 'pointerleave', { pointerType: 'mouse' });
    fire(pop(), 'pointerenter', { pointerType: 'mouse' });
    vi.advanceTimersByTime(POPOVER_GRACE_MS * 5);
    expect(pop().hidden).toBe(false);
    fire(pop(), 'pointerleave', { pointerType: 'mouse' });
    vi.advanceTimersByTime(POPOVER_GRACE_MS + 1);
    expect(pop().hidden).toBe(true);
  });

  it('a touch has no hover: only a tap opens it, and a second tap closes it', () => {
    fire(tab(), 'pointerenter', { pointerType: 'touch' });
    expect(pop().hidden).toBe(true);
    tab().click();
    expect(pop().hidden).toBe(false);
    fire(tab(), 'pointerleave', { pointerType: 'touch' });
    vi.advanceTimersByTime(POPOVER_GRACE_MS * 3);
    expect(pop().hidden).toBe(false);                               // pinned by the tap
    tab().click();
    expect(pop().hidden).toBe(true);
  });

  it('a click pins it past the pointer leaving; Esc closes it however it was held', () => {
    fire(tab(), 'pointerenter', { pointerType: 'mouse' });
    tab().click();
    fire(tab(), 'pointerleave', { pointerType: 'mouse' });
    vi.advanceTimersByTime(POPOVER_GRACE_MS * 3);
    expect(pop().hidden).toBe(false);
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    expect(pop().hidden).toBe(true);
    expect(tab().getAttribute('aria-expanded')).toBe('false');
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));   // nothing open: nothing to do
    expect(pop().hidden).toBe(true);
  });

  it('a press outside closes a pinned one, and a press inside does not', () => {
    tab().click();
    fire(pop(), 'pointerdown');
    expect(pop().hidden).toBe(false);
    fire(document.getElementById('view')!, 'pointerdown');
    expect(pop().hidden).toBe(true);
  });

  it('opens on a keyboard focus and closes when the focus leaves', () => {
    tab().matches = ((sel: string) => sel === ':focus-visible') as Element['matches'];
    fire(tab(), 'focusin');
    expect(pop().hidden).toBe(false);
    fire(tab(), 'focusout', { relatedTarget: null });
    expect(pop().hidden).toBe(true);
  });

  it('never takes the focus: opening it moves nothing', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    fire(tab(), 'pointerenter', { pointerType: 'mouse' });
    tab().click();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('holds the hint and both lists, and a pad connecting shows the Controller list', () => {
    expect(pop().contains(document.getElementById('hint'))).toBe(true);
    expect(pop().contains(document.getElementById('pad-list'))).toBe(true);
    ui.setPadConnected(true);
    expect(document.getElementById('controls-pad')!.hidden).toBe(false);
  });
});
