import { parseRdr, rdrGet, readZarMembers, readZdbMember, Zar, type AssetSource, type RdrNode } from '@s2u/archive';
import { flattenScene, parseAnimSets, parseSceneGraph, parseWorldRoot, spawnsFor, UNITS_PER_METRE, worldCollision, type SceneNode } from '@s2u/scene';
import {
  ambienceLayers, callbackPlays, findReverbPresets, fixSoundName, globalRegister2, parseBankFile, parseSoils, parseSoundScript,
  renderLoopAtLeastOneVoice, reverbImpulse, SampleCache, SOUND_FALLBACKS, type AmbienceLayers, type ReverbImpulse, type SoundBank,
  SOCOM_REVERB_MODE, soundHash, soundParams, weaponGlobals, weaponSounds, zanimEmitters, zanimSounds, type Material, type RenderedSound,
  type SoundParams, type SoundSet, type WeaponSounds, type ZAnimPayload,
} from '@s2u/sound';

/**
 * The walk's sound, read off the disc in the worker (web/docs/research/81; ruling W2.R6: at run time, never written
 * into the source) for one map:
 *
 * - **the banks**: the map's `<map>_am.bnk` (the steps, the landings, the jump, the world's impacts), `_fx.bnk` (the
 *   weapons) and `_vc.bnk` (the voices), and `HUDUI.bnk` (the interface's, the night vision's goggles among them), which
 *   the game loads with every map (`SOUND_GLOBAL_BANKS`), out of `RUN/SOUNDS/BNKSTORE.ZAR` by range -- about 1.9 MB of
 *   its 67 for Frostfire (research 81 s1: 986,408 + 687,344 + 176,088 B and HUDUI's), plus the one or two banks lent
 *   for names the map's lack (`borrowMissing`) -- sent as their bytes; the page parses and decodes them (`./audio`);
 * - **the script**: `RUN/SOUNDRDR.ZAR/sounds.rdr`, each of those banks' sounds' `RANGE` and flags, by name;
 * - **the materials**: `READERC.ZAR/materials.rdr`, the step, stealth, crawl and landing sound of every surface;
 * - **the weapons**: `ZWEAPON.ZAR/zweapon.rdr`'s fire and reload sounds for `SOUND_WEAPONS`, and its `WEAPON_GLOBAL`
 *   distances that pick a remote round's close, medium or far sound (`fireDistances`);
 * - **the callbacks**: the map's own `CZANIM.ZAR` and `MZANIM.ZAR`, which zAnim a `zanim_callback` name plays which
 *   sounds, through the animations it starts;
 * - **the ambience** (research 81 §10): the layers the mission's camera-state scripts start on each side
 *   (`ambienceLayers`: the beds `~OUTDOOR_AMB` / `~INDOOR_AMB` of `outside_noise` / `inside_noise`, Frostfire's wind
 *   gusts), each at its command's volume, and its emitters -- the self-starting zAnims that loop a `~` sound at a scene
 *   node, placed at the node's world position out of the map's `_GEO.ZED`;
 * - **the reverb** (§9): libsd's preset for the game's mode out of `RUN/IRX/LIBSD.IRX`, and the mission's
 *   `IndoorReverb`/`OutdoorReverb` depths (`READERM.ZAR/mission.rdr`);
 * - **the map's `DefaultMaterial`** (its world root, `<map>.ZED`), what a polygon's material byte 0 is
 *   (`FUN_002dc1d0`), and the SEAL's hurt voice (`character.rdr`'s `mp_seal1` `CHRSND_DAMAGE`).
 *
 * Each part is optional: a source without `BNKSTORE.ZAR` (an index extracted before web/docs/research/81) answers
 * null and the walk is silent; a missing script, table or archive leaves that part empty and says so in `missing`.
 */

export const SOUND_BANKS_PATH = 'RUN/SOUNDS/BNKSTORE.ZAR';
export const SOUND_SCRIPT_PATH = 'RUN/SOUNDRDR.ZAR';
export const SOUND_MATERIALS_PATH = 'RUN/READERC.ZAR';
export const SOUND_WEAPONS_PATH = 'RUN/ZWEAPON.ZAR';
/** libsd, whose data holds the SPU2 reverb presets (web/docs/research/81 §9). */
export const SOUND_LIBSD_PATH = 'RUN/IRX/LIBSD.IRX';
/** The character whose `sounds` the SEAL's voice is read from: the first multiplayer SEAL kit (as `weapons.ts` takes its rifle). */
export const SOUND_CHARACTER = 'mp_seal1';
/** A map's three banks, in the order a name is looked up in them. */
export const SOUND_BANK_KINDS = ['am', 'fx', 'vc'] as const;
/**
 * The banks the game loads with every map, before the map's own: `FUN_00344450` (decomp 242785, called from the map's
 * load at 152105) loads `HUDUI`, `SMUS` and `TCM_ECHO`, then `<map>_vc`, `_fx`, `_am`, `_svo`, `_smu` (and `MULTI`,
 * `HOSTAGE` or a mission's cast). Of these only `HUDUI` is on the disc (`BNKSTORE.ZAR` holds HUDUI and the maps' three);
 * it holds the interface's 24 sounds -- `.NV_GOGGLES_ON` and `_OFF` (research 90 item 24), the countdowns, the menus'.
 * No name of it is in any map's bank, so where it sits in the lookup does not matter (the game's is one sorted table,
 * `FUN_00344bf0`); the viewer looks it up after the map's.
 */
export const SOUND_GLOBAL_BANKS: readonly string[] = ['HUDUI.bnk'];
/** The weapons whose sounds are read: the SEAL's rifle as held (W2.R4) and as the fire table reads it (W2.5). */
export const SOUND_WEAPONS: readonly string[] = ['M4A1 SD', 'M4A1', 'Mark 23'];

export interface SoundData {
  /** The map's archive id, `MP2`. */
  archive: string;
  /**
   * Each bank's member name and its bytes (their own buffers: transferred); a bank borrowed from another map
   * (`borrowMissing`) carries the names it was borrowed for in `only`.
   */
  banks: { file: string; bytes: Uint8Array; only?: string[] }[];
  materials: Material[];
  /** `sounds.rdr`'s entry for a bank sound, by the sound's name, for the sounds it lists. */
  params: [string, SoundParams][];
  weapons: WeaponSounds[];
  /** zAnim callback name to the sounds it plays. */
  callbacks: [string, string[]][];
  /** Each callback's sounds' command volumes, in the same order (1 unless the command's flag 0x10 gives its own). */
  callbackVolumes?: [string, number[]][];
  /**
   * `WEAPON_GLOBAL`'s `SoundDistanceClose/Med/Far` in units (metres x `UNITS_PER_METRE`): a remote round past `med`
   * plays its weapon's `FireSoundMed`, past `far` its `FireSoundFar` (`fireVariant`); null without `zweapon.rdr`.
   */
  fireDistances?: { close: number; med: number; far: number } | null;
  /** The SOILS index a material byte 0 stands for: the map's `DefaultMaterial` (0 when it names none). */
  defaultMaterial: number;
  /** The beds: the `loop` layers' sounds per side (`~OUTDOOR_AMB`, `~INDOOR_AMB`), empty where a map has none. */
  beds: { outside: string[]; inside: string[] };
  /**
   * The camera-state scripts' layers per side (`ambienceLayers`): the beds with their volumes, and the one-shots a
   * script replays (Frostfire's wind gusts). Absent in data made before them: the beds alone, at 1.0.
   */
  layers?: AmbienceLayers;
  /** The emitters: a looping sound at a world position, at its command's volume (absent: 1.0). */
  emitters: { anim: string; sound: string; node: string; position: [number, number, number]; volume?: number }[];
  /**
   * The reverb: the preset's 32 registers (null without `LIBSD.IRX`), the depth zones (depth 0..1, ramp seconds), and
   * the preset's response, computed in the worker (`renderReverb`) so the page's unlock does no arithmetic.
   */
  reverb: { preset: number[] | null; indoor: [number, number][]; outdoor: [number, number][]; ir?: ReverbImpulse | null };
  /** The SEAL's `CHRSND_DAMAGE`, or null. */
  damageVoice: string | null;
  /** True when the worker renders the loops after (`renderAmbienceLoops`, a second message): the page waits for them. */
  loopsFollow?: boolean;
  /** `mission.rdr`'s `elevation` (max, min): global register 2's band (`globalRegister2`); null when absent. */
  elevation?: [number, number] | null;
  /** The camera's height at spawn A (`BED_CAMERA_ABOVE_FEET_PLACEHOLDER` over its floor): what the beds are rendered at. */
  standHeight?: number | null;
  /** The parts that could not be read, and why. */
  missing: string[];
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Where an emitter sounds: the play-sound command's place (`FUN_002659c0`, decomp 112317) starts at 0, adds the
 * command's offset with flag 4 (`FUN_00309240`) and is carried through the node's matrices up to the world
 * (`FUN_00310980`) only when the node resolves. Vigilance's `water_drain` (a copy of Crossroads', whose node is
 * `waterpipe`) names a node `pipe` that no model of the map has, so the game sounds it at its bare offset (0, -60, 30).
 * `world` is the node's world matrix, column-major (`flattenScene`); null when the scene has no such node. Null back:
 * no node and no offset -- the game plays that without a place, which the emitters do not model.
 */
export function emitterPosition(world: ArrayLike<number> | null, offset: readonly number[] | undefined): [number, number, number] | null {
  const [x, y, z] = offset ?? [0, 0, 0];
  if (!world) return offset ? [x!, y!, z!] : null;
  const w = world;
  return [
    w[0]! * x! + w[4]! * y! + w[8]! * z! + w[12]!,
    w[1]! * x! + w[5]! * y! + w[9]! * z! + w[13]!,
    w[2]! * x! + w[6]! * y! + w[10]! * z! + w[14]!,
  ];
}

/**
 * The SOILS index a map's `DefaultMaterial` names, matched without case (MP64 writes `stone`); 0 -- the engine's
 * `UNKNOWN`, no sounds -- for a name no entry spells, as `FUN_002de9e0` answers (MP11's `none`).
 */
export function defaultMaterialIndex(materials: readonly Material[], name: string): number {
  const i = materials.findIndex((m) => m.name.toUpperCase() === name.toUpperCase());
  return i > 0 ? i : 0;
}

/** Data with no banks: the walk is silent, and `missing` says why (the page warns once). */
function silent(archive: string, missing: string[]): SoundData {
  return {
    archive, banks: [], materials: [], params: [], weapons: [], callbacks: [], defaultMaterial: 0,
    beds: { outside: [], inside: [] }, emitters: [], reverb: { preset: null, indoor: [], outdoor: [] }, damageVoice: null, missing,
    fireDistances: null,
  };
}

/**
 * Reads a map's sound data off `source`. A source without `SOUNDS/BNKSTORE.ZAR` (a tree extracted before research
 * 81) gives data with no banks and the archive named in `missing`.
 */
export async function soundFromDisc(source: AssetSource, mapPath: string, archive: string): Promise<SoundData> {
  const files = [...SOUND_BANK_KINDS.map((k) => `${archive}_${k}.bnk`), ...SOUND_GLOBAL_BANKS];
  let found: Map<string, Uint8Array>;
  try {
    found = await readZarMembers(source, SOUND_BANKS_PATH, files);
  } catch (e) {
    return silent(archive, [`${SOUND_BANKS_PATH}: ${why(e)}`]);
  }
  // A member of a whole-archive read is a view of the 67 MB buffer: copied, so only its own bytes cross.
  const banks: SoundData['banks'] = files.filter((f) => found.has(f)).map((file) => ({ file, bytes: found.get(file)!.slice() }));
  if (!banks.some((b) => !SOUND_GLOBAL_BANKS.includes(b.file))) return silent(archive, [`${SOUND_BANKS_PATH}: no bank of ${archive}`]);
  const missing: string[] = files.filter((f) => !found.has(f)).map((f) => `${f}: not in ${SOUND_BANKS_PATH}`);
  const one = async (path: string, member: string): Promise<Uint8Array | null> => {
    try {
      const got = (await readZarMembers(source, path, [member])).get(member);
      if (!got) missing.push(`${path}: no ${member}`);
      return got ?? null;
    } catch (e) {
      missing.push(`${path}: ${why(e)}`);
      return null;
    }
  };

  const params: [string, SoundParams][] = [];
  let sets: Map<string, SoundSet> | null = null;
  const script = await one(SOUND_SCRIPT_PATH, 'sounds.rdr');
  if (script) {
    try { sets = parseSoundScript(parseRdr(script)); } catch (e) { missing.push(`sounds.rdr: ${why(e)}`); }
  }

  let materials: Material[] = [];
  const mats = await one(SOUND_MATERIALS_PATH, 'materials.rdr');
  if (mats) { try { materials = parseSoils(parseRdr(mats)); } catch (e) { missing.push(`materials.rdr: ${why(e)}`); } }

  const weapons: WeaponSounds[] = [];
  let fireDistances: SoundData['fireDistances'] = null;
  const zweapon = await one(SOUND_WEAPONS_PATH, 'zweapon.rdr');
  if (zweapon) {
    try {
      const table = parseRdr(zweapon);
      for (const name of SOUND_WEAPONS) { const w = weaponSounds(table, name); if (w) weapons.push(w); }
      // `FUN_003cd810`: metres x `DAT_003dfe10` (1 / MetersPerUnit, 10 on every map: `UNITS_PER_METRE`).
      const g = weaponGlobals(table);
      fireDistances = { close: g.soundDistanceClose * UNITS_PER_METRE, med: g.soundDistanceMed * UNITS_PER_METRE, far: g.soundDistanceFar * UNITS_PER_METRE };
    } catch (e) { missing.push(`zweapon.rdr: ${why(e)}`); }
  }

  // The map's scene graph: the emitters' nodes, and the materials its floors are made of.
  let models: SceneNode[] | null = null;
  try { models = parseSceneGraph(Zar.parse(await readZdbMember(source, mapPath, `${archive}_GEO.ZED`))); }
  catch (e) { missing.push(`${archive}_GEO.ZED: ${why(e)}`); }

  // The zAnims: the common set and the mission's, a command's bytes out of its animation's Seq_Data.
  let callbacks: [string, string[]][] = [];
  let callbackVolumes: [string, number[]][] = [];
  const beds = { outside: [] as string[], inside: [] as string[] };
  let layers: AmbienceLayers = { outside: [], inside: [] };
  let emitters: SoundData['emitters'] = [];
  const casingSounds = new Set<string>();
  try {
    const zars = [Zar.parse(await readZdbMember(source, mapPath, 'CZANIM.ZAR'))];
    try { zars.push(Zar.parse(await readZdbMember(source, mapPath, 'MZANIM.ZAR'))); } catch (e) { missing.push(`${mapPath} MZANIM.ZAR: ${why(e)}`); }
    const archives = zars.map((z) => parseAnimSets(z));
    const payload: ZAnimPayload = (set, anim, offset, length) => {
      for (const z of zars) {
        const key = z.find(`Anim_Sets/${set}/Animation_List/${anim}/Seq_Data`);
        if (key && offset + length <= key.size) return z.data(key).subarray(offset, offset + length);
      }
      return null;
    };
    const plays = [...callbackPlays(archives, payload)];
    callbacks = plays.map(([name, p]) => [name, p.map((x) => x.sound)]);
    callbackVolumes = plays.map(([name, p]) => [name, p.map((x) => x.volume)]);
    const infos = zanimSounds(archives, payload);
    // The casings' sounds are named in the shell_eject zAnims' name tables, played from inside their particle command.
    for (const a of archives) for (const set of a.sets) for (const anim of set.anims) {
      if (/^shell_eject/.test(anim.name)) for (const n of anim.names) if (/^[.~!][A-Z0-9_]/.test(n)) casingSounds.add(n);
    }
    // The camera-state scripts' start/stop walk (research 81 §10): the beds and the replayed one-shots of each side.
    layers = ambienceLayers(archives, payload);
    for (const side of ['outside', 'inside'] as const) {
      for (const l of layers[side]) if (l.kind === 'loop' && !beds[side].includes(l.sound)) beds[side].push(l.sound);
    }
    const wanted = zanimEmitters(infos);
    if (wanted.length > 0 && models) {
      const at = new Map<string, number[]>();
      for (const inst of flattenScene(models)) {
        if (!at.has(inst.node.name)) at.set(inst.node.name, Array.from(inst.world));
      }
      emitters = wanted.flatMap((e) => {
        const position = emitterPosition(at.get(e.node) ?? null, e.offset);
        if (!position) { missing.push(`emitter ${e.anim}: no node ${e.node}`); return []; }
        return [{ anim: e.anim, sound: e.sound, node: e.node, position, ...(e.volume !== undefined ? { volume: e.volume } : {}) }];
      });
    }
  } catch (e) { missing.push(`${mapPath} zAnims: ${why(e)}`); }

  // The map's DefaultMaterial, a SOILS name on its world root.
  let defaultMaterial = 0;
  try {
    const name = parseWorldRoot(Zar.parse(await readZdbMember(source, mapPath, `${archive}.ZED`))).defaultMaterial;
    // A name no SOILS entry spells is the game's 0, UNKNOWN, which has no sounds: `FUN_002de9e0` (decomp, the map's
    // load at 152109) answers 0 for a name its table lacks, and `FUN_002ddc30` sets that as the default. Death Trap
    // (MP11) writes `none`, so its byte-0 floors are silent on the console too (research 90 item 26): no error.
    defaultMaterial = defaultMaterialIndex(materials, name);
  } catch (e) { missing.push(`${archive}.ZED: ${why(e)}`); }

  // The reverb: libsd's preset, and the mission's zones.
  const reverb: SoundData['reverb'] = { preset: null, indoor: [], outdoor: [] };
  let elevation: [number, number] | null = null, standHeight: number | null = null;
  try {
    const presets = findReverbPresets(await source.read(SOUND_LIBSD_PATH));
    if (presets) reverb.preset = Array.from(presets[SOCOM_REVERB_MODE - 1]!);
    else missing.push(`${SOUND_LIBSD_PATH}: no reverb preset table`);
  } catch (e) { missing.push(`${SOUND_LIBSD_PATH}: ${why(e)}`); }
  try {
    const readerm = Zar.parse(await readZdbMember(source, mapPath, 'READERM.ZAR'));
    const key = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr');
    if (key) {
      const mission = parseRdr(readerm.data(key));
      reverb.indoor = reverbZones(rdrGet(mission, 'IndoorReverb'));
      reverb.outdoor = reverbZones(rdrGet(mission, 'OutdoorReverb'));
      // `elevation (max (100) min (142))`: the band global register 2 maps the camera's height through.
      const elev = rdrGet(mission, 'elevation');
      const num = (k: string): number => { const v = elev === undefined ? undefined : rdrGet(elev, k); return typeof v === 'string' ? Number(v) : NaN; };
      if (Number.isFinite(num('max')) && Number.isFinite(num('min'))) elevation = [num('max'), num('min')];
      const description = rdrGet(mission, 'description');
      const spawn = typeof description === 'string' ? spawnsFor(description) : undefined;
      if (spawn) standHeight = spawn.a[1] + BED_CAMERA_ABOVE_FEET_PLACEHOLDER;
    }
  } catch (e) { missing.push(`${mapPath} mission.rdr: ${why(e)}`); }

  let damageVoice: string | null = null;
  const character = await one(SOUND_MATERIALS_PATH, 'character.rdr');
  if (character) {
    try { damageVoice = characterSound(parseRdr(character), SOUND_CHARACTER, 'CHRSND_DAMAGE'); } catch (e) { missing.push(`character.rdr: ${why(e)}`); }
  }

  // Borrowed sounds (PLACEHOLDER, see `borrowMissing`), then each bank's sounds' script entries.
  if (sets) {
    // The surfaces of the map: its floors (the steps, crawls, landings) and every polygon (a grenade's bounce).
    const floors = new Set<number>(), surfaces = new Set<string>();
    if (models) {
      for (const p of worldCollision(models)) {
        const m = p.material === 0 ? defaultMaterial : p.material;
        if (p.ditype & 1) floors.add(m);
        if (materials[m]) surfaces.add(materials[m]!.name.toLowerCase());
      }
    }
    const wanted = new Set<string>();
    for (const m of floors) for (const n of [materials[m]?.step, materials[m]?.stealthStep, materials[m]?.crawl, materials[m]?.land]) if (n) wanted.add(n);
    for (const [cb, sounds] of callbacks) {
      // A grenade's bounce and a round's impact on the map's own surfaces, the explosions, the casings' bounces.
      const hit = /^(?:grenade|bullet)_hit_(.+)$/.exec(cb);
      if ((hit && surfaces.has(hit[1]!)) || /^(frag_grenade|he_grenade)/.test(cb)) {
        for (const n of sounds) wanted.add(fixSoundName(n));
      }
    }
    for (const n of casingSounds) wanted.add(fixSoundName(n));   // `.BUL_CASE_METAL` lent as the banks spell it
    for (const l of [...layers.outside, ...layers.inside]) if (l.kind !== 'loop') wanted.add(l.sound);   // the gusts
    if (damageVoice) wanted.add(damageVoice);
    try { await borrowMissing(source, banks, sets, wanted, archive, missing); } catch (e) { missing.push(`borrowing: ${why(e)}`); }
    // Bank by bank: one that will not parse is named in `missing`, and the others' entries still come.
    for (const { file, bytes } of banks) {
      let bank: SoundBank;
      try { bank = parseBankFile(bytes); } catch (e) { missing.push(`${file}: ${why(e)}`); continue; }
      for (const name of bank.names.keys()) {
        const p = soundParams(sets, [bank.name], name);
        if (p) params.push([name, p]);
      }
    }
  }

  return {
    archive, banks, materials, params, weapons, callbacks, callbackVolumes, fireDistances, defaultMaterial, beds, layers, emitters,
    reverb, damageVoice, missing, elevation, standHeight,
  };
}

/**
 * PLACEHOLDER (not the game's behaviour): a sound the map's floors, grenades or SEAL ask for by name that none of the
 * map's own banks holds -- Rat's Nest's `DefaultMaterial` is `DIRT` and `MP8_am` has no `.STEP_DIRT` (85% of its
 * floors); Frostfire's metal has no `.GREN_METAL` -- is borrowed, by the same name, from another map's bank that holds
 * it: the same recording out of the game's own library. The console looks names up in the loaded banks only
 * (`FUN_00344f30`), so there such a sound is presumably silent -- not established by a capture (research/81 §7).
 * The bank is found through `sounds.rdr`'s sets (a set is a bank's block, `MP9_AM` is `MP9_am.bnk`), greedily, the bank
 * that covers the most still-missing names first; its other sounds are not registered (`SoundData.banks[].only`).
 */
export async function borrowMissing(
  source: AssetSource, banks: SoundData['banks'], sets: ReadonlyMap<string, SoundSet>, wanted: ReadonlySet<string>,
  archive: string, missing: string[],
): Promise<void> {
  const have = new Set<string>();
  for (const b of banks) {
    let names: Iterable<string>;
    try { names = parseBankFile(b.bytes).names.keys(); } catch { continue; }   // named in `missing` by the params loop
    for (const n of names) { have.add(n); have.add(n.trim()); }
  }
  let need = [...wanted].filter((n) => !have.has(n) && !have.has(n.trim()));
  if (need.length === 0) return;
  const own = new Set(banks.map((b) => b.file.toUpperCase()));
  const bankOf = (set: string): string | null => {
    const m = /^(M[P]?\d+|T\d+)_(AM|FX|VC)$/.exec(set);
    return m ? `${m[1]}_${m[2]!.toLowerCase()}.bnk` : null;
  };
  const tried = new Set<string>();
  for (let guard = 0; guard < 6 && need.length > 0; guard++) {
    const cover = new Map<string, string[]>();
    for (const [name, set] of sets) {
      const file = bankOf(name);
      if (!file || own.has(file.toUpperCase()) || tried.has(file)) continue;
      const got = need.filter((n) => set.has(soundHash(n)) || set.has(soundHash(n.trim())));
      if (got.length > 0) cover.set(file, got);
    }
    const best = [...cover].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (!best) break;
    tried.add(best[0]);
    const bytes = (await readZarMembers(source, SOUND_BANKS_PATH, [best[0]])).get(best[0]);
    if (!bytes) continue;
    const names = parseBankFile(bytes).names;
    const only = need.filter((n) => names.has(n) || names.has(`${n} `));
    if (only.length === 0) continue;
    banks.push({ file: best[0], bytes: bytes.slice(), only });
    need = need.filter((n) => !only.includes(n));
  }
  // A name with a stand-in the banks now hold is not missing: the play takes the stand-in (`soundFor`).
  const held = new Set([...have, ...banks.flatMap((b) => b.only ?? [])]);
  for (const n of need) if (!SOUND_FALLBACKS[n]?.some((f) => held.has(f))) missing.push(`${archive}: no bank holds ${n}`);
}

/**
 * `FUN_00341500`/`FUN_003416b0`'s lists: each entry's `Depth` (0..1, times 32767 for the SPU) and `Seconds` (the ramp).
 * A mission may carry the key twice (Frostfire: `IndoorReverb` 0.45 after `UiVehicles`, 0.3 before `OutdoorReverb`);
 * the reader's find (`FUN_0032f0d0`) takes the first, as `rdrGet` does [reading: its scan order was not traced].
 */
export function reverbZones(list: RdrNode | undefined): [number, number][] {
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is RdrNode[] => Array.isArray(e)).map((e) => {
    const n = (k: string): number => { const v = rdrGet(e, k); return typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : 0; };
    return [n('Depth'), n('Seconds')];
  });
}

/**
 * A character's sound for a slot, out of `character.rdr`: the entry named for the character (`mp_seal1 : mp_seal`,
 * three tokens and the record), its `sounds` list, the slot's name (`CHRSND_DAMAGE (.SEAL_DAMAGE)`).
 */
export function characterSound(root: RdrNode, character: string, slot: string): string | null {
  const find = (node: RdrNode, depth: number): string | null => {
    if (!Array.isArray(node) || depth > 12) return null;
    for (let i = 0; i + 1 < node.length; i++) {
      if (node[i] !== character) continue;
      // `mp_seal1 : mp_seal ( ... )`: the record is the first list after the name (past the inheritance).
      const record = node.slice(i + 1, i + 4).find((x) => Array.isArray(x));
      const sounds = record === undefined ? undefined : rdrGet(record, 'sounds');
      const v = sounds === undefined ? undefined : rdrGet(sounds, slot);
      if (typeof v === 'string') return v;
    }
    for (const child of node) { const got = find(child, depth + 1); if (got) return got; }
    return null;
  };
  return find(root, 0);
}

/** The banks' buffers, for the worker's transfer list. */
export function soundTransferables(data: SoundData): Transferable[] {
  return data.banks.map((b) => b.bytes.buffer as ArrayBuffer);
}

/**
 * The name a loop is rendered and played under: the sound's name at the game's 1.0, else the name and the command's
 * volume -- Desert Glory loops `~OUTDOOR_AMB` at 1.0 outdoors and at 0.6 indoors (its mission `inside_noise`), two
 * renders, since 989snd applies a play's volume inside the voice (`(app x orig) >> 10`, clamped at 127) and not as a
 * gain after it.
 */
export function loopKey(name: string, volume = 1): string {
  return volume === 1 ? name : `${name}@${volume}`;
}

/** The loops the ambience plays: each bed layer's and each emitter's sound at its volume, once each. */
export function ambienceLoops(data: SoundData): { key: string; name: string; volume: number }[] {
  const out: { key: string; name: string; volume: number }[] = [];
  const add = (name: string, volume: number): void => {
    const key = loopKey(name, volume);
    if (!out.some((l) => l.key === key)) out.push({ key, name, volume });
  };
  if (data.layers) { for (const l of [...data.layers.outside, ...data.layers.inside]) if (l.kind === 'loop') add(l.sound, l.volume); }
  else for (const n of [...data.beds.outside, ...data.beds.inside]) add(n, 1);
  for (const e of data.emitters) add(e.sound, e.volume ?? 1);
  return out;
}

/**
 * The map's beds and emitters rendered as loops (`renderLoop`), one per sound and volume (`loopKey`), in the worker:
 * `seconds` long with a `fade` folded in, at the play volume 0x400 x the command's volume (`FUN_002659c0`). A sound the
 * banks lack is left out; so is one whose grains start no voice (the crickets' conductors wait on a global register the
 * game sets and the viewer does not); so is a bank that will not parse (`soundFromDisc` names it in `missing`).
 */
export function renderAmbienceLoops(data: SoundData, seconds: number, fade: number, longSeconds = seconds): { name: string; sound: RenderedSound }[] {
  const banks: SoundBank[] = [];
  for (const { bytes } of data.banks) { try { banks.push(parseBankFile(bytes)); } catch { /* named in `missing` */ } }
  const caches = banks.map((b) => new SampleCache(b.vag));
  const out: { name: string; sound: RenderedSound }[] = [];
  const state = new Map<string, number>();
  // Global register 2 at the stand's height (the beds that test it take their layers from it once, not per frame).
  const globals = data.elevation && data.standHeight !== null && data.standHeight !== undefined
    ? [0, globalRegister2(data.standHeight, data.elevation)] : [];
  for (const { key, name, volume } of ambienceLoops(data)) {
    const at = banks.findIndex((b) => b.names.has(name) || b.names.has(`${name} `));
    if (at < 0) continue;
    const bank = banks[at]!;
    const sound = renderLoopAtLeastOneVoice(bank, bank.names.get(name) ?? bank.names.get(`${name} `)!, caches[at]!, seconds, fade,
      longSeconds, { state, globals, vol: Math.round(0x400 * volume) });
    if (sound.voices > 0) out.push({ name: key, sound });
  }
  return out;
}

/** The reverb's response for the data's preset, in the worker (`reverbImpulse`: tens of milliseconds). */
export function renderReverb(data: SoundData): void {
  data.reverb.ir = data.reverb.preset ? reverbImpulse(Uint16Array.from(data.reverb.preset)) : null;
}

/** The response's buffers, for the transfer list. */
export function reverbTransferables(data: SoundData): Transferable[] {
  const ir = data.reverb.ir;
  return ir ? [ir.ll, ir.lr, ir.rl, ir.rr].map((x) => x.buffer as ArrayBuffer) : [];
}

/**
 * PLACEHOLDER (not the game's): how far over spawn A's floor the camera is taken to be when the beds are rendered with
 * global register 2 -- the standing third-person camera's height over the feet (about 25.7, `playerCamera.ts`).
 */
export const BED_CAMERA_ABOVE_FEET_PLACEHOLDER = 25;

/** The loops' buffers, for the transfer list. */
export function loopTransferables(loops: readonly { sound: RenderedSound }[]): Transferable[] {
  return loops.flatMap(({ sound: s }) => [s.left, s.right, s.sendLeft, s.sendRight]
    .filter((x): x is Float32Array => x !== null).map((x) => x.buffer as ArrayBuffer));
}
