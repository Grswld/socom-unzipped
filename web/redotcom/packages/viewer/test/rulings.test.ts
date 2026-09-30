import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * The owner's rulings of 2026-09-29, as the panel says them: the field of view stays the game's vertical 49 degrees (the
 * width widens with the screen) and the PS2 picture's stretch onto 4:3 stays smooth. The mouse look's law, since the
 * owner hotfix of 2026-09-30, is no choice: the mouse is raw, a controller the game's stick curve, and the switch is gone. The copy is the tabs' tooltips; nothing here changes what the tabs do.
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
  it('mouse look (owner hotfix, 2026-09-30): no law switch; the help line says a controller keeps the stick curve', () => {
    expect(doc.getElementById('mouselaw')).toBeNull();
    expect(doc.querySelector('[data-law]')).toBeNull();
    expect(doc.getElementById('look-note')!.textContent).toMatch(/controller keeps the game.s stick curve/);
    expect(doc.getElementById('sensitivity')).not.toBeNull();
  });
});
