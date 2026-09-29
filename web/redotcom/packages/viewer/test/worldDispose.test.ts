import { describe, expect, it } from 'vitest';
import { type BufferGeometry, InstancedMesh, Mesh, type Object3D } from 'three';
import { DEFAULT_GRID_PARAMS } from '@s2u/scene';
import { buildWorld } from '../src/world';
import type { LoadedMap, LoadedMesh } from '../src/loadMap';

/**
 * `WorldView.dispose` frees every object `buildWorld` made, revealed or not (the release review's MJ-4): the page
 * compiles the props before their reveal (`ViewerRenderer.prepare`), which uploads their geometry, and three's renderer
 * holds an uploaded geometry until its 'dispose' event -- so a map switched away from while its props stream in kept
 * its unrevealed props, flares and instance buffers for good when `dispose` walked only the group's children.
 */

const part = (texture = 'wall.tif'): LoadedMesh => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs: new Float32Array(6),
  colors: new Float32Array(12).fill(1), normals: null, faceNormals: null, indices: new Uint32Array([0, 1, 2]),
  textureName: texture, fog: true, lit: false, order: 0, orderEnd: 0, cull: true, alternate: false, scroll: null,
});
const at = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const map = (): LoadedMap => ({
  archive: 'SYN', camera: null, path: 'SYN.ZDB', name: 'synthetic', lines: null,
  world: [part('ground.tif'), part('wall.tif')],
  props: [
    // One placement: its own mesh.
    { modelName: 'crate', parts: [part()], matrices: new Float32Array(at(10, 0, 0)), order: 0, alternate: false, facade: 0, lod: null },
    // Two placements, one instanced draw.
    { modelName: 'barrel', parts: [part()], matrices: new Float32Array([...at(20, 0, 0), ...at(30, 0, 0)]), order: 1,
      alternate: false, facade: 0, lod: null },
    // A facade (a lamp's flare): a quad of its own a placement.
    { modelName: 'lamp', parts: [part('flare.tif')], matrices: new Float32Array([...at(40, 0, 0), ...at(50, 0, 0)]), order: 2,
      alternate: false, facade: 1, lod: null },
  ],
  textures: {
    'ground.tif': { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 },
    'wall.tif': { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 },
    'flare.tif': { data: new Uint8ClampedArray(16).fill(128), width: 2, height: 2 },
  },
  textureFlags: {
    'ground.tif': { bilinear: true, transparent: false, graded: false, opaque: true, gs: null },
    'wall.tif': { bilinear: true, transparent: false, graded: false, opaque: true, gs: null },
    'flare.tif': { bilinear: true, transparent: true, graded: true, opaque: false, gs: null },
  },
  metersPerUnit: 0.1, lightRig: null, origin: [0, 0, 0], detail: {}, grid: DEFAULT_GRID_PARAMS,
  collision: { positions: new Float32Array(0), colors: new Uint8Array(0), polygons: 0 },
  slots: [], diagnostics: [], loadMs: 0, timings: { fetch: 0, decode: 0, postedAt: 0 },
} as LoadedMap);

/** Every built object's geometry, each with a count of its 'dispose' events; and each InstancedMesh's. */
function watch(objects: Object3D[]) {
  const geometries = new Map<BufferGeometry, number>();
  const instanced = new Map<InstancedMesh, number>();
  for (const o of objects) {
    if (!(o instanceof Mesh)) continue;
    const g = o.geometry as BufferGeometry;
    if (!geometries.has(g)) {
      geometries.set(g, 0);
      g.addEventListener('dispose', () => { geometries.set(g, geometries.get(g)! + 1); });
    }
    if (o instanceof InstancedMesh) {
      instanced.set(o, 0);
      o.addEventListener('dispose', () => { instanced.set(o, instanced.get(o)! + 1); });
    }
  }
  return { geometries, instanced };
}

describe('WorldView.dispose (MJ-4)', () => {
  it('frees a map none of whose objects was revealed: every geometry once, every InstancedMesh', () => {
    const view = buildWorld(map());
    const { geometries, instanced } = watch([...view.worldObjects, ...view.propObjects]);
    expect(view.group.children).toHaveLength(0);               // nothing revealed: the old walk found nothing to free
    expect(geometries.size).toBeGreaterThanOrEqual(5);         // two world parts, the crate, the barrels, two flare quads
    expect(instanced.size).toBe(1);
    view.dispose();
    expect([...geometries.values()].every((n) => n === 1)).toBe(true);
    expect([...instanced.values()]).toEqual([1]);
    expect(view.group.children).toHaveLength(0);
  });

  it('frees the unrevealed half as well as the revealed half', () => {
    const view = buildWorld(map());
    for (const task of view.revealWorld) task();
    view.revealProps[0]!();                                    // one prop in, the rest still streaming
    const { geometries } = watch([...view.worldObjects, ...view.propObjects]);
    view.dispose();
    expect([...geometries.values()].every((n) => n === 1)).toBe(true);
    expect(view.group.children).toHaveLength(0);
  });
});
