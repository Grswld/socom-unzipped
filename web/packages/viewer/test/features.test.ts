import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PAD_LAYOUT } from '../src/gamepad';
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
    expect(words.match(/.{0,40}\b(walk\w*|stance|crouch\w*|prone|redotcom)\b.{0,40}/gi)).toBeNull();
  });

  describe('the Ui over that page', () => {
    let ui: Ui;
    beforeEach(() => { removePlayUi(); ui = new Ui(); });

    it('builds without the play elements, and its setters do nothing to them', () => {
      expect(() => { ui.setWalk(true); ui.setWalk(false); ui.onWalkSwitch(() => undefined); }).not.toThrow();
      expect(ui.toggles().body).toBe(false);
    });

    it('the hint line and the pad table list the fly camera alone, and no walk, no Start', () => {
      ui.setCameraHint(1, false);
      const hint = document.getElementById('hint')!.textContent!;
      expect(hint).toBe('click to look · WASD fly · space/shift up/down · double-tap W to boost · wheel speed 1.0× · arrows look · F fullscreen · ` hides this');
      expect(hint).not.toMatch(/walk|jump|stance|fire|reload/i);
      ui.showPadLayout(PAD_LAYOUT);
      const rows = [...document.querySelectorAll('#pad-layout tbody tr')].map((r) => r.querySelector('td')!.textContent);
      expect(rows).toEqual(['L-stick', 'R-stick', 'Square', 'Triangle', 'R3']);
    });
  });
});

describe('the page with the play on', () => {
  it('keeps the play markup, and the hint has G walk', () => {
    load();
    const ui = new Ui();
    expect(document.getElementById('mode')).not.toBeNull();
    expect(document.getElementById('hint')!.textContent).toMatch(/ · G walk · F fullscreen/);
    ui.setWalk(true);
    expect(document.getElementById('hint')!.textContent).toMatch(/G fly/);
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

  it('holds the hint and, once a pad is connected, the layout table, each for the current mode', () => {
    expect(pop().contains(document.getElementById('hint'))).toBe(true);
    expect(pop().contains(document.getElementById('pad-box'))).toBe(true);
    ui.showPadLayout(PAD_LAYOUT);
    expect(document.getElementById('pad-box')!.hidden).toBe(false);
  });
});
