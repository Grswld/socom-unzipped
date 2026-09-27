/**
 * Where the two sides stand when a multiplayer round starts, per map, in game units.
 *
 * **These are measured actor positions, not archive data.** Nothing in `MP*_GEO.ZED` or the world root
 * matches `spawn|start|team|respawn` (36 section 6); `vehicles.rdr` carries a named `playerstart`
 * reference rather than coordinates, and the regions those names resolve to live in `AIMAPS.MPS`, whose
 * format is the one documented gap for a viewer. So until `AIMAPS.MPS` is read, these numbers come from
 * the game itself: the actor block of both players at the start of a control round, read over the
 * 2026-09-17 online sweep (`docs/research/33-online-map-coverage.md` lines 47-71) and, for the two maps
 * the sweep did not cover, `docs/KNOWN.md` section 1's Frostfire and Vigilance rows.
 *
 * A map's key is the name the game shows, which is `mission.rdr`'s `description` (36 section 0) -- the
 * same string `listMaps` puts in `MapInfo.name`, so the viewer can look a map up by what it is called.
 *
 * Two of the twenty-two were measured twice. The Mixer, Foxhunt and Requiem's first pass are the retry
 * rows in that table (their first attempt never reached a round); Requiem's two passes differ by one
 * unit in A's z, and the first is kept.
 */

/** One map's two spawns, xyz in game units, at the players' feet. */
export interface Spawns {
  a: [number, number, number];
  b: [number, number, number];
}

/** Every MP map that has been measured: all 22 of them (36 section 0; MP3 and MP4 do not exist). */
export const SPAWNS: Record<string, Spawns> = {
  BLIZZARD:         { a: [2562, 272, 3113], b: [1789, 75, 1385] },   // MP1
  FROSTFIRE:        { a: [796, 100, 614],   b: [536, 143, 1254] },   // MP2  (KNOWN section 1)
  ABANDONED:        { a: [1172, 82, 2260],  b: [927, 168, 622] },    // MP5
  'DESERT GLORY':   { a: [837, -5, 1901],   b: [1865, 66, 1221] },   // MP6
  'NIGHT STALKER':  { a: [648, 124, 1675],  b: [2310, 163, 1458] },  // MP7
  "RAT'S NEST":     { a: [1601, 166, 905],  b: [188, 165, 948] },    // MP8
  'BITTER JUNGLE':  { a: [1065, 30, 1253],  b: [2749, 31, 911] },    // MP9
  'BLOOD LAKE':     { a: [1098, 35, 626],   b: [884, 52, 2004] },    // MP10
  'DEATH TRAP':     { a: [1170, 163, 1572], b: [1628, 1, 247] },     // MP11
  'THE RUINS':      { a: [2063, 68, 1114],  b: [486, 69, 1309] },    // MP12
  VIGILANCE:        { a: [540, 160, 1456],  b: [1130, 65, 96] },     // MP51 (KNOWN section 1)
  'THE MIXER':      { a: [2254, 40, 2688],  b: [3802, 101, 2044] },  // MP52 (pass 2)
  FOXHUNT:          { a: [3407, 144, 4904], b: [3212, 212, 1817] },  // MP53 (pass 2)
  SUJO:             { a: [873, 143, 279],   b: [658, -25, 2245] },   // MP61
  ENOWAPI:          { a: [802, 4, 340],     b: [1442, 277, 1231] },  // MP62
  'SHADOW FALLS':   { a: [1607, 36, 2160],  b: [445, 38, 811] },     // MP64
  'FISH HOOK':      { a: [1199, 73, 1450],  b: [1892, 175, 758] },   // MP71
  CROSSROADS:       { a: [1972, 68, 2150],  b: [748, 93, 766] },     // MP72
  SANDSTORM:        { a: [2303, 201, 2017], b: [857, 85, 1306] },    // MP73
  'CHAIN REACTION': { a: [1256, 272, 1254], b: [1457, 26, 2374] },   // MP81
  GUIDANCE:         { a: [900, 55, 2803],   b: [2011, 21, 1377] },   // MP82
  REQUIEM:          { a: [1928, 224, 2591], b: [676, 187, 789] },    // MP83 (pass 1; pass 2 read z 2592)
};

/**
 * The spawns of the map with this shown name, or undefined when none were measured. The lookup is
 * forgiving about case and surrounding space, because the name comes out of an archive and a viewer
 * should not miss a map over a stray blank.
 */
export function spawnsFor(name: string): Spawns | undefined {
  return SPAWNS[name.trim().toUpperCase()];
}
