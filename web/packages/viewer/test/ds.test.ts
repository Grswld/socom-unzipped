import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ds = resolve(here, '../src/ds');
const pub = resolve(here, '../../../public/fonts');
const manifest = JSON.parse(readFileSync(resolve(ds, 'MANIFEST.json'), 'utf-8')) as { version: string; files: Record<string, string> };
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('the vendored design system', () => {
  it('names a version and five stylesheets', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(manifest.files).sort()).toEqual(['base.css', 'components.css', 'fonts.css', 'index.css', 'tokens.css']);
  });
  it.each(Object.keys(manifest.files))('%s is byte-identical to the manifest (run npm run ds:sync, never edit)', (f) => {
    expect(sha(resolve(ds, f))).toBe(manifest.files[f]);
  });
  it('carries the version inside tokens.css', () => {
    expect(readFileSync(resolve(ds, 'tokens.css'), 'utf-8')).toContain(`--s2u-version: "${manifest.version}"`);
  });
  it('has every font fonts.css names under public/fonts', () => {
    const css = readFileSync(resolve(ds, 'fonts.css'), 'utf-8');
    const files = [...css.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]!);
    expect(files.length).toBe(3);
    for (const f of files) expect(existsSync(resolve(pub, f)), f).toBe(true);
    expect(css).not.toMatch(/googleapis|gstatic/);
  });
});
