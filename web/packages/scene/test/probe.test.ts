import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  buildGrid, collisionOwners, flattenScene, multiply, parseSceneGraph, parseWorldRoot, probeFloor, probeGround, selectFloor,
  spawnsFor, transformPoint, worldCollision, worldDi, ALL_LAYERS, IDENTITY, NODE_GENERIC, NODE_INSTANCE, NODE_MODEL,
  type CollisionOwner, type CollisionPoly, type Grid, type GridParams, type Hit, type SceneNode, type WorldPoly,
} from '../src/index';

/**
 * The ground probe's polygon set (research 24 section 1.1) and the probe itself (research 23 section 1.1-1.2,
 * research 24 section 2). The synthetic half runs anywhere; the fixture half needs `npm run extract-maps`.
 */

const MP2 = fixture('RUN/MP2.ZDB');
const MP6 = fixture('RUN/MP6.ZDB');
const MP72 = fixture('RUN/MP72.ZDB');

const opened = new Map<string, { graph: SceneNode[]; grid: Grid; name: string }>();
/** A map's scene graph and its collision grid, built once. Only ever called from inside a test. */
function open(stem: string): { graph: SceneNode[]; grid: Grid; name: string } {
  const known = opened.get(stem);
  if (known) return known;
  const bytes = fixture(`RUN/${stem}.ZDB`);
  if (!bytes) throw new Error(`${FIXTURES_ABSENT} (RUN/${stem}.ZDB)`);
  const toc = parseZdb(bytes);
  const graph = parseSceneGraph(Zar.parse(zdbMember(bytes, toc, `${stem}_GEO.ZED`)));
  const root = parseWorldRoot(Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`)));
  const grid = buildGrid(root.grid, [], [], worldCollision(graph), collisionOwners(graph));
  const name = { MP2: 'FROSTFIRE', MP6: 'DESERT GLORY', MP72: 'CROSSROADS' }[stem] ?? stem;
  const made = { graph, grid, name };
  opened.set(stem, made);
  return made;
}
const models = (stem: string): SceneNode[] => open(stem).graph;

/** A row-major, row-vector matrix: a turn about y by `degrees`, then a translation (research 24 section 1.1). */
function turnThenMove(degrees: number, tx: number, ty: number, tz: number): Float32Array {
  const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return Float32Array.from([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1]);
}

/** One `di` polygon, model space: a flat square of side 2 at height `y`, ground (`m_ditype` 3). */
function square(y: number, cameratype = 0): CollisionPoly {
  return {
    region: 0, refcount: 0, ditype: 3, ptcount: 4, material: 25, cameratype, appflags: 0, inside: 0, shadow: 0,
    points: Float32Array.from([-1, y, -1, 1, y, -1, 1, y, 1, -1, y, 1]),
  };
}

/** `m_active` (bit 0) and `m_hasDI` (bit 12) of `tag_NODE_PARAMS` (`zNode/znode.h:78-90`). */
const LIVE = (1 << 0) | (1 << 12);

function node(name: string, type: number, matrix: Float32Array, over: Partial<SceneNode> = {}): SceneNode {
  return {
    name, modelName: null, type, flags: LIVE, matrix, bbox: Float32Array.from([-1, 0, -1, 1, 0, 1]), regionmask: 0,
    visuals: 0, visualParams: [], visualMaterials: [], children: [], collision: [], ...over,
  };
}

describe('the probe\'s polygon set (research 24 section 1.1)', () => {
  it('carries a polygon two levels down by local x parent, row vectors, as FUN_001BFC30 composes them', () => {
    const parent = turnThenMove(90, 100, 10, 200);
    const local = turnThenMove(0, 5, 2, 0);
    const child = node('deck', NODE_GENERIC, local, { collision: [square(0)] });
    const world = node('worldmodel', NODE_GENERIC, parent, { children: [child] });
    const polys = worldCollision([world]);
    expect(polys.length).toBe(1);
    const composed = multiply(local, parent);
    const expected = [...square(0).points].map((_, i, p) => (i % 3 === 0 ? transformPoint(composed, p[i]!, p[i + 1]!, p[i + 2]!) : null))
      .filter((v): v is [number, number, number] => v !== null).flat();
    expect([...polys[0]!.points].map((v) => Math.round(v * 1000) / 1000)).toEqual(expected.map((v) => Math.round(v * 1000) / 1000));
    // The other order would put the child's offset through the parent's turn first: (100 + 5, ...) is not where
    // it lands. The composed first corner is (-1, 0, -1) moved by (5, 2, 0), turned 90 degrees, then moved to
    // (100, 10, 200): x = 100 + (-1) = 99, y = 12, z = 200 - (5 - 1) = 196.
    expect([...polys[0]!.points.slice(0, 3)].map((v) => Math.round(v * 1000) / 1000)).toEqual([99, 12, 196]);
  });

  it('keeps a world-file instance\'s own `di` beside its prototype\'s, and drops a nested instance\'s own copy', () => {
    // `post` is a prototype with one polygon. `rail` is a prototype that instances `post` once. The world instances
    // `post` directly and `rail` once. The exporter writes the prototype's `di` onto every instance node too.
    const post = node('post', NODE_MODEL, IDENTITY, { collision: [square(0)] });
    const postInRail = node('post', NODE_INSTANCE, turnThenMove(0, 10, 0, 0), { modelName: 'post', collision: [square(0)] });
    const rail = node('rail', NODE_MODEL, IDENTITY, { children: [postInRail] });
    const world = node('worldmodel', NODE_GENERIC, IDENTITY, {
      children: [
        node('post', NODE_INSTANCE, turnThenMove(0, 100, 0, 0), { modelName: 'post', collision: [square(0)] }),
        node('rail', NODE_INSTANCE, turnThenMove(0, 200, 0, 0), { modelName: 'rail' }),
      ],
    });
    const scene = [world, post, rail];
    const flat = flattenScene(scene);
    // The engine reads a world-file instance with `CreateInstance(sload)`: a copy of the model, then the node's own
    // `di` read on top by `ReadDataBegin` (reCOM `zNode/node_io.cpp:46-51`, `node_saveload.cpp:49-74`) -- two copies.
    // A nested instance is re-made from its model when its container is copied (`_Copy`, `zNode/node_main.cpp:312-333`),
    // so the file's own `di` on it never reaches the world -- one copy.
    const carried = flat.map((f) => `${f.path}:${worldDi(f).length}`);
    expect(carried).toEqual([
      'worldmodel:0',
      'worldmodel/post:1', 'worldmodel/post=post:1',
      'worldmodel/rail:0', 'worldmodel/rail=rail:0', 'worldmodel/rail=rail/post:0', 'worldmodel/rail=rail/post=post:1',
    ]);
    const xs = worldCollision(scene).map((p) => p.points[0]);
    expect(xs).toEqual([99, 99, 209]);
  });

  it.skipIf(!MP2)('Frostfire: 3,318 world-space polygons within x 120-1200, y 40-241, z 322-1280, the props\' own included', () => {
    const graph = models('MP2');
    const polys = worldCollision(graph);
    expect(polys.length).toBe(3318);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of polys) {
      for (let i = 0; i < p.points.length; i += 3) {
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p.points[i + k]!); hi[k] = Math.max(hi[k]!, p.points[i + k]!); }
      }
    }
    // Research 24 quotes whole units; the extremes are 120, 40 (39.99999), 322.5 and 1200, 241.1, 1280.
    [120, 40, 322].forEach((v, k) => expect(Math.abs(lo[k]! - v)).toBeLessThanOrEqual(1));
    [1200, 241, 1280].forEach((v, k) => expect(Math.abs(hi[k]! - v)).toBeLessThanOrEqual(1));
    // The 20 the viewer used to carry on top: the own `di` of the ten `railpostfiller` instances inside the tank
    // rails, which the engine re-makes from the model (see the synthetic case above). Each has a twin in the set.
    const dropped = flattenScene(graph).filter((f) => f.node.collision.length > 0 && worldDi(f).length === 0);
    expect(dropped.length).toBe(10);
    expect(dropped.reduce((n, f) => n + f.node.collision.length, 0)).toBe(20);
    expect(new Set(dropped.map((f) => f.path.replace(/tankrail\d/g, 'tankrailN')))).toEqual(
      new Set(['worldmodel/bigtank/tankrailN=tankrailN/railpostfiller']));
    const key = (pts: Float32Array): string => [...pts].map((v) => v.toFixed(3)).join(',');
    const kept = new Set(polys.map((p) => key(p.points)));
    for (const f of dropped) {
      for (const poly of f.node.collision) {
        const pts = new Float32Array(poly.points.length);
        for (let i = 0; i < pts.length; i += 3) pts.set(transformPoint(f.world, poly.points[i]!, poly.points[i + 1]!, poly.points[i + 2]!), i);
        expect(kept.has(key(pts))).toBe(true);
      }
    }
    // The 64 type-2 props' polygons are in (research 24 section 1.1): the crates, for one.
    expect(polys.filter((p) => p.path.startsWith('worldmodel/crates1/prop0')).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The probe: FUN_002d3030 per model over the cell's atoms, then FUN_005b5d40's selection.

/** A flat quad polygon, world space: ground (`m_ditype` 3) unless told otherwise. */
function slab(minX: number, minZ: number, maxX: number, maxZ: number, y: number, over: Partial<WorldPoly> = {}): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/slab', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([minX, y, minZ, maxX, y, minZ, maxX, y, maxZ, minX, y, maxZ]), ...over,
  };
}

/** A 2 x 2 grid of 100-unit cells from the origin, the polygons split into owners by the given counts. */
function gridOf(polys: WorldPoly[], counts: number[], flags: (number | undefined)[] = []): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 2, cellsZ: 2, originX: 0, originZ: 0 };
  let first = 0;
  const owners: CollisionOwner[] = counts.map((count, i) => {
    const o: CollisionOwner = { modelName: 'worldmodel', path: `worldmodel/n${i}`, first, count };
    if (flags[i] !== undefined) o.flags = flags[i];
    first += count;
    return o;
  });
  return buildGrid(params, [], [], polys, owners);
}

const ys = (hits: Hit[]): number[] => hits.map((h) => Math.round(h.y * 1000) / 1000 + 0);   // + 0: no -0

describe('probeGround and selectFloor, synthetic (research 23 section 1.1, research 24 section 2)', () => {
  // A floor at y 0 over the whole first cell and a deck at y 42 over part of it, two nodes.
  const deck = gridOf([slab(0, 0, 100, 100, 0), slab(20, 20, 60, 60, 42)], [1, 1]);

  it('a floor at y 0 under a deck at y 42: from origin 5 the floor, from 47 the deck', () => {
    expect(ys(probeGround(deck, 40, 40)).sort((a, b) => a - b)).toEqual([0, 42]);
    expect(selectFloor(probeGround(deck, 40, 40), 5)!.y).toBe(0);
    expect(selectFloor(probeGround(deck, 40, 40), 47)!.y).toBe(42);
    // Only x and z reach the query (research 23 section 1.2): the hits are the same from any height.
    expect(ys(probeGround(deck, 40, 40))).toEqual(ys(probeGround(deck, 40, 40)));
  });

  it('from origin 70 the deck, 28 below: the 20-unit window rejects a pick *over* the feet, not under them', () => {
    // FUN_005b5d40 rejects `pick.y > actor y + 20` (research 23 section 1.1 item 9), so a drop is not refused here;
    // the plan's "nothing" from 70 is what the mover's own drop limit does (viewer walk.ts), not the selection.
    expect(selectFloor(probeGround(deck, 40, 40), 70)!.y).toBe(42);
    // Nothing at or under origin + 1: the lowest candidate, unless it is more than 20 over the feet.
    expect(selectFloor(probeGround(deck, 40, 40), -15, -20)!.y).toBe(0);         // 0 is exactly 20 over: kept
    expect(selectFloor(probeGround(deck, 40, 40), -15.01, -20.01)).toBe(null);   // just over: rejected
    expect(selectFloor(probeGround(deck, 40, 40), -30)).toBe(null);              // actor -35, floor 35 over it
    expect(selectFloor([], 5)).toBe(null);
    // The origin's +1: a floor 6 over the feet (origin + 1) is still "under" and wins over the lower one.
    expect(selectFloor(probeGround(deck, 40, 40), 41, 36)!.y).toBe(42);
    expect(selectFloor(probeGround(deck, 40, 40), 40.99, 35.99)!.y).toBe(0);
    // probeFloor is the two together with the origin at the feet + 5 (research 24 section 2).
    expect(probeFloor(deck, 40, 0, 40)!.y).toBe(0);
    expect(probeFloor(deck, 40, 42, 40)!.y).toBe(42);
    expect(probeFloor(deck, 80, 42, 80)!.y).toBe(0);                             // off the deck: the floor
  });

  it('takes the first hit per model in surface order, and one per model', () => {
    const stacked = gridOf([slab(0, 0, 100, 100, 10), slab(0, 0, 100, 100, 0)], [2]);
    expect(ys(probeGround(stacked, 50, 50))).toEqual([10]);
    const reversed = gridOf([slab(0, 0, 100, 100, 0), slab(0, 0, 100, 100, 10)], [2]);
    expect(ys(probeGround(reversed, 50, 50))).toEqual([0]);
    const apart = gridOf([slab(0, 0, 100, 100, 10), slab(0, 0, 100, 100, 0)], [1, 1]);
    expect(ys(probeGround(apart, 50, 50))).toEqual([10, 0]);
    // A polygon the line misses does not stop the loop: the first *hit* is taken.
    const beside = gridOf([slab(60, 60, 90, 90, 10), slab(0, 0, 100, 100, 0)], [2]);
    expect(ys(probeGround(beside, 20, 20))).toEqual([0]);
  });

  it('skips a surface with bit 18 set and one without bit 0, and the hit carries its polygon and node', () => {
    const skipped = gridOf([slab(0, 0, 100, 100, 10, { cameratype: 1 }), slab(0, 0, 100, 100, 0)], [2]);
    expect(ys(probeGround(skipped, 50, 50))).toEqual([0]);
    const side = gridOf([slab(0, 0, 100, 100, 10, { ditype: 2 }), slab(0, 0, 100, 100, 0)], [2]);
    expect(ys(probeGround(side, 50, 50))).toEqual([0]);
    // cameratype 2 is bit 19, not 18: not skipped.
    const nineteen = gridOf([slab(0, 0, 100, 100, 10, { cameratype: 2 }), slab(0, 0, 100, 100, 0)], [2]);
    expect(ys(probeGround(nineteen, 50, 50))).toEqual([10]);
    const [hit] = probeGround(side, 50, 50);
    expect(hit!.poly).toBe(side.objects[0]!.kind === 'collision' ? side.objects[0]!.polys[1] : null);
    expect(hit!.owner.path).toBe('worldmodel/n0');
    expect([hit!.x, hit!.z]).toEqual([50, 50]);
    expect(hit!.normal[1]).toBeCloseTo(1, 6);
  });

  it('gates each model as FUN_002d3030 does: m_active, m_hasDI, and its layer against the record\'s mask', () => {
    const polys = [slab(0, 0, 100, 100, 0)];
    const live = (1 << 0) | (1 << 12);
    expect(probeGround(gridOf(polys, [1], [live]), 50, 50)).toHaveLength(1);
    expect(probeGround(gridOf(polys, [1], [1 << 12]), 50, 50)).toHaveLength(0);          // not m_active
    expect(probeGround(gridOf(polys, [1], [1 << 0]), 50, 50)).toHaveLength(0);           // no m_hasDI
    const layer5 = live | (5 << 13);                                                     // m_region_shift = 5
    expect(probeGround(gridOf(polys, [1], [layer5]), 50, 50, 0x03)).toHaveLength(0);
    expect(probeGround(gridOf(polys, [1], [layer5]), 50, 50, 0x23)).toHaveLength(1);     // Frostfire's records' mask
    expect(probeGround(gridOf(polys, [1], [layer5]), 50, 50, ALL_LAYERS)).toHaveLength(1);
    expect(probeGround(gridOf(polys, [1]), 50, 50, 0x01)).toHaveLength(1);              // no flags known: let through
  });

  it('asks only the cell that holds (x, z), and reads the height off the polygon\'s plane', () => {
    // A ramp rising 10 over 20 in x (grade 0.5, research 24 section 2 step 4), in cell (1, 0) only.
    const ramp = slab(110, 10, 130, 30, 0);
    ramp.points = Float32Array.from([110, 0, 10, 130, 10, 10, 130, 10, 30, 110, 0, 30]);
    const grid = gridOf([ramp, slab(0, 0, 50, 50, 3)], [1, 1]);
    expect(ys(probeGround(grid, 115, 20))).toEqual([2.5]);
    expect(ys(probeGround(grid, 25, 25))).toEqual([3]);
    expect(probeGround(grid, 75, 75)).toEqual([]);
    // On an edge counts as inside (the two floors of a seam both answer; first-per-model keeps it to one each).
    expect(ys(probeGround(grid, 50, 25))).toEqual([3]);
    // A triangle: inside and outside its hypotenuse.
    const tri = slab(0, 0, 0, 0, 0, { ptcount: 3, points: Float32Array.from([0, 7, 0, 40, 7, 0, 0, 7, 40]) });
    const g2 = gridOf([tri], [1]);
    expect(ys(probeGround(g2, 10, 10))).toEqual([7]);
    expect(probeGround(g2, 30, 30)).toEqual([]);
  });
});

describe('the probe on the fixture maps', () => {
  it.skipIf(!MP2)('returns Frostfire\'s two spawns, measured off the actor block, within [-3, +1] of their y (research 24 section 3)', () => {
    // KNOWN section 1's rows: the actor's own position at round start (spawns.ts, 'KNOWN section 1').
    const { grid } = open('MP2');
    const spawns = spawnsFor('FROSTFIRE')!;
    const residuals = [spawns.a, spawns.b].map(([x, y, z]) => probeFloor(grid, x, y, z)!.y - y);
    expect(residuals.map((r) => Math.round(r * 1000) / 1000)).toEqual([0, -1]);
    for (const r of residuals) { expect(r).toBeGreaterThanOrEqual(-3); expect(r).toBeLessThanOrEqual(1); }
  });

  it.skipIf(!MP6 || !MP72)('finds one floor 18-30 under Desert Glory\'s and Crossroads\' table rows, which are the orbit camera, not the feet', () => {
    // Research 33's spawn column is `online_match_ours`'s `[peek] @416054` row -- "the local player's ORBITING
    // CAMERA record" (tools_py/parity/online_match_ours.py:42-45; Vigilance's is (542.3, 1479.9) at :174 against
    // the actor's (540, 1456) in KNOWN section 1). So the probe's [-3, +1] cannot hold at these four; what holds is
    // a floor under each, the camera's height over it, 25 on flat ground. Pinned here so a re-measured table shows.
    for (const stem of ['MP6', 'MP72']) {
      const { grid, name } = open(stem);
      const spawns = spawnsFor(name)!;
      for (const [x, y, z] of [spawns.a, spawns.b]) {
        const floor = probeFloor(grid, x, y, z);
        expect(floor, `${name} (${x}, ${y}, ${z})`).not.toBe(null);
        expect(y - floor!.y, `${name} (${x}, ${y}, ${z})`).toBeGreaterThanOrEqual(18);
        expect(y - floor!.y, `${name} (${x}, ${y}, ${z})`).toBeLessThanOrEqual(30);
      }
    }
  });

  it.skipIf(!MP2)('Frostfire\'s walkway column (x 705-735, z 975-1000): 142 and 100, and from y 100 the lower (research 24 section 4.2)', () => {
    const { grid } = open('MP2');
    for (const [x, z] of [[710, 980], [720, 990], [730, 998]] as const) {
      const floors = ys(probeGround(grid, x, z)).map(Math.round);
      expect(floors, `(${x}, ${z})`).toContain(142);
      expect(floors, `(${x}, ${z})`).toContain(100);
      expect(probeFloor(grid, x, 100, z)!.y, `(${x}, ${z})`).toBeCloseTo(100, 3);
      expect(probeFloor(grid, x, 142, z)!.y, `(${x}, ${z})`).toBeCloseTo(142, 3);
    }
  });

  it.skipIf(!MP2)('the 142 deck\'s east corner (x 674-680, z 720-726) is the engine\'s hole: pipeworks\' box top at 112 is its first hit', () => {
    // Research 90 #2. The deck (pipeworks' di #14, y 142) and a 6x6 box top under its corner (#4, y 112) are one node's
    // polygons, and FUN_002d3030 stops at a model's first hit in surface order. SOCOM II's AddDI appends
    // (FUN_00313d60: the insert at `+0x7c + count * 4`, the vector's end), so the surface order is the file's and #4
    // comes first -- where reCOM's SOCOM I transcription prepends (`node_main.cpp:153`, `m_di.insert(m_di.begin(), di)`)
    // and would have found the deck. So from the deck the probe picks 112 at the corner, on the console as here.
    const { grid } = open('MP2');
    for (const [x, z] of [[674.5, 720.5], [677, 723], [679.5, 725.5]] as const) {
      expect(ys(probeGround(grid, x, z)).map(Math.round).sort(), `(${x}, ${z})`).toEqual([100, 112]);
      expect(probeFloor(grid, x, 142, z)!.y, `(${x}, ${z})`).toBeCloseTo(112, 3);
    }
    expect(probeFloor(grid, 668, 142, 722)!.y).toBeCloseTo(142, 3);      // beside the box, the deck
  });
});
