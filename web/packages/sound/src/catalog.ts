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
  sets: {
    name: string;
    anims: { name: string; names: string[]; sequences: { commands: { offset: number; set: number; cmd: number }[] }[] }[];
  }[];
}

/**
 * Where a play-sound command's name index is: `(set, animation, command offset in Seq_Data) => the u16 at +6`, read
 * from the animation's `Seq_Data` key; null when the bytes are not to hand.
 */
export type ZAnimNameIndex = (set: string, anim: string, offset: number) => number | null;

/**
 * The zAnim callbacks' sounds: `motion.rdr`'s `zanim_callback (name (jump_whoosh) time (0.4))` runs the zAnim of that
 * name, which a map's `CZANIM.ZAR` (its `common` set) holds; each play-sound command of its sequences (set 0, command
 * 30, 32 bytes) names a sound through the `u16` at +6, an index into the animation's name table -- a sound's name,
 * with its sigil, on all 73 such commands of MP6's archive (`.JUMP_WHOOSH`, `.STEP_LADDER`; `law_impact` plays two,
 * `.EXP_1` and `.GREN_FAR`). Callback name to the sounds it plays, in command order. Without `nameIndex` an
 * animation's first sigiled name stands in for each command's.
 */
export function callbackSounds(archive: ZAnimSetsLike, nameIndex?: ZAnimNameIndex): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const set of archive.sets) {
    for (const anim of set.anims) {
      if (out.has(anim.name)) continue;
      const sounds: string[] = [];
      for (const q of anim.sequences) {
        for (const c of q.commands) {
          if (c.set !== 0 || c.cmd !== ZANIM_PLAY_SOUND) continue;
          const i = nameIndex?.(set.name, anim.name, c.offset) ?? null;
          const name = i !== null ? anim.names[i] : anim.names.find((n) => /^[.~!][A-Z0-9_]/.test(n));
          if (name && /^[.~!]/.test(name) && !sounds.includes(name)) sounds.push(name);
        }
      }
      if (sounds.length > 0) out.set(anim.name, sounds);
    }
  }
  return out;
}
