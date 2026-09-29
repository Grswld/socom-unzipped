/* The gallery's script: the tokens tab's contrast readout (the same maths as the guard), the CRT toggle, the typed
   panel, and the bar's current link. `renderContrastTable` and `PAIRS` are exported for the jsdom test. */
import { parseColor, composite, contrast, readTokens, resolve } from '../../shared/ds/contrast';
import { typeInto } from '../../shared/ds/typed';

export const PAIRS: [string, string, number][] = [];
for (const fg of ['--s2u-gold', '--s2u-gold-display', '--s2u-text', '--s2u-text-strong', '--s2u-text-dim', '--s2u-glyph-triangle', '--s2u-glyph-cross', '--s2u-warn'])
  for (const bg of ['--s2u-ground', '--s2u-panel', '--s2u-tab', '--s2u-tab-lit']) PAIRS.push([fg, bg, 4.5]);
for (const bg of ['--s2u-ground', '--s2u-panel', '--s2u-tab', '--s2u-tab-lit']) PAIRS.push(['--s2u-glyph-square', bg, 3], ['--s2u-focus', bg, 3]);
PAIRS.push(['--s2u-text-strong', '--s2u-highlight', 4.5], ['--s2u-focus', '--s2u-highlight', 3], ['--s2u-cyan-boot', '--s2u-ground-deep', 4.5], ['--s2u-ground', '--s2u-gold', 4.5]);

function solid(tokens: Map<string, string>, name: string, over = '--s2u-ground') {
  const c = parseColor(resolve(tokens, name));
  return c.a === 1 ? c : composite(c, parseColor(resolve(tokens, over)));
}

export function renderContrastTable(root: HTMLElement, tokens: Map<string, string>): void {
  const doc = root.ownerDocument;
  const table = doc.createElement('table');
  table.className = 'gallery-contrast';
  table.innerHTML = '<thead><tr><th>Foreground</th><th>Surface</th><th>Ratio</th><th>Bar</th></tr></thead>';
  const body = doc.createElement('tbody');
  for (const [fg, bg, bar] of PAIRS) {
    const ratio = contrast(solid(tokens, fg, bg), solid(tokens, bg));
    const tr = doc.createElement('tr');
    tr.dataset.pair = `${fg}/${bg}`;
    tr.dataset.pass = String(ratio >= bar);
    tr.innerHTML = `<td><i class="swatch" style="background: var(${fg})"></i>${fg}</td><td><i class="swatch" style="background: var(${bg})"></i>${bg}</td><td>${ratio.toFixed(2)}</td><td>${bar}:1</td>`;
    body.appendChild(tr);
  }
  table.appendChild(body);
  root.replaceChildren(table);
}

if (typeof document !== 'undefined' && document.getElementById('contrast')) {
  const css = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } }).join('\n');
  renderContrastTable(document.getElementById('contrast')!, readTokens(css));
  const crt = document.getElementById('crt') as HTMLInputElement;
  crt.addEventListener('change', () => document.body.classList.toggle('s2u-crt', crt.checked));
  const typed = document.getElementById('typed-text');
  if (typed) void typeInto(typed, typed.dataset.text ?? '', 40);
  const nav = document.querySelector('.s2u-bar__nav')!;
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) nav.querySelectorAll('a').forEach((a) => a.classList.toggle('is-on', a.getAttribute('href') === `#${e.target.id}`));
  }, { rootMargin: '-40% 0px -55% 0px' });
  document.querySelectorAll('section[id]').forEach((s) => io.observe(s));
}
