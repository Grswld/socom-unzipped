import { parseRdr, readZarMembers, readZdbMember, Zar, type AssetSource } from '@s2u/archive';
import { parseAnimSets } from '@s2u/scene';
import {
  callbackSounds, parseBankFile, parseSoils, parseSoundScript, soundParams, weaponSounds,
  type Material, type SoundParams, type WeaponSounds,
} from '@s2u/sound';

/**
 * The walk's sound, read off the disc in the worker (web/docs/research/81; ruling W2.R6: at run time, never written
 * into the source) for one map:
 *
 * - **the banks**: the map's `<map>_am.bnk` (the steps, the landings, the jump, the world's impacts), `_fx.bnk` (the
 *   weapons) and `_vc.bnk` (the voices), out of `RUN/SOUNDS/BNKSTORE.ZAR` by range -- 1.1 to 1.4 MB of its 67 --
 *   sent as their bytes; the page parses and decodes them (`./audio`);
 * - **the script**: `RUN/SOUNDRDR.ZAR/sounds.rdr`, each of those banks' sounds' `RANGE` and flags, by name;
 * - **the materials**: `READERC.ZAR/materials.rdr`, the step, stealth, crawl and landing sound of every surface;
 * - **the weapons**: `ZWEAPON.ZAR/zweapon.rdr`'s fire and reload sounds for `SOUND_WEAPONS`;
 * - **the callbacks**: the map's own `CZANIM.ZAR`, which zAnim a `zanim_callback` name plays which sound.
 *
 * Each part is optional: a source without `BNKSTORE.ZAR` (an index extracted before web/docs/research/81) answers
 * null and the walk is silent; a missing script, table or archive leaves that part empty and says so in `missing`.
 */

export const SOUND_BANKS_PATH = 'RUN/SOUNDS/BNKSTORE.ZAR';
export const SOUND_SCRIPT_PATH = 'RUN/SOUNDRDR.ZAR';
export const SOUND_MATERIALS_PATH = 'RUN/READERC.ZAR';
export const SOUND_WEAPONS_PATH = 'RUN/ZWEAPON.ZAR';
/** A map's three banks, in the order a name is looked up in them. */
export const SOUND_BANK_KINDS = ['am', 'fx', 'vc'] as const;
/** The weapons whose sounds are read: the SEAL's rifle as held (W2.R4) and as the fire table reads it (W2.5). */
export const SOUND_WEAPONS: readonly string[] = ['M4A1 SD', 'M4A1'];

export interface SoundData {
  /** The map's archive id, `MP2`. */
  archive: string;
  /** Each bank's member name and its bytes (their own buffers: transferred). */
  banks: { file: string; bytes: Uint8Array }[];
  materials: Material[];
  /** `sounds.rdr`'s entry for a bank sound, by the sound's name, for the sounds it lists. */
  params: [string, SoundParams][];
  weapons: WeaponSounds[];
  /** zAnim callback name to the sounds it plays. */
  callbacks: [string, string[]][];
  /** The parts that could not be read, and why. */
  missing: string[];
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Reads a map's sound data off `source`; null when the source has no banks for it. */
export async function soundFromDisc(source: AssetSource, mapPath: string, archive: string): Promise<SoundData | null> {
  const files = SOUND_BANK_KINDS.map((k) => `${archive}_${k}.bnk`);
  let found: Map<string, Uint8Array>;
  try {
    found = await readZarMembers(source, SOUND_BANKS_PATH, files);
  } catch {
    return null;
  }
  // A member of a whole-archive read is a view of the 67 MB buffer: copied, so only its own bytes cross.
  const banks = files.filter((f) => found.has(f)).map((file) => ({ file, bytes: found.get(file)!.slice() }));
  if (banks.length === 0) return null;
  const missing: string[] = files.filter((f) => !found.has(f)).map((f) => `${f}: not in ${SOUND_BANKS_PATH}`);
  const one = async (path: string, member: string): Promise<Uint8Array | null> => {
    try {
      const got = (await readZarMembers(source, path, [member])).get(member);
      if (!got) missing.push(`${path}: no ${member}`);
      return got ?? null;
    } catch (e) {
      missing.push(`${path}: ${why(e)}`);
      return null;
    }
  };

  const params: [string, SoundParams][] = [];
  const script = await one(SOUND_SCRIPT_PATH, 'sounds.rdr');
  if (script) {
    try {
      const sets = parseSoundScript(parseRdr(script));
      for (const { bytes } of banks) {
        const bank = parseBankFile(bytes);
        for (const name of bank.names.keys()) {
          const p = soundParams(sets, [bank.name], name);
          if (p) params.push([name, p]);
        }
      }
    } catch (e) { missing.push(`sounds.rdr: ${why(e)}`); }
  }

  let materials: Material[] = [];
  const mats = await one(SOUND_MATERIALS_PATH, 'materials.rdr');
  if (mats) { try { materials = parseSoils(parseRdr(mats)); } catch (e) { missing.push(`materials.rdr: ${why(e)}`); } }

  const weapons: WeaponSounds[] = [];
  const zweapon = await one(SOUND_WEAPONS_PATH, 'zweapon.rdr');
  if (zweapon) {
    try {
      const table = parseRdr(zweapon);
      for (const name of SOUND_WEAPONS) { const w = weaponSounds(table, name); if (w) weapons.push(w); }
    } catch (e) { missing.push(`zweapon.rdr: ${why(e)}`); }
  }

  let callbacks: [string, string[]][] = [];
  try {
    const czanim = Zar.parse(await readZdbMember(source, mapPath, 'CZANIM.ZAR'));
    // A play-sound command's name index, the u16 at +6 of its 32 bytes in the animation's Seq_Data.
    const nameIndex = (set: string, anim: string, offset: number): number | null => {
      const key = czanim.find(`Anim_Sets/${set}/Animation_List/${anim}/Seq_Data`);
      if (!key || offset + 8 > key.size) return null;
      const d = czanim.data(key);
      return d[offset + 6]! | (d[offset + 7]! << 8);
    };
    callbacks = [...callbackSounds(parseAnimSets(czanim), nameIndex)];
  } catch (e) { missing.push(`${mapPath} CZANIM.ZAR: ${why(e)}`); }

  return { archive, banks, materials, params, weapons, callbacks, missing };
}

/** The banks' buffers, for the worker's transfer list. */
export function soundTransferables(data: SoundData): Transferable[] {
  return data.banks.map((b) => b.bytes.buffer as ArrayBuffer);
}
