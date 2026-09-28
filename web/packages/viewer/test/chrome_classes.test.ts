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
    ['site-links', 's2u-bar'], ['panel', 's2u-overlay'], ['panel-toggle', 's2u-overlay__toggle'], ['panel-body', 's2u-overlay__body'],
    ['fps', 's2u-status--pill'], ['fullscreen', 's2u-fab'], ['loading', 's2u-loading'], ['loading-bar', 's2u-loading__bar'],
    ['loading-what', 's2u-status'], ['status', 's2u-status'], ['diagnostics', 's2u-status'], ['warning', 's2u-notice--warn'],
    ['about', 's2u-disclosure'], ['advanced', 's2u-disclosure'], ['fog-box', 's2u-disclosure'], ['sliders-box', 's2u-disclosure'],
    ['diagnostics-box', 's2u-disclosure'], ['disc', 's2u-label'],
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
  it('every class on the page is a system class, a state, or the viewer’s own', () => {
    const selectors = readFileSync(resolve(here, '../src/ds/components.css'), 'utf-8') + readFileSync(resolve(here, '../src/ds/base.css'), 'utf-8');
    const bad = new Set<string>();
    for (const el of doc.querySelectorAll('[class]')) for (const c of el.classList)
      if (!c.startsWith('is-') && !OWN.includes(c) && !selectors.includes(`.${c}`)) bad.add(c);
    expect([...bad]).toEqual([]);
  });
  it('styles.css is the canvas, the touch layer and placement only', () => {
    expect(css).not.toMatch(/#panel-toggle|#look|#loading-track|\.look-name|\.badge|\.rights|#about|#warning/);
    const literals = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? [];
    expect(literals.length).toBeLessThanOrEqual(2);
  });
  it('ui.ts speaks the system’s state classes', () => {
    expect(ui).not.toMatch(/toggle\('error'/);
    expect(ui).toMatch(/toggle\('is-bad'/);
    expect(ui).toMatch(/toggle\('is-folded'/);
  });
});
