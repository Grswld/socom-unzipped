import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Zar, parseRdr, rdrGet, type RdrNode } from '@s2u/archive';
import {
  BULLET_MARK, DEFAULT_RIFLE, M4A1_SD, UNITS_PER_METRE, decalEntry, defaultPrimary, kitPrimaries, readBulletMark,
  readDefaultRifle, readWeapon, weaponRecord,
  type DecalEntry, type WeaponRecord,
} from '../src/weapons';

/**
 * The weapon table (web sprint 2, W2.5): `RUN/ZWEAPON.ZAR/zweapon.rdr`'s records, the SEAL's default primary out of
 * `READERC.ZAR/character.rdr`, and the bullet mark out of `READERC.ZAR/decals.rdr`. The synthetic scripts below are
 * `parseRdr`'s shape (a key string, then the list of its values), spelled the way the game's files spell them.
 */

/** A `key (value)` pair list the way `parseRdr` hands a record back. */
const rec = (...pairs: [string, RdrNode][]): RdrNode[] => pairs.flatMap(([k, v]) => [k, Array.isArray(v) ? v : [v]]);

const stance = rec(['ReticuleKnock', '12'], ['ReticuleKnockReturn', '70'], ['ReticuleKnockMax', '45'], ['TargetMin', '1']);
const m4 = rec(
  ['InternalName', 'M4A1'], ['DisplayName', 'M4A1'],
  ['Reticule_Modifiers', rec(['STANCE_STAND', stance], ['STANCE_CROUCH', stance])],
  ['FireWait', '0.12'], ['Maximum_Range', '1000'], ['ID', '54'], ['NumMags', '3'],
  ['AMMO_TYPES', [rec(['NAME', '5.56 x 45mm'])]], ['Ammo_Capacity', '30'], ['DecalSet', 'BULLET_MARK_SMALL'],
);
const m16 = rec(['InternalName', 'M16A2'], ['FireWait', '0.1'], ['ID', '51']);
const zweapon: RdrNode = [
  'WEAPON_GLOBAL', rec(['SoundDistanceClose', '0']),
  'ZAMMO', [rec(['InternalName', '9x19P'], ['ID', '1']), rec(['InternalName', '5.56 x 45mm'], ['ID', '8'])],
  'ZWEAPON', [m16, m4],
];

describe('the weapon record reader over a hand-built zweapon.rdr', () => {
  it('reads the M4A1: FireWait as the interval and the rate, the magazine, the mags, the ammo by name to its ID', () => {
    expect(weaponRecord(zweapon, 'M4A1')).toMatchObject<Partial<WeaponRecord>>({
      name: 'M4A1', id: 54, fireWait: 0.12, roundsPerMinute: 500, magazine: 30, mags: 3,
      ammo: '5.56 x 45mm', ammoId: 8, maximumRange: 1000, effectiveRange: 0, decalSet: 'BULLET_MARK_SMALL',
      knock: { knock: 12, knockReturn: 70, knockMax: 45 },
    });
  });

  it('reads the stances as the parser does: each starts as a copy of the one before, the constructor defaults under all', () => {
    const r = weaponRecord(zweapon, 'M4A1');
    // STANCE_STAND sets four keys; the rest are FUN_003c59c0's: 0, Mult 1, KnockCount 3, KnockEntryStrength 1.
    expect(r.stances.stand).toMatchObject({ knock: 12, knockReturn: 70, knockMax: 45, targetMin: 1, targetMax: 0,
      dilateMoveMult: 1, knockCount: 3, knockEntry: 1, kickRate: 0 });
    // STANCE_CROUCH is the same node here; STANCE_PRONE is absent, so it is the crouch copied.
    expect(r.stances.crouch).toEqual(r.stances.stand);
    expect(r.stances.prone).toEqual(r.stances.crouch);
    const prone = rec(['ReticuleKnock', '8'], ['TargetDilateUponMovementMult', '63']);
    const script: RdrNode = ['ZAMMO', [rec(['InternalName', 'r'], ['ID', '1']), rec(['InternalName', 's'], ['ID', '2'])], 'ZWEAPON', [rec(
      ['InternalName', 'G'], ['FireWait', '0.1'], ['ID', '1'], ['NumMags', '1'], ['Ammo_Capacity', '1'], ['Maximum_Range', '1'],
      ['DecalSet', 'X'], ['AMMO_TYPES', [rec(['NAME', 'r'])]],
      ['Reticule_Modifiers', rec(['STANCE_STAND', stance], ['STANCE_PRONE', prone])]), m16]];
    const g = weaponRecord(script, 'G');
    expect(g.stances.prone).toMatchObject({ knock: 8, dilateMoveMult: 63, knockReturn: 70, targetMin: 1 });
  });

  it('reads the zoom table, the burst accuracy, and the fire modes MaxFireMode and the mode keys enable', () => {
    const r = weaponRecord(zweapon, 'M4A1');
    expect(r.zoomModes).toEqual([]);
    expect(r.maxFireMode).toBe(0);
    expect(r.fireModes).toEqual([]);
    const script: RdrNode = ['ZAMMO', [rec(['InternalName', 'r'], ['ID', '1']), rec(['InternalName', 's'], ['ID', '2'])], 'ZWEAPON', [rec(
      ['InternalName', 'G'], ['FireWait', '0.1'], ['ID', '1'], ['NumMags', '1'], ['Ammo_Capacity', '1'], ['Maximum_Range', '1'],
      ['DecalSet', 'X'], ['AMMO_TYPES', [rec(['NAME', 'r'])]], ['Reticule_Modifiers', rec(['STANCE_STAND', stance])],
      ['NumZoomModes', '3'], ['ZoomMode0', '1.5'], ['ZoomMode2', '12'], ['AccBurstCnt_Min', '4'], ['AccScalar_Max', '0.03'],
      ['SingleMode', []], ['AutoMode', []]), m16]];
    const g = weaponRecord(script, 'G');
    expect(g.zoomModes).toEqual([1.5, -1, 12]);      // a missing ZoomMode%d is the parser's -1
    expect(g.accuracyBurst).toEqual({ countMin: 4, countMax: 0, scalarMin: 0, scalarMax: 0.03 });
    expect(g.maxFireMode).toBe(3);                    // no MaxFireMode: 0, raised to 3 by AutoMode
    expect(g.fireModes).toEqual([1, 3]);              // the M14's pattern: single and automatic, no burst
  });

  it('refuses a weapon the table does not hold, and a record without a key, naming them', () => {
    expect(() => weaponRecord(zweapon, 'AK-47')).toThrow('AK-47');
    expect(() => weaponRecord(zweapon, 'M16A2')).toThrow(/M16A2 has no \w+/);
  });

  it('reads the default primary: the first wep_name of the first record of that name under characters', () => {
    const character: RdrNode = ['characters', [
      // The inheritance line comes first in the game's file: `mp_seal1 : mp_seal (sounds ...)`.
      'mp_seal1', ':', 'mp_seal', rec(['sounds', rec(['CHRSND_DEATH', 'x'])]),
      'basic_seal', rec(['default_weapons', [rec(['wep_name', 'M4A1-M203'])]]),
      'mp_seal1', rec(['texture_asset', 'artcseal'], ['default_weapons', [rec(['wep_name', 'M4A1']), rec(['wep_name', 'Mark 23'])]]),
      'mp_seal1', rec(['default_weapons', [rec(['wep_name', 'HK5'])]]),
    ]];
    expect(defaultPrimary(character)).toBe('M4A1');
    expect(kitPrimaries(character)).toEqual(['M4A1', 'HK5']);
    expect(() => defaultPrimary(character, 'mp_seal9')).toThrow('mp_seal9');
  });

  it('reads a decal set\'s entry for one material out of decals.rdr', () => {
    const decals: RdrNode = ['TEMP_DECAL_POOL_SIZE', ['198'], 'DECAL_SETS', [
      [rec(['SETNAME', 'GRENADE_BLAST']), rec(['MATERIALNAME', 'STONE'], ['TEXTURENAME', 'grenade_mark.tif'])],
      [rec(['SETNAME', 'BULLET_MARK_SMALL']),
        rec(['MATERIALNAME', 'SAND'], ['TEXTURENAME', 'bullet_mark_sand.tif'], ['MIN_SIZE', '1'], ['MAX_SIZE', '1.5']),
        rec(['MATERIALNAME', 'STONE'], ['TEXTURENAME', 'bullet_mark_stone.tif'], ['MIN_SIZE', '1'], ['MAX_SIZE', '1.8'])],
    ]];
    expect(decalEntry(decals, 'BULLET_MARK_SMALL', 'STONE')).toEqual<DecalEntry>(
      { set: 'BULLET_MARK_SMALL', material: 'STONE', texture: 'bullet_mark_stone.tif', minSize: 1, maxSize: 1.8 });
    expect(() => decalEntry(decals, 'BULLET_MARK_SMALL', 'GLASS')).toThrow('GLASS');
    expect(() => decalEntry(decals, 'BULLET_MARK_LARGE', 'STONE')).toThrow('BULLET_MARK_LARGE');
  });
});

// The game's own files: the served copies first (`tools/extract-maps.ts` puts them beside the maps, W2.R5), then the
// disc tree (`SOCOM_DISC`, the repository's `game/disc`, this host's main tree).
const web = resolve(import.meta.dirname, '../../..');
const onDisc = (name: string): string | undefined => [
  resolve(web, `public/maps/RUN/${name}`),
  ...(process.env.SOCOM_DISC ? [resolve(process.env.SOCOM_DISC, `RUN/${name}`)] : []),
  resolve(web, `../game/disc/RUN/${name}`),
  `C:/projects/socom_pc/game/disc/RUN/${name}`,
].find((p) => existsSync(p));
const ZWEAPON = onDisc('ZWEAPON.ZAR'), READERC = onDisc('READERC.ZAR');
const bytes = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

describe.skipIf(!ZWEAPON || !READERC)('the default rifle off the game\'s ZWEAPON.ZAR and READERC.ZAR', () => {
  it('ZWEAPON.ZAR holds one script, zweapon.rdr', () => {
    expect(Zar.parse(bytes(ZWEAPON!)).root.children.map((k) => k.name)).toEqual(['zweapon.rdr']);
  });

  it('the multiplayer SEAL\'s first kit (character.rdr mp_seal1) is the M4A1: 0.12 s a round, 30 a magazine, 3 magazines', () => {
    const rifle = readDefaultRifle(bytes(ZWEAPON!), bytes(READERC!));
    expect(rifle.name).toBe('M4A1');
    expect(rifle.fireWait).toBe(0.12);
    expect(rifle.roundsPerMinute).toBe(500);
    expect(rifle.magazine).toBe(30);
    expect(rifle.mags).toBe(3);
    expect(rifle.ammo).toBe('5.56 x 45mm');
    expect(rifle.ammoId).toBe(8);
    expect(rifle.id).toBe(54);
    // Every theatre's mp_seal1 (arctic, scuba, jungle, desert ...) hands the same rifle first.
    const zar = Zar.parse(bytes(READERC!));
    const character = parseRdr(zar.data(zar.root.children.find((k) => k.name === 'character.rdr')!));
    const kits = kitPrimaries(character);
    expect(kits.length).toBeGreaterThanOrEqual(4);
    expect(new Set(kits)).toEqual(new Set(['M4A1']));
  });

  it('is the transcription: DEFAULT_RIFLE, M4A1_SD and BULLET_MARK are the files\', proven each run that has them', () => {
    expect(readDefaultRifle(bytes(ZWEAPON!), bytes(READERC!))).toEqual(DEFAULT_RIFLE);
    expect(readWeapon(bytes(ZWEAPON!), 'M4A1 SD')).toEqual(M4A1_SD);
    expect(readBulletMark(bytes(READERC!), DEFAULT_RIFLE.decalSet)).toEqual(BULLET_MARK);
  });

  it('the M16A2 beside it reads its own numbers (the reader is not the transcription)', () => {
    const script = parseRdr(Zar.parse(bytes(ZWEAPON!)).data(Zar.parse(bytes(ZWEAPON!)).root.children[0]!));
    expect(weaponRecord(script, 'M16A2')).toMatchObject({ fireWait: 0.1, magazine: 30, mags: 4, ammoId: 8, id: 51 });
  });

  it('the M4A1 SD zooms to 3; every weapon has ZoomMode0 1.5; the ranges are metres, 10 units each', () => {
    const sd = readWeapon(bytes(ZWEAPON!), 'M4A1 SD');
    expect(sd.zoomModes).toEqual([1.5, 3]);
    expect(sd.stances.crouch.targetMin).toBe(0.75);
    expect(sd.maximumRange * UNITS_PER_METRE).toBe(8000);   // DAT_003dfe10: 10 units a metre
    const zar = Zar.parse(bytes(ZWEAPON!));
    const script = parseRdr(zar.data(zar.root.children[0]!)) as RdrNode[];
    const list = script[script.indexOf('ZWEAPON') + 1] as RdrNode[][];
    for (const r of list) {
      const name = (r[r.indexOf('InternalName') + 1] as string[])[0]!;
      expect(rdrGet(r, 'ZoomMode0'), name).toBe('1.5');
    }
  });
});
