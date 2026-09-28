import { Zar, zdbMember, type ZdbEntry } from '@s2u/archive';
import { PaletteTable, type Rgba } from '@s2u/gs';
import { decodeNamedTextures } from './hudBitmaps';
import type { ClimbPrompt } from './traversal';

/**
 * The action icon the traversal offers (web research 86 section 3.4): `action_climb.tif` while a climb is offered and
 * `action_slide.tif` on a ladder (the action menu's "LADDER SLIDE"), both in `RUN\COMMON\HUD_TXR.ZED` with their
 * palettes in `HUD_PAL.ZED` (the texture set `0x45c3c0` `FUN_0021ded0` loads, decomp 73549, 73614-73621).
 *
 * **TEMPORARY, for the HUD workstream to replace**: the traversal's `climbPrompt()` is the seam; this overlay draws the
 * game's bitmap at the game's place -- the action panel centred at x 306 of 640, half-width 25, y 365 to 415 of 448
 * (`DAT_003dc628/630/640`, `DAT_0040c160`, decomp 327763) -- with its tint pulsing at rate 5 (`FUN_0021f120`, 73840;
 * the pulse's colours are not read: a brightness swing stands in for them).
 */

export const ACTION_ICONS = { climb: 'action_climb.tif', slide: 'action_slide.tif' } as const;
export interface ActionIcons { climb: Rgba | null; slide: Rgba | null }

/** The two icons out of a map archive's `HUD_TXR.ZED` / `HUD_PAL.ZED`; nulls with a reason when absent. */
export function readActionIcons(bytes: Uint8Array, toc: ZdbEntry[]): { icons: ActionIcons; diagnostics: string[] } {
  let txr: Zar, pal: Zar;
  try {
    txr = Zar.parse(zdbMember(bytes, toc, 'HUD_TXR.ZED'));
    pal = Zar.parse(zdbMember(bytes, toc, 'HUD_PAL.ZED'));
  } catch (e) {
    return { icons: { climb: null, slide: null }, diagnostics: [`action icons: HUD_TXR/HUD_PAL.ZED: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const keys = txr.find('textures')?.children ?? [];
  const texdat = (name: string): Uint8Array | null => {
    const key = keys.find((k) => k.name.toLowerCase() === name);
    const child = key ? txr.child(key, 'texdat') : undefined;
    return key && child ? txr.data(child) : null;
  };
  const { textures, diagnostics } = decodeNamedTextures(texdat, PaletteTable.fromZars([pal]), Object.values(ACTION_ICONS));
  return {
    icons: { climb: textures[ACTION_ICONS.climb] ?? null, slide: textures[ACTION_ICONS.slide] ?? null },
    diagnostics: diagnostics.map((d) => `action icons: ${d}`),
  };
}

/** The action panel on the console's 640 x 448 frame. */
export const ACTION_PANEL = { x: 306, halfWidth: 25, top: 365, bottom: 415, frameWidth: 640, frameHeight: 448 } as const;
/** `FUN_0021f120`'s pulse rate. */
const PULSE_RATE = 5;

/** What the overlay is asked to show: a climb (its prompt), the ladder's slide, or nothing. */
export type ActionShown = { icon: 'climb'; prompt: ClimbPrompt } | { icon: 'slide' } | null;

/** The overlay: one canvas over the frame, the icon drawn at the panel's place as the frame scales. */
export class ActionIconView {
  readonly element: HTMLCanvasElement;
  private icons: ActionIcons = { climb: null, slide: null };
  private shown: ActionShown = null;
  private time = 0;

  constructor(parent: HTMLElement) {
    const c = document.createElement('canvas');
    c.className = 'action-icon';
    c.width = 64; c.height = 64;
    Object.assign(c.style, { position: 'absolute', pointerEvents: 'none', display: 'none', imageRendering: 'pixelated', zIndex: '3' });
    parent.appendChild(c);
    this.element = c;
  }

  setIcons(icons: ActionIcons | null | undefined): void {
    this.icons = icons ?? { climb: null, slide: null };
    this.shown = null;
  }

  /** One frame: the icon for what is offered, placed over `frame` (the canvas the world is drawn in), pulsing. */
  frame(dt: number, shown: ActionShown, frame: { left: number; top: number; width: number; height: number }): void {
    this.time += dt;
    const rgba = shown ? this.icons[shown.icon] : null;
    const c = this.element;
    if (!shown) { c.style.display = 'none'; this.shown = null; return; }
    if (this.shown?.icon !== shown.icon) {
      this.shown = shown;
      const ctx = c.getContext('2d');
      if (ctx) {
        if (rgba) {
          c.width = rgba.width; c.height = rgba.height;
          ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height), 0, 0);
        } else {
          // No bitmap on this source: the action menu's own word, "CLIMB" / "LADDER SLIDE" (0x3e4e00, 0x3e4de8).
          c.width = 128; c.height = 32;
          ctx.clearRect(0, 0, 128, 32);
          ctx.fillStyle = '#e8e2c8';
          ctx.font = 'bold 14px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(shown.icon === 'climb' ? 'CLIMB' : 'LADDER SLIDE', 64, 20);
        }
      }
    }
    const sx = frame.width / ACTION_PANEL.frameWidth, sy = frame.height / ACTION_PANEL.frameHeight;
    const h = (ACTION_PANEL.bottom - ACTION_PANEL.top) * sy, w = rgba ? (h * c.width) / c.height : ACTION_PANEL.halfWidth * 4 * sx;
    Object.assign(c.style, {
      display: 'block', width: `${w}px`, height: `${h}px`,
      left: `${frame.left + ACTION_PANEL.x * sx - w / 2}px`, top: `${frame.top + ACTION_PANEL.top * sy}px`,
      opacity: String(0.7 + 0.3 * Math.sin(this.time * PULSE_RATE)),
    });
  }
}
