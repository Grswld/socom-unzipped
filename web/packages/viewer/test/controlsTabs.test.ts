import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chooseTab, CONTROLS_TAB_KEY, controlGroups, padControlGroups } from '../src/controlsList';
import { Ui } from '../src/ui';

/**
 * The Controls popover, simplified (owner, 2026-09-29): two tabs, Controller and Mouse & Keyboard, each the action and
 * its button or key and nothing else; the chosen tab remembered, and a first visit on the Controller tab when a pad is
 * connected.
 */
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
/** Words a player's list has no business carrying: sources, research, decomp names, debug and stub notes. */
const DEVELOPER = /research|decomp|FUN_|0x|\.md|\.ts|\.cpp|\.h\b|stub|reading|assumed|placeholder|owner|debug|§/i;

const rows = (groups: ReturnType<typeof controlGroups>): string[] => groups.flatMap((g) => g.rows.map((r) => `${r.keys} = ${r.does}`));

describe('the lists', () => {
  it('Controller, walking: the player\'s actions, reload on R3', () => {
    const all = rows(padControlGroups('walk', true)).join(' | ');
    for (const want of ['Left stick = move', 'Right stick = look', 'Square = jump', 'R1 = fire', 'R3 = reload', 'Triangle', 'Cross', 'L1', 'L2', 'R2', 'Select', 'Start']) {
      expect(all, want).toContain(want);
    }
    expect(all).toMatch(/zoom/);
    expect(all).toMatch(/peek/);
    expect(all).toMatch(/door/);
    expect(all).toMatch(/scoreboard/);
  });

  it('Mouse & Keyboard, walking: weapons 1 to 4, reload on R, the action on X', () => {
    const all = rows(controlGroups('walk', true)).join(' | ');
    for (const want of ['W A S D = move', 'Space = jump', 'R = reload', 'C', 'X', 'Q / E', '1 = ', '2 = ', '3 / 4 = ', 'Tab']) expect(all, want).toContain(want);
    expect(all).toMatch(/fire/);
    expect(all).toMatch(/zoom/);
    expect(all).toMatch(/grenade/);
  });

  it('carries no developer notes, no sources and no debug keys, in any mode', () => {
    for (const mode of ['walk', 'fly'] as const) for (const play of [true, false]) {
      for (const text of [...rows(controlGroups(mode, play)), ...rows(padControlGroups(mode, play))]) expect(text).not.toMatch(DEVELOPER);
    }
  });

  it('the map viewer lists no walk: no G, no Start, no jump', () => {
    const keys = rows(controlGroups('fly', false)).join(' | ');
    const pad = rows(padControlGroups('fly', false)).join(' | ');
    expect(keys).not.toMatch(/^G =| G =/);
    expect(pad).not.toMatch(/Start/);
    expect(pad).toMatch(/Left stick = fly/);
  });

  it('marks the face buttons with their glyphs', () => {
    const face = padControlGroups('walk', true).flatMap((g) => g.rows).filter((r) => r.glyph);
    expect(face.map((r) => r.glyph).sort()).toEqual(['cross', 'square', 'triangle']);
  });
});

describe('chooseTab', () => {
  it('the remembered tab wins', () => {
    expect(chooseTab('keys', true)).toBe('keys');
    expect(chooseTab('pad', false)).toBe('pad');
  });
  it('without one, the Controller tab when a pad is connected, else Mouse & Keyboard', () => {
    expect(chooseTab(null, true)).toBe('pad');
    expect(chooseTab(null, false)).toBe('keys');
    expect(chooseTab('nonsense', false)).toBe('keys');
  });
});

describe('the popover', () => {
  let ui: Ui;
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    ui = new Ui();
    ui.onControlsPopover();
  });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  const tab = (which: 'pad' | 'keys'): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`#controls-tabs [data-tab="${which}"]`)!;
  const panel = (which: 'pad' | 'keys'): HTMLElement => document.getElementById(which === 'pad' ? 'controls-pad' : 'controls-keys')!;

  it('has two system tabs, Controller then Mouse & Keyboard, each over its own panel', () => {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('#controls-tabs button')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Controller', 'Mouse & Keyboard']);
    for (const t of tabs) {
      expect(t.classList.contains('s2u-tab')).toBe(true);
      expect(t.getAttribute('role')).toBe('tab');
    }
    expect(document.getElementById('controls-tabs')!.classList.contains('s2u-tabs')).toBe(true);
    expect(document.getElementById('controls-tabs')!.getAttribute('role')).toBe('tablist');
    expect(panel('pad').getAttribute('role')).toBe('tabpanel');
    expect(panel('keys').getAttribute('role')).toBe('tabpanel');
  });

  it('opens on Mouse & Keyboard with no pad and nothing remembered', () => {
    expect(tab('keys').getAttribute('aria-selected')).toBe('true');
    expect(tab('pad').getAttribute('aria-selected')).toBe('false');
    expect(panel('keys').hidden).toBe(false);
    expect(panel('pad').hidden).toBe(true);
  });

  it('a pad connecting moves an unchosen popover to Controller; a choice made stays', () => {
    ui.setPadConnected(true);
    expect(tab('pad').getAttribute('aria-selected')).toBe('true');
    expect(panel('pad').hidden).toBe(false);
    tab('keys').click();
    expect(localStorage.getItem(CONTROLS_TAB_KEY)).toBe('keys');
    ui.setPadConnected(false);
    ui.setPadConnected(true);
    expect(tab('keys').getAttribute('aria-selected')).toBe('true');
  });

  it('remembers the tab chosen for the next visit', () => {
    tab('pad').click();
    expect(localStorage.getItem(CONTROLS_TAB_KEY)).toBe('pad');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    const next = new Ui();
    next.onControlsPopover();
    expect(tab('pad').getAttribute('aria-selected')).toBe('true');
    expect(panel('pad').hidden).toBe(false);
  });

  it('a storage that throws changes nothing but the memory', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => tab('pad').click()).not.toThrow();
    expect(tab('pad').getAttribute('aria-selected')).toBe('true');
  });

  it('lists the controller\'s rows in the Controller panel and the keys in the other, walking and flying', () => {
    const text = (id: string): string => document.getElementById(id)!.textContent ?? '';
    ui.setWalk(true);
    expect(text('pad-list')).toContain('R3');
    expect(text('pad-list')).toContain('reload');
    expect(text('keys-list')).toContain('reload');
    expect(`${text('pad-list')} ${text('keys-list')}`).not.toMatch(DEVELOPER);
    expect(document.querySelector('#pad-list svg.s2u-hint__glyph--square')).not.toBeNull();
    ui.setWalk(false);
    expect(text('pad-list')).not.toContain('R1');
  });

  it('says whether a controller is connected, on the Controller panel', () => {
    const status = document.getElementById('pad-status')!;
    expect(status.textContent).toMatch(/no controller/i);
    ui.setPadConnected(true);
    expect(status.textContent).toMatch(/connected/i);
    expect(status.textContent).not.toMatch(/no controller/i);
  });
});
