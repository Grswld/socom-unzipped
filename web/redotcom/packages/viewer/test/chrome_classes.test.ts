import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const css = readFileSync(resolve(here, '../src/styles.css'), 'utf-8');
const ui = readFileSync(resolve(here, '../src/ui.ts'), 'utf-8');
const doc = new JSDOM(html).window.document;
/**
 * The viewer's own classes: layout helpers of the panel and the body's state flags (`./src/ui.ts`, `./src/touch.ts`,
 * `./src/main.ts`), which the system has no word for. Anything else on the page is the system's or an `is-*` state.
 */
const OWN = ['row', 'checks', 'section', 'touch-lift', 'ps2-look', 'chrome-hidden', 'touch', 'panel-collapsed',
  'no-served', 'disc-over', 'pad-on', 'tip-on', 'pad-group'];
const SRC = resolve(here, '../src');
const tsSources = (): { file: string; text: string }[] => [...readdirSync(SRC), ...readdirSync(resolve(SRC, 'net')).map((f) => `net/${f}`)]
  .filter((f) => f.endsWith('.ts')).map((f) => ({ file: f, text: readFileSync(resolve(SRC, f), 'utf-8') }));
const DS_SELECTORS = readFileSync(resolve(here, '../../../../shared/ds/components.css'), 'utf-8') + readFileSync(resolve(here, '../../../../shared/ds/base.css'), 'utf-8');
/** Each rule of a stylesheet (comments out): its selector and its declarations. Innermost blocks, so @media bodies' rules. */
function rules(sheet: string): { selector: string; decls: [string, string][] }[] {
  const out: { selector: string; decls: [string, string][] }[] = [];
  for (const m of sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*){([^{}]*)}/g)) {
    const decls = m[2]!.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const at = d.indexOf(':');
      return [d.slice(0, at).trim(), d.slice(at + 1).trim()] as [string, string];
    });
    out.push({ selector: m[1]!.trim(), decls });
  }
  return out;
}

describe('the viewer chrome uses the design system', () => {
  it('links the shared system once (web/shared/ds, aliased as /src/ds/), before styles.css', () => {
    const links = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
    expect(links).toEqual(['/src/ds/index.css', './src/styles.css']);
    expect(html).not.toMatch(/googleapis|gstatic/);
  });
  it.each([
    ['site-links', 's2u-bar'], ['panel', 's2u-overlay'], ['panel-toggle', 's2u-tab--nav'], ['controls-toggle', 's2u-tab--nav'], ['controls', 's2u-overlay'], ['panel-body', 's2u-overlay__body'],
    ['fps', 's2u-status--pill'], ['fullscreen', 's2u-fab'], ['loading', 's2u-loading'], ['loading-bar', 's2u-loading__bar'],
    ['loading-what', 's2u-status'], ['status', 's2u-status'], ['diagnostics', 's2u-status'], ['warning', 's2u-notice--warn'],
    ['about', 's2u-disclosure'], ['advanced', 's2u-disclosure'], ['fog-box', 's2u-disclosure'], ['sliders-box', 's2u-disclosure'],
    ['diagnostics-box', 's2u-disclosure'], ['disc', 's2u-label'],
    ['revision-line', 's2u-fine'], ['revision', 's2u-label--warn'], ['home', 's2u-bar__brand'], ['source', 's2u-tab--nav'],
  ])('#%s carries %s', (id, cls) => {
    const el = doc.getElementById(id);
    expect(el, id).not.toBeNull();
    expect(el!.classList.contains(cls), `${id} lacks ${cls}`).toBe(true);
  });
  it('the map select sits in an s2u-field with a label', () => {
    const sel = doc.getElementById('maps')!;
    expect(sel.parentElement!.classList.contains('s2u-field')).toBe(true);
    expect(sel.parentElement!.querySelector('label.s2u-field__label[for="maps"]')).not.toBeNull();
  });
  it('the look tabs are s2u-tabs of s2u-tab with a __what caption', () => {
    expect(doc.getElementById('look')!.classList.contains('s2u-tabs')).toBe(true);
    for (const b of doc.querySelectorAll('#look button')) {
      expect(b.classList.contains('s2u-tab')).toBe(true);
      expect(b.querySelector('.s2u-tab__what')).not.toBeNull();
    }
  });
  it('checkboxes, ranges and the colour input wear the system classes', () => {
    for (const l of doc.querySelectorAll('#panel label')) {
      const input = l.querySelector('input');
      if (!input) continue;
      const want = input.type === 'checkbox' ? 's2u-check' : input.type === 'range' ? 's2u-range' : input.type === 'color' ? 's2u-colour' : null;
      if (want) expect(l.classList.contains(want), l.textContent ?? '').toBe(true);
    }
  });
  /** whether the system's stylesheets carry `.cls` as a whole token: `.s2u-tab` is not found in `.s2u-tabs` */
  const declares = (selectors: string, cls: string): boolean =>
    new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w-])`).test(selectors);
  it('every class on the page is a system class, a state, or the viewer’s own (whole tokens)', () => {
    const selectors = DS_SELECTORS;
    const bad = new Set<string>();
    for (const el of doc.querySelectorAll('[class]')) for (const c of el.classList)
      if (!c.startsWith('is-') && !OWN.includes(c) && !declares(selectors, c)) bad.add(c);
    expect([...bad]).toEqual([]);
    expect(declares('.s2u-tabs { }', 's2u-tab')).toBe(false);
    expect(declares('.s2u-tabs .s2u-tab { }', 's2u-tab')).toBe(true);
    expect(declares('.s2u-tab--nav { }', 's2u-tab')).toBe(false);
  });
  it('styles.css is the canvas, the touch layer and placement only', () => {
    expect(css).not.toMatch(/#panel-toggle|#look|#loading-track|\.look-name|\.badge|\.rights|#about|#warning/);
  });

  /**
   * The owner, 2026-09-29: "Make sure all elements use our design system." Every colour, type, tracking, radius and
   * duration in the viewer's stylesheet is a system token; the only literal colours are the picture's own (the touch
   * sticks' translucent rings over the canvas, the flashbang's white), each in its one rule.
   */
  describe('styles.css speaks the system tokens', () => {
    const all = rules(css);
    const TOKEN = /var\(--s2u-[a-z0-9-]+\)/;
    const PICTURE: Record<string, RegExp> = {
      '#stick-base, #aim-base': /^rgba\(255, 255, 255, 0\.06\)$/, '#stick-knob, #aim-knob': /^rgba\(255, 255, 255, 0\.14\)$/, '#whiteout': /^#fff$/,
    };
    it('no colour literal but the picture own three, each in its rule', () => {
      const found: string[] = [];
      for (const r of all) for (const [p, v] of r.decls) {
        if (p.startsWith('--')) continue;
        if (!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black|red|gray|grey)\b/i.test(v)) continue;
        if (p === 'background' && PICTURE[r.selector]?.test(v)) continue;
        found.push(`${r.selector} { ${p}: ${v} }`);
      }
      expect(found).toEqual([]);
      for (const sel of Object.keys(PICTURE)) expect(all.some((r) => r.selector === sel), sel).toBe(true);
    });
    it('every colour property is a token, transparent, none or currentColor', () => {
      const bad: string[] = [];
      for (const r of all) for (const [p, v] of r.decls) {
        if (!/^(color|background|background-color|border-color|outline-color|fill|stroke|caret-color|accent-color)$/.test(p)) continue;
        if (p === 'background' && PICTURE[r.selector]) continue;
        if (!TOKEN.test(v) && !/^(transparent|none|currentColor|inherit)$/.test(v)) bad.push(`${r.selector} { ${p}: ${v} }`);
      }
      expect(bad).toEqual([]);
    });
    it('every font is a system type, every tracking a system tracking (or 0), every family a system face', () => {
      const bad: string[] = [];
      for (const r of all) for (const [p, v] of r.decls) {
        if (p === 'font' && !/^var\(--s2u-type-[a-z-]+\)$/.test(v)) bad.push(`${r.selector} { font: ${v} }`);
        if (['font-size', 'font-weight', 'line-height', 'font-style'].includes(p)) bad.push(`${r.selector} { ${p}: ${v} }`);
        if (p === 'font-family' && !/^var\(--s2u-font-[a-z]+\)$/.test(v)) bad.push(`${r.selector} { font-family: ${v} }`);
        if (p === 'letter-spacing' && !/^var\(--s2u-tracking-[a-z-]+\)$|^0$/.test(v)) bad.push(`${r.selector} { letter-spacing: ${v} }`);
      }
      expect(bad).toEqual([]);
    });
    it('every radius and duration is the system one (a circle is 50%)', () => {
      const bad: string[] = [];
      for (const r of all) for (const [p, v] of r.decls) {
        if (p === 'border-radius' && !TOKEN.test(v) && v !== '50%') bad.push(`${r.selector} { ${p}: ${v} }`);
        if (p === 'transition' && /\d(m?s)\b/.test(v.replace(/var\([^)]*\)/g, ''))) bad.push(`${r.selector} { ${p}: ${v} }`);
      }
      expect(bad).toEqual([]);
    });
  });

  it('the page has no inline style, and its theme colour is the system ground', () => {
    expect(doc.querySelectorAll('[style]')).toHaveLength(0);
    const tokens = readFileSync(resolve(here, '../../../../shared/ds/tokens.json'), 'utf-8');
    const ground = tokens.match(/"name":\s*"ground",\s*"value":\s*"(#[0-9a-f]+)"/i)![1];
    expect(doc.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe(ground);
  });

  it('the scripts put only system, state or viewer-own classes on the page, and no colour or type in inline styles', () => {
    const bad: string[] = [];
    const ok = (c: string): boolean => c.startsWith('is-') || OWN.includes(c) || declares(DS_SELECTORS, c);
    for (const { file, text } of tsSources()) {
      for (const m of text.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) if (!ok(m[1]!)) bad.push(`${file}: ${m[1]}`);
      for (const m of text.matchAll(/\.className\s*=\s*'([^']+)'/g)) for (const c of m[1]!.split(/\s+/)) if (!ok(c)) bad.push(`${file}: ${c}`);
      for (const m of text.matchAll(/setAttribute\('class',\s*`([^`]+)`/g)) {
        for (const c of m[1]!.replace(/\$\{[^}]+\}/g, 'cross').split(/\s+/)) if (!ok(c)) bad.push(`${file}: ${c}`);
      }
      if (/\.style\.(color|background\w*|font\w*|borderColor)\s*=|Object\.assign\([^)]*\.style/.test(text)) bad.push(`${file}: an inline colour, type or style block`);
    }
    expect(bad).toEqual([]);
  });

  it('the touch buttons are the system fab (round) and tab (the pills)', () => {
    for (const id of ['touch-up', 'touch-down', 'touch-stance', 'touch-fire', 'tw-fire', 'tw-jump', 'tw-stance', 'tw-action']) {
      expect(doc.getElementById(id)!.classList.contains('s2u-fab'), id).toBe(true);
    }
    for (const id of ['tw-reload', 'tw-inventory', 'tw-zoom-out', 'tw-zoom-in']) expect(doc.getElementById(id)!.classList.contains('s2u-tab'), id).toBe(true);
    for (const b of doc.querySelectorAll('button')) expect(b.classList.length, b.id).toBeGreaterThan(0);
  });
  it('styles.css keeps the placement minors the rewrite once lost', () => {
    expect(css).toMatch(/#fps\s*{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/#panel :focus-visible\s*{[^}]*outline-offset:\s*-2px/);
    expect(css).toMatch(/#panel-kicker\s*{[^}]*margin:\s*0/);
    expect(css).toMatch(/@media \(max-width: 480px\)\s*{[^}]*#fps-rest\s*{[^}]*display:\s*none/);
  });
  it('the ammo box is the in-game HUD (./hud, research 87), drawn in the frame: no HTML pill stands in for it', () => {
    expect(doc.getElementById('ammo')).toBeNull();
    expect(css).not.toMatch(/#ammo/);
    expect(doc.getElementById('touch-fire')!.closest('#touch')).not.toBeNull();
  });
  it('the fps pill is a number and a rest, so the rest can go on a phone', () => {
    expect(doc.querySelector('#fps > #fps-n')).not.toBeNull();
    expect(doc.querySelector('#fps > #fps-rest')).not.toBeNull();
  });
  it('the About link goes to socomunzipped.com', () => {
    expect(doc.querySelector('#about a[href="https://socomunzipped.com/"]')).not.toBeNull();
    expect(html).not.toMatch(/s2u\.scotho\.com/);
  });
  it('the segmented switch style keys on the switches\' role=group (never a radiogroup), so every switch is drawn as one', () => {
    expect(css).not.toMatch(/radiogroup/);
    expect(css).toMatch(/\.s2u-tabs\[role="group"\] \.s2u-tab\[aria-pressed="true"\]/);
    for (const g of doc.querySelectorAll('.s2u-tabs[role="group"]')) expect(g.closest('.s2u-overlay'), g.id).not.toBeNull();
  });
  it('About says what Play is, and never that there is no game (the Mode switch offers Play)', () => {
    const about = (doc.getElementById('about')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(about).not.toMatch(/there is no game/i);
    expect(about).not.toMatch(/just the world/i);
    expect(about).toMatch(/No game code runs/);
    expect(about).toMatch(/Play is a reading of the game's rules/);
    expect(doc.querySelector('#recom [data-recom="on"]')).not.toBeNull();
  });
  it('ui.ts speaks the system’s state classes', () => {
    expect(ui).not.toMatch(/toggle\('error'/);
    expect(ui).toMatch(/toggle\('is-bad'/);
    expect(ui).toMatch(/toggle\('is-folded'/);
  });
  it('ui.ts puts the badge on the chip and the full label on the About line', () => {
    expect(ui).toMatch(/find<HTMLElement>\('revision'\)\.textContent = badge/);
    expect(ui).toMatch(/find<HTMLElement>\('revision-line'\)\.textContent = label/);
  });
});

/**
 * W2.0, the owner's words: "turn settings into a single cog settings button beside unzipped and give
 * github an icon". The fold control leaves the panel for the site bar; a folded panel shows nothing.
 */
describe('W2.0: the cog beside the brand, the GitHub mark', () => {
  it('the panel toggle is a cog tab in the end group of the bar: Settings, then Controls, then GitHub (owner, 2026-09-29)', () => {
    const cog = doc.getElementById('panel-toggle')!;
    expect(cog.tagName).toBe('BUTTON');
    expect(cog.parentElement!.classList.contains('s2u-bar__end')).toBe(true);
    expect(cog.parentElement!.parentElement!.id).toBe('site-links');
    expect(cog.previousElementSibling).toBeNull();                          // first in the end group
    expect(cog.nextElementSibling!.id).toBe('controls-toggle');
    expect(doc.getElementById('controls-toggle')!.nextElementSibling!.id).toBe('source');
    expect([...cog.parentElement!.children].map((e) => e.id)).toEqual(['panel-toggle', 'controls-toggle', 'source']);
    expect(cog.getAttribute('aria-label')).toBe('settings');
    expect(cog.getAttribute('aria-controls')).toBe('panel-body');
    expect(cog.getAttribute('aria-expanded')).toBe('false');                 // the panel starts folded
    expect(cog.getAttribute('title')).toBeTruthy();
    expect(cog.querySelector('svg path')).not.toBeNull();
  });
  it('the three tabs of the bar are one class, each an icon before its word, so they share one size', () => {
    for (const id of ['controls-toggle', 'panel-toggle', 'source']) {
      const tab = doc.getElementById(id)!;
      expect(tab.classList.contains('s2u-tab') && tab.classList.contains('s2u-tab--nav'), id).toBe(true);
      expect(tab.firstElementChild!.tagName.toLowerCase(), id).toBe('svg');
      expect(tab.lastElementChild!.tagName.toLowerCase(), id).toBe('span');
      expect(tab.getAttribute('aria-label') && tab.getAttribute('title'), id).toBeTruthy();
    }
    expect(css).toMatch(/\.s2u-bar__end \.s2u-tab\s*{[^}]*height:\s*30px[^}]*padding:\s*0 12px/);
  });
  it('the controls tab opens a dialog popover after the panel, hidden, that holds the two tabs and their lists', () => {
    const tab = doc.getElementById('controls-toggle')!;
    expect(tab.getAttribute('aria-haspopup')).toBe('dialog');
    expect(tab.getAttribute('aria-expanded')).toBe('false');
    expect(tab.getAttribute('aria-controls')).toBe('controls');
    const pop = doc.getElementById('controls')!;
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(pop.hidden).toBe(true);
    expect(pop.compareDocumentPosition(doc.getElementById('panel')!) & 2).toBe(2);   // the panel precedes it
    expect(pop.querySelector('#hint')).not.toBeNull();
    expect(pop.querySelector('#controls-tabs.s2u-tabs')).not.toBeNull();
    expect(pop.querySelector('#pad-list')).not.toBeNull();
    expect(doc.querySelector('#panel #hint, #panel #pad-list')).toBeNull();
  });
  it('the panel has no title bar left in it: the kicker is its body\'s first line', () => {
    const panel = doc.getElementById('panel')!;
    expect(panel.querySelector('button.s2u-overlay__toggle, #panel-title, #panel-chevron')).toBeNull();
    expect(panel.firstElementChild!.id).toBe('panel-body');
    expect(doc.getElementById('panel-body')!.firstElementChild!.id).toBe('panel-kicker');
  });
  it('a folded panel is gone entirely, not left as a strip', () => {
    expect(css).toMatch(/#panel\.is-folded\s*{[^}]*display:\s*none/);
  });
  it('the GitHub link wears the mark before its word and keeps a name when the word goes', () => {
    const source = doc.getElementById('source')!;
    expect(source.firstElementChild!.tagName.toLowerCase()).toBe('svg');
    expect(source.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(source.getAttribute('aria-label')).toBe('GitHub');
    expect(source.getAttribute('title')).toBeTruthy();
    expect(doc.getElementById('source-word')!.textContent).toBe('GitHub');
    expect(css).toMatch(/#source svg\s*{[^}]*fill:\s*currentColor/);
    expect(css).toMatch(/@media \(max-width: 480px\)\s*{[^}]*#source-word[^}]*display:\s*none/);
  });
  it('ui.ts no longer writes a panel title', () => {
    expect(ui).not.toMatch(/panel-title/);
  });
});
