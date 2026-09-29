import {
  BufferAttribute, BufferGeometry, DataTexture, DoubleSide, LinearFilter, Mesh, OrthographicCamera, RGBAFormat, Scene,
  UnsignedByteType, Vector2,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { texture as textureNode, uv, vec4, vertexColor } from 'three/tsl';
import type { Rgba } from '@s2u/gs';
import { segmentHit, type Grid } from '@s2u/scene';
import type { HudBitmaps } from './hudAssets';
import { FONT_TEXT_01, layoutText, textWidth } from './hudFont';
import type { HudRenderer, Rect } from './reticle';

/**
 * The in-game HUD (web/docs/research/87-hud.md): SOCOM II's own multiplayer HUD drawn over the world in walk mode --
 * the ammo box (panel, "30/30", "2 MAGS", the weapon's icon, the fire-mode rounds), the compass ring turned by the
 * heading, the info box (the health bar, the round timer, the range), the stance word on a stance change, the
 * context-action icon (the climb icon among them) and the message banner -- out of the game's own bitmaps and font
 * (`./hudAssets`, `./hudFont`), at the places `CHUD`'s code puts them (research 87 §1: the constants read out of
 * the ELF) and the console frames show them (`scripts/parity/refs/console_spawn_slot8.png`; research 87 §2).
 *
 * **Frames and scale** are `./reticle`'s: the layout is in pixels of the PS2's 640x448 frame, y down, which is the
 * HUD's own space -- `CHUD` writes these numbers straight (the ammo box's `-10, 364, 170, 75`). The PS2 presentation
 * draws it one to one; the native one scales it by the canvas height / 448 and anchors each element to the side
 * the console keeps it on (the ammo box left, the compass and the info box right, the prompt and the banner on the
 * centre line), so a wide screen keeps the console's margins. The reticle is `./reticle`'s own pass, drawn before
 * this one; nothing here overlaps it.
 */

const PS2_W = 640, PS2_H = 448;

export type FireMode = 'single' | 'burst' | 'auto';
/**
 * The context prompts `CZActionBitmap` shows (research 87 §5), by the icon each flag selects in `FUN_0021f850`:
 * `climb` (flag `0x4`, `action_climb.tif`) is what the traversal's ledge prompt and a ladder's foot drive;
 * `ladder_slide` is flag `0x10000`'s `action_slide.tif`.
 */
export type ActionPrompt =
  | 'climb' | 'ladder_slide' | 'pickup' | 'bomb' | 'bomb_drop' | 'c4' | 'button' | 'lever' | 'turret_mount'
  | 'turret_dismount' | 'knife' | 'restrain' | 'action';
/** The traversal workstream's getter (`climbPrompt()`): a ledge in reach, and how high. The icon is the same for all three. */
export interface ClimbPrompt { visible: boolean; kind: 'low' | 'med' | 'high' }
export type HudStance = 'stand' | 'crouch' | 'prone';

/** Each prompt's bitmap in `HUD_TXR.ZED` (research 87 §5). `action_x.tif` is also the game's fallback icon. */
export const ACTION_ICONS: Record<ActionPrompt, string> = {
  climb: 'action_climb.tif', ladder_slide: 'action_slide.tif', pickup: 'action_pickup_item.tif',
  bomb: 'action_mp_bomb.tif', bomb_drop: 'action_drop_mp_bomb.tif', c4: 'action_place_c4.tif',
  button: 'action_button.tif', lever: 'action_pull_lever.tif', turret_mount: 'action_mount_turret.tif',
  turret_dismount: 'action_dismount_turret.tif', knife: 'action_knife.tif', restrain: 'action_restrain.tif',
  action: 'action_x.tif',
};

/**
 * How many `firemode.tif` rounds each mode shows (`FUN_00237b40`): the weapon's fire-mode value 1 shows one, 2
 * three, 3 four. The console frame at spawn shows three: the M4A1 at its mode 2.
 */
export const FIRE_MODE_ROUNDS: Record<FireMode, number> = { single: 1, burst: 3, auto: 4 };

/** One HUD text line: its pen x (or the x it is right-aligned to / centred on), its baseline, its scale. */
interface TextSpot { x: number; y: number; scale: number; align?: 'left' | 'right' | 'centre' }

/**
 * The layout in the frame's pixels (research 87 §1; every number's source is its table): `CHUD`'s constants where the
 * ELF holds them, the console frames' measurements where it does not (marked "measured").
 */
export const HUD_LAYOUT = {
  ammo: {
    /** `newweapnbkrnd.tif` stretched over `DAT_003dcb90..a8`: x -10..160, y 364..439. */
    panel: { x: -10, y: 364, w: 170, h: 75 },
    /** The weapon's HUDW icon, top-left (20, 389), its own size (`FUN_00237fc0`). */
    icon: { x: 20, y: 389 },
    /** `"%d/%d"`: scale 0.9, pen x 15, baseline 382. */
    rounds: { x: 15, y: 382, scale: 0.9 } as TextSpot,
    /** `"%d MAG%c"`: scale 0.9, pen x 95, baseline 382. */
    mags: { x: 95, y: 382, scale: 0.9 } as TextSpot,
    /** `firemode.tif` at x = 15 + 36i, y 422, its own 32x16; the first moved to x 10 (`FUN_00237b40`). */
    rounds4: { xs: [10, 51, 87, 123], y: 422 },
  },
  /** `compass_lo.tif` at 0.75 (96x96) centred on `DAT_003dc508/50c` (565, 90); alpha 100 (`FUN_002126f0`). */
  compass: { cx: 565, cy: 90, size: 96, alpha: 100 / 128 },
  /** The MP info box (`FUN_002388a0`): the health bar at (488, 396) 134x18; the timer and range lines. */
  info: {
    bar: { x: 488, y: 396, w: 134, h: 18 },
    /** The name on the bar: centred on it, measured on the Vigilance frames (ink x 535-575, y 402-411). */
    name: { x: 555, y: 411, scale: 0.9, align: 'centre' } as TextSpot,
    /** The box under the timer line: measured x 488-622, y 418-438, `newweapnbkrnd.tif` mirrored. */
    box: { x: 488, y: 418, w: 134, h: 20 },
    /** `"%02d:%02d"` at (500, 433), scale 0.9. */
    timer: { x: 500, y: 433, scale: 0.9 } as TextSpot,
    /** `"%dm"` at (587, 433), scale 0.9. */
    range: { x: 587, y: 433, scale: 0.9 } as TextSpot,
  },
  /** `PoseBitmap`'s word, multiplayer place: right-aligned to x 480, baseline 431, scale 0.765 (`FUN_00222010`). */
  stance: { x: 480, y: 431, scale: 0.765, align: 'right' } as TextSpot,
  /** `CZActionBitmap`: 50x50 centred on x 306, y 365..415 (`DAT_003dc628/630/640`). */
  action: { cx: 306, y: 365, size: 50 },
  /**
   * The event banner ("STARTING ROUND 1 OF 11"): measured on the Vigilance frames -- the panel x 147-492, y 0-99, the
   * line centred on x 320 with its ink at y 81-93.
   */
  message: { panel: { x: 147, y: 0, w: 345, h: 99 }, text: { x: 320, y: 93, scale: 0.9, align: 'centre' } as TextSpot },
} as const;

/** RGBA 0..1. A textured draw is the GS's MODULATE, the vertex colour's 128 being 1; an untextured one is the colour as is. */
type Rgba4 = [number, number, number, number];
export const HUD_COLOURS = {
  /** `DAT_00408e40..4c`: 128, 128, 128 and alpha 80 -- every HUD string (and `min(80, 0.75 x 128)` for the shadow). */
  text: [1, 1, 1, 80 / 128] as Rgba4,
  shadow: [0, 0, 0, 80 / 128] as Rgba4,
  /** The panels' alpha 76.8 (0.6 of 128). */
  panel: [1, 1, 1, 0.6] as Rgba4,
  icon: [1, 1, 1, 1] as Rgba4,
  /** `CHealthBar`'s fill (0, 128, 64), untextured, at the HUD's alpha 80. */
  health: [0, 128 / 255, 64 / 255, 80 / 128] as Rgba4,
  /** The missing part of the bar (128, 64, 64). */
  healthLost: [128 / 255, 64 / 255, 64 / 255, 80 / 128] as Rgba4,
};

/**
 * `CZActionBitmap`'s colour table (`FUN_0021f120`): base + pulse x delta, the GS's 128 as 1. Entry 2 (blue) is the
 * allowed action's; entry 3 (grey) an action that is not allowed.
 */
export const ACTION_COLOURS = {
  red: { base: [120, 0, 0], delta: [80, 24, 24] },
  green: { base: [24, 80, 24], delta: [24, 80, 24] },
  blue: { base: [20, 50, 60], delta: [35, 80, 80] },
  grey: { base: [42, 42, 42], delta: [8, 8, 8] },
} as const;
/** The pulse ramps 0 to 1 and back at 5 a second (`DAT_0040d750`). */
export const ACTION_PULSE_RATE = 5;
/** The HUD fades in on a spawn (`DAT_003dc380`): hidden for 1 s, then up over 0.5 s. */
export const SPAWN_FADE = { hold: 1, ramp: 0.5 } as const;
/** The stance word: alpha 127 on a change, down 64 a second (`FUN_00221d90`). */
export const STANCE_FADE = { start: 127 / 128, perSecond: 64 / 128 } as const;
/** The words `PoseBitmap` writes. */
export const STANCE_WORDS: Record<HudStance, string> = { stand: 'STAND', crouch: 'CROUCH', prone: 'PRONE' };
/** A plain white texel: the bitmap the untextured draws (the health bar) modulate. */
export const WHITE = 'white';

export type HudElement =
  | 'panel' | 'rounds' | 'mags' | 'icon' | 'firemode' | 'compass' | 'bar' | 'name' | 'box' | 'timer' | 'range'
  | 'stance' | 'action' | 'banner' | 'message';

/** One textured quad in frame pixels (y down): its centre, size, turn (radians, clockwise), texels, colour. */
export interface HudQuad {
  element: HudElement;
  texture: string;
  x: number; y: number; w: number; h: number; turn: number;
  u0: number; v0: number; u1: number; v1: number;
  rgba: Rgba4;
}

/** Everything the HUD shows; the page writes it through `Hud`'s setters. */
export interface HudModel {
  rounds: number; capacity: number; spare: number; reloading: boolean;
  fireMode: FireMode;
  /** The weapon's HUDW icon, e.g. `m4carbine_icon.tif`. */
  weaponIcon: string;
  /** The camera's heading in degrees (`fly.pose().yaw`): the ring turns by it, clockwise (research 87 §1.2). */
  yaw: number;
  action: ActionPrompt | null;
  /** The action's colour: `blue` when it can be done, `grey` when not. */
  actionColour: keyof typeof ACTION_COLOURS;
  stance: HudStance;
  /** The player's name on the health bar; the viewer's SEAL has none. */
  name: string;
  /** Health, 0..1: the bar's green share. */
  health: number;
  /** The round timer, seconds; static in the viewer (a round's six minutes). */
  timer: number;
  /** The range readout, metres, or null for none (nothing under the reticle within the weapon's range). */
  range: number | null;
  message: string | null;
  zoom: number;
}

export const DEFAULT_MODEL: HudModel = {
  rounds: 30, capacity: 30, spare: 2, reloading: false, fireMode: 'burst', weaponIcon: 'm4carbine_icon.tif',
  yaw: 0, action: null, actionColour: 'blue', stance: 'stand', name: '', health: 1, timer: 6 * 60, range: null,
  message: null, zoom: 1,
};

/** The HUD's time-varying alphas, 0..1: the spawn fade, the stance word, the action pulse. */
export interface HudTiming { fade: number; stance: number; pulse: number }
export const AT_REST: HudTiming = { fade: 1, stance: 0, pulse: 0 };

/** The ammo box's lines as `CHUD` formats them: `"%d/%d"` and `"%d MAG%c"` ('S' unless one), none with no spare. */
export function ammoLines(m: Pick<HudModel, 'rounds' | 'capacity' | 'spare'>): { rounds: string; mags: string | null } {
  return { rounds: `${m.rounds}/${m.capacity}`, mags: m.spare > 0 ? `${m.spare} MAG${m.spare === 1 ? '' : 'S'}` : null };
}

/** `"%02d:%02d"`. */
export function timerText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The HUD's quads on a frame of `frame` pixels: pure, for the tests and the pass. `sizes` gives each bitmap's texel
 * size; a bitmap missing from it is not drawn. `rects` is each element's bounding box on the frame.
 */
export function hudLayout(
  frame: { width: number; height: number }, model: HudModel, sizes: Record<string, { width: number; height: number }>,
  timing: HudTiming = AT_REST,
): { scale: number; quads: HudQuad[]; rects: Partial<Record<HudElement, Rect>> } {
  const s = frame.height / PS2_H;
  const quads: HudQuad[] = [];
  // Anchors: the left edge, the right edge, the centre line.
  const L = (x: number): number => x * s;
  const R = (x: number): number => frame.width - (PS2_W - x) * s;
  const C = (x: number): number => frame.width / 2 + (x - PS2_W / 2) * s;
  const Y = (y: number): number => y * s;
  const alpha = (rgba: Rgba4, a: number): Rgba4 => [rgba[0], rgba[1], rgba[2], rgba[3] * a];
  const bitmap = (
    element: HudElement, texture: string, x: number, y: number, w: number, h: number, rgba: Rgba4,
    turn = 0, src?: [number, number, number, number],
  ): void => {
    const size = sizes[texture];
    if (!size || rgba[3] <= 0) return;
    const [u0, v0, u1, v1] = src ?? [0, 0, size.width, size.height];
    quads.push({ element, texture, x: x + w / 2, y: y + h / 2, w, h, turn, u0, v0, u1, v1, rgba });
  };
  const text = (element: HudElement, line: string, spot: TextSpot, anchor: (x: number) => number, a = 1): void => {
    const font = FONT_TEXT_01.texture;
    if (!sizes[font] || a <= 0) return;
    const width = textWidth(line, spot.scale);
    const pen = spot.align === 'right' ? spot.x - width : spot.align === 'centre' ? spot.x - width / 2 : spot.x;
    const { glyphs } = layoutText(line, pen, spot.y, spot.scale);
    const [dx, dy] = FONT_TEXT_01.dropShadow.pixels;
    for (const pass of ['shadow', 'text'] as const) {
      const [ox, oy] = pass === 'shadow' ? [dx * spot.scale, dy * spot.scale] : [0, 0];
      for (const g of glyphs) {
        bitmap(element, font, anchor(g.x + ox), Y(g.y + oy), g.w * s, g.h * s, alpha(HUD_COLOURS[pass], a),
          0, [g.u0, g.v0, g.u1, g.v1]);
      }
    }
  };

  // The ammo box, faded in on a spawn.
  const A = HUD_LAYOUT.ammo, fade = timing.fade;
  bitmap('panel', 'newweapnbkrnd.tif', L(A.panel.x), Y(A.panel.y), A.panel.w * s, A.panel.h * s, alpha(HUD_COLOURS.panel, fade));
  const icon = sizes[model.weaponIcon];
  if (icon) bitmap('icon', model.weaponIcon, L(A.icon.x), Y(A.icon.y), icon.width * s, icon.height * s, alpha(HUD_COLOURS.icon, fade));
  const fm = sizes['firemode.tif'];
  if (fm) {
    for (const x of A.rounds4.xs.slice(0, FIRE_MODE_ROUNDS[model.fireMode])) {
      bitmap('firemode', 'firemode.tif', L(x), Y(A.rounds4.y), fm.width * s, fm.height * s, alpha(HUD_COLOURS.icon, fade));
    }
  }
  const lines = ammoLines(model);
  text('rounds', lines.rounds, A.rounds, L, fade);
  if (lines.mags) text('mags', lines.mags, A.mags, L, fade);

  // The compass: the ring turned by the heading (`FUN_00211510` -> `FUN_00358730`).
  const K = HUD_LAYOUT.compass;
  bitmap('compass', 'compass_lo.tif', R(K.cx - K.size / 2), Y(K.cy - K.size / 2), K.size * s, K.size * s,
    [1, 1, 1, K.alpha], (model.yaw * Math.PI) / 180);

  // The info box: the health bar and the name on it, the timer line's box, the timer, the range.
  const I = HUD_LAYOUT.info;
  const health = Math.min(1, Math.max(0, model.health));
  if (health > 0) bitmap('bar', WHITE, R(I.bar.x), Y(I.bar.y), I.bar.w * health * s, I.bar.h * s, HUD_COLOURS.health);
  if (health < 1) {
    bitmap('bar', WHITE, R(I.bar.x + I.bar.w * health), Y(I.bar.y), I.bar.w * (1 - health) * s, I.bar.h * s, HUD_COLOURS.healthLost);
  }
  if (model.name) text('name', model.name, I.name, R);
  const panel = sizes['newweapnbkrnd.tif'];
  if (panel) {
    bitmap('box', 'newweapnbkrnd.tif', R(I.box.x), Y(I.box.y), I.box.w * s, I.box.h * s, HUD_COLOURS.panel, 0,
      [panel.width, 0, 0, panel.height]);
  }
  text('timer', timerText(model.timer), I.timer, R);
  if (model.range !== null) text('range', `${Math.round(model.range)}m`, I.range, R);

  // The stance word, fading after a change.
  if (timing.stance > 0) text('stance', STANCE_WORDS[model.stance], HUD_LAYOUT.stance, R, timing.stance / HUD_COLOURS.text[3]);

  // The context prompt, pulsing.
  if (model.action) {
    const P = HUD_LAYOUT.action, c = ACTION_COLOURS[model.actionColour];
    const rgb = c.base.map((b, i) => (b + timing.pulse * c.delta[i]!) / 128) as [number, number, number];
    const name = sizes[ACTION_ICONS[model.action]] ? ACTION_ICONS[model.action] : ACTION_ICONS.action;
    bitmap('action', name, C(P.cx - P.size / 2), Y(P.y), P.size * s, P.size * s, [...rgb, 1]);
  }

  // The event banner.
  if (model.message) {
    const M = HUD_LAYOUT.message;
    bitmap('banner', 'newweapnbkrnd.tif', C(M.panel.x), Y(M.panel.y), M.panel.w * s, M.panel.h * s, HUD_COLOURS.panel);
    text('message', model.message, M.text, C);
  }

  const rects: Partial<Record<HudElement, Rect>> = {};
  for (const q of quads) {
    const c = Math.abs(Math.cos(q.turn)), n = Math.abs(Math.sin(q.turn));
    const hw = (q.w * c + q.h * n) / 2, hh = (q.w * n + q.h * c) / 2;
    const r = rects[q.element];
    const x0 = q.x - hw, y0 = q.y - hh, x1 = q.x + hw, y1 = q.y + hh;
    if (!r) rects[q.element] = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    else {
      const nx0 = Math.min(r.x, x0), ny0 = Math.min(r.y, y0);
      rects[q.element] = { x: nx0, y: ny0, width: Math.max(r.x + r.width, x1) - nx0, height: Math.max(r.y + r.height, y1) - ny0 };
    }
  }
  return { scale: s, quads, rects };
}

/** What `Hud.feed` reads each frame. */
export interface HudSources {
  magazine: { rounds: number; capacity: number; spare: number; reloading: boolean };
  yaw: number;
  stance?: HudStance;
  climb?: ClimbPrompt | null;
  range?: number | null;
}

/** The test hook's patch: any of the inputs the walk does not drive yet. */
export interface HudPatch {
  fireMode?: FireMode; weaponIcon?: string; action?: ActionPrompt | null; climb?: ClimbPrompt | null;
  message?: string | null; zoom?: number; name?: string; health?: number; timer?: number; range?: number | null;
  stance?: HudStance; yaw?: number; rounds?: number; capacity?: number; spare?: number;
  /** Skip the spawn fade (the tests' still frames). */
  settled?: boolean;
  /** Hold the model as patched: `feed` is ignored until a patch with `frozen: false` (the tests' still frames). */
  frozen?: boolean;
}

/** `Hud.state()`: drawn or not, the frame, what it shows, the fades, and each element's rectangle (y down). */
export interface HudView {
  visible: boolean;
  frame: { width: number; height: number };
  model: HudModel;
  timing: HudTiming;
  rects: Partial<Record<HudElement, Rect>>;
}

/**
 * The info box's range (`"%dm"`): how far the surface under the reticle is, in metres (`MetersPerUnit` 0.1), along
 * the shot's own segment (`./fire`: the eye through the aim point, the rifle's 1000 units) -- the viewer's reading of
 * the readout [estimate: the game's own source for the number was not traced]. Measured at most five times a second:
 * the segment walks the hull's grid.
 */
export class RangeFinder {
  private at = -Infinity;
  private value: number | null = null;
  constructor(private readonly metersPerUnit = 0.1, private readonly every = 0.2, private readonly reach = 1000) {}
  measure(grid: Grid | null, aim: { eye: readonly number[]; far: readonly number[] } | null, now: number): number | null {
    if (now - this.at < this.every) return this.value;
    this.at = now;
    if (!grid || !aim) return (this.value = null);
    const d = [aim.far[0]! - aim.eye[0]!, aim.far[1]! - aim.eye[1]!, aim.far[2]! - aim.eye[2]!];
    const n = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    const from: [number, number, number] = [aim.eye[0]!, aim.eye[1]!, aim.eye[2]!];
    const end: [number, number, number] = [from[0] + (d[0]! / n) * this.reach, from[1] + (d[1]! / n) * this.reach, from[2] + (d[2]! / n) * this.reach];
    const hit = segmentHit(grid, from, end);
    return (this.value = hit ? hit.t * this.reach * this.metersPerUnit : null);
  }
}

/**
 * The GS samples a sprite's texture at each pixel's integer corner where GL samples at its centre (research 87 §2):
 * with the HUD's bilinear filter (every HUD bitmap's TEX1 asks for it) the console's content sits half a PS2 pixel
 * right of and below GL's for the same quad -- the +0.2..+0.8 pixel offsets the console frames show on every bitmap
 * before this correction. The pass moves each quad's texels by this much, in PS2 pixels, and leaves its edges.
 */
export const GS_SAMPLE_OFFSET = 0.5;

function makeTexture(rgba: Rgba): DataTexture {
  // `./hudAssets` hands the bitmaps over top row first; the HUD camera looks with y down, so they go up unflipped.
  const t = new DataTexture(rgba.data, rgba.width, rgba.height, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** One batch per bitmap: a dynamic quad list drawn in one call. */
interface Batch { mesh: Mesh; geometry: BufferGeometry; capacity: number; size: { width: number; height: number } }

/**
 * The HUD pass: an orthographic scene in frame pixels (y down) drawn after the world and the reticle with
 * `autoClear` off and no depth test. The page feeds it (`feed`, once a frame) and calls `render` after the reticle's.
 */
export class Hud {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, 1, 0, 1, -1, 1);
  private batches = new Map<string, Batch>();
  private textures: DataTexture[] = [];
  private materials: MeshBasicNodeMaterial[] = [];
  private model: HudModel = { ...DEFAULT_MODEL };
  private on = false;
  private frame = { width: 0, height: 0 };
  private readonly size = new Vector2();
  private order = 0;
  /** Seconds since the HUD came on (the spawn fade), since the last stance change, of the prompt's pulse. */
  private sinceOn = 0;
  private stanceAlpha = 0;
  private pulse = 0;
  private pulseUp = true;
  private messageLeft = 0;
  private frozen = false;
  private last = -1;

  /** The bitmaps of the map just loaded (`./hudAssets`), or none: the HUD then draws nothing. */
  setBitmaps(bitmaps: HudBitmaps | null | undefined): void {
    this.clear();
    if (!bitmaps) return;
    // The draw order: the panels, what sits on them, the compass, the prompt, the text last.
    const names = Object.keys(bitmaps);
    const order = [
      'newweapnbkrnd.tif', WHITE, ...names.filter((n) => n.endsWith('_icon.tif')), 'firemode.tif', 'compass_lo.tif',
      ...names.filter((n) => n.startsWith('action_')), FONT_TEXT_01.texture,
    ];
    const all: Record<string, Rgba> = { ...bitmaps, [WHITE]: { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) } };
    for (const name of [...new Set([...order, ...names])]) if (all[name]) this.addBatch(name, all[name]!);
  }

  /** Walking or not. Coming on starts the spawn fade (`SPAWN_FADE`). */
  setVisible(on: boolean): void {
    if (on && !this.on) this.sinceOn = 0;
    this.on = on;
  }
  setAmmo(rounds: number, capacity: number, spare: number, reloading = false): void {
    Object.assign(this.model, { rounds, capacity, spare, reloading });
  }
  setFireMode(mode: FireMode): void { this.model.fireMode = mode; }
  /** The weapon's HUDW icon by file name (`m4carbine_icon.tif` for the M4A1). */
  setWeaponIcon(icon: string): void { this.model.weaponIcon = icon.toLowerCase(); }
  /** The camera's heading, degrees (`fly.pose().yaw`). */
  setHeading(yaw: number): void { this.model.yaw = yaw; }
  /** A context prompt by kind, or none; `allowed` false greys it (`ACTION_COLOURS.grey`). */
  setAction(action: ActionPrompt | null, allowed = true): void {
    this.model.action = action;
    this.model.actionColour = allowed ? 'blue' : 'grey';
  }
  /** The traversal's ledge prompt: the game's climb icon while visible, unless another prompt holds the slot. */
  setClimbPrompt(state: ClimbPrompt | null): void {
    if (state?.visible === true) { if (!this.model.action) this.setAction('climb'); }
    else if (this.model.action === 'climb') this.model.action = null;
  }
  /** The stance: a change shows its word (`STANCE_FADE`). */
  setStance(stance: HudStance): void {
    if (stance !== this.model.stance) this.stanceAlpha = STANCE_FADE.start;
    this.model.stance = stance;
  }
  setZoom(zoom: number): void { this.model.zoom = zoom; }
  setPlayerName(name: string): void { this.model.name = name; }
  setHealth(health: number): void { this.model.health = health; }
  setTimer(seconds: number): void { this.model.timer = seconds; }
  setRange(metres: number | null): void { this.model.range = metres; }
  /** A line on the event banner for `seconds`. */
  flashMessage(text: string, seconds = 3): void {
    this.model.message = text.toUpperCase();
    this.messageLeft = seconds;
  }

  /**
   * The page's once-a-frame feed from the live state: the magazine (`fire.state().magazine`), the heading
   * (`fly.pose().yaw`), the stance (`walk.posture()`), the range, and the traversal's ledge prompt when it has one.
   */
  feed(src: HudSources): void {
    if (this.frozen) return;
    const m = src.magazine;
    this.setAmmo(m.rounds, m.capacity, m.spare, m.reloading);
    this.setHeading(src.yaw);
    if (src.stance !== undefined) this.setStance(src.stance);
    if (src.climb !== undefined) this.setClimbPrompt(src.climb);
    if (src.range !== undefined) this.setRange(src.range);
  }

  /** Several inputs at once (the test hook's `setHud`). */
  patch(p: HudPatch): void {
    if (p.fireMode) this.setFireMode(p.fireMode);
    if (p.weaponIcon) this.setWeaponIcon(p.weaponIcon);
    if (p.action !== undefined) this.setAction(p.action);
    if (p.climb !== undefined) this.setClimbPrompt(p.climb);
    if (p.message !== undefined) { if (p.message === null) this.model.message = null; else this.flashMessage(p.message, 3600); }
    if (p.zoom !== undefined) this.setZoom(p.zoom);
    if (p.name !== undefined) this.setPlayerName(p.name);
    if (p.health !== undefined) this.setHealth(p.health);
    if (p.timer !== undefined) this.setTimer(p.timer);
    if (p.range !== undefined) this.setRange(p.range);
    if (p.stance !== undefined) this.setStance(p.stance);
    if (p.yaw !== undefined) this.setHeading(p.yaw);
    if (p.rounds !== undefined) this.model.rounds = p.rounds;
    if (p.capacity !== undefined) this.model.capacity = p.capacity;
    if (p.spare !== undefined) this.model.spare = p.spare;
    if (p.frozen !== undefined) this.frozen = p.frozen;
    if (p.settled) { this.sinceOn = SPAWN_FADE.hold + SPAWN_FADE.ramp; this.pulse = 0; }
  }

  /** The fades now. */
  timing(): HudTiming {
    const t = this.sinceOn - SPAWN_FADE.hold;
    return { fade: Math.min(1, Math.max(0, t / SPAWN_FADE.ramp)), stance: this.stanceAlpha, pulse: this.pulse };
  }

  /** What is drawn and where, in the drawing buffer's pixels (y down) of the last frame. */
  state(): HudView {
    const visible = this.on && this.batches.size > 0 && this.frame.height > 0;
    const timing = this.timing();
    const rects = visible ? hudLayout(this.frame, this.model, this.sizes(), timing).rects : {};
    return { visible, frame: { ...this.frame }, model: { ...this.model }, timing, rects };
  }

  /** Steps the fades by `dt` seconds (called by `render` from the frame clock). */
  step(dt: number): void {
    if (this.on) this.sinceOn += dt;
    this.stanceAlpha = Math.max(0, this.stanceAlpha - STANCE_FADE.perSecond * dt);
    if (this.model.action) {
      this.pulse += (this.pulseUp ? 1 : -1) * ACTION_PULSE_RATE * dt;
      if (this.pulse >= 1) { this.pulse = 1; this.pulseUp = false; }
      if (this.pulse <= 0) { this.pulse = 0; this.pulseUp = true; }
    } else { this.pulse = 0; this.pulseUp = true; }
    if (this.model.message) {
      this.messageLeft -= dt;
      if (this.messageLeft <= 0) this.model.message = null;
    }
  }

  /** Draws the HUD over whatever the renderer last drew: nothing is cleared. */
  render(renderer: HudRenderer): void {
    const now = performance.now() / 1000;
    this.step(this.last < 0 ? 0 : Math.min(0.1, now - this.last));
    this.last = now;
    renderer.getDrawingBufferSize(this.size);
    this.frame = { width: this.size.x, height: this.size.y };
    if (!this.on || this.batches.size === 0) return;
    const { width, height } = this.frame;
    this.camera.left = 0; this.camera.right = width; this.camera.top = 0; this.camera.bottom = height;
    this.camera.updateProjectionMatrix();
    const { quads } = hudLayout(this.frame, this.model, this.sizes(), this.timing());
    const byTexture = new Map<string, HudQuad[]>();
    for (const q of quads) {
      const list = byTexture.get(q.texture);
      if (list) list.push(q); else byTexture.set(q.texture, [q]);
    }
    const half = GS_SAMPLE_OFFSET * (height / PS2_H);
    for (const [name, batch] of this.batches) this.fill(batch, byTexture.get(name) ?? [], half);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try { renderer.render(this.scene, this.camera); } finally { renderer.autoClear = autoClear; }
  }

  private sizes(): Record<string, { width: number; height: number }> {
    const out: Record<string, { width: number; height: number }> = {};
    for (const [name, b] of this.batches) out[name] = b.size;
    return out;
  }

  private fill(batch: Batch, quads: HudQuad[], half: number): void {
    if (quads.length > batch.capacity) this.grow(batch, quads.length);
    const pos = batch.geometry.getAttribute('position') as BufferAttribute;
    const tex = batch.geometry.getAttribute('uv') as BufferAttribute;
    const col = batch.geometry.getAttribute('color') as BufferAttribute;
    const { width, height } = batch.size;
    quads.forEach((q, i) => {
      const c = Math.cos(q.turn), sn = Math.sin(q.turn);
      // The GS's corner sampling (`GS_SAMPLE_OFFSET`): the screen's (-half, -half) in the quad's own axes, in texels.
      const lx0 = -half * c - half * sn, ly0 = half * sn - half * c;
      const du = (lx0 / q.w) * (q.u1 - q.u0), dv = (ly0 / q.h) * (q.v1 - q.v0);
      const corners: [number, number, number, number][] = [
        [-0.5, -0.5, q.u0, q.v0], [0.5, -0.5, q.u1, q.v0], [0.5, 0.5, q.u1, q.v1], [-0.5, 0.5, q.u0, q.v1],
      ];
      corners.forEach(([cx, cy, u, v], k) => {
        const lx = cx * q.w, ly = cy * q.h;
        // A clockwise turn on a y-down screen: the game's own (x cos - y sin, x sin + y cos), `FUN_00358730`.
        pos.setXYZ(i * 4 + k, q.x + lx * c - ly * sn, q.y + lx * sn + ly * c, 0);
        tex.setXY(i * 4 + k, (u + du) / width, (v + dv) / height);
        col.setXYZW(i * 4 + k, q.rgba[0], q.rgba[1], q.rgba[2], q.rgba[3]);
      });
    });
    pos.needsUpdate = true; tex.needsUpdate = true; col.needsUpdate = true;
    batch.geometry.setDrawRange(0, quads.length * 6);
    batch.mesh.visible = quads.length > 0;
  }

  private grow(batch: Batch, need: number): void {
    const capacity = Math.max(need, batch.capacity * 2);
    const geometry = quadGeometry(capacity);
    batch.mesh.geometry = geometry;
    batch.geometry.dispose();
    batch.geometry = geometry;
    batch.capacity = capacity;
  }

  private addBatch(name: string, rgba: Rgba): void {
    const map = makeTexture(rgba);
    this.textures.push(map);
    const material = new MeshBasicNodeMaterial();
    material.name = `hud ${name}`;
    material.vertexColors = false;
    // The GS's MODULATE: the texel times the vertex colour, alpha included, blended over the frame. The colour may go
    // over 1 (the action pulse's 140/128), and the GS clamps.
    material.colorNode = vec4(textureNode(map, uv()).mul(vertexColor())).clamp(0, 1);
    material.transparent = true;
    material.depthTest = false;
    material.depthWrite = false;
    material.side = DoubleSide;
    material.fog = false;
    material.toneMapped = false;
    this.materials.push(material);
    const capacity = name === FONT_TEXT_01.texture ? 96 : 4;
    const geometry = quadGeometry(capacity);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.order++;
    mesh.visible = false;
    this.scene.add(mesh);
    this.batches.set(name, { mesh, geometry, capacity, size: { width: rgba.width, height: rgba.height } });
  }

  private clear(): void {
    for (const b of this.batches.values()) { this.scene.remove(b.mesh); b.geometry.dispose(); }
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.batches.clear(); this.materials = []; this.textures = []; this.order = 0;
  }
}

/** `capacity` quads' worth of vertices (four each) and indices (two triangles each). */
function quadGeometry(capacity: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(capacity * 12), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(capacity * 8), 2));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(capacity * 16), 4));
  const index = new Uint16Array(capacity * 6);
  for (let i = 0; i < capacity; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}
