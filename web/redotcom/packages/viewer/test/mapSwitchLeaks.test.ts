import { describe, expect, it } from 'vitest';
import { type BufferGeometry, type Material, Mesh, type Object3D, type Texture } from 'three';
import type { EffectData, EffectTexture } from '../src/effectData';
import { Effects } from '../src/effects';
import { GrenadeThrower } from '../src/grenade';
import { GRENADE_BITMAPS } from '../src/grenadeAssets';
import type { PlaySnapshot } from '../src/walk';

/**
 * A map switch frees what the old map's effects and grenades made (the release review's PL-3): the effect models'
 * packet geometries, the warm-up's mark and footprint materials and bitmaps, the grenade's clipped warm-up scorch.
 * Before, each switch left them to the renderer's caches.
 */

const texture = (): EffectTexture => ({ rgba: { data: new Uint8ClampedArray(16).fill(200), width: 2, height: 2 }, gs: null });
const packet = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs: new Float32Array(6), colors: new Float32Array(12).fill(1),
  indices: new Uint16Array([0, 1, 2]), textureName: 'spark.tif', fog: true, cull: false,
});
const data = (): EffectData => ({
  archive: 'SYN', programs: [], absent: [], ambient: [], sceneNodes: [], hitAnims: [], missing: [],
  models: [{ name: 'shell', parts: [{ node: 'shell', path: 'shell/body', world: new Float32Array(16), meshes: [packet(), packet()] }] }],
  textures: [['spark.tif', texture()], ['bullet_mark_stone.tif', texture()], ['footprint_sand.tif', texture()]],
  materials: ['UNKNOWN', 'PARTICLE_SYSTEM', 'STONE', 'SAND'], defaultMaterial: 2,
  // Two rows on one bitmap: one material made, not two.
  marks: [
    { set: 'BULLET', material: 'STONE', texture: 'bullet_mark_stone.tif', minSize: 1, maxSize: 2 },
    { set: 'BULLET', material: 'DIRT', texture: 'bullet_mark_stone.tif', minSize: 1, maxSize: 2 },
  ],
  footprints: [['SAND', 'footprint_sand.tif']],
} as unknown as EffectData);

function counting<T extends { addEventListener(type: 'dispose', f: () => void): void }>(items: Iterable<T>): Map<T, number> {
  const seen = new Map<T, number>();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.set(item, 0);
    item.addEventListener('dispose', () => { seen.set(item, seen.get(item)! + 1); });
  }
  return seen;
}
const meshesUnder = (root: Object3D): Mesh[] => {
  const out: Mesh[] = [];
  root.traverse((o) => { if (o instanceof Mesh) out.push(o); });
  return out;
};

describe('the effects free their map (PL-3)', () => {
  it('setData frees the effect models\' packet geometries', () => {
    const fx = new Effects(() => 0.5);
    fx.setData(data());
    const models = (fx as unknown as { models: Map<string, Object3D> }).models;
    const geometries = counting([...models.values()].flatMap((m) => meshesUnder(m).map((x) => x.geometry as BufferGeometry)));
    expect(geometries.size).toBe(2);
    fx.setData(null);
    expect([...geometries.values()]).toEqual([1, 1]);
  });

  it('the warm-up makes one material a bitmap, kept for the next setData to free; its quad is made once', () => {
    const fx = new Effects(() => 0.5);
    fx.setData(data());
    const g = fx.warmUp();
    const marks = meshesUnder(g).filter((m) => !m.name && m.geometry.getAttribute('color') && m.geometry.getAttribute('position').count === 4);
    expect(marks).toHaveLength(3);                             // the two mark rows and the footprint
    const materials = counting(marks.map((m) => m.material as Material));
    expect(materials.size).toBe(2);                            // one a bitmap: the stone mark's, the sand footprint's
    const textures = counting([...materials.keys()].map((m) => (m as Material & { map: Texture }).map));
    const quads = new Set(marks.map((m) => m.geometry));
    expect(quads.size).toBe(1);
    fx.warmStarted(g);
    fx.warmDone(g);
    const again = fx.warmUp();
    const quad2 = meshesUnder(again).find((m) => m.geometry.getAttribute('color') && m.geometry.getAttribute('position').count === 4)!.geometry;
    expect(quads.has(quad2)).toBe(true);                        // no quad a warm-up
    fx.warmDone(again);
    fx.setData(null);
    expect([...materials.values()]).toEqual([1, 1]);
    expect([...textures.values()]).toEqual([1, 1]);
  });
});

describe('the grenade frees its clipped warm-up scorch at a new map (PL-3)', () => {
  it('setMap disposes both warm-up scorches and the next map makes them again', () => {
    const g = new GrenadeThrower({
      grid: () => null, snapshot: () => null as unknown as PlaySnapshot, view: () => 'third', handPoint: () => [0, 0, 0],
    });
    const rgba = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) };
    g.setMap(null, { models: [], bitmaps: { [GRENADE_BITMAPS.scorch]: rgba }, defaultMaterial: '' });
    const warm = g.warmObjects();
    const clipped = warm.find((o) => o.name === 'scorch clipped (warm-up)') as Mesh;
    const flat = warm.find((o) => o.name === 'scorch (warm-up)') as Mesh;
    const disposed = counting([clipped.geometry as BufferGeometry, flat.geometry as BufferGeometry]);
    g.setMap(null, { models: [], bitmaps: { [GRENADE_BITMAPS.scorch]: rgba }, defaultMaterial: '' });
    expect([...disposed.values()]).toEqual([1, 1]);
    const next = g.warmObjects();
    expect(next.find((o) => o.name === 'scorch clipped (warm-up)')).not.toBe(clipped);
  });
});
