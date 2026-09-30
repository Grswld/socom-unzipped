import type { Zar } from '@s2u/archive';
import { interpretChainPartsAs, walkChain, type MeshData } from '@s2u/mesh';
import { flattenScene, type SceneInstance } from './buildScene';
import { chunkKey, loadModelLibrary, resolveChunk, type ModelLibrary } from './modelLibrary';
import { NODE_FLAGS_LIT, parseSceneGraph, transformPoint, VISUAL_FLAG_CULL, type SceneNode } from './sceneGraph';
import type { Pnt3D } from './firePoint';

/**
 * The weapons (W2.4; web/redotcom/docs/research/79 §2): `RUN\COMMON\WEAP_GEO.ZED` and `WEAP_MDL.ZED`, inside every map
 * archive (the world root's `assetlibs` names `//common/assetlib/weapons`). They are the props' shape, not the
 * characters': `WEAP_GEO` is a `models` forest of 59 `CNode` trees (research 72 §2) and `WEAP_MDL` one chain
 * buffer per model with `N%03d_%03d` chunk keys (`hookupVisuals`' fallback naming: no weapon instances another),
 * and every model's key set is exactly what `expectedChunks` predicts from its graph.
 *
 * **One difference: the position form.** A weapon's packets carry `TOP+3 = (0, 0, 0, w)` with `w` the packet's
 * extent, and their int16 lanes run to 32767: they are drawn by command `0x70`, `ITOF15` times `TOP+3.w` (research
 * 15 §0 item 1), not the world's `0x68`. Read that way every visual node of all 59 lands inside its own `nparams`
 * bbox (102 of 102) and read the world's way none does. `PositionForm` in `@s2u/mesh` carries the choice.
 *
 * A weapon's own graph names its points: `firepoint` (the muzzle), `firepoint_shell` (the ejection port),
 * `aimpoint` (the sight), `Gun_box` (the pickup box, six `di` polygons), and on the long guns `scope` and
 * `thermal_scope`. Its visuals come in LOD pairs, `<gun>_high` and `<gun>_low`.
 */

/** The default target: the SEAL's M4A1 SD (W2.R4, the owner's word of 2026-09-28). */
export const DEFAULT_WEAPON = 'm4Acarbine_sd';
/**
 * The sidearm the SEAL carries: `a_mark23`, the `ModelName` of `zweapon.rdr`'s "Mark 23" -- the second weapon of every
 * `mp_seal1` kit in `READERC.ZAR/character.rdr` (Frostfire's `mp2_seal1`: M4A1, Mark 23, M67, HE, Double Ammo Load),
 * the slot the game's L2 (`SwapWeapon2`) takes up (`scene/src/weapons.ts` `HELD_SIDEARM`). W2.R4 first named the M9
 * (`baretta_m9`) as the controller's default; the kit is the game's.
 */
export const DEFAULT_SIDEARM = 'a_mark23';
/** The two members of a map archive the weapons live in (research 72 §0-§2: the asset library's stem is `WEAP`). */
export const WEAPON_MEMBERS = { geo: 'WEAP_GEO.ZED', mdl: 'WEAP_MDL.ZED' } as const;

/** One decoded packet of a weapon, with the two flags a renderer needs, as `loadMap`'s props carry them. */
export type WeaponMesh = MeshData & { cull: boolean; lit: boolean };

/** One visual-bearing node of a weapon, decoded: its name, its `nparams` bbox and its packets in model space. */
export interface WeaponPart {
  node: string;
  /** min xyz then max xyz, model space: `nparams`' bbox, which every decoded vertex lies inside. */
  bbox: Float32Array;
  meshes: WeaponMesh[];
}

/** A named node without visuals -- the muzzle, the sight -- and where it sits in the weapon's frame. */
export interface WeaponPoint { name: string; at: Pnt3D }

export interface DecodedWeapon {
  name: string;
  parts: WeaponPart[];
  points: WeaponPoint[];
  /** The chunks walked, and what they came to: packets, vertices, triangles (degenerate ones dropped). */
  chunks: number;
  vertices: number;
  triangles: number;
  /** The texture names its packets cite, sorted, as the chains spell them. */
  textures: string[];
  /** A chunk that is missing or would not decode, one line each; the rest still decodes. */
  diagnostics: string[];
}

/**
 * Which LOD's visuals to decode. `high` drops the nodes named `*_low`: the viewer holds the weapon at arm's length,
 * where the engine's LOD choice (not decoded here) would take the high copy. `all` decodes both, for the tests.
 */
export type WeaponLod = 'high' | 'all';

export interface WeaponLibrary {
  models: SceneNode[];
  library: ModelLibrary;
  names(): string[];
  /** Throws for a name the library does not hold; a chunk that fails is a diagnostic, not a throw. */
  decode(name: string, lod?: WeaponLod): DecodedWeapon;
}

const LOW_LOD = /_low$/i;

/** The weapons of one map archive: `WEAP_GEO.ZED`'s graph over `WEAP_MDL.ZED`'s chains. */
export function weaponLibrary(geo: Zar, mdl: Zar): WeaponLibrary {
  const models = parseSceneGraph(geo);
  const library = loadModelLibrary([mdl]);
  const byName = new Map(models.map((m) => [m.name, m]));
  return {
    models,
    library,
    names: () => models.map((m) => m.name),
    decode: (name, lod = 'high') => {
      const model = byName.get(name);
      if (!model) throw new Error(`weapon ${name}: not in WEAP_GEO's ${models.length} models`);
      return decodeWeapon(models, library, model, lod);
    },
  };
}

function decodeWeapon(models: SceneNode[], library: ModelLibrary, model: SceneNode, lod: WeaponLod): DecodedWeapon {
  const entry = library.get(model.name);
  const out: DecodedWeapon = {
    name: model.name, parts: [], points: [], chunks: 0, vertices: 0, triangles: 0, textures: [], diagnostics: [],
  };
  if (!entry) out.diagnostics.push(`no chain buffer named ${model.name} in WEAP_MDL`);
  const textures = new Set<string>();
  const own = flattenScene(models, model.name).filter((f) => f.modelName === model.name);
  for (const f of own) {
    if (f.node.visuals === 0) {
      if (f.node !== model) out.points.push({ name: f.node.name, at: origin(f) });
      continue;
    }
    if (lod === 'high' && LOW_LOD.test(f.node.name)) continue;
    const lit = ((f.node.flags | model.flags) & NODE_FLAGS_LIT) !== 0;
    const part: WeaponPart = { node: f.node.name, bbox: f.node.bbox, meshes: [] };
    for (let v = 0; v < f.node.visuals; v++) {
      const key = chunkKey(f.nodeIndex, f.instanceIndex, v);
      out.chunks++;
      const at = entry ? resolveChunk(entry, key) : null;
      if (!entry || !at) {
        if (entry) out.diagnostics.push(`chunk ${key}: no such chain in the model buffer`);
        continue;
      }
      const cull = ((f.node.visualParams[v] ?? VISUAL_FLAG_CULL) & VISUAL_FLAG_CULL) !== 0;
      try {
        // The weapon's packets are command 0x70's: ITOF15 times TOP+3.w (see the file's comment).
        const { meshes, lines } = interpretChainPartsAs(walkChain(entry.buffer, at.offset, key), 'scale');
        if (lines.length > 0) out.diagnostics.push(`chunk ${key}: ${lines.length} line strip(s), which a weapon is not drawn with`);
        for (const mesh of meshes) {
          part.meshes.push({ ...mesh, cull, lit: lit || at.lit });
          out.vertices += mesh.positions.length / 3;
          out.triangles += mesh.indices.length / 3;
          if (mesh.textureName !== null) textures.add(mesh.textureName);
        }
      } catch (e) {
        out.diagnostics.push(`chunk ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.parts.push(part);
  }
  out.textures = [...textures].sort();
  return out;
}

/** A node's origin in the weapon's frame: its composed matrix's translation (`world` of a model realised at the root). */
function origin(f: SceneInstance): Pnt3D {
  return transformPoint(f.world, 0, 0, 0);
}
