import { describe, expect, it } from 'vitest';
import { Mesh, OneFactor, OneMinusSrcAlphaFactor, PerspectiveCamera, SrcAlphaFactor, ZeroFactor, type Material, type Object3D } from 'three';
import type { MeshBasicNodeMaterial, Node } from 'three/webgpu';
import type { LodBand } from '@s2u/scene';
import { buildWorld } from '../src/world';
import type { LoadedMap, LoadedMesh } from '../src/loadMap';

/**
 * The fade wired into `buildWorld`, without a GPU: a synthetic map with Frostfire's railings pair -- a
 * high copy in 0..100-120 and a low one in 100-120..420-440 -- at one spot, both on one solid texture.
 * `frame` puts each copy on its shared material at rest and on a blended twin while it fades.
 */
const HIGH: LodBand = { nearFade: [0, 0], farFade: [100, 120] };
const LOW: LodBand = { nearFade: [100, 120], farFade: [420, 440] };

const part = (): LoadedMesh => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs: new Float32Array(6),
  colors: new Float32Array(12).fill(1), normals: null, faceNormals: null, indices: new Uint32Array([0, 1, 2]),
  textureName: 'rail.tif', fog: true, lit: false, order: 0, orderEnd: 0, cull: true, alternate: false, scroll: null,
});
const prop = (modelName: string, lod: LodBand) => ({
  modelName, parts: [part()], matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  order: 0, alternate: false, facade: 0, lod,
});
const map = (): LoadedMap => ({
  archive: 'SYN', camera: null, path: 'SYN.ZDB', name: 'synthetic', world: [], lines: null,
  props: [prop('railhi', HIGH), prop('raillo', LOW)],
  textures: { 'rail.tif': { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 } },
  textureFlags: { 'rail.tif': { bilinear: true, transparent: false, graded: false, opaque: true, gs: null } },
  metersPerUnit: 0.1, lightRig: null, origin: [0, 0, 0], detail: {},
  collision: { positions: new Float32Array(0), colors: new Uint8Array(0), polygons: 0 },
  diagnostics: [], loadMs: 0, timings: { fetch: 0, decode: 0, postedAt: 0 },
} as LoadedMap);

function setUp() {
  const view = buildWorld(map());
  for (const task of view.revealProps) task();
  const meshes = view.group.children.filter((c): c is Mesh => c instanceof Mesh);
  const high = meshes.find((m) => m.name === 'railhi (lod)')!;
  const low = meshes.find((m) => m.name === 'raillo (lod)')!;
  const camera = new PerspectiveCamera();
  const at = (units: number) => { camera.position.set(0, 0, units); camera.updateMatrixWorld(); view.frame(camera, 0); };
  return { view, high, low, rest: high.material as Material, at };
}

describe('buildWorld: LOD copies fade across their bands', () => {
  it('draws both copies inside the crossover, each with a blended twin, and one copy at rest either side', () => {
    const { high, low, rest, at } = setUp();
    expect(low.material).toBe(rest);                    // one texture, one shared material

    at(90);
    expect([high.visible, low.visible]).toEqual([true, false]);
    expect(high.material).toBe(rest);

    at(110);
    expect([high.visible, low.visible]).toEqual([true, true]);
    const twin = high.material as Material;
    expect(twin).not.toBe(rest);
    expect(low.material).toBe(twin);                    // the twin is per shared material, not per copy
    expect([twin.transparent, twin.depthWrite, twin.blendSrc, twin.blendDst]).toEqual([true, false, SrcAlphaFactor, OneMinusSrcAlphaFactor]);

    at(130);
    expect([high.visible, low.visible]).toEqual([false, true]);
    expect(low.material).toBe(rest);
  });

  it('returns a copy at rest to its shared material, whose opaque state the fade never touched', () => {
    const { high, rest, at } = setUp();
    const before = [rest.transparent, rest.depthWrite, rest.blendSrc, rest.blendDst];
    expect(before).toEqual([false, true, OneFactor, ZeroFactor]);
    at(110);
    at(50);
    expect(high.material).toBe(rest);
    expect([rest.transparent, rest.depthWrite, rest.blendSrc, rest.blendDst]).toEqual(before);
  });

  it('gives each copy its own opacity through the one twin: 23/44 high and 21/44 low at 110 units', () => {
    const { high, low, at } = setUp();
    at(110);
    // The twin's graph holds one uniform refreshed per drawn object (`onObjectUpdate`); drive it as
    // three does before each draw, once per copy.
    type Updating = Node & { isUniformNode?: boolean; updateType: string; value: number; update(frame: { object: Object3D }): void };
    const found: Updating[] = [];
    const seen = new Set<unknown>();
    const walk = (node: Node | null): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      const n = node as Updating;
      if (n.isUniformNode && n.updateType === 'object') found.push(n);
      for (const child of node.getChildren()) walk(child as Node);
    };
    walk((high.material as MeshBasicNodeMaterial).colorNode);
    expect(found.length).toBe(1);
    const opacity = found[0]!;
    opacity.update({ object: high });
    expect(opacity.value).toBeCloseTo(23 / 44, 12);
    opacity.update({ object: low });
    expect(opacity.value).toBeCloseTo(21 / 44, 12);
  });
});
