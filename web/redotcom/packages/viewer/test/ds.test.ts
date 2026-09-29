import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ds = resolve(here, '../src/ds');
const pub = resolve(here, '../../../public/fonts');
const web = resolve(here, '../../..');
const manifest = JSON.parse(readFileSync(resolve(ds, 'MANIFEST.json'), 'utf-8')) as { version: string; files: Record<string, string>; fonts: Record<string, string> };
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** the system's VERSION in the scotho checkout beside this repository, as ds-sync.ts finds it; absent on CI */
const sourceVersion = resolve(web, '../../scotho/apps/s2u/src/ds/VERSION');

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
  it('names the three woff2 files fonts.css uses, beside the stylesheets', () => {
    const css = readFileSync(resolve(ds, 'fonts.css'), 'utf-8');
    const files = [...css.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]!).sort();
    expect(Object.keys(manifest.fonts ?? {}).sort()).toEqual(files);
  });
  it.each(Object.keys(manifest.fonts ?? {}))('%s under public/fonts is byte-identical to the manifest (a CRLF-truncated copy fails here)', (f) => {
    expect(sha(resolve(pub, f))).toBe(manifest.fonts[f]);
  });
  it('carries the source’s VERSION when the scotho checkout is beside this repository', () => {
    if (!existsSync(sourceVersion)) { console.log(`ds.test.ts: no ${sourceVersion}; the source-version check was skipped (CI has no scotho)`); return; }
    expect(manifest.version).toBe(readFileSync(sourceVersion, 'utf-8').trim());
  });
});
