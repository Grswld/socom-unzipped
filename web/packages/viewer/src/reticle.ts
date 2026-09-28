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
 * **The spread** (the floating part's bloom, `m_minsize` to `m_maxsize`): the game's numbers are not in hand, so
 * 0 is the measured rest reach (the arms' outer ends 32 pixels out) and 1 is 1.5x it [estimate], the arms moving
 * outwards and the ring staying.
 */

/** The console frame's cross, measured (above): its pixel bounding box and centre, 640x448 pixels. */
export const CONSOLE_RETICLE = {
  rect: { x: 288, y: 192, width: 65, height: 65 },
  centre: [320.5, 224.5] as [number, number],
} as const;

/** The PS2 frame's height: the HUD's pixel is one 448th of the frame's height (`./renderer`'s `PS2_FRAME`). */
const PS2_HEIGHT = 448;
/** `ret_rifle_01` and `ret_rifle_02`'s own sizes, drawn one texel to one PS2 pixel. */
const FIXED = 64, ARM = 32;
/** Where the arm's core lies across its bitmap: texel column 30, whose centre is 30.5 texels in. */
const ARM_CORE = 30.5;
/** The arms' outer ends at rest, in PS2 pixels from the aim point (measured), and at spread 1 [estimate]. */
const REST_REACH = 32, MAX_REACH_SCALE = 1.5;
/** The arms' colour (measured, above), as 0..1 in the working space: the frame goes out unconverted (`./renderer`). */
export const ARM_TINT: [number, number, number] = [204 / 255, 204 / 255, 31 / 255];

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * One HUD quad in frame pixels, y down: its centre, its size before the turn, and the quarter turns it is drawn
 * with (clockwise on the screen). `floating` turns 0 is the arm as stored, pointing down.
 */
export interface Quad { part: 'fixed' | 'floating'; x: number; y: number; width: number; height: number; turns: 0 | 1 | 2 | 3 }

/**
 * The reticle's quads on a frame of `frame` pixels, centred on the aim point `aim` (0..1 across and down), with
 * the floating part at `spread` (0..1, clamped). `rect` is the quads' bounding box.
 */
export function reticleLayout(
  frame: { width: number; height: number }, aim: [number, number], spread: number,
): { scale: number; centre: [number, number]; quads: Quad[]; rect: Rect } {
  const s = frame.height / PS2_HEIGHT;
  const cx = aim[0] * frame.width, cy = aim[1] * frame.height;
  const reach = REST_REACH * (1 + (MAX_REACH_SCALE - 1) * Math.min(1, Math.max(0, spread)));
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
  private textures: DataTexture[] = [];
  private materials: MeshBasicMaterial[] = [];
  private aim: [number, number] = [0.5, 0.5];
  private spread = 0;
  private on = false;
  private frame = { width: 0, height: 0 };
  private readonly size = new Vector2();

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
    const floating = make(bitmaps.floating, ARM_TINT);
    this.add('fixed', fixed);
    for (let i = 0; i < 4; i++) this.add('floating', floating);
  }

  /** The aim point in normalised screen coordinates, 0..1 across and down; the frame's centre by default. */
  setAimPoint(nx: number, ny: number): void { this.aim = [nx, ny]; }

  setVisible(on: boolean): void { this.on = on; }

  /** The floating part's spread, 0 (rest, measured) to 1 (1.5x the rest reach) [estimate]. */
  setSpread(spread: number): void { this.spread = spread; }

  /** Whether it is being drawn, and where, in the drawing buffer's pixels (y down) of the last frame drawn. */
  state(): { visible: boolean; rect: Rect | null; frame: { width: number; height: number } } {
    const visible = this.on && this.meshes.length > 0 && this.frame.height > 0;
    return { visible, rect: visible ? reticleLayout(this.frame, this.aim, this.spread).rect : null, frame: { ...this.frame } };
  }

  /** Draws the HUD over whatever the renderer last drew: nothing is cleared. */
  render(renderer: HudRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    this.frame = { width: this.size.x, height: this.size.y };
    if (!this.on || this.meshes.length === 0) return;
    const { width, height } = this.frame;
    this.camera.left = 0; this.camera.right = width; this.camera.top = 0; this.camera.bottom = height;
    this.camera.updateProjectionMatrix();
    const quads = reticleLayout(this.frame, this.aim, this.spread).quads;
    const fixed = quads.filter((q) => q.part === 'fixed'), floating = quads.filter((q) => q.part === 'floating');
    let f = 0, a = 0;
    for (const { part, mesh } of this.meshes) {
      const q = part === 'fixed' ? fixed[f++] : floating[a++];
      if (!q) { mesh.visible = false; continue; }
      mesh.visible = true;
      mesh.position.set(q.x, q.y, 0);
      mesh.scale.set(q.width, q.height, 1);
      mesh.rotation.z = (q.turns * Math.PI) / 2;   // +z turns clockwise on a y-down screen
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try { renderer.render(this.scene, this.camera); } finally { renderer.autoClear = autoClear; }
  }

  private add(part: Quad['part'], material: MeshBasicMaterial): void {
    const mesh = new Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = part === 'fixed' ? 0 : 1;
    this.scene.add(mesh);
    this.meshes.push({ part, mesh });
  }

  private clear(): void {
    for (const { mesh } of this.meshes) this.scene.remove(mesh);
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.meshes = []; this.materials = []; this.textures = [];
  }
}
