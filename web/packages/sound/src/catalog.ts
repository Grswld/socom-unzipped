import { parseRdr, rdrGet, Zar, type RdrNode } from '@s2u/archive';

/**
 * Where the game names the sounds the walk plays, apart from the materials (web/docs/research/81 §5-§6).
 */

/**
 * A weapon's sounds, `RUN/ZWEAPON.ZAR/zweapon.rdr`'s `ZWEAPON` record (keys at `0x3fcb50`-`0x3fcc70` in the ELF's
 * strings): `FireSoundClose`, `FireSoundMed`, `FireSoundFar` -- one round heard near, mid and far, the `MED`/`FAR`
 * variants `sounds.rdr` marks -- and `ReloadSound`. The M4A1 SD's are `.M4A1_SIL` and `.M4A1_SIL_RLD`, with no
 * medium or far variant: a suppressed round is heard near only.
 */
export interface WeaponSounds { name: string; fireClose: string | null; fireMed: string | null; fireFar: string | null; reload: string | null }

const sound = (record: RdrNode, key: string): string | null => {
  const v = rdrGet(record, key);
  return typeof v === 'string' && /^[.~!]/.test(v) ? v : null;
};

/** The `ZWEAPON` record whose `InternalName` is `name`, its four sound keys; null when there is none. */
export function weaponSounds(script: RdrNode, name: string): WeaponSounds | null {
  const list = rdrGet(script, 'ZWEAPON');
  if (!Array.isArray(list)) throw new Error('zweapon.rdr has no ZWEAPON');
  const record = list.find((r): r is RdrNode[] => Array.isArray(r) && rdrGet(r, 'InternalName') === name);
  if (!record) return null;
  return {
    name, fireClose: sound(record, 'FireSoundClose'), fireMed: sound(record, 'FireSoundMed'),
    fireFar: sound(record, 'FireSoundFar'), reload: sound(record, 'ReloadSound'),
  };
}

/** `ZWEAPON.ZAR`'s one script, decoded. */
export function weaponScriptFromArchive(bytes: Uint8Array): RdrNode {
  const zar = Zar.parse(bytes);
  const key = zar.root.children.find((k) => k.name.toLowerCase() === 'zweapon.rdr');
  if (!key) throw new Error('ZWEAPON.ZAR has no zweapon.rdr');
  return parseRdr(zar.data(key));
}

/** The zAnim command that plays a sound: set 0, command 30 (`_zanim_cmd_hdr`'s type 0x1e). */
export const ZANIM_PLAY_SOUND = 30;

/** The shape of `@s2u/scene`'s `parseAnimSets` this reads (kept structural so the package needs no scene). */
export interface ZAnimSetsLike {
  sets: { name: string; anims: { name: string; names: string[]; sequences: { commands: { set: number; cmd: number }[] }[] }[] }[];
}

/**
 * The zAnim callbacks' sounds: `motion.rdr`'s `zanim_callback (name (jump_whoosh) time (0.4))` runs the zAnim of that
 * name, which a map's `CZANIM.ZAR` (its `common` set) holds; an animation whose sequence carries a play-sound command
 * (set 0, command 30: 32 bytes whose `u16` at +6 indexes the animation's name table -- read on `jump_whoosh` and
 * `ladder_rung`) plays the sound its name table names, the one entry with a sound's sigil (`.JUMP_WHOOSH`,
 * `.STEP_LADDER`, `.SHOTGUN_COCK`). Callback name to sound name, for every such animation of every set.
 */
export function callbackSounds(archive: ZAnimSetsLike): Map<string, string> {
  const out = new Map<string, string>();
  for (const set of archive.sets) {
    for (const anim of set.anims) {
      const plays = anim.sequences.some((q) => q.commands.some((c) => c.set === 0 && c.cmd === ZANIM_PLAY_SOUND));
      const name = anim.names.find((n) => /^[.~!][A-Z0-9_]/.test(n));
      if (plays && name && !out.has(anim.name)) out.set(anim.name, name);
    }
  }
  return out;
}
