import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, spawnsFor, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { loadMap, type LoadedMap } from '../src/loadMap';
import { EYE, openingStand } from '../src/stand';

/**
 * The opening stand (web sprint 1, W1.4b): the fly camera opens at spawn A's (x, z), `EYE` over the floor the
 * ground probe finds there -- not over A's recorded y, which on 20 of the 22 maps is the orbit camera's, 25 over
 * that floor (`spawns.ts`, the spec's W1.R10) -- and over the recorded y only where the probe finds nothing.
 */

/** A flat ground polygon (`m_ditype` 3), world space. */
function slab(minX: number, minZ: number, maxX: number, maxZ: number, y: number): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/slab', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([minX, y, minZ, maxX, y, minZ, maxX, y, maxZ, minX, y, maxZ]),
  };
}

/** A 2 x 2 grid of 100-unit cells from the origin, one owner per polygon. */
function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 2, cellsZ: 2, originX: 0, originZ: 0 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

describe('openingStand: spawn A on the probe\'s floor (W1.4b)', () => {
  // A floor at y 0 over the first cell and a deck at y 42 over part of it (research 24 section 4.2's walkway, scaled).
  const grid = world([slab(0, 0, 100, 100, 0), slab(20, 20, 60, 60, 42)]);

  it('a camera row, 25 over its floor, stands EYE over the floor rather than 45 over it', () => {
    expect(EYE).toBe(20);
    expect(openingStand([80, 25, 80], grid)).toEqual({ position: [80, 0 + EYE, 80], floor: 0 });
    // Under the deck: the deck is 17 over the row, past the origin (y + 5) + 1, so the floor under the row is kept.
    expect(openingStand([40, 25, 40], grid)).toEqual({ position: [40, 0 + EYE, 40], floor: 0 });
  });

  it('a feet row stands EYE over its own floor: the floor and the deck, each from its own height', () => {
    expect(openingStand([80, 0, 80], grid)).toEqual({ position: [80, EYE, 80], floor: 0 });
    expect(openingStand([40, 42, 40], grid)).toEqual({ position: [40, 42 + EYE, 40], floor: 42 });
    expect(openingStand([40, 41, 40], grid)).toEqual({ position: [40, 42 + EYE, 40], floor: 42 });   // 1 under
  });

  it('where the probe finds no floor -- none under (x, z), one over the 20-unit window, or no ground -- the recorded y', () => {
    expect(openingStand([150, 25, 150], grid)).toEqual({ position: [150, 25 + EYE, 150], floor: null });
    expect(openingStand([40, -30, 40], grid)).toEqual({ position: [40, -30 + EYE, 40], floor: null });  // 0 is 30 over
    expect(openingStand([80, 25, 80], undefined)).toEqual({ position: [80, 25 + EYE, 80], floor: null });
  });
});

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const absent = fixture('RUN/MP2.ZDB') === null || fixture('RUN/MP6.ZDB') === null || fixture('RUN/MP72.ZDB') === null;
const loads = new Map<string, Promise<LoadedMap>>();
/** One `loadMap` per fixture for the whole file. Only called inside a test body. */
const load = (stem: string): Promise<LoadedMap> => {
  const known = loads.get(stem);
  if (known) return known;
  const made = loadMap(new FsAssetSource(FIXTURES), `RUN/${stem}.ZDB`);
  loads.set(stem, made);
  return made;
};

describe.skipIf(absent)(`the opening stand out of loadMap (W1.4b)${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  // research 24 section 3, W1.4's table (`tools/probe-spawns.ts`): Frostfire's A is the actor's feet, on the
  // floor at 100.000; Desert Glory's and Crossroads' A are the orbit camera, 25.000 and 25.500 over their floors.
  for (const [stem, name, floor] of [['MP2', 'FROSTFIRE', 100], ['MP6', 'DESERT GLORY', -30], ['MP72', 'CROSSROADS', 42.5]] as const) {
    it.skipIf(absent)(`${name}: A's floor is ${floor}, and the camera opens ${EYE} over it at A's (x, z)`, async () => {
      const map = await load(stem);
      const [x, , z] = spawnsFor(name)!.a;
      expect(map.stand).toBeDefined();
      expect(map.stand!.floor).not.toBeNull();
      expect(map.stand!.floor!).toBeCloseTo(floor, 3);
      expect(map.stand!.position[0]).toBe(x);
      expect(map.stand!.position[1]).toBeCloseTo(floor + EYE, 3);
      expect(map.stand!.position[2]).toBe(z);
    });
  }
});
