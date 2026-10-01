#!/usr/bin/env node
/* One-off: print the @font-face fallback blocks that make a local face stand in for each hosted one at the same
   line positions (size-adjust from the average glyph width; ascent/descent/line-gap overrides from the primary's
   metrics divided by that adjust: the capsize / fontaine method). Needs the fallback TTFs on this machine
   (Windows: C:\Windows\Fonts). Paste the output into web/shared/ds/fonts.css at the FALLBACKS comment, with the date.
   There is no target range for size-adjust: it is whatever the maths gives for a given primary/local pairing
   (an ultra-condensed italic primary against a local face that is not itself condensed and italic can land far
   from 100%, and that is correct, not a bug). The only guard is that the number came out finite and plausible
   (40-250%) -- anything outside that means a wrong file or a wrong metric was read, not a bad pairing. */
import * as fontkit from 'fontkit';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const win = process.env.WINDIR ? `${process.env.WINDIR}/Fonts` : 'C:/Windows/Fonts';
/* weight and style repeat the primary's descriptors so the browser synthesises the same weight and slant from the
   local face while the woff2 is still loading (a fallback block without them is matched as 400 normal only) */
const PAIRS = [
  { name: 'Oswald Fallback', local: 'Arial Narrow', primary: '../fonts/oswald-normal-variable-latin.woff2', fallback: `${win}/ARIALN.TTF`, weight: '400 600' },
  { name: 'Saira Condensed Fallback', local: 'Arial Narrow Bold Italic', primary: '../fonts/saira-italic-800-latin.woff2', fallback: `${win}/ARIALNBI.TTF`, weight: '800', style: 'italic' },
  { name: 'JetBrains Mono Fallback', local: 'Consolas', primary: '../fonts/jetbrains-mono-normal-variable-latin.woff2', fallback: `${win}/consola.ttf`, weight: '400 500' },
];
const pct = (x) => `${(x * 100).toFixed(2)}%`;
for (const p of PAIRS) {
  const a = fontkit.openSync(resolve(here, p.primary));
  const b = fontkit.openSync(p.fallback);
  const avg = (f) => (f['OS/2'].xAvgCharWidth || f.bbox.maxX) / f.unitsPerEm;
  const adjust = avg(a) / avg(b);
  const adjustPct = adjust * 100;
  if (!Number.isFinite(adjustPct) || adjustPct < 40 || adjustPct > 250) throw new Error(`${p.name}: size-adjust ${adjustPct}% is not a plausible finite percentage -- check the files`);
  const descriptors = `\n    font-weight: ${p.weight};` + (p.style ? `\n    font-style: ${p.style};` : '');
  console.log(`  @font-face {\n    font-family: '${p.name}';${descriptors}\n    font-display: swap;\n    src: local('${p.local}');\n    size-adjust: ${pct(adjust)};\n    ascent-override: ${pct(a.ascent / a.unitsPerEm / adjust)};\n    descent-override: ${pct(Math.abs(a.descent) / a.unitsPerEm / adjust)};\n    line-gap-override: ${pct(a.lineGap / a.unitsPerEm / adjust)};\n  }`);
}
console.log(`  /* fallback metrics computed ${new Date().toISOString().slice(0, 10)} by tools/font-metrics.mjs */`);
