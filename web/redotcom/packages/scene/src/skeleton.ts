import { Reader, type Zar, type ZarKey } from '@s2u/archive';
import { multiply } from './sceneGraph';

/**
 * A character's skeleton: `CLIB_GEO.ZED`'s `models/<name>` tree read as the matrix palette the skinned mesh is
 * drawn against (web/redotcom/docs/research/78 §3).
 *
 * The model node carries the one visual of `vtype` 1 -- the `CMesh`, whose DMA buffer is `CLIB_MDL.ZED`'s
 * `MESH_<name>` -- and every node below it one visual of `vtype` 2, a `CSubMesh` with a `matrix_id`
 * (reCOM `zVisual/vis_main.cpp:246-265` builds the two; `zvis.h:251-272` gives `CSubMesh::m_matrix_id`,
 * which its constructor defaults to `0xabcd`, `vis_mesh.cpp:36-42`). The ids are the node's slot in the
 * palette the bone lists' reloc-9 tags index (78 §2), and on every character of the 22 maps they run
 * 0 .. `mtx_count` - 1 in the tree's pre-order, so a part's index here *is* its palette slot.
 *
 * The palette the mesh was exported against is the bind pose: each node's `nparams` matrix composed down the
 * tree, local x parent in the engine's row-vector convention (24 §1.1). Every bone's own copy of every vertex,
 * carried through that palette, lands on the same point to the 1.15 lanes' rounding (78 §3) -- the test that
 * proves it is `influenceSpread` over every mesh of three maps.
 *
 * Built to be driven: a motion clip (W2.2) sets per-part local matrices by name or by index, `update` composes
 * them, `palette` hands the current world matrices to the skinning, and the bind pose stays beside them.
 */

/** 36 §2 / `tag_NODE_PARAMS`: 64 B matrix, 24 B bbox, u32 type, u32 flags. */
const NPARAMS_SIZE = 96, BBOX_AT = 64, TYPE_AT = 88, FLAGS_AT = 92;
/** `CVisual::Create`'s switch (`vis_main.cpp:246-265`): 1 a `CMesh`, 2 a `CSubMesh`. */
export const VTYPE_MESH = 1, VTYPE_SUBMESH = 2;

export class SkeletonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkeletonError';
  }
}

/** One node of the skeleton: a palette slot. */
export interface SkeletonPart {
  /** The palette slot, `matrix_id`, and this part's index in `Skeleton.parts`. */
  index: number;
  name: string;
  /** The parent part's index, or -1 for a part hung directly off the model node (`skel_root`, `body`). */
  parent: number;
  /** The node's `nparams` matrix: local to its parent, row-major, row-vector (24 §1.1). */
  bindLocal: Float32Array;
  /** The node's bbox, in its own frame: the extent of the vertices it moves most (78 §3). */
  bbox: Float32Array;
  type: number;
  flags: number;
}

/** A character's skeleton, its bind pose, and a current pose a motion can drive. */
export class Skeleton {
  /** Model space per part in the bind pose: the palette the mesh was exported against. */
  readonly bindWorld: readonly Float32Array[];
  /** The current pose: local matrices, one per part, which `setLocal` replaces and `update` composes. */
  readonly local: Float32Array[];
  /** The current pose in model space, as of the last `update`. */
  readonly world: Float32Array[];
  private readonly byName: Map<string, number>;

  constructor(readonly model: string, readonly modelMatrix: Float32Array, readonly parts: readonly SkeletonPart[]) {
    this.byName = new Map(parts.map((p) => [p.name, p.index]));
    this.local = parts.map((p) => Float32Array.from(p.bindLocal));
    this.world = parts.map(() => new Float32Array(16));
    this.update();
    this.bindWorld = this.world.map((m) => Float32Array.from(m));
  }

  get size(): number { return this.parts.length; }

  /** The part of that name, or -1. */
  indexOf(name: string): number { return this.byName.get(name) ?? -1; }

  /** A part by palette slot or by name; throws when there is none. */
  part(key: number | string): SkeletonPart {
    const i = typeof key === 'number' ? key : this.indexOf(key);
    const p = this.parts[i];
    if (!p) throw new SkeletonError(`${this.model} has no part ${key}`);
    return p;
  }

  /** Sets a part's local matrix (row-major, row-vector, relative to its parent). Call `update` after. */
  setLocal(key: number | string, matrix: ArrayLike<number>): void {
    const p = this.part(key);
    if (matrix.length !== 16) throw new SkeletonError(`a local matrix is 16 floats, not ${matrix.length}`);
    this.local[p.index]!.set(matrix);
  }

  /** Puts every part back at its bind-pose local matrix, and the world with it. */
  resetToBind(): void {
    this.parts.forEach((p, i) => this.local[i]!.set(p.bindLocal));
    this.update();
  }

  /** Composes the current pose: local x parent's world, parents first (the palette is in pre-order). */
  update(): void {
    for (const p of this.parts) {
      const parent = p.parent < 0 ? this.modelMatrix : this.world[p.parent]!;
      this.world[p.index]!.set(multiply(this.local[p.index]!, parent));
    }
  }

  /** The current pose, one model-space matrix per palette slot: what `skinSubMesh` takes. */
  palette(): readonly Float32Array[] { return this.world; }
}

const u32Of = (geo: Zar, key: ZarKey | undefined): number | null => (key && key.size === 4 ? new Reader(geo.data(key)).u32(0) : null);

/** The one visual a node carries (`visuals/vis`), or null; a character node has exactly one (78 §3). */
function visualOf(geo: Zar, node: ZarKey): ZarKey | null {
  const visuals = geo.child(node, 'visuals')?.children ?? [];
  return visuals.length === 1 ? visuals[0]! : null;
}

function nparamsOf(geo: Zar, node: ZarKey, what: string): { matrix: Float32Array; bbox: Float32Array; type: number; flags: number } {
  const key = geo.child(node, 'nparams');
  if (!key || key.size !== NPARAMS_SIZE) throw new SkeletonError(`${what}: nparams is ${key ? `${key.size} bytes` : 'absent'}`);
  const r = new Reader(geo.data(key));
  return {
    matrix: Float32Array.from({ length: 16 }, (_, i) => r.f32(i * 4)),
    bbox: Float32Array.from({ length: 6 }, (_, i) => r.f32(BBOX_AT + i * 4)),
    type: r.u32(TYPE_AT),
    flags: r.u32(FLAGS_AT),
  };
}

/**
 * The names of the models in a `*_GEO.ZED` that are characters: a model node whose one visual is `vtype` 1.
 * In `CLIB_GEO.ZED` that is every model (17 on Frostfire), one per `CLIB_MDL.ZED` mesh (78 §4).
 */
export function characterModelNames(geo: Zar): string[] {
  const models = geo.find('models')?.children ?? [];
  return models.filter((m) => {
    const vis = visualOf(geo, m);
    return vis !== null && u32Of(geo, geo.child(vis, 'vtype')) === VTYPE_MESH;
  }).map((m) => m.name);
}

/**
 * Reads a character's skeleton (78 §3). Throws `SkeletonError` when the model is absent, is not a `CMesh`, or a
 * node below it is not a `CSubMesh` whose `matrix_id` is its pre-order place -- the one layout on the disc, and
 * the only one a palette index can be read against without guessing.
 */
export function readSkeleton(geo: Zar, model: string): Skeleton {
  const root = geo.find(`models/${model}`);
  if (!root) throw new SkeletonError(`no model ${model} in the GEO archive`);
  const top = nparamsOf(geo, root, model);
  const vis = visualOf(geo, root);
  if (!vis || u32Of(geo, geo.child(vis, 'vtype')) !== VTYPE_MESH) throw new SkeletonError(`${model}: its visual is not a vtype-1 CMesh`);
  const parts: SkeletonPart[] = [];
  const walk = (node: ZarKey, parent: number): void => {
    const what = `${model}/${node.name}`;
    const v = visualOf(geo, node);
    if (!v || u32Of(geo, geo.child(v, 'vtype')) !== VTYPE_SUBMESH) throw new SkeletonError(`${what}: not a vtype-2 CSubMesh`);
    const id = u32Of(geo, geo.child(v, 'matrix_id'));
    if (id !== parts.length) throw new SkeletonError(`${what}: matrix_id ${id} where the pre-order puts slot ${parts.length}`);
    const n = nparamsOf(geo, node, what);
    parts.push({ index: id, name: node.name, parent, bindLocal: n.matrix, bbox: n.bbox, type: n.type, flags: n.flags });
    for (const c of geo.child(node, 'children')?.children ?? []) walk(c, id);
  };
  for (const c of geo.child(root, 'children')?.children ?? []) walk(c, -1);
  if (parts.length === 0) throw new SkeletonError(`${model}: no parts`);
  return new Skeleton(model, top.matrix, parts);
}
