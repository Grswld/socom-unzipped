import { describe, expect, it } from 'vitest';
import { revisionLabel, viewerRevision } from '../src/revision';

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
