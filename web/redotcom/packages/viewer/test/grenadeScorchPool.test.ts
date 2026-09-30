import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { buildGrid, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { GrenadeThrower, THROWABLES } from '../src/grenade';
import { GRENADE_BITMAPS } from '../src/grenadeAssets';
import type { PlaySnapshot } from '../src/walk';
import { MarkClipper, markClipGeometry, markFrame, PERM_DECAL_TRIANGLES } from '../src/markClip';

/**
 * The grenade's scorch goes to the game's permanent decal pool (web/redotcom/docs/research/89 §5, §14): `decals.rdr`'s
 * `PERM_DECAL_POOL` `BASE 30, OVERFLOW 0` (read into `0x4b5050` at decomp 324141-324148); `FUN_003b3800` (306386-306418)
 * takes one entry per kept world triangle from it through `FUN_003bf1a0`, which refuses once `count >= base + overflow`
 * (313254-313262); the oldest-first trim `FUN_003bf110` runs on the temporary pool only (218207, 219048, 236776), and
 * the permanent pool is emptied only at the level's teardown (`FUN_003bf050`, 218219, 219060). So a map keeps its first
 * 30 scorch triangles -- the scorch that only partly fits partly drawn -- and refuses the rest; nothing is recycled.
 */

type V3 = [number, number, number];

/** A drawn floor at y = 0 over x, z in [-20, 20], two-unit quads: a scorch keeps several triangles. */
function tiledFloor(): Group {
  const positions: number[] = [], colours: number[] = [], index: number[] = [];
  for (let x = -20; x < 20; x += 2) for (let z = -20; z < 20; z += 2) {
    const base = positions.length / 3;
    const corners: V3[] = [[x, 0, z + 2], [x + 2, 0, z + 2], [x + 2, 0, z], [x, 0, z]];
    for (const c of corners) { positions.push(...c); colours.push(0.5, 0.5, 0.5, 1); }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  g.setAttribute('color', new BufferAttribute(Float32Array.from(colours), 4));
  g.setIndex(index);
  const root = new Group();
  root.add(new Mesh(g, new MeshBasicMaterial()));
  root.updateMatrixWorld(true);
  return root;
}

const grid: Grid = (() => {
  const poly: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/f', region: 0, ditype: 3, material: 7, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-2000, 0, -2000, 2000, 0, -2000, 2000, 0, 2000, -2000, 0, 2000]),
  };
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 500, cellsX: 8, cellsZ: 8, originX: -2000, originZ: -2000 };
  return buildGrid(params, [], [], [poly], [{ modelName: 'worldmodel', path: 'worldmodel/f0', first: 0, count: 1 }]);
})();
const snap = (): PlaySnapshot => ({
  feet: [-2, 0, 8], yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, airborne: false, crouched: false, stance: 'stand', landing: null, jumps: 0,
} as PlaySnapshot);
const run = (g: GrenadeThrower, seconds: number): void => { for (let t = 0; t < seconds; t += 1 / 60) g.update(1 / 60); };

function thrower(): GrenadeThrower {
  let seed = 1;
  const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const g = new GrenadeThrower({ grid: () => grid, snapshot: snap, view: () => 'third', handPoint: () => [0, 12, 0] }, THROWABLES, random);
  g.setMap(null, { models: [], bitmaps: { [GRENADE_BITMAPS.scorch]: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) } }, defaultMaterial: '' });
  g.setClip(new MarkClipper(tiledFloor()));
  return g;
}

function blast(g: GrenadeThrower): void {
  g.refill();
  g.select('Claymore');
  g.pull();
  run(g, 1.5);
  expect(g.detonateCharges()).toBe(1);
  run(g, 0.1);
}

describe('the scorch pool is the game\'s permanent decal pool (PERM_DECAL_POOL BASE 30, OVERFLOW 0)', () => {
  it('PERM_DECAL_TRIANGLES is decals.rdr\'s base + overflow', () => {
    expect(PERM_DECAL_TRIANGLES).toBe(30);
  });

  it('a clip keeps no more world triangles than it is allowed (the pool\'s room)', () => {
    const root = tiledFloor();
    const frame = markFrame([1, 0, 1], [0, 1, 0], [0, -1, 0], 3);
    const all = new MarkClipper(root).clip(frame, markClipGeometry(), 0);
    expect(all).toBeGreaterThan(3);
    const target = markClipGeometry();
    expect(new MarkClipper(root).clip(frame, target, 0, 3)).toBe(3);
    expect(target.drawRange.count).toBeGreaterThanOrEqual(9);
    expect(new MarkClipper(root).clip(frame, markClipGeometry(), 0, 0)).toBe(0);
  });

  it('keeps the first 30 triangles of a map, the last scorch partly, and refuses the rest -- none recycled', () => {
    const g = thrower();
    blast(g);
    const first = g.scorchMeshes()[0]!;
    expect(g.stats().scorchTriangles).toBeGreaterThan(0);
    let blasts = 1;
    while (g.stats().scorchTriangles < PERM_DECAL_TRIANGLES && blasts < 40) { blast(g); blasts++; }
    expect(g.stats().scorchTriangles).toBe(PERM_DECAL_TRIANGLES);   // exactly full: the last one partly drawn
    const meshes = g.scorchMeshes().length;
    for (let k = 0; k < 20; k++) blast(g);                            // more than the old 16-mesh recycle
    expect(g.scorchMeshes()).toHaveLength(meshes);                   // refused, not recycled
    expect(g.scorchMeshes()[0]).toBe(first);                         // the first stays
    expect(g.stats().scorchTriangles).toBe(PERM_DECAL_TRIANGLES);
  });

  it('a new map empties the pool (FUN_003bf050 at the level\'s teardown)', () => {
    const g = thrower();
    for (let k = 0; k < 12; k++) blast(g);
    expect(g.stats().scorchTriangles).toBe(PERM_DECAL_TRIANGLES);
    g.setMap(null, { models: [], bitmaps: { [GRENADE_BITMAPS.scorch]: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) } }, defaultMaterial: '' });
    expect(g.stats().scorchTriangles).toBe(0);
    expect(g.scorchMeshes()).toHaveLength(0);
    blast(g);
    expect(g.scorchMeshes()).toHaveLength(1);
  });
});
