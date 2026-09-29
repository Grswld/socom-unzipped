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
 *   `ReticuleKnockMax 45` -- the pixels of the 640x448 frame a round climbs the reticle, its return a second, and its
 *   cap; every stance's whole `Reticule_Modifiers` struct is `stances` (research 84, `viewer/src/accuracy.ts`).
 * - **The rifle kick** (WEAPON; `Reticule_Modifiers STANCE_STAND/CROUCH/PRONE`): `FireRifleKickRate`,
 *   `FireRifleKickReturnRate`, `FireRifleKickBaseDist`, `FireRifleKickRandomDist` -- the aim's climb a round, read by
 *   the game's `FUN_005b91c0` / `FUN_005b9280` into the aim pitch in radians (`viewer/src/rifleKick.ts`). The M4A1:
 *   0.5 / 0.18 / 0.09 / 0.015 standing, 0.08 crouched, 0.06 prone.
 * - **The effect and the sounds** (WEAPON, for the muzzle and the audio): `FireAnimName` (the CZANIM animation a round
 *   plays at the muzzle: the M4A1's `muzzle_m4` is `shell_eject`, `flash_fire_hider`, `shell_smoke_med`; the M4A1
 *   SD's `muzzle_m4SD` has no flash), `FireSoundClose`/`Med`/`Far` and `ReloadSound` (the sound bank's names).
 * - **The mark.** `READERC.ZAR/decals.rdr`'s `DECAL_SETS` entry `BULLET_MARK_SMALL` lists a bitmap and a size range
 *   per surface material. The effects resolve the hit polygon's material to its row (`READERC.ZAR/materials.rdr`'s
 *   SOILS, web/docs/research/89 §5); without those tables the viewer takes the `STONE` row: `bullet_mark_stone.tif`,
 *   1 to 1.8 units.
 *   The bitmaps ride in every map archive's `RUN\COMMON\EFFE_TXR.ZED` (`viewer/src/hudBitmaps.ts`).
 */

/**
 * The metres-to-units factor the weapon reader applies to its ranges and speeds: `DAT_003dfe10` = 10.0, the multiplier
 * `CZWeapon`'s parser (0x3cda30, `socom2_game.elf.decomp.c:322405-322445`) puts on `Muzzle_Velocity`,
 * `Gravity_Acceleration`, `ImpactRadius`, `Effective_Range` and `Maximum_Range` -- the file's numbers are metres, the
 * game's world is in tenths of one (the HUD's `RANGE(m): %.0f` divides a distance by 10: 0x216770). Research 84 §2.
 */
export const UNITS_PER_METRE = 10;

/** The three stances of `Reticule_Modifiers`, in the parser's order (0 `STANCE_STAND`, 1 crouch, 2 prone). */
export const WEAPON_STANCES = ['stand', 'crouch', 'prone'] as const;
export type WeaponStanceName = (typeof WEAPON_STANCES)[number];

/**
 * One `Reticule_Modifiers` stance of a weapon: the 0x74-byte struct at weapon `+0xf8 + stance x 0x74` (`FUN_003c5a50`)
 * that `CZWeapon`'s parser fills (0x3cda30, decomp 322197-322356), with the offset each field lives at. Units: the
 * reticle's are PS2 pixels of the 640x448 frame (research 84 §3), the kick's radians and radians a second of the aim
 * pitch (§5). A stance absent from the file keeps the one before it: the parser copies stance n-1 into n first.
 */
export interface WeaponStance {
  /** `ReticuleKnock` (+0x00): pixels the reticle climbs a round. */
  knock: number;
  /** `ReticuleKnockReturn` (+0x04): pixels a second it comes back. */
  knockReturn: number;
  /** `ReticuleKnockMax` (+0x08): the climb's limit, pixels. */
  knockMax: number;
  /** `SniperDistPPFrameX`/`Y` (+0x0c/+0x10): the scoped sway's speed, pixels a second (its sign is the direction). */
  swayRateX: number; swayRateY: number;
  /** `SniperDistLimitX`/`Y` (+0x14/+0x18): the scoped sway's reach, pixels. */
  swayLimitX: number; swayLimitY: number;
  /** `SniperDecayRate` (+0x1c). */
  sniperDecay: number;
  /** `TargetDilateUponFire` (+0x20): pixels the reticle opens a round. */
  dilateFire: number;
  /** `TargetDilateUponMovement` (+0x24): pixels a 60 Hz tick it opens toward the movement's size. */
  dilateMove: number;
  /** `TargetDilateUponMovementMult` (+0x28, default 1): the speed term's multiplier. */
  dilateMoveMult: number;
  /** `TargetConstrict` (+0x30): pixels a second it closes. */
  constrict: number;
  /** `TargetMin` / `TargetMax` (+0x34/+0x38): the reticle's size range, pixels. */
  targetMin: number; targetMax: number;
  /** `FireRifleKickRate` / `FireRifleKickReturnRate` (+0x3c/+0x40): the scoped kick's rise and fall, radians a second. */
  kickRate: number; kickReturnRate: number;
  /** `FireRifleKickBaseDist` + rand x `FireRifleKickRandomDist` (+0x44/+0x48): the kick's height, radians. */
  kickBase: number; kickRandom: number;
  /** `KnockCount` (+0x6c, default 3): the round of a pull the knock starts on, at `KnockEntryStrength` (+0x70, default 1). */
  knockCount: number; knockEntry: number;
}

/** One stance's rifle kick (`Reticule_Modifiers STANCE_*`): rates in radians a second, sizes in radians. */
export interface RifleKick { rate: number; returnRate: number; baseDist: number; randomDist: number }

/** The three stance records of `Reticule_Modifiers`, as the game's `FUN_0058a720` picks one. */
export const KICK_STANCES = { stand: 'STANCE_STAND', crouch: 'STANCE_CROUCH', prone: 'STANCE_PRONE' } as const;

/** One weapon out of `zweapon.rdr`: the fields the viewer's shot, reticle, zoom, muzzle and sounds use. */
export interface WeaponRecord {
  /** `InternalName`. */
  name: string;
  /** `ID`: the weapon's own id in the table -- the `EQUIP_ITEM` the reticle set is chosen by (weapon `+0x7c`). */
  id: number;
  /** `FireWait`: seconds between rounds, the file's rate field (weapon `+0x50`). */
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
  /**
   * That round's `Piercing` (`ZAMMO`, ammo `+0x14`, 0 when absent: `FUN_003cedb0`): a penetrated surface leaves the
   * round `range x (1 + Piercing x 0.1) x PENETRATION` (`FUN_003c8920`; research 84 section 13). 5.56 x 45mm: 3.
   */
  piercing: number;
  /** `Maximum_Range`, metres (x `UNITS_PER_METRE` in the world). */
  maximumRange: number;
  /** `Effective_Range`, metres (0 when absent). */
  effectiveRange: number;
  /** `DecalSet`: the `decals.rdr` set its hits mark with. */
  decalSet: string;
  /** `Reticule_Modifiers STANCE_STAND`: `ReticuleKnock`, `ReticuleKnockReturn`, `ReticuleKnockMax` (= `stances.stand`'s). */
  knock: { knock: number; knockReturn: number; knockMax: number };
  /** `Reticule_Modifiers`, all three stances, the parser's inheritance applied. */
  stances: Record<WeaponStanceName, WeaponStance>;
  /** `ZoomMode0..NumZoomModes-1` (weapon `+0x280` vector): view state s >= 5 magnifies by `zoomModes[s - 4]`. */
  zoomModes: number[];
  /** `AccBurstCnt_Min`/`_Max` and `AccScalar_Min`/`_Max` (weapon `+0x268..+0x274`): the bloom's growth over a burst. */
  accuracyBurst: { countMin: number; countMax: number; scalarMin: number; scalarMax: number };
  /** The highest fire mode (weapon `+0x24`): `MaxFireMode`, raised by an explicit mode key. */
  maxFireMode: number;
  /** The fire modes the switch stops on, 1 single, 2 burst, 3 automatic (weapon `+0xd0..`: `FUN_003d2a80`/`2a30`). */
  fireModes: number[];
  /** `RecoilPct` (weapon `+0x6c`): what a round adds to the body's `+0x378` (capped at 10; `FUN_0057d510`). */
  recoilPct: number;
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

/** The stance struct as `FUN_003c59c0` constructs it: zeros, `TargetDilateUponMovementMult` 1, `KnockCount` 3, `KnockEntryStrength` 1. */
const STANCE_DEFAULTS: WeaponStance = {
  knock: 0, knockReturn: 0, knockMax: 0, swayRateX: 0, swayRateY: 0, swayLimitX: 0, swayLimitY: 0, sniperDecay: 0,
  dilateFire: 0, dilateMove: 0, dilateMoveMult: 1, constrict: 0, targetMin: 0, targetMax: 0,
  kickRate: 0, kickReturnRate: 0, kickBase: 0, kickRandom: 0, knockCount: 3, knockEntry: 1,
};

/** The file's key for each `WeaponStance` field, in the parser's order (0x3cda30). */
const STANCE_KEYS: [keyof WeaponStance, string][] = [
  ['knock', 'ReticuleKnock'], ['knockReturn', 'ReticuleKnockReturn'], ['knockMax', 'ReticuleKnockMax'],
  ['dilateFire', 'TargetDilateUponFire'], ['dilateMove', 'TargetDilateUponMovement'],
  ['dilateMoveMult', 'TargetDilateUponMovementMult'], ['constrict', 'TargetConstrict'], ['targetMin', 'TargetMin'],
  ['targetMax', 'TargetMax'], ['swayRateX', 'SniperDistPPFrameX'], ['swayLimitX', 'SniperDistLimitX'],
  ['swayRateY', 'SniperDistPPFrameY'], ['swayLimitY', 'SniperDistLimitY'], ['sniperDecay', 'SniperDecayRate'],
  ['kickRate', 'FireRifleKickRate'], ['kickReturnRate', 'FireRifleKickReturnRate'], ['kickBase', 'FireRifleKickBaseDist'],
  ['kickRandom', 'FireRifleKickRandomDist'], ['knockCount', 'KnockCount'], ['knockEntry', 'KnockEntryStrength'],
];

const STANCE_NODES: Record<WeaponStanceName, string> = { stand: 'STANCE_STAND', crouch: 'STANCE_CROUCH', prone: 'STANCE_PRONE' };

/** A number under `key`, or undefined when the key is absent (the parser then keeps what it had). */
function optReal(node: RdrNode | undefined, key: string, where: string): number | undefined {
  if (node === undefined || rdrGet(node, key) === undefined) return undefined;
  return rdrReal(node, key, 1, where);
}

/**
 * `Reticule_Modifiers`, the way the parser reads it: stance n starts as a copy of stance n-1 (stance 0 as the
 * constructor's), then each key present overwrites its field. The file's per-stance `AccuracyBurstCnt_*` and
 * `AccuracyScalar_*` have no string in the ELF (research 84 §2): nothing reads them, and neither does this.
 */
export function weaponStances(modifiers: RdrNode | undefined, where: string): Record<WeaponStanceName, WeaponStance> {
  const out = {} as Record<WeaponStanceName, WeaponStance>;
  let prev = STANCE_DEFAULTS;
  for (const stance of WEAPON_STANCES) {
    const node = modifiers === undefined ? undefined : rdrGet(modifiers, STANCE_NODES[stance]);
    const s: WeaponStance = { ...prev };
    for (const [field, key] of STANCE_KEYS) {
      const v = optReal(node, key, `${where} ${STANCE_NODES[stance]}`);
      if (v !== undefined) s[field] = v;
    }
    out[stance] = s;
    prev = s;
  }
  return out;
}

/** `zweapon.rdr`, decoded: the `ZWEAPON` record named `name`, its round looked up in `ZAMMO`. */
export function weaponRecord(script: RdrNode, name: string): WeaponRecord {
  const record = records(script, 'ZWEAPON').find((r) => rdrGet(r, 'InternalName') === name);
  if (!record) throw new Error(`zweapon.rdr has no weapon ${name}`);
  const where = `zweapon.rdr ${name}`;
  const n = (key: string, node: RdrNode = record, at = where): number => rdrReal(node, key, 1, at);
  const opt = (key: string, fallback: number): number => optReal(record, key, where) ?? fallback;
  const ammoTypes = rdrGet(record, 'AMMO_TYPES');
  if (ammoTypes === undefined) throw new Error(`${where} has no AMMO_TYPES`);
  const ammo = text(ammoTypes, 'NAME', `${where} AMMO_TYPES`);
  const round = records(script, 'ZAMMO').find((r) => rdrGet(r, 'InternalName') === ammo);
  if (!round) throw new Error(`zweapon.rdr ZAMMO has no ${ammo}`);
  const modifiers = rdrGet(record, 'Reticule_Modifiers');
  const standNode = modifiers === undefined ? undefined : rdrGet(modifiers, 'STANCE_STAND');
  if (standNode === undefined) throw new Error(`${where} has no Reticule_Modifiers STANCE_STAND`);
  const fireWait = n('FireWait');
  const knockAt = `${where} STANCE_STAND`;
  // ZoomMode%d for 0..NumZoomModes-1; a missing one is -1 (the parser's 0xbf800000).
  const zoomModes: number[] = [];
  for (let i = 0; i < opt('NumZoomModes', 0); i++) zoomModes.push(opt(`ZoomMode${i}`, -1));
  // FUN_003d2a80(MaxFireMode) enables modes 0..max; BurstMode, SingleMode and AutoMode enable 2, 1, 3 and raise the max.
  let maxFireMode = opt('MaxFireMode', 0);
  const enabled = new Set<number>();
  for (let m = 0; m <= maxFireMode && m < 5; m++) enabled.add(m);
  for (const [key, mode] of [['BurstMode', 2], ['SingleMode', 1], ['AutoMode', 3]] as const) {
    if (rdrGet(record, key) !== undefined) { enabled.add(mode); maxFireMode = Math.max(maxFireMode, mode); }
  }
  const stances = weaponStances(modifiers, where);
  // WEAPON's per-stance kick, off the parsed stances (so a stance inherits the one before, as the parser copies it);
  // null for a stance with no kick (the constructor's zeros).
  const kick = (stance: WeaponStanceName): RifleKick | null => {
    const st = stances[stance];
    return st.kickRate === 0 && st.kickBase === 0 ? null
      : { rate: st.kickRate, returnRate: st.kickReturnRate, baseDist: st.kickBase, randomDist: st.kickRandom };
  };
  const optional = (key: string): string | null => {
    const v = rdrGet(record, key);
    return typeof v === 'string' ? v : null;
  };
  return {
    name, id: n('ID'), fireWait, roundsPerMinute: Math.round(60 / fireWait),
    magazine: n('Ammo_Capacity'), mags: n('NumMags'),
    ammo, ammoId: n('ID', round, `zweapon.rdr ZAMMO ${ammo}`), piercing: optReal(round, 'Piercing', `zweapon.rdr ZAMMO ${ammo}`) ?? 0,
    maximumRange: n('Maximum_Range'), effectiveRange: opt('Effective_Range', 0), decalSet: text(record, 'DecalSet', where),
    knock: { knock: n('ReticuleKnock', standNode, knockAt), knockReturn: n('ReticuleKnockReturn', standNode, knockAt), knockMax: n('ReticuleKnockMax', standNode, knockAt) },
    stances, zoomModes,
    accuracyBurst: {
      countMin: opt('AccBurstCnt_Min', 0), countMax: opt('AccBurstCnt_Max', 0),
      scalarMin: opt('AccScalar_Min', 0), scalarMax: opt('AccScalar_Max', 0),
    },
    maxFireMode, fireModes: [1, 2, 3].filter((m) => enabled.has(m)),
    recoilPct: opt('RecoilPct', 0),
    rifleKick: { stand: kick('stand'), crouch: kick('crouch'), prone: kick('prone') },
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

/** `ZWEAPON.ZAR` -> the record named `name` (`M4A1 SD`, ...). */
export function readWeapon(zweapon: Uint8Array, name: string): WeaponRecord {
  return weaponRecord(script(Zar.parse(zweapon), 'ZWEAPON.ZAR', 'zweapon.rdr'), name);
}

/** The material the viewer marks every surface as when the effects' tables are not in hand (the header). */
export const MARK_MATERIAL = 'STONE';

/** `READERC.ZAR` -> `decals.rdr`'s `set` row for `MARK_MATERIAL`. */
export function readBulletMark(readerc: Uint8Array, set: string): DecalEntry {
  return decalEntry(script(Zar.parse(readerc), 'READERC.ZAR', 'decals.rdr'), set, MARK_MATERIAL);
}

/** A `WeaponStance` written short: the twenty fields in `STANCE_KEYS`' order of the interface. */
function stance(
  knock: number, knockReturn: number, knockMax: number,
  [swayRateX, swayRateY, swayLimitX, swayLimitY, sniperDecay]: number[],
  [dilateFire, dilateMove, dilateMoveMult, constrict, targetMin, targetMax]: number[],
  [kickRate, kickReturnRate, kickBase, kickRandom]: number[],
  knockCount: number, knockEntry: number,
): WeaponStance {
  return {
    knock, knockReturn, knockMax, swayRateX: swayRateX!, swayRateY: swayRateY!, swayLimitX: swayLimitX!, swayLimitY: swayLimitY!,
    sniperDecay: sniperDecay!, dilateFire: dilateFire!, dilateMove: dilateMove!, dilateMoveMult: dilateMoveMult!,
    constrict: constrict!, targetMin: targetMin!, targetMax: targetMax!, kickRate: kickRate!, kickReturnRate: kickReturnRate!,
    kickBase: kickBase!, kickRandom: kickRandom!, knockCount, knockEntry,
  };
}

/**
 * `RUN/ZWEAPON.ZAR/zweapon.rdr`'s M4A1, the default primary of `READERC.ZAR/character.rdr`'s `mp_seal1`, transcribed
 * (W2.R5): what the viewer uses, since it does not fetch the archive. `test/weapons.test.ts` proves it deep-equals
 * `readDefaultRifle` of the game's files on every run that has them. Research 84 prints every number.
 */
export const DEFAULT_RIFLE: WeaponRecord = {
  name: 'M4A1', id: 54, fireWait: 0.12, roundsPerMinute: 500, magazine: 30, mags: 3,
  ammo: '5.56 x 45mm', ammoId: 8, piercing: 3, maximumRange: 1000, effectiveRange: 600, decalSet: 'BULLET_MARK_SMALL',
  knock: { knock: 12, knockReturn: 70, knockMax: 45 },
  stances: {
    stand: stance(12, 70, 45, [5, 4, 20, 24, -0.06], [7, 1, 1, 50, 1, 26], [0.5, 0.18, 0.09, 0.015], 1, 0.4),
    crouch: stance(9, 75, 45, [4, 4, 16, 19, -0.06], [7, 1, 13, 55, 1, 25], [0.5, 0.18, 0.08, 0.015], 1, 0.4),
    prone: stance(8, 75, 20, [4, 4, 12, 15, -0.2], [7, 1, 63, 50, 1, 24], [0.5, 0.18, 0.06, 0.015], 1, 0.4),
  },
  zoomModes: [1.5, 2.5],
  accuracyBurst: { countMin: 4, countMax: 7, scalarMin: 0, scalarMax: 0.03 },
  maxFireMode: 3, fireModes: [1, 2, 3], recoilPct: 0.2,
  rifleKick: {
    stand: { rate: 0.5, returnRate: 0.18, baseDist: 0.09, randomDist: 0.015 },
    crouch: { rate: 0.5, returnRate: 0.18, baseDist: 0.08, randomDist: 0.015 },
    prone: { rate: 0.5, returnRate: 0.18, baseDist: 0.06, randomDist: 0.015 },
  },
  fireAnim: 'muzzle_m4',
  sounds: { close: '.M4A1', med: '.M4A1_M', far: '.M4A1_F', reload: '.M4A1_RLD' },
};

/**
 * `zweapon.rdr`'s **M4A1 SD** (`ID 62`, `ModelName m4Acarbine_sd`), transcribed and pinned as `DEFAULT_RIFLE` is: the
 * rifle the viewer's SEAL holds and fires (the owner's pick, W2.R4, over `mp_seal1`'s kit default, the plain M4A1).
 * Beside the M4A1 it fires slower (`FireWait` 0.14, 429 a minute), reaches less (800 m), zooms further (`ZoomMode1` 3),
 * sways faster scoped (6 px/s standing), knocks harder crouched and prone (11, 10), crouches to a finer rest
 * (`TargetMin` 0.75) and never grows its bloom over a burst (`AccScalar_Max` 0); `muzzle_m4SD` (shell and smoke, no
 * flash) and the suppressed `.M4A1_SIL` with no medium or far variant. Research 84 prints every number.
 */
export const HELD_RIFLE: WeaponRecord = {
  name: 'M4A1 SD', id: 62, fireWait: 0.14, roundsPerMinute: 429, magazine: 30, mags: 3,
  ammo: '5.56 x 45mm', ammoId: 8, piercing: 3, maximumRange: 800, effectiveRange: 550, decalSet: 'BULLET_MARK_SMALL',
  knock: { knock: 12, knockReturn: 70, knockMax: 45 },
  stances: {
    stand: stance(12, 70, 45, [6, 6, 20, 24, -0.04], [7, 1, 1, 50, 1, 26], [0.5, 0.18, 0.09, 0.015], 1, 0.4),
    crouch: stance(11, 75, 45, [5, 5, 16, 19, -0.05], [7, 1, 13, 55, 0.75, 25], [0.5, 0.18, 0.08, 0.015], 1, 0.4),
    prone: stance(10, 75, 20, [4, 4, 12, 15, -0.2], [7, 1, 63, 50, 1, 24], [0.5, 0.18, 0.06, 0.015], 1, 0.4),
  },
  zoomModes: [1.5, 3],
  accuracyBurst: { countMin: 5, countMax: 10, scalarMin: 0, scalarMax: 0 },
  maxFireMode: 3, fireModes: [1, 2, 3], recoilPct: 0.2,
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
