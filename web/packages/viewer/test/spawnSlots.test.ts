import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRdr, parseZdb, rdrGet, Zar, zdbMember } from '@s2u/archive';
import { FsAssetSource } from '@s2u/archive/node';
import {
  accountsFor, buildGrid, collisionOwners, fitSlot, parseSceneGraph, parseWorldRoot, probeFloor, spawnsFor, worldCollision,
  type CollisionOwner, type Grid, type GridParams, type SpawnSlot, type WorldPoly,
} from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { syntheticAiMaps } from '../../scene/test/syntheticAiMaps';
import { loadMap, spawnSlotsOf, type LoadedMap } from '../src/loadMap';

/**
 * The disc's spawn slots as the worker reads them (W1.5b): `AIMAPS.MPS` out of the map's archive, its
 * trailer's list placed (`placeSpawnSlots`, web/docs/research/75 §5.5-§7), and `LoadedMap.slots` set
 * beside the other members. The spec's W1.R9 is the oracle: every measured spawn of `spawns.ts` lies at a
 * slot of its own side (the 4 actor rows) or up to 30 units behind one along its facing (the 40 rows that are
 * the orbit camera behind the actor, research 75 §11).
 */

/** A ZDB as 36 §1 lays it out: 0xA0 header, count at 0x98, 0x5C-byte entries, members 2048-aligned. */
function zdbOf(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const dataStart = 2048;
  const out = new Uint8Array(dataStart + members.reduce((n, m) => n + Math.ceil(Math.max(1, m.data.length) / 2048) * 2048, 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0x98, members.length, true);
  dv.setUint32(0x9c, 0x5c, true);
  let at = dataStart;
  members.forEach((m, i) => {
    const o = 0xa0 + i * 0x5c;
    dv.setUint32(o, 0x5c, true);
    for (let k = 0; k < m.name.length; k++) out[o + 4 + k] = m.name.charCodeAt(k);
    dv.setUint32(o + 68, at, true);
    dv.setUint32(o + 72, m.data.length, true);
    out.set(m.data, at);
    at += Math.ceil(Math.max(1, m.data.length) / 2048) * 2048;
  });
  return out;
}

const AIMAPS = 'RUN\\MP\\MP2\\AIMAPS.MPS';

describe('spawnSlotsOf: AIMAPS.MPS read in the worker (synthetic)', () => {
  it('reads the member and places its slots, y from the measured spawns', () => {
    const zdb = zdbOf([{ name: 'RUN\\MP\\MP2\\MP2.ZED', data: new Uint8Array(4) }, { name: AIMAPS, data: syntheticAiMaps() }]);
    const notes: string[] = [];
    const slots = spawnSlotsOf(zdb, parseZdb(zdb), { a: [0, 30, 0], b: [0, 40, 0] }, (line) => notes.push(line));
    expect(slots.map((s) => [s.side, s.index, s.position])).toEqual([[1, 0, [135, 40, 215]], [0, 0, [115, 30, 205]]]);
    expect(notes).toEqual([]);
    // Plain numbers: the list crosses the worker's postMessage by structured clone, unchanged.
    expect(structuredClone(slots)).toEqual(slots);
  });

  it('W1.4b: with the probe\'s grid, each slot stands on the floor under its centre', () => {
    const zdb = zdbOf([{ name: AIMAPS, data: syntheticAiMaps() }]);
    // One ground polygon under side 0's slot (115, 205) at y 12; nothing under side 1's (135, 215).
    const poly: WorldPoly = {
      modelName: 'worldmodel', path: 'worldmodel/slab', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
      points: Float32Array.from([110, 12, 200, 120, 12, 200, 120, 12, 210, 110, 12, 210]),
    };
    const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/slab', first: 0, count: 1 }];
    const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 2, cellsZ: 3, originX: 0, originZ: 0 };
    const grid: Grid = buildGrid(params, [], [], [poly], owners);
    const notes: string[] = [];
    const slots = spawnSlotsOf(zdb, parseZdb(zdb), { a: [0, 30, 0], b: [0, 40, 0] }, (line) => notes.push(line), grid);
    expect(slots.map((s) => [s.side, s.position, s.onFloor])).toEqual([[1, [135, 40, 215], false], [0, [115, 12, 205], true]]);
    expect(notes).toEqual([]);
    expect(structuredClone(slots)).toEqual(slots);
  });

  it('a file that will not parse costs one diagnostic and an empty list, not the load', () => {
    const bad = syntheticAiMaps();
    bad[0] = 3;                                              // version 3
    const zdb = zdbOf([{ name: AIMAPS, data: bad }]);
    const notes: string[] = [];
    expect(spawnSlotsOf(zdb, parseZdb(zdb), undefined, (line) => notes.push(line))).toEqual([]);
    expect(notes).toEqual([expect.stringMatching(/^spawn slots: .*version 3/)]);
  });

  it('an archive without AIMAPS.MPS costs the same, and nothing else', () => {
    const zdb = zdbOf([{ name: 'RUN\\MP\\MP2\\MP2.ZED', data: new Uint8Array(4) }]);
    const notes: string[] = [];
    expect(spawnSlotsOf(zdb, parseZdb(zdb), undefined, (line) => notes.push(line))).toEqual([]);
    expect(notes).toEqual([expect.stringMatching(/^spawn slots: .*AIMAPS\.MPS/)]);
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

/** W1.R9's oracle on one map's two measured spawns, against the slots it drew. */
function oracle(name: string, slots: readonly SpawnSlot[]): void {
  const measured = spawnsFor(name)!;
  for (const [side, [x, , z]] of [[0, measured.a], [1, measured.b]] as const) {
    const fit = fitSlot(slots, side, x, z);
    expect(accountsFor(fit), `${name} side ${side} at (${x}, ${z}): ${JSON.stringify(fit && { along: fit.along, perp: fit.perp })}`).toBe(true);
  }
}

describe.skipIf(absent)(`the slots out of loadMap (W1.5b)${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('Frostfire: 24 slots a side on LoadedMap.slots, numbered 0-23, and no diagnostic for them', async () => {
    const map = await load('MP2');
    for (const side of [0, 1] as const) {
      expect(map.slots.filter((s) => s.side === side).map((s) => s.index)).toEqual([...Array(24).keys()]);
    }
    expect(map.diagnostics.filter((d) => d.startsWith('spawn slots'))).toEqual([]);
    for (const s of map.slots) expect(Math.hypot(s.facing[0], s.facing[1])).toBeCloseTo(1, 9);
  });

  it.skipIf(absent)('W1.4b: every Frostfire slot stands on the probe\'s floor; A\'s #0 on the deck at 100, B\'s #1 on 142', async () => {
    const map = await load('MP2');
    expect(map.slots.length).toBe(48);
    expect(map.slots.filter((s) => s.onFloor).length).toBe(48);
    // KNOWN section 1's A and B are the actor's feet at a slot's centre (75 §7): side 0's #0 and side 1's #1 (75 §10).
    const a0 = map.slots.find((s) => s.side === 0 && s.index === 0)!, b1 = map.slots.find((s) => s.side === 1 && s.index === 1)!;
    expect(a0.position[1]).toBeCloseTo(100, 3);
    expect(b1.position[1]).toBeCloseTo(142, 3);
    // Frostfire's floors run from the deck at 100 to B's walkway at 143.1 under the slots (W1.4's table, 75 §3's 100-229).
    for (const s of map.slots) {
      expect(s.position[1], `slot ${s.side}#${s.index}`).toBeGreaterThanOrEqual(100 - 1e-3);
      expect(s.position[1], `slot ${s.side}#${s.index}`).toBeLessThanOrEqual(143.2);
    }
  });

  for (const [stem, name] of [['MP6', 'DESERT GLORY'], ['MP72', 'CROSSROADS']] as const) {
    it.skipIf(absent)(`W1.4b: every ${name} slot stands on the probe's floor`, async () => {
      const map = await load(stem);
      expect(map.slots.filter((s) => s.onFloor).length).toBe(map.slots.length);
    });
  }

  for (const [stem, name] of [['MP2', 'FROSTFIRE'], ['MP6', 'DESERT GLORY'], ['MP72', 'CROSSROADS']] as const) {
    it.skipIf(absent)(`${name}: A and B each lie at, or up to 30 units behind, a slot of their own side (W1.R9)`, async () => {
      const map = await load(stem);
      expect(map.name).toBe(name);
      expect([map.slots.filter((s) => s.side === 0).length, map.slots.filter((s) => s.side === 1).length]).toEqual([24, 24]);
      oracle(map.name, map.slots);
    });
  }
});

/**
 * All 22 maps, from the served copy `npm run extract-maps` writes to the git-ignored `public/maps` (skipped
 * where it is absent, as on CI): the same reader the worker runs, over every measured spawn -- 44 of 44.
 */
const MAPS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps/RUN');
const noMaps = !existsSync(MAPS);

describe.skipIf(noMaps)(`the slots on every map${noMaps ? ' (public/maps absent: run npm run extract-maps)' : ''}`, () => {
  it.skipIf(noMaps)('all 44 measured spawns are accounted for by a slot of their own side, 24 or more a side (W1.R9)', () => {
    const stems = readdirSync(MAPS).filter((f) => /^MP\d+\.ZDB$/i.test(f));
    expect(stems.length).toBe(22);
    let accounted = 0, slotCount = 0, onFloor = 0;
    const overSlot: number[] = [];
    for (const file of stems) {
      const bytes = new Uint8Array(readFileSync(resolve(MAPS, file)));
      const toc = parseZdb(bytes);
      const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
      const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr')!;
      const name = rdrGet(parseRdr(readerm.data(mission)), 'description') as string;
      // The probe's grid as `tools/probe-spawns.ts` builds it: the world's polygons, their nodes, `grid_params`.
      const stem = file.replace(/\.ZDB$/i, '');
      const graph = parseSceneGraph(Zar.parse(zdbMember(bytes, toc, `${stem}_GEO.ZED`)));
      const root = parseWorldRoot(Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`)));
      const grid = buildGrid(root.grid, [], [], worldCollision(graph), collisionOwners(graph));
      const notes: string[] = [];
      const slots = spawnSlotsOf(bytes, toc, spawnsFor(name), (line) => notes.push(line), grid);
      expect(notes, file).toEqual([]);
      for (const side of [0, 1] as const) expect(slots.filter((s) => s.side === side).length, `${file} side ${side}`).toBeGreaterThanOrEqual(24);
      oracle(name, slots);
      accounted += 2;
      slotCount += slots.length;
      onFloor += slots.filter((s) => s.onFloor).length;
      // W1.4b: the slots A and B stood on -- side 0's #0 and side 1's #1 (75 §10). On the two KNOWN section 1 maps
      // the row is the actor's feet at the slot's centre, and the slot's floor is the one the probe finds under the
      // feet. On the other 20 the row is the orbit camera 20-28 behind the slot (75 §11), and its recorded y stands
      // 18.2-26.6 over the slot's floor (median 25.000; measured 2026-09-28) -- where the floor under the camera
      // itself is 12.7-38.1 under it (W1.4): the camera is 25 over the actor's feet, not over its own ground.
      const measured = spawnsFor(name)!;
      for (const [side, index, [x, y, z]] of [[0, 0, measured.a], [1, 1, measured.b]] as const) {
        const slot = slots.find((s) => s.side === side && s.index === index)!;
        const label = `${file} side ${side} #${index}: recorded ${y}, the slot's floor ${slot.position[1]}`;
        if (name === 'FROSTFIRE' || name === 'VIGILANCE') {
          expect(Math.abs(slot.position[1] - probeFloor(grid, x, y, z)!.y), label).toBeLessThanOrEqual(0.1);
        } else {
          overSlot.push(y - slot.position[1]);
          expect(y - slot.position[1], label).toBeGreaterThanOrEqual(18);
          expect(y - slot.position[1], label).toBeLessThanOrEqual(27);
        }
      }
    }
    expect(accounted).toBe(44);
    overSlot.sort((p, q) => p - q);
    console.log(`W1.4b: ${onFloor} of ${slotCount} spawn slots stand on the probe's floor; the 40 camera rows `
      + `${overSlot[0]!.toFixed(3)}-${overSlot.at(-1)!.toFixed(3)} over their slot's floor, median ${overSlot[19]!.toFixed(3)}`);
    expect(slotCount).toBe(1058);
    expect(onFloor).toBe(1058);
  }, 30_000);                                                          // 22 maps read: seconds under a loaded suite
});
