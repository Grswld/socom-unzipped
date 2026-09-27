import {
  parseRdr, parseZdb, rdrGet, Reader, Zar, zdbMember,
  type RdrNode,
  type AssetSource, type ZarKey, type ZdbEntry,
} from '@s2u/archive';
import { decodeTexture, parseTextureRecord, PaletteTable, type Rgba } from '@s2u/gs';
import { interpretChainParts, mergeMeshes, walkChain, type LineStrip, type MeshData } from '@s2u/mesh';
import {
  collisionLines, IDENTITY, loadModelLibrary, lodBands, parseCameraParams, parseClutter, parseGlobalLighting,
  parseSceneGraph, parseWorldRoot, placeClutter, type LodBand,
  placeInstances, transformPoint, worldCollision,
  type CameraParams, type CollisionLines, type GlobalLighting, type ModelLibrary, type PlacedModel,
  type SceneNode,
} from '@s2u/scene';
import type { TextureFlags } from './materialSpec';

/**
 * One map, decoded far enough to draw: the world's triangles grouped one mesh per texture, the textures
 * those meshes name, and everything that went wrong on the way.
 *
 * The world's positions are WORLD space: `scene` gives every chunk the matrix of the `MP*_GEO.ZED` node
 * it hangs off (`hookupVisuals`, `zVisual/vis_main.cpp:88-105`), so the chunks are baked into place here
 * rather than shifted together by `origin`, which is left at zero for a map whose graph could be read.
 *
 * The props stay in MODEL space (`mesh/SEMANTICS.md` section 4): one prop model is drawn in up to 26
 * places, so it is decoded once and each placement travels as a matrix for an `InstancedMesh`.
 */
/**
 * A decoded mesh plus what the drawing needs to know about where it came from: whether the engine
 * lights its node, and where in the engine's walk of the scene graph it was drawn.
 *
 * `order` is the place in that walk (`Placement.rank`, times 256, plus the chunk's index within its
 * node), and `orderEnd` the place of the last chunk merged into this draw -- the same number for a
 * draw that is one chunk. reCOM's `CPipe::RenderNode` draws each visual as the walk reaches it and
 * sorts nothing, so this is the order the hardware drew in, and `world.ts` draws in it.
 */
export type LoadedMesh = MeshData & {
  lit: boolean;
  order: number;
  orderEnd: number;
  /** Whether the engine culls this chunk's back faces (`PlacedModel.cull`, the disc's own flag). */
  cull: boolean;
  /**
   * An alternate state the game shows only later: a destructible's `whats_left` and its debris
   * `parts`, a lamp's `nolight`, the pulsing objective ribbon (`Placement.alternate`). Drawn over the
   * state the map opens in, these z-fight with it; the viewer hides them unless asked.
   */
  alternate: boolean;
  /**
   * The uv step per engine tick of a scrolling texture (`TextureScroll_Object` on the world root:
   * Frostfire's oceans and sky horizon), or null for the still majority.
   */
  scroll: [number, number] | null;
};

export interface LoadedMap {
  archive: string;
  /** `cameras/camera` out of `MP*.ZED`: the map's own fog, or null when the key is missing. */
  camera: CameraParams | null;
  path: string;
  name: string;
  world: LoadedMesh[];
  /**
   * GS LINE_STRIP geometry in world space (SEMANTICS section 12), one group per (texture, fog), or null
   * when the map drew none.
   */
  lines: LoadedLineGroup[] | null;
  /**
   * One entry per prop model-node: its geometry once, a column-major 4x4 per placement, and the place
   * of its first placement in the scene walk (see `LoadedMesh.order`).
   */
  props: {
    modelName: string; parts: LoadedMesh[]; matrices: Float32Array; order: number; alternate: boolean;
    /** `m_facade` on the node: non-zero, every placement is turned to face the camera each frame. */
    facade: number;
    /** The model's LOD band, or null: shown by camera range, one copy of a pair at a time. */
    lod: LodBand | null;
  }[];
  textures: Record<string, Rgba>;
  /**
   * Per texture: the record's flags, two facts read off the decoded pixels (`graded`, `opaque`), and the
   * GS state the record's bind packet sets -- blend equation, alpha test, filtering, wrap. See
   * `./materialSpec` for how the three become a material.
   */
  textureFlags: Record<string, TextureFlags>;
  metersPerUnit: number;
  /** `MP*.ZED/GlobalLighting`: the map's own light rig, or null when the key is missing or short. */
  lightRig: GlobalLighting | null;
  origin: [number, number, number];
  /** The collision hull as line segments in world space, ready for a `LineSegments` overlay. */
  collision: CollisionLines;
  diagnostics: string[];
  loadMs: number;
  /**
   * Where the wait went, in milliseconds, for the status line and for measuring a regression: the
   * fetch, the decode, and the wall-clock moment the worker handed the map over (so the page can see
   * what the handoff itself cost, which the two clocks' different origins would otherwise hide).
   */
  timings: { fetch: number; decode: number; postedAt: number };
}

/**
 * The diagnostic sink: every distinct line once.
 *
 * One cause usually fires more than once -- the same missing texture is cited by twenty chunks, and the
 * same model is asked for at every placement -- and twenty identical lines say no more than one does
 * while burying the rest. Each line already names its cause *and* its subject, so the line itself is the
 * identity, and a repeat is dropped. Order is first-seen, which is decode order.
 */
class Notes {
  private readonly seen = new Set<string>();
  readonly lines: string[] = [];

  add(line: string): void {
    if (this.seen.has(line)) return;
    this.seen.add(line);
    this.lines.push(line);
  }
}

/**
 * `nparams` is 96 bytes: a 64-byte row-major 4x4, a 24-byte bbox, then the u32 `m_type` and a u32 of
 * flags (`tag_NODE_PARAMS`, `zNode/znode.h:73-105`; SEMANTICS section 11.2). 36 section 2 and
 * SEMANTICS section 8 call the 32-byte tail one bbox, which it is not. Only the matrix matters here.
 */
const NPARAMS_SIZE = 96;
/** Row-vector convention: the translation is the matrix's fourth row, floats 12, 13, 14. */
const TRANSLATION_AT = 12 * 4;
/** 36 section 2: the one model key of `WORL_MDL.ZED`, and the root of `MP*_GEO.ZED`'s placement. */
const WORLD_MODEL = 'worldmodel';
/** `MP*.ZED/MetersPerUnit` is one float; Frostfire reads 0.1, and every map so far agrees. */
const DEFAULT_METERS_PER_UNIT = 0.1;

const stemOf = (path: string): string => path.replace(/^.*\//, '').replace(/\.ZDB$/i, '').toUpperCase();
const textureKey = (name: string): string => name.toLowerCase();
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Loads a map archive and decodes its `worldmodel` and the textures that model cites.
 *
 * The sequence mirrors `web/tools/dump-textures.ts` for the texture half and the mesh package's Frostfire
 * tests for the geometry half: ZDB table of contents, `WORL_MDL.ZED` -> `worldmodel` -> DMA chains ->
 * VIF packets -> `MeshData`, and `MP*_TXR.ZED` + `MP*_PAL.ZED` -> `TextureRecord` -> RGBA.
 *
 * Nothing here throws for bad map data if it can help it, and that promise is kept one chunk at a time:
 * the DMA walk and the VIF interpretation of a chunk both happen inside `decoder`'s per-chunk `try`, so a
 * malformed tag costs that chunk and nothing else. The same holds a level up -- a model archive, the
 * scene graph, the texture archive, a single texture: each failure is a diagnostic string, and whatever
 * else decoded still draws. Only a ZDB whose table of contents will not parse ends the load.
 */
/**
 * The named parts of a load, in the order they happen. The page turns these into a sentence and a bar;
 * they exist because an 8 to 13 MB archive over a real network is seconds of nothing to look at.
 */
export type LoadStage = 'fetching' | 'archive' | 'geometry' | 'textures';

/** `done` of `total`; `total` is 0 when the step has no count to give (the archive parse). */
export type OnStage = (stage: LoadStage, done: number, total: number) => void;

export async function loadMap(source: AssetSource, path: string, onStage?: OnStage): Promise<LoadedMap> {
  const started = Date.now();
  const notes = new Notes();
  const step = (stage: LoadStage, done: number, total: number): void => onStage?.(stage, done, total);
  const T0 = performance.now();
  step('fetching', 0, 0);
  const bytes = await source.read(path, (loaded, total) => step('fetching', loaded, total));
  const T1 = performance.now();
  step('archive', 0, 0);
  const toc = parseZdb(bytes);
  const stem = stemOf(path);

  // The geometry. `scene` reads MP*_GEO.ZED's node tree and says which chain of which model buffer each
  // node draws and where; everything below is decoding what it points at.
  const library = loadModelLibrary(mdlArchives(bytes, toc, stem, notes));
  const chunksOf = decoder(library, notes);
  const placement = place(library, bytes, toc, stem, notes);
  /** The world's meshes, each with its place in the scene walk, so a blended surface keeps its own draw. */
  const parts: LoadedMesh[] = [];
  let chunk = 0;
  /** A chunk's place in the walk: its node's rank, then its index within the node (256 is a cap, not a count). */
  const orderOf = (p: PlacedModel, i: number): number => placement.rank(p) * 256 + Math.min(i, 255);
  // Relocation-type-1 packets are GS LINE_STRIPs, not meshes (SEMANTICS section 12): Desert Glory's
  // power lines and lamp brackets, Crossroads' guy ropes and light filaments. They carry no index list,
  // so a strip of n points is n-1 segments, flattened here into world-space segment lists, one per
  // (texture, fog) -- a strip is textured, and the texture is what a line draw is keyed on.
  const segments = new Segments();
  for (const p of placement.world) {
    step('geometry', chunk++, placement.world.length);
    const { meshes, lines } = chunksOf(p);
    const alternate = placement.alternate(p);
    const scroll = placement.scroll(p);
    meshes.forEach((mesh, i) => {
      const order = orderOf(p, i);
      parts.push({ ...placeMesh(mesh, p.rowMajor), lit: p.lit, order, orderEnd: order, cull: mesh.cull, alternate, scroll });
    });
    for (const strip of lines) segments.add(strip, p.rowMajor, orderOf(p, 0));
  }

  // The props: one entry per model-node, its geometry decoded once and a matrix per placement.
  const props: LoadedMap['props'] = [];
  for (const group of placement.props) {
    const first = group[0]!;
    // Lower-cased here for the same reason the world's names are: `map.textures` is keyed that way, and
    // one Frostfire prop cites `lightDark.tif` with a capital in it.
    const decoded = chunksOf(first);
    // A prop is drawn in up to 26 places; its strips are placed once per placement, which is cheap --
    // 877 segments across the three maps in total.
    const order = orderOf(first, 0);
    for (const placementOf of group) {
      for (const strip of decoded.lines) segments.add(strip, placementOf.rowMajor, orderOf(placementOf, 0));
    }
    const alternate = placement.alternate(first);
    const geometry: LoadedMesh[] = decoded.meshes.map((mesh, i) => ({
      ...mesh, textureName: mesh.textureName === null ? null : textureKey(mesh.textureName), lit: first.lit,
      order: orderOf(first, i), orderEnd: orderOf(first, i), cull: mesh.cull, alternate, scroll: placement.scroll(first),
    }));
    if (geometry.length === 0) continue;
    const matrices = new Float32Array(group.length * 16);
    group.forEach((p, i) => matrices.set(p.world, i * 16));
    props.push({
      modelName: first.modelName, parts: geometry, matrices, order, alternate,
      facade: first.facade, lod: placement.lod.get(first.modelName) ?? null,
    });
  }

  // The textures those meshes name, and only those: a map's TXR holds every texture the mission uses.
  // A TXR or PAL member that will not parse at all costs one diagnostic and the untextured map, not the
  // load: vertex colours alone still show the geometry, which is what a diagnosing eye is here for.
  const textures: Record<string, Rgba> = {};
  const textureFlags: Record<string, TextureFlags> = {};
  const texlib = textureLibrary(bytes, toc, stem, notes);
  if (texlib) {
    const { palettes, keys, libs } = texlib;
    const wanted = [...parts, ...props.flatMap((p) => p.parts)];
    let decoded = 0;
    for (const mesh of wanted) {
      step('textures', decoded++, wanted.length);
      const name = mesh.textureName === null ? null : textureKey(mesh.textureName);
      if (name === null || name in textures) continue;
      const hit = keys.get(name);
      if (!hit) {
        notes.add(`texture ${name}: in none of the map's ${libs} asset libs`);
        continue;
      }
      const { zar: txr, key } = hit;
      const texdat = txr.child(key, 'texdat');
      if (!texdat) {
        notes.add(`texture ${name}: no texdat key`);
        continue;
      }
      try {
        const record = parseTextureRecord(key.name, txr.data(texdat));
        const decoded = decodeTexture(record, palettes);
        for (const d of decoded.diagnostics) notes.add(`texture ${name}: ${d}`);
        textures[name] = decoded.rgba;
        textureFlags[name] = {
          bilinear: record.bilinear, transparent: record.transparent, graded: isGraded(decoded.rgba),
          opaque: isOpaque(decoded.rgba), gs: record.gs,
        };
      } catch (e) {
        notes.add(`texture ${name}: ${say(e)}`);
      }
    }
  }

  // One draw call per texture: Frostfire's 416 packets cite 37 names, and merging by name turns 416 draws
  // into 37 without touching a vertex. Two things split a texture's draw:
  //
  // - **Fog.** A packet's `PRIM.FGE` (SEMANTICS §3, `MeshData.fog`) is per packet, and a texture can be
  //   drawn both ways -- half of Frostfire's sky is fogged and half is not -- so the merge keys on it.
  // - **A ramp of alpha.** A blended surface is drawn where the engine's walk reached it, and where
  //   that is only means something if it is its own draw: the graded textures keep one mesh per chunk,
  //   which is the granularity the hardware drew them at anyway. And the opaque draws around it must
  //   not straddle it -- a wall merged across a glow would be drawn wholly before or wholly after it --
  //   so the merge is cut at every blended chunk: a texture's draws are one per *run* of the walk
  //   between blended chunks, and `order`/`orderEnd` say which run.
  const byGroup = new Map<string, LoadedMesh[]>();
  let run = 0;
  for (const part of parts) {
    const key = part.textureName === null ? '' : textureKey(part.textureName);
    const flags = key === '' ? undefined : textureFlags[key];
    const blended = (flags?.graded ?? false) && !(flags?.opaque ?? true);
    // A lit part (`PlacedModel.lit`) keeps its own draw as well: the rig is applied per vertex, and a
    // merge cannot be half lit.
    const scroll = part.scroll ? `|s${part.scroll[0]},${part.scroll[1]}` : '';
    const group = `${key}|${part.fog ? 1 : 0}${part.lit ? 'L' : ''}${part.cull ? 'C' : ''}${part.alternate ? 'A' : ''}${scroll}|${blended ? `b${part.order}` : `r${run}`}`;
    if (blended) run++;
    const list = byGroup.get(group);
    if (list) list.push(part);
    else byGroup.set(group, [part]);
  }
  const world: LoadedMesh[] = [...byGroup.values()].map((list) => ({
    ...mergeMeshes(list),
    // `mergeMeshes` drops the name when parts disagree; here they agree by construction.
    textureName: list[0]!.textureName === null ? null : textureKey(list[0]!.textureName),
    lit: list[0]!.lit,
    order: list[0]!.order,
    orderEnd: list[list.length - 1]!.order,
    cull: list[0]!.cull,
    alternate: list[0]!.alternate,
    scroll: list[0]!.scroll,
  })).sort((a, b) => a.order - b.order);

  return {
    archive: stem,
    lines: segments.result(),
    camera: cameraParams(bytes, toc, stem, notes),
    path,
    name: missionName(bytes, toc, notes) ?? stem,
    world,
    props,
    textures,
    textureFlags,
    metersPerUnit: metersPerUnit(bytes, toc, stem, notes),
    lightRig: lightRig(bytes, toc, stem, notes),
    origin: placement.origin,
    collision: placement.collision,
    diagnostics: notes.lines,
    loadMs: Date.now() - started,
    timings: { fetch: T1 - T0, decode: performance.now() - T1, postedAt: Date.now() },
  };
}

/** Every typed array in a `LoadedMap`, for the worker's transfer list: no copies cross the boundary. */
export function transferables(map: LoadedMap): Transferable[] {
  const out: Transferable[] = [];
  for (const mesh of [...map.world, ...map.props.flatMap((p) => p.parts)]) {
    out.push(mesh.positions.buffer, mesh.uvs.buffer, mesh.colors.buffer, mesh.indices.buffer);
    if (mesh.normals) out.push(mesh.normals.buffer);
    if (mesh.faceNormals) out.push(mesh.faceNormals.buffer);
  }
  for (const prop of map.props) out.push(prop.matrices.buffer);
  out.push(map.collision.positions.buffer, map.collision.colors.buffer);
  for (const g of map.lines ?? []) out.push(g.positions.buffer, g.uvs.buffer, g.colors.buffer, g.normals.buffer);
  for (const rgba of Object.values(map.textures)) out.push(rgba.data.buffer);
  return out;
}

/**
 * The asset libraries a map loads, in the order it loads them, as ZDB member stems.
 *
 * A map does not keep its textures in one archive. The world root's `assetlibs` key lists library
 * paths, and `CSaveLoad::LoadAssetLib_PS2` (`zNode/node_saveload.cpp:91-114`) turns each into a member
 * name by taking the **first four characters of the last path element**: `//common/assetlib/weapons`
 * becomes `WEAP`, `//mp/mp61/junkyard` becomes `JUNK`, `//mp/mp73/c73` becomes `C73`. The map's own
 * library is last in that list, which matters -- see `textureLibrary`.
 *
 * Falls back to the map's own stem so a root that will not parse still draws the map the way it did.
 */
function assetLibStems(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): string[] {
  try {
    const root = Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`));
    const libs = root.find('assetlibs')?.children ?? [];
    const stems: string[] = [];
    for (const lib of libs) {
      const last = lib.name.split('/').filter(Boolean).pop() ?? '';
      const member = last.slice(0, 4).toUpperCase();
      if (member && !stems.includes(member)) stems.push(member);
    }
    if (stems.length) return stems;
    notes.add(`${stem}.ZED: no assetlibs key, so only ${stem}_TXR.ZED is read`);
  } catch (e) {
    notes.add(`assetlibs: ${say(e)} -- only ${stem}_TXR.ZED is read`);
  }
  return [stem];
}

/**
 * Every texture the map can name, across all of its asset libraries, and every palette beside them.
 *
 * The viewer used to read `MP<N>_TXR.ZED` alone, which is why twelve maps reported missing skies,
 * weapons and vehicles: those live in the shared libraries the world root lists, and they are already
 * inside the same `MP<N>.ZDB` the viewer downloads. Reading the chain costs no new bytes.
 *
 * **First wins.** `LoadTextures_PS2` (`zNode/node_saveload.cpp:172-193`) skips a name an
 * already-loaded library owns, and the map's own library is last in `assetlibs`, so a map-local name
 * never overrides a shared one. `PaletteTable.fromZars` already resolves its ids the same way, so the
 * palettes go in the same order.
 *
 * A library missing its `_TXR` or `_PAL` member is normal -- `JUNK_PAL.ZED` does not exist on most
 * maps, because `null_xmas.bmp` is direct 16bpp and needs no palette -- so a missing member of one
 * library is a skip. Only a total failure costs the diagnostic and the textures.
 */
function textureLibrary(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes):
{ palettes: PaletteTable; keys: Map<string, { zar: Zar; key: ZarKey }>; libs: number } | null {
  const stems = assetLibStems(bytes, toc, stem, notes);
  const keys = new Map<string, { zar: Zar; key: ZarKey }>();
  const pals: Zar[] = [];
  let found = 0;
  for (const lib of stems) {
    try {
      const txr = Zar.parse(zdbMember(bytes, toc, `${lib}_TXR.ZED`));
      found++;
      for (const key of txr.find('textures')?.children ?? []) {
        const name = textureKey(key.name);
        if (!keys.has(name)) keys.set(name, { zar: txr, key });   // first library wins
      }
    } catch { /* a library with no textures of its own is ordinary */ }
    try {
      pals.push(Zar.parse(zdbMember(bytes, toc, `${lib}_PAL.ZED`)));
    } catch { /* and one with no palettes likewise */ }
  }
  if (found === 0) {
    notes.add(`textures: no readable _TXR.ZED among ${stems.length} asset libs -- `
      + 'the map draws in vertex colour alone');
    return null;
  }
  return { palettes: PaletteTable.fromZars(pals), keys, libs: stems.length };
}

/** 36 section 6: the shown name is `READERM.ZAR/mission.rdr`'s `description`, as `listMaps` reads it. */
function missionName(bytes: Uint8Array, toc: ZdbEntry[], notes: Notes): string | null {
  try {
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr');
    if (!mission) return null;
    const name = rdrGet(parseRdr(readerm.data(mission)), 'description');
    return typeof name === 'string' ? name : null;
  } catch (e) {
    notes.add(`mission name: ${say(e)}`);
    return null;
  }
}

/**
 * Whether a decoded texture's alpha is a ramp rather than a switch. A corona, a glow or a soft-edged
 * decal has alpha between 0 and full; a cutout leaf or a wall has only the two ends. The flag on the
 * record says a texture *has* alpha, not what shape it is, and drawing a ramp with an alpha test is
 * what turns a light into a flat disc on a black square.
 */
/**
 * Is every pixel solid? A texture with so much as a punched-out corner is a *sheet* -- a leaf card, a
 * chain-link panel, a frond -- and the artists drew those as one face meant to be seen from both sides.
 * An all-solid texture skins a closed thing, and `world.ts` culls its back faces.
 *
 * Sampled the same way `isGraded` samples, and by the same 247 threshold, so the two agree about what
 * counts as solid.
 */
export function isOpaque(rgba: Rgba): boolean {
  const a = rgba.data;
  const step = Math.max(4, (Math.floor(a.length / 4 / 4096) || 1) * 4);
  for (let i = 3; i < a.length; i += step) if (a[i]! < 247) return false;
  return true;
}

function isGraded(rgba: Rgba): boolean {
  const a = rgba.data;
  let soft = 0;
  // Every fourth byte, and only a sample of them: a 256x256 texture is 65,536 pixels and the answer
  // does not need all of them.
  const step = Math.max(4, (Math.floor(a.length / 4 / 4096) || 1) * 4);
  for (let i = 3; i < a.length; i += step) {
    const v = a[i]!;
    if (v > 8 && v < 247 && ++soft > 16) return true;
  }
  return false;
}

/** `MP*.ZED/cameras/camera`: fog colour, range and flags, the way the level authored them. */
function cameraParams(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): CameraParams | null {
  try {
    const params = parseCameraParams(Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`)));
    if (!params) notes.add(`${stem}.ZED: no cameras/camera key, so no fog`);
    return params;
  } catch (e) {
    notes.add(`cameras/camera: ${say(e)}`);
    return null;
  }
}

/** `MP*.ZED/MetersPerUnit`, the scale the research tables quote positions in. */
function metersPerUnit(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): number {
  try {
    const zed = Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`));
    const key = zed.find('MetersPerUnit');
    if (key && key.size === 4) return new Reader(zed.data(key)).f32(0);
    notes.add(`${stem}.ZED: no MetersPerUnit key, assuming ${DEFAULT_METERS_PER_UNIT}`);
  } catch (e) {
    notes.add(`MetersPerUnit: ${say(e)}`);
  }
  return DEFAULT_METERS_PER_UNIT;
}

/**
 * `MP*.ZED/GlobalLighting`, the map's three directional lights and its ambient. All 34 maps carry it,
 * so an absence is worth a diagnostic rather than a silent fallback.
 */
function lightRig(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): GlobalLighting | null {
  try {
    const rig = parseGlobalLighting(Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`)));
    if (!rig) notes.add(`${stem}.ZED: no GlobalLighting key, lighting with a stand-in rig`);
    return rig;
  } catch (e) {
    notes.add(`GlobalLighting: ${say(e)}`);
    return null;
  }
}

/**
 * 36 section 2: the model buffers a map draws from. None of the three is required: a map missing its
 * world buffer still draws its props, and one missing a prop library still draws its world, each absence
 * costing one diagnostic. `decoder` names whatever the scene graph then asks for and cannot find.
 *
 * `CLIB_MDL.ZED` is deliberately absent, its models being the `MESH_` form the scene graph never names.
 */
function mdlArchives(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): Zar[] {
  // The same asset-library chain the textures come from: 15 of the 22 maps name prop models that live
  // in libraries the viewer used to leave shut -- `TURR_MDL` (turrets) on eight of them, `PAVE_MDL`
  // (the Pave Hawk) on five, and so on. `WORL_MDL` is the world itself and is not an asset library, so
  // it leads; the chain follows in its own order, which puts the map's own library last, as the engine
  // does.
  //
  // `CLIB_MDL` is excluded on purpose. Character models are a different chain form -- `CMesh` /
  // `CSubMesh`, `vis_main.cpp:246-265` -- that this walker produces garbage on (36 section 3).
  const members = ['WORL_MDL.ZED', ...assetLibStems(bytes, toc, stem, notes)
    .filter((lib) => lib !== 'CLIB')
    .map((lib) => `${lib}_MDL.ZED`)];
  const out: Zar[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member)) continue;
    seen.add(member);
    try {
      out.push(Zar.parse(zdbMember(bytes, toc, member)));
    } catch {
      // A library with no models of its own is ordinary -- MP53 has no `MP53_MDL.ZED` at all and is
      // right not to, drawing its three props out of shared libraries instead.
    }
  }
  if (out.length === 0) notes.add(`no model archive of ${members.length} could be read`);
  return out;
}

/** What gets drawn where: the world's chunks one placement each, and the props grouped by model-node. */
interface Placement {
  world: PlacedModel[];
  /** One group per (model, node); every member draws the same geometry at a different matrix. */
  props: PlacedModel[][];
  /**
   * A placement's position in the engine's walk of the graph: `flattenScene` recurses the tree depth
   * first, children in order, prototypes realised in place, which is what reCOM's `CPipe::RenderNode`
   * does, and `placeInstances` keeps that order. The clutter, which the walk never reaches (it is
   * placed from `CLUTTER.ZAR`), ranks after everything the graph places.
   */
  rank: (p: PlacedModel) => number;
  /**
   * Whether a placement is a state the map does not open in. Not a flag on the node -- the engine
   * sets these from game logic. A crate is `crates_weapons/healthy` beside
   * `crates_weapons/whats_left` and `crates_weapons/parts/part1..15`; a lamp is `light02` with a
   * `light02/nolight` child; an alarm has `hornlightbox_on` and `hornlightbox_off`. The graph holds
   * every state and the game switches them; the map opens on the intact, lit one. The naming is the
   * exporter's and is the same on every map (surveyed over all 22).
   */
  alternate: (p: PlacedModel) => boolean;
  /** The LOD band per model name (`lodBands`), for the copies the engine shows by camera range. */
  lod: Map<string, LodBand>;
  /** The texture scroll of a placement's node (`TextureScroll_Object`), or null. */
  scroll: (p: PlacedModel) => [number, number] | null;
  /** Zero once the graph has been read: the matrices are already in the positions. */
  origin: [number, number, number];
  /** The collision hull, already in world space and already cut into segments (36 section 6). */
  collision: CollisionLines;
}

/**
 * An empty hull: what a map whose graph would not parse has to offer the overlay. A function, not a
 * shared constant, because `transferables` hands these buffers to the page -- a constant's arrays would
 * be detached by the first load that used them and unusable by the second.
 */
const noCollision = (): CollisionLines => ({ positions: new Float32Array(0), colors: new Uint8Array(0), polygons: 0 });

/**
 * A node name that is a state the map opens without: the destroyed remains, the debris, the lamp off,
 * and the `terrorist_pulse` ribbon round a demolition crate, which the game pulses and the graph
 * holds at full brightness.
 */
const ALTERNATE_STATE = /^(vis_)?whats_left$|^parts$|^(beer|radio)_parts$|^nolight$|_off$|_pulse$/i;

function place(library: ModelLibrary, bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): Placement {
  try {
    const geo = Zar.parse(zdbMember(bytes, toc, `${stem}_GEO.ZED`));
    const models = parseSceneGraph(geo);
    const placed = placeInstances(models, WORLD_MODEL);
    const world = placed.filter((p) => p.modelName === WORLD_MODEL);
    if (world.length === 0) throw new Error(`no ${WORLD_MODEL} node carries visuals`);
    const groups = new Map<string, PlacedModel[]>();
    const ranks = new Map<PlacedModel, number>();
    // The clutter joins the props: `CLUTTER.ZAR` places models the graph holds as prototypes but never
    // instances from the root, so without this pass Desert Glory's ground is bare (36 section 2).
    for (const p of [...placed, ...clutter(models, bytes, toc, notes)]) {
      ranks.set(p, ranks.size);
      if (p.modelName === WORLD_MODEL) continue;
      const key = `${p.modelName}#${p.nodeIndex}`;
      const group = groups.get(key);
      if (group) group.push(p);
      else groups.set(key, [p]);
    }
    const alternate = (p: PlacedModel): boolean => p.path.split(/[/=]/).some((segment) => ALTERNATE_STATE.test(segment));
    const scrolls = textureScroll(bytes, toc, stem, notes);
    const scroll = (p: PlacedModel): [number, number] | null => {
      const node = p.path.split('/').pop()?.split('=')[0] ?? '';
      return scrolls.get(node) ?? null;
    };
    return {
      world, props: [...groups.values()], origin: [0, 0, 0], collision: hull(models, notes),
      rank: (p) => ranks.get(p) ?? 0,
      alternate,
      lod: lods(bytes, toc, notes),
      scroll,
    };
  } catch (e) {
    notes.add(`scene graph: ${say(e)} -- falling back to the modal node translation, props omitted`);
    const entry = library.get(WORLD_MODEL);
    const every: PlacedModel = {
      modelName: WORLD_MODEL, path: WORLD_MODEL, nodeIndex: -1, instanceIndex: null,
      chunks: entry ? entry.nodes.map((n) => n.name) : [],
      cull: entry ? entry.nodes.map(() => true) : [],
      facade: 0,
      world: Float32Array.from(IDENTITY), rowMajor: Float32Array.from(IDENTITY), lit: false,
    };
    return {
      world: [every], props: [], origin: worldOrigin(bytes, toc, stem, notes), collision: noCollision(),
      rank: () => 0, alternate: () => false, lod: new Map(), scroll: () => null,
    };
  }
}

/** The LOD band per model named by `READERM.ZAR/lod.rdr`, or none when the record is missing or will not parse. */
function lods(bytes: Uint8Array, toc: ZdbEntry[], notes: Notes): Map<string, LodBand> {
  try {
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const lod = readerm.root.children.find((k) => k.name.toLowerCase() === 'lod.rdr');
    if (!lod) return new Map();
    return lodBands(parseRdr(readerm.data(lod)) as RdrNode);
  } catch (e) {
    notes.add(`lod table: ${say(e)}`);
    return new Map();
  }
}

/** The scrolling textures of the world root, by node name, or none. */
function textureScroll(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): Map<string, [number, number]> {
  try {
    const root = parseWorldRoot(Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`)));
    return new Map(root.textureScroll.map((b) => [b.nodeName, [b.du, b.dv]]));
  } catch (e) {
    notes.add(`texture scroll: ${say(e)}`);
    return new Map();
  }
}

/**
 * The map's collision hull as line segments. It is drawn from the same graph and the same matrices as
 * the chunks, so a hull that does not sit on the floor is a placement bug, not a collision one -- which
 * is most of why the overlay is worth having.
 */
function hull(models: SceneNode[], notes: Notes): CollisionLines {
  try {
    return collisionLines(worldCollision(models, WORLD_MODEL));
  } catch (e) {
    notes.add(`collision: ${say(e)}`);
    return noCollision();
  }
}

/**
 * `CLUTTER.ZAR`'s instances, placed. A model it names that the graph does not hold costs one diagnostic
 * for the model, not one per instance -- 36 of the same rock would otherwise say the same thing 36 times.
 */
function clutter(models: SceneNode[], bytes: Uint8Array, toc: ZdbEntry[], notes: Notes): PlacedModel[] {
  try {
    const { placed, missing, malformed } = placeClutter(
      models, parseClutter(Zar.parse(zdbMember(bytes, toc, 'CLUTTER.ZAR'))));
    for (const name of missing) notes.add(`clutter ${name}: named by CLUTTER.ZAR but not in the scene graph`);
    // Records that are not the affine matrix the format says. Drawn, they compose into basis rows
    // thousands of units long and streak across the map; this is Abandoned's whole problem.
    for (const m of malformed) {
      notes.add(`clutter ${m.modelName}: ${m.instances} instance(s) whose params are not an affine`
        + ' matrix, so they are not placed (scene/clutter.ts isAffineRowVector)');
    }
    return placed;
  } catch (e) {
    notes.add(`clutter: ${say(e)}`);
    return [];
  }
}

/**
 * World-space line segments, accumulated across every placement that draws a strip.
 *
 * A `LineStrip` is points in draw order with no index list, so strip point `k` joins point `k+1` and a
 * strip of n points is n-1 segments. They are flattened into one pair list here rather than kept as
 * strips, because one `LineSegments` draw is cheaper than a few hundred `Line` objects and the whole
 * map's worth is under a thousand segments.
 */
class Segments {
  private readonly groups = new Map<string, {
    textureName: string | null; fog: boolean; order: number;
    positions: number[]; uvs: number[]; colors: number[]; normals: number[];
  }>();

  add(strip: LineStrip, rowMajor: Float32Array, order: number): void {
    const n = strip.positions.length / 3;
    if (n < 2) return;                                   // a single point draws nothing
    const textureName = strip.textureName === null ? null : textureKey(strip.textureName);
    const key = `${textureName ?? ''}|${strip.fog ? 1 : 0}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { textureName, fog: strip.fog, order, positions: [], uvs: [], colors: [], normals: [] };
      this.groups.set(key, g);
    }
    g.order = Math.min(g.order, order);
    const m = rowMajor;
    const at = (k: number): [number, number, number] =>
      transformPoint(m, strip.positions[k * 3]!, strip.positions[k * 3 + 1]!, strip.positions[k * 3 + 2]!);
    // The 3x3 alone, as `placeMesh` rotates a mesh's normals: a direction has no translation.
    const rot = (k: number): [number, number, number] => {
      const [x, y, z] = [strip.normals[k * 3]!, strip.normals[k * 3 + 1]!, strip.normals[k * 3 + 2]!];
      return [
        x * m[0]! + y * m[4]! + z * m[8]!,
        x * m[1]! + y * m[5]! + z * m[9]!,
        x * m[2]! + y * m[6]! + z * m[10]!,
      ];
    };
    for (let k = 0; k + 1 < n; k++) {
      for (const end of [k, k + 1]) {
        g.positions.push(...at(end));
        g.normals.push(...rot(end));
        g.uvs.push(strip.uvs[end * 2]!, strip.uvs[end * 2 + 1]!);
        g.colors.push(
          strip.colors[end * 4]!, strip.colors[end * 4 + 1]!,
          strip.colors[end * 4 + 2]!, strip.colors[end * 4 + 3]!,
        );
      }
    }
  }

  /** Null when the map drew no strips, so the viewer can skip the object entirely. */
  result(): LoadedLineGroup[] | null {
    if (this.groups.size === 0) return null;
    return [...this.groups.values()].map((g) => ({
      textureName: g.textureName, fog: g.fog, order: g.order,
      positions: Float32Array.from(g.positions),
      uvs: Float32Array.from(g.uvs),
      colors: Float32Array.from(g.colors),
      normals: Float32Array.from(g.normals),
    })).sort((a, b) => a.order - b.order);
  }
}

/**
 * Line segments in world space that share a texture and a fog bit: two points a segment, a uv, an rgba
 * and a normal per point, and the earliest place in the scene walk any of them was drawn.
 */
export interface LoadedLineGroup {
  textureName: string | null;
  fog: boolean;
  order: number;
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  normals: Float32Array;
}

/**
 * Decodes the chains one placement draws. A chunk that will not interpret becomes a diagnostic and the
 * rest of the map still draws, as it did before the scene graph existed.
 */
function decoder(library: ModelLibrary, notes: Notes): (p: PlacedModel) => { meshes: (MeshData & { cull: boolean })[]; lines: LineStrip[] } {
  const offsets = new Map<string, Map<string, number>>();
  return (p) => {
    const entry = library.get(p.modelName);
    if (!entry) {
      notes.add(`model ${p.modelName}: in the scene graph but not in any MDL archive`);
      return { meshes: [], lines: [] };
    }
    let where = offsets.get(p.modelName);
    if (!where) offsets.set(p.modelName, where = new Map(entry.nodes.map((n) => [n.name, n.offset])));
    const meshes: (MeshData & { cull: boolean })[] = [];
    const lines: LineStrip[] = [];
    for (const [i, chunk] of p.chunks.entries()) {
      const at = where.get(chunk);
      if (at === undefined) {
        notes.add(`chunk ${p.modelName}/${chunk}: no such chain in the model buffer`);
        continue;
      }
      try {
        const parts = interpretChainParts(walkChain(entry.buffer, at, chunk));
        // The cull is per visual, and a chunk is one visual: every mesh out of it takes its flag.
        meshes.push(...parts.meshes.map((mesh) => ({ ...mesh, cull: p.cull[i] ?? true })));
        lines.push(...parts.lines);
      } catch (e) {
        notes.add(`chunk ${p.modelName}/${chunk}: ${say(e)}`);
      }
    }
    return { meshes, lines };
  };
}

/**
 * Carries a decoded chunk from model space into the world, positions and both sets of normals. Rotating
 * the normals matters even though Frostfire's six world matrices are pure translations: other maps'
 * need not be, and an unrotated normal is a lighting bug nobody would trace back to here.
 */
function placeMesh(mesh: MeshData, m: Float32Array): MeshData {
  if (IDENTITY.every((v, i) => v === m[i])) return mesh;
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const p = transformPoint(m, mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
    positions[i] = p[0]; positions[i + 1] = p[1]; positions[i + 2] = p[2];
  }
  const rotate = (n: Float32Array | null): Float32Array | null => {
    if (!n) return null;
    const out = new Float32Array(n.length);
    for (let i = 0; i < n.length; i += 3) {
      // The 3x3 alone: a direction has no translation. Row-vector, so the rows multiply the components.
      out[i] = n[i]! * m[0]! + n[i + 1]! * m[4]! + n[i + 2]! * m[8]!;
      out[i + 1] = n[i]! * m[1]! + n[i + 1]! * m[5]! + n[i + 2]! * m[9]!;
      out[i + 2] = n[i]! * m[2]! + n[i + 1]! * m[6]! + n[i + 2]! * m[10]!;
    }
    return out;
  };
  return { ...mesh, positions, normals: rotate(mesh.normals), faceNormals: rotate(mesh.faceNormals) };
}

/**
 * The fallback for a map whose scene graph would not read: SEMANTICS section 8's modal translation, the
 * one shared by most of the `worldmodel` subtree's direct children -- (960, 0, 800) on Frostfire. It
 * misplaces the chunks whose node carries a different matrix, which is why it is no longer the first
 * choice; `place` only reaches for it when `MP*_GEO.ZED` cannot be parsed at all.
 */
function worldOrigin(bytes: Uint8Array, toc: ZdbEntry[], stem: string, notes: Notes): [number, number, number] {
  try {
    const geo = Zar.parse(zdbMember(bytes, toc, `${stem}_GEO.ZED`));
    const children = geo.find('models/worldmodel/children');
    if (!children) throw new Error(`${stem}_GEO.ZED has no models/worldmodel/children key`);
    const counts = new Map<string, { translation: [number, number, number]; nodes: number }>();
    for (const node of children.children) {
      const nparams = geo.child(node, 'nparams');
      if (!nparams || nparams.size !== NPARAMS_SIZE) continue;
      const r = new Reader(geo.data(nparams));
      const translation: [number, number, number] = [r.f32(TRANSLATION_AT), r.f32(TRANSLATION_AT + 4), r.f32(TRANSLATION_AT + 8)];
      const id = translation.join(',');
      const seen = counts.get(id) ?? { translation, nodes: 0 };
      seen.nodes++;
      counts.set(id, seen);
    }
    const modal = [...counts.values()].sort((a, b) => b.nodes - a.nodes)[0];
    if (!modal) throw new Error(`${stem}_GEO.ZED: no worldmodel child carries a 96-byte nparams`);
    const total = [...counts.values()].reduce((n, c) => n + c.nodes, 0);
    if (modal.nodes * 2 <= total) {
      notes.add(`world placement: the modal node translation covers only ${modal.nodes} of ${total} chunks; chunk-exact placement is a later task`);
    }
    return modal.translation;
  } catch (e) {
    notes.add(`world placement: ${say(e)}`);
    return [0, 0, 0];
  }
}
