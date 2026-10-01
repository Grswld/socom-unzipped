import { describe, expect, it } from 'vitest';
import { Mesh, OneFactor, PerspectiveCamera, SrcAlphaFactor, type Material, type Object3D } from 'three';
import type { MeshBasicNodeMaterial, Node } from 'three/webgpu';
import { DEFAULT_GRID_PARAMS, type LodBand } from '@s2u/scene';
import { buildWorld } from '../src/world';
import type { LoadedMap, LoadedMesh } from '../src/loadMap';

/**
 * Issue #113: a detail pass on a LOD copy follows its base through the fade. A synthetic map with a
 * banded pair at one spot (Frostfire's railings bands, 0..100-120 and 100-120..420-440) drawn with a
 * texture that binds an ADDITIVE detail -- what Frostfire's `railramp_sl8n` does with `floor_oilgrime.tif`
 * (`lodDetailCount.test.ts`).
 * While the base fades it is drawn with its blended twin, in the transparent list, writing no depth; the
 * pass must be too, and at the base's opacity, or it draws first and whole through the half-faded copy.
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
const solid = { bilinear: true, transparent: false, graded: false, opaque: true, gs: null };
const map = (): LoadedMap => ({
  archive: 'SYN', camera: null, path: 'SYN.ZDB', name: 'synthetic', world: [], lines: null,
  // The pair at one spot: alone, the high copy would be the last there and never fade out (`lodIsLast`).
  props: [prop('railhi', HIGH), prop('raillo', LOW)],
  textures: {
    'rail.tif': { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 },
    'rail_det.tif': { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2 },
  },
  textureFlags: { 'rail.tif': solid, 'rail_det.tif': solid },
  detail: { 'rail.tif': { name: 'rail_det.tif', uv: 8, range: 250000, bmode: 'ADDITIVE' } },
  metersPerUnit: 0.1, lightRig: null, origin: [0, 0, 0], grid: DEFAULT_GRID_PARAMS,
  collision: { positions: new Float32Array(0), colors: new Uint8Array(0), polygons: 0 },
  slots: [],
  diagnostics: [], loadMs: 0, timings: { fetch: 0, decode: 0, postedAt: 0 },
} as LoadedMap);

type Updating = Node & { isUniformNode?: boolean; updateType: string; value: number; update(frame: { object: Object3D }): void };
/** The per-object uniforms in a material's colour graph: the fade opacity is the one three refreshes per draw. */
function objectUniforms(material: Material): Updating[] {
  const found: Updating[] = [];
  const seen = new Set<unknown>();
  const walk = (node: Node | null): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const n = node as Updating;
    if (n.isUniformNode && n.updateType === 'object') found.push(n);
    for (const child of node.getChildren()) walk(child as Node);
  };
  walk((material as MeshBasicNodeMaterial).colorNode);
  return found;
}

function setUp(engineOrder: boolean) {
  const view = buildWorld(map());
  view.setEngineOrder(engineOrder);
  for (const task of view.revealProps) task();
  const base = view.group.children.find((c): c is Mesh => c instanceof Mesh && c.name === 'railhi (lod)')!;
  const detail = base.children.find((c): c is Mesh => c instanceof Mesh && c.name === 'railhi (lod) (detail)')!;
  const camera = new PerspectiveCamera();
  const at = (units: number) => { camera.position.set(0, 0, units); camera.updateMatrixWorld(); view.frame(camera, 0); };
  return { base, detail, rest: detail.material as Material, at };
}

describe('buildWorld: a detail pass on a fading LOD copy (issue #113)', () => {
  for (const engineOrder of [true, false]) {
    it(`follows its base into the transparent list, writing no depth, at the base's opacity (engine order ${engineOrder ? 'on' : 'off'})`, () => {
      const { base, detail, at } = setUp(engineOrder);
      at(110);                                              // mid-fade: 23/44 by DrawLOD's ramp
      const twin = base.material as Material;
      expect([twin.transparent, twin.depthWrite]).toEqual([true, false]);
      const pass = detail.material as Material;
      expect([pass.transparent, pass.depthWrite]).toEqual([twin.transparent, twin.depthWrite]);
      expect([pass.blendSrc, pass.blendDst]).toEqual([SrcAlphaFactor, OneFactor]);   // its own ADDITIVE blend
      expect(detail.renderOrder).toBeGreaterThan(base.renderOrder);                    // still after its base
      const opacity = objectUniforms(pass);
      expect(opacity.length).toBe(1);
      opacity[0]!.update({ object: detail });
      expect(opacity[0]!.value).toBeCloseTo(23 / 44, 12);
    });
  }

  it('is back on its own material at rest, whose state the fade never touched', () => {
    const { detail, rest, at } = setUp(true);
    const before = [rest.transparent, rest.depthWrite, rest.blendSrc, rest.blendDst];
    expect(objectUniforms(rest)).toEqual([]);
    at(110);
    at(50);
    expect(detail.material).toBe(rest);
    expect([rest.transparent, rest.depthWrite, rest.blendSrc, rest.blendDst]).toEqual(before);
  });
});
