import { describe, expect, it } from 'vitest';
import { revisionBadge, revisionLabel, viewerRevision, viewerRevisionBadge } from '../src/revision';

/**
 * The build's own name in the panel: the git revision it was built from and when. Vite writes the two
 * values in at build time; vitest does not run Vite's `define`, so the fallback is what a test sees.
 */
describe('revisionLabel', () => {
  it('names the revision and the UTC minute it was built', () => {
    expect(revisionLabel('a1b2c3d', '2026-09-27 15:10:42')).toBe('rev a1b2c3d · built 2026-09-27 15:10 UTC');
  });

  it('keeps the dirty mark on a build from an edited tree', () => {
    expect(revisionLabel('a1b2c3d-dirty', '2026-09-27 15:10:42')).toBe('rev a1b2c3d-dirty · built 2026-09-27 15:10 UTC');
  });

  it('says unknown rather than printing an empty or malformed value', () => {
    expect(revisionLabel('', '')).toBe('rev unknown · build time unknown');
    expect(revisionLabel('  ', 'yesterday')).toBe('rev unknown · build time unknown');
  });
});

describe('viewerRevision', () => {
  it('falls back to unknown when the build defines are absent, as under vitest', () => {
    expect(viewerRevision()).toBe('rev unknown · build time unknown');
  });
});

/**
 * The About summary's chip carries only `rev <short hash>`: the full "rev … · built …" line is the
 * last line of the About text, and the chip beside a summary has no room for a date.
 */
describe('revisionBadge', () => {
  it('is the revision alone, dirty mark kept', () => {
    expect(revisionBadge('a1b2c3d')).toBe('rev a1b2c3d');
    expect(revisionBadge('a1b2c3d-dirty')).toBe('rev a1b2c3d-dirty');
  });
  it('says unknown for an empty value', () => {
    expect(revisionBadge('')).toBe('rev unknown');
    expect(revisionBadge('  ')).toBe('rev unknown');
  });
  it('viewerRevisionBadge falls back like the label', () => {
    expect(viewerRevisionBadge()).toBe('rev unknown');
  });
});
