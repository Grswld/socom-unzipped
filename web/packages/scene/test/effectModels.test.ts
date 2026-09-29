import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import type { MeshData } from '@s2u/mesh';
import { fixture } from '../../archive/test/fixtures';
import { boxFill, decodeFitted, EFFECT_MEMBERS, effectLibrary, insideBox } from '../src/index';

/**
 * The effect models (web/docs/research/89 §3): `COMMON/EFFE_GEO.ZED` over `EFFE_MDL.ZED`, the casing and the flashes
 * the zAnim effects name. Fixture-backed where the archives are needed.
 */

const mesh = (positions: number[]): MeshData => ({ positions: Float32Array.from(positions) } as unknown as MeshData);

describe('the position form a chunk is decoded with', () => {
  it('keeps the form whose vertices lie in the node box and fill it; a collapsed point fills nothing', () => {
    const box = [-1, -1, -1, 1, 1, 1];
    expect(insideBox([mesh([0.5, 0.5, 0.5, -1, -1, -1])], box)).toBe(true);
    expect(insideBox([mesh([0, 0, 3])], box)).toBe(false);
    expect(insideBox([], box)).toBe(false);                     // nothing drawn fits nothing
    expect(boxFill([mesh([-1, 0, 0, 1, 0, 0])], box)).toBeCloseTo(1, 9);
    const pick = decodeFitted((form) => [mesh(form === 'scale' ? [900, 0, 0, -900, 0, 0] : [0.9, 0, 0, -0.9, 0, 0])], box);
    expect(pick?.form).toBe('bias');
    // The flashes' trap: the weapon form collapses them to a point, which lies inside the box but fills none of it.
    const collapsed = decodeFitted((form) => [mesh(form === 'scale' ? [0.001, 0, 0, 0.003, 0, 0] : [-1, 0, 0, 1, 0, 0])], box);
    expect(collapsed?.form).toBe('bias');
    expect(decodeFitted(() => [mesh([5, 5, 5])], box)).toBeNull();
  });
});

const MP2 = fixture('RUN/MP2.ZDB');

describe.skipIf(!MP2)('EFFE_GEO + EFFE_MDL on Frostfire', () => {
  const toc = parseZdb(MP2!);
  const lib = effectLibrary(Zar.parse(zdbMember(MP2!, toc, EFFECT_MEMBERS.geo)), Zar.parse(zdbMember(MP2!, toc, EFFECT_MEMBERS.mdl)));

  it('holds the 18 effect models, the casings and the flashes among them', () => {
    expect(lib.names()).toHaveLength(18);
    for (const n of ['bullet_shell_9m', 'bullet_shell_m60', 'bullet_shell_shotgun', 'muzzle_flash_hider', 'muzzle_flash_m4', 'muzzle_flash_break']) {
      expect(lib.names()).toContain(n);
    }
  });

  it('decodes the rifle casing in the weapon form: 0.45 units long, gold, inside its box', () => {
    const shell = lib.decode('bullet_shell_9m');
    expect(shell.diagnostics).toEqual([]);
    expect(shell.textures).toEqual(['shell_gold.tif']);
    const p = shell.parts[0]!.meshes[0]!.positions;
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < p.length; i += 3) { minX = Math.min(minX, p[i]!); maxX = Math.max(maxX, p[i]!); }
    expect(maxX - minX).toBeCloseTo(0.45, 1);
  });

  it('decodes the flash hider in the world form: five additive quads under scale/rotate, 6.16 units along +x', () => {
    const flash = lib.decode('muzzle_flash_hider');
    expect(flash.diagnostics).toEqual([]);
    expect(flash.parts.map((p) => p.node)).toEqual(['g27', 'g28', 'g29', 'g30', 'g31']);
    expect(flash.parts.every((p) => p.path.startsWith('muzzle_flash_hider/scale/rotate/'))).toBe(true);
    expect(flash.textures).toEqual(['effect_muzzle01.tif']);
    for (const part of flash.parts) expect(insideBox(part.meshes, [0, -2.1, -2.1, 6.2, 2.1, 2.1])).toBe(true);
    // And the quads reach along the barrel: 6.16 units, not the weapon form's collapsed point.
    const star = flash.parts.find((p) => p.node === 'g28')!;
    expect(boxFill(star.meshes, [0, -2.03, 0, 6.16, 0, 2.03])).toBeGreaterThan(0.9);
  });

  it('leaves only the tracers undrawn (line strips)', () => {
    const bad = lib.names().flatMap((n) => lib.decode(n).diagnostics.map((d) => `${n}: ${d}`));
    expect(bad.every((d) => /^tracer/.test(d) && /line strip/.test(d))).toBe(true);
  });
});
