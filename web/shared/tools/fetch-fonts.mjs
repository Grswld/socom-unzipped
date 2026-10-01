#!/usr/bin/env node
/* One-off: fetch the three OFL families as latin woff2 from Google Fonts into web/shared/fonts/ with their licences,
   and write web/shared/ds/fonts.css. `npm run fonts -w shared`; the output is committed; not part of any build.
   Saira is requested as one static instance of the variable family (italic, width 62.5, weight 800): Saira
   Condensed has no italic and 62.5 is its width. The face is declared as `font-family: 'Saira Condensed'`
   (not 'Saira') because that is the family tokens.json and gen-tokens.mjs actually name -- the served file
   IS the variable Saira instance at width 62.5, which is Saira Condensed's own design; Saira Condensed itself
   ships with no italic, so this italic instance of the variable family stands in for it. The filename keeps
   the fetched family's own slug ('saira-...'), not the declared one, so it stays `saira-italic-800-latin.woff2`.

   Oswald and JetBrains Mono are variable fonts: Google serves the SAME file for every weight requested in one
   family/style (Oswald's wght axis covers 400-700, JetBrains Mono's covers 400-800), so several latin blocks
   in the css2 response share one url. Blocks are grouped by url first: a url used by more than one block is
   downloaded and written ONCE, named `<family-slug>-<style>-variable-latin.woff2`, and gets ONE @font-face
   with `font-weight: <lowest requested> <highest requested>` (a weight range, which the variable file actually
   supports across). A url used by a single block (Saira, requested as one static instance) keeps the old
   per-weight name and a single numeric font-weight. The fallback block is added by hand from font-metrics.mjs. */
import { mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const fontsDir = resolve(here, '../fonts');
const cssOut = resolve(here, '../ds/fonts.css');
mkdirSync(fontsDir, { recursive: true });

const FAMILIES = 'family=Oswald:wght@400;500;600&family=Saira:ital,wdth,wght@1,62.5,800&family=JetBrains+Mono:wght@400;500';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LICENCES = {
  Oswald: 'https://raw.githubusercontent.com/googlefonts/OswaldFont/main/OFL.txt',
  Saira: 'https://raw.githubusercontent.com/google/fonts/main/ofl/saira/OFL.txt',
  'JetBrains Mono': 'https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt',
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const res = await fetch(`https://fonts.googleapis.com/css2?${FAMILIES}&display=swap`, { headers: { 'User-Agent': UA } });
if (!res.ok) throw new Error(`fonts css ${res.status}`);
const text = await res.text();
const blocks = [...text.matchAll(/\/\*\s*(\w[\w-]*)\s*\*\/\s*(@font-face\s*{[^}]*})/g)].filter((m) => m[1] === 'latin');
if (blocks.length !== 6) throw new Error(`expected 6 latin faces, got ${blocks.length}`);

const parsed = blocks.map(([, , face]) => ({
  family: /font-family:\s*'([^']+)'/.exec(face)[1],
  style: /font-style:\s*(\w+)/.exec(face)[1],
  weight: /font-weight:\s*(\d+)/.exec(face)[1],
  stretch: /font-stretch:\s*([^;]+);/.exec(face)?.[1],
  url: /url\(([^)]+)\)/.exec(face)[1],
  range: /unicode-range:\s*([^;]+);/.exec(face)[1],
}));

const byUrl = new Map();
for (const b of parsed) {
  if (!byUrl.has(b.url)) byUrl.set(b.url, []);
  byUrl.get(b.url).push(b);
}

const out = ['@layer s2u.base {', '  /* Self-hosted faces (spec 5): written by tools/fetch-fonts.mjs, latin subsets, OFL 1.1 (licences in /fonts/). */'];
for (const group of byUrl.values()) {
  const { family, style, stretch, range, url } = group[0];
  const cssFamily = family === 'Saira' ? 'Saira Condensed' : family;
  const isVariable = group.length > 1;
  const weights = group.map((g) => Number(g.weight)).sort((a, b) => a - b);
  const file = isVariable ? `${slug(family)}-${style}-variable-latin.woff2` : `${slug(family)}-${style}-${group[0].weight}-latin.woff2`;
  const weightDecl = isVariable ? `${weights[0]} ${weights[weights.length - 1]}` : String(weights[0]);
  const bin = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!bin.ok) throw new Error(`${file} ${bin.status}`);
  writeFileSync(resolve(fontsDir, file), Buffer.from(await bin.arrayBuffer()));
  out.push(`  @font-face {\n    font-family: '${cssFamily}';\n    font-style: ${style};\n    font-weight: ${weightDecl};${stretch ? `\n    font-stretch: ${stretch};` : ''}\n    font-display: swap;\n    src: url('/fonts/${file}') format('woff2');\n    unicode-range: ${range};\n  }`);
  console.log('wrote', file);
}
for (const [family, url] of Object.entries(LICENCES)) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`licence ${family} ${r.status}`);
  writeFileSync(resolve(fontsDir, `OFL-${slug(family)}.txt`), await r.text());
}
out.push('  /* FALLBACKS: paste the output of `npm run fonts:metrics -w shared` below this line */', '}');
writeFileSync(cssOut, out.join('\n') + '\n');
console.log('wrote', cssOut);
