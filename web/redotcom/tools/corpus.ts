import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The web project's AI-digestible corpus (`web/docs/corpus/`), rebuilt by `tools/build-corpus.ts` and checked by
 * `tools/test/corpus.test.ts`.
 *
 * Two layers:
 * - `records.jsonl`, written by hand: one record per data kind, subsystem or finding -- a question, a short answer,
 *   the sources (a research note and its section, decomp functions and lines, disc files), a confidence, the code and
 *   the tests that pin it. Nothing here generates them; the test checks every citation resolves.
 * - `sections.jsonl` and `llms.txt`, generated: one row per numbered section of every note in `web/docs/research/`
 *   (its title, its line, the `FUN_` addresses it cites, the files under `packages/` and `tools/` that cite the note),
 *   and an index of the whole. The test rebuilds both in memory and refuses a stale copy on disk.
 *
 * Note keys: a web note by its number (`"84"`, `web/docs/research/84-*.md`); a note of the repository's own research
 * (`docs/research/`) as `"repo/24"` -- the two series overlap (`79` is the weapon table here, the SEAL's speed there).
 */

export type Confidence = 'proven' | 'reading' | 'placeholder';
export const CONFIDENCES: readonly Confidence[] = ['proven', 'reading', 'placeholder'];
export const KINDS = ['data', 'rule', 'subsystem', 'finding', 'process'] as const;
export type Kind = (typeof KINDS)[number];

export interface SourceRef {
  /** `"84"` for `web/docs/research/84-*.md`, `"repo/24"` for `docs/research/24-*.md`. */
  note: string;
  /** A section id as `sections.jsonl` spells it (`"3"`, `"2.1"`, `"D1"`, `"17/1"`); omitted = the whole note. */
  section?: string;
}

export interface CorpusRecord {
  id: string;
  kind: Kind;
  subsystem: string;
  question: string;
  answer: string;
  sources: SourceRef[];
  /** Decompilation citations as the notes write them (`FUN_005c2670 L477256-477377`); never the decompiled text. */
  decomp?: string[];
  /** Disc files by name only (`RUN/ZWEAPON.ZAR/zweapon.rdr`): what the fact is read from, never their bytes. */
  disc?: string[];
  confidence: Confidence;
  /** Paths relative to `web/`. */
  code?: string[];
  /** Paths relative to `web/`: the tests that pin the answer. */
  tests?: string[];
  related?: string[];
}

export interface Section {
  id: string;
  note: string;
  file: string;
  section: string;
  title: string;
  line: number;
  /** Bracketed markers on the heading (`read`, `data`) -- research 86's claim kinds. */
  tags: string[];
  functions: string[];
}

export interface Note {
  note: string;
  file: string;
  title: string;
  sections: Section[];
  /** Files under `packages/` and `tools/` (relative to `web/`) whose text says `research NN` or `research/NN`. */
  citedBy: string[];
}

const HEADING = /^(#{2,3})\s+(.*)$/;
/** A section number as the notes write them: `3.`, `2.1`, `6b.`, `D1`, `D3b`. */
const NUMBER = /^((?:\d+[a-z]?)(?:\.\d+[a-z]?)*|D\d+[a-z]?)\.?\s+(.*)$/;

function cleanTitle(raw: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  // Only the claim markers the notes use (research 77's, 78's, 86's): `[read]`, `[data, findLadders ...]`.
  const title = raw.replace(/\s*\[((?:read|data|derived|viewer|shown|inference|unknown|code)\b[^\]]*)\]\s*/gi, (_m, t: string) => {
    for (const part of t.split(',')) {
      const tag = part.trim().split(' ')[0]!.toLowerCase();
      if (/^(read|data|derived|viewer|shown|inference|unknown|code)$/.test(tag)) tags.push(tag);
    }
    return ' ';
  }).trim();
  return { title, tags };
}

/** The numbered sections of one note. A `###` whose number is not under its parent's is qualified `parent/n`. */
export function parseSections(note: string, file: string, text: string): { title: string; sections: Section[] } {
  const lines = text.split(/\r?\n/);
  const title = (lines[0] ?? '').replace(/^#\s+/, '').trim();
  const sections: Section[] = [];
  let parent: string | undefined;
  let open: Section | undefined;
  let fence = false;
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    if (line.startsWith('```')) fence = !fence;
    if (fence) return;
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      const n = NUMBER.exec(h[2]!);
      if (level === 2) parent = n ? n[1] : undefined;
      if (!n) { if (level === 2) open = undefined; return; }
      let id = n[1]!;
      if (level === 3 && parent && !id.startsWith('D') && id !== parent && !id.startsWith(`${parent}.`)) id = `${parent}/${id}`;
      if (seen.has(id)) id = `${id}@${i + 1}`;
      seen.add(id);
      const { title: t, tags } = cleanTitle(n[2]!);
      open = { id: `${note}#${id}`, note, file, section: id, title: t, line: i + 1, tags, functions: [] };
      sections.push(open);
      return;
    }
    if (open) {
      for (const m of line.matchAll(/\bFUN_[0-9a-fA-F]{6,8}\b/g)) if (!open.functions.includes(m[0])) open.functions.push(m[0]);
    }
  });
  // The heading's own functions too (`## 3. The size: the bloom (`FUN_005c2670` ...)`).
  for (const s of sections) {
    const head = lines[s.line - 1]!;
    for (const m of head.matchAll(/\bFUN_[0-9a-fA-F]{6,8}\b/g)) if (!s.functions.includes(m[0])) s.functions.unshift(m[0]);
  }
  return { title, sections };
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'ds') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const posix = (p: string): string => p.split(sep).join('/');

/** Every note of `web/docs/research/`, in number order, with its sections and the files that cite it. */
export function readNotes(web: string): Note[] {
  const dir = join(web, 'docs', 'research');
  const files = readdirSync(dir).filter((f) => /^\d+-.*\.md$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const sources = [...walk(join(web, 'packages')), ...walk(join(web, 'tools'))]
    .filter((p) => !posix(relative(web, p)).startsWith('tools/test/') && !posix(p).endsWith('/tools/corpus.ts'))
    .map((p) => ({ rel: posix(relative(web, p)), text: readFileSync(p, 'utf8') }));
  return files.map((f) => {
    const note = String(parseInt(f, 10));
    const { title, sections } = parseSections(note, `docs/research/${f}`, readFileSync(join(dir, f), 'utf8'));
    const cite = new RegExp(`research[ /]${note}(?![0-9])`);
    const citedBy = sources.filter((s) => cite.test(s.text)).map((s) => s.rel).sort();
    return { note, file: `docs/research/${f}`, title, sections, citedBy };
  });
}

/** `sections.jsonl`: one line per numbered section, the note's citing files on its first line only (`note` rows). */
export function sectionsJsonl(notes: Note[]): string {
  const rows: string[] = [];
  for (const n of notes) {
    rows.push(JSON.stringify({ type: 'note', id: n.note, file: n.file, title: n.title, sections: n.sections.length, cited_by: n.citedBy }));
    for (const s of n.sections) {
      rows.push(JSON.stringify({ type: 'section', id: s.id, note: s.note, section: s.section, title: s.title, line: s.line, tags: s.tags, functions: s.functions }));
    }
  }
  return rows.join('\n') + '\n';
}

export function parseRecords(text: string): CorpusRecord[] {
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('//')).map((l, i) => {
    try { return JSON.parse(l) as CorpusRecord; } catch (e) { throw new Error(`records.jsonl line ${i + 1}: ${(e as Error).message}`); }
  });
}

/** Every problem with the records: a missing field, an unknown confidence, a citation or path that does not resolve. */
export function checkRecords(records: CorpusRecord[], notes: Note[], web: string): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const sectionIds = new Set(notes.flatMap((n) => n.sections.map((s) => s.id)));
  const noteIds = new Set(notes.map((n) => n.note));
  const repoResearch = join(web, '..', 'docs', 'research');
  const repoNotes = existsSync(repoResearch) ? readdirSync(repoResearch).filter((f) => /^\d+-/.test(f)) : [];
  for (const r of records) {
    const at = r.id ?? '(no id)';
    for (const k of ['id', 'kind', 'subsystem', 'question', 'answer', 'confidence'] as const) {
      if (typeof r[k] !== 'string' || !(r[k] as string).trim()) problems.push(`${at}: missing ${k}`);
    }
    if (ids.has(r.id)) problems.push(`${at}: duplicate id`);
    ids.add(r.id);
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(r.id ?? '')) problems.push(`${at}: id must be lower-case words joined by . or -`);
    if (!(KINDS as readonly string[]).includes(r.kind)) problems.push(`${at}: unknown kind ${r.kind}`);
    if (!CONFIDENCES.includes(r.confidence)) problems.push(`${at}: unknown confidence ${r.confidence}`);
    if (!Array.isArray(r.sources) || r.sources.length === 0) problems.push(`${at}: no sources`);
    for (const s of r.sources ?? []) {
      if (s.note.startsWith('repo/')) {
        const n = s.note.slice(5);
        if (!repoNotes.some((f) => f.startsWith(`${n}-`))) problems.push(`${at}: no repository note ${s.note}`);
        continue;
      }
      if (!noteIds.has(s.note)) { problems.push(`${at}: no web note ${s.note}`); continue; }
      if (s.section !== undefined && !sectionIds.has(`${s.note}#${s.section}`)) problems.push(`${at}: no section ${s.note} §${s.section}`);
    }
    for (const p of [...(r.code ?? []), ...(r.tests ?? [])]) {
      if (!existsSync(join(web, p))) problems.push(`${at}: no file web/${p}`);
    }
    if (r.answer && r.answer.length > 600) problems.push(`${at}: answer over 600 characters (keep it short; the note has the rest)`);
  }
  for (const r of records) for (const rel of r.related ?? []) if (!ids.has(rel)) problems.push(`${r.id}: related ${rel} is not a record`);
  return problems;
}

/** `llms.txt`: the index an assistant reads first. */
export function llmsTxt(notes: Note[], records: CorpusRecord[]): string {
  const out: string[] = [];
  out.push('# SOCOM Unzipped -- the web project (map viewer and reCOM mode)');
  out.push('');
  out.push('> A browser recreation of SOCOM II (PS2, US): the multiplayer maps decoded from the user\'s own disc and drawn with');
  out.push('> three.js, a playable walk mode and a respawn multiplayer round, every value read from the game\'s data or its');
  out.push('> decompiled code. The repository ships no game data. This file is generated by `web/tools/build-corpus.ts`.');
  out.push('');
  out.push('Confidence in the records: `proven` = measured on the disc or a console frame and pinned by a test; `reading` =');
  out.push('read from the decompilation or reCOM, not yet measured on a console; `placeholder` = no source found, a named');
  out.push('constant (`*_PLACEHOLDER`) stands in. Code and test paths are relative to `web/`. A source note `NN` is');
  out.push("`web/docs/research/NN-*.md`; `repo/NN` is the repository's own `docs/research/NN-*.md`.");
  out.push('');
  out.push('## Documents');
  out.push('');
  out.push('- [README](../../README.md): what the viewer is, how to run it, the controls, what the picture is made of');
  out.push('- [Architecture](../ARCHITECTURE.md): the packages, their boundaries, what is SOCOM-specific, adapting it to another PS2 game');
  out.push('- [Data sources](../DATA_SOURCES.md): every kind of data, where it comes from, the tool that reads it, how it was verified');
  out.push('- [How it is built](../PROCESS.md): the stack and the development process, ground truth, rulings, agents');
  out.push('- [Contributing](../../CONTRIBUTING.md): conventions for the web project');
  out.push('- [records.jsonl](records.jsonl): the curated findings (schema in `web/tools/corpus.ts`, `CorpusRecord`)');
  out.push('- [sections.jsonl](sections.jsonl): every numbered section of every research note, with the functions it cites');
  out.push('');
  out.push('## Research notes');
  out.push('');
  for (const n of notes) out.push(`- [${n.note}](../research/${n.file.split('/').pop()}): ${n.title.replace(/^\d+\s*[—-]+\s*/, '')} (${n.sections.length} sections)`);
  out.push('');
  out.push('## Records');
  out.push('');
  const bySub = new Map<string, CorpusRecord[]>();
  for (const r of records) bySub.set(r.subsystem, [...(bySub.get(r.subsystem) ?? []), r]);
  for (const sub of [...bySub.keys()].sort()) {
    out.push(`### ${sub}`);
    out.push('');
    for (const r of bySub.get(sub)!) out.push(`- \`${r.id}\` (${r.confidence}): ${r.question}`);
    out.push('');
  }
  return out.join('\n');
}
