import { parseZdb, Reader, zdbMember } from '@s2u/archive';
import type { Grid } from './grid';
import { probeGround, selectFloor, PROBE_LIFT, type Hit } from './probe';
import type { Spawns } from './spawns';

/**
 * `AIMAPS.MPS`, the AI map file each `RUN/MP*.ZDB` carries beside its ZARs. It is not a ZAR
 * (web/docs/research/72 §1, §6) and holds no members: a head, one record per AI sub-map (the grids
 * `aimaps.rdr`'s `map_list` names), and a trailer. Every field read here is laid out in
 * web/docs/research/75, which checks each one on all 22 archives -- 83 sub-maps -- and the reader
 * holds the layout to the one proof a byte format has without its writer: it consumes every file to
 * its last byte, and throws when a count, a size or the file's length disagrees.
 *
 * This sits in `scene`, not `archive`: it is a record format, not a container -- nothing in it is
 * looked up by name -- and what it yields is placed in the world (cell centres, spawn slots), beside
 * `spawns.ts`, the measured table it is checked against. The bytes are read through archive's `Reader`.
 */

/** A cell of one sub-map: `CAiMapLoc` (reCOM zAI/zai.h:302-307), 75 §4. `z` is its `y`, the grid's second axis. */
export interface AiLoc { map: number; x: number; z: number }

/** One row of a sub-map's grid: the stored cells are columns `[x0, x1)`, from cell index `first` (75 §4). */
export interface AiRow { x0: number; x1: number; first: number }

/** A named cell -- `PlayerStart`, `spectator`, `Charlie` ... -- one cell, not an extent (75 §5.1). */
export interface AiNamedPoint { name: string; loc: AiLoc; kind: number; word: number }

/** A 40-byte record with a loc and a flags word; the other 32 bytes are not read (75 §5.2). */
export interface AiMarker { loc: AiLoc; word: number }

/** A link from a cell of this sub-map to a cell of another; each is stored at both ends (75 §5.3). */
export interface AiLink { from: AiLoc; to: AiLoc; word: number }

/** A named rectangle of cells from `corner`, `width` by `height` cells -- the `Safety` zones (75 §5.4). */
export interface AiZone { name: string; corner: AiLoc; width: number; height: number; kind: number }

/** One record of the spawn list: side in bit 5, twin in bit 4, facing in bits 0-2 (75 §5.5). */
export interface AiSpawnRecord {
  loc: AiLoc;
  flags: number;
  side: 0 | 1;
  /** Bit 4. A slot is a record with it clear; a twin sits in a cell next to its slot (75 §5.5). */
  twin: boolean;
  /** 45-degree steps from -z toward +x (`facingVector`), 75 §7 as corrected in §11. */
  facing: number;
  /** The record's third word: not decoded (pointer-like on some maps, float-like on others). */
  word: number;
}

/** A polyline of cells and the word after it (75 §5.6). */
export interface AiLine { locs: AiLoc[]; value: number }

/** One AI sub-map: its header (75 §3), its grid (§4) and its tables (§5). */
export interface AiSubMap {
  /** Position in the file, which is what every loc's `map` field names -- not `id` (75 §4). */
  index: number;
  name: string;
  /** The i32 at +0x34: 0-46 or -1, not the loc's map index (Frostfire's Tunnels: 7, its locs say 2). */
  id: number;
  flags: number;
  min: [number, number, number];
  max: [number, number, number];
  cellsX: number;
  cellsZ: number;
  cellSize: [number, number];
  /** The f32 at +0x58: 0.5 on 76 of the 83 sub-maps; not decoded. */
  param: number;
  /** An MS-DOS date-time (`dosDateTime`), 2002-05-17 to 2003-10-09 over the 83. */
  stamp: number;
  rows: AiRow[];
  /** Each stored cell's first word, in row order (75 §4); bit 31 is set on all 946,155. */
  cells: Uint32Array;
  /** The word per stored cell after the tables (75 §4); not decoded. */
  cellsB: Uint32Array;
  points: AiNamedPoint[];
  markers: AiMarker[];
  links: AiLink[];
  zones: AiZone[];
  spawns: AiSpawnRecord[];
  lines: AiLine[];
}

/** A whole `AIMAPS.MPS`. */
export interface AiMaps {
  version: number;
  maps: AiSubMap[];
  /** The trailer's link block: `words` 4-byte and `records` 16-byte entries, neither decoded (75 §6). */
  links: { words: number; records: number };
  /** The trailer's spawn list: every sub-map's records again, in another order (75 §6). */
  spawns: AiSpawnRecord[];
}

const VERSION = 2;
const FILE_HEAD = 0x28;          // 75 §2: u32 version, u32 sub-map count, 32 zero bytes
const SUB_HEAD = 0xa8;           // 75 §3
const NAME = 32, SHORT_NAME = 16;

/** Unpacks a `CAiMapLoc` word: map in bits 0-5, x in 6-18, z in 19-31 (75 §4). */
export function decodeAiLoc(word: number): AiLoc {
  return { map: word & 0x3f, x: (word >>> 6) & 0x1fff, z: word >>> 19 };
}

/** The marker in bits 5-7 of a cell word: 2 under a named point, 3 under a start point, 4 under a marker (75 §4). */
export function aiCellMarker(word: number): number {
  return (word >>> 5) & 7;
}

/** An MS-DOS date-time word as `YYYY-MM-DD hh:mm:ss` (75 §3). */
export function dosDateTime(word: number): string {
  const d = word >>> 16, t = word & 0xffff;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${1980 + (d >>> 9)}-${p((d >>> 5) & 15)}-${p(d & 31)} ${p(t >>> 11)}:${p((t >>> 5) & 63)}:${p((t & 31) * 2)}`;
}

function spawnRecord(r: Reader, o: number): AiSpawnRecord {
  const flags = r.u32(o + 4);
  return {
    loc: decodeAiLoc(r.u32(o)), flags, side: ((flags >>> 5) & 1) as 0 | 1, twin: (flags & 0x10) !== 0,
    facing: flags & 7, word: r.u32(o + 8),
  };
}

/** Reads a counted table of fixed-size records, returning the offset after it. */
function table<T>(r: Reader, o: number, size: number, read: (at: number) => T, out: T[]): number {
  const n = r.u32(o);
  let at = o + 4;
  for (let i = 0; i < n; i++, at += size) out.push(read(at));
  return at;
}

function subMap(r: Reader, at: number, index: number): { sub: AiSubMap; end: number } {
  // 75 §3: the 0xA8-byte header. +0x88..+0xA7 (and +0x78) are left unread: uninitialised memory in the
  // writer, carrying stale text such as `Opacity( 0.5 )` on some sub-maps (75 §8).
  const f3 = (o: number): [number, number, number] => [r.f32(o), r.f32(o + 4), r.f32(o + 8)];
  const cellsX = r.u32(at + 0x1c), cellsZ = r.u32(at + 0x20), count = r.u32(at + 0x74);
  const sub: AiSubMap = {
    index, name: r.cstr(at + 0x38, NAME), id: r.i32(at + 0x34), flags: r.u32(at),
    min: f3(at + 4), max: f3(at + 0x10), cellsX, cellsZ, cellSize: [r.f32(at + 0x24), r.f32(at + 0x28)],
    param: r.f32(at + 0x58), stamp: r.u32(at + 0x7c),
    rows: [], cells: new Uint32Array(count), cellsB: new Uint32Array(count),
    points: [], markers: [], links: [], zones: [], spawns: [], lines: [],
  };
  let o = at + SUB_HEAD;
  // 75 §4: `count` cells of 8 bytes, {u32 word; u32 -1}, then one 12-byte row record per grid row.
  for (let i = 0; i < count; i++, o += 8) sub.cells[i] = r.u32(o);
  let running = 0;
  for (let z = 0; z < cellsZ; z++, o += 12) {
    const span = r.u32(o), row = { x0: span & 0xffff, x1: span >>> 16, first: r.u32(o + 4) };
    if (row.x1 > row.x0) {
      if (row.first !== running || row.x1 > cellsX) throw new Error(`AIMAPS.MPS ${sub.name}: row ${z} does not follow its predecessors`);
      running += row.x1 - row.x0;
    }
    sub.rows.push(row);
  }
  if (running !== count) throw new Error(`AIMAPS.MPS ${sub.name}: the rows hold ${running} cells, the header ${count}`);

  // 75 §5: eight counted tables, in this order.
  o = table(r, o, 24, (p) => {
    const word = r.u32(p + 20);
    return { name: r.cstr(p + 4, SHORT_NAME), loc: decodeAiLoc(r.u32(p)), kind: (word >>> 8) & 0xff, word };
  }, sub.points);
  o = table(r, o, 40, (p) => ({ loc: decodeAiLoc(r.u32(p)), word: r.u32(p + 4) }), sub.markers);
  o = table(r, o, 12, (p) => ({ from: decodeAiLoc(r.u32(p)), to: decodeAiLoc(r.u32(p + 4)), word: r.u32(p + 8) }), sub.links);
  o = table(r, o, 28, (p) => {
    const size = r.u32(p + 4);
    return { name: r.cstr(p + 12, SHORT_NAME), corner: decodeAiLoc(r.u32(p)), width: size & 0xffff, height: size >>> 16, kind: r.u32(p + 8) };
  }, sub.zones);
  o = table(r, o, 12, (p) => spawnRecord(r, p), sub.spawns);
  const lines = r.u32(o);
  o += 4;
  for (let i = 0; i < lines; i++) {
    const n = r.u32(o), locs: AiLoc[] = [];
    for (let k = 0; k < n; k++) locs.push(decodeAiLoc(r.u32(o + 4 + 4 * k)));
    sub.lines.push({ locs, value: r.u32(o + 4 + 4 * n) });
    o += 8 + 4 * n;
  }
  for (const label of ['seventh', 'eighth']) {
    // Empty on all 22 archives, so their record size is unknown: refuse rather than guess (75 §5.7).
    if (r.u32(o) !== 0) throw new Error(`AIMAPS.MPS ${sub.name}: the ${label} table is not empty (${r.u32(o)})`);
    o += 4;
  }
  for (let i = 0; i < count; i++, o += 4) sub.cellsB[i] = r.u32(o);
  return { sub, end: o };
}

/** Reads a whole `AIMAPS.MPS` (75 §2): throws unless the layout accounts for every byte. */
export function parseAiMaps(bytes: Uint8Array): AiMaps {
  const r = new Reader(bytes);
  const version = r.u32(0), count = r.u32(4);
  if (version !== VERSION) throw new Error(`AIMAPS.MPS version ${version}, expected ${VERSION}`);
  const maps: AiSubMap[] = [];
  let o = FILE_HEAD;
  for (let i = 0; i < count; i++) {
    const { sub, end } = subMap(r, o, i);
    maps.push(sub);
    o = end;
  }
  // 75 §6: {u32 1; u32 size; u32 words; u32 records; words x 4 B; records x 16 B}, then the spawn list.
  if (r.u32(o) !== 1) throw new Error(`AIMAPS.MPS: trailer begins ${r.u32(o)}, expected 1`);
  const size = r.u32(o + 4), words = r.u32(o + 8), records = r.u32(o + 12);
  if (size !== 16 + 4 * words + 16 * records) throw new Error(`AIMAPS.MPS: link block of ${size} bytes for ${words} + ${records} entries`);
  o += size;
  const spawns: AiSpawnRecord[] = [];
  o = table(r, o, 12, (p) => spawnRecord(r, p), spawns);
  if (o !== bytes.byteLength) throw new Error(`AIMAPS.MPS: ${bytes.byteLength - o} bytes past the trailer's spawn list`);
  return { version, maps, links: { words, records }, spawns };
}

/** The `AIMAPS.MPS` of a map archive (`RUN/MP*.ZDB`), read. */
export function aiMapsFromZdb(zdb: Uint8Array): AiMaps {
  return parseAiMaps(zdbMember(zdb, parseZdb(zdb), 'AIMAPS.MPS'));
}

/** The index of cell (x, z) in `cells`/`cellsB`, or -1 when the grid stores no such cell (75 §4). */
export function aiCellIndex(sub: AiSubMap, x: number, z: number): number {
  const row = sub.rows[z];
  if (!row || x < row.x0 || x >= row.x1) return -1;
  return row.first + x - row.x0;
}

/** The world (x, z) of a cell's centre: the sub-map's minimum corner plus (cell + 0.5) cell sizes (75 §4). */
export function aiCellCentre(sub: AiSubMap, x: number, z: number): [number, number] {
  return [sub.min[0] + (x + 0.5) * sub.cellSize[0], sub.min[2] + (z + 0.5) * sub.cellSize[1]];
}

/** A zone's world rectangle: cells `[x, x + width) x [z, z + height)` from its corner (75 §5.4). */
export function aiZoneRect(sub: AiSubMap, zone: AiZone): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const minX = sub.min[0] + zone.corner.x * sub.cellSize[0], minZ = sub.min[2] + zone.corner.z * sub.cellSize[1];
  return { minX, minZ, maxX: minX + zone.width * sub.cellSize[0], maxZ: minZ + zone.height * sub.cellSize[1] };
}

/** The first named point matching any of `names`, case-insensitively, and the sub-map holding it. */
export function namedPoint(ai: AiMaps, ...names: string[]): { sub: AiSubMap; point: AiNamedPoint } | undefined {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const sub of ai.maps) {
    const point = sub.points.find((p) => wanted.has(p.name.toLowerCase()));
    if (point) return { sub, point };
  }
  return undefined;
}

/**
 * The unit (x, z) a facing points along: step k is (sin 45k deg, -cos 45k deg) -- 0 is -z, 2 is +x, 4 is +z,
 * 6 is -x. Derived from the data (75 §11): 40 of the 44 measured spawns are the orbit camera, which sits behind
 * the actor along its facing (`tools_py/parity/online_match_ours.py:42-45`), and this is the one convention of
 * the sixteen (step 0 on any of eight axes, turning either way) under which all 40 lie behind a slot of their
 * own side -- 20.1-28.0 units back, the bearing to the slot within 2.2-7.6 degrees of its facing; the next best
 * places 22. Until 2026-09-28 this was its negation, read as the actor standing ahead of its slot.
 */
export function facingVector(facing: number): [number, number] {
  const a = (facing & 7) * Math.PI / 4;
  return [Math.sin(a), -Math.cos(a)];
}

/** A spawn slot placed in the world: a record of the trailer's list with bit 4 clear (75 §5.5, §6). */
export interface AiSpawnSlot { record: AiSpawnRecord; sub: AiSubMap; side: 0 | 1; facing: number; x: number; z: number }

/**
 * The spawn slots of one side, or of both, at their cells' centres; with `twins`, the twin records instead -- the
 * respawn records (research 91 section 4: list key `flags >> 4` 1 and 3, `FUN_0052fe60`).
 */
export function spawnSlots(ai: AiMaps, side?: 0 | 1, twins = false): AiSpawnSlot[] {
  const out: AiSpawnSlot[] = [];
  for (const record of ai.spawns) {
    if (record.twin !== twins || (side !== undefined && record.side !== side)) continue;
    const sub = ai.maps[record.loc.map];
    if (!sub) throw new Error(`AIMAPS.MPS: a spawn names sub-map ${record.loc.map} of ${ai.maps.length}`);
    const [x, z] = aiCellCentre(sub, record.loc.x, record.loc.z);
    out.push({ record, sub, side: record.side, facing: record.facing, x, z });
  }
  return out;
}

/** How a world position sits against a slot: along its facing, across it, and straight-line. */
export interface SpawnFit { slot: AiSpawnSlot; along: number; perp: number; distance: number }

/**
 * The slot of `side` that best explains a position (x, z) as at the slot's centre or behind it along its
 * facing: of the slots with `along` in `[-maxBehind, 1]`, the one with the least `|perp|`; undefined if none
 * qualifies. Research 75 §7 and §11 are the check this serves: the measured spawns of `spawns.ts` sit either
 * at a slot's centre (the actor's feet, 4 rows) or 20-28 units behind one (the orbit camera behind the actor,
 * 40 rows).
 */
export function fitSpawn(ai: AiMaps, side: 0 | 1, x: number, z: number, maxBehind = 30): SpawnFit | undefined {
  let best: SpawnFit | undefined;
  for (const slot of spawnSlots(ai, side)) {
    const [ux, uz] = facingVector(slot.facing);
    const dx = x - slot.x, dz = z - slot.z;
    const along = dx * ux + dz * uz, perp = dz * ux - dx * uz;
    if (along > 1 || along < -maxBehind) continue;
    if (!best || Math.abs(perp) < Math.abs(best.perp)) best = { slot, along, perp, distance: Math.hypot(dx, dz) };
  }
  return best;
}

/**
 * A spawn slot as the viewer draws it (W1.5b; the spec's W1.R9 makes the slots the spawn markers): the flat
 * form of `AiSpawnSlot`, plain numbers and a flag only, so it crosses the worker's `postMessage` as it is.
 */
export interface SpawnSlot {
  /** 0 is A's side and 1 is B's: bit 5 of the record's flags (75 §5.5); A is side 0 on all 22 maps (75 §0). */
  side: 0 | 1;
  /**
   * The slot's place among its side's slots in the trailer's list, from 0 (75 §6): a name for the slot,
   * not the game's choice of it -- which slot a player gets is game logic outside the file (W1.R9).
   */
  index: number;
  /**
   * World (x, y, z). x and z are the cell's centre (75 §4). The y is not in the file (no record carries a
   * height, 75 §4, §9): it is the ground probe's floor under the centre where `placeSpawnSlots` is given the
   * map's ground and the probe finds one (`onFloor`, W1.4b), and its estimate from the measured spawns otherwise.
   */
  position: [number, number, number];
  /** Whether the y is the ground probe's floor under the cell's centre (W1.4b); false where it is the estimate. */
  onFloor: boolean;
  /** The facing in eighth turns, bits 0-2 of the flags (75 §5.5). */
  step: number;
  /** The same facing as a unit (x, z): step k points along (sin 45k deg, -cos 45k deg) (`facingVector`, 75 §11). */
  facing: [number, number];
  /** The cell: sub-map index and grid (x, z) (`CAiMapLoc`, 75 §4). */
  loc: AiLoc;
}

/**
 * Every slot of the file's spawn list, both sides, placed for drawing (W1.5b; the y, W1.4b).
 *
 * The y, which the file does not hold (75 §4). First an estimate: the measured spawn of the slot's side
 * (`spawns.ts`) where the map has one, held inside the height range of the slot's sub-map -- the header's
 * bounding box, the only heights the file has (75 §3) -- and that range's bottom where the map has none. The
 * measured height is the actor's feet only on Frostfire and Vigilance (`KNOWN.md` section 1); on the other 20
 * maps it is the orbit camera's, about 25 units above the actor's floor (75 §11), so the estimate stands that
 * much high there. The hold brings down the slots of a lower sub-map (9 of Death Trap's B on one spanning y -140
 * to -100.5, where B was measured at 1). Then, given the map's ground (`ground`, the probe's grid), the floor
 * under the slot's centre (`slotFloor`) replaces the estimate wherever the probe finds one, and `onFloor` says
 * so: on the 22 maps, 1,058 of the 1,058 slots (2026-09-28, `tools/spawn-slots.ts`).
 */
export function placeSpawnSlots(ai: AiMaps, measured?: Spawns, ground?: Grid, twins = false): SpawnSlot[] {
  const count = [0, 0];
  return spawnSlots(ai, undefined, twins).map((slot) => {
    const bottom = slot.sub.min[1], top = slot.sub.max[1];
    const table = measured ? (slot.side === 0 ? measured.a : measured.b)[1] : undefined;
    const estimate = table === undefined ? bottom : Math.min(top, Math.max(bottom, table));
    const floor = ground ? slotFloor(ground, slot.x, slot.z, estimate, bottom, top) : null;
    return {
      side: slot.side, index: count[slot.side]!++, position: [slot.x, floor ? floor.y : estimate, slot.z],
      onFloor: floor !== null, step: slot.facing, facing: facingVector(slot.facing), loc: { ...slot.record.loc },
    };
  });
}

/** A floor this far outside a sub-map's height range still counts as in it: the header's bounds are floats (75 §3). */
const RANGE_SLACK = 1;

/**
 * The floor under a slot's centre (W1.4b): the ground probe's candidates at (x, z) (`probeGround`, research 23
 * section 1.1); of them, those inside the slot's sub-map's height range `[bottom, top]` where any is (75 §3); then
 * the engine's pick from the estimate + 5 -- the highest at or under that origin + 1, else the lowest
 * (`selectFloor`, research 24 section 2). Null only where nothing is under (x, z).
 *
 * **Not the pick's 20-unit reject.** That bounds a floor over an actor's own feet (research 23 section 1.1 item 9),
 * and a slot has no feet: its estimate is the side's measured y, taken where A or B stood -- up to 851 units from
 * the slot (75 §10) -- and on 20 maps at the camera's height. Measured over the 22 maps (2026-09-28): every one of
 * the 1,058 slots has a candidate, and one inside its range; the reject would have refused 34 of them (18 of The
 * Ruins', 11 of Enowapi's, 4 of Guidance's, 1 of Desert Glory's), each with nothing under the estimate + 6 and a
 * floor 20.4-119.5 units over it. **The range** moves 3 slots, Sujo's B #12-14 (range -27.2 to 85.5, estimate -25):
 * from a floor at -46.9, 20 under their sub-map, to the one at -11.9 inside it.
 */
function slotFloor(ground: Grid, x: number, z: number, estimate: number, bottom: number, top: number): Hit | null {
  const hits = probeGround(ground, x, z);
  const inside = hits.filter((h) => h.y >= bottom - RANGE_SLACK && h.y <= top + RANGE_SLACK);
  return selectFloor(inside.length > 0 ? inside : hits, estimate + PROBE_LIFT, Number.POSITIVE_INFINITY);
}

/** How a position (x, z) sits against a placed slot: along its facing, across it, and straight-line. */
export interface SlotFit { slot: SpawnSlot; along: number; perp: number; distance: number }

/**
 * `fitSpawn` over placed slots: of `side`'s slots with the position's `along` in `[-maxBehind, 1]` -- at the
 * centre or behind it -- the one with the least `|perp|` (`perp = dz * ux - dx * uz`, 75 §7), or undefined
 * when none qualifies.
 */
export function fitSlot(slots: readonly SpawnSlot[], side: 0 | 1, x: number, z: number, maxBehind = 30): SlotFit | undefined {
  let best: SlotFit | undefined;
  for (const slot of slots) {
    if (slot.side !== side) continue;
    const [ux, uz] = slot.facing;
    const dx = x - slot.position[0], dz = z - slot.position[2];
    const along = dx * ux + dz * uz, perp = dz * ux - dx * uz;
    if (along > 1 || along < -maxBehind) continue;
    if (!best || Math.abs(perp) < Math.abs(best.perp)) best = { slot, along, perp, distance: Math.hypot(dx, dz) };
  }
  return best;
}

/** At a slot's centre: the 4 `KNOWN.md` rows, the actor's feet, are 0.26-0.51 units off theirs (75 §7). */
const AT_SLOT = 1;
/**
 * Behind a slot: up to 30 units back along its facing (W1.R9) and within half a cell of the line (75 §3: cells
 * are 10) -- where the orbit camera sits behind an actor standing on the slot (75 §11).
 */
const BEHIND_ALONG = 30, BEHIND_ACROSS = 5;

/**
 * The spec's W1.R9 oracle: a measured position is accounted for when it lies at its fitted slot's centre (an
 * actor row), or behind it along its facing, up to 30 units, within half a cell of the line (a camera row).
 * 75 §7 and §11 found all 44: 4 at a centre, 40 at 20.1-28.0 behind and 1.0-3.2 across.
 */
export function accountsFor(fit: SlotFit | undefined): boolean {
  if (!fit) return false;
  return fit.distance <= AT_SLOT || (fit.along <= 0 && fit.along >= -BEHIND_ALONG && Math.abs(fit.perp) <= BEHIND_ACROSS);
}
