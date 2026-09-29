/**
 * The sound names the effects ask for, mended and stood in for (research 89 §11, research 90 items 4, 12, 18): one
 * table for every path a casing's or an impact's sound takes -- the effects' plays (`Effects`' sound callback) and the
 * audio's list of the names a map wants (`./soundData`, run in the worker: this module imports nothing).
 */

/**
 * The effect data's sound names the banks do not hold, and the name they meant -- **a deliberate departure from the
 * retail game** (the owner's playtest, 2026-09-29). `shell_eject`, `shell_eject_60` and `shell_eject_first_person`
 * name the metal bounce `.BUL_CASE_METAL`; no bank of the 115 and no `sounds.rdr` entry carries it, while
 * `.BUL_CAS_METAL` is in 16 banks (Frostfire's `MP2_am` among them) beside `.BUL_CAS_STONE`, `_DIRT`, `_SAND` and
 * `_WOOD`, the table's other names. The game looks a sound up by its name's CRC (`FUN_00344f30`), so on the console a
 * casing lands on metal in silence; the viewer plays the bank's `.BUL_CAS_METAL` (research 89 §11).
 */
export const SOUND_NAME_FIXES: Readonly<Record<string, string>> = { '.BUL_CASE_METAL': '.BUL_CAS_METAL' };

/**
 * The casing sounds a map's banks may lack, and what stands in -- **a departure from the retail game** (the feel-QA
 * playtest, research 90 item 12). The game resolves a sound by its name's CRC among the loaded banks' sounds, a binary
 * search over one sorted table (`FUN_00344f30` -> `FUN_00344bf0`, decomp 243197): no fallback bank, no other name, so a
 * name the map's banks lack plays nothing. The shell table sends grass and dirt (materials 4 and 8) to `.BUL_CAS_DIRT`,
 * which 13 banks hold and Blood Lake's (MP10) does not, beside its own `.BUL_CAS_GRASS`; so on the console its casings
 * land on the ground in silence. The viewer plays the first of these the map holds.
 */
export const SOUND_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  '.BUL_CAS_DIRT': ['.BUL_CAS_GROUND', '.BUL_CAS_GRASS', '.BUL_CAS_SAND'],
  '.BUL_CAS_SAND': ['.BUL_CAS_GROUND', '.BUL_CAS_DIRT'],
  '.BUL_CAS_METAL': ['.BUL_CAS_GR8ING'],
  // The shotgun's shell on tin: two banks hold it (MP8's, MP61's); a map whose borrowing does not reach one plays its
  // shell on metal (research 90 item 18).
  '.SG_SHELL_TIN': ['.SG_SHELL_METAL'],
  // On sand: three banks (MP6's, MP7's, MP73's); elsewhere the casing's sand, else the shell on stone (every `_am` bank).
  '.SG_SHELL_SAND': ['.BUL_CAS_SAND', '.SG_SHELL_STONE'],
};

/** The sound to play for an effect's sound name: the data's slips mended, then a fallback when the banks lack it. */
export function soundFor(name: string, has: (name: string) => boolean): string {
  const fixed = SOUND_NAME_FIXES[name] ?? name;
  if (has(fixed)) return fixed;
  return SOUND_FALLBACKS[fixed]?.find(has) ?? fixed;
}
