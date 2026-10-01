// @vitest-environment node
// The home page's LATEST tiles link to `/story.html#<id>` with the id read from the story's timeline.json, and the
// story page writes `id="<date>-<slug>"` on each entry from the same document. Both files are generated from
// docs/STORY.md in socom_pc and copied here in one pass; if one is regenerated without the other, a tile's link has
// nothing to land on and the reader is left at the top of the page with no error anywhere. This test reads the two
// deployed files and refuses that state (owner, 2026-09-27: the story links did not land).
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

// Static literals only: the ds guard records that a dynamic template in `new URL(..., import.meta.url)` mis-resolves.
const timeline = JSON.parse(readFileSync(new URL('../public/story/timeline.json', import.meta.url), 'utf-8')) as {
  entries: ReadonlyArray<{ id: string; date: string; title: string }>;
};
const story = readFileSync(new URL('../story.html', import.meta.url), 'utf-8');
const anchors = new Set([...story.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

describe('story anchors', () => {
  it('has a timeline with entries', () => {
    expect(timeline.entries.length).toBeGreaterThan(0);
  });
  it('gives every timeline entry an anchor on the story page', () => {
    const missing = timeline.entries.map((e) => e.id).filter((id) => !anchors.has(id));
    expect(missing).toEqual([]);
  });
  it('uses the <date>-<slug> shape the home page links to', () => {
    for (const e of timeline.entries) expect(e.id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/);
  });
  it('keeps the anchors the home page links to by name', () => {
    expect(anchors.has('from-the-creator')).toBe(true);
  });
  it('reserves every picture\'s size so the anchor does not move as pictures load', () => {
    const imgs = [...story.matchAll(/<figure><img [^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBeGreaterThan(0);
    const unsized = imgs.filter((tag) => !/ width="\d+" height="\d+"/.test(tag));
    expect(unsized).toEqual([]);
  });
});
