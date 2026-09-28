import { drawState, type DrawState, type MaterialSpec } from './materialSpec';

/**
 * Where a LOD copy stands at an opacity (`lodOpacity` in `@s2u/scene`):
 *
 * - `hidden` at 0: not drawn at all (`lodVisible` is false there).
 * - `fading` strictly between: drawn with its material's fading twin (`fadeMaterial`).
 * - `rest` at 1: drawn with its texture's shared material, exactly as `materialSpec` and `drawState`
 *   classify it, so nothing about a draw at rest -- its list, its depth write, its blend -- changes.
 *
 * The engine draws the same way: `CPipe::RenderVisual` renders a visual in place when its opacity is 1
 * and otherwise defers it to the alpha pass, `m_alpha.Add`, down to 1/128 (reCOM
 * `zRender/zrndr_pipe.cpp:344-364`). The 1/128 floor is not copied: below it the GS alpha is zero and
 * the draw is invisible anyway, and `lodVisible` is defined as `lodOpacity > 0`.
 */
export type FadePhase = 'hidden' | 'fading' | 'rest';

export function fadePhase(opacity: number): FadePhase {
  return opacity <= 0 ? 'hidden' : opacity >= 1 ? 'rest' : 'fading';
}

/**
 * How the opacity enters a fading draw's colour:
 *
 * - `solid` -- an unblended draw (opaque, or a cutout): its alpha never reached the screen, so the
 *   faded alpha is the opacity alone, blended source-over.
 * - `alpha` -- a draw that already blends by its alpha (source over, additive, a shadow decal): the
 *   alpha is scaled by the opacity.
 * - `carrier` -- the destination brighten, `(Cd - 0) * As + Cd`, whose shader emits `As` as its colour
 *   (`./materialSpec`): the carrier colour is scaled, since the blend reads nothing else.
 */
export type FadeMode = 'solid' | 'alpha' | 'carrier';

/** A fading twin, described without three: what `world.ts` sets on it beside its shared material's own. */
export interface FadeMaterial {
  state: DrawState;
  mode: FadeMode;
  /**
   * The alpha test, on the texel's *unfaded* alpha (a mask, not three's `alphaTest`, which tests the
   * output alpha after the opacity is in it -- a cutout at 0.5 fading through 0.4 would be discarded
   * whole). 0 for none. The GS keeps a texel whose alpha is greater, as `materialSpec` says.
   */
  mask: number;
}

/**
 * The fading twin of a draw with `spec` (a `shadow*.tif` decal when `shadow`). It is blended and in
 * three's transparent list with no depth written, whatever the draw-order mode: the engine draws a fading
 * visual in its alpha pass after the world rather than at its place in the walk (`fadePhase`), and two
 * copies crossing over at the same spot must not cut each other out of the depth buffer.
 */
export function fadeMaterial(spec: MaterialSpec, shadow: boolean): FadeMaterial {
  const mode: FadeMode = spec.blend === 'destination' ? 'carrier' : spec.blend === 'none' && !shadow ? 'solid' : 'alpha';
  const blend = shadow || spec.blend === 'none' ? 'source' : spec.blend;
  return { state: drawState({ ...spec, blend }, false), mode, mask: spec.alphaTest };
}
