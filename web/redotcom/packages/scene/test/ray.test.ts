import { describe, expect, it } from 'vitest';
import { buildGrid, castRay, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '../src/index';

/**
 * `castRay` (web/docs/research/79 §4): the first hull polygon a segment meets, walked through the grid's cells in
 * the order the segment crosses them. Synthetic worlds on a 4 x 4 grid of 100-unit cells from (-200, -200).
 */

const poly = (points: number[], over: Partial<WorldPoly> = {}): WorldPoly => ({
  modelName: 'worldmodel', path: 'worldmodel/p', region: 0, ditype: 3, material: 25, ptcount: points.length / 3,
  cameratype: 0, points: Float32Array.from(points), ...over,
});
/** A vertical wall across z at `x`. */
const wallX = (x: number, z0 = -100, z1 = 100, y0 = 0, y1 = 100, over: Partial<WorldPoly> = {}): WorldPoly =>
  poly([x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0], { ditype: 2, ...over });
/** A floor at height `y`. */
const floor = (minX: number, minZ: number, maxX: number, maxZ: number, y: number): WorldPoly =>
  poly([minX, y, minZ, maxX, y, minZ, maxX, y, maxZ, minX, y, maxZ]);

function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

describe('castRay: the first hull polygon along a segment', () => {
  it('hits a wall straight ahead at its distance, with the hit point and the wall', () => {
    const wall = wallX(50);
    const hit = castRay(world([wall]), [0, 10, 0], [1, 0, 0], 1000);
    expect(hit?.t).toBeCloseTo(50, 9);
    expect(hit?.point[0]).toBeCloseTo(50, 9);
    expect(hit?.point[1]).toBeCloseTo(10, 9);
    expect(hit?.point[2]).toBeCloseTo(0, 9);
    expect(hit?.poly).toBe(wall);
    expect(Math.abs(hit!.normal[0])).toBeCloseTo(1, 9);
  });

  it('takes the direction at any length: t is a distance, not a multiple of the vector', () => {
    expect(castRay(world([wallX(50)]), [0, 10, 0], [4, 0, 0], 1000)?.t).toBeCloseTo(50, 9);
  });

  it('misses behind the origin and past the range', () => {
    const g = world([wallX(50)]);
    expect(castRay(g, [0, 10, 0], [-1, 0, 0], 1000)).toBeNull();
    expect(castRay(g, [0, 10, 0], [1, 0, 0], 49.5)).toBeNull();
  });

  it('takes the nearest of two walls filed in different cells, whichever the grid lists first', () => {
    const near = wallX(-60), far = wallX(150);
    const hit = castRay(world([far, near]), [-190, 10, 0], [1, 0, 0], 1000);
    expect(hit?.poly).toBe(near);
    expect(hit?.t).toBeCloseTo(130, 9);
  });

  it('finds a wall several cells down the segment, filed only in its own cell', () => {
    const hit = castRay(world([wallX(180, 150, 190)]), [-190, 10, 170], [1, 0, 0], 1000);
    expect(hit?.t).toBeCloseTo(370, 9);
  });

  it('walks a diagonal: a wall across the far corner cell only', () => {
    const corner = wallX(150, 120, 180);
    const hit = castRay(world([corner]), [-150, 10, -150], [1, 0, 1], 2000);
    expect(hit?.poly).toBe(corner);
    expect(hit?.point[0]).toBeCloseTo(150, 6);
    expect(hit?.point[2]).toBeCloseTo(150, 6);
    expect(hit?.t).toBeCloseTo(300 * Math.SQRT2, 6);
  });

  it('hits a floor from above: down and forward at 45 degrees from 10 up lands 10 along', () => {
    const hit = castRay(world([floor(-200, -200, 200, 200, 0)]), [0, 10, 0], [1, -1, 0], 1000);
    expect(hit?.point[0]).toBeCloseTo(10, 9);
    expect(hit?.point[1]).toBeCloseTo(0, 9);
    expect(hit?.t).toBeCloseTo(10 * Math.SQRT2, 9);
  });

  it('a vertical ray stays in its one cell and still hits the floor under it', () => {
    expect(castRay(world([floor(-200, -200, 200, 200, 0)]), [30, 50, 30], [0, -1, 0], 1000)?.t).toBeCloseTo(50, 9);
  });

  it('passes a plane outside the polygon: through the gap beside a short wall', () => {
    const g = world([wallX(50, 20, 100)]);
    expect(castRay(g, [0, 10, 0], [1, 0, 0], 1000)).toBeNull();
    expect(castRay(g, [0, 10, 50], [1, 0, 0], 1000)?.t).toBeCloseTo(50, 9);
  });

  it('counts an edge as inside: a ray grazing the wall top hits it', () => {
    expect(castRay(world([wallX(50)]), [0, 100, 0], [1, 0, 0], 1000)?.t).toBeCloseTo(50, 9);
  });

  it('skips a polygon with surface bit 18 set (m_cameratype bit 0), as the probe does', () => {
    const volume = wallX(50, -100, 100, 0, 100, { cameratype: 1 });
    const behind = wallX(80);
    expect(castRay(world([volume, behind]), [0, 10, 0], [1, 0, 0], 1000)?.poly).toBe(behind);
  });

  it('skips a ray lying in the polygon plane', () => {
    expect(castRay(world([floor(-200, -200, 200, 200, 0)]), [-100, 0, 0], [1, 0, 0], 1000)).toBeNull();
  });

  it('starts off the grid and still meets a wall inside it: the cells clamp as the grid files them', () => {
    const hit = castRay(world([wallX(-150)]), [-300, 10, 0], [1, 0, 0], 1000);
    expect(hit?.t).toBeCloseTo(150, 9);
  });

  it('finds a wall that lies off the grid, filed in the edge cell it clamps to', () => {
    const outside = wallX(260, -50, 50);
    const hit = castRay(world([outside]), [0, 10, 0], [1, 0, 0], 1000);
    expect(hit?.poly).toBe(outside);
    expect(hit?.t).toBeCloseTo(260, 9);
  });

  it('honours a caller\'s surface filter', () => {
    const wall = wallX(50);
    expect(castRay(world([wall]), [0, 10, 0], [1, 0, 0], 1000, () => false)).toBeNull();
  });

  it('refuses a zero direction', () => {
    expect(castRay(world([wallX(50)]), [0, 10, 0], [0, 0, 0], 1000)).toBeNull();
  });
});
