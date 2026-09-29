import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * The owner's rulings of 2026-09-29, as the panel says them: the field of view stays the game's vertical 49 degrees (the
 * width widens with the screen), the mouse look keeps both laws with raw the default, and the PS2 picture's stretch onto
 * 4:3 stays smooth. The copy is the tabs' tooltips; nothing here changes what the tabs do.
 */
const here = dirname(fileURLToPath(import.meta.url));
const doc = new JSDOM(readFileSync(resolve(here, '../index.html'), 'utf-8')).window.document;
const title = (sel: string): string => doc.querySelector(sel)?.getAttribute('title') ?? '';

describe('the owner rulings of 2026-09-29 in the panel copy', () => {
  it('Modern: the game\'s vertical 49 degrees, the width widening with the screen', () => {
    expect(title('#look [data-look="modern"]')).toMatch(/49° vertical/);
    expect(title('#look [data-look="modern"]')).toMatch(/widens/);
  });
  it('PS2: the 640x448 frame stretched smooth onto 4:3', () => {
    expect(title('#look [data-look="ps2"]')).toMatch(/640×448/);
    expect(title('#look [data-look="ps2"]')).toMatch(/smooth/);
  });
  it('mouse look: raw is the default and pressed, the stick curve is kept beside it', () => {
    const raw = doc.querySelector('#mouselaw [data-law="raw"]')!;
    expect(raw.getAttribute('aria-pressed')).toBe('true');
    expect(title('#mouselaw [data-law="raw"]')).toMatch(/default/);
    expect(doc.querySelector('#mouselaw [data-law="stick"]')).not.toBeNull();
  });
});
