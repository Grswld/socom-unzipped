import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve as p, dirname } from 'path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(p(here, '../data.html'), 'utf-8');
const doc = new JSDOM(html).window.document;
const POLICY = "The server keeps what the game's own protocol requires and nothing else: the persona name, the password hash, the clan and the match statistics the game shows, and the clamped chat lines while a lobby is open. No analytics, no e-mail unless you gave one on the REPORT A BUG form, nothing sold or shared. Anything kept about you is deleted on request through the contact on this site.";
const BACKUPS = 'Backups. The account database on the server is backed up once a day, and old copies there are dropped as new ones arrive.';

/** the page's own declarations: every `prop: value` inside `{…}` across ALL of its <style> elements */
const ownDeclarations = (page: string): number => {
  const d = new JSDOM(page).window.document;
  let n = 0;
  for (const style of d.querySelectorAll('style')) {
    const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/{([^{}]*)}/g)) n += (m[1].match(/:/g) ?? []).length;
  }
  return n;
};
/** every element carrying a style attribute, as `tag#id` */
const inlineStyles = (page: string): string[] =>
  [...new JSDOM(page).window.document.querySelectorAll('[style]')].map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`);

describe('data.html', () => {
  it('states the owner’s policy verbatim, first', () => {
    const first = doc.querySelector('main .s2u-panel .s2u-panel__body p')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(first).toBe(POLICY);
  });
  it('says how a reset happens and who does it, and names the form as the contact', () => {
    const text = doc.body.textContent!.replace(/\s+/g, ' ');
    expect(text).toMatch(/password reset/i);
    expect(text).toMatch(/by hand/);
    expect(text).toMatch(/REPORT A BUG/);
    expect(text).not.toMatch(/within \d+ (days|hours)|we take your privacy|GDPR|cookie banner/i);
  });
  it('keeps to the facts list: the backups item verbatim, no reach past what is kept', () => {
    const text = doc.body.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain(BACKUPS);
    expect(text).toMatch(/on that first login\. /);
    expect(text).not.toMatch(/the server adds nothing|leaves the backups too|the game's own lobby shows/);
  });
  it('is a system page: one stylesheet, the head tags, at most ten own declarations, no style attribute', () => {
    expect(doc.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
    expect(doc.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('/src/ds/index.css');
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://socomunzipped.com/data.html');
    expect(doc.querySelector('meta[property="og:title"]')).not.toBeNull();
    expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000e11');
    expect(ownDeclarations(html)).toBeLessThanOrEqual(10);
    expect(inlineStyles(html)).toEqual([]);
    expect(html).not.toMatch(/googleapis|gstatic/);
  });
  it('the declaration guard, adversarially: every <style> counts, a second block cannot hide six more', () => {
    const six = '<style>.a { color: red; margin: 0; padding: 0; top: 0; left: 0; right: 0 }</style>';
    expect(ownDeclarations(`<html><head>${six}</head><body></body></html>`)).toBe(6);
    expect(ownDeclarations(`<html><head>${six}</head><body>${six}</body></html>`)).toBe(12);
    expect(ownDeclarations(`<html><head>${six}</head><body>${six}</body></html>`)).toBeGreaterThan(10);
    expect(ownDeclarations('<style>/* a: b; c: d */ .a { x: 1; y: 2 } @media (a: b) { .c { z: 3 } }</style>')).toBe(3);
    expect(inlineStyles('<p id="q" style="color: red">x</p><span style="">y</span>')).toEqual(['p#q', 'span']);
  });
  it('is in the sitemap and has the no-cache location', () => {
    expect(readFileSync(p(here, '../public/sitemap.xml'), 'utf-8')).toContain('https://socomunzipped.com/data.html');
    expect(readFileSync(p(here, '../../shared/deploy/site/nginx.conf'), 'utf-8')).toContain('location = /data.html');
  });
});
