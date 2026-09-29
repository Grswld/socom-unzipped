import { Color, type Scene } from 'three';
import { clamp, float, fog as fogNode, positionView, positionWorld, uniform } from 'three/tsl';

/**
 * SOCOM II's fog, as the game computes it.
 *
 * The EE builds a scale and an offset from the level's near and far
 * (`sub_00294070`, guest `0x294730`-`0x2947CC`):
 *
 * ```
 *   scale  = -255 / (far - near)
 *   offset = 255 - near * scale        // = 255 * far / (far - near)
 * ```
 *
 * and uploads them to VU1 data qwords 28/29. Per vertex the coefficient is
 *
 * ```
 *   F = clamp(w * scale + offset, 0, 255) * clamp((P.y - bottom) / (top - bottom), 0, 1)
 * ```
 *
 * where `w` is the **clip-space w -- view depth along the camera axis**, not radial distance from the
 * eye (`sub_002948D0` computes the radial form, but that is the EE's own mirror for CPU-side object
 * fades; the per-vertex fog that shades world geometry is VU1 handlers `0xf90` and `0x1108`, which read
 * data qwords 28/29 and use `w`). The second factor is the **altitude band**: qword 28 is
 * `(ref.xyz, offset)` and 29 is `(scl.xyz, scale)`, and the VU multiplies the distance term by
 * `clamp(dot(P - ref, scl), 0, 1)` (research/13 lines 570-585). `sub_00294070` from `0x2947D0` fills
 * `ref.y = fog_bottom` and `scl.y = 1 / (fog_top - fog_bottom)` when `cameras/camera` enables the band
 * (flags bit 31; six of the 22 maps), and `sub_00293F90` parks them at `ref.y = -10000`,
 * `scl.y = 0.001` when it does not, so the term is 1 for anything above y = -9000. Below the bottom of
 * the band everything is fog colour: a valley fog.
 *
 * The GS then blends `C = (F*C)>>8 + ((255-F)*FOGCOL)>>8`, i.e. `mix(FOGCOL, C, F/255)`: `F = 255` at
 * `near` is unfogged, `F = 0` at `far` is the fog colour outright -- and only where the packet's
 * `PRIM.FGE` is set (`MeshData.fog`); the skies, the water and the glows clear it and take no fog.
 *
 * Three's own range fog is a *smoothstep* between near and far, which is not the GS's linear ramp, so
 * the fog is a node of its own on `scene.fogNode`: the ramp above, in view depth, with the band.
 *
 * `FOGCOL` is not written by any EE instruction: it sits in a static 16-qword GS-state packet at
 * guest `0x003E0880` (value word at `0x003E08B0`) that the flip DMAs every frame, and the level
 * loader patches that qword per map. The ELF default in the slot is `0x00646464`.
 *
 * **Departures from the hardware.** `far == near` divides by zero on the hardware path too, and the
 * game's own note records the NaN; a zero or inverted span is refused here rather than propagated.
 * The band is applied in world space; the dumps show `ref`/`scl` rewritten per object into model
 * space, which is the same test on an unscaled object.
 */
export interface FogSettings {
  enabled: boolean;
  /** Distance at which fog starts, in game units -- the geometry's own scale. */
  near: number;
  /** Distance at which fog is total. */
  far: number;
  /** `FOGCOL`, 0..255 per channel, as the GS register holds it. */
  color: [number, number, number];
  /** The altitude band, `m_fog_top` / `m_fog_bottom`, or null when the map does not enable it. */
  altitude: { top: number; bottom: number } | null;
}

/** The ELF's own default in the FOGCOL slot at `0x003E08B0`: grey 100,100,100. */
export const ELF_DEFAULT_FOGCOL: [number, number, number] = [0x64, 0x64, 0x64];

/** What `sub_00293F90` writes for `ref.y` and `scl.y` when the band is off. */
const BAND_OFF = { bottom: -10000, invSpan: 0.001 } as const;

/**
 * A starting near/far for a map whose own numbers have not been read off the disc yet, derived from
 * how big the map is. Stated as a fraction of the world diagonal so it is at least the right order
 * of magnitude on a 100 m map and on a 400 m one.
 */
export function fogForExtent(diagonal: number): { near: number; far: number } {
  return { near: Math.round(diagonal * 0.35), far: Math.round(diagonal * 0.95) };
}

/**
 * The GS's `F` at a distance, for a test or a readout. Returns 0..255, 255 being unfogged.
 * Mirrors `sub_002948D0` including its clamp.
 */
export function fogCoefficient(dist: number, near: number, far: number): number {
  if (!(far > near)) return 255;                       // the hardware's NaN case, refused
  const scale = -255 / (far - near);
  const offset = 255 - near * scale;
  return Math.min(255, Math.max(0, offset + scale * dist));
}

/** The altitude term at a height: 1 at and above the top of the band, 0 at and below the bottom. */
export function altitudeFactor(y: number, top: number, bottom: number): number {
  if (!(top > bottom)) return 1;
  return Math.min(1, Math.max(0, (y - bottom) / (top - bottom)));
}

/** The four numbers the VU reads: qword 29's scale, qword 28's offset, and the band's `ref.y` / `scl.y`. */
export interface FogParams { scale: number; offset: number; bottom: number; invSpan: number }

/** `fogParams` of the settings, or null when the fog is off or its span is degenerate. */
export function fogParams(settings: FogSettings): FogParams | null {
  if (!settings.enabled || !(settings.far > settings.near)) return null;
  const scale = -255 / (settings.far - settings.near);
  const offset = 255 - settings.near * scale;
  const band = settings.altitude;
  const altitude = band && band.top > band.bottom
    ? { bottom: band.bottom, invSpan: 1 / (band.top - band.bottom) }
    : BAND_OFF;
  return { scale, offset, ...altitude };
}

/** `uniform` is overloaded; these two pin the shapes the fog uses so the record below can name them. */
const numberUniform = (v: number) => uniform(v);
const colorUniform = (c: Color) => uniform(c);

/** The node and its uniforms, one set per scene, updated in place. */
interface Ps2Fog {
  color: ReturnType<typeof colorUniform>;
  scale: ReturnType<typeof numberUniform>;
  offset: ReturnType<typeof numberUniform>;
  bottom: ReturnType<typeof numberUniform>;
  invSpan: ReturnType<typeof numberUniform>;
  node: ReturnType<typeof fogNode>;
}

const fogs = new WeakMap<Scene, Ps2Fog>();

function ps2FogFor(scene: Scene): Ps2Fog {
  const known = fogs.get(scene);
  if (known) return known;
  const color = colorUniform(new Color());
  const scale = numberUniform(0);
  const offset = numberUniform(255);
  const bottom = numberUniform(BAND_OFF.bottom);
  const invSpan = numberUniform(BAND_OFF.invSpan);
  // `w` is the view-space depth; `P` the world position. Both clamps are the VU's own.
  const viewZ = positionView.z.negate();
  const base = clamp(viewZ.mul(scale).add(offset), float(0), float(255));
  const band = clamp(positionWorld.y.sub(bottom).mul(invSpan), float(0), float(1));
  const factor = base.mul(band).div(255).oneMinus();   // 0 = untouched, 1 = FOGCOL outright
  const made: Ps2Fog = { color, scale, offset, bottom, invSpan, node: fogNode(color, factor) };
  fogs.set(scene, made);
  return made;
}

/** The uniforms behind a scene's fog, for a test or a readout; null before `applyFog` ran. */
export function fogUniforms(scene: Scene): Omit<Ps2Fog, 'node'> | null {
  return fogs.get(scene) ?? null;
}

/**
 * Puts the settings on the scene. The colour is set through `setRGB` on the working space rather than
 * `setHex`, which would apply an sRGB decode the GS never did -- `FOGCOL` is a raw register value and
 * the viewer's default pipeline is the GS's own space.
 */
export function applyFog(scene: Scene, settings: FogSettings): void {
  const params = fogParams(settings);
  if (!params) {
    scene.fogNode = null;
    return;
  }
  const fog = ps2FogFor(scene);
  const [r, g, b] = settings.color;
  fog.color.value.setRGB(r / 255, g / 255, b / 255);
  fog.scale.value = params.scale;
  fog.offset.value = params.offset;
  fog.bottom.value = params.bottom;
  fog.invSpan.value = params.invSpan;
  if (scene.fogNode !== fog.node) scene.fogNode = fog.node;
}
