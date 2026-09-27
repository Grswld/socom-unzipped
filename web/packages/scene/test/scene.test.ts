import { describe, it, expect } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { bounds, interpretChain, mergeMeshes, walkChain, type MeshData } from '@s2u/mesh';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  countInstances, expectedChunks, flattenScene, loadModelLibrary, multiply, parseSceneGraph,
  parseWorldRoot, placeCollision, placeInstances, toColumnMajor, transformPoint, visualNodes,
  IDENTITY, NODE_GENERIC, NODE_INSTANCE, NODE_MODEL, type ModelLibrary, type PlacedModel, type SceneNode, VISUAL_FLAG_CULL,
} from '../src/index';

/** Frostfire's two measured spawns (36 section 6), in game units, feet on the floor. */
const SPAWN_A: [number, number, number] = [796, 100, 614];
const SPAWN_B: [number, number, number] = [536, 143, 1254];

/**
 * The map archives, or null where the fixture has not been extracted. Reading the file is safe here;
 * *parsing* it is not, because vitest runs a suite's body at collection even when the suite is skipped.
 * So every archive is opened lazily, from inside a test, behind `it.skipIf`.
 */
const MP2 = fixture('RUN/MP2.ZDB');
const MP6 = fixture('RUN/MP6.ZDB');
const MP72 = fixture('RUN/MP72.ZDB');

interface Opened {
  /** Any member of the archive, by the suffix `zdbMember` matches on. */
  zar(suffix: string): Zar;
  models: SceneNode[];
  library: ModelLibrary;
  placed: PlacedModel[];
}

const opened = new Map<string, Opened>();

/** Opens a map once and remembers it. Only ever called from inside a test. */
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
    placed: placeInstances(models),
  };
  opened.set(stem, made);
  return made;
}

/** Every node of the forest, depth first, the roots included. */
function everyNode(nodes: SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const rec = (n: SceneNode) => { out.push(n); for (const c of n.children) rec(c); };
  for (const n of nodes) rec(n);
  return out;
}

describe('matrices (24 section 1.1: row-vector, world = local x parent)', () => {
  it('multiplies in row-vector order: translating then scaling scales the translation', () => {
    const translate = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);
    const scale = Float32Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    // A point at the origin, moved by the local translate and then by the parent scale, lands at 20.
    expect(transformPoint(multiply(translate, scale), 0, 0, 0)).toEqual([20, 0, 0]);
    // The other order is the one the engine does not use: the scale happens first, so the point lands at 10.
    expect(transformPoint(multiply(scale, translate), 0, 0, 0)).toEqual([10, 0, 0]);
  });

  it('hands three.js the stored floats unchanged: the transpose and the layout flip cancel', () => {
    const m = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect([...toColumnMajor(m)]).toEqual([...m]);
    expect(toColumnMajor(m)).not.toBe(m);                     // a copy, so the caller can keep both
    // The translation is three.js's elements 12..14, which is also the engine's fourth row.
    const t = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 960, 0, 800, 1]);
    expect([...toColumnMajor(t).slice(12, 15)]).toEqual([960, 0, 800]);
    // What a three.js Matrix4 then does with a point is what the engine's row-vector product does.
    const yaw = Float32Array.from([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 0, 0, 1]);
    const e = toColumnMajor(yaw);
    const times = (x: number, y: number, z: number): [number, number, number] => [
      e[0]! * x + e[4]! * y + e[8]! * z + e[12]!,
      e[1]! * x + e[5]! * y + e[9]! * z + e[13]!,
      e[2]! * x + e[6]! * y + e[10]! * z + e[14]!,
    ];
    expect(times(1, 0, 0)).toEqual(transformPoint(yaw, 1, 0, 0));
  });
});

describe('Frostfire scene graph', () => {
  it.skipIf(!MP2)('reads the world root (36 section 2)', () => {
    const { zar } = open('MP2');
    const world = parseWorldRoot(zar('MP2.ZED'));
    expect(world.metersPerUnit).toBeCloseTo(0.1, 6);
    expect(world.defaultMaterial).toBe('METAL_THICK');
    expect(world.nightMission).toBe(false);
    expect(world.shadowVector.map((v) => Number(v.toFixed(3)))).toEqual([-0.811, -0.2, 0.55]);
    // `TextureScroll_Object`: the three ocean chunks and the sky horizon scroll, nothing else does.
    expect(world.textureScroll.map((b) => `${b.nodeName} ${b.du.toFixed(2)},${b.dv.toFixed(2)}`).sort()).toEqual([
      'ocean_1 -0.04,-0.04', 'ocean_2 0.04,0.04', 'ocean_3 0.00,0.02', 'skyhorizon 0.00,0.02',
    ]);
    expect(world.textureScroll.every((b) => b.modelName === 'alaska1a_sky')).toBe(true);
  });

  it.skipIf(!MP2)('marks the facade nodes -- the flares -- and nothing else (m_facade, node flags bits 8-9)', () => {
    const { models } = open('MP2');
    const placed = placeInstances(models);
    const facades = placed.filter((p) => p.facade !== 0);
    expect(facades.length).toBeGreaterThan(0);
    expect(facades.every((p) => /flare|g\d/.test(p.path))).toBe(true);
    // A shadow quad or a lamp body is never a facade, whatever its shape.
    expect(placed.filter((p) => /shadow|lightcage$|light01$/.test(p.path)).every((p) => p.facade === 0)).toBe(true);
  });

  it.skipIf(!MP2)('reads the params word of each visual, whose bit 3 is the cull the EE emits (vis_main, FUN_003b5f20 flags & 8)', () => {
    const { models } = open('MP2');
    let set = 0, clear = 0;
    const clearOn: string[] = [];
    const walk = (n: SceneNode, path: string): void => {
      expect(n.visualParams.length).toBe(n.visuals);
      for (const w of n.visualParams) { if (w & VISUAL_FLAG_CULL) set++; else { clear++; clearOn.push(path); } }
      for (const c of n.children) walk(c, `${path}/${c.name}`);
    };
    for (const m of models) walk(m, m.name);
    // 177 visuals on Frostfire (36 section 2): the cull is set on the solid things and clear on the 19
    // drawn from both sides -- the ladders among them, whose rungs vanished from behind under the old
    // rule that culled wherever the texture was solid.
    expect(set + clear).toBe(177);
    expect(clear).toBe(19);
    for (const ladder of ['worldmodel/lad1', 'worldmodel/lad2', 'worldmodel/ldr', 'worldmodel/laddrilltower']) {
      expect(clearOn, ladder).toContain(ladder);
    }
    // And the placements carry it per chunk, in chunk order.
    const placed = placeInstances(models);
    for (const p of placed) expect(p.cull.length).toBe(p.chunks.length);
    expect(placed.some((p) => p.cull.includes(false))).toBe(true);
  });

  it.skipIf(!MP2)('yields 46 prototypes, 206 instance nodes and 2,756 collision polygons (36 section 2)', () => {
    const { models } = open('MP2');
    expect(models.length).toBe(46);
    const all = everyNode(models);
    expect(all.filter((n) => n.modelName !== null).length).toBe(206);
    expect(all.filter((n) => n.modelName !== null).every((n) => n.type === NODE_INSTANCE)).toBe(true);
    expect(all.reduce((n, node) => n + node.visuals, 0)).toBe(177);
    const polys = all.flatMap((n) => n.collision);
    expect(polys.length).toBe(2756);
    // 36 section 6: the decoded ptcount is the point count, in every polygon.
    expect(polys.every((p) => p.points.length / 3 === p.ptcount)).toBe(true);
    // 36 section 6 says `m_refcount` is 0x2d "in every sample read"; over all 2,756 it is not -- the
    // samples were narrow. What does hold is the region word: 2,477 polygons in region 0, 279 in 34.
    expect(new Set(polys.map((p) => p.region))).toEqual(new Set([0, 34]));
    expect(polys.filter((p) => p.region === 0).length).toBe(2477);
    // 36 section 6's Frostfire histogram of (ditype, ptcount), top to bottom.
    const shape = new Map<string, number>();
    for (const p of polys) shape.set(`${p.ditype},${p.ptcount}`, (shape.get(`${p.ditype},${p.ptcount}`) ?? 0) + 1);
    expect([...shape].sort((a, b) => b[1] - a[1]).slice(0, 6))
      .toEqual([['2,4', 1743], ['3,4', 736], ['2,3', 184], ['3,3', 43], ['3,6', 22], ['3,5', 15]]);
  });

  it.skipIf(!MP2)('resolves every instance name in the model library, with nothing missing', () => {
    const { zar, models, library } = open('MP2');
    const wanted = new Set(everyNode(models).map((n) => n.modelName).filter((n): n is string => n !== null));
    expect([...wanted].filter((n) => library.get(n) === undefined)).toEqual([]);
    expect(library.skipped).toEqual([]);
    // 36 section 2: character models are a MESH_ chain form and are not part of a map's scene graph.
    expect(loadModelLibrary([zar('CLIB_MDL.ZED')]).names()).toEqual([]);
  });

  it.skipIf(!MP2)('numbers the 194 worldmodel children the way SEMANTICS section 8 counted them', () => {
    const { models } = open('MP2');
    const children = models.find((m) => m.name === 'worldmodel')!.children;
    expect(children.length).toBe(194);
    expect(new Set(children.map((c) => [...c.matrix].join(','))).size).toBe(70);
    const translations = children.map((c) => [...c.matrix.slice(12, 15)].join(','));
    expect(translations.filter((t) => t === '960,0,800').length).toBe(118);
    // SEMANTICS section 8: where the world nodes carry that translation they are pure translations.
    const pure = children.filter((c) => [...c.matrix.slice(12, 15)].join(',') === '960,0,800');
    expect(pure.every((c) => [...c.matrix.slice(0, 12)].join(',') === '1,0,0,0,0,1,0,0,0,0,1,0')).toBe(true);
  });
});

describe('which placements the engine lights', () => {
  /** A bare node: no children, no collision, one visual. */
  const node = (name: string, flags: number, over: Partial<SceneNode> = {}): SceneNode => ({
    name, modelName: null, type: NODE_GENERIC, flags, matrix: Float32Array.from(IDENTITY),
    bbox: new Float32Array(6), regionmask: 0, visuals: 1, visualParams: [0], children: [], collision: [], ...over,
  });

  it('a node with neither dynamic bit is drawn prelit: the VU light command is never emitted for it', () => {
    const root = node('worldmodel', 1 | (1 << 4) | (1 << 6), { type: NODE_MODEL });
    expect(placeInstances([root]).map((p) => p.lit)).toEqual([false]);
  });

  it('bit 1 (dynamic motion) or bit 2 (dynamic light) on the node asks for the light command', () => {
    for (const bit of [1, 2]) {
      const root = node('worldmodel', 1 | (1 << 4), { type: NODE_MODEL, children: [node('lamp', 1 | (1 << bit))] });
      expect(placeInstances([root]).map((p) => p.lit), `bit ${bit}`).toEqual([false, true]);
    }
  });

  it('an instance of a model whose own node carries the bit is lit too', () => {
    const fern = node('fern', 1 | (1 << 1), { type: NODE_MODEL });
    const root = node('worldmodel', 1, { type: NODE_MODEL, children: [node('fern_1', 1, { type: NODE_INSTANCE, modelName: 'fern', visuals: 0 })] });
    const placed = placeInstances([root, fern]);
    expect(placed.map((p) => [p.modelName, p.lit])).toEqual([['worldmodel', false], ['fern', true]]);
  });

  it.skipIf(!MP2)('no Frostfire placement is lit: the whole map is drawn from its baked vertex colours', () => {
    const { placed } = open('MP2');
    expect(placed.some((p) => p.lit)).toBe(false);
  });
});

describe('Frostfire placement', () => {
  it.skipIf(!MP2)('gives every world chunk its own node matrix, so all 123 are placed and none is left over', () => {
    const { library, placed } = open('MP2');
    const world = placed.filter((p) => p.modelName === 'worldmodel');
    expect(world.length).toBe(101);                               // visual-bearing nodes, vis_main.cpp:88-105
    const chunks = world.flatMap((p) => p.chunks);
    expect(chunks.length).toBe(123);
    expect(new Set(chunks).size).toBe(123);
    expect(new Set(library.get('worldmodel')!.nodes.map((n) => n.name))).toEqual(new Set(chunks));
    // The mapping is not the stopgap: the chunks do not all share one matrix.
    expect(new Set(world.map((p) => [...p.world].join(','))).size).toBeGreaterThan(1);
  });

  it.skipIf(!MP2)('places every prop chunk against a chain the library actually holds', () => {
    const { library, placed } = open('MP2');
    const props = placed.filter((p) => p.modelName !== 'worldmodel');
    expect(props.length).toBeGreaterThan(200);
    for (const p of props) {
      const names = new Set(library.get(p.modelName)!.nodes.map((n) => n.name));
      for (const chunk of p.chunks) expect(names.has(chunk)).toBe(true);
    }
  });

  it.skipIf(!MP2)('counts the instance contexts the exporter wrote keys for (vis_main.cpp:77-111)', () => {
    const { models, library } = open('MP2');
    const counts = countInstances(models);
    // The six models whose key count only comes out right once nested instancing is expanded.
    expect(counts.get('tankrailsupport')).toBe(28);
    expect(counts.get('tankrailbarslo')).toBe(18);
    expect(counts.get('railstraithi1')).toBe(15);
    expect(counts.get('railpostfiller')).toBe(14);
    expect(counts.get('grate_midlod')).toBe(26);
    expect(counts.get('worldmodel')).toBe(0);
    // Every model's key set is exactly what the naming rule predicts from its nodes and its contexts.
    for (const model of models) {
      const entry = library.get(model.name);
      if (!entry) continue;
      expect(new Set(entry.nodes.map((n) => n.name)))
        .toEqual(new Set(expectedChunks(model, counts.get(model.name) ?? 0)));
    }
  });

  it.skipIf(!MP2)('puts a collision polygon under both spawns, at their measured heights (36 section 6)', () => {
    const { models } = open('MP2');
    const polys = placeCollision(models);
    expect(polys.length).toBeGreaterThan(2756);       // an instanced model contributes its polys per instance
    for (const [spawn, expected] of [[SPAWN_A, 100], [SPAWN_B, 142]] as [[number, number, number], number][]) {
      const hits = polys
        .map((p) => ({
          distance: horizontalDistance(p.points, spawn[0], spawn[2]),
          height: planeHeight(p.points, spawn[0], spawn[2]),
        }))
        .filter((h) => h.distance <= 40 && h.height !== null && h.height - spawn[1] >= -5 && h.height - spawn[1] <= 5)
        .sort((a, b) => a.distance - b.distance);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.distance).toBe(0);
      expect(hits[0]!.height).toBeCloseTo(expected, 3);
    }
  });

  it.skipIf(!MP2)('still has a world floor under each spawn once the chunks are placed one by one (task 12)', () => {
    const { library, placed } = open('MP2');
    const entry = library.get('worldmodel')!;
    const offsets = new Map(entry.nodes.map((n) => [n.name, n.offset]));
    const world = placed.filter((q) => q.modelName === 'worldmodel');
    const floors: ({ y: number; chunk: string; texture: string | null } | null)[] = [];
    for (const spawn of [SPAWN_A, SPAWN_B]) {
      let best: { y: number; chunk: string; texture: string | null } | null = null;
      for (const p of world) {
        for (const chunk of p.chunks) {
          for (const mesh of interpretChain(walkChain(entry.buffer, offsets.get(chunk)!, chunk))) {
            const y = highestFloorUnder(mesh, p.rowMajor, spawn);
            if (y !== null && (best === null || y > best.y)) best = { y, chunk, texture: mesh.textureName };
          }
        }
      }
      floors.push(best);
    }
    // SEMANTICS section 8 named both chunks and both textures with the modal translation; the per-node
    // placement has to reproduce them exactly, or it has moved the world.
    expect(floors[0]).toEqual({ y: 100, chunk: 'N013_000', texture: 'floor_oilgrime.tif' });
    expect(floors[1]).toEqual({ y: 142, chunk: 'N038_000', texture: 'floor_oilgrime.tif' });
  });

  it.skipIf(!MP2)('keeps every placed prop over the deck, which only the row-vector order does', () => {
    const { models, library, placed } = open('MP2');
    // The world's own collision polygons are the tight extent to test against -- the drawn world also
    // holds the sky chunk at y = 1442 and a skirt biased to +-2000, which would let anything through.
    const deck = extentOf(placeCollision(models).filter((p) => p.modelName === 'worldmodel').map((p) => p.points));
    expect(deck.min.map((v) => Math.round(v))).toEqual([120, 40, 323]);
    expect(deck.max.map((v) => Math.round(v))).toEqual([1200, 241, 1280]);

    let props = 0;
    const strayed: string[] = [];
    for (const p of placed) {
      if (p.modelName === 'worldmodel') continue;
      const entry = library.get(p.modelName)!;
      const where = new Map(entry.nodes.map((n) => [n.name, n.offset]));
      const parts: MeshData[] = [];
      for (const chunk of p.chunks) parts.push(...interpretChain(walkChain(entry.buffer, where.get(chunk)!, chunk)));
      if (parts.length === 0) continue;
      props++;
      const b = bounds(mergeMeshes(parts));
      const c = transformPoint(p.rowMajor, (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      // Horizontally over the deck, and vertically between it and the top of the drill tower.
      const over = c[0] >= deck.min[0]! && c[0] <= deck.max[0]! && c[2] >= deck.min[2]! && c[2] <= deck.max[2]!
        && c[1] >= deck.min[1]! - 10 && c[1] <= deck.max[1]! + 120;
      if (!over) strayed.push(`${p.modelName} ${p.path} at ${c.map((v) => v.toFixed(1)).join(',')}`);
    }
    expect(props).toBe(347);
    // The falsification: composing parent x local instead sends 153 of these 347 off the deck, the worst
    // of them 2,105 units away, so this assertion is what holds the convention in place.
    expect(strayed).toEqual([]);
  });

  it.skipIf(!MP2)('realises the scene as a forest rooted at worldmodel, with the instance matrices accumulated', () => {
    const { models } = open('MP2');
    const flat = flattenScene(models, 'worldmodel');
    // The root's world matrix is its own: nothing above it to multiply by but the identity.
    expect([...flat[0]!.world]).toEqual([...multiply(models.find((m) => m.name === 'worldmodel')!.matrix, IDENTITY)]);
    // 26 grates, each a separate realisation of one prototype.
    expect(flat.filter((f) => f.modelName === 'grate_midlod' && f.node.visuals > 0).length).toBe(26);
    expect(new Set(flat.map((f) => f.modelName)).size).toBeGreaterThan(30);
  });
});

/**
 * The naming rule, checked on every map in the fixtures rather than only on the one it was read off.
 *
 * This is the assertion that tells the two possible failures apart. Desert Glory and Crossroads have
 * prop chains the `mesh` decoder cannot read (15 and 29 of them); if the numbering were wrong instead,
 * the *key sets* would not line up, and they do -- exactly, for all 203 models of the three maps. So the
 * bad chains are a decoder gap, not a placement one.
 */
describe('the N-I-V naming rule across the fixtures', () => {
  for (const [stem, bytes, models] of [
    ['MP2', MP2, 46], ['MP6', MP6, 87], ['MP72', MP72, 70],
  ] as [string, Uint8Array | null, number][]) {
    it.skipIf(!bytes)(`${stem}: every model's chunk keys are what the rule predicts`, () => {
      const map = open(stem);
      expect(map.models.length).toBe(models);
      const counts = countInstances(map.models);
      const wrong: string[] = [];
      let checked = 0;
      for (const model of map.models) {
        const entry = map.library.get(model.name);
        if (!entry) continue;
        checked++;
        const actual = new Set(entry.nodes.map((n) => n.name));
        const predicted = new Set(expectedChunks(model, counts.get(model.name) ?? 0));
        const missing = [...predicted].filter((k) => !actual.has(k));
        const extra = [...actual].filter((k) => !predicted.has(k));
        if (missing.length > 0 || extra.length > 0) {
          wrong.push(`${model.name}: ${visualNodes(model).length} visual nodes x ${counts.get(model.name)} contexts` +
            ` predicts ${predicted.size} keys, the buffer has ${actual.size}` +
            ` -- missing [${missing.slice(0, 6).join(' ')}], extra [${extra.slice(0, 6).join(' ')}]`);
        }
      }
      expect(checked).toBe(models);
      expect(wrong).toEqual([]);
      expect(map.library.skipped).toEqual([]);
    });

    /**
     * `hookupVisuals:73-75` reads `node->m_visual.size() != 0 || node->m_hasVisuals`, and `m_hasVisuals`
     * is *not* "this node has visuals": `AddVisual` calls `SetParentHasVisuals`, which walks up and sets
     * it on every ancestor (`zNode/node_main.cpp:133-145`, `:538-545`). Taken literally the `||` would
     * number visual-less ancestors too, and the keys would shift. There are 10 such ancestors on MP2, 63
     * on MP6 and 7 on MP72, so if the wider predicate were right the test above could not pass. It does,
     * so the archives are numbered by the `visuals` key alone -- which is what `visualNodes` uses.
     */
    it.skipIf(!bytes)(`${stem}: the numbering counts nodes with visuals, not nodes with visuals below`, () => {
      const map = open(stem);
      const below = (n: SceneNode): boolean =>
        n.visuals > 0 || n.children.some((c) => c.type !== NODE_INSTANCE && below(c));
      let ancestors = 0;
      const walk = (n: SceneNode): void => {
        if (n.visuals === 0 && n.children.some((c) => c.type !== NODE_INSTANCE && below(c))) ancestors++;
        for (const c of n.children) if (c.type !== NODE_INSTANCE) walk(c);
      };
      for (const model of map.models) walk(model);
      expect(ancestors).toBe({ MP2: 10, MP6: 63, MP72: 7 }[stem]);
      // And no bit of `nparams`' flag word is a usable `m_hasVisuals` either: none is set on exactly the
      // nodes that carry a `visuals` key, on any of the three maps.
      const flagged: number[] = [];
      for (let bit = 0; bit < 32; bit++) {
        let hit = 0, falsePositive = 0, falseNegative = 0;
        const count = (n: SceneNode): void => {
          const on = ((n.flags >>> bit) & 1) === 1;
          if (on && n.visuals > 0) hit++;
          else if (on) falsePositive++;
          else if (n.visuals > 0) falseNegative++;
          for (const c of n.children) count(c);
        };
        for (const model of map.models) count(model);
        if (hit > 0 && falsePositive === 0 && falseNegative === 0) flagged.push(bit);
      }
      expect(flagged).toEqual([]);
    });
  }
});

/** The height of a polygon's plane over (x, z), or null when the polygon is vertical there. */
function planeHeight(points: Float32Array, x: number, z: number): number | null {
  const n = points.length / 3;
  let nx = 0, ny = 0, nz = 0;                                 // Newell's normal: works for any convex polygon
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    nx += (points[a + 1]! - points[b + 1]!) * (points[a + 2]! + points[b + 2]!);
    ny += (points[a + 2]! - points[b + 2]!) * (points[a]! + points[b]!);
    nz += (points[a]! - points[b]!) * (points[a + 1]! + points[b + 1]!);
  }
  if (Math.abs(ny) < 1e-6) return null;
  const d = nx * points[0]! + ny * points[1]! + nz * points[2]!;
  return (d - nx * x - nz * z) / ny;
}

/** How far (x, z) is from the polygon's footprint: 0 inside it, the nearest edge distance outside. */
function horizontalDistance(points: Float32Array, x: number, z: number): number {
  const n = points.length / 3;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = i * 3, b = j * 3;
    if ((points[a + 2]! > z) !== (points[b + 2]! > z) &&
        x < (points[b]! - points[a]!) * (z - points[a + 2]!) / (points[b + 2]! - points[a + 2]!) + points[a]!) inside = !inside;
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    const dx = points[b]! - points[a]!, dz = points[b + 2]! - points[a + 2]!;
    const len = dx * dx + dz * dz;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - points[a]!) * dx + (z - points[a + 2]!) * dz) / len)) : 0;
    best = Math.min(best, Math.hypot(x - (points[a]! + t * dx), z - (points[a + 2]! + t * dz)));
  }
  return best;
}

/** The highest triangle of a placed mesh that is under the spawn's feet, or null when none is. */
function highestFloorUnder(mesh: MeshData, world: Float32Array, spawn: [number, number, number]): number | null {
  let best: number | null = null;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const p = [0, 1, 2].map((j) => {
      const i = mesh.indices[t + j]!;
      return transformPoint(world, mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!);
    });
    const a = p[0]!, b = p[1]!, c = p[2]!;
    const s1 = (spawn[0] - b[0]!) * (a[2]! - b[2]!) - (a[0]! - b[0]!) * (spawn[2] - b[2]!);
    const s2 = (spawn[0] - c[0]!) * (b[2]! - c[2]!) - (b[0]! - c[0]!) * (spawn[2] - c[2]!);
    const s3 = (spawn[0] - a[0]!) * (c[2]! - a[2]!) - (c[0]! - a[0]!) * (spawn[2] - a[2]!);
    if (((s1 < 0) || (s2 < 0) || (s3 < 0)) && ((s1 > 0) || (s2 > 0) || (s3 > 0))) continue;
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    const ny = uz * vx - ux * vz;
    if (Math.abs(ny) < 1e-9) continue;
    const y = a[1]! + ((uy * vz - uz * vy) * (a[0]! - spawn[0]) + (ux * vy - uy * vx) * (a[2]! - spawn[2])) / ny;
    if (y <= spawn[1] + 1 && (best === null || y > best)) best = y;
  }
  return best;
}

/** The axis-aligned extent of a pile of xyz triples. */
function extentOf(pieces: Float32Array[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = piece[i + a]!;
        if (v < min[a]!) min[a] = v;
        if (v > max[a]!) max[a] = v;
      }
    }
  }
  return { min, max };
}
