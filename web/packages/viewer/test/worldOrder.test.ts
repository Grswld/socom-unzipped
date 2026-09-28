import { describe, expect, it } from 'vitest';
import { InstancedMesh, Mesh, PerspectiveCamera, type Material } from 'three';
import type { GridParams, LodBand } from '@s2u/scene';
import { buildWorld } from '../src/world';
import type { LoadedMap, LoadedMesh } from '../src/loadMap';
import type { TextureFlags } from '../src/materialSpec';

/**
 * The engine order wired into `buildWorld` (W1.2), without a GPU. A 3 x 3 grid of 100-unit cells (cell
 * `x + 3z`, the centre is 4) holding a ground that covers every cell and carries a detail pass, a blended
 * glow in the centre, a wall in the far corner, a crate placed twice (instanced) in the other two corners,
 * and a drop shadow in the centre.
 */
const GRID: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 3, cellsZ: 3, originX: 0, originZ: 0 };

const part = (textureName: string, order: number, cells?: number[]): LoadedMesh => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs: new Float32Array(6),
  colors: new Float32Array(12).fill(1), normals: null, faceNormals: null, indices: new Uint32Array([0, 1, 2]),
  textureName, fog: true, lit: false, order, orderEnd: order, cull: true, alternate: false, scroll: null,
  ...(cells ? { cells } : {}),
});
const rgba = (alpha: number) => ({ data: new Uint8ClampedArray(16).fill(alpha), width: 2, height: 2 });
const solid: TextureFlags = { bilinear: true, transparent: false, graded: false, opaque: true, gs: null };
const ramp: TextureFlags = { bilinear: true, transparent: true, graded: true, opaque: false, gs: null };
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const map = (): LoadedMap => ({
  archive: 'SYN', camera: null, path: 'SYN.ZDB', name: 'synthetic', lines: null, grid: GRID,
  world: [
    part('ground.tif', 0, [0, 1, 2, 3, 4, 5, 6, 7, 8]),
    part('shadow.tif', 5, [4]),
    part('wall.tif', 10, [8]),
    part('glow.tif', 20, [4]),
  ],
  props: [{
    modelName: 'crate', parts: [part('wall.tif', 30)], matrices: new Float32Array([...identity, ...identity]),
    order: 30, alternate: false, facade: 0, lod: null, cells: [[2], [6]],
  }],
  textures: { 'ground.tif': rgba(255), 'wall.tif': rgba(255), 'glow.tif': rgba(128), 'shadow.tif': rgba(128), 'grain.tif': rgba(255) },
  textureFlags: { 'ground.tif': solid, 'wall.tif': solid, 'glow.tif': ramp, 'shadow.tif': ramp, 'grain.tif': solid },
  detail: { 'ground.tif': { name: 'grain.tif', uv: 4, range: 10000, bmode: 'COLORBLEND' } },
  metersPerUnit: 0.1, lightRig: null, origin: [0, 0, 0],
  collision: { positions: new Float32Array(0), colors: new Uint8Array(0), polygons: 0 },
  diagnostics: [], loadMs: 0, timings: { fetch: 0, decode: 0, postedAt: 0 },
});

function setUp() {
  const view = buildWorld(map());
  for (const task of [...view.revealWorld, ...view.revealProps]) task();
  view.setBlendGraded(true);                          // the panel's default: ramps blend as the disc asks
  const meshes = view.group.children.filter((c): c is Mesh => c instanceof Mesh);
  const byName = (name: string): Mesh => meshes.find((m) => m.name === name)!;
  const ground = byName('ground.tif'), shadow = byName('shadow.tif'), wall = byName('wall.tif'), glow = byName('glow.tif');
  const crate = byName('crate');
  const detail = ground.children[0] as Mesh;
  const camera = new PerspectiveCamera();
  const at = (x: number, z: number) => { camera.position.set(x, 15, z); camera.updateMatrixWorld(); view.frame(camera, 0); };
  const orders = () => [ground, glow, wall, crate, shadow].map((m) => m.renderOrder);
  return { view, ground, shadow, wall, glow, crate, detail, at, orders };
}

const state = (m: Mesh) => { const x = m.material as Material; return [x.transparent, x.depthWrite]; };

describe('buildWorld: the engine draw order', () => {
  it('is off by default: three\'s sort, blends in the transparent list with no depth written', () => {
    const { ground, glow, crate, detail, at, orders } = setUp();
    at(150, 150);
    expect(orders()).toEqual([0, 0, 0, 0, 0]);
    expect(crate).toBeInstanceOf(InstancedMesh);
    expect(detail.name).toBe('ground.tif (detail)');
    expect(detail.renderOrder).toBe(0.5);
    expect(state(glow)).toEqual([true, false]);
    expect(state(ground)).toEqual([false, true]);
  });

  it('on, numbers every draw by its place in the walk from the camera\'s cell, the shadow last, and writes depth under blends', () => {
    const { view, glow, shadow, detail, at, orders } = setUp();
    view.setEngineOrder(true);
    at(150, 150);
    // ground (ring 0, walk 0), glow (ring 0, walk 20), wall (ring 2, walk 10), crate (ring 2, walk 30), shadow.
    expect(orders()).toEqual([0, 1, 2, 3, 4]);
    expect(detail.renderOrder).toBe(0.5);                // right behind its base, ahead of the next draw
    expect(state(glow)).toEqual([false, true]);          // research 26 section 2: ZMSK = 0 under the blend
    expect(state(shadow)).toEqual([true, false]);        // the decal pass stays a decal pass
  });

  it('recomputes the order when the camera crosses into another cell, not every frame', () => {
    const { view, wall, at, orders } = setUp();
    view.setEngineOrder(true);
    at(150, 150);
    wall.renderOrder = 99;                              // a frame in the same cell leaves the numbers alone
    at(160, 140);
    expect(wall.renderOrder).toBe(99);
    at(250, 250);                                       // into the wall's corner cell: the wall comes second
    expect(orders()).toEqual([0, 2, 1, 3, 4]);
  });

  it('off again, returns every draw to three\'s sort; on again, reorders at once from the last camera seen', () => {
    const { view, glow, detail, at, orders } = setUp();
    view.setEngineOrder(true);
    at(250, 250);
    view.setEngineOrder(false);
    expect(orders()).toEqual([0, 0, 0, 0, 0]);
    expect(detail.renderOrder).toBe(0.5);
    expect(state(glow)).toEqual([true, false]);
    view.setEngineOrder(true);
    expect(orders()).toEqual([0, 2, 1, 3, 4]);
  });

  it('keeps a fading LOD copy on its blended twin in the transparent list, numbered in the walk like any draw (W1.3)', () => {
    // Frostfire's railings pair at one spot in cell 0 (worldLod.test.ts): both copies fade at 110 units.
    const band = (nearFade: [number, number], farFade: [number, number]): LodBand => ({ nearFade, farFade });
    const lodProp = (modelName: string, order: number, lod: LodBand) => ({
      modelName, parts: [part('wall.tif', order)], matrices: identity.slice(), order, alternate: false, facade: 0, lod, cells: [[0]],
    });
    const view = buildWorld({ ...map(), world: [], props: [lodProp('railhi', 1, band([0, 0], [100, 120])), lodProp('raillo', 2, band([100, 120], [420, 440]))] });
    for (const task of view.revealProps) task();
    const [high, low] = ['railhi (lod)', 'raillo (lod)'].map((n) => view.group.children.find((c) => c.name === n) as Mesh);
    const rest = high!.material;
    view.setEngineOrder(true);
    const camera = new PerspectiveCamera();
    camera.position.set(0, 0, 110);
    camera.updateMatrixWorld();
    view.frame(camera, 0);
    expect(high!.material).not.toBe(rest);
    expect([state(high!), state(low!)]).toEqual([[true, false], [true, false]]);
    expect([high!.renderOrder, low!.renderOrder]).toEqual([0, 1]);
  });
});
