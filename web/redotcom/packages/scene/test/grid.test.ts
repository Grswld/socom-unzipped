import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  buildGrid, cellAt, cellByCoord, cellsCovering, chopF32, collisionOwners, collisionRuns, decodeGridParams, footprintDistance,
  parseClutter, parseGridParams, parseSceneGraph, parseWorldRoot, placeClutter, placeInstances, placementCells, planeHeightAt, ringCells,
  transformPoint, traverse, worldCollision, worldFootprint, DEFAULT_GRID_PARAMS, IDENTITY,
  type Grid, type GridAtom, type GridParams, type PlacedModel, type SceneNode, type WorldPoly,
} from '../src/index';

/**
 * The engine's grid, `zdb::CGrid` (research 23 section 2.1; reCOM `research/recom/src/gamez/zGrid/`).
 * The synthetic half runs anywhere; the fixture half needs `npm run extract-maps` and skips without it.
 */

const MP2 = fixture('RUN/MP2.ZDB');
const MP6 = fixture('RUN/MP6.ZDB');
const MP72 = fixture('RUN/MP72.ZDB');

/** A `tag_GRID_PARAMS` block built from its five fields (`zNode/znode.h:109-120`), little-endian. */
function block(atoms: number, posts: number, cellDim: number, cellsX: number, cellsZ: number): Uint8Array {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, atoms, true);
  view.setInt32(4, posts, true);
  view.setFloat32(8, cellDim, true);
  view.setInt32(12, cellsX, true);
  view.setInt32(16, cellsZ, true);
  return bytes;
}

/** A Zar whose one key is `grid_params`, standing in for `MP*.ZED`; null for a root without it. */
const zarOf = (bytes: Uint8Array | null): Zar => ({
  find: (name: string) => (bytes && name === 'grid_params' ? { name, offset: 0, size: bytes.length, children: [] } : undefined),
  data: () => bytes,
} as unknown as Zar);

const params = (cellsX: number, cellsZ: number, cellDim = 100): GridParams =>
  ({ atomCount: 8192, posts: 16, cellDim, cellsX, cellsZ, originX: 0, originZ: 0 });

/** A placement whose node bbox is the given ground rectangle, 10 high, at the identity. */
function box(minX: number, minZ: number, maxX: number, maxZ: number, name = 'box'): PlacedModel {
  return {
    modelName: name, path: `worldmodel/${name}`, nodeIndex: 0, instanceIndex: null, chunks: ['N000_000'], cull: [true],
    facade: 0, world: Float32Array.from(IDENTITY), rowMajor: Float32Array.from(IDENTITY), lit: false,
    bbox: Float32Array.from([minX, 0, minZ, maxX, 10, maxZ]),
  };
}

/** A clutter placement: no bounds of its own needed, a matrix whose translation row is its position. */
function tuft(x: number, z: number): PlacedModel {
  const m = Float32Array.from(IDENTITY);
  m[12] = x; m[14] = z;
  return { ...box(-1, -1, 1, 1, 'grass'), path: 'clutter/grass', world: Float32Array.from(m), rowMajor: m };
}

/** A flat quad polygon, world space, owned by `path`. */
function quad(minX: number, minZ: number, maxX: number, maxZ: number, path: string, y = 0): WorldPoly {
  return {
    modelName: 'worldmodel', path, region: 0, ditype: 2, material: 0, ptcount: 4, cameratype: 0,
    points: Float32Array.from([minX, y, minZ, maxX, y, minZ, maxX, y, maxZ, minX, y, maxZ]),
  };
}

/** A small deterministic generator, so the random boxes are the same boxes on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** How many distinct cells each ring of a walk visits, ring 0 first. */
function cellsPerRing(grid: Grid, x: number, z: number, metric?: 'square' | 'diamond'): number[] {
  const out: number[] = [];
  for (const { ring } of ringCells(grid, x, z, Infinity, metric)) out[ring] = (out[ring] ?? 0) + 1;
  return out;
}

describe('grid_params (tag_GRID_PARAMS, zNode/znode.h:109-120)', () => {
  it('decodes the 20 bytes in the header\'s order: atom pool, posts, cell dimension, cells along x, cells along z', () => {
    // Frostfire's grid (research 24 section 1.1) with the pool research 23 section 2.1 reads live (0x2000).
    expect(decodeGridParams(block(8192, 16, 160, 8, 9))).toEqual(
      { atomCount: 8192, posts: 16, cellDim: 160, cellsX: 8, cellsZ: 9, originX: 0, originZ: 0 });
    // The M51 image's grid (research 23 section 2.1): the same five fields, the other known values.
    const m51 = decodeGridParams(block(8192, 16, 180, 36, 25))!;
    expect([m51.cellDim, m51.cellsX, m51.cellsZ]).toEqual([180, 36, 25]);
  });

  it('refuses a short block and a grid of no cells; the root then takes the engine\'s default grid (research 23 section 2.3)', () => {
    expect(decodeGridParams(new Uint8Array(16))).toBe(null);
    expect(decodeGridParams(block(8192, 16, 160, 0, 9))).toBe(null);
    expect(decodeGridParams(block(8192, 16, 0, 8, 9))).toBe(null);
    expect(decodeGridParams(block(8192, 16, Number.NaN, 8, 9))).toBe(null);
    expect(parseGridParams(zarOf(null))).toEqual(DEFAULT_GRID_PARAMS);
    expect(parseGridParams(zarOf(new Uint8Array(12)))).toEqual(DEFAULT_GRID_PARAMS);
    expect([DEFAULT_GRID_PARAMS.cellDim, DEFAULT_GRID_PARAMS.cellsX, DEFAULT_GRID_PARAMS.cellsZ]).toEqual([640, 8, 8]);
    expect(parseGridParams(zarOf(block(8192, 16, 160, 8, 9))).cellsZ).toBe(9);
  });

  it.skipIf(!MP2)('reads Frostfire\'s world root as dimension 160, 8 x 9, origin 0 and the 8,192-atom pool (research 24 section 1.1, 23 section 2.1)', () => {
    const { root } = open('MP2');
    expect(root.grid).toEqual({ atomCount: 8192, posts: 16, cellDim: 160, cellsX: 8, cellsZ: 9, originX: 0, originZ: 0 });
  });

  it.skipIf(!MP6 || !MP72)('reads the other two fixtures\' grids (read off the disc 2026-09-28; no note records them)', () => {
    expect(open('MP6').root.grid).toMatchObject({ atomCount: 8192, cellDim: 180, cellsX: 14, cellsZ: 15 });
    expect(open('MP72').root.grid).toMatchObject({ atomCount: 8192, cellDim: 170, cellsX: 14, cellsZ: 16 });
  });
});

describe('cells and atoms (CGrid::Create, FUN_002d7580)', () => {
  it('generates cellsX x cellsZ cells from the origin at cellDim, x fastest, named cell%06d (grid_main.cpp:98-142)', () => {
    const grid = buildGrid({ ...params(3, 2, 50), originX: 1000, originZ: -200 }, [], [], []);
    expect(grid.cells.map((c) => c.name)).toEqual(['cell000000', 'cell000001', 'cell000002', 'cell000003', 'cell000004', 'cell000005']);
    expect(grid.cells.map((c) => [c.index, c.x, c.z])).toEqual([[0, 0, 0], [1, 1, 0], [2, 2, 0], [3, 0, 1], [4, 1, 1], [5, 2, 1]]);
    expect(grid.cells[4]).toMatchObject({ minX: 1050, minZ: -150, maxX: 1100, maxZ: -100 });
    expect(grid.atomsSpent).toBe(0);
  });

  it('spends one atom per cell a box covers: straddling the middle of 2 x 2, four', () => {
    const grid = buildGrid(params(2, 2), [box(80, 60, 120, 140)], [], []);
    expect(grid.atomsSpent).toBe(4);
    expect(grid.cells.map((c) => c.atoms.length)).toEqual([1, 1, 1, 1]);
    expect(grid.objects).toHaveLength(1);
    expect(grid.cells.every((c) => c.atoms[0]!.object === grid.objects[0])).toBe(true);
    expect(grid.cells.map((c) => c.atoms[0]!.cell)).toEqual([0, 1, 2, 3]);
    // Inside one cell, one atom; along one edge, two.
    expect(buildGrid(params(2, 2), [box(10, 10, 90, 90)], [], []).atomsSpent).toBe(1);
    expect(buildGrid(params(2, 2), [box(10, 10, 150, 90)], [], []).atomsSpent).toBe(2);
  });

  it('clamps what lies outside the grid onto its edge cells, as addOrderedCellAtom and gridGetAtomBasePtr clamp (grid_main.cpp:317-334, 474-489)', () => {
    const grid = buildGrid(params(4, 3), [box(-500, -500, -400, -400, 'sw'), box(900, 150, 1200, 180, 'e'), box(-50, 350, 450, 900, 'n')], [], []);
    const where = (name: string) => grid.cells.filter((c) => c.atoms.some((a) => a.object.kind === 'model' && a.object.placed.modelName === name)).map((c) => [c.x, c.z]);
    expect(where('sw')).toEqual([[0, 0]]);
    expect(where('e')).toEqual([[3, 1]]);
    expect(where('n')).toEqual([[0, 2], [1, 2], [2, 2], [3, 2]]);
  });

  it('covers every cell with bounds of +-FLT_MAX: 900 atoms on the M51 image\'s 36 x 25 (research 23 section 2.1)', () => {
    const FLT_MAX = 3.4028234663852886e38;
    const grid = buildGrid(params(36, 25, 180), [box(-FLT_MAX, -FLT_MAX, FLT_MAX, FLT_MAX)], [], []);
    expect(grid.atomsSpent).toBe(900);
  });

  it('chops a coordinate to single precision before its cell, as the EE rounds (research 25): 799.9999981 is in cell 4, not 5', () => {
    // Frostfire's `relieftower` has a bound here; rounded to nearest it reads 800 and takes a fifth column.
    const edge = 799.9999980926514;
    expect(Math.fround(edge)).toBe(800);
    expect(chopF32(edge)).toBeLessThan(800);
    expect(chopF32(-edge)).toBeGreaterThan(-800);
    expect(chopF32(0.1)).toBeLessThanOrEqual(0.1);
    expect(chopF32(1e39)).toBe(3.4028234663852886e38);          // no infinity on the EE: FLT_MAX
    // Such a bound only arises out of a transform (a stored f32 would already be 800): a 0.1 scale at x 700.
    const scaled = { ...box(0, 0, 999.99994, 1), rowMajor: Float32Array.from([0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 700, 0, 10, 1]) };
    const grid = buildGrid(params(8, 9, 160), [scaled], [], []);
    expect(grid.objects[0]!.footprint.maxX).toBeLessThan(800);
    expect(Math.fround(grid.objects[0]!.footprint.maxX)).toBe(800);
    expect(grid.cells.filter((c) => c.atoms.length > 0).map((c) => c.x)).toEqual([4]);
    expect(cellAt(grid, edge, 15).x).toBe(4);
    // On an exact boundary the f32 inverse decides: 1/160 rounds up, so 800 opens the next cell; 1/100 rounds
    // down, so 100 x f32(1/100) chops to under 1 and stays in the cell below.
    expect(cellAt(grid, 800, 15).x).toBe(5);
    expect(Math.fround(1 / 100)).toBeLessThan(1 / 100);
    expect(cellAt(buildGrid(params(4, 3), [], [], []), 100, 150).x).toBe(0);
  });

  it('puts NaN bounds in one cell, cvt.w saturating to 0x7fffffff (research 23 section 2.1)', () => {
    const grid = buildGrid(params(4, 3), [box(Number.NaN, Number.NaN, Number.NaN, Number.NaN)], [], []);
    expect(grid.atomsSpent).toBe(1);
    expect(grid.cells.filter((c) => c.atoms.length > 0).map((c) => [c.x, c.z])).toEqual([[3, 2]]);
  });

  it('carries a placement\'s node bbox into the world by its two corners, as gridAddNodeToGrids does (grid_main.cpp:408-431)', () => {
    // A 90-degree yaw in the row-vector convention: (x, z) -> (z, -x), then translated to (300, 500).
    const yaw = Float32Array.from([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 300, 0, 500, 1]);
    const bbox = Float32Array.from([-10, 0, -50, 10, 5, 50]);
    expect(worldFootprint(bbox, yaw)).toEqual({ minX: 250, minZ: 490, maxX: 350, maxZ: 510 });
    // Two corners, not eight: at 45 degrees the box they span is narrower than what the node covers.
    const c = Math.SQRT1_2;
    const turn = Float32Array.from([c, 0, -c, 0, 0, 1, 0, 0, c, 0, c, 0, 0, 0, 0, 1]);
    const two = worldFootprint(bbox, turn);
    const corners = [[-10, -50], [10, -50], [10, 50], [-10, 50]].map(([x, z]) => transformPoint(turn, x!, 0, z!));
    const deep = Math.max(...corners.map((p) => p[2])) - Math.min(...corners.map((p) => p[2]));
    expect(deep).toBeCloseTo(120 * c, 4);
    expect(two.maxZ - two.minZ).toBeCloseTo(80 * c, 4);
    const lo = transformPoint(turn, -10, 0, -50), hi = transformPoint(turn, 10, 5, 50);
    expect(two).toEqual({ minX: Math.min(lo[0], hi[0]), minZ: Math.min(lo[2], hi[2]), maxX: Math.max(lo[0], hi[0]), maxZ: Math.max(lo[2], hi[2]) });
  });

  it('takes a placement without a bbox at its translation: one cell', () => {
    const bare = box(0, 0, 0, 0);
    delete bare.bbox;
    bare.rowMajor = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 250, 0, 150, 1]);
    const grid = buildGrid(params(4, 3), [bare], [], []);
    expect(grid.cells.filter((c) => c.atoms.length > 0).map((c) => [c.x, c.z])).toEqual([[2, 1]]);
  });

  it('files clutter in one cell by its position (FUN_002d55c0 reads .x/.z), ahead of the cell\'s other atoms', () => {
    const grid = buildGrid(params(2, 2), [box(0, 0, 200, 200)], [tuft(150, 50), tuft(20, 180)], []);
    expect(grid.atomsSpent).toBe(4 + 2);
    const east = grid.cells[1]!, north = grid.cells[2]!;
    expect(east.atoms.map((a) => a.object.kind)).toEqual(['clutter', 'model']);
    expect(north.atoms.map((a) => a.object.kind)).toEqual(['clutter', 'model']);
    expect(grid.cells[0]!.atoms.map((a) => a.object.kind)).toEqual(['model']);
    const clutter = grid.objects.filter((o) => o.kind === 'clutter');
    expect(clutter.map((o) => o.index)).toEqual([0, 1]);
  });

  it('indexes collision by the node that owns it -- one object per node, its polygons in surface order', () => {
    const polys = [quad(10, 10, 40, 40, 'worldmodel/deck'), quad(60, 10, 140, 40, 'worldmodel/deck'), quad(110, 110, 190, 190, 'worldmodel/roof')];
    const grid = buildGrid(params(2, 2), [], [], polys);
    const owners = grid.objects.filter((o) => o.kind === 'collision');
    expect(owners).toHaveLength(2);
    const deck = owners[0]!;
    if (deck.kind !== 'collision') throw new Error('unreachable');
    expect(deck.polys).toEqual([polys[0], polys[1]]);
    expect(deck.owner).toEqual({ modelName: 'worldmodel', path: 'worldmodel/deck', first: 0, count: 2 });
    expect(deck.footprint).toEqual({ minX: 10, minZ: 10, maxX: 140, maxZ: 40 });
    expect(grid.atomsSpent).toBe(2 + 1);
    // Owners given explicitly split what a run of one path would merge.
    const split = buildGrid(params(2, 2), [], [], polys, [
      { modelName: 'worldmodel', path: 'worldmodel/deck', first: 0, count: 1 },
      { modelName: 'worldmodel', path: 'worldmodel/deck', first: 1, count: 1 },
      { modelName: 'worldmodel', path: 'worldmodel/roof', first: 2, count: 1 },
    ]);
    expect(split.objects.filter((o) => o.kind === 'collision')).toHaveLength(3);
    // A polygon with no points has no footprint to file it by: it links nowhere rather than everywhere.
    const empty = { ...quad(0, 0, 1, 1, 'worldmodel/nothing'), ptcount: 0, points: new Float32Array(0) };
    expect(buildGrid(params(2, 2), [], [], [empty]).atomsSpent).toBe(0);
    expect(collisionRuns(polys)).toEqual([
      { modelName: 'worldmodel', path: 'worldmodel/deck', first: 0, count: 2 },
      { modelName: 'worldmodel', path: 'worldmodel/roof', first: 2, count: 1 },
    ]);
  });

  it('gives the cells buildGrid links a placement into, placement by placement, without linking it (placementCells)', () => {
    const random = lcg(2026_09_28_2);
    const placed = Array.from({ length: 30 }, (_, i) => {
      const x = random() * 900 - 150, z = random() * 700 - 150;
      return box(x, z, x + random() * 300, z + random() * 300, `b${i}`);
    });
    const clutter = Array.from({ length: 8 }, () => tuft(random() * 600, random() * 400));
    const grid = buildGrid(params(6, 4), placed, clutter, []);
    const linked = (object: unknown): number[] => grid.cells.filter((c) => c.atoms.some((a) => a.object === object)).map((c) => c.index);
    for (const o of grid.objects) {
      if (o.kind === 'collision') continue;
      expect(placementCells(grid, o.placed, o.kind).map((c) => c.index), `${o.kind} ${o.index}`).toEqual(linked(o));
    }
    // A clutter instance is filed by its position alone; the same matrix as a placement is filed by its bbox.
    const wide = { ...tuft(150, 150), bbox: Float32Array.from([-120, 0, -20, 120, 1, 20]) };
    expect(placementCells(grid, wide, 'clutter').map((c) => c.index)).toEqual([7]);
    expect(placementCells(grid, wide).map((c) => c.index)).toEqual([6, 7, 8]);
  });

  it('addresses one cell three ways -- by index, by cell (x, z), by world (x, z) -- all clamped', () => {
    const grid = buildGrid(params(4, 3), [box(120, 120, 180, 180)], [], []);
    const cell = grid.cells[5]!;
    expect(cellByCoord(grid, 1, 1)).toBe(cell);
    expect(cellAt(grid, 150, 150)).toBe(cell);
    expect(cellAt(grid, 100.01, 199.99)).toBe(cell);
    expect(cellAt(grid, 99.99, 150)).toBe(grid.cells[4]);
    expect(cellAt(grid, -1e6, 1e6)).toBe(cellByCoord(grid, 0, 2));
    expect(cellByCoord(grid, 9, -3)).toBe(cellByCoord(grid, 3, 0));
    expect(cellByCoord(grid, Number.NaN, 0)).toBe(cellByCoord(grid, 3, 0));   // cvt.w: NaN is 0x7fffffff
    expect(cellsCovering(grid, { minX: 50, minZ: 150, maxX: 250, maxZ: 250 }).map((c) => c.index)).toEqual([4, 5, 6, 8, 9, 10]);
    expect(cellsCovering(grid, { minX: 120, minZ: 120, maxX: 180, maxZ: 180 })).toEqual([cell]);
  });
});

describe('the ordered traversal (addOrderedCellAtom, GetNextAtomOrdered)', () => {
  /** A 5 x 5 grid with one box over all of it: every cell holds exactly one atom. */
  const five = (): Grid => buildGrid(params(5, 5), [box(0, 0, 500, 500)], [], []);

  it('walks from the centre of 5 x 5 in rings of |dx| + |dz| by default, as addOrderedCellAtom labels them (grid_main.cpp:351, W1.R8): 1, 4, 8, 8, 4', () => {
    const grid = five();
    expect(cellsPerRing(grid, 250, 250)).toEqual([1, 4, 8, 8, 4]);
    const walk = [...traverse(grid, 250, 250)];
    expect(walk).toHaveLength(25);
    expect(walk[0]!.atom.cell).toBe(12);
    expect(walk.map((w) => w.ring)).toEqual([0, 1, 1, 1, 1, ...Array(8).fill(2), ...Array(8).fill(3), 4, 4, 4, 4]);
    // Ring 1 is the four cells that share an edge with the camera's, in cell order.
    expect(walk.slice(1, 5).map((w) => w.atom.cell)).toEqual([7, 11, 13, 17]);
  });

  it('labels square rings on request, max(|dx|, |dz|), for a neighbourhood query: 1, 8, 16', () => {
    const grid = five();
    expect(cellsPerRing(grid, 250, 250, 'square')).toEqual([1, 8, 16]);
    expect([...traverse(grid, 250, 250, Infinity, 'square')].map((w) => w.ring))
      .toEqual([0, 1, 1, 1, 1, 1, 1, 1, 1, ...Array(16).fill(2)]);
    expect(ringCells(grid, 250, 250, 1, 'square')).toHaveLength(9);          // the 3 x 3 around the camera
  });

  it('from a corner drops the cells a ring would take outside the grid: 1, 2, 3, 4, 5, 4, 3, 2, 1 (square: 1, 3, 5, 7, 9)', () => {
    const grid = five();
    expect(cellsPerRing(grid, 10, 10)).toEqual([1, 2, 3, 4, 5, 4, 3, 2, 1]);
    expect(cellsPerRing(grid, 490, 10)).toEqual([1, 2, 3, 4, 5, 4, 3, 2, 1]);
    expect(cellsPerRing(grid, 10, 10, 'square')).toEqual([1, 3, 5, 7, 9]);
    // A camera off the grid starts from the cell it clamps to.
    expect(ringCells(grid, -300, 900)[0]!.cell).toBe(cellByCoord(grid, 0, 4));
  });

  it('stops at maxRing', () => {
    const grid = five();
    expect([...traverse(grid, 250, 250, 1)]).toHaveLength(5);
    expect([...traverse(grid, 250, 250, 1, 'square')]).toHaveLength(9);
    expect([...traverse(grid, 250, 250, 0)].map((w) => w.atom.cell)).toEqual([12]);
  });

  it('yields every atom exactly once, ring by ring, each cell\'s atoms in insertion order', () => {
    const random = lcg(2026_09_28);
    const placed: PlacedModel[] = [];
    for (let i = 0; i < 40; i++) {
      const x = random() * 900 - 150, z = random() * 700 - 150, w = random() * 300, d = random() * 300;
      placed.push(box(x, z, x + w, z + d, `b${i}`));
    }
    const clutter = Array.from({ length: 10 }, () => tuft(random() * 600, random() * 400));
    const polys = Array.from({ length: 12 }, (_, i) => quad(i * 50, 0, i * 50 + 80, 60 + i * 30, `worldmodel/p${i >> 1}`));
    const grid = buildGrid(params(6, 4), placed, clutter, polys);
    expect(grid.atomsSpent).toBe(grid.cells.reduce((n, c) => n + c.atoms.length, 0));
    for (const [x, z] of [[0, 0], [310, 190], [599, 399], [-1000, 250], [450, 5000]]) {
      const seen: GridAtom[] = [];
      let ring = 0;
      for (const step of traverse(grid, x!, z!)) {
        expect(step.ring).toBeGreaterThanOrEqual(ring);
        ring = step.ring;
        seen.push(step.atom);
      }
      expect(seen).toHaveLength(grid.atomsSpent);
      expect(new Set(seen).size).toBe(grid.atomsSpent);
      // Within a cell, the order the atoms were linked.
      for (const cell of grid.cells) expect(seen.filter((a) => a.cell === cell.index)).toEqual(cell.atoms);
    }
  });
});

interface Opened {
  root: ReturnType<typeof parseWorldRoot>;
  models: SceneNode[];
  placed: PlacedModel[];
  clutter: PlacedModel[];
  collision: WorldPoly[];
}
const opened = new Map<string, Opened>();

/** Opens a map once and remembers it. Only ever called from inside a test (vitest collects skipped bodies). */
function open(stem: string): Opened {
  const known = opened.get(stem);
  if (known) return known;
  const bytes = fixture(`RUN/${stem}.ZDB`);
  if (!bytes) throw new Error(`${FIXTURES_ABSENT} (RUN/${stem}.ZDB)`);
  const toc = parseZdb(bytes);
  const zar = (suffix: string): Zar => Zar.parse(zdbMember(bytes, toc, suffix));
  const models = parseSceneGraph(zar(`${stem}_GEO.ZED`));
  const made: Opened = {
    root: parseWorldRoot(zar(`${stem}.ZED`)),
    models,
    placed: placeInstances(models),
    clutter: placeClutter(models, parseClutter(zar('CLUTTER.ZAR'))).placed,
    collision: worldCollision(models),
  };
  opened.set(stem, made);
  return made;
}

function gridOf(stem: string): Grid {
  const { root, models, placed, clutter, collision } = open(stem);
  return buildGrid(root.grid, placed, clutter, collision, collisionOwners(models));
}

describe('the grid of the fixture maps', () => {
  it.skipIf(!MP2)('Frostfire: 72 cells, and every placed model in at least one of them (research 24 section 1.1)', () => {
    const { placed } = open('MP2');
    const grid = gridOf('MP2');
    expect(grid.cells).toHaveLength(72);
    expect(grid.cells.at(-1)!.name).toBe('cell000071');
    const atoms = new Map<unknown, number>();
    for (const cell of grid.cells) for (const a of cell.atoms) atoms.set(a.object, (atoms.get(a.object) ?? 0) + 1);
    const models = grid.objects.filter((o) => o.kind === 'model');
    expect(models).toHaveLength(placed.length);
    expect(models.every((o, i) => o.kind === 'model' && o.placed === placed[i] && (atoms.get(o) ?? 0) >= 1)).toBe(true);
  });

  it.skipIf(!MP2)('Frostfire: the floors under the spawns are linked in (4, 3) and (3, 7), the console\'s cells (KNOWN, the vf0 row)', () => {
    const grid = gridOf('MP2');
    const floors: [number, number, number, string, number, number][] = [[796, 614, 100, 'N013_000', 4, 3], [536, 1254, 142, 'N038_000', 3, 7]];
    for (const [x, z, y, chunk, cx, cz] of floors) {
      const cell = cellAt(grid, x, z);
      expect([cell.x, cell.z]).toEqual([cx, cz]);
      // The drawn floor (scene.test's chunk under each spawn) and a collision polygon at its height.
      expect(cell.atoms.some((a) => a.object.kind === 'model' && a.object.placed.modelName === 'worldmodel' && a.object.placed.chunks.includes(chunk))).toBe(true);
      const underfoot = cell.atoms.flatMap((a) => (a.object.kind === 'collision' ? [...a.object.polys] : []))
        .filter((p) => footprintDistance(p.points, x, z) === 0)
        .map((p) => planeHeightAt(p.points, x, z));
      expect(underfoot.some((h) => h !== null && Math.abs(h - y) < 0.5)).toBe(true);
    }
  });

  it.skipIf(!MP2 || !MP6 || !MP72)('spends fewer atoms than the pool on each fixture, cell heads included (nodes + free = 8192, research 23 section 2.1)', () => {
    for (const stem of ['MP2', 'MP6', 'MP72']) {
      const grid = gridOf(stem);
      expect(grid.params.atomCount, stem).toBe(8192);
      expect(grid.atomsSpent, stem).toBeGreaterThan(0);
      expect(grid.cells.length + grid.atomsSpent, stem).toBeLessThanOrEqual(8192);
      expect(grid.spent.model + grid.spent.clutter + grid.spent.collision, stem).toBe(grid.atomsSpent);
    }
    // Desert Glory is the fixture with clutter: 110 instances of one-node models, so 110 placements, one atom each.
    expect(gridOf('MP6').spent.clutter).toBe(110);
  });

  it.skipIf(!MP2)('collisionOwners tiles worldCollision exactly, node by node; runs of one path merge same-named siblings', () => {
    const { models, collision } = open('MP2');
    const owners = collisionOwners(models);
    let next = 0;
    for (const o of owners) {
      expect(o.first).toBe(next);
      expect(o.count).toBeGreaterThan(0);
      for (let i = o.first; i < o.first + o.count; i++) expect(collision[i]!.path).toBe(o.path);
      next += o.count;
    }
    expect(next).toBe(collision.length);
    expect(collisionRuns(collision).length).toBeLessThan(owners.length);
  });
});
