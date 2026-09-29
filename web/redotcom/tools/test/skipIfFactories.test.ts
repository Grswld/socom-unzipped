import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The fixture-backed suites skip without game data (`describe.skipIf(!FIXTURE)`), but vitest still RUNS a skipped
 * describe's factory to collect its tests: only the `it`/hook bodies are skipped. A factory statement that
 * dereferences the absent fixture (`parseZdb(MP2!)` at the describe level) therefore throws at collection and fails
 * the whole file on a machine without fixtures -- CI, a fresh clone (release review BL-7: effectModels.test.ts made
 * web.yml red). This guard reads every test file and refuses a non-null assertion executed at collection time inside
 * a `describe.skipIf(` factory: it belongs in a `beforeAll`, an `it`, or a lazy arrow (`const lib = () => ...`).
 */

const REDOTCOM = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'e2e') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.test\.ts$/.test(e.name) && p !== SELF) out.push(p);   // this file quotes the pattern it refuses
  }
  return out;
}

const indent = (line: string): number => line.length - line.trimStart().length;
/** A call whose callback vitest defers: a test or a hook. Its body is not run at collection. */
const DEFERRED = /^(it|test)(\.\w+)*[(`]|^(beforeAll|beforeEach|afterAll|afterEach)\(/;
/** A non-null assertion used as a value (`x!)`, `x!,`, `x!.y`, `x![0]`, `x!;`), not `!=`/`!==`. */
const NON_NULL = /[\w\])]!(?!=)(?=[),.;\[\s])/;

/** Lines (1-based) of `source` inside a `describe.skipIf(` factory that dereference with `!` at collection time. */
export function eagerDerefs(source: string): number[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const bad: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/describe\.skipIf\(/.test(lines[i]!)) continue;
    const base = indent(lines[i]!);
    // The factory runs until the line that closes the describe at its own indentation.
    let end = i + 1;
    while (end < lines.length && !(indent(lines[end]!) === base && /^[})]/.test(lines[end]!.trim()))) end++;
    for (let j = i + 1; j < end; j++) {
      const line = lines[j]!;
      const text = line.trim();
      if (text === '' || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue;
      // A test, a hook, or a function (arrow or declared): its body runs only when called.
      if (DEFERRED.test(text) || text.includes('=>') || /^(export\s+)?(async\s+)?function\b/.test(text)) {
        // Skip the deferred body: a one-line call ends here; otherwise at the closer at the call's indentation.
        if (/\);?\s*$/.test(text) && !/[{(]\s*$/.test(text)) continue;
        const at = indent(line);
        let k = j + 1;
        while (k < end && !(indent(lines[k]!) === at && /^[})]/.test(lines[k]!.trim()))) k++;
        j = k;
        continue;
      }
      if (NON_NULL.test(text.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''"))) bad.push(j + 1);
    }
  }
  return bad;
}

describe('describe.skipIf factories do not dereference an absent fixture at collection (BL-7)', () => {
  it('the scanner refuses the eager form and passes the lazy ones', () => {
    const eager = [
      "describe.skipIf(!MP2)('x', () => {",
      '  const toc = parseZdb(MP2!);',
      "  it('a', () => { expect(toc).toBeTruthy(); });",
      '});',
    ].join('\n');
    expect(eagerDerefs(eager)).toEqual([2]);
    const lazy = [
      "describe.skipIf(!MP2)('x', () => {",
      '  let toc: Toc;',
      '  beforeAll(() => {',
      '    toc = parseZdb(MP2!);',
      '  });',
      '  const file = (): Toc => parseZdb(MP2!);',
      '  const load = (): Toc => {',
      '    const toc = parseZdb(MP2!);',
      '    return toc;',
      '  };',
      '  function pick(): Toc {',
      '    return parseZdb(MP2!);',
      '  }',
      "  it('a', () => {",
      '    expect(parseZdb(MP2!)).toBeTruthy();',
      '  });',
      "  it('b', () => expect(MP2!.length).toBe(1));",
      '  if (a !== b) done();',
      '});',
    ].join('\n');
    expect(eagerDerefs(lazy)).toEqual([]);
  });

  it('no test file under web/redotcom has one', () => {
    const found = testFiles(REDOTCOM).flatMap((f) =>
      eagerDerefs(readFileSync(f, 'utf8')).map((n) => `${relative(REDOTCOM, f).replace(/\\/g, '/')}:${n}`));
    expect(found).toEqual([]);
  });
});
