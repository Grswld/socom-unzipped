import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The placeholder ledger (PL-15 of the launch review): the code's named stand-ins and the research notes' lists of them
 * are held in step.
 *
 * - A value no source gives is a `*_PLACEHOLDER` constant, and a reading the viewer had to choose a `*_READING`
 *   (docs/DATA_SOURCES.md, "Rules read from the game's code"). Every such name in the viewer, server, scene and sound
 *   sources must be listed in a research note's placeholder section -- a section whose heading says "placeholder(s)" or
 *   "reading(s)", down to the next heading of the same or a higher level.
 * - A name a note's placeholder section lists that no source holds any more is either retired -- its row says
 *   resolved, retired, removed, replaced or "was" -- or never was code: its row says *note only* (an open gap in the
 *   research that no constant stands in for).
 */

const root = resolve(import.meta.dirname, '../..');
const SOURCES = ['viewer', 'server', 'scene', 'sound'].map((p) => join(root, 'packages', p, 'src'));
const NOTES = join(root, 'docs', 'research');
const NAME = /\b[A-Z][A-Z0-9_]*_(?:PLACEHOLDER|READING)\b/g;
const SECTION = /placeholder|reading/i;
const RETIRED = /note only|resolved|retired|removed|replaced|\bwas\b/i;

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

/** Every placeholder name in the sources, with the first file that holds it. */
export function codeNames(dirs: readonly string[] = SOURCES): Map<string, string> {
  const names = new Map<string, string>();
  for (const dir of dirs) {
    for (const file of files(dir, /\.ts$/)) {
      for (const m of readFileSync(file, 'utf8').matchAll(NAME)) if (!names.has(m[0])) names.set(m[0], relative(root, file));
    }
  }
  return names;
}

/**
 * A name a note's placeholder section holds on a line. `subject`: the line is about it -- a table row's first cell, or
 * any name on a line that is not a table row -- rather than naming it in passing (a row that cites another's search).
 */
export interface Listed { name: string; note: string; line: number; text: string; subject: boolean }

/**
 * The names a note's placeholder sections list, one entry per name on a line. A section runs from a heading whose text
 * says placeholder(s) or reading(s) to the next heading of the same or a higher level.
 */
export function listedNames(markdown: string, note: string): Listed[] {
  const out: Listed[] = [];
  let inside = 0;   // the heading level of the open section, 0 when none
  let fence = false;
  markdown.split(/\r?\n/).forEach((text, i) => {
    if (/^```/.test(text)) fence = !fence;
    const heading = fence ? null : /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      if (inside && level <= inside) inside = 0;
      if (!inside && SECTION.test(heading[2]!)) inside = level;
      return;
    }
    if (!inside) return;
    const row = /^\s*\|/.test(text);
    const first = row ? text.split('|')[1] ?? '' : text;
    for (const m of text.matchAll(NAME)) {
      out.push({ name: m[0], note, line: i + 1, text, subject: first.includes(m[0]) });
    }
  });
  return out;
}

function notes(): Listed[] {
  return files(NOTES, /\.md$/).flatMap((f) => listedNames(readFileSync(f, 'utf8'), relative(root, f)));
}

describe('the placeholder ledger: the code\'s named stand-ins and the research notes\' lists', () => {
  it('reads a placeholder section to the next heading of its level, and not a name outside one', () => {
    const md = [
      '# Note', 'A `FOO_PLACEHOLDER` in the prose.', '## 7. Placeholders', '### 7.1 A part', '| `BAR_PLACEHOLDER` | 1 |',
      '## 8. Next', '`BAZ_READING`', '### Readings', '`QUX_READING` (*note only*)',
    ].join('\n');
    expect(listedNames(md, 'n').map((l) => l.name)).toEqual(['BAR_PLACEHOLDER', 'QUX_READING']);
  });

  it('takes a table row\'s subject from its first cell, and every name on a line that is not a row', () => {
    const md = ['## Placeholders', '| `A_PLACEHOLDER` | as `B_PLACEHOLDER`\'s | open |', '- `C_READING` beside `D_READING`'].join('\n');
    expect(listedNames(md, 'n').map((l) => [l.name, l.subject])).toEqual([
      ['A_PLACEHOLDER', true], ['B_PLACEHOLDER', false], ['C_READING', true], ['D_READING', true],
    ]);
  });

  it('lists every placeholder and reading the viewer, server, scene and sound sources name', () => {
    const code = codeNames();
    expect(code.size).toBeGreaterThan(40);
    const listed = new Set(notes().map((l) => l.name));
    const missing = [...code].filter(([name]) => !listed.has(name)).map(([name, file]) => `${name} (${file})`);
    expect(missing, 'named in code, in no research note\'s placeholder section').toEqual([]);
  });

  it('marks a listed name no source holds any more as resolved or retired, or the note\'s own (note only)', () => {
    const code = codeNames();
    const stale = notes()
      .filter((l) => l.subject && !code.has(l.name) && !RETIRED.test(l.text))
      .map((l) => `${l.name} (${l.note}:${l.line})`);
    expect(stale, 'listed as a placeholder, in no source, not marked retired or note only').toEqual([]);
  });
});
