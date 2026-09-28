import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const css = readFileSync(resolve(here, '../src/styles.css'), 'utf-8');
const ui = readFileSync(resolve(here, '../src/ui.ts'), 'utf-8');
const doc = new JSDOM(html).window.document;
const OWN = ['row', 'touch-lift', 'ps2-look', 'chrome-hidden', 'touch', 'panel-collapsed'];

describe('the viewer chrome uses the design system', () => {
  it('links the vendored system once, before styles.css', () => {
    const links = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
    expect(links).toEqual(['./src/ds/index.css', './src/styles.css']);
    expect(html).not.toMatch(/googleapis|gstatic/);
  });
  it.each([
    ['site-links', 's2u-bar'], ['panel', 's2u-overlay'], ['panel-toggle', 's2u-iconbtn'], ['panel-body', 's2u-overlay__body'],
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
    const selectors = readFileSync(resolve(here, '../src/ds/components.css'), 'utf-8') + readFileSync(resolve(here, '../src/ds/base.css'), 'utf-8');
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
    const literals = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [];
    expect(literals.length).toBeLessThanOrEqual(2);
  });
  it('styles.css keeps the placement minors the rewrite once lost', () => {
    expect(css).toMatch(/#fps\s*{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/#panel :focus-visible\s*{[^}]*outline-offset:\s*-2px/);
    expect(css).toMatch(/#panel-kicker\s*{[^}]*margin:\s*0/);
    expect(css).toMatch(/@media \(max-width: 360px\)\s*{[^}]*#fps-rest\s*{[^}]*display:\s*none/);
  });
  it('the fps pill is a number and a rest, so the rest can go at 360px', () => {
    expect(doc.querySelector('#fps > #fps-n')).not.toBeNull();
    expect(doc.querySelector('#fps > #fps-rest')).not.toBeNull();
  });
  it('the About link goes to socomunzipped.com', () => {
    expect(doc.querySelector('#about a[href="https://socomunzipped.com/"]')).not.toBeNull();
    expect(html).not.toMatch(/s2u\.scotho\.com/);
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
  it('the panel toggle is a cog icon button in the site bar, right after the brand', () => {
    const cog = doc.getElementById('panel-toggle')!;
    expect(cog.tagName).toBe('BUTTON');
    expect(cog.parentElement!.id).toBe('site-links');
    expect(cog.previousElementSibling!.id).toBe('home');
    expect(cog.getAttribute('aria-label')).toBe('settings');
    expect(cog.getAttribute('aria-controls')).toBe('panel-body');
    expect(cog.getAttribute('aria-expanded')).not.toBeNull();
    expect(cog.querySelector('svg path')).not.toBeNull();
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
    expect(css).toMatch(/@media \(max-width: 480px\)\s*{[^}]*#source-word\s*{[^}]*display:\s*none/);
  });
  it('ui.ts no longer writes a panel title', () => {
    expect(ui).not.toMatch(/panel-title/);
  });
});
