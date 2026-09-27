import { describe, expect, it } from 'vitest';
import { CustomBlending, OneFactor, ZeroFactor } from 'three';
import { drawState, type DrawState, type MaterialSpec } from '../src/materialSpec';
import { blendFactorsFor } from '../src/world';

/**
 * The canvas must stay opaque. The GS's alpha never reached the television, but a canvas with alpha is
 * composited over the page, which no fog touches: a cutout edge, an alpha ramp or a blended edge let
 * `--bg` show through on night maps (bluish in the Modern look, black -- the fog colour -- in PS2's).
 * So every world draw leaves the destination alpha at the clear colour's 1, and keeps its colour blend.
 */
const spec = (blend: MaterialSpec['blend']): MaterialSpec => ({
  blend, alphaTest: 0, cull: true, wrapS: 'repeat', wrapT: 'repeat', bilinear: true, mipmaps: false, fog: true,
});
/** The shadow decal's state, as `apply` builds it in `world.ts`. */
const SHADOW: DrawState['factors'] = { src: 'srcAlpha', dst: 'oneMinusSrcAlpha' };

const every: [string, DrawState['factors']][] = [];
for (const blend of ['none', 'source', 'additive', 'destination'] as const) {
  for (const discOrder of [false, true]) every.push([`${blend}, disc order ${discOrder}`, drawState(spec(blend), discOrder).factors]);
}
every.push(['shadow decal', SHADOW]);

describe('blendFactorsFor: every world draw keeps the canvas opaque', () => {
  it.each(every)('%s writes no alpha: source alpha zero, destination alpha one', (_, factors) => {
    const b = blendFactorsFor(factors);
    expect(b.blending).toBe(CustomBlending);
    expect(b.blendSrcAlpha).toBe(ZeroFactor);
    expect(b.blendDstAlpha).toBe(OneFactor);
  });

  it('an unblended draw copies its colour: One, Zero', () => {
    const b = blendFactorsFor(null);
    expect([b.blendSrc, b.blendDst]).toEqual([OneFactor, ZeroFactor]);
  });

  it('a blended draw keeps the colour factors its draw state asks for', () => {
    const src = blendFactorsFor(drawState(spec('destination'), false).factors);
    const dst = blendFactorsFor(SHADOW);
    expect(src.blendSrc).not.toBe(dst.blendSrc);
    expect(dst.blendDst).not.toBe(OneFactor);
  });
});
