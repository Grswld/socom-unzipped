import type { MapInfo } from '@s2u/archive';

/**
 * The map picker's order: the owner's popularity ranking of the multiplayer maps (2026-09-21), most played
 * first. `mode` is the map's game type. Names are matched to the archive's own `mission.rdr` description with
 * spaces and punctuation ignored, so "Fox Hunt" finds FOXHUNT and "Rat's Nest" finds RAT'S NEST.
 *
 * Last Bastion, After Hours and Liberation are on the list but not on the r0001 disc (they were later
 * additions), so they never appear in the picker.
 */
export interface MapRank {
  readonly name: string;
  readonly mode: string;
  readonly popularity: string;
}

export const MAP_POPULARITY: readonly MapRank[] = [
  { name: 'Crossroads', mode: 'Demolition', popularity: 'Legendary' },
  { name: 'Desert Glory', mode: 'Extraction', popularity: 'Legendary' },
  { name: 'Frostfire', mode: 'Suppression', popularity: 'Legendary' },
  { name: 'Fish Hook', mode: 'Extraction', popularity: 'Extremely high' },
  { name: 'Night Stalker', mode: 'Demolition', popularity: 'Extremely high' },
  { name: 'Blizzard', mode: 'Demolition', popularity: 'Very high' },
  { name: 'The Ruins', mode: 'Demolition', popularity: 'Very high' },
  { name: 'Vigilance', mode: 'Suppression', popularity: 'Very high' },
  { name: 'Fox Hunt', mode: 'Escort', popularity: 'High' },
  { name: 'Sujo', mode: 'Breach', popularity: 'High' },
  { name: 'Chain Reaction', mode: 'Suppression', popularity: 'High' },
  { name: 'Guidance', mode: 'Escort', popularity: 'High/moderate' },
  { name: 'Enowapi', mode: 'Breach', popularity: 'Moderate' },
  { name: 'Requiem', mode: 'Demolition', popularity: 'Moderate' },
  { name: 'The Mixer', mode: 'Escort', popularity: 'Moderate' },
  { name: 'Sandstorm', mode: 'Breach', popularity: 'Moderate' },
  { name: 'Shadow Falls', mode: 'Suppression', popularity: 'Lower / cult favorite' },
  { name: 'Abandoned', mode: 'Suppression', popularity: 'Lower in S2' },
  { name: 'Death Trap', mode: 'Extraction', popularity: 'Lower / cult favorite' },
  { name: 'Blood Lake', mode: 'Extraction', popularity: 'Lower / cult favorite' },
  { name: 'Bitter Jungle', mode: 'Demolition', popularity: 'Lower' },
  { name: "Rat's Nest", mode: 'Suppression', popularity: 'Lower in S2' },
  { name: 'Last Bastion', mode: 'Breach', popularity: 'Limited exposure' },
  { name: 'After Hours', mode: 'Suppression', popularity: 'Limited exposure' },
  { name: 'Liberation', mode: 'Escort', popularity: 'Limited exposure' },
];

/** "Rat's Nest", "RAT'S NEST" and "ratsnest" all become "ratsnest". */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const RANK_BY_NAME = new Map(MAP_POPULARITY.map((m, i) => [normaliseName(m.name), i] as const));

/** The rank entry for an archive's display name, or undefined for a map the list does not know. */
export function rankOf(name: string): MapRank | undefined {
  const i = RANK_BY_NAME.get(normaliseName(name));
  return i === undefined ? undefined : MAP_POPULARITY[i];
}

/**
 * Maps in popularity order. Maps the list does not know keep their incoming (archive-number) order and follow
 * the ranked ones, so a map is never dropped from the picker.
 */
export function sortByPopularity(maps: readonly MapInfo[]): MapInfo[] {
  const indexed = maps.map((m, i) => ({ m, i, rank: RANK_BY_NAME.get(normaliseName(m.name)) ?? Infinity }));
  indexed.sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank - b.rank));
  return indexed.map((x) => x.m);
}

/** The picker label: the archive's own name, its game type when known, and the archive id. */
export function labelFor(m: MapInfo): string {
  const rank = rankOf(m.name);
  return rank ? `${m.name} · ${rank.mode} (${m.archive})` : `${m.name} (${m.archive})`;
}
