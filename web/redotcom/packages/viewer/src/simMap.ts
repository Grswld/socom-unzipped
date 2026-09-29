import { parseRdr, parseZdb, rdrGet, Zar, zdbMember, type AssetSource, type ZdbEntry } from '@s2u/archive';
import {
  characterModelNames, collisionOwners, DEFAULT_GRID_PARAMS, parseAiMaps, parseCharacterTable, parseGridParams, parseSceneGraph,
  placeSpawnSlots, readSkeleton, spawnsFor, teamCharacter, worldCollision,
  type Grid, type MotionClip, type Skeleton, type SpawnSlot, type Spawns,
} from '@s2u/scene';
import { actionRoots, ACTION_CLIPS, groundGrid, packGround, type GroundData, type Stance } from './mover';
import { SEAL_ANIMS } from './locomotion';
import { clipsFromPack, motionTableFromArchive, MOTION_PACK_PATH, type MotionEntry } from './motionTable';
import { TRAVERSAL_CLIPS } from './traversal';
import { readDoors, type DoorSpec } from './doors';

/**
 * A map as the shared sim needs it (web sprint 3, M2; spec W3.R6: the server loads only the hulls, the tuning and the
 * weapon records, from a private path): the probe's hull (`GroundData`, the same polygons, nodes and `grid_params`
 * `./loadMap` packs for the page's walk), its grid, the map's shown name, its measured spawns and its `AIMAPS.MPS` spawn
 * slots on the probe's floor. No textures, no meshes: a Node server holds all 22 maps in a few tens of megabytes.
 */
export interface SimMap {
  /** The archive's stem (`MP2`). */
  stem: string;
  /** `READERM.ZAR/mission.rdr`'s `description` (`FROSTFIRE`), or the stem. */
  name: string;
  ground: GroundData;
  grid: Grid;
  /** The two measured spawns (`@s2u/scene` `spawns.ts`), when the map is one of the 22. */
  spawns: Spawns | null;
  /** `AIMAPS.MPS`'s spawn slots, side 0 (A) and side 1 (B), each on the probe's floor (research 75). */
  slots: SpawnSlot[];
  /** Its twin records: where a SEAL respawns (research 91 section 4, `FUN_002b7ee0`), placed the same way. */
  respawns: SpawnSlot[];
  /**
   * DOORS (`./doors`, web/docs/research/92-doors.md): the map's doors, their polygons marked in `ground.owners`
   * (`sweep`) so the server's movers read them as they swing. Absent on a map built by hand without them.
   */
  doors?: DoorSpec[];
  /** What went wrong on the way (a missing member costs a line, never the load, except the hull's). */
  notes: string[];
}

const WORLD_MODEL = 'worldmodel';
const say = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const stemOf = (path: string): string => path.replace(/^.*\//, '').replace(/\.ZDB$/i, '').toUpperCase();

/** Reads a map archive's hull and spawns. Throws when the scene graph or its collision will not read: no hull, no round. */
export function simMapFromBytes(bytes: Uint8Array, path: string): SimMap {
  const notes: string[] = [];
  const toc = parseZdb(bytes);
  const stem = stemOf(path);
  const models = parseSceneGraph(Zar.parse(zdbMember(bytes, toc, `${stem}_GEO.ZED`)));
  const polys = worldCollision(models, WORLD_MODEL);
  let params = DEFAULT_GRID_PARAMS;
  try {
    params = parseGridParams(Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`)));
  } catch (e) {
    notes.push(`grid_params: ${say(e)} -- the engine's default grid`);
  }
  const owners = collisionOwners(models, WORLD_MODEL);
  const { doors, diagnostics } = readDoors(bytes, toc, models, owners, polys);   // marks the doors' owners: before the pack
  notes.push(...diagnostics);
  const ground = packGround(params, polys, owners);
  const grid = groundGrid(ground);
  const name = missionName(bytes, toc, notes) ?? stem;
  const spawns = spawnsFor(name) ?? null;
  let slots: SpawnSlot[] = [], respawns: SpawnSlot[] = [];
  try {
    const ai = parseAiMaps(zdbMember(bytes, toc, 'AIMAPS.MPS'));
    slots = placeSpawnSlots(ai, spawns ?? undefined, grid);
    respawns = placeSpawnSlots(ai, spawns ?? undefined, grid, true);
  } catch (e) {
    notes.push(`spawn slots: ${say(e)}`);
  }
  return { stem, name, ground, grid, spawns, slots, respawns, doors, notes };
}

export async function loadSimMap(source: AssetSource, path: string): Promise<SimMap> {
  return simMapFromBytes(await source.read(path), path);
}

function missionName(bytes: Uint8Array, toc: ZdbEntry[], notes: string[]): string | null {
  try {
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr');
    if (!mission) return null;
    const name = rdrGet(parseRdr(readerm.data(mission)), 'description');
    return typeof name === 'string' ? name : null;
  } catch (e) {
    notes.push(`mission name: ${say(e)}`);
    return null;
  }
}

/** The clips the sim reads: the mover's action clips (their root motion) and the traversal moves', with the table. */
export interface SimClips {
  clips: MotionClip[];
  table: Map<string, MotionEntry> | null;
  /** `actionRoots(clips)`: what `Walker.actionRoots` takes. */
  roots: Map<string, Float32Array>;
}

/** Every clip name the sim asks the pack for. */
export const SIM_CLIPS: readonly string[] = [
  ...new Set([...Object.keys(ACTION_CLIPS).map((k) => SEAL_ANIMS[k as keyof typeof ACTION_CLIPS]), ...TRAVERSAL_CLIPS]),
];

/** `MOTION_P.ZAR`'s sim clips and `READERC.ZAR`'s `motion.rdr` (null when it will not read). */
export function simClipsFromBytes(motionPack: Uint8Array, readerc: Uint8Array | null): SimClips {
  const clips = clipsFromPack(motionPack, SIM_CLIPS);
  let table: Map<string, MotionEntry> | null = null;
  if (readerc) {
    try { table = motionTableFromArchive(readerc); } catch { table = null; }
  }
  return { clips, table, roots: actionRoots(clips) };
}

export async function loadSimClips(source: AssetSource): Promise<SimClips> {
  let readerc: Uint8Array | null = null;
  try { readerc = await source.read('RUN/READERC.ZAR'); } catch { readerc = null; }
  return simClipsFromBytes(await source.read(MOTION_PACK_PATH), readerc);
}

/**
 * The SEAL's skeleton as the server's hit volumes need it (web sprint 3, M6; research 91 section 1.3): the map's first
 * `navyseals` character's model (`READERM.ZAR/chartype.rdr` through `READERC.ZAR/character.rdr`, as `./body` `loadBody`
 * picks it), its skeleton out of `CLIB_GEO.ZED`, and the three stance idles out of `MOTION_P.ZAR`. No meshes, no
 * textures. The Terrorist models of the 22 maps carry the same 26 bone names in the same order (`al_gman01` on
 * Frostfire, `test/hitVolumes.test.ts`), so one SEAL skeleton serves both teams.
 */
export interface SimSkeleton {
  /** `seal_A_scuba` on Frostfire. */
  model: string;
  /** The `character.rdr` character (`mp2_seal1`), or null when the table did not read. */
  character: string | null;
  skeleton: Skeleton;
  /** The idle each posture stands in (`SEAL_ANIMS` stand, crouch, prone); null when the pack lacks it. */
  idles: Record<Stance, MotionClip | null>;
  notes: string[];
}

/** The SEAL model `./body` falls back to (W2.R4), and a LOD copy's suffix (`_1`, `_2`). */
const SEAL_FALLBACK = 'seal_A_scuba', LOD_COPY = /_\d+$/;
export const IDLE_CLIPS: Readonly<Record<Stance, string>> = { stand: SEAL_ANIMS.stand, crouch: SEAL_ANIMS.crouch, prone: SEAL_ANIMS.prone };

/**
 * Reads the SEAL skeleton out of a map archive's bytes, with `READERC.ZAR` and `MOTION_P.ZAR` (either may be null).
 * Null, with a note, when the character library or its skeleton will not read: the server falls back to the placeholder.
 */
export function simSkeletonFromBytes(bytes: Uint8Array, readerc: Uint8Array | null, motionPack: Uint8Array | null,
  note: (line: string) => void = () => {}): SimSkeleton | null {
  const notes: string[] = [];
  const keep = (line: string): void => { notes.push(line); note(line); };
  let toc: ZdbEntry[], geo: Zar;
  try {
    toc = parseZdb(bytes);
    geo = Zar.parse(zdbMember(bytes, toc, 'CLIB_GEO.ZED'));
  } catch (e) {
    note(`skeleton: ${say(e)}`);
    return null;
  }
  let character: string | null = null, model: string | null = null;
  try {
    if (readerc) {
      const rc = Zar.parse(readerc);
      const key = rc.root.children.find((k) => k.name.toLowerCase() === 'character.rdr');
      const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
      const ct = readerm.root.children.find((k) => k.name.toLowerCase() === 'chartype.rdr');
      if (key && ct) {
        character = teamCharacter(parseRdr(readerm.data(ct)), 'navyseals', 0);
        model = character ? parseCharacterTable(parseRdr(rc.data(key))).model(character) ?? null : null;
      }
    }
  } catch (e) {
    keep(`character table: ${say(e)}`);
  }
  if (!model) {
    const names = characterModelNames(geo);
    const seals = names.filter((n) => /^seal_/i.test(n) && !LOD_COPY.test(n));
    model = names.includes(SEAL_FALLBACK) ? SEAL_FALLBACK : seals.find((n) => /^seal_A/i.test(n)) ?? seals[0] ?? null;
  }
  if (!model) { note('skeleton: the character library holds no SEAL'); return null; }
  let skeleton: Skeleton;
  try {
    skeleton = readSkeleton(geo, model);
  } catch (e) {
    note(`skeleton ${model}: ${say(e)}`);
    return null;
  }
  const idles: Record<Stance, MotionClip | null> = { stand: null, crouch: null, prone: null };
  if (motionPack) {
    try {
      const clips = clipsFromPack(motionPack, Object.values(IDLE_CLIPS));
      for (const k of Object.keys(IDLE_CLIPS) as Stance[]) idles[k] = clips.find((c) => c.name === IDLE_CLIPS[k]) ?? null;
    } catch (e) {
      keep(`idle clips: ${say(e)}`);
    }
  }
  for (const k of Object.keys(idles) as Stance[]) if (!idles[k]) keep(`no ${IDLE_CLIPS[k]}: ${k} stands in the bind pose`);
  return { model, character, skeleton, idles, notes };
}

/** `simSkeletonFromBytes` off a source: the map, `READERC.ZAR` beside it and `MOTION_P.ZAR` (each optional but the map). */
export async function loadSimSkeleton(source: AssetSource, mapPath: string): Promise<SimSkeleton | null> {
  const optional = async (path: string): Promise<Uint8Array | null> => {
    try { return await source.read(path); } catch { return null; }
  };
  const [bytes, readerc, pack] = await Promise.all([
    source.read(mapPath), optional(mapPath.replace(/[^/]*$/, 'READERC.ZAR')), optional(MOTION_PACK_PATH),
  ]);
  return simSkeletonFromBytes(bytes, readerc, pack);
}
