import { describe, it, expect } from 'vitest';
import type { MapInfo } from '@s2u/archive';
import { MAP_POPULARITY, labelFor, normaliseName, rankOf, sortByPopularity } from '../src/mapOrder';

const disc: MapInfo[] = [
  { archive: 'MP1', path: 'RUN/MP1.ZDB', name: 'BLIZZARD' },
  { archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'FROSTFIRE' },
  { archive: 'MP5', path: 'RUN/MP5.ZDB', name: 'ABANDONED' },
  { archive: 'MP8', path: 'RUN/MP8.ZDB', name: "RAT'S NEST" },
  { archive: 'MP53', path: 'RUN/MP53.ZDB', name: 'FOXHUNT' },
  { archive: 'MP72', path: 'RUN/MP72.ZDB', name: 'CROSSROADS' },
  { archive: 'MP99', path: 'RUN/MP99.ZDB', name: 'SOMETHING NEW' },
];

describe('sortByPopularity', () => {
  it('puts the owner’s ranking first and keeps unknown maps last in archive order', () => {
    const names = sortByPopularity(disc).map((m) => m.name);
    expect(names).toEqual(['CROSSROADS', 'FROSTFIRE', 'BLIZZARD', 'FOXHUNT', 'ABANDONED', "RAT'S NEST", 'SOMETHING NEW']);
  });
  it('matches names regardless of case, spaces and apostrophes', () => {
    expect(normaliseName("Rat's Nest")).toBe(normaliseName("RAT'S NEST"));
    expect(normaliseName('Fox Hunt')).toBe(normaliseName('FOXHUNT'));
    expect(rankOf('FOXHUNT')?.mode).toBe('Escort');
    expect(rankOf('SOMETHING NEW')).toBeUndefined();
  });
  it('labels a known map with its game type and an unknown one plainly', () => {
    expect(labelFor(disc[5]!)).toBe('CROSSROADS · Demolition (MP72)');
    expect(labelFor(disc[6]!)).toBe('SOMETHING NEW (MP99)');
  });
  it('ranks all 22 disc names', () => {
    const discNames = ['BLIZZARD', 'FROSTFIRE', 'ABANDONED', 'DESERT GLORY', 'NIGHT STALKER', "RAT'S NEST",
      'BITTER JUNGLE', 'BLOOD LAKE', 'DEATH TRAP', 'THE RUINS', 'VIGILANCE', 'THE MIXER', 'FOXHUNT', 'SUJO',
      'ENOWAPI', 'SHADOW FALLS', 'FISH HOOK', 'CROSSROADS', 'SANDSTORM', 'CHAIN REACTION', 'GUIDANCE', 'REQUIEM'];
    for (const n of discNames) expect(rankOf(n), n).toBeDefined();
    expect(MAP_POPULARITY.length).toBe(25);
  });
});
