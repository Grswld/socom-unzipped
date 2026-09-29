import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The built viewer ships its fonts. Live, before a fix, `/map-viewer/fonts/….woff2` answered 200 text/html (nginx's
 * try_files handing back index.html) and the chrome fell to the fallbacks. Since 2026-09-29 the fonts are read from
 * web/shared/fonts: `vite.config.ts` aliases `/fonts/` there, so the build bundles each woff2 under `assets/`, and
 * `shipFontLicences` (web/shared/vite.ts) copies the woff2 files and their OFL texts into `<outDir>/fonts/`.
 *
 * Reads `dist/viewer` when a build is present and skips with a note when it is not (CI runs the unit
 * suite without a build); `VIEWER_BASE=/redotcom/ npm run build` makes it real.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../../dist/viewer');
const pub = resolve(here, '../../../../shared/fonts');
const built = existsSync(resolve(dist, 'index.html'));

describe.skipIf(!built)('the built viewer (dist/viewer)', () => {
  const woff2 = () => readdirSync(pub).filter((f) => f.endsWith('.woff2')).sort();
  it('holds every woff2 of web/shared/fonts under fonts/, byte-identical, with the licences', () => {
    expect(woff2()).toHaveLength(3);
    for (const f of woff2()) {
      const out = resolve(dist, 'fonts', f);
      expect(existsSync(out), out).toBe(true);
      expect(readFileSync(out).equals(readFileSync(resolve(pub, f))), f).toBe(true);
    }
    for (const f of readdirSync(pub).filter((x) => x.endsWith('.txt'))) expect(existsSync(resolve(dist, 'fonts', f)), f).toBe(true);
  });
  it('every font URL in the built CSS resolves to a file under dist', () => {
    const assets = resolve(dist, 'assets');
    const css = readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => readFileSync(resolve(assets, f), 'utf-8')).join('\n');
    const urls = [...css.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)].map((m) => m[1]!);
    expect(urls.length).toBe(3);
    for (const u of urls) {
      // `/redotcom/assets/x-hash.woff2`, `/assets/...` or `./x-hash.woff2`: the path after the base is what dist serves
      const rel = u.replace(/^.*?\/(assets|fonts)\//, '$1/').replace(/^\.\//, 'assets/');
      expect(existsSync(resolve(dist, rel)), `${u} -> ${rel}`).toBe(true);
    }
  });
});

if (!built) console.log('build_fonts.test.ts: no dist/viewer build present; the fonts-ship check was skipped');
