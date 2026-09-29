import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The viewer reads the s2u design system in place from web/shared/ds (since 2026-09-29; before that a synced copy
 * under src/ds/ with a MANIFEST). One copy, so there is nothing to drift: this checks the viewer's side of the
 * contract -- the five stylesheets are where vite.config.ts's alias points, the version is stamped, and every font
 * fonts.css names is in web/shared/fonts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ds = resolve(here, '../../../../shared/ds');
const fonts = resolve(here, '../../../../shared/fonts');
const FILES = ['index.css', 'tokens.css', 'fonts.css', 'base.css', 'components.css'];

describe('the shared design system (web/shared/ds)', () => {
  it.each(FILES)('%s is there', (f) => {
    expect(existsSync(resolve(ds, f)), resolve(ds, f)).toBe(true);
  });
  it('carries its VERSION inside tokens.css', () => {
    const version = readFileSync(resolve(ds, 'VERSION'), 'utf-8').trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readFileSync(resolve(ds, 'tokens.css'), 'utf-8')).toContain(`--s2u-version: "${version}"`);
  });
  it('has every font fonts.css names under web/shared/fonts, and none from Google', () => {
    const css = readFileSync(resolve(ds, 'fonts.css'), 'utf-8');
    const files = [...css.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]!);
    expect(files.length).toBe(3);
    for (const f of files) expect(existsSync(resolve(fonts, f)), f).toBe(true);
    expect(css).not.toMatch(/googleapis|gstatic/);
  });
});
