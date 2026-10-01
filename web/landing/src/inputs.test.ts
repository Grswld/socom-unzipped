// @vitest-environment node
// The generated inputs the page tests read (story.html, public/story/timeline.json) are git-ignored and made by
// tools/prepare.mjs from the tracked docs/STORY.md and docs/story/. A bare or targeted `vitest run` used to skip that
// step and fail page_classes.test.ts and story_anchors.test.ts at collection with ENOENT (release review MJ-10), so
// vitest.config.ts names a globalSetup (tools/vitest-prepare.mjs) that runs prepare.mjs before any test file loads.
// This file pins that: the inputs exist, story.html is not older than the STORY.md it is made from, and the config
// still names the setup.
import { existsSync, readFileSync, statSync } from 'fs';
import { describe, expect, it } from 'vitest';

const app = new URL('../', import.meta.url);                 // web/landing/
const repo = new URL('../../', app);                         // the repository
const at = (rel: string, base: URL = app): URL => new URL(rel, base);

describe('the landing tests\' generated inputs', () => {
  it('story.html and public/story/timeline.json exist before any test file loads', () => {
    expect(existsSync(at('story.html'))).toBe(true);
    expect(existsSync(at('public/story/timeline.json'))).toBe(true);
  });

  it('story.html is not older than docs/STORY.md (a stale copy from an earlier prepare must not pass)', () => {
    expect(statSync(at('story.html')).mtimeMs).toBeGreaterThanOrEqual(statSync(at('docs/STORY.md', repo)).mtimeMs);
  });

  it('the copied timeline is the tracked one', () => {
    expect(readFileSync(at('public/story/timeline.json'), 'utf-8')).toBe(readFileSync(at('docs/story/timeline.json', repo), 'utf-8'));
  });

  it('vitest.config.ts runs tools/vitest-prepare.mjs as its globalSetup', () => {
    const config = readFileSync(at('vitest.config.ts'), 'utf-8');
    expect(config).toMatch(/globalSetup:\s*\[\s*'tools\/vitest-prepare\.mjs'\s*\]/);
    expect(existsSync(at('tools/vitest-prepare.mjs'))).toBe(true);
  });
});
