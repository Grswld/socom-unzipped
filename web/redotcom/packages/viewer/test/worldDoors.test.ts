import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Mesh, Vector3 } from 'three';
import { DEFAULT_GRID_PARAMS } from '@s2u/scene';
import { buildWorld } from '../src/world';
import type { LoadedMap, LoadedMesh } from '../src/loadMap';

/**
 * DOORS (web/redotcom/docs/research/92-doors.md): `WorldView.moveNode` draws a door's leaf where its swing has it -- every prop
 * placement at or under the door's node path, a mesh of its own or one instance of a shared draw -- and nothing
 * else; the identity puts them back where the disc has them, so nothing drawn is left behind.
 */

const part = (): LoadedMesh => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs: new Float32Array(6),
  colors: new Float32Array(12).fill(1), normals: null, faceNormals: null, indices: new Uint32Array([0, 1, 2]),
  textureName: 'door.tif', fog: true, lit: false, order: 0, orderEnd: 0, cull: true, alternate: false, scroll: null,
});
const at = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const map = (): LoadedMap => ({
  archive: 'SYN', camera: null, path: 'SYN.ZDB', name: 'synthetic', world: [], lines: null,
  props: [
    // One placement: its own mesh (Frostfire's `door1` leaves, each lit apart).
    { modelName: 'leaf', parts: [part()], matrices: new Float32Array(at(10, 0, 0)), order: 0, alternate: false, facade: 0, lod: null,
      paths: ['worldmodel/door_a/door1=door1/door_slab'] },
    // Three placements, one instanced draw: the second is under door_b, the others are not.
    { modelName: 'slab', parts: [part()], matrices: new Float32Array([...at(0, 0, 0), ...at(20, 0, 0), ...at(40, 0, 0)]), order: 1,
      alternate: false, facade: 0, lod: null, paths: ['worldmodel/crate', 'worldmodel/door_b=slab', 'worldmodel/door_bb'] },
  ],
  textures: { 'door.tif': { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 } },
  textureFlags: { 'door.tif': { bilinear: true, transparent: false, graded: false, opaque: true, gs: null } },
  metersPerUnit: 0.1, lightRig: null, origin: [0, 0, 0], detail: {}, grid: DEFAULT_GRID_PARAMS,
  collision: { positions: new Float32Array(0), colors: new Uint8Array(0), polygons: 0 },
  slots: [], diagnostics: [], loadMs: 0, timings: { fetch: 0, decode: 0, postedAt: 0 },
} as LoadedMap);

describe('WorldView.moveNode (doors)', () => {
  const view = buildWorld(map());
  for (const task of view.revealProps) task();
  const leaf = view.group.children.find((c): c is Mesh => c instanceof Mesh && !(c instanceof InstancedMesh) && c.name === 'leaf')!;
  const slabs = view.group.children.find((c): c is InstancedMesh => c instanceof InstancedMesh && c.name === 'slab')!;
  const instance = (i: number): Vector3 => { const m = new Matrix4(); slabs.getMatrixAt(i, m); return new Vector3().setFromMatrixPosition(m); };
  // A quarter turn about y through the door's hinge at (10, 0, 0), as a column-major delta.
  const turn = new Matrix4().makeTranslation(10, 0, 0).multiply(new Matrix4().makeRotationY(Math.PI / 2)).multiply(new Matrix4().makeTranslation(-10, 0, 0));

  it('moves the placements under the node, own mesh or instance, and only those', () => {
    expect(view.moveNode('worldmodel/door_a', turn.toArray())).toBe(1);
    leaf.updateMatrixWorld();
    // The leaf's far corner (1, 0, 0) in its model, (11, 0, 0) at rest, turns to (10, 0, -1).
    const corner = new Vector3(1, 0, 0).applyMatrix4(leaf.matrixWorld);
    expect(corner.x).toBeCloseTo(10, 5);
    expect(corner.z).toBeCloseTo(-1, 5);
    const shift = new Matrix4().makeTranslation(0, 0, 5).toArray();
    expect(view.moveNode('worldmodel/door_b', shift)).toBe(1);                  // not `door_bb`, not the crate
    expect(instance(0).toArray()).toEqual([0, 0, 0]);
    expect(instance(1).toArray()).toEqual([20, 0, 5]);
    expect(instance(2).toArray()).toEqual([40, 0, 0]);
  });

  it('the identity puts them back where the disc has them', () => {
    const identity = new Matrix4().toArray();
    view.moveNode('worldmodel/door_a', identity);
    view.moveNode('worldmodel/door_b', identity);
    leaf.updateMatrixWorld();
    expect(new Vector3().setFromMatrixPosition(leaf.matrixWorld).toArray()).toEqual([10, 0, 0]);
    expect(instance(1).toArray()).toEqual([20, 0, 0]);
    expect(view.moveNode('worldmodel/nothing', identity)).toBe(0);
  });
});
