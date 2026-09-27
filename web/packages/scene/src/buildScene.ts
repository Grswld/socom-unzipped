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
 * Realises the scene: every node of every model, in every context reachable from the root model, with
 * its world matrix. An instance node is emitted itself (it can carry collision of its own) and then the
 * model it names is realised beneath it.
 *
 * The `I` index runs in traversal order. Nothing about where a prop sits depends on it -- the chains of
 * one model differ only in their baked per-instance vertex lighting, their positions being identical --
 * so a context the traversal cannot reach costs a shade, not a placement.
 */
export function flattenScene(models: SceneNode[], rootName = 'worldmodel'): SceneInstance[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const root = byName.get(rootName);
  if (!root) throw new Error(`the scene graph has no model named ${rootName}`);
  const counts = countInstances(models);
  const taken = new Map<string, number>();
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
    const rec = (node: SceneNode, above: Float32Array, where: string, facadeAbove: number): void => {
      const world = multiply(node.matrix, above);
      const facade = facadeOf(node.flags) || facadeAbove;
      out.push({ modelName: model.name, node, nodeIndex: node.visuals > 0 ? nodeIndex++ : -1, instanceIndex, world, path: where, facade });
      for (const child of node.children) {
        const childPath = `${where}/${child.name}`;
        if (child.type !== NODE_INSTANCE) {
          rec(child, world, childPath, facade);
          continue;
        }
        const childWorld = multiply(child.matrix, world);
        const childFacade = facadeOf(child.flags) || facade;
        out.push({ modelName: model.name, node: child, nodeIndex: -1, instanceIndex, world: childWorld, path: childPath, facade: childFacade });
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
      facade: f.facade,
      world: toColumnMajor(f.world),
      rowMajor: f.world,
      lit: ((f.node.flags | (modelFlags.get(f.modelName) ?? 0)) & NODE_FLAGS_LIT) !== 0,
    }));
}

/** Every collision polygon of the scene, its points carried from model space into the world frame. */
export function placeCollision(models: SceneNode[], rootName = 'worldmodel'): PlacedCollision[] {
  const out: PlacedCollision[] = [];
  for (const f of flattenScene(models, rootName)) {
    for (const poly of f.node.collision) {
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
