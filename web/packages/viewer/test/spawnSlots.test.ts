import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRdr, parseZdb, rdrGet, Zar, zdbMember } from '@s2u/archive';
import { FsAssetSource } from '@s2u/archive/node';
import { accountsFor, fitSlot, spawnsFor, type SpawnSlot } from '@s2u/scene';
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
    let accounted = 0;
    for (const file of stems) {
      const bytes = new Uint8Array(readFileSync(resolve(MAPS, file)));
      const toc = parseZdb(bytes);
      const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
      const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr')!;
      const name = rdrGet(parseRdr(readerm.data(mission)), 'description') as string;
      const notes: string[] = [];
      const slots = spawnSlotsOf(bytes, toc, spawnsFor(name), (line) => notes.push(line));
      expect(notes, file).toEqual([]);
      for (const side of [0, 1] as const) expect(slots.filter((s) => s.side === side).length, `${file} side ${side}`).toBeGreaterThanOrEqual(24);
      oracle(name, slots);
      accounted += 2;
    }
    expect(accounted).toBe(44);
  });
});
