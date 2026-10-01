import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkRecords, llmsTxt, parseRecords, readNotes, sectionsJsonl } from './corpus';

/**
 * Rebuilds the generated half of `web/redotcom/docs/corpus/` -- `sections.jsonl` and `llms.txt` -- from the research notes and
 * the hand-written `records.jsonl`, and refuses (exit 1) when a record cites a note, a section or a file that does
 * not exist. Run it after editing a research note's headings or the records: `npx tsx tools/build-corpus.ts`.
 * `tools/test/corpus.test.ts` fails while the files on disk differ from what this would write.
 */
const web = resolve(import.meta.dirname, '..');
const dir = join(web, 'docs', 'corpus');
const notes = readNotes(web);
const records = parseRecords(readFileSync(join(dir, 'records.jsonl'), 'utf8'));
const problems = checkRecords(records, notes, web);
writeFileSync(join(dir, 'sections.jsonl'), sectionsJsonl(notes));
writeFileSync(join(dir, 'llms.txt'), llmsTxt(notes, records));
const sections = notes.reduce((n, x) => n + x.sections.length, 0);
console.log(`corpus: ${notes.length} notes, ${sections} sections, ${records.length} records`);
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
