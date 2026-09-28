import type { TexDetail } from '@s2u/archive';
import type { GsState } from '@s2u/gs';

/**
 * What the viewer knows about one texture: the two record flags it always read, the two facts it reads
 * off the decoded pixels, and -- since the audit of 2026-09-26 -- the GS state the record's own bind
 * packet sets (`@s2u/gs`'s `GsState`), which is what the pixel facts used to stand in for.
 */
export interface TextureFlags {
  bilinear: boolean;
  transparent: boolean;
  /** The alpha is a ramp (a glow, a corona) rather than a switch (a leaf, a grating). */
  graded: boolean;
  /**
   * Every sampled texel is solid. It used to decide backface culling, standing in for the visual's
   * own flag; now it only says whether a texture has any alpha to blend or test at all.
   */
  opaque: boolean;
  gs: GsState | null;
}

/**
 * The blend a draw asks for, in the GS's own terms (`ALPHA_1`, research 31 §12 for the notation):
 *
 * - `none` -- no blending: an opaque surface, or a cutout punched by the alpha test.
 * - `source` -- `(Cs - Cd) * As + Cd`, source alpha over.
 * - `additive` -- `(Cs - 0) * As + Cd`.
 * - `destination` -- `(Cd - 0) * As + Cd`: the destination brightened by its own alpha, a light map.
 *   The source *colour* is not read at all, only its alpha.
 */
export type Blend = 'none' | 'source' | 'additive' | 'destination';

/** A three material, described without three: what `world.ts` sets on a material and its texture. */
export interface MaterialSpec {
  blend: Blend;
  /** 0 for none; otherwise the threshold in 0..1. The GS keeps a texel whose alpha is *greater*. */
  alphaTest: number;
  /** Backface culling on: the visual's own flag on the disc (`VISUAL_FLAG_CULL` in `@s2u/scene`). */
  cull: boolean;
  wrapS: 'repeat' | 'clamp';
  wrapT: 'repeat' | 'clamp';
  bilinear: boolean;
  mipmaps: boolean;
  /** `PRIM.FGE` of the packet that draws it: off for skies, water and self-lit surfaces. */
  fog: boolean;
  /** The second pass its texture's manifest binds (`DetailSpec`); absent on every texture without one. */
  detail?: DetailSpec;
}

/**
 * The disc's state, read into a material.
 *
 * Three kinds of alpha, and the disc distinguishes two of them:
 *
 * - **A cutout** -- `TEST.ATE = 1` -- is punched through at the reference the register gives (`AREF /
 *   128`, 0.5 on every one in the corpus) and blends nothing. It writes depth and needs no sorting.
 * - **A switch drawn with a blend** -- `ATE = 0` but the alpha is only ever 0 or full -- blends to the
 *   same picture a cutout gives, because `(Cs - Cd) * As + Cd` at `As` in {0, 1} *is* a cutout; the
 *   hardware wrote depth under its clear texels and lived with it, and a cutout is the better copy.
 * - **A ramp** -- a glow, a flare, a soft decal -- is blended with the equation the disc asks for:
 *   source alpha, additive, or the destination brighten. The EE-animated `FIX` factor (one texture in
 *   the corpus, `lightglow.tif` on MP61, which draws nothing at rest) has no fixed value to draw with
 *   and is drawn additive, the nearest thing.
 *
 * `honourDisc` off is the escape hatch the panel's toggle offers: every texture with alpha becomes a
 * cutout at half, which sorts perfectly and looks wrong, and is what the viewer drew before the
 * blend modes were read.
 *
 * Wrap and filtering come off `CLAMP` and `TEX1`. A record with no state block (none in the corpus,
 * kept for a damaged one) falls back to the old pixel rules: a ramp clamps, everything else repeats.
 */
function discSpec(flags: TextureFlags | undefined, fog: boolean, honourDisc: boolean, cull: boolean): MaterialSpec {
  const gs = flags?.gs ?? null;
  const graded = flags?.graded ?? false;
  const hasAlpha = flags ? !flags.opaque : false;
  const wrap = gs
    ? { wrapS: gs.wrapS, wrapT: gs.wrapT }
    : { wrapS: graded ? 'clamp' as const : 'repeat' as const, wrapT: graded ? 'clamp' as const : 'repeat' as const };
  const base = {
    cull,
    ...wrap,
    bilinear: gs?.bilinear ?? flags?.bilinear ?? true,
    mipmaps: gs?.mipmaps ?? false,
    fog,
  };
  if (!hasAlpha) return { ...base, blend: 'none', alphaTest: 0 };

  const cutout = (at: number): MaterialSpec => ({ ...base, blend: 'none', alphaTest: at });
  if (!honourDisc) return cutout(flags?.transparent ? 0.5 : 0);
  if (gs?.alphaTest !== null && gs?.alphaTest !== undefined) return cutout(gs.alphaTest);
  if (!graded) return cutout(0.5);
  const blend = gs?.blend ?? 'source';
  if (blend === 'none') return cutout(0.5);
  if (blend === 'destination') return { ...base, blend: 'destination', alphaTest: 0 };
  return { ...base, blend: blend === 'source' ? 'source' : 'additive', alphaTest: 0 };
}

/**
 * The disc's state read into a material (`discSpec` above), and -- when the texture's manifest entry
 * carries one -- the detail pass bound to it (`DetailSpec`). Without a binding the spec is exactly what it
 * always was; with one, only `detail` is added.
 */
export function materialSpec(
  flags: TextureFlags | undefined, fog: boolean, honourDisc: boolean, cull: boolean, detail?: TexDetail,
): MaterialSpec {
  const spec = discSpec(flags, fog, honourDisc, cull);
  const bound = detail === undefined ? null : detailSpec(detail, fog, cull);
  return bound ? { ...spec, detail: bound } : spec;
}

/**
 * The detail pass: the engine's second draw of a surface, over its own geometry, with a second texture.
 *
 * On the console it is VU1's `0x30`/`0x32` (SEMANTICS §7, §11.6; research 13 §4.8): the EE's command
 * list carries a GIF block with the second texture's GS state, the handler kicks it, multiplies the
 * staging `S`,`T` by the block's scale and re-runs the draw handler -- same vertices, same colours, same
 * `PRIM` (so the same fog bit), new texture and blend. What the block holds is compiled from the texture's
 * manifest `detail` record (web/docs/research/72 §6) into each visual's `detail_buff` (`CVisual::Read`,
 * `research/recom/src/gamez/zVisual/vis_main.cpp:276-296`), which the viewer reads the record for.
 */
export interface DetailSpec {
  /** The detail texture, lower-cased as `LoadedMap.textures` keys it. */
  texture: string;
  /** `bmode` as the GS ALPHA it becomes (`DETAIL_BLEND`). */
  blend: 'source' | 'additive';
  /** The manifest's `uv`: the factor on `S`,`T`, the texture repeating. */
  scale: number;
  /** Where the weight reaches zero, in world units from the camera: the root of the manifest's squared `range`. */
  fade: number;
  /** The draw's own `PRIM.FGE`: the handler re-runs the same packet. */
  fog: boolean;
  /** The draw's own cull, for the same reason. */
  cull: boolean;
}

/**
 * `bmode` to the GS `ALPHA` form (docs/research/31 §12 for the notation), read off the disc: every
 * visual's `detail_buff` record holds its pass's `ALPHA_1` selector in the byte at +20, and over the 22
 * maps the 932 single records whose texture's `bmode` is `COLORBLEND` all hold `0x44`, `(Cs - Cd) * As +
 * Cd`, and the 68 `ADDITIVE` ones all hold `0x48`, `(Cs - 0) * As + Cd`. No other `bmode` is on the disc,
 * and none is guessed: a record naming one binds no pass.
 */
export const DETAIL_BLEND: Readonly<Record<string, DetailSpec['blend']>> = { COLORBLEND: 'source', ADDITIVE: 'additive' };

function detailSpec(detail: TexDetail, fog: boolean, cull: boolean): DetailSpec | null {
  const blend = DETAIL_BLEND[detail.bmode];
  if (blend === undefined || !(detail.uv > 0) || !(detail.range > 0)) return null;
  return { texture: detail.name.toLowerCase(), blend, scale: detail.uv, fade: Math.sqrt(detail.range), fog, cull };
}

/**
 * The detail's weight at a distance from the camera: whole at the eye, falling in a straight line to
 * nothing at `fade`. The shader in `world.ts` computes the same per fragment and multiplies the pass's
 * alpha by it, which fades both blends -- `Cs * As * w + ...` either way.
 *
 * The engine does not fade: `CPipe::RenderNode` turns the pass on for a whole visual whose centroid is
 * within range (`zRender/zrndr_pipe.cpp:311-322`, reCOM's reading). The viewer's world is merged across
 * visuals, so no centroid survives to switch on, and a per-fragment switch would draw a hard ring on
 * the ground; the fade over the same range is the brief's reading (web sprint 1, W1.6).
 */
export function detailWeight(distance: number, fade: number): number {
  if (!(fade > 0)) return 0;
  return Math.min(1, Math.max(0, 1 - distance / fade));
}

/** A detail draw's GPU state: the base `DrawState` plus the depth test, which the base leaves at three's default. */
export interface DetailDrawState extends DrawState {
  depthFunc: 'lessEqual';
}

/**
 * How a detail pass goes to the GPU.
 *
 * - **The blend** is its record's (`DETAIL_BLEND`): source alpha or additive, whatever the base does.
 * - **No depth written**: it lies exactly on a surface that has already written it.
 * - **Depth less-or-equal**: the detail textures' own bind packets all set `TEST_1` to `ZTE = 1, ZTST =
 *   GEQUAL` (on all 65 detail records whose texture is on the disc), and the GS's Z grows toward the eye,
 *   so its GEQUAL is GL's less-or-equal. The same vertices through the same transform give the same
 *   depth, so the pass lands on its base and nowhere nearer; and unlike an EQUAL test it does not ask two
 *   programs to agree on the last bit.
 * - **The list** is its base's: three draws the opaque list before the transparent one, so a pass in its
 *   base's list, ordered after it (`detailRenderOrder`), can never be drawn before it.
 */
export function detailDrawState(detail: DetailSpec, base: DrawState): DetailDrawState {
  return { transparent: base.transparent, depthWrite: false, depthFunc: 'lessEqual', factors: FACTORS[detail.blend] };
}

/**
 * Where a detail pass sorts. In the disc order every draw's `renderOrder` is its integer place in the walk
 * (`LoadedMesh.order`), so half a step after its base puts the pass right behind it and ahead of the next
 * draw. In three's order every draw sorts at 0, so half a step puts every pass after every base draw of
 * its list, which is where the depth test needs it; nothing between a base and its pass changes a pixel
 * the pass would touch, the opaque draws having written their depth first.
 */
export function detailRenderOrder(baseOrder: number, discOrder: boolean): number {
  return (discOrder ? baseOrder : 0) + 0.5;
}

/** A blend factor, named the way the GPU names it. */
export type Factor = 'zero' | 'one' | 'srcAlpha' | 'oneMinusSrcAlpha' | 'dstColor';

/** How one draw goes to the GPU: which list it sorts in, whether it writes depth, and the blend. */
export interface DrawState {
  /** three's transparent list, sorted back to front by object centre; otherwise the opaque list. */
  transparent: boolean;
  depthWrite: boolean;
  /** `Cs * src + Cd * dst`, or null for no blending at all. */
  factors: { src: Factor; dst: Factor } | null;
}

const FACTORS: Record<Exclude<Blend, 'none'>, { src: Factor; dst: Factor }> = {
  source: { src: 'srcAlpha', dst: 'oneMinusSrcAlpha' },
  additive: { src: 'srcAlpha', dst: 'one' },
  // `(Cd - 0) * As + Cd = Cd * (As + 1)`: with the shader emitting `As` as the source colour, the GPU's
  // `Cs * Cd + Cd * 1` is the same product. The fix `gs_gl_backend.cpp` made for the game itself.
  destination: { src: 'dstColor', dst: 'one' },
};

/**
 * The draw state for a spec, in one of the two orders the viewer draws in.
 *
 * **The disc's order** (`discOrder`): the engine walked the scene graph and drew each visual as it
 * reached it, blended or not, with depth writes on every draw -- the live GS state is `ZMSK = 0`
 * throughout (research 26 §2, `zbp=118 zpsm=3a zmsk=0 test=5000c abe=1` on the water). So every draw
 * goes in three's opaque list, which sorts by `renderOrder` first, with its place in the walk as that
 * order, and writes depth. A blended surface then lands exactly where the hardware put it, holes and
 * all: a glow drawn before the wall behind it keeps the wall out, as the console did.
 *
 * **three's order**: the reading before this one. A blended draw goes to the transparent list, is sorted
 * back to front by object centre, and writes no depth, which never punches a hole and is never quite
 * where the game drew it.
 */
export function drawState(spec: MaterialSpec, discOrder: boolean): DrawState {
  if (spec.blend === 'none') return { transparent: false, depthWrite: true, factors: null };
  const factors = FACTORS[spec.blend];
  return discOrder
    ? { transparent: false, depthWrite: true, factors }
    : { transparent: true, depthWrite: false, factors };
}
