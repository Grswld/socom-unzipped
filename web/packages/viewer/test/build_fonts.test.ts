import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The built viewer ships its fonts. `copyPublicDir` is off (the extracted maps under `public/` must
 * never be copied into the build), so `vite.config.ts` carries a plugin that copies `public/fonts/*.woff2`
 * into `<outDir>/fonts/` at `closeBundle`. Live, before it, `/map-viewer/fonts/….woff2` answered 200
 * text/html (nginx's try_files handing back index.html) and the chrome fell to the fallbacks.
 *
 * Reads `dist/viewer` when a build is present and skips with a note when it is not (CI runs the unit
 * suite without a build); `VIEWER_BASE=/map-viewer/ npm run build` makes it real.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../../../dist/viewer');
const pub = resolve(here, '../../../public/fonts');
const built = existsSync(resolve(dist, 'index.html'));

describe.skipIf(!built)('the built viewer (dist/viewer)', () => {
  const woff2 = () => readdirSync(pub).filter((f) => f.endsWith('.woff2')).sort();
  it('holds every woff2 of public/fonts under fonts/, byte-identical', () => {
    expect(woff2()).toHaveLength(3);
    for (const f of woff2()) {
      const out = resolve(dist, 'fonts', f);
      expect(existsSync(out), out).toBe(true);
      expect(readFileSync(out).equals(readFileSync(resolve(pub, f))), f).toBe(true);
    }
  });
  it('every font URL in the built CSS resolves to a file under dist', () => {
    const assets = resolve(dist, 'assets');
    const css = readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => readFileSync(resolve(assets, f), 'utf-8')).join('\n');
    const urls = [...css.matchAll(/url\(["']?([^"')]*\/fonts\/[^"')]+)["']?\)/g)].map((m) => m[1]!);
    expect(urls.length).toBe(3);
    for (const u of urls) {
      // `/map-viewer/fonts/x.woff2` or `/fonts/x.woff2`: the path under the base is what dist serves
      const rel = u.replace(/^.*\/fonts\//, 'fonts/');
      expect(existsSync(resolve(dist, rel)), `${u} -> ${rel}`).toBe(true);
    }
  });
});

if (!built) console.log('build_fonts.test.ts: no dist/viewer build present; the fonts-ship check was skipped');
