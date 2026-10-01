import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry } from 'three';
import { buildGrid, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { GrenadeThrower } from '../src/grenade';
import { GRENADE_BITMAPS } from '../src/grenadeAssets';
import type { PlaySnapshot } from '../src/walk';
import { markGeometry } from '../src/fire';
import { drawKey, drawsUnder, unwarmed } from '../src/warmSet';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { effectsFromDisc } from '../src/effectData';
import { Effects } from '../src/effects';

/**
 * The warm-ups hold what the frame then draws (research 90 §9): #23, a WebGL2 frame of 92-217 ms 0.1-0.26 s after a
 * grenade's blast, was a program first met there. A draw whose key (the material instance, the kind, the attribute
 * lanes: `./warmSet`) is in the warm set links and builds nothing on its first frame.
 */

describe('warmSet: a draw\'s key', () => {
  it('tells a `color` lane from none, and one material instance from another', () => {
    const m = new MeshBasicMaterial();
    const plain = new Mesh(new PlaneGeometry(1, 1), m);
    const coloured = new Mesh(markGeometry(new PlaneGeometry(1, 1)), m);
    expect(drawKey(plain)).not.toBe(drawKey(coloured));
    expect(drawKey(new Mesh(new PlaneGeometry(2, 2), m))).toBe(drawKey(plain));
    expect(drawKey(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()))).not.toBe(drawKey(plain));
    expect(drawKey(new Group())).toBeNull();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
    expect(drawKey(new Mesh(g, m))).toBe(`Mesh|||${m.uuid}|position:3`);
  });

  it('lists the draws the warm set lacks', () => {
    const m = new MeshBasicMaterial();
    const warm = new Group();
    warm.add(new Mesh(new PlaneGeometry(1, 1), m));
    const drawn: Object3D[] = [new Mesh(new PlaneGeometry(1, 1), m), new Mesh(markGeometry(new PlaneGeometry(1, 1)), m)];
    expect(unwarmed(drawn, [warm])).toEqual([drawn[1]]);
  });
});

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

describe('#23: the grenade\'s warm-up holds what its blast draws', () => {
  it('a claymore\'s blast on the ground (the scorch, with the game\'s zAnim playing the rest) draws nothing unwarmed', () => {
    const grid = floor();
    const g = new GrenadeThrower({ grid: () => grid, snapshot: snap, view: () => 'third', handPoint: () => [102, 62, 192] });
    const rgba = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) };
    g.setMap(null, { models: [], bitmaps: { [GRENADE_BITMAPS.scorch]: rgba }, defaultMaterial: '' });
    g.setEffectPlayer(() => true);                     // the map's zAnim draws the explosion (`./effects`, warmed there)
    // The page's warm-up, with the SEAL's (`warmWalk`): the scorch is not in the scene (the renderer parks it for the
    // compile call), the arc's strip is, hidden until a throw is held.
    const warm = g.warmObjects();
    const inScene = drawsUnder([g.object]);
    expect(warm.filter((o) => inScene.includes(o)).map((o) => o.name)).toEqual(['throwArc']);
    expect(warm.some((o) => o.name === 'scorch (warm-up)' && o.parent === null)).toBe(true);
    expect(g.warmObjects()).toEqual(warm);             // one set a map
    const before = new Set(drawsUnder([g.object]));
    g.select('Claymore');
    g.pull();
    run(g, 1.5);
    expect(g.detonateCharges()).toBe(1);
    run(g, 0.3);
    const added = drawsUnder([g.object]).filter((o) => !before.has(o));
    expect(g.scorchMeshes()).toHaveLength(1);
    expect(added).toContain(g.scorchMeshes()[0]);
    expect(unwarmed(added, warm).map((o) => o.name || o.type)).toEqual([]);
  });
});

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');

describe.skipIf(!MP2)(`the effects' warm-up draws the marks as they are drawn${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('its mark and footprint quads carry the `color` lane a footprint laid on the ground carries', async () => {
    const d = await effectsFromDisc(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB', 'MP2');
    const fx = new Effects(() => 0.5);
    fx.setData(d);
    const warm = fx.warmUp();
    // The marks' quads: the warm group's own meshes of four corners (the models are clones of groups, the particles
    // their own groups).
    const marks = warm.children.filter((o): o is Mesh => o instanceof Mesh && o.geometry.getAttribute('position').count === 4);
    expect(marks.length).toBeGreaterThan(0);
    fx.warmStarted(warm);
    fx.warmDone(warm);
    const before = new Set(drawsUnder([fx.object]));
    const sand = d.materials.indexOf('SAND');
    expect(fx.footfall([0, 0, 0], sand, [0, 1, 0], [0, 0, -1], false)).toBe(true);
    const laid = drawsUnder([fx.object]).filter((o) => !before.has(o));
    expect(laid).toHaveLength(1);
    const lanes = (o: Mesh): string => Object.entries(o.geometry.attributes).map(([n, a]) => `${n}:${a.itemSize}`).sort().join(',');
    for (const m of marks) expect(lanes(m)).toBe(lanes(laid[0] as Mesh));
  });
});
