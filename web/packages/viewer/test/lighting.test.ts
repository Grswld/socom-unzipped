import { describe, expect, it } from 'vitest';
import { applyLighting, brightenOf, DEFAULT_LIGHTING, FALLBACK_RIG, type Lightable, type Lighting } from '../src/lighting';
import type { GlobalLighting } from '@s2u/scene';

/**
 * The VU's `lit` (dispatcher command `0x18` -> `0x1440`), with the matrix read as what a live capture
 * says it is -- three light directions in the *columns* of `vf5`-`vf7`:
 *
 *   lit         = C0*max(dot(D0,N),0) + C1*max(dot(D1,N),0) + C2*max(dot(D2,N),0) + ambient
 *   staging + 1 = record2 * lit
 *
 * with the w lane taken from the staging quad rather than from `lit` -- so alpha passes through.
 */

/** A rig whose three lights are the axes, so the arithmetic below can be read off by eye. */
const AXES: GlobalLighting = {
  directions: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  colours: [[0.25, 0.25, 0.25], [1, 1, 1], [0.125, 0.125, 0.125]],
  ambient: [0.5, 0.5, 0.5],
};
/**
 * FIX = 128 would be a brighten of exactly 2x -- and none of the numbers below carry it, because the
 * brighten is the post-process's, applied on the material as a uniform after the texel is clamped,
 * not baked into the vertex. `applyLighting` is the VU's arithmetic and nothing after it.
 */
const LIGHT: Lighting = { rig: AXES, brighten: 128, rigEverywhere: false };

/** One vertex of a part the engine lights: a material colour and a normal. */
const one = (rgba: number[], n: number[] | null, lit = true): Lightable => ({
  colors: Float32Array.from(rgba),
  normals: n ? Float32Array.from(n) : null,
  lit,
});

const lit = (part: Lightable, light: Lighting = LIGHT): number[] => {
  const out = new Float32Array(part.colors.length);
  applyLighting(part, light, out);
  return [...out];
};

describe('applyLighting on a part the engine does not light', () => {
  it('draws the baked material colour and nothing else', () => {
    // No rig term at all: the VU copies record2 into RGBAQ untouched.
    expect(lit(one([0.5, 0.25, 1, 0.75], [0, 1, 0], false))).toEqual([0.5, 0.25, 1, 0.75]);
  });

  it('ignores the normals, which the light command alone would read', () => {
    expect(lit(one([0.5, 0.5, 0.5, 1], [0, -1, 0], false))).toEqual(lit(one([0.5, 0.5, 0.5, 1], [0, 1, 0], false)));
  });

  it('is lit by the rig anyway when the panel asks for the rig everywhere', () => {
    const everywhere: Lighting = { ...LIGHT, rigEverywhere: true };
    expect(lit(one([0.5, 0.5, 0.5, 1], [0, 1, 0], false), everywhere)).toEqual([0.75, 0.75, 0.75, 1]);
  });

  it('the brighten is not applied here: the frame multiplier lives on the material, after the clamp', () => {
    const part = one([0.5, 0.5, 0.5, 1], null, false);
    expect(lit(part, { ...LIGHT, brighten: 0 })).toEqual(lit(part, { ...LIGHT, brighten: 255 }));
    expect(lit(part, { ...LIGHT, brighten: 0 })).toEqual([0.5, 0.5, 0.5, 1]);
  });
});

describe('applyLighting on a part the engine lights', () => {
  it('multiplies the material by ambient plus each light it faces', () => {
    // Straight up: ambient + the y light. 0.5 * (0.5 + 1) = 0.75.
    expect(lit(one([0.5, 0.5, 0.5, 1], [0, 1, 0]))).toEqual([0.75, 0.75, 0.75, 1]);
    // Straight along +x: ambient + the x light. 0.5 * (0.5 + 0.25) = 0.375.
    expect(lit(one([0.5, 0.5, 0.5, 1], [1, 0, 0]))).toEqual([0.375, 0.375, 0.375, 1]);
  });

  it('clamps each light at zero, so a face turned away from one takes nothing from it', () => {
    // -y faces away from the y light: 0.5 * 0.5 = 0.25.
    expect(lit(one([0.5, 0.5, 0.5, 1], [0, -1, 0]))).toEqual([0.25, 0.25, 0.25, 1]);
    // The clamp is per light, not on the sum: a normal facing away from y still collects x.
    expect(lit(one([0.5, 0.5, 0.5, 1], [1, -1, 0]))).toEqual([0.375, 0.375, 0.375, 1]);
  });

  it('is a dot product, so a light at an angle contributes its cosine', () => {
    const half = Math.SQRT1_2;
    // 45 degrees between +x and +y: each of those two lights gives its colour times 0.7071.
    const [r] = lit(one([1, 1, 1, 1], [half, half, 0]));
    expect(r).toBeCloseTo(0.5 + 0.25 * half + 1 * half, 6);
  });

  it('lights each channel by its own light colour, not by a single scalar', () => {
    const tinted: Lighting = {
      rig: { directions: [[0, 1, 0], [0, 0, 0], [0, 0, 0]], colours: [[1, 0.5, 0], [0, 0, 0], [0, 0, 0]], ambient: [0, 0, 0] },
      brighten: 0, rigEverywhere: false,
    };
    expect(lit(one([1, 1, 1, 1], [0, 1, 0]), tinted)).toEqual([1, 0.5, 0, 1]);
  });

  it('does not clamp the product: the GS clamps the modulate, not the vertex', () => {
    // Unity material, straight up: 0.5 + 1 = 1.5, and 1.5 is what comes out.
    expect(lit(one([1, 1, 1, 1], [0, 1, 0]))).toEqual([1.5, 1.5, 1.5, 1]);
  });

  it('passes alpha through untouched, however bright the light', () => {
    for (const a of [0, 0.25, 0.5, 1]) {
      expect(lit(one([0.5, 0.5, 0.5, a], [0, 1, 0]))[3]).toBe(a);
    }
  });

  it('lights each channel by its own material value', () => {
    expect(lit(one([1, 0.5, 0, 1], [0, 1, 0]))).toEqual([1.5, 0.75, 0, 1]);
  });

  it('falls back to half of every light when a merge lost the normals', () => {
    // The mean of max(dot(d, n), 0) over a sphere is a half, so that is what a normal-less part takes.
    const expected = 0.5 * (0.5 + (0.25 + 1 + 0.125) / 2);
    const [r] = lit(one([0.5, 0.5, 0.5, 1], null));
    expect(r).toBeCloseTo(expected, 6);
  });

  it('handles several vertices in one pass, each by its own normal', () => {
    const part = one(
      [0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.25],
      [0, 1, 0, 0, -1, 0],
    );
    expect(lit(part)).toEqual([0.75, 0.75, 0.75, 1, 0.25, 0.25, 0.25, 0.25]);
  });

  it('a zero normal takes the ambient alone, not the flat fallback', () => {
    // The `normals` array exists, so the per-vertex path runs: no light's dot product is positive.
    expect(lit(one([0.5, 0.5, 0.5, 1], [0, 0, 0]))).toEqual([0.25, 0.25, 0.25, 1]);
  });

  it('lights with a stand-in rig, not with nothing, when a map has no GlobalLighting record', () => {
    // The bare model, not the shipped trims: this is about the rig standing in, not about the sliders.
    const none: Lighting = { rig: null, brighten: 0, rigEverywhere: false };
    const up = lit(one([0.5, 0.5, 0.5, 1], [0, 1, 0]), none)[0]!;
    const down = lit(one([0.5, 0.5, 0.5, 1], [0, -1, 0]), none)[0]!;
    expect(up).toBeCloseTo(0.5 * (FALLBACK_RIG.ambient[0] + FALLBACK_RIG.colours[0]![0]), 6);
    expect(down).toBeCloseTo(0.5 * FALLBACK_RIG.ambient[0], 6);
    expect(up).toBeGreaterThan(down);
  });

  it('the shipped default is the console-measured brighten, FIX 93, and no rig on unflagged parts', () => {
    expect(DEFAULT_LIGHTING).toEqual({ rig: null, brighten: 93, rigEverywhere: false });
    expect(brightenOf(DEFAULT_LIGHTING)).toBeCloseTo(1 + 93 / 128, 6);
  });
});
