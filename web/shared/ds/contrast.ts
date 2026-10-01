/* Colour maths for the design system: the WCAG 2 contrast formula, alpha compositing, and a reader for the
   custom properties in tokens.css. Pure; used by tokens.test.ts and the gallery's readout. */
export interface Rgba { r: number; g: number; b: number; a: number }

export function parseColor(s: string): Rgba {
  const t = s.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) { const [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16)); return { r, g, b, a: 1 }; }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t);
  if (m) {
    const n = parseInt(m[1], 16);
    const a = m[2] ? Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000 : 1;
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(t);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error(`not a colour: ${s}`);
}

export function composite(fg: Rgba, bg: Rgba): Rgba {
  const mix = (f: number, b: number) => Math.round(fg.a * f + (1 - fg.a) * b);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `--name: value;` declaration in the text; the last one wins. */
export function readTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.set(m[1], m[2].trim());
  return out;
}

/** Follow `var(--x)` chains to the literal at the end. */
export function resolve(tokens: Map<string, string>, name: string, depth = 0): string {
  const v = tokens.get(name);
  if (v === undefined) throw new Error(`unknown token ${name}`);
  if (depth > 16) throw new Error(`token loop at ${name}`);
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v);
  return m ? resolve(tokens, m[1], depth + 1) : v;
}
