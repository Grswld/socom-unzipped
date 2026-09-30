import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  PLAY_ATTRIBUTE, PLAY_KEY, PlayUi, readPlayChoice, writePlayChoice,
} from '../src/features';
import { Ui } from '../src/ui';

/**
 * The owner's 2026-09-29 settings: the Mode switch (Explore / Play, at run time, remembered; the address's `mode=play` /
 * `mode=explore` beats the memory -- `./shareUrl`, pinned in shareUrl.test.ts; no flag gates it, "&redotcom can die now"),
 * the Online setting's markup, and the disc page the page opens on without `?devmode`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const load = (): void => { document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML; };
const keys = (): string => [...document.querySelectorAll('#keys-list tbody tr')].map((r) => r.textContent).join(' | ');

describe('the remembered mode', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('is written as 1 or 0 under s2u.viewer.recom and read back', () => {
    expect(readPlayChoice()).toBeNull();
    writePlayChoice(true);
    expect(localStorage.getItem(PLAY_KEY)).toBe('1');
    expect(readPlayChoice()).toBe('1');
    writePlayChoice(false);
    expect(localStorage.getItem('s2u.viewer.recom')).toBe('0');
    expect(readPlayChoice()).toBe('0');
  });

  it('survives a storage that throws', () => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('private window'); };
    Storage.prototype.setItem = () => { throw new Error('private window'); };
    try {
      expect(readPlayChoice()).toBeNull();
      expect(() => writePlayChoice(true)).not.toThrow();
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
  });
});

describe('PlayUi: the play markup out and back in, at run time', () => {
  beforeEach(load);

  it('takes every data-play element out and puts the same nodes back where they were', () => {
    const before = [...document.querySelectorAll(`[${PLAY_ATTRIBUTE}]`)];
    const places = before.map((el) => [el.parentElement, el.nextSibling]);
    const ui = new PlayUi();
    expect(ui.shown()).toBe(true);
    expect(ui.detach()).toBeGreaterThanOrEqual(5);
    expect(ui.shown()).toBe(false);
    expect(document.querySelectorAll(`[${PLAY_ATTRIBUTE}]`)).toHaveLength(0);
    for (const id of ['mode', 'walk', 'body-row', 'sound-section', 'look-section', 'touch-stance', 'touch-fire', 'touch-walk']) {
      expect(document.getElementById(id), id).toBeNull();
    }
    expect(ui.detach()).toBe(0);                                  // nothing twice
    ui.attach();
    expect(ui.shown()).toBe(true);
    const after = [...document.querySelectorAll(`[${PLAY_ATTRIBUTE}]`)];
    expect(after).toEqual(before);                                 // the same nodes, in the same order
    after.forEach((el, i) => { expect(el.parentElement).toBe(places[i]![0]); expect(el.nextSibling).toBe(places[i]![1]); });
    expect(document.body.innerHTML).not.toMatch(/<!--data-play-->/);
  });

  it('keeps what was wired while the markup was on the page: a listener still fires after a round trip', () => {
    const ui = new PlayUi();
    let heard = 0;
    document.getElementById('mute')!.addEventListener('change', () => { heard++; });
    ui.set(false);
    ui.set(true);
    document.getElementById('mute')!.dispatchEvent(new Event('change'));
    expect(heard).toBe(1);
  });

  it('the panel kicker says redotcom, the product name, in both modes (owner ruling, handoff s3; do not flip it again)', () => {
    const kicker = (): string | null | undefined => document.getElementById('panel-kicker')?.textContent;
    expect(kicker()).toBe('redotcom · SOCOM II multiplayer');
    const ui = new PlayUi();
    ui.detach();
    expect(kicker()).toMatch(/^redotcom /);
  });

  it('with the markup out, no word about walking is left in the page text or tooltips (the mode and online switches included)', () => {
    new PlayUi().detach();
    const words = (document.body.textContent ?? '') + [...document.querySelectorAll('[title],[aria-label]')]
      .map((e) => `${e.getAttribute('title')} ${e.getAttribute('aria-label')}`).join(' ');
    expect(words.match(/.{0,40}\b(walk\w*|stance|crouch\w*|prone|devmode)\b.{0,40}/gi)).toBeNull();
  });
});

describe('the Mode switch in the panel', () => {
  let ui: Ui;
  beforeEach(() => { load(); ui = new Ui(); });

  it('is always there: no flag gates it (owner, 2026-09-29: "&redotcom can die now. The mode replaces it")', () => {
    const src = (f: string): string => readFileSync(resolve(here, f), 'utf-8');
    // The page builds the same markup for every address; nothing reads a feature flag before it.
    expect(document.getElementById('recom')).not.toBeNull();
    for (const f of ['../src/main.ts', '../src/features.ts', '../src/ui.ts']) {
      expect(src(f), f).not.toMatch(/playEnabled|PLAY_PARAM|\.has\(['"]redotcom['"]\)|get\(['"]redotcom['"]\)/);
    }
    // With the play's markup out (Explore) the switch stays, and offers Play.
    new PlayUi().detach();
    expect(document.querySelector('#recom [data-recom="on"]')).not.toBeNull();
    expect(document.querySelector('#recom [data-recom="off"]')).not.toBeNull();
  });

  it('the Play-only settings follow the mode: in on Play, out on Explore, the rest stays', () => {
    const play = new PlayUi();
    const PLAY_ONLY = ['sound-section', 'look-section', 'body-row'];
    const ALWAYS = ['recom', 'look', 'online', 'maps', 'advanced'];
    play.set(false);
    for (const id of PLAY_ONLY) expect(document.getElementById(id), id).toBeNull();
    for (const id of ALWAYS) expect(document.getElementById(id), id).not.toBeNull();
    play.set(true);
    for (const id of [...PLAY_ONLY, ...ALWAYS]) expect(document.getElementById(id), id).not.toBeNull();
  });

  it('is the picture switch markup, in the panel, not the play (it is there in both modes)', () => {
    const recom = document.getElementById('recom')!;
    expect(recom.className).toBe(document.getElementById('look')!.className);
    expect(recom.getAttribute('role')).toBe('group');
    expect(recom.closest('#panel')).not.toBeNull();
    expect(recom.closest(`[${PLAY_ATTRIBUTE}]`)).toBeNull();
    const buttons = [...recom.querySelectorAll('button')];
    expect(buttons.map((b) => b.dataset['recom'])).toEqual(['off', 'on']);
    for (const b of buttons) { expect(b.classList.contains('s2u-tab')).toBe(true); expect(b.querySelector('.s2u-tab__what')).not.toBeNull(); }
    expect(buttons.map((b) => b.firstChild!.textContent)).toEqual(['Explore', 'Play']);
  });

  it('hands the visitor choice on once, and shows it', () => {
    const heard: boolean[] = [];
    ui.onRecomSwitch((on) => heard.push(on));
    const on = document.querySelector<HTMLButtonElement>('#recom [data-recom="on"]')!;
    const off = document.querySelector<HTMLButtonElement>('#recom [data-recom="off"]')!;
    off.click();                                                  // already chosen: nothing
    on.click();
    on.click();
    expect(heard).toEqual([true]);
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(off.getAttribute('aria-pressed')).toBe('false');
    off.click();
    expect(heard).toEqual([true, false]);
    ui.setRecom(true);
    expect(on.getAttribute('aria-pressed')).toBe('true');
  });

  it('the Controls popover follows the mode: G walk listed only with the play on the page (and the developer toggle)', () => {
    ui.setFlyToggle(true);
    const play = new PlayUi();
    play.detach(); ui.setPlay(false);
    expect(keys()).not.toMatch(/walk/i);
    play.attach(); ui.setPlay(true);
    expect(keys()).toMatch(/Gwalk/);
    play.detach(); ui.setPlay(false);
    expect(keys()).not.toMatch(/Gwalk/);
  });
});

describe('the Online setting in the panel', () => {
  let ui: Ui;
  beforeEach(() => { load(); ui = new Ui(); });

  it('is Off / Shared / Local in the picture switch markup, with a connection line, outside the play', () => {
    const online = document.getElementById('online')!;
    expect(online.className).toBe(document.getElementById('look')!.className);
    expect(online.getAttribute('role')).toBe('group');
    expect([...online.querySelectorAll('button')].map((b) => b.dataset['online'])).toEqual(['off', 'shared', 'local']);
    expect(online.closest(`[${PLAY_ATTRIBUTE}]`)).toBeNull();
    expect(document.getElementById('mp-name')!.closest(`[${PLAY_ATTRIBUTE}]`)).toBeNull();
    expect(document.getElementById('online-lamp')!.classList.contains('s2u-lamp')).toBe(true);
    expect(document.getElementById('online-state')!.classList.contains('s2u-status')).toBe(true);
  });

  it('hands a new choice on, shows it, and a URL server presses none', () => {
    const heard: string[] = [];
    ui.onOnline((c) => heard.push(c));
    const button = (c: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`#online [data-online="${c}"]`)!;
    button('off').click();
    button('local').click();
    button('shared').click();
    expect(heard).toEqual(['local', 'shared']);
    expect(button('shared').getAttribute('aria-pressed')).toBe('true');
    expect(button('local').getAttribute('aria-pressed')).toBe('false');
    ui.setOnline('url');
    expect([...document.querySelectorAll('#online [aria-pressed="true"]')]).toHaveLength(0);
  });

  it('writes the connection line and lights the lamp up or down', () => {
    const lamp = document.getElementById('online-lamp')!;
    ui.setOnlineState('online · 3 players', 'up');
    expect(document.getElementById('online-text')!.textContent).toBe('online · 3 players');
    expect(lamp.classList.contains('is-up')).toBe(true);
    ui.setOnlineState('server unreachable · retrying in 4 s', 'down');
    expect(lamp.classList.contains('is-up')).toBe(false);
    expect(lamp.classList.contains('is-down')).toBe(true);
    ui.setOnlineState('single player: no server', null);
    expect(lamp.className).toBe('s2u-lamp s2u-lamp--small');
  });
});

describe('the disc page (no served assets by default)', () => {
  let ui: Ui;
  beforeEach(() => { load(); ui = new Ui(); document.body.classList.remove('no-served', 'disc-over'); });

  it('is hidden in the markup, outside the panel, on the design system, and says what it needs and that nothing is uploaded', () => {
    const page = document.getElementById('disc-page')!;
    expect(page.hidden).toBe(true);
    expect(page.closest('#panel')).toBeNull();
    expect(page.classList.contains('s2u-section')).toBe(true);
    expect(page.querySelector('.s2u-title')).not.toBeNull();
    expect(page.querySelector('.s2u-card')).not.toBeNull();
    expect(page.querySelector('.s2u-notice')).not.toBeNull();
    const text = page.textContent!.replace(/\s+/g, ' ');
    expect(text).toMatch(/your own copy of the disc/);
    expect(text).toMatch(/SCUS-97275/);
    expect(text).toMatch(/\.iso/);
    expect(text).toMatch(/Drop the \.iso anywhere on this window/);
    expect(text).toMatch(/Nothing is uploaded/);
    expect(text).toMatch(/2352-byte sectors is refused/);
    const input = page.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.id).toBe('disc-page-file');
    expect(input.accept).toBe('.iso');
    expect(input.closest('label')!.classList.contains('s2u-tab')).toBe(true);
  });

  it('offerDisc shows it without unfolding the panel; hideDiscPage takes it down', () => {
    ui.onPanelToggle();
    ui.offerDisc();
    expect(ui.discPageShown()).toBe(true);
    expect(document.body.classList.contains('no-served')).toBe(true);
    expect(ui.panelCollapsed()).toBe(true);
    ui.hideDiscPage();
    expect(ui.discPageShown()).toBe(false);
    expect(document.body.classList.contains('no-served')).toBe(false);
  });

  it('its line says reading, or the reader words in the error colour', () => {
    ui.setDiscState('reading the disc image a.iso ...');
    const line = document.getElementById('disc-state')!;
    expect(line.textContent).toBe('reading the disc image a.iso ...');
    expect(line.classList.contains('is-bad')).toBe(false);
    ui.setDiscState('not an ISO9660 image', 'error');
    expect(line.classList.contains('is-bad')).toBe(true);
  });

  it('the whole window is the drop target: a drag over lights it, a drop hands the file on, and its button does too', () => {
    const files: string[] = [];
    ui.onDisc((f) => files.push(f.name));
    const file = new File([new Uint8Array(8)], 'SOCOM2.iso');
    const transfer = { types: ['Files'], files: [file], dropEffect: 'none' };
    const drag = (type: string): Event => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { dataTransfer: transfer, relatedTarget: null }); return e; };
    const over = drag('dragover');
    document.getElementById('view')!.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(document.body.classList.contains('disc-over')).toBe(true);
    const drop = drag('drop');
    document.getElementById('disc-title')!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(document.body.classList.contains('disc-over')).toBe(false);
    const input = document.getElementById('disc-page-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(8)], 'picked.iso')], configurable: true });
    input.dispatchEvent(new Event('change'));
    expect(files).toEqual(['SOCOM2.iso', 'picked.iso']);
  });

  it('the stylesheet lights it while a file is over the window and clears the chrome over it, in tokens', () => {
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf-8');
    expect(css).toMatch(/body\.disc-over #disc-page\s*{[^}]*var\(--s2u-gold\)/);
    expect(css).toMatch(/#disc-page\[hidden\]\s*{\s*display:\s*none/);
    expect(css).toMatch(/body\.no-served #fps, body\.no-served #fullscreen, body\.no-served #touch\s*{\s*display:\s*none/);
  });
});
