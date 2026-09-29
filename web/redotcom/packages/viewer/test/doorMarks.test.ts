import { describe, expect, it } from 'vitest';
import { Matrix4, type Mesh } from 'three';
import { buildGrid, DEFAULT_GRID_PARAMS, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { Fire } from '../src/fire';
import { MarkClipper } from '../src/markClip';
import { buildWorld, type WorldView } from '../src/world';
import type { LoadedMap, LoadedMesh } from '../src/loadMap';

/**
 * A mark on a door's leaf swings with the leaf (the release review's PL-5; research 92 §6). The game's decal is the hit
 * visual's own: `FUN_003139e0` (213931-213935) hands each visual of the hit node to `FUN_003b3950`, which clips in the
 * node's frame (306470-306483); `FUN_003b3800` (306396-306416) links each kept triangle into that visual's list
 * (`visual + 0x2c`), and `FUN_003b2ea0` draws the list inside the node's own packet (306133-306135). So a mark made on
 * a leaf moves with it; one on the world stays.
 */

type V3 = [number, number, number];
const LEAF_PATH = 'worldmodel/door_a/door1=door1/door_slab';
/** The leaf: 10 wide, 20 tall, facing +z, in its own frame; placed with its hinge edge at x = -5, at z = -30. */
const leafPart = (): LoadedMesh => ({
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0]), uvs: new Float32Array(8),
  colors: new Float32Array(16).fill(1), normals: null, faceNormals: null, indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  textureName: 'door.tif', fog: true, lit: false, order: 0, orderEnd: 0, cull: true, alternate: false, scroll: null,
});
/** The world's own wall at z = -60, x -100..100, y 0..50. */
const wallPart = (): LoadedMesh => ({
  positions: new Float32Array([-100, 0, -60, 100, 0, -60, 100, 50, -60, -100, 50, -60]), uvs: new Float32Array(8),
  colors: new Float32Array(16).fill(1), normals: null, faceNormals: null, indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  textureName: 'door.tif', fog: true, lit: false, order: 0, orderEnd: 0, cull: true, alternate: false, scroll: null,
});
const map = (): LoadedMap => ({
  archive: 'SYN', camera: null, path: 'SYN.ZDB', name: 'synthetic', lines: null, world: [wallPart()],
  props: [{ modelName: 'door1', parts: [leafPart()], matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 10, -30, 1]),
    order: 0, alternate: false, facade: 0, lod: null, paths: [LEAF_PATH] }],
  textures: { 'door.tif': { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 } },
  textureFlags: { 'door.tif': { bilinear: true, transparent: false, graded: false, opaque: true, gs: null } },
  metersPerUnit: 0.1, lightRig: null, origin: [0, 0, 0], detail: {}, grid: DEFAULT_GRID_PARAMS,
  collision: { positions: new Float32Array(0), colors: new Uint8Array(0), polygons: 0 },
  slots: [], diagnostics: [], loadMs: 0, timings: { fetch: 0, decode: 0, postedAt: 0 },
} as LoadedMap);

const quad = (points: number[]): WorldPoly =>
  ({ modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype: 0, points: Float32Array.from(points) });
/** The hull: the world's wall and the leaf where it stands (`leafZ`). */
function hull(leafZ: number): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const polys = [quad([-100, 0, -60, 100, 0, -60, 100, 50, -60, -100, 50, -60]), quad([-5, 10, leafZ, 5, 10, leafZ, 5, 30, leafZ, -5, 30, leafZ])];
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

function setUp(leafZ = -30) {
  const view: WorldView = buildWorld(map());
  for (const task of [...view.revealWorld, ...view.revealProps]) task();
  view.group.updateMatrixWorld(true);
  const grid = hull(leafZ);
  const look = { dir: [0, 0, -1] as V3 };
  const eye: V3 = [0, 20, 0];
  const fire = new Fire({
    grid: () => grid,
    aim: () => ({ eye, far: [eye[0] + look.dir[0] * 1000, eye[1] + look.dir[1] * 1000, eye[2] + look.dir[2] * 1000] }),
    attachToNode: (path, mark) => view.attachToNode(path, mark),
  }, undefined, undefined, () => 0.5);
  fire.setClip(new MarkClipper(view.group));
  const shoot = (dir: V3): Mesh => {
    look.dir = dir;
    fire.update(1);
    expect(fire.shoot()).not.toBeNull();
    const shown = fire.decalMeshes();
    return shown[shown.length - 1]!;
  };
  return { view, fire, shoot };
}

/** A quarter turn about y through the hinge (-5, *, -30), as a column-major delta. */
const TURN = new Matrix4().makeTranslation(-5, 0, -30).multiply(new Matrix4().makeRotationY(Math.PI / 2)).multiply(new Matrix4().makeTranslation(5, 0, 30));
const worldOf = (mesh: Mesh): number[] => { mesh.updateMatrixWorld(true); return mesh.matrixWorld.toArray(); };
const close = (a: number[], b: number[]): void => { a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5)); };

describe('marks on a door\'s leaf (PL-5, research 92 §6)', () => {
  it('a mark on the leaf follows its swing and comes back with it; a mark on the world wall stays', () => {
    const { view, fire, shoot } = setUp();
    const onLeaf = shoot([0, 0, -1]);
    const onWall = shoot([20 / 60, 0, -1]);                     // past the leaf's edge, onto the wall at z = -60
    expect(fire.state().lastHit!.point[2]).toBeCloseTo(-60, 3);
    expect(fire.marksOnNodes()).toBe(1);
    expect(view.moveNode('worldmodel/door_a', TURN.toArray())).toBe(1);   // the placements moved: the mark rides, uncounted
    close(worldOf(onLeaf), TURN.toArray());
    close(worldOf(onWall), new Matrix4().toArray());
    view.moveNode('worldmodel/door_a', new Matrix4().toArray());
    close(worldOf(onLeaf), new Matrix4().toArray());
  });

  it('a mark made on the leaf while it stands open is carried by the swing since: shut again, it comes with it', () => {
    const slide = new Matrix4().makeTranslation(0, 0, -5);    // the leaf pushed 5 back, the hull with it
    const { view, fire, shoot } = setUp(-35);
    view.moveNode('worldmodel/door_a', slide.toArray());
    view.group.updateMatrixWorld(true);
    const onLeaf = shoot([0, 0, -1]);
    expect(fire.state().lastHit!.point[2]).toBeCloseTo(-35, 3);
    expect(fire.marksOnNodes()).toBe(1);
    close(worldOf(onLeaf), new Matrix4().toArray());          // made where it is: no move yet
    view.moveNode('worldmodel/door_a', new Matrix4().toArray());
    close(worldOf(onLeaf), new Matrix4().makeTranslation(0, 0, 5).toArray());
  });

  it('a new map takes every mark off its node; a recycled mark leaves the node it rode', () => {
    const { view, fire, shoot } = setUp();
    const onLeaf = shoot([0, 0, -1]);
    expect(fire.marksOnNodes()).toBe(1);
    fire.reset();
    expect(fire.marksOnNodes()).toBe(0);
    view.moveNode('worldmodel/door_a', TURN.toArray());
    close(worldOf(onLeaf), new Matrix4().toArray());
  });
});
