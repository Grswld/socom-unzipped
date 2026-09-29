import { describe, expect, it } from 'vitest';
import {
  detailDrawState, detailRenderOrder, detailWeight, drawState, gsMipLevel, gsMipLod, materialSpec, mipChain, type DrawState, type MaterialSpec,
  type TextureFlags,
} from '../src/materialSpec';
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
 * The draw state: what a blend becomes on the GPU, in the engine's order and in three's.
 *
 * In the engine's order every draw is in one list, sorted by its place in the grid walk, and writes
 * depth -- the GS state the game runs with is `ZMSK = 0` on every draw, blended or not. In three's
 * order a blended draw goes to the transparent list, is sorted back to front and writes no depth.
 */
describe('drawState in the engine order', () => {
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

/**
 * The detail pass (W1.6): a second draw of a surface whose texture's manifest entry carries a `detail`
 * record (`readTexManifest`, web/docs/research/72 §6). The record's `bmode` is read as the GS ALPHA its
 * visuals carry in `detail_buff` -- `COLORBLEND` is `0x44` on all 932 records of that mode over the 22
 * maps, `ADDITIVE` `0x48` on all 68 -- its `uv` scales S,T (SEMANTICS §11.6), and its `range` is a squared
 * distance (`m_range_sqd_to_camera`), so the weight reaches zero at its root.
 */
describe('materialSpec with a detail binding', () => {
  const colorblend = { name: 'Ground_Grassy_Det.tif', uv: 4, range: 202500, bmode: 'COLORBLEND' };
  const additive = { name: 'flooroil_detail.tif', uv: 8, range: 250000, bmode: 'ADDITIVE' };

  it('binds the detail texture, its scale and its fade, and keeps every base property as it was', () => {
    const plain = materialSpec(flags(), true, true, true);
    const spec = materialSpec(flags(), true, true, true, colorblend);
    expect(spec).toEqual({
      ...plain,
      detail: { texture: 'ground_grassy_det.tif', blend: 'source', scale: 4, fade: 450, fog: true, cull: true },
    });
  });

  it('ADDITIVE adds; the pass takes the fog bit and the cull of the draw it lies on', () => {
    expect(materialSpec(flags(), false, true, false, additive).detail).toEqual({
      texture: 'flooroil_detail.tif', blend: 'additive', scale: 8, fade: 500, fog: false, cull: false,
    });
  });

  it('a bmode the disc was never seen to use, or a record with no scale or range, binds nothing', () => {
    expect(materialSpec(flags(), true, true, true, { ...colorblend, bmode: 'ADDITIVE_4' }).detail).toBeUndefined();
    expect(materialSpec(flags(), true, true, true, { ...colorblend, uv: 0 }).detail).toBeUndefined();
    expect(materialSpec(flags(), true, true, true, { ...colorblend, range: 0 }).detail).toBeUndefined();
  });

  it('the blend-graded switch does not touch the detail: its blend is the record\'s, not the texture\'s', () => {
    expect(materialSpec(flags(), true, false, true, colorblend).detail?.blend).toBe('source');
  });
});

describe('the detail weight', () => {
  it('is whole at the camera, half at half the fade, and nothing from the fade out', () => {
    expect(detailWeight(0, 500)).toBe(1);
    expect(detailWeight(250, 500)).toBeCloseTo(0.5);
    expect(detailWeight(500, 500)).toBe(0);
    expect(detailWeight(900, 500)).toBe(0);
    for (let d = 0; d < 600; d += 50) expect(detailWeight(d + 50, 500)).toBeLessThanOrEqual(detailWeight(d, 500));
  });
});

describe('the detail draw state', () => {
  const spec = (blend: 'source' | 'additive') => ({ texture: 'd.tif', blend, scale: 4, fade: 450, fog: true, cull: true });
  const opaqueBase: DrawState = { transparent: false, depthWrite: true, factors: null };

  it('blends by its record, writes no depth, and tests depth as the GS did (GEQUAL, read as less-or-equal)', () => {
    expect(detailDrawState(spec('source'), opaqueBase)).toEqual({
      transparent: false, depthWrite: false, depthFunc: 'lessEqual', factors: { src: 'srcAlpha', dst: 'oneMinusSrcAlpha' },
    });
    expect(detailDrawState(spec('additive'), opaqueBase).factors).toEqual({ src: 'srcAlpha', dst: 'one' });
  });

  it('goes in the list its base draw is in, so it can never be drawn before it', () => {
    expect(detailDrawState(spec('source'), { transparent: true, depthWrite: false, factors: null }).transparent).toBe(true);
  });

  it('is ordered right after its base draw in the engine order, and after every base in three\'s', () => {
    expect(detailRenderOrder(512, true)).toBeGreaterThan(512);
    expect(detailRenderOrder(512, true)).toBeLessThan(513);
    expect(detailRenderOrder(512, false)).toBeGreaterThan(0);
    expect(detailRenderOrder(512, false)).toBeLessThan(1);
  });
});

describe('the GS mip level: from the depth, not the screen', () => {
  // TEX1 with LCM = 0: LOD = (log2(1/|Q|) << L) + K, Q = 1/clip.w, clamped to 0..MXL (GS manual, TEX1).
  it('a texture that asks for no mipmaps has no LOD to compute', () => {
    expect(gsMipLod(gs())).toBeNull();
    expect(gsMipLod(null)).toBeNull();
  });
  it('a hand-built state without K falls back to the renderer\'s own chain', () => {
    expect(gsMipLod(gs({ mipmaps: true, levels: 2 }))).toBeNull();
  });
  it('Vigilance\'s rockwall (MXL 2, K -12) stays on its base level across the whole far clip', () => {
    const lod = gsMipLod(gs({ mipmaps: true, levels: 2, lodK: -12, lodL: 0 }))!;
    expect(lod).toEqual({ k: -12, scale: 1, max: 2 });
    for (const depth of [4, 68, 171, 640, 2000]) expect(gsMipLevel(lod, depth)).toBe(0);
    expect(gsMipLevel(lod, 8192)).toBe(1);
    expect(gsMipLevel(lod, 1e6)).toBe(2);                      // clamped at MXL
  });
  it('a K near -6.5 reaches its first level at 90.5 units, and L doubles the slope', () => {
    const lod = gsMipLod(gs({ mipmaps: true, levels: 1, lodK: -6.5, lodL: 0 }))!;
    expect(gsMipLevel(lod, 2 ** 6.5)).toBeCloseTo(0, 6);
    expect(gsMipLevel(lod, 2 ** 7)).toBeCloseTo(0.5, 6);
    const steep = gsMipLod(gs({ mipmaps: true, levels: 3, lodK: -13, lodL: 1 }))!;
    expect(steep.scale).toBe(2);
    expect(gsMipLevel(steep, 2 ** 7)).toBeCloseTo(1, 6);
  });
});

describe('mipChain: the disc\'s levels, then a tail to 1x1', () => {
  const flat = (w: number, h: number, v: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });
  it('keeps the disc levels as they are -- a transparent detail level stays transparent -- and completes the chain', () => {
    const base = flat(8, 4, 200);
    const disc = [{ ...flat(4, 2, 100), data: new Uint8ClampedArray(4 * 2 * 4).map((_, i) => (i % 4 === 3 ? 0 : 100)) }];
    const chain = mipChain(base, disc);
    expect(chain.map((l) => [l.width, l.height])).toEqual([[8, 4], [4, 2], [2, 1], [1, 1]]);
    expect(chain[0]).toBe(base);
    expect(chain[1]).toBe(disc[0]);
    expect([...chain[3]!.data]).toEqual([100, 100, 100, 0]);    // the tail is filtered from the disc level, not the base
  });
  it('a texture with no disc levels is the base and a box-filtered tail', () => {
    expect(mipChain(flat(2, 2, 50), []).map((l) => l.width)).toEqual([2, 1]);
  });
});
