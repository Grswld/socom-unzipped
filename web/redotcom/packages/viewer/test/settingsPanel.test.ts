import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PlayUi } from '../src/features';
import { Ui } from '../src/ui';

/**
 * The settings panel's polish pass (owner, 2026-09-29: "Give the full settings panel another polish pass for usability
 * and readability"): sections in the order a player reaches for them, each with a heading and at most a line of plain
 * help, one control type per kind of setting, the defaults said, every control named and reachable by the keyboard in
 * the order it is drawn, and 44 px touch targets. Behaviour and persistence are the other tests' (features, modes,
 * online, shareUrl); this pins the shape.
 */
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const css = readFileSync(resolve(here, '../src/styles.css'), 'utf-8');
const load = (): void => { document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML; };
const panel = (): HTMLElement => document.getElementById('panel-body')!;

describe('the settings panel: order and headings', () => {
  beforeEach(load);

  it('reads Mode, Map, Picture, Mouse look, Sound, Online, then Advanced, the notice and About', () => {
    const order = [...panel().children].map((e) => e.id).filter(Boolean);
    expect(order).toEqual(['panel-kicker', 'recom-section', 'map-section', 'view-section', 'look-section', 'sound-section', 'mp-section', 'advanced', 'warning', 'about']);
  });

  it('each section is a named region: a heading the section points at, in the system\'s field label', () => {
    for (const section of panel().querySelectorAll<HTMLElement>(':scope > section')) {
      const heading = document.getElementById(section.getAttribute('aria-labelledby') ?? '');
      expect(heading, section.id).not.toBeNull();
      expect(heading!.classList.contains('s2u-field__label'), section.id).toBe(true);
      expect(section.contains(heading), section.id).toBe(true);
      expect(heading!.textContent!.trim().length, section.id).toBeGreaterThan(0);
    }
    const names = [...panel().querySelectorAll(':scope > section')].map((s) => document.getElementById(s.getAttribute('aria-labelledby')!)!.textContent);
    expect(names).toEqual(['Mode', 'Map', 'Picture', 'Mouse look', 'Sound', 'Online']);
  });

  it('the help lines are short and plain: one sentence or two, no research references, dates or file names', () => {
    const notes = [...panel().querySelectorAll<HTMLElement>(':scope > section .s2u-field__note')];
    expect(notes.length).toBeGreaterThanOrEqual(5);
    for (const n of notes) expect(n.textContent!.length, n.id).toBeLessThanOrEqual(90);
    // Everything a player reads outside Advanced (text, tooltips), in plain words.
    const words = [...panel().querySelectorAll(':scope > section')].map((s) => `${s.textContent} ${[...s.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).join(' ')}`).join(' ');
    expect(words).not.toMatch(/research|\bW\d\.\w+|FUN_|0x[0-9a-f]{3,}|owner,? 20\d\d|\.rdr\b|\.ZAR\b|\bGS\b|VU1|FIX\b/i);
  });
});

describe('the settings panel: one control per kind, named, defaults said', () => {
  beforeEach(load);

  it('every few-options choice is a segmented switch named by its heading and described by its help line', () => {
    for (const id of ['recom', 'look', 'mouselaw', 'online']) {
      const g = document.getElementById(id)!;
      expect(g.getAttribute('role'), id).toBe('group');
      const label = document.getElementById(g.getAttribute('aria-labelledby') ?? '');
      expect(label?.classList.contains('s2u-field__label'), id).toBe(true);
      const note = document.getElementById(g.getAttribute('aria-describedby') ?? '');
      expect(note?.classList.contains('s2u-field__note'), id).toBe(true);
    }
  });

  it('each switch says which option is the default, and the markup presses it', () => {
    for (const id of ['recom', 'look', 'mouselaw', 'online']) {
      const pressed = document.querySelector<HTMLElement>(`#${id} [aria-pressed="true"]`)!;
      expect(pressed.getAttribute('title'), id).toMatch(/The default\./);
      const others = [...document.querySelectorAll<HTMLElement>(`#${id} [aria-pressed="false"]`)];
      for (const o of others) expect(o.getAttribute('title'), id).not.toMatch(/The default/);
    }
  });

  it('every amount is a slider with its value beside it, and every on / off a switch-drawn checkbox', () => {
    for (const id of ['sensitivity', 'volume']) {
      const input = document.getElementById(id) as HTMLInputElement;
      expect(input.type).toBe('range');
      expect(input.closest('label')!.classList.contains('s2u-range'), id).toBe(true);
      expect(document.querySelector(`output[for="${id}"]`), id).not.toBeNull();
    }
    for (const id of ['mute', 'invertpitch', 'uniformpitch']) {
      expect((document.getElementById(id) as HTMLInputElement).type).toBe('checkbox');
      expect(document.getElementById(id)!.closest('label')!.classList.contains('s2u-check'), id).toBe(true);
    }
  });

  it('the name is a system field with its own label and help', () => {
    const name = document.getElementById('mp-name') as HTMLInputElement;
    const field = name.closest('.s2u-field')!;
    expect(field).not.toBeNull();
    expect(field.querySelector('label.s2u-field__label[for="mp-name"]')!.textContent).toBe('Your name');
    expect(document.getElementById(name.getAttribute('aria-describedby')!)!.classList.contains('s2u-field__note')).toBe(true);
    expect(name.maxLength).toBe(30);
  });

  it('every control a player can reach has a name', () => {
    const named = (el: Element): boolean => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
      if (el.closest('label')) return true;
      return (el.textContent ?? '').trim().length > 0;
    };
    for (const el of panel().querySelectorAll('button, select, input:not([hidden]), summary')) expect(named(el), el.outerHTML.slice(0, 80)).toBe(true);
  });
});

describe('the settings panel: keyboard', () => {
  beforeEach(load);

  it('nothing takes a place of its own in the Tab order: the focus follows the page, top to bottom', () => {
    expect([...panel().querySelectorAll('[tabindex]')].filter((e) => Number(e.getAttribute('tabindex')) > 0)).toHaveLength(0);
  });

  it('every switch option is a real button (Enter and Space press it), and a pressed one is the Ui\'s state', () => {
    const ui = new Ui();
    const heard: boolean[] = [];
    ui.onRecomSwitch((on) => heard.push(on));
    const play = document.querySelector<HTMLButtonElement>('#recom [data-recom="on"]')!;
    expect(play.tagName).toBe('BUTTON');
    expect(play.type).toBe('button');
    play.click();                                                  // what Enter and Space do to a button
    expect(heard).toEqual([true]);
  });

  it('the focus ring shows inside the panel\'s clipped edge', () => {
    expect(css).toMatch(/#panel :focus-visible\s*{[^}]*outline-offset:\s*-2px/);
    expect(css).toMatch(/#disc:focus-within\s*{[^}]*outline:\s*2px solid var\(--s2u-focus\)/);
  });
});

describe('the settings panel: touch and narrow screens', () => {
  it('on a touch screen every panel and popover control is at least 44 px tall, and the bar tabs take a 44 px touch band', () => {
    const coarse = css.match(/@media \(pointer: coarse\) {\s*#panel \.s2u-tab[\s\S]*?\n}/)![0];
    for (const sel of ['#panel .s2u-tab', '#controls .s2u-tab', '#panel .s2u-check', '#panel .s2u-range', '#panel .s2u-disclosure > summary', '#panel .s2u-field select', '#panel .s2u-field input', '#disc']) {
      expect(coarse, sel).toContain(sel);
    }
    expect(coarse).toMatch(/min-height:\s*44px/);
    expect(coarse).toMatch(/\.s2u-bar__end \.s2u-tab::after\s*{[^}]*top:\s*-7px;[^}]*bottom:\s*-7px/);   // 30 + 7 + 7
    expect(coarse).toMatch(/#mobile-tip \.s2u-iconbtn\s*{[^}]*width:\s*44px;\s*height:\s*44px/);
  });

  it('a segment and a section may shrink rather than push the panel wider (no truncation, no sideways scroll)', () => {
    expect(css).toMatch(/\.section\s*{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.s2u-overlay \.s2u-tabs\[role="group"\] \.s2u-tab\s*{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('on Explore the Play sections leave and the panel still reads in order', () => {
    load();
    new PlayUi().detach();
    const order = [...panel().children].map((e) => e.id).filter(Boolean);
    expect(order).toEqual(['panel-kicker', 'recom-section', 'map-section', 'view-section', 'mp-section', 'advanced', 'warning', 'about']);
  });
});
