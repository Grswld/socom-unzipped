// @vitest-environment node
//
// Node, not the project default jsdom: under jsdom, Vite's static-analysis transform for
// `new URL(dynamicTemplate, import.meta.url)` mis-resolves the base to a path missing the repo's root
// segments (a Vite/jsdom interaction, not a bug in this file's logic -- confirmed by a minimal repro:
// the same expression resolves correctly under `node`). This file is fs/crypto only, no DOM.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { parseColor, composite, contrast, readTokens, resolve } from './contrast';
import { generate } from '../tools/gen-tokens.mjs';

const here = (f: string) => new URL(`./${f}`, import.meta.url);
const json = readFileSync(here('tokens.json'), 'utf-8');
const css = readFileSync(here('tokens.css'), 'utf-8');
const version = readFileSync(here('VERSION'), 'utf-8').trim();
const tokens = readTokens(css);
const ARTIFACT_SHA = '85a909c21044a95c7f73e97cd34c96f8877a9ad0de3c2c753b3ee66d5fdbcdf1';

const solid = (name: string, over = '--s2u-ground') => {
  const c = parseColor(resolve(tokens, name));
  return c.a === 1 ? c : composite(c, parseColor(resolve(tokens, over)));
};

/* spec 4.3: [foreground, surface, bar] */
const PAIRS: [string, string, number][] = [];
for (const fg of ['--s2u-gold', '--s2u-gold-display', '--s2u-text', '--s2u-text-strong', '--s2u-text-dim', '--s2u-glyph-triangle', '--s2u-glyph-cross', '--s2u-warn'])
  for (const bg of ['--s2u-ground', '--s2u-panel', '--s2u-tab', '--s2u-tab-lit']) PAIRS.push([fg, bg, 4.5]);
for (const bg of ['--s2u-ground', '--s2u-panel', '--s2u-tab', '--s2u-tab-lit']) PAIRS.push(['--s2u-glyph-square', bg, 3], ['--s2u-focus', bg, 3]);
PAIRS.push(['--s2u-text-strong', '--s2u-highlight', 4.5], ['--s2u-focus', '--s2u-highlight', 3]);
PAIRS.push(['--s2u-cyan-boot', '--s2u-ground-deep', 4.5], ['--s2u-ground', '--s2u-gold', 4.5]);

describe('tokens.json', () => {
  it('is the artifact’s file, byte for byte', () => {
    expect(createHash('sha256').update(json).digest('hex')).toBe(ARTIFACT_SHA);
  });
});

describe('tokens.css', () => {
  it('is exactly what gen-tokens.mjs writes from tokens.json (never edit it by hand)', () => {
    expect(css).toBe(generate(JSON.parse(json), version));
  });
  it('declares the cascade layer order first', () => {
    expect(css.trimStart().startsWith('@layer s2u.tokens, s2u.base, s2u.components;')).toBe(true);
  });
  it('carries the VERSION', () => {
    expect(/^\d+\.\d+\.\d+$/.test(version)).toBe(true);
    expect(resolve(tokens, '--s2u-version')).toBe(`"${version}"`);
  });
  it('names every token --s2u-*', () => {
    for (const k of tokens.keys()) expect(k.startsWith('--s2u-')).toBe(true);
  });
  it.each(['--s2u-ground', '--s2u-panel', '--s2u-tab', '--s2u-tab-lit', '--s2u-highlight', '--s2u-gold', '--s2u-gold-display', '--s2u-text', '--s2u-text-strong', '--s2u-text-dim', '--s2u-focus', '--s2u-warn', '--s2u-panel-edge'])('%s is a colour', (n) => {
    expect(() => parseColor(resolve(tokens, n))).not.toThrow();
  });
  it.each(PAIRS)('%s on %s clears %s:1', (fg, bg, bar) => {
    expect(contrast(solid(fg, bg), solid(bg))).toBeGreaterThanOrEqual(bar);
  });
  it('gold-source fails on panel, by design, so the guard can name it', () => {
    expect(contrast(solid('--s2u-gold-source'), solid('--s2u-panel'))).toBeLessThan(4.5);
  });
  it('generates the type styles as shorthands', () => {
    expect(resolve(tokens, '--s2u-type-tab')).toBe('600 18px/24px var(--s2u-font-label)');
    expect(resolve(tokens, '--s2u-tracking-tab')).toBe('0.08em');
    expect(resolve(tokens, '--s2u-italic-screen-title')).toBe('italic');
    expect(resolve(tokens, '--s2u-italic-body')).toBe('normal');
    expect(resolve(tokens, '--s2u-tracking-body')).toBe('0');
    expect(resolve(tokens, '--s2u-type-readout')).toBe('500 13px/18px var(--s2u-font-mono)');
  });
  it('carries the families, spacing, radius, shadow and opacity', () => {
    expect(resolve(tokens, '--s2u-font-label')).toContain('Oswald');
    expect(resolve(tokens, '--s2u-font-display')).toContain('Saira Condensed Fallback');
    expect(resolve(tokens, '--s2u-space-4')).toBe('16px');
    expect(resolve(tokens, '--s2u-tab-w')).toBe('230px');
    expect(resolve(tokens, '--s2u-radius-0')).toBe('0px');
    expect(resolve(tokens, '--s2u-panel-inset')).toBe('inset 0 0 0 1px #061a1c');
    expect(resolve(tokens, '--s2u-scanline')).toBe('0.10');
    expect(resolve(tokens, '--s2u-disabled')).toBe('0.45');
  });
});
