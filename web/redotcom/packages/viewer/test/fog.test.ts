import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import {
  altitudeFactor, applyFog, fogCoefficient, fogForExtent, fogParams, fogUniforms, type FogSettings,
} from '../src/fog';

/**
 * The coefficient is pinned against the game's own arithmetic: `scale = -255/(far-near)`,
 * `offset = 255 - near*scale`, `F = clamp(offset + scale*dist, 0, 255)`. M51's 600/875 are the one
 * pair read off a live VU1 dump, so they are the fixture.
 */
describe('fogCoefficient', () => {
  const NEAR = 600, FAR = 875;

  it('is unfogged at and inside the near plane', () => {
    expect(fogCoefficient(NEAR, NEAR, FAR)).toBeCloseTo(255, 6);
    expect(fogCoefficient(0, NEAR, FAR)).toBe(255);
    expect(fogCoefficient(-50, NEAR, FAR)).toBe(255);      // behind the camera still clamps
  });

  it('is fully fogged at and beyond the far plane', () => {
    expect(fogCoefficient(FAR, NEAR, FAR)).toBeCloseTo(0, 6);
    expect(fogCoefficient(FAR * 10, NEAR, FAR)).toBe(0);
  });

  it('falls linearly between them', () => {
    const mid = fogCoefficient((NEAR + FAR) / 2, NEAR, FAR);
    expect(mid).toBeCloseTo(127.5, 6);
    // Equal steps in distance are equal steps in F.
    const a = fogCoefficient(650, NEAR, FAR);
    const b = fogCoefficient(700, NEAR, FAR);
    const c = fogCoefficient(750, NEAR, FAR);
    expect(a - b).toBeCloseTo(b - c, 6);
  });

  it('matches the EE offset/scale form exactly', () => {
    const scale = -255 / (FAR - NEAR);
    const offset = 255 - NEAR * scale;
    for (const d of [600, 640, 700, 800, 874]) {
      expect(fogCoefficient(d, NEAR, FAR)).toBeCloseTo(offset + scale * d, 9);
    }
    // The documented identity: offset is 255*far/(far-near).
    expect(offset).toBeCloseTo(255 * FAR / (FAR - NEAR), 9);
  });

  it('refuses a zero or inverted span rather than returning the hardware NaN', () => {
    expect(fogCoefficient(100, 500, 500)).toBe(255);
    expect(fogCoefficient(100, 900, 500)).toBe(255);
    expect(Number.isNaN(fogCoefficient(100, 500, 500))).toBe(false);
  });
});

/**
 * The altitude term, `alt = clamp((y - bottom) / (top - bottom), 0, 1)`, multiplies F: below the band
 * everything is fog colour, above it the distance fog alone applies. Blizzard's band is 50 down to 10.
 */
describe('altitudeFactor', () => {
  it('is 1 at and above the top of the band', () => {
    expect(altitudeFactor(50, 50, 10)).toBe(1);
    expect(altitudeFactor(500, 50, 10)).toBe(1);
  });
  it('is 0 at and below the bottom', () => {
    expect(altitudeFactor(10, 50, 10)).toBe(0);
    expect(altitudeFactor(-300, 50, 10)).toBe(0);
  });
  it('is linear through the band', () => {
    expect(altitudeFactor(30, 50, 10)).toBeCloseTo(0.5, 9);
    expect(altitudeFactor(20, 50, 10)).toBeCloseTo(0.25, 9);
  });
});

describe('fogParams', () => {
  const base: FogSettings = { enabled: true, near: 600, far: 875, color: [74, 74, 72], altitude: null };

  it('is the EE scale and offset, with the altitude term parked as the engine parks it when off', () => {
    const p = fogParams(base)!;
    expect(p.scale).toBeCloseTo(-255 / 275, 9);
    expect(p.offset).toBeCloseTo(255 + 600 * 255 / 275, 9);
    // `sub_00293F90`: ref.y = -10000, scl.y = 0.001 -- the term is 1 for anything above y = -9000.
    expect(p.bottom).toBe(-10000);
    expect(p.invSpan).toBe(0.001);
  });

  it('carries a map\'s band as the bottom and the reciprocal span', () => {
    const p = fogParams({ ...base, altitude: { top: 50, bottom: 10 } })!;
    expect(p.bottom).toBe(10);
    expect(p.invSpan).toBeCloseTo(1 / 40, 12);
  });

  it('treats an empty or inverted band as off', () => {
    expect(fogParams({ ...base, altitude: { top: 10, bottom: 10 } })!.invSpan).toBe(0.001);
    expect(fogParams({ ...base, altitude: { top: 5, bottom: 10 } })!.bottom).toBe(-10000);
  });

  it('is null when the fog is off or the span is degenerate', () => {
    expect(fogParams({ ...base, enabled: false })).toBeNull();
    expect(fogParams({ ...base, near: 900, far: 900 })).toBeNull();
  });
});

describe('applyFog', () => {
  const base: FogSettings = { enabled: true, near: 600, far: 875, color: [74, 74, 72], altitude: null };

  it('puts the GS fog on the scene as a fog node with the register colour undecoded', () => {
    const scene = new Scene();
    applyFog(scene, base);
    expect(scene.fogNode).not.toBeNull();
    const u = fogUniforms(scene)!;
    expect(u.scale.value).toBeCloseTo(-255 / 275, 9);
    expect(u.offset.value).toBeCloseTo(255 + 600 * 255 / 275, 9);
    // FOGCOL is a raw register value: 74/255 must survive as 74/255, not be sRGB-decoded.
    expect(u.color.value.r).toBeCloseTo(74 / 255, 6);
    expect(u.color.value.b).toBeCloseTo(72 / 255, 6);
  });

  it('updates in place rather than replacing, so a slider does not churn the scene', () => {
    const scene = new Scene();
    applyFog(scene, base);
    const first = scene.fogNode;
    applyFog(scene, { ...base, far: 1200 });
    expect(scene.fogNode).toBe(first);
    expect(fogUniforms(scene)!.scale.value).toBeCloseTo(-255 / 600, 9);
  });

  it('clears the fog when it is switched off or the span is degenerate', () => {
    const scene = new Scene();
    applyFog(scene, base);
    applyFog(scene, { ...base, enabled: false });
    expect(scene.fogNode).toBe(null);

    applyFog(scene, base);
    applyFog(scene, { ...base, near: 900, far: 900 });
    expect(scene.fogNode).toBe(null);
  });
});

describe('fogForExtent', () => {
  it('scales with the map and keeps near under far', () => {
    for (const d of [500, 1500, 4000]) {
      const { near, far } = fogForExtent(d);
      expect(near).toBeLessThan(far);
      expect(far).toBeLessThanOrEqual(d);
      expect(near).toBeGreaterThan(0);
    }
  });
});
