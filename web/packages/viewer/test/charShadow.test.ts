import { describe, expect, it } from 'vitest';
import { Box3, OrthographicCamera, Vector3 } from 'three';
import { fitShadowCamera, shadowFactor, shadowStrength, SHADOW_MAP_SIZE, SHADOW_WEIGHT } from '../src/charShadow';

/** A SEAL-sized box standing on the ground at (100, 0, -50). */
const seal = new Box3(new Vector3(96, 0, -54), new Vector3(104, 18, -46));
/** Frostfire's `ShadowVector` (MP2) and a steep one (MP9). */
const VECTORS: [number, number, number][] = [[-0.811, -0.2, 0.55], [0.408, -0.816, 0.408], [0, -1, 0]];

describe('charShadow: the CRenderMap camera (FUN_0031a180)', () => {
  for (const v of VECTORS) {
    it(`fits the actor's eight corners inside the map with a texel's margin, looking down ${v.join(',')}`, () => {
      const cam = new OrthographicCamera();
      const d = new Vector3(...v).normalize();
      const range = fitShadowCamera(cam, seal, d);
      expect(range).toBeCloseTo(18 * 1.5, 6);                          // 1.5 x the largest side
      expect(cam.position.toArray()).toEqual([100, 9, -50]);             // the bounds' centre
      const forward = new Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
      expect(forward.dot(d)).toBeCloseTo(1, 6);                          // down the shadow vector
      const edge = (SHADOW_MAP_SIZE - 2) / SHADOW_MAP_SIZE;
      let most = 0;
      for (let i = 0; i < 8; i++) {
        const c = new Vector3(i & 1 ? seal.max.x : seal.min.x, i & 2 ? seal.max.y : seal.min.y, i & 4 ? seal.max.z : seal.min.z).project(cam);
        most = Math.max(most, Math.abs(c.x), Math.abs(c.y));
        expect(Math.abs(c.z)).toBeLessThanOrEqual(1);                    // within the depth range
      }
      expect(most).toBeCloseTo(edge, 6);                                 // the outermost corner a texel in from the edge
    });
  }
});

describe('charShadow: the receivers\' darkening (VU1 0x3c)', () => {
  it('scales by ShadowWeight * 255 in the GS\'s 0..128: 0.25 (the world default, no map names one) is ~0.5', () => {
    expect(SHADOW_WEIGHT).toBe(0.25);
    expect(shadowStrength(SHADOW_WEIGHT)).toBeCloseTo(63.75 / 128, 6);
  });
  it('builds a node for the world\'s graphs', () => {
    expect(shadowFactor()).toBeTruthy();
  });
});
