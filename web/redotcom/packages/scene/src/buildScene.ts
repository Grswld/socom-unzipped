import { chunkKey } from './modelLibrary';
import {
  IDENTITY, multiply, toColumnMajor, transformPoint, NODE_INSTANCE, type CollisionPoly, type SceneNode, NODE_FLAGS_LIT,
  VISUAL_FLAG_CULL, facadeOf } from './sceneGraph';

/**
 * Turning `MP*_GEO.ZED`'s prototype forest into placements: what gets drawn where, and which chain in
 * which model buffer draws it.
 *
 * The rule is `hookupVisuals` (`research/recom/src/gamez/zVisual/vis_main.cpp:58-175`). A model's chunk
 * keys are numbered `N` by the model's own visual-bearing nodes, depth first, never descending through
 * an instance; `I` by the model's instance contexts; `V` by the node's visuals. So a chunk does not
 * belong to "the world" as a whole -- it belongs to one node of the world, and takes that node's matrix
 * times every matrix above it.
 */

/** A realised node: one node of one model, in one context, with its matrix accumulated to the root. */
export interface SceneInstance {
  /** The model whose buffer holds this node's chunks. */
  modelName: string;
  node: SceneNode;
  /** Its index among the model's visual-bearing nodes -- the chunk key's `N` -- or -1 when it has none. */
  nodeIndex: number;
  /** The chunk key's `I`, or null when the model has no instances and takes the fallback naming. */
  instanceIndex: number | null;
  /** Row-major, row-vector: this node's matrix times every parent's, up to the root (24 section 1.1). */
  world: Float32Array;
  /** The path of node names from the root, for diagnostics. */
  path: string;
  /**
   * `m_facade` on this node or on any node above it in the walk: the engine applies the facade to
   * the matrix stack, so everything under a flagged node turns with it.
   */
  facade: number;
  /**
   * Whether the node was reached through a realised prototype -- inside an instance's model rather than in
   * the root model's own tree. It decides whether an instance node's own `di` reaches the world (`worldDi`).
   */
  nested: boolean;
}

/** One drawn placement: a node's chunks and the matrix that puts them in the world. */
export interface PlacedModel {
  modelName: string;
  path: string;
  nodeIndex: number;
  instanceIndex: number | null;
  /** The chain keys of `modelName`'s buffer this placement draws, one per visual. */
  chunks: string[];
  /** Per chunk, in `chunks` order: whether the engine culls its back faces (`VISUAL_FLAG_CULL`). */
  cull: boolean[];
  /** Per chunk: its `Material_Palette` entry, 1-based, 0 for none (`SceneNode.visualMaterials`). Absent on one built by hand. */
  material?: number[];
  /** `m_facade` on this node: non-zero, the engine turns it to face the camera (`facadeOf`). */
  facade: number;
  /** 16 floats, column-major: what three.js wants (the transpose of `rowMajor`). */
  world: Float32Array;
  /** 16 floats, row-major, as the engine computes it. */
  rowMajor: Float32Array;
  /**
   * Whether the engine lights this placement on VU1 -- `NODE_FLAGS_LIT` on its node or on the model it
   * instances. False on every node of most maps: the multiplayer world is drawn from the vertex colours
   * the exporter baked, and only the odd fern, palm or flare is lit at run time.
   */
  lit: boolean;
  /**
   * The node's own `nparams` bbox, model space (min xyz, max xyz): what the grid files the placement by,
   * carried through `rowMajor` (`grid.ts`, `worldFootprint`). Absent on a placement built by hand.
   */
  bbox?: Float32Array;
}

/** One collision polygon, placed: its points carried into the world frame. */
export interface PlacedCollision {
  modelName: string;
  path: string;
  poly: CollisionPoly;
  /** xyz per point, world space. */
  points: Float32Array;
}

/** A prototype that instances itself, directly or through others, would never stop expanding. */
const MAX_DEPTH = 16;

/**
 * How many instance contexts the exporter wrote chunk keys for, per model.
 *
 * A model's subtree is realised once as the prototype itself and once more for every context its
 * container is realised in, so `contexts(C) = sum over containers M of (1 + contexts(M)) * howOftenMContainsC`,
 * and the world model, which nothing contains, has none. Frostfire's six nested rail models are the
 * evidence: `tankrailsupport` has 4 instance nodes in the graph but 28 `I` keys in the buffer, and only
 * this recursion reaches 28.
 */
export function countInstances(models: SceneNode[]): Map<string, number> {
  const containers = new Map<string, Map<string, number>>();     // model -> container -> how many times
  for (const model of models) {
    const rec = (node: SceneNode): void => {
      for (const child of node.children) {
        if (child.type === NODE_INSTANCE && child.modelName !== null) {
          const byContainer = containers.get(child.modelName) ?? new Map<string, number>();
          byContainer.set(model.name, (byContainer.get(model.name) ?? 0) + 1);
          containers.set(child.modelName, byContainer);
        }
        rec(child);
      }
    };
    rec(model);
  }

  const counts = new Map<string, number>();
  const busy = new Set<string>();
  const contexts = (name: string): number => {
    const known = counts.get(name);
    if (known !== undefined) return known;
    if (busy.has(name)) throw new Error(`model ${name} instances itself, directly or through another model`);
    busy.add(name);
    let total = 0;
    for (const [container, times] of containers.get(name) ?? []) total += (1 + contexts(container)) * times;
    busy.delete(name);
    counts.set(name, total);
    return total;
  };
  for (const model of models) contexts(model.name);
  for (const name of containers.keys()) contexts(name);
  return counts;
}

/**
 * How many instance contexts of each model the load has created by the time it reaches `rootName`: the
 * first `I` index the root's own realisations take.
 *
 * `hookupVisuals` numbers a model's contexts by its `m_list` (`vis_main.cpp:77-111`), the instance nodes in
 * the order the load created them. The graph's models are read in file order, and reading a model creates
 * one context per instance node in its tree, depth first, each copy re-making the instances inside the
 * prototype it copies (`CNode::CreateInstance`, `CNode::_Copy`, `zNode/node_main.cpp:312-333`) -- the same
 * recursion `countInstances` sums. The world model is read last, so every prototype's own contexts (the
 * copies inside other prototypes, never placed and never prelit) come first and the world's placements
 * take the numbers after them. Frostfire's tank rails are the evidence: `tankrailbarshi`'s `I000` is the
 * bare material colour, (128, 109, 35) on every vertex, and `I001`..`I017` the seventeen prelit rails.
 */
export function contextsBefore(models: SceneNode[], rootName = 'worldmodel'): Map<string, number> {
  const byName = new Map(models.map((m) => [m.name, m]));
  const created = new Map<string, number>();
  const create = (name: string, depth: number): void => {
    created.set(name, (created.get(name) ?? 0) + 1);
    const prototype = byName.get(name);
    if (prototype && depth < MAX_DEPTH) instancesIn(prototype, depth + 1);
  };
  const instancesIn = (node: SceneNode, depth: number): void => {
    for (const child of node.children) {
      if (child.type === NODE_INSTANCE) { if (child.modelName !== null) create(child.modelName, depth); }
      else instancesIn(child, depth);
    }
  };
  for (const model of models) {
    if (model.name === rootName) break;
    instancesIn(model, 0);
  }
  return created;
}

/**
 * Realises the scene: every node of every model, in every context reachable from the root model, with
 * its world matrix. An instance node is emitted itself (it can carry collision of its own) and then the
 * model it names is realised beneath it.
 *
 * The `I` index is the context's place in the load's creation order (`contextsBefore`): the root's
 * realisations take the numbers after the contexts the models read before it created, in traversal
 * order. Nothing about where a prop sits depends on it -- the chains of one model differ only in their
 * baked per-instance vertex lighting, their positions being identical -- but that lighting is the picture.
 */
export function flattenScene(models: SceneNode[], rootName = 'worldmodel'): SceneInstance[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const root = byName.get(rootName);
  if (!root) throw new Error(`the scene graph has no model named ${rootName}`);
  const counts = countInstances(models);
  const taken = contextsBefore(models, rootName);
  const out: SceneInstance[] = [];

  const takeIndex = (name: string): number | null => {
    const total = counts.get(name) ?? 0;
    if (total === 0) return null;                               // the fallback naming: one set of chunks
    const next = taken.get(name) ?? 0;
    taken.set(name, next + 1);
    return Math.min(next, total - 1);
  };

  const realise = (model: SceneNode, parent: Float32Array, path: string, instanceIndex: number | null, depth: number, inherited: number): void => {
    let nodeIndex = 0;
    const nested = depth > 0;
    const rec = (node: SceneNode, above: Float32Array, where: string, facadeAbove: number): void => {
      const world = multiply(node.matrix, above);
      const facade = facadeOf(node.flags) || facadeAbove;
      out.push({ modelName: model.name, node, nodeIndex: node.visuals > 0 ? nodeIndex++ : -1, instanceIndex, world, path: where, facade, nested });
      for (const child of node.children) {
        const childPath = `${where}/${child.name}`;
        if (child.type !== NODE_INSTANCE) {
          rec(child, world, childPath, facade);
          continue;
        }
        const childWorld = multiply(child.matrix, world);
        const childFacade = facadeOf(child.flags) || facade;
        out.push({ modelName: model.name, node: child, nodeIndex: -1, instanceIndex, world: childWorld, path: childPath, facade: childFacade, nested });
        const prototype = child.modelName === null ? undefined : byName.get(child.modelName);
        if (prototype && depth < MAX_DEPTH) {
          realise(prototype, childWorld, `${childPath}=${prototype.name}`, takeIndex(prototype.name), depth + 1, childFacade);
        }
      }
    };
    rec(model, parent, path, inherited);
  };

  realise(root, IDENTITY, rootName, takeIndex(rootName), 0, 0);
  return out;
}

/** Every drawn placement of the scene: one per realised node that has visuals, with its chunk keys. */
export function placeInstances(models: SceneNode[], rootName = 'worldmodel'): PlacedModel[] {
  const modelFlags = new Map(models.map((m) => [m.name, m.flags]));
  return flattenScene(models, rootName)
    .filter((f) => f.node.visuals > 0)
    .map((f) => ({
      modelName: f.modelName,
      path: f.path,
      nodeIndex: f.nodeIndex,
      instanceIndex: f.instanceIndex,
      chunks: Array.from({ length: f.node.visuals }, (_, v) => chunkKey(f.nodeIndex, f.instanceIndex, v)),
      cull: Array.from({ length: f.node.visuals }, (_, v) => ((f.node.visualParams[v] ?? VISUAL_FLAG_CULL) & VISUAL_FLAG_CULL) !== 0),
      material: Array.from({ length: f.node.visuals }, (_, v) => f.node.visualMaterials?.[v] ?? 0),
      facade: f.facade,
      world: toColumnMajor(f.world),
      rowMajor: f.world,
      lit: ((f.node.flags | (modelFlags.get(f.modelName) ?? 0)) & NODE_FLAGS_LIT) !== 0,
      bbox: f.node.bbox,
    }));
}

/**
 * The `di` polygons a realised node contributes to the world the engine holds: its own, except on an instance
 * node inside a realised prototype, which contributes none of its own (research 24 section 1.1's 3,318).
 *
 * The exporter writes a prototype's root `di` onto every node that instances it as well, and the engine keeps
 * both copies only where it reads the instance from the world's own file: `CNode::CreateInstance(sload)` copies
 * the model (its `di` with it) and then `ReadDataBegin` adds the node's own `di` on top (reCOM
 * `research/recom/src/gamez/zNode/node_io.cpp:46-51`, `node_saveload.cpp:49-74`). An instance inside a prototype is
 * not read again when the prototype is instanced: `CNode::_Copy` re-makes it from a model
 * (`zNode/node_main.cpp:312-333`; reCOM's transcription passes the container's `m_model` there, and leaves the
 * `di` copy itself a TODO at `:308`), so the file's copy on it never reaches the world. The prototype's own copy is
 * still there -- the viewer realises it as the model root under the instance node (`flattenScene`'s `=`) -- so
 * nothing is lost but a duplicate. On Frostfire that is the ten `railpostfiller` posts inside the three tank
 * rails, 20 polygons: 3,338 before, 3,318 after, the count and bounds research 24 section 1.1 walked in the
 * image (checked 2026-09-28; MP6 carries 79 such, MP72 none).
 */
export function worldDi(f: SceneInstance): CollisionPoly[] {
  return f.nested && f.node.type === NODE_INSTANCE ? [] : f.node.collision;
}

/** Every collision polygon of the scene, its points carried from model space into the world frame (`worldDi`). */
export function placeCollision(models: SceneNode[], rootName = 'worldmodel'): PlacedCollision[] {
  const out: PlacedCollision[] = [];
  for (const f of flattenScene(models, rootName)) {
    for (const poly of worldDi(f)) {
      const points = new Float32Array(poly.points.length);
      for (let i = 0; i < poly.points.length; i += 3) {
        const p = transformPoint(f.world, poly.points[i]!, poly.points[i + 1]!, poly.points[i + 2]!);
        points[i] = p[0]; points[i + 1] = p[1]; points[i + 2] = p[2];
      }
      out.push({ modelName: f.modelName, path: f.path, poly, points });
    }
  }
  return out;
}
