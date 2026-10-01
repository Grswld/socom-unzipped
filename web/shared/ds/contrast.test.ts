import { describe, it, expect } from 'vitest';
import { parseColor, composite, luminance, contrast, readTokens, resolve } from './contrast';

describe('parseColor', () => {
  it('reads hex (3, 6, 8 digits) and rgba', () => {
    expect(parseColor('#000e11')).toEqual({ r: 0, g: 14, b: 17, a: 1 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#dcb85c66')).toEqual({ r: 220, g: 184, b: 92, a: 0.4 });
    expect(parseColor('rgba(10, 30, 36, 0.78)')).toEqual({ r: 10, g: 30, b: 36, a: 0.78 });
  });
  it('refuses anything else', () => {
    expect(() => parseColor('var(--s2u-gold)')).toThrow(/not a colour/);
  });
});

describe('composite, luminance, contrast', () => {
  it('composites alpha over opaque', () => {
    expect(composite(parseColor('#dcb85c66'), parseColor('#000000'))).toEqual({ r: 88, g: 74, b: 37, a: 1 });
  });
  it('matches the artifact’s table', () => {
    expect(contrast(parseColor('#c4a04a'), parseColor('#093535'))).toBeCloseTo(5.39, 2);
    expect(contrast(parseColor('#8a9a9c'), parseColor('#093535'))).toBeCloseTo(4.57, 2);
    expect(contrast(parseColor('#dfe4e5'), parseColor('#0d595c'))).toBeCloseTo(6.29, 2);
    expect(contrast(parseColor('#786e3b'), parseColor('#002933'))).toBeCloseTo(3.0, 1);
    expect(contrast(parseColor('#ffffff'), parseColor('#000000'))).toBeCloseTo(21, 2);
  });
  it('is symmetric; white is 1, black is 0', () => {
    const a = parseColor('#c4a04a'), b = parseColor('#002933');
    expect(contrast(a, b)).toBe(contrast(b, a));
    expect(luminance(parseColor('#fff'))).toBeCloseTo(1, 6);
    expect(luminance(parseColor('#000'))).toBe(0);
  });
});

describe('readTokens and resolve', () => {
  const css = `@layer s2u.tokens { :root { --s2u-gold: #c4a04a; --s2u-x: var(--s2u-gold); --s2u-y: var(--s2u-x); } }`;
  it('reads every declaration and follows var chains', () => {
    const t = readTokens(css);
    expect(t.get('--s2u-gold')).toBe('#c4a04a');
    expect(resolve(t, '--s2u-y')).toBe('#c4a04a');
  });
  it('throws on an unknown name', () => {
    expect(() => resolve(readTokens(css), '--s2u-nope')).toThrow(/--s2u-nope/);
  });
});
