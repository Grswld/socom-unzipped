import { parseRdr, rdrGet, readZarMembers, readZdbMember, Zar, type AssetSource } from '@s2u/archive';
import { decodeTexture, PaletteTable, parseTextureRecord, type GsState, type Rgba } from '@s2u/gs';
import {
  decalSetRows, decodeEffectProgram, EFFECT_MEMBERS, effectLibrary, flattenScene, parseAnimSets, parseSceneGraph,
  type DecalEntry, type EffectMesh, type EffectProgram,
} from '@s2u/scene';
import { parseSoils } from '@s2u/sound';

/**
 * The gunplay's effects, read off the disc in the worker for one map (web/redotcom/docs/research/89), as the sound is
 * (`./soundData`): at run time, never written into the source.
 *
 * - **the programs**: every animation of the map's `CZANIM.ZAR` (the `common` set: the muzzle effects, the casings,
 *   the grenades') and its `MZANIM.ZAR` (the `mission` set: the bullet impacts `bullet_hit_<material>`, research 89 §5),
 *   decoded (`@s2u/scene`'s `decodeEffectProgram`); the engine looks a name up in every set (`FUN_0026a250`), the
 *   common set first;
 * - **the models**: `COMMON/EFFE_GEO.ZED` + `EFFE_MDL.ZED`'s (`effectLibrary`: the casings, the flashes, the chunks);
 * - **the weapons**: `ZWEAPON.ZAR/zweapon.rdr`'s `HitAnimName` of each held weapon (`bullet_hit` for every gun);
 * - **the textures**: the models', the particle sources', and the marks', out of `COMMON/EFFE_TXR.ZED` and
 *   `COMMON/ALPH_TXR.ZED`, each against its own `_PAL` (a library cites its own palette ids, `./hudBitmaps`), with the
 *   GS state its bind packet sets (the blend: `cloudpuff01.tif` source alpha, `effect_muzzle01.tif` additive);
 * - **the materials**: `READERC.ZAR/materials.rdr`'s SOILS names by index -- the collision polygon's `material` byte
 *   (research 81 §4) -- and `decals.rdr`'s rows of the rifle's `DecalSet` per material name.
 *
 * Each part is optional: what will not read is left out and said in `missing`.
 */

/** The zAnim archives of a map, in the order a name is looked up. */
export const EFFECT_ARCHIVES: readonly string[] = ['CZANIM.ZAR', 'MZANIM.ZAR'];
/** The weapons whose `HitAnimName` is read: the SEAL's rifle as held and the plain M4A1. */
export const EFFECT_WEAPONS: readonly string[] = ['M4A1 SD', 'M4A1'];
/** The two texture libraries the effects draw from (a map archive's `RUN\COMMON\*`). */
export const EFFECT_TEXTURE_LIBS: readonly string[] = ['EFFE', 'ALPH'];
/** The rifle's `DecalSet` (`zweapon.rdr`: the M4A1 and the M4A1 SD both mark with it). */
export const MARK_SET = 'BULLET_MARK_SMALL';

export interface EffectTexture { rgba: Rgba; gs: GsState | null }
export interface EffectModelData { name: string; parts: { node: string; path: string; world: Float32Array; meshes: EffectMesh[] }[] }

export interface EffectData {
  archive: string;
  programs: EffectProgram[];
  models: EffectModelData[];
  textures: [string, EffectTexture][];
  /** Textures the programs name that neither library holds. */
  absent: string[];
  /** SOILS names by the polygon's material byte (the engine's `UNKNOWN` 0 and `PARTICLE_SYSTEM` 1 first). */
  materials: string[];
  /**
   * The map's `DefaultMaterial` (`READERM.ZAR/<map>.rdr`: Frostfire `METAL_THICK`, Desert Glory `SAND`) as a SOILS
   * index, or 0: a polygon whose byte is 0 takes it (`FUN_002dc1d0` reads `DAT_0044f310`, which `FUN_002ddc30` sets
   * at the map's load, decomp 152110).
   */
  defaultMaterial: number;
  /** `decals.rdr`'s `MARK_SET` rows. */
  marks: DecalEntry[];
  /** `decals.rdr`'s `FOOTSTEP_DECALS`: the footprint's bitmap by material name (SAND, SNOW). */
  footprints: [string, string][];
  /**
   * The mission's ambient effects (research 89 §12): its `MZANIM`'s self-starting animations (activation 1) that
   * draw -- a particle source or a light, directly or through a call -- Frostfire's tower flames, the torches, the
   * waterfalls' spray, the snow and rain about the camera, the bugs.
   */
  ambient: string[];
  /** The scene nodes those name, by name: their world matrices (16 floats, three's element order). */
  sceneNodes: [string, number[]][];
  /** `zweapon.rdr`'s `HitAnimName` by weapon (`InternalName`). */
  hitAnims: [string, string][];
  missing: string[];
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The texture names a program draws (its particle sources'). */
function programTextures(p: EffectProgram): string[] {
  const out: string[] = [];
  for (const s of p.sequences) for (const o of s.ops) if (o.op === 'particles') for (const t of o.source.textures) out.push(t.name.toLowerCase());
  return out;
}

/** Reads a map's effect data off `source`. */
export async function effectsFromDisc(source: AssetSource, mapPath: string, archive: string): Promise<EffectData> {
  const missing: string[] = [];
  const member = async (suffix: string): Promise<Uint8Array | null> => {
    try { return await readZdbMember(source, mapPath, suffix); } catch (e) { missing.push(`${mapPath} ${suffix}: ${why(e)}`); return null; }
  };

  const programs: EffectProgram[] = [];
  const seen = new Set<string>();
  const autoStart: string[] = [];
  for (const archiveName of EFFECT_ARCHIVES) {
    const bytes = await member(archiveName);
    if (!bytes) continue;
    try {
      for (const set of parseAnimSets(Zar.parse(bytes)).sets) {
        for (const a of set.anims) {
          const key = a.name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          programs.push(decodeEffectProgram(a));
          if (archiveName === 'MZANIM.ZAR' && (a.params.flags & 3) === 1) autoStart.push(a.name);
        }
      }
    } catch (e) { missing.push(`${archiveName}: ${why(e)}`); }
  }

  const models: EffectModelData[] = [];
  const textureNames = new Set<string>(programs.flatMap(programTextures));
  const geo = await member(EFFECT_MEMBERS.geo), mdl = await member(EFFECT_MEMBERS.mdl);
  if (geo && mdl) {
    try {
      const lib = effectLibrary(Zar.parse(geo), Zar.parse(mdl));
      for (const name of lib.names()) {
        const m = lib.decode(name);
        for (const d of m.diagnostics) if (!/line strip/.test(d)) missing.push(`effect ${name}: ${d}`);
        if (m.parts.length === 0) continue;
        models.push({ name, parts: m.parts });
        for (const t of m.textures) textureNames.add(t.toLowerCase());
      }
    } catch (e) { missing.push(`EFFE_GEO/EFFE_MDL: ${why(e)}`); }
  }

  const materials: string[] = [];
  const marks: DecalEntry[] = [];
  const footprints: [string, string][] = [];
  try {
    const got = await readZarMembers(source, 'RUN/READERC.ZAR', ['materials.rdr', 'decals.rdr']);
    const mats = got.get('materials.rdr'), decals = got.get('decals.rdr');
    if (mats) materials.push(...parseSoils(parseRdr(mats)).map((m) => m.name)); else missing.push('READERC.ZAR: no materials.rdr');
    if (decals) {
      const root = parseRdr(decals);
      marks.push(...decalSetRows(root, MARK_SET));
      const list = rdrGet(root, 'FOOTSTEP_DECALS');
      for (const row of Array.isArray(list) ? list : []) {
        const m = rdrGet(row, 'MATERIALNAME'), t = rdrGet(row, 'TEXTURENAME');
        if (typeof m === 'string' && typeof t === 'string') footprints.push([m, t.toLowerCase()]);
      }
    } else missing.push('READERC.ZAR: no decals.rdr');
  } catch (e) { missing.push(`READERC.ZAR: ${why(e)}`); }
  for (const m of marks) textureNames.add(m.texture.toLowerCase());
  for (const [, t] of footprints) textureNames.add(t);
  textureNames.add('light_map.tif');                  // the `LIGHT` pass's spot (`FUN_00315110`'s default)

  let defaultMaterial = 0;
  const readerm = await member('READERM.ZAR');
  if (readerm) {
    try {
      const zar = Zar.parse(readerm);
      const key = zar.root.children.find((k) => k.name.toLowerCase() === `${archive.toLowerCase()}.rdr`);
      // `<map>.rdr` is `(fileinfo (...) world_params (name (mp2) ... DefaultMaterial (METAL_THICK) ...))`.
      const root = key ? parseRdr(zar.data(key)) : undefined;
      const top = Array.isArray(root) && Array.isArray(root[0]) ? root[0] : root;
      const params = top === undefined ? undefined : rdrGet(top, 'world_params');
      const name = params === undefined ? undefined : rdrGet(params, 'DefaultMaterial');
      if (typeof name === 'string') defaultMaterial = Math.max(0, materials.indexOf(name));
      else missing.push(`READERM.ZAR: no DefaultMaterial in ${archive.toLowerCase()}.rdr`);
    } catch (e) { missing.push(`READERM.ZAR: ${why(e)}`); }
  }

  const hitAnims: [string, string][] = [];
  try {
    const got = (await readZarMembers(source, 'RUN/ZWEAPON.ZAR', ['zweapon.rdr'])).get('zweapon.rdr');
    if (got) {
      const list = rdrGet(parseRdr(got), 'ZWEAPON');
      for (const r of Array.isArray(list) ? list : []) {
        if (!Array.isArray(r)) continue;
        const name = rdrGet(r, 'InternalName'), hit = rdrGet(r, 'HitAnimName');
        if (typeof name === 'string' && typeof hit === 'string' && EFFECT_WEAPONS.includes(name)) hitAnims.push([name, hit]);
      }
    } else missing.push('ZWEAPON.ZAR: no zweapon.rdr');
  } catch (e) { missing.push(`ZWEAPON.ZAR: ${why(e)}`); }

  const textures: [string, EffectTexture][] = [];
  const left = new Set([...textureNames].map((t) => t.toLowerCase()));
  const quiet = async (suffix: string): Promise<Uint8Array | null> => {
    try { return await readZdbMember(source, mapPath, suffix); } catch { return null; }
  };
  // The effect libraries first, then the map's own (a mission's ambient effects draw its own bitmaps: Blizzard's
  // `effect_snow*.tif`, Shadow Falls' butterflies), each against its own palettes.
  for (const lib of [...EFFECT_TEXTURE_LIBS, archive, 'CLIB', 'FLIB']) {
    if (left.size === 0) break;
    const own = EFFECT_TEXTURE_LIBS.includes(lib);
    const txr = own ? await member(`${lib}_TXR.ZED`) : await quiet(`${lib}_TXR.ZED`);
    const pal = own ? await member(`${lib}_PAL.ZED`) : await quiet(`${lib}_PAL.ZED`);
    if (!txr || !pal) continue;
    try {
      const zar = Zar.parse(txr);
      const palettes = PaletteTable.fromZars([Zar.parse(pal)]);
      for (const key of zar.find('textures')?.children ?? []) {
        const name = key.name.toLowerCase();
        if (!left.has(name)) continue;
        const texdat = zar.child(key, 'texdat');
        if (!texdat) continue;
        try {
          const record = parseTextureRecord(key.name, zar.data(texdat));
          const decoded = decodeTexture(record, palettes);
          for (const d of decoded.diagnostics) missing.push(`${name}: ${d}`);
          textures.push([name, { rgba: decoded.rgba, gs: record.gs }]);
          left.delete(name);
        } catch (e) { missing.push(`${name}: ${why(e)}`); }
      }
    } catch (e) { missing.push(`${lib}_TXR.ZED: ${why(e)}`); }
  }
  // A texture neither library holds (`fire_very_large`'s `fire101.tif`, a mission's): its particles draw untextured.
  const absent = [...left];

  // The ambient effects and the scene nodes they sit at (the map's graph: the emitters' way, `./soundData`).
  const byName = new Map(programs.map((p) => [p.name.toLowerCase(), p]));
  const draws = (name: string, depth = 0): boolean => {
    const p = byName.get(name.toLowerCase());
    if (!p || depth > 4) return false;
    return p.sequences.some((s) => s.ops.some((o) => o.op === 'particles' || o.op === 'light' || (o.op === 'call' && draws(o.anim, depth + 1))));
  };
  const ambient = autoStart.filter((n) => draws(n));
  const sceneNodes: [string, number[]][] = [];
  const wantedNodes = new Set<string>();
  for (const n of ambient) for (const node of byName.get(n.toLowerCase())?.nodes ?? []) if (node !== 'NA' && node !== 'camera') wantedNodes.add(node);
  if (wantedNodes.size > 0) {
    const geo = await member(`${archive}_GEO.ZED`);
    if (geo) {
      try {
        for (const inst of flattenScene(parseSceneGraph(Zar.parse(geo)))) {
          if (wantedNodes.has(inst.node.name) && !sceneNodes.some(([n]) => n === inst.node.name)) sceneNodes.push([inst.node.name, Array.from(inst.world)]);
        }
      } catch (e) { missing.push(`${archive}_GEO.ZED: ${why(e)}`); }
    }
  }
  return { archive, programs, models, textures, absent, materials, defaultMaterial, marks, footprints, ambient, sceneNodes, hitAnims, missing };
}

/** The buffers the data can hand over rather than copy. */
export function effectTransferables(data: EffectData): Transferable[] {
  const out = new Set<ArrayBufferLike>();
  for (const [, t] of data.textures) out.add(t.rgba.data.buffer);
  return [...out].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);
}
