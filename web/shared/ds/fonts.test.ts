import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve as p, dirname } from 'path';
import { createHash } from 'crypto';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(p(here, 'fonts.css'), 'utf-8');
const pub = p(here, '../fonts');
const FILES = ['oswald-normal-variable-latin.woff2', 'saira-italic-800-latin.woff2', 'jetbrains-mono-normal-variable-latin.woff2'];

describe('fonts.css', () => {
  it('is in the base layer and never reaches Google', () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '').trimStart().startsWith('@layer s2u.base {')).toBe(true);
    expect(css).not.toMatch(/googleapis|gstatic/);
  });
  it.each(FILES)('%s is declared and present', (f) => {
    expect(css).toContain(`url('/fonts/${f}')`);
    expect(existsSync(p(pub, f))).toBe(true);
  });
  it('the Saira face is the condensed width', () => {
    const face = css.match(/@font-face\s*{[^}]*saira-italic-800[^}]*}/)?.[0] ?? '';
    expect(face).toMatch(/font-stretch:\s*62\.5%/);
    expect(face).toMatch(/font-style:\s*italic/);
    expect(face).toMatch(/font-family:\s*'Saira Condensed'/);
  });
  it('every face swaps and keeps the latin range', () => {
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
    expect(faces.length).toBeGreaterThanOrEqual(6);
    for (const f of faces) expect(f).toMatch(/font-display:\s*swap/);
    for (const f of faces.filter((x) => x.includes('url('))) expect(f).toMatch(/unicode-range:/);
  });
  it('the variable faces declare a weight range, not a single instance', () => {
    const oswald = css.match(/@font-face\s*{[^}]*oswald-normal-variable[^}]*}/)?.[0] ?? '';
    expect(oswald).toMatch(/font-weight:\s*400 600/);
    const jbMono = css.match(/@font-face\s*{[^}]*jetbrains-mono-normal-variable[^}]*}/)?.[0] ?? '';
    expect(jbMono).toMatch(/font-weight:\s*400 500/);
  });
  it('no two woff2 files under web/shared/fonts are byte-identical', () => {
    const files = readdirSync(pub).filter((f) => f.endsWith('.woff2'));
    const hashes = files.map((f) => createHash('sha256').update(readFileSync(p(pub, f))).digest('hex'));
    expect(new Set(hashes).size).toBe(files.length);
  });
  it.each(['Oswald Fallback', 'Saira Condensed Fallback', 'JetBrains Mono Fallback'])('%s carries numeric metric overrides', (fam) => {
    const f = css.match(new RegExp(`@font-face\\s*{[^}]*font-family:\\s*'${fam}'[^}]*}`))?.[0];
    expect(f, fam).toBeDefined();
    for (const k of ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override']) expect(f).toMatch(new RegExp(`${k}:\\s*\\d+(\\.\\d+)?%`));
    expect(f).toMatch(/src:\s*local\(/);
  });
  it.each([
    ['Oswald Fallback', /font-weight:\s*400 600;/, /font-style:/, false],
    ['Saira Condensed Fallback', /font-weight:\s*800;/, /font-style:\s*italic;/, true],
    ['JetBrains Mono Fallback', /font-weight:\s*400 500;/, /font-style:/, false],
  ] as const)('%s synthesises the weight (and slant) of the face it stands in for', (fam, weight, style, slanted) => {
    const f = css.match(new RegExp(`@font-face\\s*{[^}]*font-family:\\s*'${fam}'[^}]*}`))?.[0] ?? '';
    expect(f).toMatch(weight);
    if (slanted) expect(f).toMatch(style); else expect(f).not.toMatch(style);
  });
  it('the licences ride along', () => {
    for (const f of ['OFL-oswald.txt', 'OFL-saira.txt', 'OFL-jetbrains-mono.txt']) expect(existsSync(p(pub, f)), f).toBe(true);
  });
});
