import { describe, expect, it } from 'vitest';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  aiCellCentre, aiCellIndex, aiCellMarker, aiMapsFromZdb, aiZoneRect, decodeAiLoc, dosDateTime, facingVector,
  accountsFor, fitSlot, fitSpawn, namedPoint, parseAiMaps, placeSpawnSlots, spawnSlots, SPAWNS, type AiMaps,
  type AiSpawnRecord, type SpawnSlot,
} from '../src/index';
import { loc, syntheticAiMaps as synthetic } from './syntheticAiMaps';

/**
 * `AIMAPS.MPS` read to its last byte (web/docs/research/75): a hand-built file first, which is what CI runs,
 * then the three fixture maps, whose numbers the note's tables were read off.
 */

describe('decodeAiLoc (CAiMapLoc, reCOM zAI/zai.h:302-307; 75 §4)', () => {
  it('takes the map from the low 6 bits, then x, then the grid\'s second axis', () => {
    expect(decodeAiLoc(0x01180b00)).toEqual({ map: 0, x: 44, z: 35 });   // Frostfire's PlayerStart
    expect(decodeAiLoc(0x01300282)).toEqual({ map: 2, x: 10, z: 38 });   // a point of Frostfire's Tunnels
    expect(decodeAiLoc(loc(5, 8191, 8191))).toEqual({ map: 5, x: 8191, z: 8191 });
  });
});

describe('parseAiMaps on a hand-built file', () => {
  const ai = parseAiMaps(synthetic());
  const base = ai.maps[0]!, ramps = ai.maps[1]!;

  it('reads the head and each sub-map header (75 §2, §3)', () => {
    expect(ai.version).toBe(2);
    expect(ai.maps.map((m) => m.name)).toEqual(['BaseMap', 'Ramps']);
    expect(base).toMatchObject({ index: 0, id: 0, flags: 0x17, cellsX: 4, cellsZ: 3, cellSize: [10, 10] });
    expect(base.min).toEqual([100, 0, 200]);
    expect(base.max).toEqual([140, 50, 230]);
    expect(ramps).toMatchObject({ index: 1, id: 3, cellsX: 2, cellsZ: 1 });
    expect(dosDateTime(base.stamp)).toBe('2003-09-13 16:41:46');
  });

  it('indexes the stored cells through the row spans, and nothing outside them (75 §4)', () => {
    expect(base.cells.length).toBe(6);
    expect(base.cellsB.length).toBe(6);
    expect(base.rows.map((r) => [r.x0, r.x1, r.first])).toEqual([[1, 3, 0], [0, 4, 2], [4, 4, 6]]);
    expect(aiCellIndex(base, 1, 0)).toBe(0);
    expect(aiCellIndex(base, 2, 1)).toBe(4);
    expect(aiCellIndex(base, 0, 0)).toBe(-1);   // before row 0's span
    expect(aiCellIndex(base, 1, 2)).toBe(-1);   // an empty row
    expect(aiCellIndex(base, 9, 9)).toBe(-1);   // off the grid
    expect(aiCellMarker(base.cells[aiCellIndex(base, 2, 1)]!)).toBe(3);
    expect(aiCellCentre(base, 2, 1)).toEqual([125, 215]);
  });

  it('reads a named point as one cell -- a place, not an extent (75 §5.1)', () => {
    expect(base.points).toEqual([{ name: 'PlayerStart', loc: { map: 0, x: 2, z: 1 }, kind: 2, word: 0x00990208 }]);
    const found = namedPoint(ai, 'startplayer', 'playerstart');
    expect(found?.sub.name).toBe('BaseMap');
    expect(found?.point.name).toBe('PlayerStart');
    expect(namedPoint(ai, 'nowhere')).toBeUndefined();
  });

  it('reads the marker, the link, the zone rectangle and the polyline (75 §5.2-5.4, §5.6)', () => {
    expect(base.markers).toEqual([{ loc: { map: 0, x: 1, z: 0 }, word: 0x608ffff0 }]);
    expect(base.links).toEqual([{ from: { map: 0, x: 3, z: 1 }, to: { map: 1, x: 0, z: 0 }, word: 8 }]);
    expect(base.zones).toEqual([{ name: 'Safety', corner: { map: 0, x: 0, z: 1 }, width: 2, height: 1, kind: 1 }]);
    expect(aiZoneRect(base, base.zones[0]!)).toEqual({ minX: 100, minZ: 210, maxX: 120, maxZ: 220 });
    expect(base.lines).toEqual([{ locs: [{ map: 0, x: 0, z: 0 }, { map: 0, x: 3, z: 2 }], value: 0 }]);
    expect(ramps.points.length + ramps.markers.length + ramps.links.length + ramps.zones.length).toBe(0);
  });

  it('reads the spawn records -- side bit 5, twin bit 4, facing bits 0-2 -- and the trailer\'s copy (75 §5.5, §6)', () => {
    expect(base.spawns.map((s) => [s.side, s.twin, s.facing])).toEqual([[0, false, 0], [0, true, 0], [1, false, 4]]);
    expect(ai.links).toEqual({ words: 1, records: 0 });
    expect(ai.spawns.length).toBe(3);
    expect(new Set(ai.spawns.map((s) => s.flags))).toEqual(new Set(base.spawns.map((s) => s.flags)));
    const slots = spawnSlots(ai, 1);
    expect(slots.length).toBe(1);
    expect(slots[0]).toMatchObject({ x: 135, z: 215, facing: 4, side: 1 });
    expect(spawnSlots(ai).length).toBe(2);        // the twin is not a slot
  });

  it('turns facing k by 45 degrees per step from +z toward -x (75 §7)', () => {
    const r = (v: [number, number]) => v.map((c) => Math.round(c * 1000) / 1000 + 0);
    expect(r(facingVector(0))).toEqual([0, 1]);
    expect(r(facingVector(2))).toEqual([-1, 0]);
    expect(r(facingVector(4))).toEqual([0, -1]);
    expect(r(facingVector(6))).toEqual([1, 0]);
    expect(r(facingVector(1))).toEqual([-0.707, 0.707]);
  });

  it('fits a position ahead of a slot along its facing, and only on the side asked for (75 §7)', () => {
    const fit = fitSpawn(ai, 1, 135, 191)!;
    expect(fit.slot).toMatchObject({ x: 135, z: 215 });
    expect(fit.along).toBeCloseTo(24, 6);
    expect(fit.perp).toBeCloseTo(0, 6);
    expect(fit.distance).toBeCloseTo(24, 6);
    expect(fitSpawn(ai, 0, 135, 191)).toBeUndefined();   // side 0's slot faces +z; this is behind it
    expect(fitSpawn(ai, 0, 115, 205.5)!.distance).toBeCloseTo(0.5, 6);
  });

  it('refuses a wrong version, a short file and a long one', () => {
    const good = synthetic();
    const bad = good.slice();
    bad[0] = 3;
    expect(() => parseAiMaps(bad)).toThrow(/version 3/);
    expect(() => parseAiMaps(good.subarray(0, good.length - 4))).toThrow();
    const long = new Uint8Array(good.length + 4);
    long.set(good);
    expect(() => parseAiMaps(long)).toThrow(/4 bytes past/);
  });
});

describe('placeSpawnSlots: the slots as the viewer draws them (W1.5b, the spec\'s W1.R9)', () => {
  const ai = parseAiMaps(synthetic());
  /** The synthetic file plus records the hand-built one lacks: a second side-0 slot on Ramps, a Ramps twin. */
  const more = (): AiMaps => {
    const base = ai.spawns.find((s) => s.side === 0 && !s.twin)!;
    const extra: AiSpawnRecord[] = [
      { ...base, loc: { map: 1, x: 0, z: 0 }, flags: 0x02, facing: 2 },
      { ...base, loc: { map: 1, x: 1, z: 0 }, flags: 0x12, facing: 2, twin: true },
    ];
    return { ...ai, spawns: [...ai.spawns, ...extra] };
  };
  const round = (v: number[]): number[] => v.map((c) => Math.round(c * 1000) / 1000 + 0);

  it('puts each slot at its cell\'s centre with its side, its facing and its cell; twins are not slots (75 §4, §5.5, §7)', () => {
    const slots = placeSpawnSlots(ai);
    expect(slots.map((s) => [s.side, s.index, s.step, s.loc])).toEqual([
      [1, 0, 4, { map: 0, x: 3, z: 1 }], [0, 0, 0, { map: 0, x: 1, z: 0 }],
    ]);
    expect(slots[0]!.position[0]).toBe(135);
    expect(slots[0]!.position[2]).toBe(215);
    expect(round(slots[0]!.facing)).toEqual([0, -1]);   // step 4 is -z
    expect(slots[1]!.position[0]).toBe(115);
    expect(slots[1]!.position[2]).toBe(205);
    expect(round(slots[1]!.facing)).toEqual([0, 1]);    // step 0 is +z
  });

  it('numbers a side\'s slots from 0 in the trailer\'s order, the other side\'s apart (75 §6)', () => {
    const slots = placeSpawnSlots(more());
    expect(slots.map((s) => [s.side, s.index, s.loc.map])).toEqual([[1, 0, 0], [0, 0, 0], [0, 1, 1]]);
    expect(slots[2]!.position[0]).toBe(115);            // Ramps' cell (0, 0) from (110, 200)
    expect(slots[2]!.position[2]).toBe(205);
    expect(round(slots[2]!.facing)).toEqual([-1, 0]);   // step 2 is -x
  });

  it('takes y from the side\'s measured spawn, held inside the slot\'s sub-map\'s height range (75 §3)', () => {
    // BaseMap spans y 0..50, Ramps 20..20; A was measured at y 30, B at y 80.
    const slots = placeSpawnSlots(more(), { a: [0, 30, 0], b: [0, 80, 0] });
    expect(slots.map((s) => s.position[1])).toEqual([50, 30, 20]);
  });

  it('with no measured spawn, takes the floor of the sub-map\'s height range', () => {
    expect(placeSpawnSlots(more()).map((s) => s.position[1])).toEqual([0, 0, 20]);
  });

  it('refuses a slot whose cell names a sub-map the file does not hold', () => {
    const bad = more();
    bad.spawns.push({ ...bad.spawns[0]!, loc: { map: 5, x: 0, z: 0 } });
    expect(() => placeSpawnSlots(bad)).toThrow(/sub-map 5 of 2/);
  });

  it('fitSlot and accountsFor: W1.R9\'s oracle -- at a slot\'s centre, or up to 30 ahead of it along its facing', () => {
    const slots: SpawnSlot[] = placeSpawnSlots(ai);
    const ahead = fitSlot(slots, 1, 135, 191)!;       // side 1 faces -z from (135, 215): 24 ahead
    expect(ahead.slot.loc).toEqual({ map: 0, x: 3, z: 1 });
    expect(ahead.along).toBeCloseTo(24, 6);
    expect(ahead.perp).toBeCloseTo(0, 6);
    expect(accountsFor(ahead)).toBe(true);
    expect(accountsFor(fitSlot(slots, 0, 115.3, 205.4))).toBe(true);        // at the centre, 0.5 off
    expect(fitSlot(slots, 0, 135, 191)).toBeUndefined();                    // behind side 0's slot
    expect(accountsFor(fitSlot(slots, 1, 135, 180))).toBe(false);           // 35 ahead: past 30
    expect(accountsFor(fitSlot(slots, 1, 142, 195))).toBe(false);           // 20 ahead, 7 across: off the lane
    expect(accountsFor(undefined)).toBe(false);
  });
});

const MP2 = fixture('RUN/MP2.ZDB');
const MP6 = fixture('RUN/MP6.ZDB');
const MP72 = fixture('RUN/MP72.ZDB');

const opened = new Map<string, AiMaps>();
/** Opens a map's AIMAPS.MPS once. Only called from inside a test (vitest collects skipped bodies). */
function open(stem: string): AiMaps {
  const known = opened.get(stem);
  if (known) return known;
  const bytes = fixture(`RUN/${stem}.ZDB`);
  if (!bytes) throw new Error(`${FIXTURES_ABSENT} (RUN/${stem}.ZDB)`);
  const made = aiMapsFromZdb(bytes);
  opened.set(stem, made);
  return made;
}

/** Every loc of every table names a stored cell of the sub-map its map field names (75 §4). */
function everyLocStored(ai: AiMaps): void {
  const stored = (l: { map: number; x: number; z: number }): boolean => {
    const sub = ai.maps[l.map];
    return sub !== undefined && aiCellIndex(sub, l.x, l.z) >= 0;
  };
  for (const s of ai.spawns) expect(stored(s.loc)).toBe(true);
  for (const sub of ai.maps) {
    for (const p of sub.points) expect(stored(p.loc) && p.loc.map === sub.index).toBe(true);
    for (const k of sub.links) {
      expect(stored(k.from) && stored(k.to)).toBe(true);
      // every link is stored twice, once from each end
      const back = ai.maps[k.to.map]!.links.some((b) => b.to.map === k.from.map && b.to.x === k.from.x && b.to.z === k.from.z);
      expect(back).toBe(true);
    }
  }
}

describe('AIMAPS.MPS on the fixture maps (75 §2-§7)', () => {
  it.skipIf(!MP2)('Frostfire: BaseMap, Ramps and Tunnels, 10,890 + 1,617 + 3,315 cells, 572 spawn records', () => {
    const ai = open('MP2');
    expect(ai.maps.map((m) => [m.name, m.cellsX, m.cellsZ, m.cells.length])).toEqual([
      ['BaseMap', 137, 100, 10890], ['Ramps', 110, 99, 1617], ['Tunnels', 110, 99, 3315],
    ]);
    expect(ai.maps.map((m) => m.spawns.length)).toEqual([400, 0, 172]);
    expect(ai.spawns.length).toBe(572);
    expect(ai.maps[0]!.points.map((p) => p.name)).toEqual(['PlayerStart', 'spectator', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);
    expect(spawnSlots(ai, 0).length).toBe(24);
    expect(spawnSlots(ai, 1).length).toBe(24);
    everyLocStored(ai);
  });

  it.skipIf(!MP2)('Frostfire: PlayerStart is one cell, and neither measured spawn is in it (W1.R4, 75 §7)', () => {
    const ai = open('MP2');
    const { sub, point } = namedPoint(ai, 'playerstart', 'startplayer')!;
    expect(point.loc).toEqual({ map: 0, x: 44, z: 35 });
    expect(aiCellMarker(sub.cells[aiCellIndex(sub, 44, 35)]!)).toBe(3);
    const [cx, cz] = aiCellCentre(sub, 44, 35);
    expect(cx).toBeCloseTo(495.73, 2);
    expect(cz).toBeCloseTo(653.57, 2);
    const { a, b } = SPAWNS.FROSTFIRE!;
    for (const [x, , z] of [a, b]) expect(Math.abs(x - cx) > 5 || Math.abs(z - cz) > 5).toBe(true);
  });

  it.skipIf(!MP2)('Frostfire: A and B stand at the centre of a spawn slot of sides 0 and 1 (KNOWN section 1 rows, 75 §7)', () => {
    const ai = open('MP2');
    const { a, b } = SPAWNS.FROSTFIRE!;
    const fa = fitSpawn(ai, 0, a[0], a[2])!, fb = fitSpawn(ai, 1, b[0], b[2])!;
    expect(fa.distance).toBeLessThan(0.6);
    expect(fa.slot.record.loc).toEqual({ map: 0, x: 74, z: 31 });
    expect(fa.slot.record.flags).toBe(0x04);
    expect(fb.distance).toBeLessThan(0.6);
    expect(fb.slot.record.loc).toEqual({ map: 0, x: 48, z: 95 });
    expect(fb.slot.record.flags).toBe(0x22);
    // and each is far from the other side's slots
    expect(Math.min(...spawnSlots(ai, 1).map((s) => Math.hypot(s.x - a[0], s.z - a[2])))).toBeGreaterThan(500);
    expect(Math.min(...spawnSlots(ai, 0).map((s) => Math.hypot(s.x - b[0], s.z - b[2])))).toBeGreaterThan(500);
  });

  it.skipIf(!MP2)('Frostfire: 24 slots a side placed, y from the measured spawns, A and B each accounted for (W1.R9)', () => {
    const measured = SPAWNS.FROSTFIRE!;
    const slots = placeSpawnSlots(open('MP2'), measured);
    for (const side of [0, 1] as const) {
      expect(slots.filter((s) => s.side === side).map((s) => s.index)).toEqual([...Array(24).keys()]);
    }
    // BaseMap spans y 100 to 229.34, so both measured heights stand as they are.
    expect(new Set(slots.filter((s) => s.side === 0).map((s) => s.position[1]))).toEqual(new Set([100]));
    expect(new Set(slots.filter((s) => s.side === 1).map((s) => s.position[1]))).toEqual(new Set([143]));
    const fa = fitSlot(slots, 0, measured.a[0], measured.a[2]), fb = fitSlot(slots, 1, measured.b[0], measured.b[2]);
    expect(accountsFor(fa) && accountsFor(fb)).toBe(true);
    expect(fa!.slot.loc).toEqual({ map: 0, x: 74, z: 31 });
    expect(fb!.slot.loc).toEqual({ map: 0, x: 48, z: 95 });
  });

  it.skipIf(!MP6)('Desert Glory: nine sub-maps, 16 links, a Safety zone 8 x 15 cells, 96 records, A and B 23-24 units ahead of a slot', () => {
    const ai = open('MP6');
    expect(ai.maps.length).toBe(9);
    expect(ai.maps[0]!.name).toBe('Base Map');
    expect(ai.maps.reduce((n, m) => n + m.links.length, 0)).toBe(16);
    expect(ai.links).toEqual({ words: 16, records: 31 });
    expect(ai.maps[0]!.zones).toEqual([{ name: 'Safety', corner: { map: 0, x: 6, z: 76 }, width: 8, height: 15, kind: 1 }]);
    expect(ai.spawns.length).toBe(96);
    const { a, b } = SPAWNS['DESERT GLORY']!;
    const fa = fitSpawn(ai, 0, a[0], a[2])!, fb = fitSpawn(ai, 1, b[0], b[2])!;
    expect(fa.along).toBeCloseTo(23.26, 1);
    expect(Math.abs(fa.perp)).toBeLessThan(3.5);
    expect(fb.along).toBeCloseTo(23.66, 1);
    expect(Math.abs(fb.perp)).toBeLessThan(3.5);
    everyLocStored(ai);
  });

  it.skipIf(!MP72)('Crossroads: ground and floor1, eight named points, 96 records, A and B ahead of a slot', () => {
    const ai = open('MP72');
    expect(ai.maps.map((m) => [m.name, m.cellsX, m.cellsZ])).toEqual([['ground', 212, 212], ['floor1', 729, 627]]);
    expect(ai.maps[0]!.points.length).toBe(8);
    expect(namedPoint(ai, 'startplayer')?.point.loc).toEqual({ map: 0, x: 87, z: 107 });
    expect(ai.spawns.length).toBe(96);
    const { a, b } = SPAWNS.CROSSROADS!;
    const fa = fitSpawn(ai, 0, a[0], a[2])!, fb = fitSpawn(ai, 1, b[0], b[2])!;
    expect(fa.along).toBeCloseTo(23.89, 1);
    expect(fb.along).toBeCloseTo(20.11, 1);
    expect(Math.max(Math.abs(fa.perp), Math.abs(fb.perp))).toBeLessThan(3.5);
    everyLocStored(ai);
  });
});
