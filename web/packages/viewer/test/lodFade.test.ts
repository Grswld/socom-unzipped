import { describe, expect, it } from 'vitest';
import { lodOpacity, type LodBand } from '@s2u/scene';
import { drawState, type MaterialSpec } from '../src/materialSpec';
import { fadeMaterial, fadePhase } from '../src/lodFade';

/**
 * A LOD copy's opacity (`lodOpacity`) reaches the draw as a material: at rest (1) the copy is drawn with
 * its texture's own shared material, exactly as `materialSpec` and `drawState` classify it; only while it
 * fades (0 < opacity < 1) is it drawn with a blended twin, which the engine defers to its alpha pass
 * (reCOM `zRender/zrndr_pipe.cpp:344-364`: in place at 1, `m_alpha.Add` from 1/128). Pure, pinned here.
 */
const spec = (over: Partial<MaterialSpec> = {}): MaterialSpec => ({
  blend: 'none', alphaTest: 0, cull: true, wrapS: 'repeat', wrapT: 'repeat', bilinear: true, mipmaps: false, fog: true, ...over,
});
const OVER = { src: 'srcAlpha', dst: 'oneMinusSrcAlpha' } as const;
const high: LodBand = { nearFade: [0, 0], farFade: [100, 120] };
const low: LodBand = { nearFade: [100, 120], farFade: [420, 440] };

describe('fadePhase', () => {
  it('is hidden at 0, fading strictly between, and at rest at 1', () => {
    expect([0, 1e-9, 0.5, 1 - 1e-9, 1].map(fadePhase)).toEqual(['hidden', 'fading', 'fading', 'fading', 'rest']);
  });

  it('puts both railings copies in their fade at 110 units, and one at rest either side of the crossover', () => {
    const phases = (u: number) => [fadePhase(lodOpacity(high, u * u)), fadePhase(lodOpacity(low, u * u))];
    expect(phases(90)).toEqual(['rest', 'hidden']);
    expect(phases(110)).toEqual(['fading', 'fading']);
    expect(phases(130)).toEqual(['hidden', 'rest']);
  });
});

describe('fadeMaterial: the fading twin of a shared material', () => {
  it('leaves an opaque draw at rest on its opaque path: depth written, no blend, in either order', () => {
    // At rest the world draws with the shared material, whose state is this and nothing else.
    for (const disc of [false, true]) expect(drawState(spec(), disc)).toEqual({ transparent: false, depthWrite: true, factors: null });
  });

  it('blends an opaque draw by its opacity while it fades, after the world and writing no depth', () => {
    expect(fadeMaterial(spec(), false)).toEqual({
      state: { transparent: true, depthWrite: false, factors: OVER }, mode: 'solid', mask: 0,
    });
  });

  it('keeps a cutout\'s test on the texel\'s own alpha, not the faded one, so a fade cannot punch the copy away', () => {
    const fading = fadeMaterial(spec({ alphaTest: 0.5 }), false);
    expect(fading.mask).toBe(0.5);                 // the unfaded alpha must pass the disc's reference
    expect(fading.mode).toBe('solid');             // and the faded alpha is the opacity alone
    expect(fading.state.factors).toEqual(OVER);
  });

  it('keeps a blended draw\'s own equation and scales its alpha', () => {
    expect(fadeMaterial(spec({ blend: 'source' }), false)).toEqual({ state: drawState(spec({ blend: 'source' }), false), mode: 'alpha', mask: 0 });
    expect(fadeMaterial(spec({ blend: 'additive' }), false)).toEqual({ state: drawState(spec({ blend: 'additive' }), false), mode: 'alpha', mask: 0 });
  });

  it('scales the destination brighten through its carrier colour, the only thing that blend reads', () => {
    const fading = fadeMaterial(spec({ blend: 'destination' }), false);
    expect(fading.mode).toBe('carrier');
    expect(fading.state.factors).toEqual({ src: 'dstColor', dst: 'one' });
  });

  it('fades a shadow decal as the decal it is: source alpha over, no depth written', () => {
    expect(fadeMaterial(spec({ alphaTest: 0.5 }), true)).toEqual({
      state: { transparent: true, depthWrite: false, factors: OVER }, mode: 'alpha', mask: 0.5,
    });
  });
});
