import { parseRdr, rdrGet, Zar, type RdrNode } from '@s2u/archive';

/**
 * `RUN/SOUNDRDR.ZAR/sounds.rdr`, the sound script (web/docs/research/81 §3): under `SETS`, one list per bank block
 * (`MP2_AM`, `MP2_FX`, `HUDUI` ...) of the sounds that carry parameters, each named by the **CRC-32 of its bank
 * name** -- `.STEP_STONE` is 1440126871 -- and followed by keys: `ONESHOT`, `AMBIENT`, `DOPPLER`, `STREAMING_EFX`,
 * `RANGE (min max)`, `VOLUME`, `MED`/`FAR` (marks on a weapon's distance variants that the game never reads: its
 * key table has no such key, and the variant is chosen by distance, `./rules`' `fireVariant`) ... The reader is `FUN_003435c0`
 * (decomp 242323-242560): `RANGE` lands as two `u16` at +0xc/+0xe, `VOLUME` as a float at +4; the hash is
 * `FUN_003a2370`, a table CRC-32 over the name's bytes (poly 0x04C11DB7 reflected, init and final ~0 -- zlib's), and
 * the name a material or a weapon names is turned into the same number to look its sound up (`FUN_00344f30`).
 *
 * What `RANGE` means is `FUN_00342670` (decomp 241912-241955): full volume inside `min`, falling linearly to 0 at
 * `max`, silent beyond (`./rules`'s `rangeGain`).
 */

export interface SoundParams {
  /** The CRC-32 the script files it under (signed, as the compiled script holds it). */
  hash: number;
  oneShot: boolean;
  ambient: boolean;
  doppler: boolean;
  /** `RANGE`: world units, full inside the first, silent past the second. */
  range: [number, number] | null;
  /** `VOLUME`, when the entry has one. */
  volume: number | null;
  /** The script's `MED`/`FAR` marks (`.M4A1_M` is `MED`, `.M4A1_F` is `FAR`): data only, `FUN_003435c0` reads neither. */
  med: boolean;
  far: boolean;
}

/** One block's entries, by hash. */
export type SoundSet = Map<number, SoundParams>;

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** `FUN_003a2370`: the CRC-32 of a name's bytes, signed as the script stores it. */
export function soundHash(name: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < name.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ name.charCodeAt(i)) & 0xff]!;
  return ~c | 0;
}

const has = (entry: RdrNode[], key: string): boolean => entry.includes(key);
const numbers = (v: RdrNode | undefined): number[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(Number).filter(Number.isFinite) : typeof v === 'string' ? [Number(v)] : [];

/** Every `SETS` block of a decoded `sounds.rdr`, by block name (`MP2_AM`), its entries by hash. */
export function parseSoundScript(root: RdrNode): Map<string, SoundSet> {
  const sets = rdrGet(root, 'SETS');
  if (!Array.isArray(sets)) throw new Error('sounds.rdr has no SETS');
  const out = new Map<string, SoundSet>();
  for (let i = 0; i + 1 < sets.length; i += 2) {
    const name = sets[i], list = sets[i + 1];
    if (typeof name !== 'string' || !Array.isArray(list)) continue;
    const set: SoundSet = new Map();
    for (const entry of list) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const hash = Number(entry[0]);
      if (!Number.isInteger(hash)) continue;
      // `FUN_0032dd80(entry, "RANGE", ...)`: the first RANGE and the two numbers after it.
      const at = entry.indexOf('RANGE');
      const range = at >= 0 ? numbers(entry[at + 1]) : [];
      const vAt = entry.indexOf('VOLUME');
      const volume = vAt >= 0 ? numbers(entry[vAt + 1])[0] ?? null : null;
      set.set(hash, {
        hash, oneShot: has(entry, 'ONESHOT'), ambient: has(entry, 'AMBIENT'), doppler: has(entry, 'DOPPLER'),
        range: range.length >= 2 ? [range[0]!, range[1]!] : null, volume, med: has(entry, 'MED'), far: has(entry, 'FAR'),
      });
    }
    out.set(name, set);
  }
  return out;
}

/** `SOUNDRDR.ZAR`'s one script, decoded. */
export function soundScriptFromArchive(bytes: Uint8Array): Map<string, SoundSet> {
  const zar = Zar.parse(bytes);
  const key = zar.root.children.find((k) => k.name.toLowerCase() === 'sounds.rdr');
  if (!key) throw new Error('SOUNDRDR.ZAR has no sounds.rdr');
  return parseSoundScript(parseRdr(zar.data(key)));
}

/** A sound's parameters out of the first of `sets` that files its name. */
export function soundParams(script: ReadonlyMap<string, SoundSet>, sets: readonly string[], name: string): SoundParams | null {
  const hash = soundHash(name);
  for (const s of sets) {
    const p = script.get(s)?.get(hash);
    if (p) return p;
  }
  return null;
}
