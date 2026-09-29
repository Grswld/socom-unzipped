import { Zar, zdbMember, type ZdbEntry } from '@s2u/archive';
import { decodeTexture, PaletteTable, parseTextureRecord, type Rgba } from '@s2u/gs';

/**
 * The HUD's bitmaps (web sprint 2, W2.4): `RUN\COMMON\HUD2_TXR.ZED` rides in every `MP*.ZDB` (72 textures, the
 * reticles among them) with its palettes in `HUD2_PAL.ZED` beside it. They decode through the same
 * `parseTextureRecord` -> `decodeTexture` path as the world's (`./loadMap`), against a `PaletteTable` built from
 * **HUD2_PAL alone**: a library's textures cite the ids of its own `_PAL` (web/docs/research/72's caveat on
 * `CLIB_TXR`/`CLIB_PAL`; the HUD pair has the same shape -- `ret_rifle_01.tif`'s TEX0.CBP is 188, an id of
 * HUD2_PAL's 39), so the map's palettes are not mixed in.
 *
 * Decoded in the worker as part of the map load rather than by a request of its own: the archive's bytes are
 * already there, the three bitmaps are 6,400 texels together, and a map whose HUD pair will not read costs one
 * diagnostic and no reticle, never the map.
 */

/**
 * The rifle reticle as reCOM's `BitmapReticule` holds it (`research/recom/src/Apps/FTS/hud/hud.h:465-520`:
 * `m_reticuleTex[10]`, `m_floatingreticuleTex[10]`, `m_accuracyxtex` = `ret_accuracy.tif`). Which file is which
 * part is read off their shapes (decoded 2026-09-28): `_01` (64x64) is a dark translucent ring, radius 21-27,
 * with a 2x2 white dot at its centre -- the fixed part; `_02` (32x32) is one tapered arm, white at its outer
 * end -- the floating part, drawn four times.
 */
export const RETICLE_TEXTURES = {
  fixed: 'ret_rifle_01.tif', floating: 'ret_rifle_02.tif', accuracy: 'ret_accuracy.tif',
} as const;

/**
 * Every reticle set's bitmaps (`BitmapReticule_Init` 0x2178c0 loads these 19 by name off `HUD2_TXR`; research 84 §8):
 * decoded with the rifle's so a weapon's set is a table look-up (`./reticle`'s `RETICLE_SETS`).
 */
export const RETICLE_SET_TEXTURES = [
  'ret_sidearm_01.tif', 'ret_sidearm_02.tif', 'ret_rifle_01.tif', 'ret_rifle_02.tif', 'ret_shotgun_01.tif',
  'ret_shotgun_02.tif', 'ret_rocket_01.tif', 'ret_rocket_02.tif', 'ret_grenade_01.tif', 'ret_grenade_02.tif',
  'ret_scope_01.tif', 'ret_scope_02.tif', 'ret_binocs.tif', 'ret_binocs2.tif', 'nvg_part.tif',
  'ret_laser_designator.tif', 'ret_threat.tif', 'ret_accuracy.tif', 'noise50.tif',
] as const;

export interface ReticleBitmaps {
  /** `ret_rifle_01.tif`, 64x64 on Frostfire's archive. */
  fixed: Rgba;
  /** `ret_rifle_02.tif`, 32x32: the arm pointing down, its core in texel column 30, rows 8-30. */
  floating: Rgba;
  /** `ret_accuracy.tif`, 16x16: decoded for the bloom to come; not in the console frame at rest, not drawn yet. */
  accuracy: Rgba | null;
  /** `RETICLE_SET_TEXTURES` by name, those the archive holds. */
  sets?: Record<string, Rgba>;
}

/**
 * Named textures out of one library: `texdat` hands back a key's `texdat` bytes (or null when the library has no
 * such key), `palettes` is that library's own table. Nothing throws: a missing or unreadable texture is a
 * diagnostic line and an absent entry.
 */
export function decodeNamedTextures(
  texdat: (name: string) => Uint8Array | null, palettes: PaletteTable, names: readonly string[],
): { textures: Record<string, Rgba>; diagnostics: string[] } {
  const textures: Record<string, Rgba> = {};
  const diagnostics: string[] = [];
  for (const name of names) {
    const bytes = texdat(name);
    if (!bytes) { diagnostics.push(`${name}: not in the library`); continue; }
    try {
      const decoded = decodeTexture(parseTextureRecord(name, bytes), palettes);
      for (const d of decoded.diagnostics) diagnostics.push(`${name}: ${d}`);
      textures[name] = decoded.rgba;
    } catch (e) {
      diagnostics.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { textures, diagnostics };
}

/**
 * One bitmap out of a map archive's `RUN\COMMON\EFFE_TXR.ZED` against its own `EFFE_PAL.ZED` (W2.5): the bullet mark
 * `READERC.ZAR/decals.rdr` names for the rifle's `DecalSet` (`bullet_mark_stone.tif`, 16x16; `@s2u/scene`'s
 * `BULLET_MARK`). The library holds 22 textures, the six `bullet_mark_*.tif` and `grenade_mark.tif` among them;
 * `ALPH_TXR.ZED` (20) holds none. Null with a diagnostic when absent: the shot then marks with a plain dark disc.
 */
export function readEffectBitmap(bytes: Uint8Array, toc: ZdbEntry[], name: string): { rgba: Rgba | null; diagnostics: string[] } {
  let txr: Zar, pal: Zar;
  try {
    txr = Zar.parse(zdbMember(bytes, toc, 'EFFE_TXR.ZED'));
    pal = Zar.parse(zdbMember(bytes, toc, 'EFFE_PAL.ZED'));
  } catch (e) {
    return { rgba: null, diagnostics: [`bullet mark: EFFE_TXR/EFFE_PAL.ZED: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const keys = txr.find('textures')?.children ?? [];
  const texdat = (wanted: string): Uint8Array | null => {
    const key = keys.find((k) => k.name.toLowerCase() === wanted);
    const child = key ? txr.child(key, 'texdat') : undefined;
    return key && child ? txr.data(child) : null;
  };
  const { textures, diagnostics } = decodeNamedTextures(texdat, PaletteTable.fromZars([pal]), [name]);
  return { rgba: textures[name] ?? null, diagnostics: diagnostics.map((d) => `bullet mark: ${d}`) };
}

/** The rifle reticle's three bitmaps out of a map archive's `HUD2_TXR.ZED` / `HUD2_PAL.ZED`; null bitmaps with a reason when absent. */
export function readReticle(bytes: Uint8Array, toc: ZdbEntry[]): { bitmaps: ReticleBitmaps | null; diagnostics: string[] } {
  let txr: Zar, pal: Zar;
  try {
    txr = Zar.parse(zdbMember(bytes, toc, 'HUD2_TXR.ZED'));
    pal = Zar.parse(zdbMember(bytes, toc, 'HUD2_PAL.ZED'));
  } catch (e) {
    return { bitmaps: null, diagnostics: [`reticle: HUD2_TXR/HUD2_PAL.ZED: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const keys = txr.find('textures')?.children ?? [];
  const texdat = (name: string): Uint8Array | null => {
    const key = keys.find((k) => k.name.toLowerCase() === name);
    const child = key ? txr.child(key, 'texdat') : undefined;
    return key && child ? txr.data(child) : null;
  };
  const { textures, diagnostics } = decodeNamedTextures(
    texdat, PaletteTable.fromZars([pal]), [...new Set<string>([...Object.values(RETICLE_TEXTURES), ...RETICLE_SET_TEXTURES])]);
  const fixed = textures[RETICLE_TEXTURES.fixed], floating = textures[RETICLE_TEXTURES.floating];
  const notes = diagnostics.map((d) => `reticle: ${d}`);
  if (!fixed || !floating) return { bitmaps: null, diagnostics: notes };
  const sets = Object.fromEntries(RETICLE_SET_TEXTURES.filter((n) => textures[n]).map((n) => [n, textures[n]!]));
  return { bitmaps: { fixed, floating, accuracy: textures[RETICLE_TEXTURES.accuracy] ?? null, sets }, diagnostics: notes };
}
