import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRecords, llmsTxt, parseRecords, parseSections, readNotes, sectionsJsonl } from '../corpus';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS = join(WEB, 'docs', 'corpus');
const read = (f: string): string => readFileSync(join(CORPUS, f), 'utf8').replace(/\r\n/g, '\n');

describe('the corpus (web/docs/corpus)', () => {
  const notes = readNotes(WEB);
  const records = parseRecords(read('records.jsonl'));

  it('every record parses, and every citation, section, code path and test path resolves', () => {
    expect(records.length).toBeGreaterThan(30);
    expect(checkRecords(records, notes, WEB)).toEqual([]);
  });

  it('every line of sections.jsonl is JSON, and the file is what build-corpus.ts writes now', () => {
    const text = read('sections.jsonl');
    for (const line of text.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
    expect(text).toBe(sectionsJsonl(notes));
  });

  it('llms.txt is what build-corpus.ts writes now, and lists every record', () => {
    const text = read('llms.txt');
    expect(text).toBe(llmsTxt(notes, records));
    for (const r of records) expect(text).toContain(`\`${r.id}\``);
  });

  it('every research note has sections, and every section id is unique', () => {
    expect(notes.length).toBeGreaterThanOrEqual(18);
    const ids = notes.flatMap((n) => n.sections.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of notes) expect(n.sections.length, n.file).toBeGreaterThan(0);
  });

  it('refuses a citation of a section that does not exist', () => {
    const bad = [{ ...records[0]!, id: 'x.bad', sources: [{ note: '84', section: '99' }], related: [] }];
    expect(checkRecords(bad, notes, WEB)).toContain('x.bad: no section 84 §99');
  });
});

describe('parseSections', () => {
  it('numbers ## and ### headings as the notes cite them, qualifying a ### that restarts under its parent', () => {
    const text = [
      '# 99 -- A note', '', '## 0. The answers', '## 3. The size (`FUN_005c2670`, decomp 1-2)', 'uses FUN_00111111 here',
      '### 3.1 A part [read, data]', '## D1 -- not numbered like that', '## 17. The kicks', '### 1. Vote-kick', '### 1.1 Eject',
      '```', '## 5. inside a fence', '```', '### D2 -- a divergence', '## 6b. The third round',
    ].join('\n');
    const { title, sections } = parseSections('99', 'x.md', text);
    expect(title).toBe('99 -- A note');
    expect(sections.map((s) => s.section)).toEqual(['0', '3', '3.1', 'D1', '17', '17/1', '17/1.1', 'D2', '6b']);
    expect(sections[1]!.functions).toEqual(['FUN_005c2670', 'FUN_00111111']);
    expect(sections[2]!.tags).toEqual(['read', 'data']);
  });
});
