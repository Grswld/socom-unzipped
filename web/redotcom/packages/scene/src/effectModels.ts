import type { Zar } from '@s2u/archive';
import { interpretChainPartsAs, walkChain, type MeshData, type PositionForm } from '@s2u/mesh';
import { flattenScene } from './buildScene';
import { chunkKey, loadModelLibrary, resolveChunk } from './modelLibrary';
import { parseSceneGraph, transformPoint, VISUAL_FLAG_CULL, type SceneNode } from './sceneGraph';
import type { Pnt3D } from './firePoint';

/**
 * The effect models (web/redotcom/docs/research/89 §3): `RUN\COMMON\EFFE_GEO.ZED` and `EFFE_MDL.ZED`, in every map archive beside
 * `EFFE_TXR.ZED`/`EFFE_PAL.ZED`. They have the weapons' shape (`./weapon`: a `models` forest over one chain buffer a
 * model, `N%03d_%03d` chunk keys) and hold what the zAnim effect commands name as nodes: `bullet_shell_9m` (the
 * rifle's casing, `shell_eject`'s node 1), `bullet_shell_m60`, `bullet_shell_shotgun`, the muzzle flashes
 * `muzzle_flash_hider` (five quads under `scale/rotate`: `flash_fire_hider`), `muzzle_flash_m4`, `muzzle_flash_break`,
 * the chunks, the water rings, the tracers.
 *
 * **The position form differs by model.** The casings' packets are the weapons' command `0x70` form (`ITOF15` times
 * `TOP+3.w`, `'scale'`): decoded that way `bullet_shell_9m` fills its `nparams` box, -0.14..0.31 by 0.07, and decoded
 * the world's way it is 2,000 times too big. The flat quads (the flashes, the rings, the chunks) are the world's `0x68`
 * form (`'bias'`), and decoded as a weapon they collapse to a point. So each chunk is decoded both ways and the form
 * whose vertices lie inside the node's own `nparams` box **and fill it** is kept -- the test `./weapon` proves its form
 * by (every visual node inside its bbox), with the fill added because a collapsed point lies inside any box. A chunk
 * neither form fits is a diagnostic.
 */

/** The two members of a map archive the effect models live in. */
export const EFFECT_MEMBERS = { geo: 'EFFE_GEO.ZED', mdl: 'EFFE_MDL.ZED' } as const;

/** One drawn packet of an effect model, with the visual's cull flag. */
export type EffectMesh = MeshData & { cull: boolean };

/** One visual-bearing node of an effect model: its path from the model's root (`muzzle_flash_hider/scale/rotate/g27`). */
export interface EffectPart {
  node: string;
  path: string;
  /** The node's composed matrix to the model's root, row-major, row-vector. */
  world: Float32Array;
  meshes: EffectMesh[];
}

export interface EffectModel {
  name: string;
  parts: EffectPart[];
  /** Named nodes without visuals (`scale`, `rotate`, ...), their origins in the model's frame. */
  points: { name: string; path: string; at: Pnt3D }[];
  /** The model's `nparams` box: min xyz then max xyz. */
  bbox: Float32Array;
  textures: string[];
  diagnostics: string[];
}

/** Whether every vertex of `meshes` lies inside `bbox` (a margin of 5% of its largest side, and 0.05 absolute). */
export function insideBox(meshes: readonly MeshData[], bbox: ArrayLike<number>): boolean {
  let any = false;
  const span = Math.max(bbox[3]! - bbox[0]!, bbox[4]! - bbox[1]!, bbox[5]! - bbox[2]!);
  const pad = Math.max(0.05, span * 0.05);
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i++) {
      const a = i % 3, v = m.positions[i]!;
      if (v < bbox[a]! - pad || v > bbox[a + 3]! + pad) return false;
      any = true;
    }
  }
  return any;
}

/** How much of the box's largest side the vertices span, 0..1 (a collapsed chunk is near 0). */
export function boxFill(meshes: readonly MeshData[], bbox: ArrayLike<number>): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i++) {
      const a = i % 3, v = m.positions[i]!;
      if (v < lo[a]!) lo[a] = v;
      if (v > hi[a]!) hi[a] = v;
    }
  }
  const span = Math.max(bbox[3]! - bbox[0]!, bbox[4]! - bbox[1]!, bbox[5]! - bbox[2]!);
  const extent = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  return span > 0 && Number.isFinite(extent) ? extent / span : 0;
}

/** The least fill a form must reach to be the chunk's (a flat quad of the box fills it whole; a point, nothing). */
export const MIN_BOX_FILL = 0.5;

/** A chunk decoded in the form whose vertices lie in and fill its node's box (the header); null when neither does. */
export function decodeFitted(decode: (form: PositionForm) => MeshData[], bbox: ArrayLike<number>): { form: PositionForm; meshes: MeshData[] } | null {
  let best: { form: PositionForm; meshes: MeshData[]; fill: number } | null = null;
  for (const form of ['scale', 'bias'] as const) {
    const meshes = decode(form);
    if (!insideBox(meshes, bbox)) continue;
    const fill = boxFill(meshes, bbox);
    if (fill >= MIN_BOX_FILL && (!best || fill > best.fill)) best = { form, meshes, fill };
  }
  return best ? { form: best.form, meshes: best.meshes } : null;
}

export interface EffectLibrary {
  models: SceneNode[];
  names(): string[];
  /** Throws for a name the library does not hold; a chunk that fails is a diagnostic. */
  decode(name: string): EffectModel;
}

/** The effect models of one map archive: `EFFE_GEO.ZED`'s graph over `EFFE_MDL.ZED`'s chains. */
export function effectLibrary(geo: Zar, mdl: Zar): EffectLibrary {
  const models = parseSceneGraph(geo);
  const library = loadModelLibrary([mdl]);
  const byName = new Map(models.map((m) => [m.name, m]));
  return {
    models,
    names: () => models.map((m) => m.name),
    decode: (name) => {
      const model = byName.get(name);
      if (!model) throw new Error(`effect ${name}: not in EFFE_GEO's ${models.length} models`);
      const entry = library.get(model.name);
      const out: EffectModel = { name, parts: [], points: [], bbox: model.bbox, textures: [], diagnostics: [] };
      if (!entry) out.diagnostics.push(`no chain buffer named ${name} in EFFE_MDL`);
      const textures = new Set<string>();
      for (const f of flattenScene(models, name).filter((f) => f.modelName === name)) {
        if (f.node.visuals === 0) {
          if (f.node !== model) out.points.push({ name: f.node.name, path: f.path, at: transformPoint(f.world, 0, 0, 0) });
          continue;
        }
        const part: EffectPart = { node: f.node.name, path: f.path, world: f.world, meshes: [] };
        for (let v = 0; v < f.node.visuals; v++) {
          const key = chunkKey(f.nodeIndex, f.instanceIndex, v);
          const at = entry ? resolveChunk(entry, key) : null;
          if (!entry || !at) {
            if (entry) out.diagnostics.push(`chunk ${key}: no such chain in the model buffer`);
            continue;
          }
          const cull = ((f.node.visualParams[v] ?? VISUAL_FLAG_CULL) & VISUAL_FLAG_CULL) !== 0;
          try {
            const chain = walkChain(entry.buffer, at.offset, key);
            const fitted = decodeFitted((form) => interpretChainPartsAs(chain, form).meshes, f.node.bbox);
            if (!fitted) {
              const lines = interpretChainPartsAs(chain, 'bias').lines.length;
              out.diagnostics.push(lines > 0 ? `chunk ${key}: ${lines} line strip(s), not drawn` : `chunk ${key}: no position form fits the node's box`);
              continue;
            }
            for (const mesh of fitted.meshes) {
              part.meshes.push({ ...mesh, cull });
              if (mesh.textureName !== null) textures.add(mesh.textureName);
            }
          } catch (e) {
            out.diagnostics.push(`chunk ${key}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (part.meshes.length > 0) out.parts.push(part);
      }
      out.textures = [...textures].sort();
      return out;
    },
  };
}
