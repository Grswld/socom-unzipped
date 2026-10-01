/**
 * What both sites' Vite configs take from web/shared: the design system's fonts.
 *
 * `ds/fonts.css` names its faces as `/fonts/<file>.woff2` and stays byte-for-byte as the generator wrote it. Each
 * site aliases `/fonts/` to `web/shared/fonts/`, so the dev server serves the files from here and the build bundles
 * them as assets under the site's own base (`/`, or `/redotcom/` for the viewer). `shipFontLicences` copies the three
 * woff2 files and their OFL texts into `<outDir>/fonts/` as well, so the licences ride along and a stale absolute
 * `/fonts/` link still answers.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Structural types, not vite's own: the two sites build with different vite majors (redotcom 7, landing 8), and
   this file must type-check under either without importing one. */
interface Alias { find: RegExp; replacement: string }
interface Plugin {
  name: string;
  apply: 'build';
  configResolved(config: { build: { outDir: string } }): void;
  closeBundle(): void;
}

/** web/shared/fonts, absolute */
export const sharedFonts = fileURLToPath(new URL('./fonts', import.meta.url));
/** web/shared/ds, absolute */
export const sharedDs = fileURLToPath(new URL('./ds', import.meta.url));

const slash = (p: string): string => p.replace(/\\/g, '/');

/** `/src/ds/index.css` (the URL both sites' pages link) -> web/shared/ds/index.css */
export const dsAlias: Alias = { find: /^\/src\/ds\//, replacement: `${slash(sharedDs)}/` };

/** `/fonts/x.woff2` -> web/shared/fonts/x.woff2 */
export const fontsAlias: Alias = { find: /^\/fonts\//, replacement: `${slash(sharedFonts)}/` };

export function shipFontLicences(): Plugin {
  let outDir = '';
  return {
    name: 's2u-shared:ship-fonts',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() {
      const dst = join(outDir, 'fonts');
      mkdirSync(dst, { recursive: true });
      for (const f of readdirSync(sharedFonts)) if (/\.(woff2|txt)$/.test(f)) copyFileSync(join(sharedFonts, f), join(dst, f));
    },
  };
}
