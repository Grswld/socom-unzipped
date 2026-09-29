import { parseRdr, Zar, zdbMember, type AssetSource, type ZdbEntry } from '@s2u/archive';
import {
  interpretScaledChain, meshNames, modelNodes, readMeshLibrary, skinSubMesh, topInfluences, walkModel, type MeshData,
} from '@s2u/mesh';
import {
  gearMatrix, IDENTITY, multiply, NODE_INSTANCE, parseCharacterTable, parseSceneGraph, playerCharacter, readSkeleton,
  transformPoint, VISUAL_FLAG_CULL, type CharacterTable, type SceneNode, type SpawnSlot,
} from '@s2u/scene';

/**
 * The player's body, decoded in the worker (web sprint 2, W2.1): the map's player character as the game dresses
 * it -- its mesh out of `CLIB_MDL.ZED`, its skeleton out of `CLIB_GEO.ZED`, its default gear out of `FLIB_MDL.ZED`
 * hung where `READERC.ZAR/character.rdr` says -- stood in its bind pose at spawn slot A. Pure data; `./bodyView`
 * makes the three objects on the page. The format is web/docs/research/78.
 */

/** W2.R4: the default target is the SEAL model, `seal_A_scuba` (the owner's word, 2026-09-28). */
export const DEFAULT_BODY = 'seal_A_scuba';
/**
 * The eye height W1.R2 walks at, 15.4 over the feet: research 17 §1's camera *target* over the actor (15.378,
 * with the console's root node at 5.5 of its 11.48 bind height), not the model's eye. The bind-pose SEAL's eyes
 * are 18.16 up (`LoadedBody.eye`, 78 §6); the two are kept apart and the difference is reported.
 */
export const EYE_HEIGHT_W1R2 = 15.4;
/** three's skinning takes four influences a vertex; the disc has up to six (78 §4). */
const RENDER_INFLUENCES = 4;
/** A LOD copy's suffix on a mesh name, `_1` and `_2` (78 §4: `seal_A_scuba_1`, `seal_A_scuba_2`). */
const LOD_SUFFIX = /_\d+$/;
/** The eye gear's models (78 §5): `seal_A_right_eye` is `right_eye.flt`, `left_eye_blue` is `left_eye_blue.flt`. */
export const EYE_MODEL = /(^|_)(right|left)_eye/i;
/** `READERC.ZAR` sits in `RUN/` beside the maps on the disc, and beside them in a served tree (78 §5). */
const READERC = 'READERC.ZAR';

/** A sub-mesh ready for a `SkinnedMesh`: the bind pose's positions and normals, and four influences a vertex. */
export interface BodySubMesh {
  textureName: string | null;
  fog: boolean;
  /** xyz per vertex, model space, the bind pose: the game's own sum over the bind palette (`skinSubMesh`). */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Four palette slots a vertex, the largest weights (`topInfluences`). */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
}

/** One part of the skeleton, as the page builds its bone. Matrices row-major, row-vector (24 §1.1). */
export interface BodyPart { name: string; parent: number; bindLocal: Float32Array; bindWorld: Float32Array }

/**
 * A gear mesh, in its model's own frame, with its visual's cull: `FLIB_GEO` `vparams` word 0 bit 3
 * (`VISUAL_FLAG_CULL`), which is clear on the eyelids, the holster's strap, the sheath's loop and the goggles.
 */
export type FittingMesh = MeshData & { cull: boolean };

/**
 * A piece of gear: the `character.rdr` entry's name, the `FLIB_MDL.ZED` model it draws, the part it hangs from,
 * its offset under that part (`gearMatrix`), and the model's meshes, each already in the model's own frame.
 */
export interface BodyFitting { name: string; model: string; part: number; offset: Float32Array; meshes: FittingMesh[] }

/** A weapon's carry place: the part it hangs from and its offset under it (row-major, row-vector). */
export interface BodyCarry { part: number; offset: Float32Array }

/** Where the body stands: slot A's centre and floor, turned to its facing. */
export interface BodyPlacement {
  position: [number, number, number];
  facing: [number, number];
  /** The turn about y, three's convention, that takes the model's forward (-z) onto `facing`. */
  yaw: number;
  side: 0 | 1;
  index: number;
}

export interface BodyStats {
  vertices: number; triangles: number; parts: number; subMeshes: number; batches: number;
  /** The most bones one vertex is weighted to on disc. */
  maxInfluences: number;
  /** The largest weight any vertex lost to the renderer's four (`topInfluences`). */
  droppedWeight: number;
  fittings: number;
}

export interface LoadedBody {
  /** The `character.rdr` character (`mp2_seal1`), or null when the table did not read. */
  character: string | null;
  model: string;
  /** Where the character and its gear came from: `character.rdr`, or why the table was not there. */
  dressedBy: string;
  parts: BodyPart[];
  subMeshes: BodySubMesh[];
  fittings: BodyFitting[];
  /** Default gear the map's `FLIB_MDL.ZED` does not carry, or whose part the skeleton lacks: not drawn. */
  missing: string[];
  /** Null until placed, and on a map with no slot A. */
  at: BodyPlacement | null;
  /** The bind pose's height over its feet (its soles are at the model's y 0). */
  height: number;
  /** The eye line over the feet: the eye gear's offset up its part, or null where the character has none. */
  eye: number | null;
  /**
   * WEAPON: where the weapons ride when not in the hand -- `character.rdr`'s "rifle" gear (`NONAME.flt` on `spinelo`,
   * `FUN_0058b0f0`'s `FindGear("rifle")`, the slung rifle `FUN_005a60d0` hangs there) and "pistol" gear (on `rthigh`, the
   * holster `FUN_005a75d0` puts it in): the part and the offset under it (`gearMatrix`). Null without the table.
   */
  carries?: { rifle: BodyCarry | null; pistol: BodyCarry | null };
  stats: BodyStats;
}

/**
 * The fallback choice when `character.rdr` is not on hand: `seal_A_scuba` (W2.R4) where the map has it, else the
 * map's first `seal_A*` that is not a LOD copy, else its first SEAL that is not.
 */
export function chooseBodyModel(names: readonly string[]): string | null {
  if (names.includes(DEFAULT_BODY)) return DEFAULT_BODY;
  const whole = names.filter((n) => /^seal_/i.test(n) && !LOD_SUFFIX.test(n));
  return whole.find((n) => /^seal_A/i.test(n)) ?? whole[0] ?? null;
}

/**
 * The turn about y that faces the model along a slot's facing. The model faces -z (its toes lead its ankles,
 * 78 §3), which is facing step 0, `(sin 0, -cos 0)` (research 75 §11); three turns (x, z) by `yaw` to
 * `(x cos + z sin, -x sin + z cos)`, so (0, -1) goes to `(-sin yaw, -cos yaw)`.
 */
export function bodyYaw(facing: readonly [number, number]): number {
  return Math.atan2(-facing[0], -facing[1]);
}

/** The character table a source serves, or why not; read once a source. */
export interface CharacterSource { table: CharacterTable | null; why: string }
const tables = new WeakMap<AssetSource, Map<string, Promise<CharacterSource>>>();

/**
 * `RUN/READERC.ZAR/character.rdr` from the same source as the map (78 §5), parsed once a source. Any failure --
 * the file absent from an older extraction or a one-archive image, or a server's page in its place -- is the
 * fallback, not a diagnostic: the map and the body both draw without it, the body bare, and `dressedBy` says why.
 */
export function characterTableFor(source: AssetSource, mapPath: string): Promise<CharacterSource> {
  const path = mapPath.replace(/[^/]*$/, READERC);
  let bySource = tables.get(source);
  if (!bySource) tables.set(source, bySource = new Map());
  let pending = bySource.get(path);
  if (!pending) {
    pending = (async (): Promise<CharacterSource> => {
      let bytes: Uint8Array;
      try {
        bytes = await source.read(path);
      } catch (e) {
        return { table: null, why: `no ${path}: ${e instanceof Error ? e.message : String(e)}` };
      }
      try {
        const zar = Zar.parse(bytes);
        const key = zar.root.children.find((k) => k.name.toLowerCase() === 'character.rdr');
        if (!key) return { table: null, why: `${path} holds no character.rdr` };
        return { table: parseCharacterTable(parseRdr(zar.data(key))), why: 'character.rdr' };
      } catch (e) {
        return { table: null, why: `${path} will not read: ${e instanceof Error ? e.message : String(e)}` };
      }
    })();
    bySource.set(path, pending);
  }
  return pending;
}

/** The player's character off the map's `READERM.ZAR/chartype.rdr`, or null. */
function mapPlayer(bytes: Uint8Array, toc: ZdbEntry[]): string | null {
  try {
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const key = readerm.root.children.find((k) => k.name.toLowerCase() === 'chartype.rdr');
    return key ? playerCharacter(parseRdr(readerm.data(key))) : null;
  } catch {
    return null;
  }
}

/**
 * Each visual-bearing node's model-space matrix and visual flags in `hookupVisuals`' order -- depth first, the
 * model first, never through an instance (`visualNodes`, `zVisual/vis_main.cpp:58-175`) -- so chunk `N%03d_%03d`
 * (node, visual) can be placed and culled: the eye's lid hangs 0.03 in front of its eyeball (78 §5.3).
 */
function visualNodesOf(model: SceneNode): { matrix: Float32Array; visualParams: number[] }[] {
  const out: { matrix: Float32Array; visualParams: number[] }[] = [];
  const rec = (node: SceneNode, parent: Float32Array): void => {
    const world = multiply(node.matrix, parent);
    if (node.visuals > 0) out.push({ matrix: world, visualParams: node.visualParams });
    for (const child of node.children) if (child.type !== NODE_INSTANCE) rec(child, world);
  };
  rec(model, IDENTITY);
  return out;
}

/** A mesh carried through a node matrix, positions and normals (the 3x3 is a rotation on every fitting node). */
function placed(mesh: MeshData, m: Float32Array): MeshData {
  if (m.every((x, i) => x === IDENTITY[i])) return mesh;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) positions.set(transformPoint(m, mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!), i);
  let normals: Float32Array | null = null;
  if (mesh.normals) {
    const n = mesh.normals;
    normals = new Float32Array(n.length);
    for (let i = 0; i < n.length; i += 3) {
      normals[i] = n[i]! * m[0]! + n[i + 1]! * m[4]! + n[i + 2]! * m[8]!;
      normals[i + 1] = n[i]! * m[1]! + n[i + 1]! * m[5]! + n[i + 2]! * m[9]!;
      normals[i + 2] = n[i]! * m[2]! + n[i + 1]! * m[6]! + n[i + 2]! * m[10]!;
    }
  }
  return { ...mesh, positions, normals, faceNormals: null };
}

/**
 * Decodes the player's body out of a map archive, unplaced. The character is the map's first `navyseals` entry
 * (`chartype.rdr`) and its mesh and gear are `character.rdr`'s; without that table the body is `chooseBodyModel`'s,
 * bare. Null, with a diagnostic, when the map has no such mesh or its mesh or skeleton will not read: the body is
 * an overlay, and the map draws without it.
 */
export function loadBody(bytes: Uint8Array, toc: ZdbEntry[], characters: CharacterSource, note: (line: string) => void): LoadedBody | null {
  let mdl: Zar, geo: Zar;
  try {
    mdl = Zar.parse(zdbMember(bytes, toc, 'CLIB_MDL.ZED'));
    geo = Zar.parse(zdbMember(bytes, toc, 'CLIB_GEO.ZED'));
  } catch (e) {
    note(`body: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const table = characters.table;
  const character = table ? mapPlayer(bytes, toc) : null;
  const model = (character && table?.model(character)) || chooseBodyModel(meshNames(mdl));
  // One mesh of the library's 14 to 30: decoding them all would cost 70 to 115 ms a load.
  const entry = model ? readMeshLibrary(mdl, [model])[0] : undefined;
  if (!model || !entry) {
    note(`body: the character library holds no ${model ?? 'SEAL'}`);
    return null;
  }
  if (!entry.mesh) {
    note(`body ${model}: ${entry.error}`);
    return null;
  }
  let skeleton;
  try {
    skeleton = readSkeleton(geo, model);
  } catch (e) {
    note(`body ${model}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const mesh = entry.mesh;
  let droppedWeight = 0;
  let height = -Infinity;
  const subMeshes: BodySubMesh[] = mesh.subMeshes.map((sub) => {
    // The bind pose is the palette the mesh was exported against (78 §3), so this is the game's own sum.
    const { positions, normals } = skinSubMesh(sub, skeleton.bindWorld);
    for (let i = 1; i < positions.length; i += 3) height = Math.max(height, positions[i]!);
    const top = topInfluences(sub, RENDER_INFLUENCES);
    droppedWeight = Math.max(droppedWeight, top.droppedMax);
    return {
      textureName: sub.textureName === null ? null : sub.textureName.toLowerCase(),
      fog: sub.fog, positions, normals, uvs: sub.uvs, indices: sub.indices,
      skinIndex: top.index, skinWeight: top.weight,
    };
  });

  // The default gear, where character.rdr hangs it (78 §5).
  const fittings: BodyFitting[] = [];
  const missing: string[] = [];
  const eyes: number[] = [];
  const gearNames = character && table ? table.defaultGear(character) : [];
  if (gearNames.length) {
    let flib: Zar | null = null, flibGeo: SceneNode[] = [];
    try {
      flib = Zar.parse(zdbMember(bytes, toc, 'FLIB_MDL.ZED'));
      flibGeo = parseSceneGraph(Zar.parse(zdbMember(bytes, toc, 'FLIB_GEO.ZED')));
    } catch { /* no fittings library: every piece is missing, below */ }
    for (const name of gearNames) {
      const gear = table!.gear.get(name);
      const key = gear && flib?.find(gear.model);
      const part = gear ? skeleton.indexOf(gear.part) : -1;
      if (!gear || !key || part < 0) { missing.push(name); continue; }
      try {
        const node = flibGeo.find((m) => m.name === gear.model);
        const visuals = node ? visualNodesOf(node) : [];
        const meshes: FittingMesh[] = [];
        for (const chain of walkModel(flib!.data(key), modelNodes(flib!, key))) {
          // `N%03d_%03d`: the chunk's node and visual (`hookupVisuals`), whose matrix places it within the model.
          const [, n = '0', v = '0'] = /^N(\d{3})_(\d{3})/.exec(chain.nodeName) ?? [];
          const visual = visuals[Number(n)];
          const at = visual?.matrix ?? IDENTITY;
          const cull = ((visual?.visualParams[Number(v)] ?? VISUAL_FLAG_CULL) & VISUAL_FLAG_CULL) !== 0;
          // 78 §5.1: the fittings are the scaled (0x70) form, research 15 §2.
          for (const m of interpretScaledChain(chain)) {
            meshes.push({ ...placed({ ...m, textureName: m.textureName === null ? null : m.textureName.toLowerCase() }, at), cull });
          }
        }
        const offset = gearMatrix(gear, table!.angleUnits);
        fittings.push({ name, model: gear.model, part, offset, meshes });
        if (EYE_MODEL.test(gear.model)) eyes.push(transformPoint(multiply(offset, skeleton.bindWorld[part]!), 0, 0, 0)[1]);
      } catch (e) {
        note(`body ${model} gear ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const carry = (name: string): BodyCarry | null => {
    const gear = table?.gear.get(name);
    const part = gear ? skeleton.indexOf(gear.part) : -1;
    return gear && part >= 0 ? { part, offset: gearMatrix(gear, table!.angleUnits) } : null;
  };
  return {
    character, model, dressedBy: characters.why,
    carries: { rifle: carry('rifle'), pistol: carry('pistol') },
    parts: skeleton.parts.map((p) => ({ name: p.name, parent: p.parent, bindLocal: p.bindLocal, bindWorld: Float32Array.from(skeleton.bindWorld[p.index]!) })),
    subMeshes, fittings, missing, at: null, height,
    eye: eyes.length ? eyes.reduce((a, b) => a + b, 0) / eyes.length : null,
    stats: {
      vertices: mesh.vertexCount, triangles: mesh.triangleCount, parts: skeleton.size, subMeshes: subMeshes.length,
      batches: mesh.batches.length, maxInfluences: mesh.maxInfluences, droppedWeight, fittings: fittings.length,
    },
  };
}

/**
 * Stands the body at slot A -- side 0, slot #0 of the disc's spawn list (`LoadedMap.slots`, W1.5b) -- its model
 * origin, which is its soles (78 §3), on the slot's floor and its forward along the slot's facing. Which slot a
 * player is given is game logic (W1.R9); slot A is W2.1's choice, not the game's.
 */
export function placeBody(body: LoadedBody, slots: readonly SpawnSlot[]): LoadedBody {
  const a = slots.find((s) => s.side === 0 && s.index === 0);
  if (!a) return body;
  return { ...body, at: { position: a.position, facing: a.facing, yaw: bodyYaw(a.facing), side: 0, index: 0 } };
}

/** Every texture the body draws with, lower-cased as `LoadedMap.textures` keys them. */
export function bodyTextureNames(body: LoadedBody): string[] {
  const names = [...body.subMeshes.map((s) => s.textureName), ...body.fittings.flatMap((f) => f.meshes.map((m) => m.textureName))];
  return [...new Set(names.filter((n): n is string => n !== null))];
}

/** The body's typed arrays, for the worker's transfer list, each buffer once. */
export function bodyTransferables(body: LoadedBody): Transferable[] {
  const out = new Set<ArrayBufferLike>();
  for (const s of body.subMeshes) for (const a of [s.positions, s.normals, s.uvs, s.indices, s.skinIndex, s.skinWeight]) out.add(a.buffer);
  for (const f of body.fittings) {
    for (const m of f.meshes) {
      for (const a of [m.positions, m.uvs, m.colors, m.indices, m.normals, m.faceNormals]) if (a) out.add(a.buffer);
    }
  }
  return [...out] as Transferable[];
}
