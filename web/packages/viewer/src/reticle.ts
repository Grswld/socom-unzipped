import {
  Color, DataTexture, DoubleSide, Mesh, MeshBasicMaterial, NearestFilter, OrthographicCamera, PlaneGeometry,
  RGBAFormat, Scene, UnsignedByteType, Vector2, type Camera,
} from 'three';
import type { Rgba } from '@s2u/gs';
import type { ReticleBitmaps } from './hudBitmaps';

/**
 * The reticle (web sprint 2, W2.4; the spec's W2.R4 and §7): the game's own rifle reticle, `ret_rifle_01.tif` and
 * `ret_rifle_02.tif` off `RUN\COMMON\HUD2_TXR.ZED` (`./hudBitmaps`), drawn as a HUD over the world at the size and
 * place the console frame shows.
 *
 * **The authority is a measurement, not code.** reCOM's `BitmapReticule` (`research/recom/src/Apps/FTS/hud/
 * hud.h:465-520`) names the parts -- `m_reticuleTex[10]` (fixed), `m_floatingreticuleTex[10]` and four floating
 * polys, `m_minsize`/`m_maxsize`, `m_accuracyxtex` -- but `hud_bitmapreticule.cpp` is empty, so the placement was
 * measured on the console frame at spawn, `scripts/parity/refs/console_spawn_slot8.png` (640x448, PCSX2 at the
 * game's native frame), on 2026-09-28:
 *
 * - **The cross.** Yellow-green pixels (min(R, G) - B >= 30 and |R - G| < 30, in the frame's middle third; the
 *   plateau (151, 149, 28)), four connected parts: top x 318-320 y 192-208, bottom x 318-320 y 240-256, left
 *   x 288-303 y 224-226, right x 337-352 y 224-226. Bounding box **x 288-352, y 192-256 (65 x 65 pixels), centre
 *   (320.5, 224.5)** -- the frame's centre (320, 224) within a pixel. Each arm is bright at its outer end
 *   (half-maximum 31 pixels from the centre on all four) and fades out 9-12 pixels from it (fainter than the
 *   threshold): `ret_rifle_02`'s arm (core texel column 30, rows 8-30, white at row 30) at one
 *   PS2 pixel a texel, its outer end outwards, turned a quarter for each arm. `ret_rifle_02` is white; the
 *   yellow-green is the draw's colour, taken so that its core over the local background (34, 28, 22) at the
 *   texel's alpha 175/255 gives the plateau: **(204, 204, 31)** [measured, one pixel's colour].
 * - **The ring and the dot.** The frame darkens 21-26 pixels from the centre on every diagonal and shows one white
 *   pixel (211, 210, 208) at (320, 224) with a grey halo: `ret_rifle_01`'s ring (radius 21-27 texels, black at
 *   alpha <= 44) and its 2x2 dot at texels 31-32, at its own 64 pixels, centred on the same point, untinted.
 * - **Which is which:** `_01` is the fixed part, `_02` the floating one (four arms, the `m_floatingreticule`
 *   polys); `ret_accuracy.tif` (16x16, a yellow diamond) is not in the frame at rest and is not drawn.
 *
 * **Size on other frames.** The PS2 presentation draws 640x448, so a texel is a pixel. The Modern presentation
 * keeps the PS2 pixel's size relative to the frame's height -- a scale of height / 448 -- so the cross keeps the
 * console's proportion on any screen. Nearest-neighbour: the console's HUD is pixel art.
 *
 * **The size and the climb** (research 84 §3-§4, `./accuracy`): SOCOM II's HUD (`BitmapReticule_UpdateAccuracy`
 * 0x215250) pushes each arm's quad out from the centre by the kit's reticle size `kit+0x84c` (`hud+0x44b4`), halved in
 * the third-person view (view state 0), in PS2 pixels -- so the measured rest (outer ends 32 out) is size 0 and an arm's
 * outer end is `32 + size` out; `TargetMin` 1 halved is the console frame's half pixel. The whole reticle, ring and arms,
 * is drawn at the aim point plus the knock's offset (`FUN_00216770`: (320, 224) + `kit+0x18/+0x20`, `+0x1c/+0x24`).
 * There is no `m_minsize`/`m_maxsize` in SOCOM II's HUD: the range is the weapon's, per stance (`TargetMin`/`TargetMax`).
 * - **The colour** (`FUN_00215c10`, `FUN_003590e0` on the four arms): (200, 200, 24) at rest -- the measured (204, 204,
 *   31) -- (24, 200, 44) on a teammate, (200, 24, 44) on an identified enemy, (130, 130, 130) out of a launcher's range.
 * - **The scope** (view state 5+, `ChangeReticule` 0x213e20 type 5): no ring and no arms; `ret_scope_01` and
 *   `ret_scope_02` each drawn as four mirrored 320x320 quads over (0, -96)-(640, 544), centred on the frame (not the
 *   aim point), as decoded: `ret_scope_01` the black tube (radius 81 of its 128 texels, 202 pixels on the frame),
 *   clear inside, with a one-texel grey (79, PS2 alpha 94) cross along the centre lines, dashed for its inner 22
 *   texels; `ret_scope_02` the soft black ring inside the tube (alpha 255 at radius 95 fading to 0 at 44).
 */

/** The console frame's cross, measured (above): its pixel bounding box and centre, 640x448 pixels. */
export const CONSOLE_RETICLE = {
  rect: { x: 288, y: 192, width: 65, height: 65 },
  centre: [320.5, 224.5] as [number, number],
} as const;

/** The PS2 frame's height: the HUD's pixel is one 448th of the frame's height (`./renderer`'s `PS2_FRAME`). */
const PS2_HEIGHT = 448;

/**
 * WEAPON: the accuracy pip (`ret_accuracy.tif`, `hud+0x1f0`), the mark of a **blocked muzzle** (research 84 §9).
 * `FUN_005aa6e0` (decomp 464290-464350), while the rifle's raise envelope is not 0 and it is up or coming down
 * (`FUN_005e0010`, state `0x12`), casts from the fire point to the aim point (`FUN_005b6240`); where that ray meets
 * something (and, after a round, not within 0.008 of where the round went) it projects the hit to the screen
 * (`FUN_00290370`) and keeps the offset from the reticle's centre at body `+0xe44`/`+0xe48`, setting kit `+0x5e0` bit 3;
 * otherwise it clears the bit. `BitmapReticule_UpdateAccuracy` (`FUN_00215250`, 69706-69770) then, each frame:
 *
 * - **hides it** (fading its alpha 32 a frame to 0) when the bit is clear, or when both offsets are at most the drawn
 *   size (`hud+0x44b4`, halved in third person) -- a signed test, so a hit up or to the left of the centre inside the
 *   other axis's size does not show it [the game's own quirk, ported];
 * - **else shows it** at the centre plus the offsets less half its bitmap, raising its alpha 32 a frame while under 128,
 *   the offsets pulled in to 200.032 pixels only while scoped (`FUN_005b9990`: state > 4).
 */
export const PIP_FADE = 32;
/** The pip's full alpha, PS2's 128 (opaque). */
export const PIP_FULL = 128;
/** The scoped clamp on the pip's offset, PS2 pixels (`FUN_00215250`: 40012.8 = 200.032²). */
export const PIP_SCOPED_REACH = 200.032;

export interface PipState { alpha: number; offset: [number, number] | null }

/**
 * One frame of the pip (`FUN_00215250`): `offset` the blocked muzzle's hit from the reticle's centre (PS2 pixels, y
 * down) or null for none, `size` the drawn size (already halved in third person), `scoped` the view state over 4.
 * Returns the new alpha (0..128) and where it is drawn (null: not drawn).
 */
export function stepPip(prev: PipState, offset: [number, number] | null, size: number, scoped: boolean): PipState {
  if (!offset || (offset[0] <= size && offset[1] <= size)) {
    const alpha = Math.max(0, prev.alpha - PIP_FADE);
    return { alpha, offset: alpha > 0 ? prev.offset : null };
  }
  let [x, y] = offset;
  const r2 = x * x + y * y;
  if (scoped && r2 > PIP_SCOPED_REACH * PIP_SCOPED_REACH) { const k = PIP_SCOPED_REACH / Math.sqrt(r2); x *= k; y *= k; }
  return { alpha: prev.alpha < PIP_FULL ? Math.min(PIP_FULL, prev.alpha + PIP_FADE) : prev.alpha, offset: [x, y] };
}
/** `ret_rifle_01` and `ret_rifle_02`'s own sizes, drawn one texel to one PS2 pixel. */
const FIXED = 64, ARM = 32;
/** Where the arm's core lies across its bitmap: texel column 30, whose centre is 30.5 texels in. */
const ARM_CORE = 30.5;
/** The arms' outer ends at size 0, in PS2 pixels from the aim point (measured on the console frame). */
const REST_REACH = 32;
/** The scope's quads: 320 PS2 pixels a side, the four around the frame's centre (`ChangeReticule` type 5). */
const SCOPE_QUAD = 320;
/** The arms' colour (measured, above), as 0..1 in the working space: the frame goes out unconverted (`./renderer`). */
export const ARM_TINT: [number, number, number] = [204 / 255, 204 / 255, 31 / 255];

/** The arms' colours (`FUN_00215c10`'s vertex colours, scaled so the rest one is the measured `ARM_TINT`). */
export type ReticleColour = 'rest' | 'friendly' | 'hostile' | 'range';
const GAME_COLOUR: Record<ReticleColour, [number, number, number]> = {
  rest: [200, 200, 24], friendly: [24, 200, 44], hostile: [200, 24, 44], range: [130, 130, 130],
};
export function reticleTint(colour: ReticleColour): [number, number, number] {
  const g = GAME_COLOUR[colour], r = GAME_COLOUR.rest;
  return [0, 1, 2].map((i) => Math.min(1, (g[i]! / r[i]!) * ARM_TINT[i]!)) as [number, number, number];
}

/**
 * The reticle set a weapon draws (`FUN_005be300`, the kit's `+0x54`): by the view first -- the 9x view 7
 * (`ret_binocs`), a magnification over 1.01 5 (the scope) -- then by the weapon's `ID` (`EQUIP_ITEM`): 11 (the
 * designator) 9; 4-30 0 (sidearm); 31-80 1 (rifle); 81-90 2 (shotgun); 91-120 1; 121-140 and 151-189 4 (grenade);
 * 190-253 0; 151/152 none. A weapon with a launcher fitted is 3 (rocket). -1 draws nothing.
 */
export function reticleType(weaponId: number, zoomState: number, magnification: number): number {
  if (zoomState === 4) return 7;
  if (magnification > 1.01) return 5;
  const id = weaponId & 0xff;
  if (id === 0x98 || id === 0x97) return -1;
  if (id === 0x0b) return 9;
  if (id >= 4 && id <= 0x1e) return 0;
  if (id >= 0x1f && id <= 0x50) return 1;
  if (id >= 0x51 && id <= 0x5a) return 2;
  if (id >= 0x5b && id <= 0x78) return 1;
  if (id >= 0x79 && id <= 0x8c) return 4;
  if (id >= 0x97 && id <= 0xbd) return 4;
  if (id >= 0xbe && id <= 0xfd) return 0;
  return -1;
}

/**
 * The sets' bitmaps (`BitmapReticule_Init` 0x2178c0: `hud+0x44bc + 4 x type` the fixed part, `hud+0x44e8 + 4 x type`
 * the floating one). Only the rifle (1) and the scope (5) are drawn today; the rest load with them, ready.
 */
export const RETICLE_SETS: Record<number, { fixed: string; floating: string | null }> = {
  0: { fixed: 'ret_sidearm_01.tif', floating: 'ret_sidearm_02.tif' },
  1: { fixed: 'ret_rifle_01.tif', floating: 'ret_rifle_02.tif' },
  2: { fixed: 'ret_shotgun_01.tif', floating: 'ret_shotgun_02.tif' },
  3: { fixed: 'ret_rocket_01.tif', floating: 'ret_rocket_02.tif' },
  4: { fixed: 'ret_grenade_02.tif', floating: null },
  5: { fixed: 'ret_scope_02.tif', floating: null },
  6: { fixed: 'ret_scope_01.tif', floating: null },
  7: { fixed: 'ret_binocs.tif', floating: 'ret_binocs2.tif' },
  8: { fixed: 'nvg_part.tif', floating: null },
  9: { fixed: 'ret_sidearm_01.tif', floating: 'ret_laser_designator.tif' },
};

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * One HUD quad in frame pixels, y down: its centre, its size before the turn, and the quarter turns it is drawn
 * with (clockwise on the screen). `floating` turns 0 is the arm as stored, pointing down.
 */
export interface Quad { part: 'fixed' | 'floating'; x: number; y: number; width: number; height: number; turns: 0 | 1 | 2 | 3 }

/**
 * The reticle's quads on a frame of `frame` pixels, centred on the aim point `aim` (0..1 across and down) moved by
 * `offset` (PS2 pixels, y down: the knock), the arms pushed out by `size` (PS2 pixels, the HUD's drawn size, >= 0).
 * `rect` is the quads' bounding box.
 */
export function reticleLayout(
  frame: { width: number; height: number }, aim: [number, number], size: number, offset: [number, number] = [0, 0],
): { scale: number; centre: [number, number]; quads: Quad[]; rect: Rect } {
  const s = frame.height / PS2_HEIGHT;
  const cx = aim[0] * frame.width + offset[0] * s, cy = aim[1] * frame.height + offset[1] * s;
  const reach = REST_REACH + Math.max(0, size);
  const quads: Quad[] = [{ part: 'fixed', x: cx, y: cy, width: FIXED * s, height: FIXED * s, turns: 0 }];
  // The arm as stored, pointing down: its core on the vertical through the aim point, its outer end `reach` out.
  let dx = (ARM / 2 - ARM_CORE) * s, dy = (reach - ARM / 2) * s;
  for (const turns of [0, 1, 2, 3] as const) {
    quads.push({ part: 'floating', x: cx + dx, y: cy + dy, width: ARM * s, height: ARM * s, turns });
    [dx, dy] = [-dy, dx];                          // a quarter turn clockwise on a y-down screen
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of quads) {
    const [hw, hh] = q.turns % 2 === 0 ? [q.width / 2, q.height / 2] : [q.height / 2, q.width / 2];
    x0 = Math.min(x0, q.x - hw); x1 = Math.max(x1, q.x + hw);
    y0 = Math.min(y0, q.y - hh); y1 = Math.max(y1, q.y + hh);
  }
  return { scale: s, centre: [cx, cy], quads, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
}

/**
 * The scope's four quads on a frame (`ChangeReticule` type 5): 320 PS2 pixels a side around the frame's centre, each
 * the bitmap mirrored so the tube's centre -- the decoded bitmap's top-right corner -- meets the frame's centre.
 * `flipX`/`flipY` mirror the stored bitmap. The black bars beyond the 640-wide square fill a wider frame.
 */
export function scopeLayout(frame: { width: number; height: number }): {
  quads: { x: number; y: number; size: number; flipX: boolean; flipY: boolean }[]; bars: Rect[];
} {
  const s = frame.height / PS2_HEIGHT, q = SCOPE_QUAD * s;
  const cx = frame.width / 2, cy = frame.height / 2;
  const quads = [
    { x: cx - q / 2, y: cy - q / 2, size: q, flipX: false, flipY: true },      // top-left: centre at its bottom-right
    { x: cx + q / 2, y: cy - q / 2, size: q, flipX: true, flipY: true },       // top-right
    { x: cx - q / 2, y: cy + q / 2, size: q, flipX: false, flipY: false },     // bottom-left: as stored
    { x: cx + q / 2, y: cy + q / 2, size: q, flipX: true, flipY: false },      // bottom-right
  ];
  const side = Math.max(0, cx - q);
  const bars = side > 0 ? [{ x: 0, y: 0, width: side, height: frame.height }, { x: frame.width - side, y: 0, width: side, height: frame.height }] : [];
  return { quads, bars };
}


/** What the HUD pass needs of three's renderer (a `WebGPURenderer` in the page). */
export interface HudRenderer {
  autoClear: boolean;
  render(scene: Scene, camera: Camera): unknown;
  getDrawingBufferSize(target: Vector2): Vector2;
}

function texture(rgba: Rgba): DataTexture {
  // Row 0 of the decode is the bitmap's top row; the HUD camera looks with y down, so it is uploaded unflipped.
  const t = new DataTexture(rgba.data, rgba.width, rgba.height, RGBAFormat, UnsignedByteType);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/**
 * The HUD layer: an orthographic scene in frame pixels (y down), drawn after the world with `autoClear` off and
 * no depth test. `setAimPoint` and `setVisible` are the page's; `render` is called once a frame after the world.
 */
export class Reticle {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, 1, 0, 1, -1, 1);
  private readonly geometry = new PlaneGeometry(1, 1);
  private meshes: { part: Quad['part']; mesh: Mesh }[] = [];
  private scopeMeshes: Mesh[] = [];
  private bars: Mesh[] = [];
  private textures: DataTexture[] = [];
  private materials: MeshBasicMaterial[] = [];
  private armMaterial: MeshBasicMaterial | null = null;
  private aim: [number, number] = [0.5, 0.5];
  private drawSize = 0;
  private offset: [number, number] = [0, 0];
  private mode: 'reticle' | 'scope' = 'reticle';
  private colour: ReticleColour = 'rest';
  private on = false;
  private frame = { width: 0, height: 0 };
  private readonly size = new Vector2();
  /** WEAPON: the accuracy pip (`stepPip`), its mesh and material, and the frames it has faded over. */
  private pip: PipState = { alpha: 0, offset: null };
  private pipMesh: Mesh | null = null;
  private pipMaterial: MeshBasicMaterial | null = null;
  private pipSize: [number, number] = [16, 16];
  private pipClock = 0;
  /** WEAPON: the reticle set drawn (`reticleType`: 1 the rifle's, 0 the sidearm's) and the bitmaps to switch between. */
  private type = 1;
  private sets: Record<string, Rgba> = {};
  private fixedMaterial: MeshBasicMaterial | null = null;

  /** The bitmaps of the map just loaded, or none (the reticle then draws nothing). */
  setBitmaps(bitmaps: ReticleBitmaps | null | undefined): void {
    this.clear();
    if (!bitmaps) return;
    const make = (rgba: Rgba, tint: [number, number, number] | null): MeshBasicMaterial => {
      const map = texture(rgba);
      this.textures.push(map);
      const material = new MeshBasicMaterial({
        map, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide, fog: false, toneMapped: false,
        color: tint ? new Color().setRGB(...tint) : new Color(1, 1, 1),
      });
      this.materials.push(material);
      return material;
    };
    const fixed = make(bitmaps.fixed, null);
    const floating = make(bitmaps.floating, reticleTint(this.colour));
    this.armMaterial = floating;
    this.fixedMaterial = fixed;
    this.sets = bitmaps.sets ?? {};
    if (bitmaps.accuracy) {
      const pip = make(bitmaps.accuracy, null);
      pip.opacity = 0;
      this.pipMaterial = pip;
      this.pipSize = [bitmaps.accuracy.width, bitmaps.accuracy.height];
      this.pipMesh = this.addMesh(pip, 3);
    }
    this.add('fixed', fixed);
    for (let i = 0; i < 4; i++) this.add('floating', floating);
    // The scope (type 5): the tube's mask, then its soft inner ring, four mirrored quads each; black bars beside.
    const scope01 = bitmaps.sets?.['ret_scope_01.tif'], scope02 = bitmaps.sets?.['ret_scope_02.tif'];
    for (const rgba of [scope01 ?? null, scope02 ?? null]) {
      if (!rgba) continue;
      const material = make(rgba, null);
      for (let i = 0; i < 4; i++) this.scopeMeshes.push(this.addMesh(material, 2));
    }
    if (this.scopeMeshes.length > 0) {
      const black = new MeshBasicMaterial({ color: 0x000000, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
      this.materials.push(black);
      for (let i = 0; i < 2; i++) this.bars.push(this.addMesh(black, 2));
    }
  }

  /** The aim point in normalised screen coordinates, 0..1 across and down; the frame's centre by default. */
  setAimPoint(nx: number, ny: number): void { this.aim = [nx, ny]; }

  setVisible(on: boolean): void { this.on = on; }

  /**
   * The HUD's drawn size and the knock's offset, PS2 pixels (`./accuracy`'s `reticle()`): the arms pushed out by
   * `size`, the whole reticle moved by `offset` (y down).
   */
  setSize(size: number, offset: [number, number] = [0, 0]): void {
    this.drawSize = size;
    this.offset = [offset[0], offset[1]];
  }

  /**
   * WEAPON: the reticle set (`reticleType` / `RETICLE_SETS`, `BitmapReticule_Init` 0x2178c0): 1 the rifle's
   * `ret_rifle_01/02`, 0 the sidearm's `ret_sidearm_01/02`; a set whose bitmaps the map lacks keeps the one drawn.
   */
  setType(type: number): void {
    if (type === this.type) return;
    const set = RETICLE_SETS[type];
    const fixed = set ? this.sets[set.fixed] : undefined, floating = set?.floating ? this.sets[set.floating] : undefined;
    if (!fixed || !floating || !this.fixedMaterial || !this.armMaterial) return;
    this.type = type;
    for (const [material, rgba] of [[this.fixedMaterial, fixed], [this.armMaterial, floating]] as const) {
      material.map?.dispose();
      const map = texture(rgba);
      this.textures.push(map);
      material.map = map;
      material.needsUpdate = true;
    }
  }

  /**
   * WEAPON: one frame of the accuracy pip (`stepPip`): the blocked muzzle's hit as an offset from the reticle's centre
   * (PS2 pixels, y down) or null, and whether the view is scoped. The fade runs at the game's 60 frames a second.
   */
  setPip(offset: [number, number] | null, scoped: boolean, dt = 1 / 60): void {
    this.pipClock += dt;
    while (this.pipClock >= 1 / 60 - 1e-9) {
      this.pipClock -= 1 / 60;
      this.pip = stepPip(this.pip, offset, this.drawSize, scoped);
    }
    // Between two of the game's frames a shown pip rides the latest offset.
    if (this.pip.offset && offset) {
      const now = stepPip({ alpha: PIP_FULL, offset: null }, offset, this.drawSize, scoped).offset;
      if (now) this.pip = { alpha: this.pip.alpha, offset: now };
    }
  }

  /** The rifle's reticle, or the scope's overlay (view state 5 and up). */
  setMode(mode: 'reticle' | 'scope'): void { this.mode = mode; }

  /** The arms' colour: at rest, on a teammate, on an enemy, out of range (`FUN_00215c10`). */
  setColour(colour: ReticleColour): void {
    this.colour = colour;
    this.armMaterial?.color.setRGB(...reticleTint(colour));
  }

  /** Whether it is being drawn, and where, in the drawing buffer's pixels (y down) of the last frame drawn. */
  state(): {
    visible: boolean; rect: Rect | null; frame: { width: number; height: number };
    mode: 'reticle' | 'scope'; size: number; offset: [number, number]; colour: ReticleColour;
    type: number; pip: { alpha: number; offset: [number, number] | null };
  } {
    const visible = this.on && this.meshes.length > 0 && this.frame.height > 0;
    const rect = visible && this.mode === 'reticle' ? reticleLayout(this.frame, this.aim, this.drawSize, this.offset).rect : null;
    return {
      visible, rect, frame: { ...this.frame }, mode: this.mode, size: this.drawSize, offset: [...this.offset], colour: this.colour,
      type: this.type, pip: { alpha: this.pip.alpha, offset: this.pip.offset ? [...this.pip.offset] : null },
    };
  }

  /** Draws the HUD over whatever the renderer last drew: nothing is cleared. */
  render(renderer: HudRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    this.frame = { width: this.size.x, height: this.size.y };
    if (!this.on || this.meshes.length === 0) return;
    const { width, height } = this.frame;
    this.camera.left = 0; this.camera.right = width; this.camera.top = 0; this.camera.bottom = height;
    this.camera.updateProjectionMatrix();
    const scoped = this.mode === 'scope' && this.scopeMeshes.length > 0;
    const quads = reticleLayout(this.frame, this.aim, this.drawSize, this.offset).quads;
    const fixed = quads.filter((q) => q.part === 'fixed'), floating = quads.filter((q) => q.part === 'floating');
    let f = 0, a = 0;
    for (const { part, mesh } of this.meshes) {
      const q = part === 'fixed' ? fixed[f++] : floating[a++];
      if (!q || scoped) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.set(q.x, q.y, 0);
      mesh.scale.set(q.width, q.height, 1);
      mesh.rotation.z = (q.turns * Math.PI) / 2;   // +z turns clockwise on a y-down screen
    }
    // The pip: at the reticle's centre plus its offset, its alpha the PS2's over 128 (`stepPip`).
    if (this.pipMesh && this.pipMaterial) {
      const p = this.pip.offset;
      const layout = reticleLayout(this.frame, this.aim, this.drawSize, this.offset);
      this.pipMesh.visible = !!p && this.pip.alpha > 0;
      if (p) {
        const s = layout.scale;
        this.pipMesh.position.set(layout.centre[0] + p[0] * s, layout.centre[1] + p[1] * s, 0);
        this.pipMesh.scale.set(this.pipSize[0] * s, this.pipSize[1] * s, 1);
        this.pipMaterial.opacity = Math.min(1, this.pip.alpha / PIP_FULL);
      }
    }
    const scope = scopeLayout(this.frame);
    this.scopeMeshes.forEach((mesh, i) => {
      const q = scope.quads[i % 4]!;
      mesh.visible = scoped;
      mesh.position.set(q.x, q.y, 0);
      mesh.scale.set(q.flipX ? -q.size : q.size, q.flipY ? -q.size : q.size, 1);
    });
    this.bars.forEach((mesh, i) => {
      const r = scope.bars[i];
      mesh.visible = scoped && !!r;
      if (r) { mesh.position.set(r.x + r.width / 2, r.y + r.height / 2, 0); mesh.scale.set(r.width, r.height, 1); }
    });
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try { renderer.render(this.scene, this.camera); } finally { renderer.autoClear = autoClear; }
  }

  private add(part: Quad['part'], material: MeshBasicMaterial): void {
    this.meshes.push({ part, mesh: this.addMesh(material, part === 'fixed' ? 0 : 1) });
  }

  private addMesh(material: MeshBasicMaterial, order: number): Mesh {
    const mesh = new Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  private clear(): void {
    for (const { mesh } of this.meshes) this.scene.remove(mesh);
    for (const mesh of [...this.scopeMeshes, ...this.bars]) this.scene.remove(mesh);
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    if (this.pipMesh) this.scene.remove(this.pipMesh);
    this.meshes = []; this.scopeMeshes = []; this.bars = []; this.materials = []; this.textures = [];
    this.armMaterial = null; this.fixedMaterial = null; this.pipMesh = null; this.pipMaterial = null;
    this.pip = { alpha: 0, offset: null }; this.type = 1; this.sets = {};
  }
}
