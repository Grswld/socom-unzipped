import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve as p, dirname } from 'path';
import { JSDOM } from 'jsdom';
import { SELECTORS } from '../../shared/ds/selectors';
import { PAGE_OWN } from './page_classes';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(p(here, '../index.html'), 'utf-8');
// a url is given so jsdom treats the document as same-origin rather than opaque (querying a <link>'s attributes
// on an opaque-origin document throws a SecurityError from an unrelated storage check on a later assertion)
const doc = new JSDOM(html, { url: 'https://socomunzipped.com/' }).window.document;
// s2u-crt and s2u-crt-text are the site's to turn on (spec rule 6), so they are not in SELECTORS (the gallery leaves the CRT off)
const known = new Set([...SELECTORS.flatMap((s) => s.split(/[\s.]+/).filter((c) => c && !c.startsWith('is-'))), ...PAGE_OWN, 's2u-crt', 's2u-crt-text']);

describe('index.html uses the design system', () => {
  it('every class is a system class, a state, or on the page-own list', () => {
    const bad = new Set<string>();
    for (const el of doc.querySelectorAll('[class]')) for (const c of el.classList) if (!known.has(c) && !c.startsWith('is-')) bad.add(c);
    expect([...bad]).toEqual([]);
  });
  it('links the system once and never Google', () => {
    expect(html).not.toMatch(/googleapis|gstatic/);
    expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000e11');
    expect(doc.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
    expect(doc.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('/src/home.css');
  });
  it('has the CRT', () => {
    expect(doc.body.classList.contains('s2u-crt')).toBe(true);
    expect(doc.querySelector('.s2u-scan')).not.toBeNull();
  });
  it('has no reveals or number stamps', () => {
    expect(doc.querySelector('.reveal, .num, .s2u-card__num')).toBeNull();
  });
  it('keeps every id the scripts use', () => {
    for (const id of ['bar', 'bar-lamp', 'sound', 'bg', 'logo', 'hero-title', 'wheel', 'hero-status', 'hero-lamp', 'hero-status-text', 'hint-select',
      'story-latest', 'stats-status', 'stats-games-head', 'stats-games', 'stats-players', 'stats-updated', 'tester-callout', 'tester-open',
      'tester-panel', 'tester-email', 'tester-note', 'tester-website', 'tester-send', 'tester-cancel', 'tester-note-line', 'report-form',
      'report-title', 'report-description', 'report-contact', 'report-website', 'report-send', 'report-note', 'foot-fine', 'progress'])
      expect(doc.getElementById(id), id).not.toBeNull();
  });
  it('has the data and redotcom footer links', () => {
    expect(doc.querySelector('footer nav a[href$="/data.html"]')).not.toBeNull();
    expect(doc.querySelector('footer nav a[href$="/redotcom/"]')).not.toBeNull();
  });
});

describe('home.ts speaks the system’s state classes', () => {
  const ts = readFileSync(p(here, 'home.ts'), 'utf-8');
  it('never toggles an old state name', () => {
    for (const old of ["toggle('on'", "toggle('solid'", "toggle('lit'", "add('in'", "'stat-row", "`lamp ", "`led ", "'frame'", "'frame none'", "'txt'", "'read'", "'stats-empty'", "report-note${"])
      expect(ts, old).not.toContain(old);
  });
});

describe('story.html uses the design system', () => {
  // the story's own classes: its placement (wrap, hero, strip), the timeline (eras, tl, era, node, dot, entry) and the
  // entry's parts; state is is-*; everything else must be the system's (tools_py/story/site.py in socom_pc emits it)
  const STORY_OWN = ['wrap', 'story-hero', 'logo', 'preface', 'foreword', 'sig', 'strip', 'eras', 'tl', 'era', 'mark', 'span', 'standing',
    'node', 'pic', 'dot', 'entry', 'yr', 'hook', 'how', 'but', 'cited', 'n', 'chips', 'cite', 'commit', 'run', 'path'];
  const shtml = readFileSync(p(here, '../story.html'), 'utf-8');
  const sdoc = new JSDOM(shtml, { url: 'https://socomunzipped.com/story.html' }).window.document;
  it('every class is a system class, a state, or the story’s own', () => {
    const bad = new Set<string>();
    for (const el of sdoc.querySelectorAll('[class]')) for (const c of el.classList) if (!known.has(c) && !STORY_OWN.includes(c) && !c.startsWith('is-')) bad.add(c);
    expect([...bad]).toEqual([]);
  });
  it('links the system once and never Google', () => {
    expect(shtml).not.toMatch(/googleapis|gstatic/);
    expect(sdoc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000e11');
    expect(sdoc.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
    expect(sdoc.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('/src/ds/index.css');
  });
  it('has the CRT and the same chrome as the front page', () => {
    expect(sdoc.body.classList.contains('s2u-crt')).toBe(true);
    expect(sdoc.querySelector('.s2u-scan')).not.toBeNull();
    for (const sel of ['header#bar.s2u-bar', '.s2u-bar__brand .s2u-bar__ii', 'nav.s2u-bar__nav a[aria-current="page"][href="/story.html"]',
      '.s2u-bar__end > a.s2u-tab.s2u-tab--nav[href="/classic.html"]', 'footer.s2u-foot .s2u-foot__brand', 'footer.s2u-foot p.s2u-fine'])
      expect(sdoc.querySelector(sel), sel).not.toBeNull();
    expect(sdoc.querySelector('#sound, #bar-lamp')).toBeNull();
  });
  it('sits still: no per-entry reveal, the entries are system panels', () => {
    expect(shtml).not.toMatch(/translateY|IntersectionObserver/);
    expect(sdoc.querySelector('article.entry:not(.s2u-panel__body)')).toBeNull();
    expect(sdoc.querySelectorAll('article.entry.s2u-panel__body').length).toBeGreaterThan(0);
    expect(sdoc.querySelector('h1.s2u-title.s2u-title--story')).not.toBeNull();
  });
  it('has the data and redotcom footer links', () => {
    expect(sdoc.querySelector('footer nav a[href$="/data.html"]')).not.toBeNull();
    expect(sdoc.querySelector('footer nav a[href$="/redotcom/"]')).not.toBeNull();
  });
});

describe('data.html uses the design system', () => {
  // the data page's own class: its placement wrapper; everything else must be the system's or a state (is-*)
  const DATA_OWN = ['wrap'];
  const dhtml = readFileSync(p(here, '../data.html'), 'utf-8');
  const ddoc = new JSDOM(dhtml, { url: 'https://socomunzipped.com/data.html' }).window.document;
  it('every class is a system class, a state, or the page’s own', () => {
    const bad = new Set<string>();
    for (const el of ddoc.querySelectorAll('[class]')) for (const c of el.classList) if (!known.has(c) && !DATA_OWN.includes(c) && !c.startsWith('is-')) bad.add(c);
    expect([...bad]).toEqual([]);
  });
  it('links the system once and never Google', () => {
    expect(dhtml).not.toMatch(/googleapis|gstatic/);
    expect(ddoc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#000e11');
    expect(ddoc.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1);
    expect(ddoc.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('/src/ds/index.css');
  });
  it('has the CRT and the same chrome as the front page', () => {
    expect(ddoc.body.classList.contains('s2u-crt')).toBe(true);
    expect(ddoc.querySelector('.s2u-scan')).not.toBeNull();
    for (const sel of ['header#bar.s2u-bar', '.s2u-bar__brand .s2u-bar__ii',
      '.s2u-bar__end > a.s2u-tab.s2u-tab--nav[href="/classic.html"]', 'footer.s2u-foot .s2u-foot__brand', 'footer.s2u-foot p.s2u-fine'])
      expect(ddoc.querySelector(sel), sel).not.toBeNull();
    expect(ddoc.querySelector('#sound, #bar-lamp')).toBeNull();
    expect(ddoc.querySelector('nav.s2u-bar__nav a[aria-current="page"]')).toBeNull();
  });
  it('has the data and redotcom footer links', () => {
    expect(ddoc.querySelector('footer nav a[href$="/data.html"]')).not.toBeNull();
    expect(ddoc.querySelector('footer nav a[href$="/redotcom/"]')).not.toBeNull();
  });
});
