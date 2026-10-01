import { describe, expect, it } from 'vitest';
import { type MeshBasicMaterial } from 'three';
import type { Node } from 'three/webgpu';
import { buildGrid, type Grid, type GridParams, type V3, type WorldPoly } from '@s2u/scene';
import { GrenadeThrower } from '../src/grenade';
import { GRENADE_BITMAPS } from '../src/grenadeAssets';
import type { PlaySnapshot } from '../src/walk';
import type { SurfaceShade } from '../src/surfaceShade';

/**
 * The grenade's scorch takes the wall's colour (web/redotcom/docs/research/89 §13): the scorch is a `FUN_003139e0` decal like a
 * bullet mark and a footprint (`FUN_003d0ba0`, the permanent pool), so `FUN_003beca0` puts the world vertices' own
 * colour words in its packet and the GS modulates its texel by them. The scorch draws with the marks' material (texel x
 * vertex colour) and carries the drawn world's colour under it (`./surfaceShade`), asked again while the ground under it
 * is not drawn yet (the props stream in after the map shows), as `./fire`'s marks are.
 */

const snap = (): PlaySnapshot => ({
  feet: [100, 50, 200], yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, airborne: false, crouched: false, stance: 'stand',
  landing: null, jumps: 0,
} as PlaySnapshot);

function floor(): Grid {
  const poly: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/f', region: 0, ditype: 3, material: 7, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-2000, 50, -2000, 2000, 50, -2000, 2000, 50, 2000, -2000, 50, 2000]),
  };
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 500, cellsX: 8, cellsZ: 8, originX: -2000, originZ: -2000 };
  return buildGrid(params, [], [], [poly], [{ modelName: 'worldmodel', path: 'worldmodel/f0', first: 0, count: 1 }]);
}

const run = (g: GrenadeThrower, seconds: number): void => { for (let t = 0; t < seconds; t += 1 / 60) g.update(1 / 60); };

/** A claymore down on the floor and fired: a blast that lay on the ground, so a scorch under it. */
function blast(shade: SurfaceShade | null, bitmap = true): GrenadeThrower {
  const grid = floor();
  const g = new GrenadeThrower({ grid: () => grid, snapshot: snap, view: () => 'third', handPoint: () => [102, 62, 192] });
  const rgba = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) };
  g.setMap(null, { models: [], bitmaps: bitmap ? { [GRENADE_BITMAPS.scorch]: rgba } : {}, defaultMaterial: '' });
  g.setShade(shade);
  g.select('Claymore');
  g.pull();
  run(g, 1.5);
  expect(g.detonateCharges()).toBe(1);
  run(g, 0.1);
  return g;
}

const corners = (g: GrenadeThrower): number[][] => {
  const colour = g.scorchMeshes()[0]!.geometry.getAttribute('color');
  expect(colour.itemSize).toBe(4);
  const out: number[][] = [];
  for (let i = 0; i < colour.count; i++) out.push([colour.getX(i), colour.getY(i), colour.getZ(i), colour.getW(i)].map((v) => +v.toFixed(6)));
  return out;
};

describe('the grenade\'s scorch takes the colour of the ground under it (research 89 §13)', () => {
  it('asks the drawn world under the blast, straight down, and paints every corner with it', () => {
    const asked: { point: V3; normal: V3 }[] = [];
    const g = blast((point, normal) => { asked.push({ point: [...point], normal: [...normal] }); return [0.21, 0.2, 0.19, 1]; });
    expect(g.scorchMeshes()).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.point[0]).toBeCloseTo(102, 6);
    expect(asked[0]!.point[2]).toBeCloseTo(192, 6);
    expect(Math.abs(asked[0]!.point[1] - 50)).toBeLessThan(1);
    expect(asked[0]!.normal).toEqual([0, 1, 0]);
    for (const c of corners(g)) expect(c).toEqual([0.21, 0.2, 0.19, 1]);
    expect(g.stats().scorchShade).toEqual([0.21, 0.2, 0.19, 1]);
  });

  it('draws with the marks\' material: the texel times the vertex colour', () => {
    const g = blast(() => [0.5, 0.5, 0.5, 1]);
    const m = g.scorchMeshes()[0]!.material as MeshBasicMaterial & { colorNode?: Node };
    const types = new Set<string>();
    const seen = new Set<unknown>();
    const walk = (node: Node | null | undefined): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      types.add((node.constructor as { type?: string }).type ?? '');
      for (const child of node.getChildren()) walk(child as Node);
    };
    walk(m.colorNode);
    expect(types.has('VertexColorNode')).toBe(true);
    expect([m.transparent, m.depthWrite, m.polygonOffset]).toEqual([true, false, true]);
    // Without the bitmap, the dark stand-in is modulated too.
    const bare = blast(() => [0.5, 0.5, 0.5, 1], false);
    expect((bare.scorchMeshes()[0]!.material as MeshBasicMaterial).vertexColors).toBe(true);
  });

  it('asks again each frame while the ground under it is not drawn yet; unity without a shade', () => {
    let drawn = false;
    const g = blast(() => (drawn ? [0.3, 0.3, 0.3, 1] : null));
    expect(corners(g)[0]).toEqual([1, 1, 1, 1]);
    expect(g.stats().scorchShade).toBeNull();
    run(g, 2 / 60);
    expect(corners(g)[0]).toEqual([1, 1, 1, 1]);
    drawn = true;
    run(g, 1 / 60);
    for (const c of corners(g)) expect(c).toEqual([0.3, 0.3, 0.3, 1]);
    expect(g.stats().scorchShade).toEqual([0.3, 0.3, 0.3, 1]);

    const unshaded = blast(null);
    for (const c of corners(unshaded)) expect(c).toEqual([1, 1, 1, 1]);
  });
});
