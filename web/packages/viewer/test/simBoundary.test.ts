import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shared sim's boundary (web sprint 3, M2; spec W3.R2): `src/sim.ts` and everything it imports by value -- across
 * the viewer and the `@s2u/*` packages -- must run in Node with no renderer: no `three`, no DOM, no Web Audio. Type-only
 * imports are erased and do not count.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '../..');
const ENTRY = resolve(HERE, '../src/sim.ts');

/** The value imports and re-exports of a module's source (`import type` / `export type` skipped). */
function valueImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m[2]) continue;
    // `import { type A, type B } from` is erased too when every name is a type.
    const names = m[3]!.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length && names.every((n) => n.startsWith('type '))) continue;
    out.push(m[4]!);
  }
  const bare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (let m = bare.exec(source); m; m = bare.exec(source)) out.push(m[1]!);
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith('@s2u/')) {
    const [pkg, sub] = spec.slice(5).split('/');
    return resolve(PACKAGES, pkg!, 'src', `${sub ?? 'index'}.ts`);
  }
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const f of [`${base}.ts`, resolve(base, 'index.ts'), base]) if (existsSync(f) && f.endsWith('.ts')) return f;
  return null;
}

function closure(entry: string): { files: Set<string>; external: Map<string, string> } {
  const files = new Set<string>(), external = new Map<string, string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of valueImports(readFileSync(f, 'utf8'))) {
      const r = resolveImport(f, spec);
      if (r) stack.push(r);
      else external.set(spec, f);
    }
  }
  return { files, external };
}

describe('the shared sim runs headless (M2, W3.R2)', () => {
  const { files, external } = closure(ENTRY);

  it('imports no three.js and no module outside Node and the workspace', () => {
    const bad = [...external].filter(([spec]) => !spec.startsWith('node:'));
    expect(bad).toEqual([]);
    expect(files.size).toBeGreaterThan(10);
  });

  it('touches no DOM, no Web Audio, no animation frame', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/\b(document|window|HTMLElement|AudioContext|requestAnimationFrame|localStorage|navigator)\b/.test(code)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it('loads in Node and exposes the mover, the moves and the round', async () => {
    const sim = await import('../src/sim');
    expect(typeof sim.Walker).toBe('function');
    expect(typeof sim.Traversal).toBe('function');
    expect(typeof sim.roundPath).toBe('function');
  });
});
