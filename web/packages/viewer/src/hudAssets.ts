import { Zar, zdbMember, type ZdbEntry } from '@s2u/archive';
import { PaletteTable, type Rgba } from '@s2u/gs';
import { decodeNamedTextures } from './hudBitmaps';

/**
 * The in-game HUD's bitmaps (web/docs/research/87-hud.md): four texture libraries every `MP*.ZDB` carries under
 * `RUN\COMMON\`, each decoded against its **own** `_PAL` (research 72's caveat; `./hudBitmaps` for the reticle's
 * pair) -- `HUD_TXR` (37: the context-action icons and the pad's button faces), `HUD2_TXR` (72: the ammo box's
 * panel, the compass, the team list's pieces, the reticles), `HUDW_TXR` (65: the weapon icons and the fire-mode
 * round) and `FONT_TXR` (the HUD's font, `font_text_01.tif`, PSMT4 -- `@s2u/gs` reads it since this note).
 *
 * **The HUD's bitmaps are stored bottom row first.** Decoded as the world's are (row 0 of the decode is row 0 of
 * the stored texels), every one of them comes out upside down against the console frame: the M4's icon with its
 * magazine up, the compass's `N` mirrored, the font's `A` row at the bottom where `fonts.rdr`'s `UL (2 0)` puts it at
 * the top (measured 2026-09-28, research 87 §2). The reader flips them once here, so every consumer indexes them
 * top row first -- as `fonts.rdr`'s glyph rectangles and the frame's pixels do.
 */

/** Which bitmaps the HUD reads out of which library. The action icons are research 87 §5's list. */
export const HUD_LIBRARIES = {
  HUD: [
    'action_climb.tif', 'action_slide.tif', 'action_door_open.tif', 'action_door_close.tif',
    'action_pickup_item.tif', 'action_pickup_item1.tif', 'action_pickup_item2.tif', 'action_mp_bomb.tif',
    'action_drop_mp_bomb.tif', 'action_defuse.tif', 'action_place_c4.tif', 'action_button.tif',
    'action_pull_lever.tif', 'action_mount_turret.tif', 'action_dismount_turret.tif', 'action_x.tif',
  ],
  HUD2: [
    'newweapnbkrnd.tif', 'compass_lo.tif', 'compass_bkrnd.tif', 'team_background.tif', 'teammate_health.tif',
  ],
  HUDW: ['m4carbine_icon.tif', 'firemode.tif'],
  FONT: ['font_text_01.tif'],
} as const;

export type HudBitmaps = Record<string, Rgba>;

/** A bitmap turned top row first (research 87 §2): the rows reversed, nothing else touched. */
export function flipRows(rgba: Rgba): Rgba {
  const { width, height } = rgba;
  const row = width * 4, out = new Uint8ClampedArray(rgba.data.length);
  for (let y = 0; y < height; y++) out.set(rgba.data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
  return { width, height, data: out };
}

/**
 * The HUD's bitmaps out of a map archive, keyed by their lower-case file name, top row first. A library that will
 * not read costs its bitmaps and a diagnostic line, never the map; the HUD draws what it has.
 */
export function readHud(bytes: Uint8Array, toc: ZdbEntry[]): { bitmaps: HudBitmaps; diagnostics: string[] } {
  const bitmaps: HudBitmaps = {};
  const diagnostics: string[] = [];
  for (const [lib, names] of Object.entries(HUD_LIBRARIES)) {
    let txr: Zar, pal: Zar;
    try {
      txr = Zar.parse(zdbMember(bytes, toc, `${lib}_TXR.ZED`));
      pal = Zar.parse(zdbMember(bytes, toc, `${lib}_PAL.ZED`));
    } catch (e) {
      diagnostics.push(`hud: ${lib}_TXR/${lib}_PAL.ZED: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const keys = txr.find('textures')?.children ?? [];
    const texdat = (name: string): Uint8Array | null => {
      const key = keys.find((k) => k.name.toLowerCase() === name);
      const child = key ? txr.child(key, 'texdat') : undefined;
      return key && child ? txr.data(child) : null;
    };
    const decoded = decodeNamedTextures(texdat, PaletteTable.fromZars([pal]), names);
    for (const d of decoded.diagnostics) diagnostics.push(`hud: ${d}`);
    for (const [name, rgba] of Object.entries(decoded.textures)) bitmaps[name] = flipRows(rgba);
  }
  return { bitmaps, diagnostics };
}
