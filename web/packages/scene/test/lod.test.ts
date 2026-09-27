import { describe, expect, it } from 'vitest';
import { farLodModels, lodBands, lodIsLast, lodVisible } from '../src/lod';
import type { RdrNode } from '@s2u/archive';

/**
 * `lod.rdr` as Frostfire ships it (`READERM.ZAR`), trimmed: bands with fade ranges, and lists of the
 * models in each. The near copies start at 0; the far copies start further out; the graph places both
 * at the same spot and the engine shows one by camera range.
 */
const FROSTFIRE: RdrNode = [[
  'LOD_Definititions', [
    ['midgrate', 'nearFade', ['0', '0'], 'farFade', ['360', '360']],
    ['lowgrate', 'nearFade', ['260', '260'], 'farFade', ['500', '500']],
    ['railings_high', 'nearFade', ['0', '0'], 'farFade', ['100', '120']],
    ['railings_low', 'nearFade', ['100', '120'], 'farFade', ['420', '440']],
    ['furniture', 'nearFade', ['0', '0'], 'farFade', ['250', '260']],
  ],
  'LOD_Connection', [
    ['LODTYPE1', 'midgrate', 'ObjectList', ['grate_midlod']],
    ['LODTYPE1', 'lowgrate', 'ObjectList', ['grate_lowlod']],
    ['LODTYPE1', 'railings_high', 'ObjectList', ['railstraithi1', 'railcornerhi1']],
    ['LODTYPE1', 'railings_low', 'ObjectList', ['railstraitlo1', 'railcornerlo1', 'tankrailbarslo']],
    ['LODTYPE1', 'furniture', 'ObjectList', ['chair_office']],
  ],
]];

describe('lodBands', () => {
  it('gives every listed model its band, with both fade ranges', () => {
    const bands = lodBands(FROSTFIRE);
    expect(bands.get('railstraithi1')).toEqual({ nearFade: [0, 0], farFade: [100, 120] });
    expect(bands.get('railstraitlo1')).toEqual({ nearFade: [100, 120], farFade: [420, 440] });
    expect(bands.get('grate_midlod')).toEqual({ nearFade: [0, 0], farFade: [360, 360] });
    expect(bands.size).toBe(8);
  });

  it('is empty for a record with no LOD lists, and for one that is not a record at all', () => {
    expect(lodBands([['LOD_Definititions', []]]).size).toBe(0);
    expect(lodBands('nothing').size).toBe(0);
    expect(lodBands([]).size).toBe(0);
  });

  it('ignores a connection whose band was never defined', () => {
    const rdr: RdrNode = [['LOD_Definititions', [], 'LOD_Connection', [['LODTYPE1', 'ghost', 'ObjectList', ['x']]]]];
    expect(lodBands(rdr).size).toBe(0);
  });
});

describe('farLodModels', () => {
  it('names the models in a band that fades in above zero, and none from a band that starts at zero', () => {
    expect([...farLodModels(FROSTFIRE)].sort()).toEqual(['grate_lowlod', 'railcornerlo1', 'railstraitlo1', 'tankrailbarslo']);
  });
});

describe('lodVisible', () => {
  const high = lodBands(FROSTFIRE).get('railstraithi1')!;
  const low = lodBands(FROSTFIRE).get('railstraitlo1')!;

  it('shows the near copy up to the middle of its fade-out and the far copy from the middle of its fade-in', () => {
    // The two fades overlap on 100..120, so both switch at 110 and exactly one is shown at every range.
    for (const range of [0, 50, 109.9]) { expect(lodVisible(high, range)).toBe(true); expect(lodVisible(low, range)).toBe(false); }
    for (const range of [110, 200, 429]) { expect(lodVisible(high, range)).toBe(false); expect(lodVisible(low, range)).toBe(true); }
  });

  it('culls both copies past the far fade of the far one, as the engine does', () => {
    expect(lodVisible(low, 431)).toBe(false);
    expect(lodVisible(high, 431)).toBe(false);
  });

  it('keeps the last copy at every range when asked, and the near copy still steps aside for it', () => {
    expect(lodVisible(low, 431, true)).toBe(true);
    expect(lodVisible(low, 5000, true)).toBe(true);
    expect(lodVisible(low, 50, true)).toBe(false);      // not yet faded in
    expect(lodVisible(high, 431, true)).toBe(true);     // a lone near copy asked to stay, stays
  });
});

describe('lodIsLast', () => {
  const bands = lodBands(FROSTFIRE);
  const high = bands.get('railstraithi1')!;
  const low = bands.get('railstraitlo1')!;
  const lone = bands.get('chair_office')!;

  it('is the far copy of a pair, not the near one', () => {
    expect(lodIsLast(low, [high])).toBe(true);
    expect(lodIsLast(high, [low])).toBe(false);
  });

  it('is a copy with nothing else at its spot', () => {
    expect(lodIsLast(lone, [])).toBe(true);
    expect(lodIsLast(high, [])).toBe(true);
  });

  it('ignores itself and another copy that fades in no later', () => {
    expect(lodIsLast(low, [low, high, lone])).toBe(true);
  });
});
