import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve as p, dirname } from 'path';
import { SELECTORS } from './selectors';
import { readTokens } from './contrast';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(p(here, f), 'utf-8');
const base = read('base.css'), components = read('components.css'), fonts = read('fonts.css'), index = read('index.css'), tokensCss = read('tokens.css'), homeCss = read('../../landing/src/home.css');
const tokens = readTokens(tokensCss + base);

/* ---- the guards: pure functions over CSS text. Each returns what it refuses (empty = clean), so the file
   tests below run them over the real stylesheets and the adversarial tests at the foot run them over a string
   that carries the hole each one closes. ---- */

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const outsideReducedMotion = (css: string) => strip(css).replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{(?:[^{}]|{[^{}]*})*}/g, '');
/** every `selector { body }` pair, at-rule bodies included (the nested blocks read as their own rules) */
const rules = (css: string): [string, string][] => [...strip(css).matchAll(/([^{}]+){([^{}]*)}/g)].map(([, sel, body]) => [sel.trim(), body]);
/** the `prop: value` pairs of one rule body */
const declarations = (body: string): [string, string][] => body.split(';').flatMap((d) => {
  const i = d.indexOf(':');
  return i < 0 ? [] : [[d.slice(0, i).trim(), d.slice(i + 1).trim()]];
});
/** split a value on the commas that are not inside parentheses */
const topLevelParts = (value: string): string[] => {
  const parts: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
};

/* transparent, currentColor, none and the system keywords carry no hue; everything else is a literal */
const COLOUR = /(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![\w-])(white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver)(?![\w-]))/i;
/** the lines that carry a colour literal (a data URI's own colours are the data-URI guard's) */
const colourLiterals = (css: string): string[] => strip(css).split('\n').filter((l) => COLOUR.test(l) && !/data:image\//.test(l));

/** every !important (any spacing, any case) outside prefers-reduced-motion */
const importants = (css: string): string[] => outsideReducedMotion(css).match(/!\s*important/gi) ?? [];

/** the --s2u-* names a stylesheet references that no token or base rule declares */
const missingTokens = (css: string, known: Map<string, string>): string[] => {
  const refs = [...strip(css).matchAll(/var\((--s2u-[a-z0-9-]+)/g)].map((m) => m[1]);
  return [...new Set(refs)].filter((r) => !known.has(r) && r !== '--s2u-progress');
};

/** the custom properties a page stylesheet may reference: a --s2u-* the tokens or base declare, a --pg-* its own
    first :root block declares, the wheel's --i stagger index and the progress bar's --s2u-progress (set by script).
    Anything else (an old page token such as --gutter or --max) resolves to nothing in the browser, in silence. */
const unknownVars = (css: string, known: Map<string, string>): string[] => {
  const clean = strip(css);
  const own = new Set([...(/:root\s*{([^}]*)}/.exec(clean)?.[1] ?? '').matchAll(/(--pg-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const refs = [...clean.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]);
  return [...new Set(refs)].filter((r) => !(r.startsWith('--s2u-') && known.has(r)) && !own.has(r) && r !== '--i' && r !== '--s2u-progress');
};

const SIDE = '(top|right|bottom|left|inline-start|inline-end|block-start|block-end)';
const EDGE_PROP = new RegExp(`^border(-${SIDE})?(-width)?$`);
const BORDER_COLOUR_PROP = new RegExp(`^border(-${SIDE})?(-color)?$`);
const tokenColours = (value: string) => [...value.matchAll(/var\((--s2u-[a-z0-9-]+)\)/g)].map((m) => m[1]);
const pxWidth = (value: string) => { const m = /(?<![\w.-])(\d+(?:\.\d+)?)px/.exec(value); return m ? Number(m[1]) : 0; };
/** an edge 2px or wider in a token colour other than --s2u-warn (the EXPERIMENTAL rule's exception); a `-width`
    longhand takes its colour from the rule's other border declarations; a transparent edge names no token */
const widenedEdges = (css: string): string[] => {
  const bad: string[] = [];
  for (const [sel, body] of rules(css)) {
    const decls = declarations(body);
    const bodyColours = decls.filter(([prop]) => BORDER_COLOUR_PROP.test(prop)).flatMap(([, v]) => tokenColours(v));
    for (const [prop, value] of decls) {
      if (!EDGE_PROP.test(prop) || pxWidth(value) < 2) continue;
      const colours = (prop.endsWith('-width') ? bodyColours : tokenColours(value)).filter((c) => c !== '--s2u-warn');
      if (colours.length) bad.push(`${sel} { ${prop}: ${value} }`);
    }
  }
  return bad;
};

const SHADOW_PART = /^(var\(--s2u-(title-glow|story-glow|panel-inset|viewer-lift)\)|none|inset 0 (-1|1)px 0 var\(--s2u-panel-edge\)|inset 0 0 0 1px var\(--s2u-warn\)|0 0 0 2px var\(--s2u-panel-edge\))$/;
/** every box-shadow part (split on top-level commas) that is not a token, a 1px rule or the lamp bezel */
const shadowsOffAllowlist = (css: string): string[] => {
  const bad: string[] = [];
  for (const [sel, body] of rules(css)) for (const [prop, value] of declarations(body)) {
    if (prop !== 'box-shadow') continue;
    for (const part of topLevelParts(value)) if (!SHADOW_PART.test(part)) bad.push(`${sel} { box-shadow: … ${part} … }`);
  }
  return bad;
};

/** a consumer outside the system: no import, from, href or @import reaching /ds/, no --s2u- token, no .s2u- class */
const boundaryViolations = (text: string): string[] => text.split('\n').filter((l) =>
  (/\b(import|from)\b|href=/.test(l) && /\/ds\//.test(l)) || /--s2u-|\.s2u-/.test(l));
/** the modules a TypeScript file imports statically by a relative path, as file names */
const staticImports = (ts: string): string[] => [...ts.matchAll(/^\s*(?:import|export)[^;]*?\bfrom\s+'(\.\/[^']+)'/gm)].map((m) => `${m[1]}.ts`);

const RADIUS_PROP = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
/** every border-radius that is not a radius token or the circle */
const offRadii = (css: string): string[] => {
  const bad: string[] = [];
  for (const [sel, body] of rules(css)) for (const [prop, value] of declarations(body)) {
    if (RADIUS_PROP.test(prop) && !/^(var\(--s2u-radius-[a-z0-9-]+\)|50%)$/.test(value)) bad.push(`${sel} { ${prop}: ${value} }`);
  }
  return bad;
};

const PROPS = new RegExp(`^(color|background|background-image|background-color|border(-${SIDE})?-color|fill|stroke|box-shadow|text-shadow|outline|outline-color|accent-color|caret-color|border(-${SIDE})?|border-inline|border-block|filter|text-decoration|text-decoration-color|scrollbar-color|-webkit-text-fill-color|mask|mask-image)$`);
const ALLOWED = /var\(--s2u-[a-z0-9-]+\)|transparent|currentColor|none|inherit|initial|CanvasText|repeating-linear-gradient|linear-gradient|color-mix\(in srgb|url\("data:image\/svg\+xml[^"]*"\)|inset|solid|underline|to bottom|to right|calc\([\d\s.%a-z+*/-]*\)|blur|drop-shadow|-?\d+(\.\d+)?(px|em|%|deg)?|[\s,/()]/g;
/** every colour-bearing declaration whose value is not tokens and keywords only */
const offTokenDeclarations = (css: string): string[] => {
  const bad: string[] = [];
  for (const [sel, body] of rules(css)) for (const [prop, value] of declarations(body)) {
    if (!PROPS.test(prop)) continue;
    const rest = value.replace(ALLOWED, '').trim();
    if (rest) bad.push(`${sel} { ${prop}: ${value} } leaves "${rest}"`);
  }
  return bad;
};

/** every %23xxxxxx colour inside a data URI that is not a colour value of tokens.css */
const dataUriColoursOffTokens = (css: string, tokensText: string): string[] => {
  const known = new Set([...tokensText.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1].toLowerCase()));
  return [...css.matchAll(/%23([0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase()).filter((hex) => !known.has(hex)).map((hex) => `%23${hex}`);
};

/* ---- the files ---- */

describe('index.css', () => {
  it('imports the four files in layer order', () => {
    expect([...index.matchAll(/@import\s+'([^']+)'/g)].map((m) => m[1])).toEqual(['./tokens.css', './fonts.css', './base.css', './components.css']);
  });
});

describe.each([['base.css', base, 's2u.base'], ['components.css', components, 's2u.components'], ['fonts.css', fonts, 's2u.base'], ['home.css', homeCss, null]])('%s', (_n, css, layer) => {
  it('is wrapped in its layer', () => {
    if (layer === null) return; // home.css: not wrapped in a layer, so it stays unlayered and wins every tie
    expect(strip(css).trimStart().startsWith(`@layer ${layer} {`)).toBe(true);
  });
  it('holds no colour literal (tokens.css owns them; home.css may declare its own page tokens in one :root block)', () => {
    const bad = colourLiterals(css.replace(/:root\s*{[^}]*}/, ''));
    expect(bad, bad.join('\n')).toEqual([]);
  });
  it('uses !important only under prefers-reduced-motion', () => {
    expect(importants(css)).toEqual([]);
  });
  it('every var(--s2u-…) it references exists', () => {
    expect(missingTokens(css, tokens)).toEqual([]);
  });
  it('references no custom property but the system’s, its own --pg-* and the two the scripts set', () => {
    if (layer !== null) return; // the system's own files: missingTokens above, and they declare what they use
    const bad = unknownVars(css, tokens);
    expect(bad, bad.join('\n')).toEqual([]);
  });
  it('never widens an edge past 1px in a token colour (warn excepted)', () => {
    const bad = widenedEdges(css);
    expect(bad, bad.join('\n')).toEqual([]);
  });
  it('gives no element a shadow but the tokens, the 1px rules and the lamp bezel, in every part', () => {
    const bad = shadowsOffAllowlist(css);
    expect(bad, bad.join('\n')).toEqual([]);
  });
  it('rounds a corner only by a radius token or the circle', () => {
    const bad = offRadii(css);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('the boundary', () => {
  it('gold-source is refused in components; cyan-boot only in the boot typewriter', () => {
    for (const [sel, body] of rules(components)) {
      expect(body, sel).not.toMatch(/--s2u-gold-source/);
      if (/--s2u-cyan-boot/.test(body)) expect(sel).toMatch(/^\.s2u-typed--boot/);
    }
  });
  const main = read('../../landing/src/main.ts');
  // classic's files are the landing site's (web/landing); the system lives in web/shared/ds since 2026-09-29
  const consumers = ['../../landing/src/style.css', '../../landing/src/main.ts', '../../landing/classic.html', ...staticImports(main).map((f) => `../../landing/src/${f}`)];
  it('classic follows its static imports', () => {
    expect(consumers.length).toBeGreaterThan(4);
  });
  it.each(consumers)('%s imports nothing from ds/ and speaks no s2u token or class', (f) => {
    const bad = boundaryViolations(read(f));
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('text-dim is never set under 13px (briefing README, Colour)', () => {
  it('holds in every component rule', () => {
    for (const [sel, body] of rules(components)) {
      if (!/--s2u-text-dim/.test(body)) continue;
      const px = /font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/.exec(body)?.[1];
      if (px) expect(+px, sel).toBeGreaterThanOrEqual(13);
      const small = /var\(--s2u-type-(stat-caption|readout-caption)\)/.test(body);
      if (small) expect(sel, `${sel} uses an 11px style with text-dim`).toMatch(/s2u-stat__k|s2u-tile|s2u-card__num|s2u-tab__what|s2u-fine|s2u-status|s2u-overlay|s2u-label/);
    }
  });
});

describe('every colour-bearing declaration is tokens and keywords only', () => {
  it.each([['base.css', base], ['components.css', components]])('%s', (_n, css) => {
    const bad = offTokenDeclarations(css);
    expect(bad, bad.join('\n')).toEqual([]);
  });
  it('every colour inside a data URI is a token colour (the select chevron is gold)', () => {
    expect(dataUriColoursOffTokens(components, tokensCss)).toEqual([]);
    expect(components).toContain('%23c4a04a');
    expect(tokensCss).toMatch(/--s2u-gold:\s*#c4a04a;/);
  });
});

describe('the spec’s selectors exist', () => {
  it.each(SELECTORS)('%s', (sel) => {
    expect(base + components).toContain(sel);
  });
});

describe('disabled states the system owns (fix round 1: the viewer lost these to the vendored rewrite)', () => {
  it.each(['.s2u-field select:disabled', '.s2u-label:disabled', '.s2u-iconbtn:disabled'])(
    'components.css has a :disabled rule reaching %s',
    (sel) => {
      const hit = rules(components).some(([s]) => s.split(',').map((part) => part.trim()).includes(sel));
      expect(hit, sel).toBe(true);
    },
  );
});

describe('the final wave: the bar’s nav shows that it scrolls, lists take the measure', () => {
  const ruleFor = (sel: string) => rules(components).filter(([s]) => s === sel).map(([, body]) => body).join(';');
  it('.s2u-bar__nav declares a mask-image (the last visible link fades instead of cutting flat)', () => {
    expect(ruleFor('.s2u-bar__nav')).toMatch(/(^|;)\s*mask-image:\s*linear-gradient\(to right/);
    expect(ruleFor('.s2u-bar__nav')).toMatch(/(^|;)\s*-webkit-mask-image:/);
  });
  it('.s2u-bar__end never shrinks under the scrolling nav', () => {
    expect(ruleFor('.s2u-bar__end')).toMatch(/(^|;)\s*flex:\s*none/);
  });
  it('the measure rule’s selector list includes .s2u-panel__body ul and ol', () => {
    const measure = rules(components).filter(([, body]) => /^\s*max-width:\s*var\(--s2u-measure\);?\s*$/.test(body)).map(([sel]) => sel.split(',').map((s) => s.trim()));
    const lists = measure.find((sels) => sels.includes('.s2u-panel__body p'));
    expect(lists, 'the measure rule on .s2u-panel__body p').toBeDefined();
    expect(lists).toContain('.s2u-panel__body ul');
    expect(lists).toContain('.s2u-panel__body ol');
  });
});

describe('the layout pass (the owner’s review of the live site, 2026-09-28)', () => {
  const ruleFor = (sel: string) => rules(components).filter(([s]) => s.split(',').map((p) => p.trim()).includes(sel)).map(([, body]) => body).join(';');
  it('.s2u-panel__body grows like .s2u-card__body, so paired panels in a grid share a height', () => {
    expect(ruleFor('.s2u-panel__body')).toMatch(/(^|;)\s*flex:\s*1\b/);
  });
  it('a link in a panel head or a card title takes the head’s gold, underlined in gold mixed against the panel, full gold when pointed at, ↗ when it leaves the site', () => {
    const rest = ruleFor('.s2u-panel__head a');
    expect(rest).toMatch(/(^|;)\s*color:\s*var\(--s2u-gold\)/);
    expect(rest).toMatch(/text-decoration-color:\s*color-mix\(in srgb, var\(--s2u-gold\) \d+%, var\(--s2u-panel\)\)/);
    expect(ruleFor('.s2u-card > h3 a')).toBe(rest);
    expect(ruleFor('.s2u-panel__head a:hover')).toMatch(/text-decoration-color:\s*var\(--s2u-gold\)/);
    expect(ruleFor('.s2u-panel__head a:focus-visible')).toMatch(/text-decoration-color:\s*var\(--s2u-gold\)/);
    expect(ruleFor('.s2u-panel__head a[target="_blank"]::after')).toMatch(/content:\s*'\s?↗'/);
  });
  it('home.css declares the page rhythm once, in its :root block, every step a space token', () => {
    const root = /:root\s*{([^}]*)}/.exec(strip(homeCss))![1];
    for (const v of ['--pg-section-pad', '--pg-head-gap', '--pg-block-gap', '--pg-group-above', '--pg-group-below', '--pg-fine-gap'])
      expect(root, v).toMatch(new RegExp(`${v}:\\s*var\\(--s2u-space-\\d+\\)`));
  });
});

/* ---- the holes each guard closes, as strings ---- */

describe('the guards, adversarially', () => {
  it('edge: a 2px-or-wider border in any token colour but warn, in every form', () => {
    expect(widenedEdges('.a { border-top: 3px solid var(--s2u-gold); }')).toHaveLength(1);
    expect(widenedEdges('.b { border: 12px solid var(--s2u-panel); }')).toHaveLength(1);
    expect(widenedEdges('.c { border-inline-start: 2px solid var(--s2u-tab); }')).toHaveLength(1);
    expect(widenedEdges('.d { border-block-end-width: 2.5px; border-block-end-color: var(--s2u-text-dim); }')).toHaveLength(1);
    expect(widenedEdges('.e { border-width: 4px; border-style: solid; border-color: var(--s2u-panel-edge); }')).toHaveLength(1);
    expect(widenedEdges('.f { border-left: 2px solid var(--s2u-warn); }')).toEqual([]);
    expect(widenedEdges('.g { border: 5px solid transparent; border-left-color: var(--s2u-text-dim); }')).toEqual([]);
    expect(widenedEdges('.h { border: 1px solid var(--s2u-panel-edge); border-bottom: 0; }')).toEqual([]);
  });
  it('shadow: every part of a comma list is checked, not only the first', () => {
    expect(shadowsOffAllowlist('.a { box-shadow: var(--s2u-panel-inset), 0 4px 12px var(--s2u-gold); }')).toHaveLength(1);
    expect(shadowsOffAllowlist('.b { box-shadow: 0 0 0 2px var(--s2u-panel-edge), 0 0 0 4px var(--s2u-gold); }')).toHaveLength(1);
    expect(shadowsOffAllowlist('.c { box-shadow: inset 0 0 0 2px var(--s2u-warn); }')).toHaveLength(1);
    expect(shadowsOffAllowlist('.d { box-shadow: var(--s2u-viewer-lift), var(--s2u-panel-inset); }')).toEqual([]);
    expect(topLevelParts('a(1, 2), b, c(d(3, 4))')).toEqual(['a(1, 2)', 'b', 'c(d(3, 4))']);
  });
  it('!important: any spacing, any case, outside reduced motion only', () => {
    expect(importants('.a { color: var(--s2u-text) ! important; }')).toHaveLength(1);
    expect(importants('.b { color: var(--s2u-text)!IMPORTANT; }')).toHaveLength(1);
    expect(importants('@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }')).toEqual([]);
  });
  it('boundary: a reach into ds/ on an import, from, href or @import line, or any s2u token or class', () => {
    expect(boundaryViolations("import { typeInto } from '../ds/typed';")).toHaveLength(1);
    expect(boundaryViolations("@import './ds/index.css';")).toHaveLength(1);
    expect(boundaryViolations('<link rel="stylesheet" href="/src/ds/index.css">')).toHaveLength(1);
    expect(boundaryViolations('el.classList.add(".s2u-tab");')).toHaveLength(1);
    expect(boundaryViolations('.menu { color: var(--s2u-gold); }')).toHaveLength(1);
    expect(boundaryViolations("import { move } from './roller';\n.menu { color: #c4a04a; }")).toEqual([]);
    expect(staticImports("import { a } from './roller';\nimport type { T } from './about';\nexport { X } from './github';\nimport './style.css';")).toEqual(['./roller.ts', './about.ts', './github.ts']);
  });
  it('radius: a literal radius, on the shorthand or a corner', () => {
    expect(offRadii('.a { border-radius: 6px; }')).toHaveLength(1);
    expect(offRadii('.b { border-top-left-radius: var(--s2u-space-2); }')).toHaveLength(1);
    expect(offRadii('.c { border-radius: var(--s2u-radius-viewer); } .d { border-radius: 50%; }')).toEqual([]);
  });
  it('token declarations: filter, text-decoration, scrollbar-color, fill-color, logical borders and masks are read', () => {
    expect(offTokenDeclarations('.a { filter: blur(2px) brightness(1.2); }')).toHaveLength(1);
    expect(offTokenDeclarations('.b { text-decoration: underline wavy red; }')).toHaveLength(1);
    expect(offTokenDeclarations('.c { scrollbar-color: rgb(0 0 0) auto; }')).toHaveLength(1);
    expect(offTokenDeclarations('.d { -webkit-text-fill-color: gold; }')).toHaveLength(1);
    expect(offTokenDeclarations('.e { border-inline-start: 1px solid #061a1c; }')).toHaveLength(1);
    expect(offTokenDeclarations('.f { mask-image: radial-gradient(circle, black, transparent); }')).toHaveLength(1);
    expect(offTokenDeclarations('.g { filter: blur(0.45px) drop-shadow(0 0 2px var(--s2u-gold)); text-decoration: none; border-block: 1px solid var(--s2u-panel-edge); }')).toEqual([]);
    expect(offTokenDeclarations('.h { mask-image: linear-gradient(to right, var(--s2u-ground) calc(100% - 28px), transparent); }')).toEqual([]);
    expect(offTokenDeclarations('.i { mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); }')).toHaveLength(1);
    // a color-mix of two tokens is tokens only; a literal inside it is still a literal
    expect(offTokenDeclarations('.j { text-decoration-color: color-mix(in srgb, var(--s2u-gold) 45%, var(--s2u-panel)); }')).toEqual([]);
    expect(offTokenDeclarations('.k { text-decoration-color: color-mix(in srgb, #c4a04a 45%, var(--s2u-panel)); }')).toHaveLength(1);
  });
  it('unknown vars: an old page token, a --pg-* declared nowhere, a --s2u-* the tokens do not know', () => {
    const t = new Map([['--s2u-gutter', '24px'], ['--s2u-max', '1200px']]);
    expect(unknownVars('.hero { padding: 96px var(--gutter) 84px; }', t)).toEqual(['--gutter']);
    expect(unknownVars(':root { --pg-shade-1: rgba(0, 14, 17, 0.9); } .a { max-width: var(--max); background: var(--pg-shade-2); color: var(--s2u-nothing); }', t))
      .toEqual(['--max', '--pg-shade-2', '--s2u-nothing']);
    expect(unknownVars(':root { --pg-shade-1: rgba(0, 14, 17, 0.9); } .a { padding: var(--s2u-gutter); max-width: var(--s2u-max); background: var(--pg-shade-1); animation-delay: calc(var(--i, 0) * 60ms); width: calc(var(--s2u-progress) * 100%); }', t)).toEqual([]);
  });
  it('data URI: a colour that is not one of the tokens', () => {
    const t = ':root { --s2u-gold: #c4a04a; }';
    expect(dataUriColoursOffTokens("url(\"data:image/svg+xml,%3Cpath stroke='%23ff0000'/%3E\")", t)).toEqual(['%23ff0000']);
    expect(dataUriColoursOffTokens("url(\"data:image/svg+xml,%3Cpath stroke='%23C4A04A'/%3E\")", t)).toEqual([]);
  });
});
