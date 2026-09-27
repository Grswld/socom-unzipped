import { describe, it, expect } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  collisionLines, DITYPE_COLOURS, footprintDistance, loadModelLibrary, parseClutter, parseSceneGraph,
  placeClutter, planeHeightAt, spawnsFor, SPAWNS, worldCollision,
  type ClutterInstance, type ModelLibrary, type SceneNode, type WorldPoly,
} from '../src/index';

/**
 * Collision in the world frame, the measured spawn table, and `CLUTTER.ZAR` -- the three things a viewer
 * needs beyond the drawn geometry, checked against 36 sections 2 and 6 on all three fixtures.
 */

const MP2 = fixture('RUN/MP2.ZDB');
const MP6 = fixture('RUN/MP6.ZDB');
const MP72 = fixture('RUN/MP72.ZDB');

interface Opened {
  zar(suffix: string): Zar;
  models: SceneNode[];
  library: ModelLibrary;
  collision: WorldPoly[];
  clutter: ClutterInstance[];
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
    zar,
    models,
    library: loadModelLibrary([zar('WORL_MDL.ZED'), zar(`${stem}_MDL.ZED`), zar('FLIB_MDL.ZED')]),
    collision: worldCollision(models),
    clutter: parseClutter(zar('CLUTTER.ZAR')),
  };
  opened.set(stem, made);
  return made;
}

/** Every polygon the graph holds, counted once per node rather than once per realisation. */
function graphPolygons(models: SceneNode[]): number {
  let n = 0;
  const rec = (node: SceneNode): void => { n += node.collision.length; for (const c of node.children) rec(c); };
  for (const m of models) rec(m);
  return n;
}

describe('the measured spawn table (33 lines 47-71, KNOWN section 1)', () => {
  it('names all 22 MP maps, keyed as mission.rdr names them', () => {
    // 36 section 0: 22 archives, MP3 and MP4 not among them. Every one was measured in the 2026-09-17 sweep.
    expect(Object.keys(SPAWNS).length).toBe(22);
    for (const [name, spawn] of Object.entries(SPAWNS)) {
      expect(name).toBe(name.toUpperCase());
      expect(spawn.a.length).toBe(3);
      expect(spawn.b.length).toBe(3);
      expect([...spawn.a, ...spawn.b].every((v) => Number.isFinite(v))).toBe(true);
      // Two spawns that landed on the same spot would be a transcription slip, not a map.
      expect(Math.hypot(spawn.a[0] - spawn.b[0], spawn.a[2] - spawn.b[2])).toBeGreaterThan(100);
    }
  });

  it('carries the three fixtures\' positions exactly as they were measured', () => {
    expect(spawnsFor('FROSTFIRE')).toEqual({ a: [796, 100, 614], b: [536, 143, 1254] });
    expect(spawnsFor('DESERT GLORY')).toEqual({ a: [837, -5, 1901], b: [1865, 66, 1221] });
    expect(spawnsFor('CROSSROADS')).toEqual({ a: [1972, 68, 2150], b: [748, 93, 766] });
  });

  it('answers undefined for a name it has never measured, and ignores case and spacing', () => {
    expect(spawnsFor('NOT A MAP')).toBeUndefined();
    expect(spawnsFor('')).toBeUndefined();
    expect(spawnsFor('  frostfire ')).toEqual(SPAWNS['FROSTFIRE']);
  });
});

describe('collision in the world frame (36 section 6)', () => {
  it.skipIf(!MP2)('Frostfire: 2,756 polygons in the graph, realised as 3,338 placements', () => {
    const { models, collision } = open('MP2');
    // 36 section 6 counts the polygons the archive stores: 2,756 on Frostfire.
    expect(graphPolygons(models)).toBe(2756);
    // A prototype's polygons are realised once per instance context, exactly as its chunks are, so the
    // world-frame count is larger. It has to be: an instanced crate collides where the crate stands.
    expect(collision.length).toBe(3338);
    expect(collision.every((p) => p.points.length === p.ptcount * 3)).toBe(true);
    // Only two of the four `m_ditype` values occur on any fixture; the overlay still colours all four.
    expect(new Set(collision.map((p) => p.ditype))).toEqual(new Set([2, 3]));
    expect(new Set(collision.map((p) => p.region))).toEqual(new Set([0, 34]));
  });

  it.skipIf(!MP2)('puts a floor polygon under each of Frostfire\'s two spawns, at the measured height', () => {
    const { collision } = open('MP2');
    const spawns = spawnsFor('FROSTFIRE')!;
    // KNOWN section 1: two discrete floors, y about 100 and 142, and the sweep measured B's feet at 143.
    for (const [feet, floor] of [[spawns.a, 100], [spawns.b, 142]] as [[number, number, number], number][]) {
      const under = collision
        .map((p) => ({ distance: footprintDistance(p.points, feet[0], feet[2]), height: planeHeightAt(p.points, feet[0], feet[2]) }))
        .filter((h) => h.distance <= 40 && h.height !== null && Math.abs(h.height - feet[1]) <= 5)
        .sort((a, b) => a.distance - b.distance);
      expect(under.length).toBeGreaterThan(0);
      expect(under[0]!.distance).toBe(0);                     // the spawn stands inside the polygon
      expect(under[0]!.height).toBeCloseTo(floor, 3);
    }
  });

  it.skipIf(!MP6 || !MP72)('reads the other two maps\' collision too, with the shapes 36 section 6 tabulates', () => {
    expect(graphPolygons(open('MP6').models)).toBe(5442);
    expect(graphPolygons(open('MP72').models)).toBe(8168);
    expect(open('MP6').collision.length).toBe(5951);
    expect(open('MP72').collision.length).toBe(9820);
    // 36 section 6's histograms: (3,3) leads Desert Glory, (2,4) leads Crossroads.
    const top = (polys: WorldPoly[]): string => {
      const shape = new Map<string, number>();
      for (const p of polys) shape.set(`${p.ditype},${p.ptcount}`, (shape.get(`${p.ditype},${p.ptcount}`) ?? 0) + 1);
      return [...shape].sort((a, b) => b[1] - a[1])[0]![0];
    };
    expect(top(open('MP6').collision)).toBe('3,3');
    expect(top(open('MP72').collision)).toBe('2,4');
  });

  it.skipIf(!MP2)('draws one line segment per polygon side, coloured by ditype', () => {
    const { collision } = open('MP2');
    const edges = collision.reduce((n, p) => n + p.ptcount, 0);
    const lines = collisionLines(collision);
    expect(edges).toBe(13265);
    expect(lines.positions.length).toBe(edges * 6);           // two endpoints, three floats each
    expect(lines.colors.length).toBe(edges * 6);              // rgb per endpoint
    // The first polygon's first edge runs from its first point to its second, in world space.
    const first = collision[0]!;
    expect([...lines.positions.slice(0, 6)]).toEqual([...first.points.slice(0, 6)]);
    const colour = DITYPE_COLOURS[first.ditype]!;
    expect([...lines.colors.slice(0, 3)]).toEqual([colour >> 16 & 0xff, colour >> 8 & 0xff, colour & 0xff]);
    // A closed polygon: its last edge returns to the first point.
    const last = first.ptcount * 6 - 3;
    expect([...lines.positions.slice(last, last + 3)]).toEqual([...first.points.slice(0, 3)]);
  });
});

describe('CLUTTER.ZAR (36 section 2)', () => {
  it.skipIf(!MP2 || !MP72)('Frostfire and Crossroads have none: a 192-byte stub', () => {
    expect(open('MP2').clutter).toEqual([]);
    expect(open('MP72').clutter).toEqual([]);
  });

  it.skipIf(!MP6)('Desert Glory has 6 models and 110 instances', () => {
    const { clutter } = open('MP6');
    expect(clutter.length).toBe(110);
    const byModel = new Map<string, number>();
    for (const c of clutter) byModel.set(c.modelName, (byModel.get(c.modelName) ?? 0) + 1);
    expect([...byModel].sort()).toEqual([
      ['afghan2r_clutter_grass1', 15], ['afghan2r_clutter_grass2', 9], ['afghan2r_clutter_grass3', 13],
      ['afghan2r_clutter_rocklarge', 21], ['afghan2r_clutter_rockmed', 16], ['afghan2r_clutter_rocksmall', 36],
    ]);
    const first = clutter[0]!;
    expect(first.modelName).toBe('afghan2r_clutter_rocksmall');
    expect(first.matrix.length).toBe(16);
    // The translation is the fourth row, in world units: this rock stands out on the open ground.
    expect([...first.matrix.slice(12, 16)].map((v) => Number(v.toFixed(3)))).toEqual([1536.068, 0, 1771.973, 1]);
    expect(first.scaleInverse).toBeCloseTo(0.93, 5);
    // `scale_inverse` is the reciprocal of the uniform scale baked into the matrix, in every instance.
    for (const c of clutter) {
      const scale = Math.hypot(c.matrix[0]!, c.matrix[1]!, c.matrix[2]!);
      expect(c.scaleInverse).toBeCloseTo(1 / scale, 3);
    }
  });

  it.skipIf(!MP6)('places every instance against a chain the model library holds', () => {
    const { models, library, clutter } = open('MP6');
    const { placed, missing } = placeClutter(models, clutter);
    expect(missing).toEqual([]);
    // Each of the six models has exactly one visual-bearing node, so one placement per instance.
    expect(placed.length).toBe(110);
    for (const p of placed) {
      const names = new Set(library.get(p.modelName)!.nodes.map((n) => n.name));
      for (const chunk of p.chunks) expect(names.has(chunk)).toBe(true);
    }
    // The placement is the clutter matrix itself where the model's own node sits at its origin.
    const first = placed.find((p) => p.modelName === 'afghan2r_clutter_rocksmall')!;
    expect([...first.rowMajor.slice(12, 15)].map((v) => Number(v.toFixed(3)))).toEqual([1536.068, 0, 1771.973]);
  });

  it.skipIf(!MP6)('names a model the scene graph does not hold once, not once per instance', () => {
    const { models, clutter } = open('MP6');
    const strangers: ClutterInstance[] = clutter.map((c) => ({ ...c, modelName: 'no_such_model' }));
    const { placed, missing } = placeClutter(models, strangers);
    expect(placed).toEqual([]);
    expect(missing).toEqual(['no_such_model']);
  });
});
