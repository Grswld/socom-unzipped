/* Vendor the s2u design system from a scotho checkout: the five stylesheets into packages/viewer/src/ds/, the
   three woff2 files and their licences into public/fonts/, and MANIFEST.json (the system's VERSION, a sha256 per
   stylesheet). `npm run ds:sync -- <path to scotho>/apps/s2u/src/ds` (default ../scotho/apps/s2u/src/ds beside
   this repository). packages/viewer/test/ds.test.ts refuses a copy that was edited by hand. */
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
for (const f of readdirSync(fontsSrc)) if (/\.(woff2|txt)$/.test(f)) copyFileSync(resolve(fontsSrc, f), resolve(fontsDst, f));
const version = readFileSync(resolve(src, 'VERSION'), 'utf-8').trim();
writeFileSync(resolve(dst, 'MANIFEST.json'), JSON.stringify({ version, source: 'scotho apps/s2u/src/ds', files }, null, 2) + '\n');
console.log(`vendored design system ${version}: ${FILES.length} stylesheets, fonts under public/fonts`);
