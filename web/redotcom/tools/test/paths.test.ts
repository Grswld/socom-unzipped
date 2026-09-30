import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The paths the tree cites, after the 2026-09-29 move of the viewer and its server under `web/redotcom/` (c3e5fa72, a
 * pure rename): a comment or a note that still says `web/docs/research/` or `web/public/maps/` sends the next reader to a
 * directory that is not there (the launch review's stale-path items). The dated plans and specs under `docs/plans/` and
 * `docs/specs/` are records of their day and keep the layout they were written in.
 */

const root = resolve(import.meta.dirname, '../..');
/** A pre-move path: `web/` straight into what now lives under `web/redotcom/` (not `.../socom_pc/web/...` prose). */
const STALE = /(^|[^A-Za-z0-9_/.-])web\/(docs\/|public\/maps|packages\/|tools\/|test-fixtures|deploy\/)/;
const RECORDS = /^(docs\/plans|docs\/specs)\//;
/** This guard names the pre-move paths on purpose (the header and the self-test), so it does not scan itself. */
const SELF = 'tools/test/paths.test.ts';

function tracked(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  return out
    .split('\0')
    .filter((f) => f && f !== SELF && !RECORDS.test(f) && !/(^|\/)dist\//.test(f) && /\.(ts|mjs|js|md|json|jsonl|txt|html|css|ya?ml)$/.test(f));
}

describe('the tree cites the paths it has', () => {
  it('matches a pre-move path, and not the moved one or a path inside another tree', () => {
    expect(STALE.test('see web/docs/research/89')).toBe(true);
    expect(STALE.test('`web/public/maps/`')).toBe(true);
    expect(STALE.test('web/redotcom/docs/research/89')).toBe(false);
    expect(STALE.test('socom_pc/web/docs/x')).toBe(false);
  });

  it('holds no pre-move path in any tracked file under web/redotcom/ (the dated plans and specs aside)', () => {
    const files = tracked();
    expect(files.length).toBeGreaterThan(100);
    const stale: string[] = [];
    for (const f of files) {
      readFileSync(join(root, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (STALE.test(line)) stale.push(`${f}:${i + 1}`);
      });
    }
    expect(stale).toEqual([]);
  });

  it('points every `web/redotcom/docs/research/NN` at a note that exists', () => {
    const notes = readdirSync(join(root, 'docs', 'research'));
    const numbers = new Set(notes.map((n) => /^(\d+)-/.exec(n)?.[1]).filter(Boolean));
    const missing: string[] = [];
    for (const f of tracked()) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(/web\/redotcom\/docs\/research\/(\d+)/g)) {
        if (!numbers.has(m[1]!)) missing.push(`${f}: research ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
