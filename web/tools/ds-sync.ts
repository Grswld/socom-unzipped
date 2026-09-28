/* Vendor the s2u design system from a scotho checkout: the five stylesheets into packages/viewer/src/ds/, the
   three woff2 files and their licences into public/fonts/, and MANIFEST.json (the system's VERSION, a sha256 per
   stylesheet and per woff2). `npm run ds:sync -- <path to scotho>/apps/s2u/src/ds` (default ../scotho/apps/s2u/src/ds
   beside this repository). packages/viewer/test/ds.test.ts refuses a copy that was edited by hand, a font that
   differs from its hash, and a version behind the source's when the checkout is there. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const src = resolve(process.argv[2] ?? resolve(web, '../../scotho/apps/s2u/src/ds'));
const dst = resolve(web, 'packages/viewer/src/ds');
const fontsSrc = resolve(src, '../../public/fonts');
const fontsDst = resolve(web, 'public/fonts');
const FILES = ['index.css', 'tokens.css', 'fonts.css', 'base.css', 'components.css'];

for (const f of FILES) if (!existsSync(resolve(src, f))) { console.error(`no ${f} under ${src}`); process.exit(2); }
mkdirSync(dst, { recursive: true });
mkdirSync(fontsDst, { recursive: true });
const files: Record<string, string> = {};
for (const f of FILES) {
  copyFileSync(resolve(src, f), resolve(dst, f));
  files[f] = createHash('sha256').update(readFileSync(resolve(dst, f))).digest('hex');
}
// The woff2 files carry a sha256 each too: a copy truncated by a CRLF conversion once shipped, and the guard
// recomputes these over public/fonts. The OFL texts are copied but not hashed (they are text, and normalised).
const fonts: Record<string, string> = {};
for (const f of readdirSync(fontsSrc).sort()) {
  if (!/\.(woff2|txt)$/.test(f)) continue;
  copyFileSync(resolve(fontsSrc, f), resolve(fontsDst, f));
  if (f.endsWith('.woff2')) fonts[f] = createHash('sha256').update(readFileSync(resolve(fontsDst, f))).digest('hex');
}
const version = readFileSync(resolve(src, 'VERSION'), 'utf-8').trim();
writeFileSync(resolve(dst, 'MANIFEST.json'), JSON.stringify({ version, source: 'scotho apps/s2u/src/ds', files, fonts }, null, 2) + '\n');
console.log(`vendored design system ${version}: ${FILES.length} stylesheets, ${Object.keys(fonts).length} fonts under public/fonts`);
