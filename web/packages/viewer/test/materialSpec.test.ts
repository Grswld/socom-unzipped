import { describe, expect, it } from 'vitest';
import { drawState, materialSpec, type MaterialSpec, type TextureFlags } from '../src/materialSpec';
import type { GsState } from '@s2u/gs';

/**
 * How a texture's disc state becomes a three material. Pure, so the whole table is pinned here
 * without a renderer: the blend, the alpha test, the wrap, the mipmaps and the fog -- and then how
 * that blend is put on a draw in each of the two orders the viewer can draw in.
 */
const gs = (over: Partial<GsState> = {}): GsState => ({
  blend: 'source', alphaTest: null, depthTest: true, bilinear: true, mipmaps: false, levels: 0,
  wrapS: 'repeat', wrapT: 'repeat', ...over,
});
const flags = (over: Partial<TextureFlags> = {}): TextureFlags => ({
  bilinear: true, transparent: false, graded: false, opaque: true, gs: gs(), ...over,
});

describe('materialSpec, honouring the disc', () => {
  it('a solid wall is opaque, culled when its visual says so, repeating, bilinear, fogged', () => {
    expect(materialSpec(flags(), true, true, true)).toEqual({
      blend: 'none', alphaTest: 0, cull: true,
      wrapS: 'repeat', wrapT: 'repeat', bilinear: true, mipmaps: false, fog: true,
    });
  });

  it('a packet whose FGE is clear is not fogged', () => {
    expect(materialSpec(flags(), false, true, true).fog).toBe(false);
  });

  it('the cull is the visual\'s flag, not the texture: a solid texture on a double-sided visual keeps both faces', () => {
    expect(materialSpec(flags(), true, true, false).cull).toBe(false);
    expect(materialSpec(flags({ transparent: true, opaque: false }), true, true, true).cull).toBe(true);
  });

  it('a cutout with the alpha test on the disc tests at the reference the disc gives', () => {
    const spec = materialSpec(flags({ transparent: true, opaque: false, gs: gs({ blend: 'none', alphaTest: 0.5 }) }), true, true, false);
    expect(spec).toMatchObject({ blend: 'none', alphaTest: 0.5, cull: false });
  });

  it('a one-bit texture drawn with a blend and no test is still a cutout: blending a switch is a cutout', () => {
    const spec = materialSpec(flags({ transparent: true, opaque: false }), true, true, false);
    expect(spec).toMatchObject({ blend: 'none', alphaTest: 0.5 });
  });

  it('a graded texture blends with the source-alpha equation', () => {
    const spec = materialSpec(flags({ transparent: true, graded: true, opaque: false }), true, true, false);
    expect(spec).toMatchObject({ blend: 'source', alphaTest: 0 });
  });

  it('a graded texture whose ALPHA is (Cs - 0) * As + Cd adds', () => {
    const spec = materialSpec(flags({ transparent: true, graded: true, opaque: false, gs: gs({ blend: 'additive' }) }), true, true, false);
    expect(spec).toMatchObject({ blend: 'additive' });
  });

  it('the destination brighten keeps its own equation; the EE-animated fixed factor is drawn additive', () => {
    const at = (blend: GsState['blend']): MaterialSpec =>
      materialSpec(flags({ transparent: true, graded: true, opaque: false, gs: gs({ blend }) }), true, true, false);
    expect(at('destination').blend).toBe('destination');
    expect(at('fixed').blend).toBe('additive');
  });

  it('takes the wrap modes and the mipmap request off the disc', () => {
    const spec = materialSpec(flags({ gs: gs({ wrapS: 'clamp', wrapT: 'repeat', mipmaps: true, levels: 1 }) }), true, true, false);
    expect(spec).toMatchObject({ wrapS: 'clamp', wrapT: 'repeat', mipmaps: true });
  });

  it('falls back to the pixel heuristics when a record has no state block', () => {
    const graded = materialSpec(flags({ transparent: true, graded: true, opaque: false, gs: null }), true, true, false);
    expect(graded).toMatchObject({ blend: 'source', wrapS: 'clamp', wrapT: 'clamp', mipmaps: false });
    const wall = materialSpec(flags({ gs: null }), true, true, false);
    expect(wall).toMatchObject({ blend: 'none', wrapS: 'repeat', wrapT: 'repeat' });
  });
});

describe('materialSpec with the disc blend switched off', () => {
  it('punches every texture with alpha out at half, as the viewer always did', () => {
    const spec = materialSpec(flags({ transparent: true, graded: true, opaque: false, gs: gs({ blend: 'additive' }) }), true, false, false);
    expect(spec).toMatchObject({ blend: 'none', alphaTest: 0.5 });
  });
});

/**
 * The draw state: what a blend becomes on the GPU, in the disc's order and in three's.
 *
 * In the disc's order every draw is in one list, sorted by its place in the scene walk, and writes
 * depth -- the GS state the game runs with is `ZMSK = 0` on every draw, blended or not. In three's
 * order a blended draw goes to the transparent list, is sorted back to front and writes no depth.
 */
describe('drawState in the disc order', () => {
  const spec = (blend: MaterialSpec['blend']): MaterialSpec => ({
    blend, alphaTest: 0, cull: false, wrapS: 'repeat', wrapT: 'repeat', bilinear: true, mipmaps: false, fog: true,
  });

  it('an opaque draw blends nothing and writes depth', () => {
    expect(drawState(spec('none'), true)).toEqual({ transparent: false, depthWrite: true, factors: null });
  });

  it('a source-alpha draw is (Cs - Cd) * As + Cd, in the opaque list, writing depth', () => {
    expect(drawState(spec('source'), true)).toEqual({
      transparent: false, depthWrite: true, factors: { src: 'srcAlpha', dst: 'oneMinusSrcAlpha' },
    });
  });

  it('an additive draw is (Cs - 0) * As + Cd', () => {
    expect(drawState(spec('additive'), true).factors).toEqual({ src: 'srcAlpha', dst: 'one' });
  });

  it('the destination brighten is (Cd - 0) * As + Cd: the source carries As and multiplies the destination', () => {
    expect(drawState(spec('destination'), true).factors).toEqual({ src: 'dstColor', dst: 'one' });
  });
});

describe('drawState in three\'s order', () => {
  const spec = (blend: MaterialSpec['blend']): MaterialSpec => ({
    blend, alphaTest: 0, cull: false, wrapS: 'repeat', wrapT: 'repeat', bilinear: true, mipmaps: false, fog: true,
  });

  it('an opaque draw is unchanged', () => {
    expect(drawState(spec('none'), false)).toEqual({ transparent: false, depthWrite: true, factors: null });
  });

  it('a blended draw goes to the transparent list and writes no depth, with the same factors', () => {
    expect(drawState(spec('source'), false)).toEqual({
      transparent: true, depthWrite: false, factors: { src: 'srcAlpha', dst: 'oneMinusSrcAlpha' },
    });
    expect(drawState(spec('additive'), false)).toMatchObject({ transparent: true, depthWrite: false, factors: { src: 'srcAlpha', dst: 'one' } });
    expect(drawState(spec('destination'), false)).toMatchObject({ transparent: true, depthWrite: false, factors: { src: 'dstColor', dst: 'one' } });
  });
});
