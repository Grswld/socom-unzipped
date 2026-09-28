import { Zar, parseRdr, rdrGet, type RdrNode } from '@s2u/archive';
import { rdrReal } from './tuning';

/**
 * The rifle a SEAL carries, off the game's own tables (web sprint 2, W2.5; the spec's §4 W2.5 and W2.R5):
 *
 * - **Which rifle.** `READERC.ZAR/character.rdr`'s `characters` list holds the multiplayer kits `mp_seal1` to
 *   `mp_seal4` once per theatre (arctic, scuba, jungle, desert); every `mp_seal1` lists `M4A1` first under
 *   `default_weapons`, then `Mark 23`, `M67`, `HE` (read 2026-09-28; `mp_seal2` the 870, `mp_seal3` the HK5,
 *   `mp_seal4` the SR-25). The M4A1 is taken as the SEAL's default primary: `mp_seal1` is the first kit, the one a
 *   player spawns with before choosing (a reading: the kit a slot is handed is game logic not traced here).
 * - **Its numbers.** `RUN/ZWEAPON.ZAR` is one script, `zweapon.rdr` (105,816 B): `WEAPON_GLOBAL`, `ZAMMO` (the rounds,
 *   `InternalName` and `ID`) and `ZWEAPON` (86 weapons and gear, `InternalName` ... ). The M4A1's record:
 *   `FireWait 0.12` -- the seconds between rounds, the file's only rate field (no rounds-per-minute key exists), so
 *   500 a minute; `Ammo_Capacity 30`; `NumMags 3`; `AMMO_TYPES (NAME "5.56 x 45mm")`, which `ZAMMO` gives `ID 8`;
 *   the weapon's own `ID 54`; `Maximum_Range 1000`; `DecalSet BULLET_MARK_SMALL`. reCOM holds them on `CZWeapon`
 *   (`research/recom/src/gamez/zWeapon/zweapon.h:515-529`: `m_ammocap`, `m_nummags`, `m_maxrange`, `m_firewait`,
 *   `m_reloadtime`; `zwep_weapon.cpp:53` defaults `m_firewait` to 0.1) and the soldier's kit on `CZKit`
 *   (`research/recom/src/gamez/zSeal/zseal.h:233-237` `m_item[30]`, `m_ammo[30]`, `m_reloads[30][10]`,
 *   `m_currentmag[30]`, `m_firemode[30]`; `:244` `m_fire_delay`; `:214-217` the rifle kick); SOCOM 1's uncompiled
 *   `research/recom/data/s1/common/zrdr/zweapon.rdr` spells the keys as this file does. **No reload time:** the
 *   M4A1's record has no `ReloadTime` (four records do -- Spas 12 2, JACKHAMMER 2, M60E3 3, M63A 2.5 -- and reCOM's
 *   loader defaults `m_reloadtime` to 0, `zwep_weapon.cpp:64`), so the rifle's reload is its animation's length.
 * - **The reticle's knock** (`Reticule_Modifiers STANCE_STAND`): `ReticuleKnock 12`, `ReticuleKnockReturn 70`,
 *   `ReticuleKnockMax 45` -- the bloom a shot adds, how fast it returns, and its cap, in the game's own units (not
 *   traced to pixels: `fire.ts` maps them onto W2.4's 0..1 spread as a ratio, an estimate).
 * - **The rifle kick** (WEAPON; `Reticule_Modifiers STANCE_STAND/CROUCH/PRONE`): `FireRifleKickRate`,
 *   `FireRifleKickReturnRate`, `FireRifleKickBaseDist`, `FireRifleKickRandomDist` -- the aim's climb a round, read by
 *   the game's `FUN_005b91c0` / `FUN_005b9280` into the aim pitch in radians (`viewer/src/rifleKick.ts`). The M4A1:
 *   0.5 / 0.18 / 0.09 / 0.015 standing, 0.08 crouched, 0.06 prone.
 * - **The effect and the sounds** (WEAPON, for the muzzle and the audio): `FireAnimName` (the CZANIM animation a round
 *   plays at the muzzle: the M4A1's `muzzle_m4` is `shell_eject`, `flash_fire_hider`, `shell_smoke_med`; the M4A1
 *   SD's `muzzle_m4SD` has no flash), `FireSoundClose`/`Med`/`Far` and `ReloadSound` (the sound bank's names).
 * - **The mark.** `READERC.ZAR/decals.rdr`'s `DECAL_SETS` entry `BULLET_MARK_SMALL` lists a bitmap and a size range
 *   per surface material; the viewer does not model the SOILS materials (the table is not in a map's archive, as
 *   `probe.ts` says of its own material test), so it takes the `STONE` row: `bullet_mark_stone.tif`, 1 to 1.8 units.
 *   The bitmaps ride in every map archive's `RUN\COMMON\EFFE_TXR.ZED` (`viewer/src/hudBitmaps.ts`).
 */

/** One stance's rifle kick (`Reticule_Modifiers STANCE_*`): rates in radians a second, sizes in radians. */
export interface RifleKick { rate: number; returnRate: number; baseDist: number; randomDist: number }

/** The three stance records of `Reticule_Modifiers`, as the game's `FUN_0058a720` picks one. */
export const KICK_STANCES = { stand: 'STANCE_STAND', crouch: 'STANCE_CROUCH', prone: 'STANCE_PRONE' } as const;

/** One weapon out of `zweapon.rdr`, the fields the viewer's shot uses. */
export interface WeaponRecord {
  /** `InternalName`. */
  name: string;
  /** `ID`: the weapon's own id in the table. */
  id: number;
  /** `FireWait`: seconds between rounds, the file's rate field. */
  fireWait: number;
  /** 60 / `FireWait`, rounded to a whole round. */
  roundsPerMinute: number;
  /** `Ammo_Capacity`: rounds a magazine. */
  magazine: number;
  /** `NumMags`: the magazines carried, the loaded one among them (a reading: `fire.ts`). */
  mags: number;
  /** `AMMO_TYPES`' first `NAME`: the round, as `ZAMMO` names it. */
  ammo: string;
  /** That round's `ID` in `ZAMMO`. */
  ammoId: number;
  /** `Maximum_Range`, units. */
  maximumRange: number;
  /** `DecalSet`: the `decals.rdr` set its hits mark with. */
  decalSet: string;
  /** `Reticule_Modifiers STANCE_STAND`: `ReticuleKnock`, `ReticuleKnockReturn`, `ReticuleKnockMax`. */
  knock: { knock: number; knockReturn: number; knockMax: number };
  /** WEAPON: the rifle kick per stance (`FireRifleKick*`), null for a stance the record does not give. */
  rifleKick: Record<keyof typeof KICK_STANCES, RifleKick | null>;
  /** WEAPON: `FireAnimName`, the muzzle's CZANIM animation, or null. */
  fireAnim: string | null;
  /** WEAPON: `FireSoundClose`, `FireSoundMed`, `FireSoundFar`, `ReloadSound`: the sound bank's names, or null. */
  sounds: { close: string | null; med: string | null; far: string | null; reload: string | null };
}

/** One row of a `decals.rdr` set: the bitmap and the size range for one material. */
export interface DecalEntry { set: string; material: string; texture: string; minSize: number; maxSize: number }

const text = (node: RdrNode, key: string, where: string): string => {
  const v = rdrGet(node, key);
  if (typeof v !== 'string') throw new Error(`${where} has no ${key}`);
  return v;
};

/** The records of a list key (`ZWEAPON`, `ZAMMO`), each a flat key/value list. */
function records(script: RdrNode, key: string): RdrNode[][] {
  const list = rdrGet(script, key);
  if (!Array.isArray(list)) throw new Error(`zweapon.rdr has no ${key}`);
  return list.filter((r): r is RdrNode[] => Array.isArray(r));
}

/** `zweapon.rdr`, decoded: the `ZWEAPON` record named `name`, its round looked up in `ZAMMO`. */
export function weaponRecord(script: RdrNode, name: string): WeaponRecord {
  const record = records(script, 'ZWEAPON').find((r) => rdrGet(r, 'InternalName') === name);
  if (!record) throw new Error(`zweapon.rdr has no weapon ${name}`);
  const where = `zweapon.rdr ${name}`;
  const n = (key: string, node: RdrNode = record, at = where): number => rdrReal(node, key, 1, at);
  const ammoTypes = rdrGet(record, 'AMMO_TYPES');
  if (ammoTypes === undefined) throw new Error(`${where} has no AMMO_TYPES`);
  const ammo = text(ammoTypes, 'NAME', `${where} AMMO_TYPES`);
  const round = records(script, 'ZAMMO').find((r) => rdrGet(r, 'InternalName') === ammo);
  if (!round) throw new Error(`zweapon.rdr ZAMMO has no ${ammo}`);
  const modifiers = rdrGet(record, 'Reticule_Modifiers');
  const stand = modifiers === undefined ? undefined : rdrGet(modifiers, 'STANCE_STAND');
  if (stand === undefined) throw new Error(`${where} has no Reticule_Modifiers STANCE_STAND`);
  const fireWait = n('FireWait');
  const knockAt = `${where} STANCE_STAND`;
  const kick = (stance: string): RifleKick | null => {
    const record = modifiers === undefined ? undefined : rdrGet(modifiers, stance);
    if (record === undefined || rdrGet(record, 'FireRifleKickRate') === undefined) return null;
    const at = `${where} ${stance}`;
    return {
      rate: n('FireRifleKickRate', record, at), returnRate: n('FireRifleKickReturnRate', record, at),
      baseDist: n('FireRifleKickBaseDist', record, at), randomDist: n('FireRifleKickRandomDist', record, at),
    };
  };
  const optional = (key: string): string | null => {
    const v = rdrGet(record, key);
    return typeof v === 'string' ? v : null;
  };
  return {
    name, id: n('ID'), fireWait, roundsPerMinute: Math.round(60 / fireWait),
    magazine: n('Ammo_Capacity'), mags: n('NumMags'),
    ammo, ammoId: n('ID', round, `zweapon.rdr ZAMMO ${ammo}`),
    maximumRange: n('Maximum_Range'), decalSet: text(record, 'DecalSet', where),
    knock: { knock: n('ReticuleKnock', stand, knockAt), knockReturn: n('ReticuleKnockReturn', stand, knockAt), knockMax: n('ReticuleKnockMax', stand, knockAt) },
    rifleKick: { stand: kick(KICK_STANCES.stand), crouch: kick(KICK_STANCES.crouch), prone: kick(KICK_STANCES.prone) },
    fireAnim: optional('FireAnimName'),
    sounds: { close: optional('FireSoundClose'), med: optional('FireSoundMed'), far: optional('FireSoundFar'), reload: optional('ReloadSound') },
  };
}

/**
 * `character.rdr`: the first `wep_name` under `default_weapons` of every `characters` record named `who`, in file
 * order. The name also appears as an inheritance line (`mp_seal1 : mp_seal (sounds ...)`), whose value is the
 * string `:`; that one and any record without a kit are passed over.
 */
export function kitPrimaries(character: RdrNode, who = 'mp_seal1'): string[] {
  const characters = rdrGet(character, 'characters');
  if (!Array.isArray(characters)) throw new Error('character.rdr has no characters');
  const out: string[] = [];
  for (let i = 0; i + 1 < characters.length; i++) {
    if (characters[i] !== who) continue;
    const weapons = rdrGet(characters[i + 1]!, 'default_weapons');
    if (!Array.isArray(weapons)) continue;
    const first = typeof weapons[0] === 'string' ? weapons : weapons[0];
    const name = first === undefined ? undefined : rdrGet(first, 'wep_name');
    if (typeof name === 'string') out.push(name);
  }
  return out;
}

/** The first of `kitPrimaries` (`mp_seal1`: the header). */
export function defaultPrimary(character: RdrNode, who = 'mp_seal1'): string {
  const name = kitPrimaries(character, who)[0];
  if (name === undefined) throw new Error(`character.rdr has no default weapon for ${who}`);
  return name;
}

/** `decals.rdr`'s `DECAL_SETS`: the row of set `set` for material `material`. */
export function decalEntry(decals: RdrNode, set: string, material: string): DecalEntry {
  const sets = rdrGet(decals, 'DECAL_SETS');
  if (!Array.isArray(sets)) throw new Error('decals.rdr has no DECAL_SETS');
  // A set is a list of records: the first carries SETNAME, the rest one material each.
  const rows = sets.find((s): s is RdrNode[] => Array.isArray(s) && s.some((r) => rdrGet(r, 'SETNAME') === set));
  if (!rows) throw new Error(`decals.rdr has no decal set ${set}`);
  const row = rows.find((r) => rdrGet(r, 'MATERIALNAME') === material);
  if (!row) throw new Error(`decals.rdr ${set} has no material ${material}`);
  const where = `decals.rdr ${set} ${material}`;
  return {
    set, material, texture: text(row, 'TEXTURENAME', where),
    minSize: rdrReal(row, 'MIN_SIZE', 1, where), maxSize: rdrReal(row, 'MAX_SIZE', 1, where),
  };
}

/** A root script of a `.ZAR`, by name (the scripts are root children, named with the suffix: 36 §6). */
function script(zar: Zar, archive: string, name: string): RdrNode {
  const key = zar.root.children.find((k) => k.name.toLowerCase() === name);
  if (!key) throw new Error(`${archive} has no ${name}`);
  return parseRdr(zar.data(key));
}

/** `ZWEAPON.ZAR` and `READERC.ZAR` -> the multiplayer SEAL's default primary's record. */
export function readDefaultRifle(zweapon: Uint8Array, readerc: Uint8Array): WeaponRecord {
  const name = defaultPrimary(script(Zar.parse(readerc), 'READERC.ZAR', 'character.rdr'));
  return weaponRecord(script(Zar.parse(zweapon), 'ZWEAPON.ZAR', 'zweapon.rdr'), name);
}

/** The material the viewer marks every surface as (the header: the SOILS table is not in hand). */
export const MARK_MATERIAL = 'STONE';

/** `READERC.ZAR` -> `decals.rdr`'s `set` row for `MARK_MATERIAL`. */
export function readBulletMark(readerc: Uint8Array, set: string): DecalEntry {
  return decalEntry(script(Zar.parse(readerc), 'READERC.ZAR', 'decals.rdr'), set, MARK_MATERIAL);
}

/**
 * `RUN/ZWEAPON.ZAR/zweapon.rdr`'s M4A1, the default primary of `READERC.ZAR/character.rdr`'s `mp_seal1`, transcribed
 * (W2.R5): what the viewer uses, since it does not fetch the archive. `test/weapons.test.ts` proves it deep-equals
 * `readDefaultRifle` of the game's files on every run that has them.
 */
export const DEFAULT_RIFLE: WeaponRecord = {
  name: 'M4A1', id: 54, fireWait: 0.12, roundsPerMinute: 500, magazine: 30, mags: 3,
  ammo: '5.56 x 45mm', ammoId: 8, maximumRange: 1000, decalSet: 'BULLET_MARK_SMALL',
  knock: { knock: 12, knockReturn: 70, knockMax: 45 },
  rifleKick: {
    stand: { rate: 0.5, returnRate: 0.18, baseDist: 0.09, randomDist: 0.015 },
    crouch: { rate: 0.5, returnRate: 0.18, baseDist: 0.08, randomDist: 0.015 },
    prone: { rate: 0.5, returnRate: 0.18, baseDist: 0.06, randomDist: 0.015 },
  },
  fireAnim: 'muzzle_m4',
  sounds: { close: '.M4A1', med: '.M4A1_M', far: '.M4A1_F', reload: '.M4A1_RLD' },
};

/**
 * `zweapon.rdr`'s M4A1 SD (ID 62), transcribed and pinned as `DEFAULT_RIFLE` is: the rifle the viewer's SEAL holds
 * and fires (the owner's pick, W2.R4 of the cloud sprint 2, over `mp_seal1`'s kit default, the plain M4A1). Against
 * the M4A1: `FireWait` 0.14 (429 a minute), `Maximum_Range` 800, `muzzle_m4SD` (shell and smoke, no flash), and the
 * suppressed `.M4A1_SIL` with no medium or far variant.
 */
export const HELD_RIFLE: WeaponRecord = {
  name: 'M4A1 SD', id: 62, fireWait: 0.14, roundsPerMinute: 429, magazine: 30, mags: 3,
  ammo: '5.56 x 45mm', ammoId: 8, maximumRange: 800, decalSet: 'BULLET_MARK_SMALL',
  knock: { knock: 12, knockReturn: 70, knockMax: 45 },
  rifleKick: {
    stand: { rate: 0.5, returnRate: 0.18, baseDist: 0.09, randomDist: 0.015 },
    crouch: { rate: 0.5, returnRate: 0.18, baseDist: 0.08, randomDist: 0.015 },
    prone: { rate: 0.5, returnRate: 0.18, baseDist: 0.06, randomDist: 0.015 },
  },
  fireAnim: 'muzzle_m4SD',
  sounds: { close: '.M4A1_SIL', med: null, far: null, reload: '.M4A1_SIL_RLD' },
};

/** `READERC.ZAR/decals.rdr`'s `BULLET_MARK_SMALL` row for `STONE`, transcribed and pinned as `DEFAULT_RIFLE` is. */
export const BULLET_MARK: DecalEntry = {
  set: 'BULLET_MARK_SMALL', material: 'STONE', texture: 'bullet_mark_stone.tif', minSize: 1, maxSize: 1.8,
};
