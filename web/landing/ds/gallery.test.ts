import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
import { JSDOM } from 'jsdom';
import { SELECTORS } from '../../shared/ds/selectors';
import { readTokens } from '../../shared/ds/contrast';
import { renderContrastTable } from './gallery';

// Under this repo's jsdom vitest environment, `new URL('./x', import.meta.url)` mis-resolves
// (import.meta.url is not a real file:// URL here), so paths are built from __dirname instead.
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolvePath(__dirname, './index.html'), 'utf-8');
const doc = new JSDOM(html).window.document;
const tokens = readTokens(readFileSync(resolvePath(__dirname, '../../shared/ds/tokens.css'), 'utf-8'));

function present(sel: string): boolean {
  return doc.querySelector(sel) !== null;
}

describe('the gallery', () => {
  it('is noindex and links the system once, never Google', () => {
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    const links = doc.querySelectorAll('link[rel="stylesheet"]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/src/ds/index.css');
    expect(html).not.toMatch(/googleapis|gstatic/);
  });
  it.each(SELECTORS)('shows %s', (sel) => { expect(present(sel), sel).toBe(true); });
  it('shows every tab state and the content extremes', () => {
    for (const s of ['rest', 'hover', 'focus', 'active', 'disabled', 'busy', 'pressed']) expect(doc.querySelector(`[data-state="${s}"]`), s).not.toBeNull();
    for (const x of ['empty', 'one', 'max', 'long-word', 'two-line']) expect(doc.querySelector(`[data-extreme="${x}"]`), x).not.toBeNull();
  });
  it('the pressed-down swatch is inert (axe skips it) and CLASSIC leads to classic.html', () => {
    expect(doc.querySelector('[data-state="active"]')?.hasAttribute('inert')).toBe(true);
    expect(doc.querySelector('.s2u-bar__end a.s2u-tab--nav')?.getAttribute('href')).toBe('/classic.html');
  });
  it('shows compact density, the overlay over a bright stand-in, and the briefing grid', () => {
    expect(doc.querySelector('[data-density="compact"]')).not.toBeNull();
    expect(doc.querySelector('.gallery-bright .s2u-overlay')).not.toBeNull();
    expect(doc.querySelector('.s2u-briefing .s2u-briefing__tabs-end')).not.toBeNull();
  });
  it('uses the site’s own sentences and the game’s words', () => {
    expect(html).toContain("The game's MIPS code was statically recompiled to C++");
    expect(html).toContain('Mission details');
    expect(html).not.toMatch(/lorem ipsum/i);
  });
  it('renders the contrast table from the tokens, every row passing', () => {
    const root = doc.createElement('div');
    renderContrastTable(root, tokens);
    const rows = root.querySelectorAll('tr[data-pair]');
    expect(rows.length).toBeGreaterThanOrEqual(44);
    for (const r of rows) expect(r.getAttribute('data-pass'), r.getAttribute('data-pair')!).toBe('true');
  });
});
