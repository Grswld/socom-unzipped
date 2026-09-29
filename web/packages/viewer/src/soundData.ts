import { parseRdr, rdrGet, readZarMembers, readZdbMember, Zar, type AssetSource, type RdrNode } from '@s2u/archive';
import { flattenScene, parseAnimSets, parseSceneGraph, parseWorldRoot, worldCollision, type SceneNode } from '@s2u/scene';
import { SOUND_FALLBACKS, SOUND_NAME_FIXES } from './soundNames';
import {
  callbackSounds, findReverbPresets, parseBankFile, parseSoils, parseSoundScript, renderLoop, SampleCache,
  SOCOM_REVERB_MODE, soundHash, soundParams, weaponSounds, zanimEmitters, zanimSounds, type Material, type RenderedSound,
  type SoundParams, type SoundSet, type WeaponSounds, type ZAnimPayload,
} from '@s2u/sound';

/**
 * The walk's sound, read off the disc in the worker (web/docs/research/81; ruling W2.R6: at run time, never written
 * into the source) for one map:
 *
 * - **the banks**: the map's `<map>_am.bnk` (the steps, the landings, the jump, the world's impacts), `_fx.bnk` (the
 *   weapons) and `_vc.bnk` (the voices), out of `RUN/SOUNDS/BNKSTORE.ZAR` by range -- 1.1 to 1.4 MB of its 67 --
 *   sent as their bytes; the page parses and decodes them (`./audio`);
 * - **the script**: `RUN/SOUNDRDR.ZAR/sounds.rdr`, each of those banks' sounds' `RANGE` and flags, by name;
 * - **the materials**: `READERC.ZAR/materials.rdr`, the step, stealth, crawl and landing sound of every surface;
 * - **the weapons**: `ZWEAPON.ZAR/zweapon.rdr`'s fire and reload sounds for `SOUND_WEAPONS`;
 * - **the callbacks**: the map's own `CZANIM.ZAR` and `MZANIM.ZAR`, which zAnim a `zanim_callback` name plays which
 *   sounds, through the animations it starts;
 * - **the ambience** (research 81 §10): the mission's beds (`outside_noise`/`inside_noise`: `~OUTDOOR_AMB`,
 *   `~INDOOR_AMB`) and its emitters -- the self-starting zAnims that loop a `~` sound at a scene node, placed at the
 *   node's world position out of the map's `_GEO.ZED`;
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
/** The weapons whose sounds are read: the SEAL's rifle as held (W2.R4) and as the fire table reads it (W2.5). */
export const SOUND_WEAPONS: readonly string[] = ['M4A1 SD', 'M4A1'];

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
  /** The SOILS index a material byte 0 stands for: the map's `DefaultMaterial` (0 when it names none). */
  defaultMaterial: number;
  /** The beds: what `outside_noise` and `inside_noise` loop (`~OUTDOOR_AMB`, `~INDOOR_AMB`), empty where a map has none. */
  beds: { outside: string[]; inside: string[] };
  /** The emitters: a looping sound at a world position. */
  emitters: { anim: string; sound: string; node: string; position: [number, number, number] }[];
  /** The reverb: the preset's 32 registers (null without `LIBSD.IRX`) and the depth zones (depth 0..1, ramp seconds). */
  reverb: { preset: number[] | null; indoor: [number, number][]; outdoor: [number, number][] };
  /** The SEAL's `CHRSND_DAMAGE`, or null. */
  damageVoice: string | null;
  /** True when the worker renders the loops after (`renderAmbienceLoops`, a second message): the page waits for them. */
  loopsFollow?: boolean;
  /** The parts that could not be read, and why. */
  missing: string[];
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Data with no banks: the walk is silent, and `missing` says why (the page warns once). */
function silent(archive: string, missing: string[]): SoundData {
  return {
    archive, banks: [], materials: [], params: [], weapons: [], callbacks: [], defaultMaterial: 0,
    beds: { outside: [], inside: [] }, emitters: [], reverb: { preset: null, indoor: [], outdoor: [] }, damageVoice: null, missing,
  };
}

/**
 * Reads a map's sound data off `source`. A source without `SOUNDS/BNKSTORE.ZAR` (a tree extracted before research
 * 81) gives data with no banks and the archive named in `missing`.
 */
export async function soundFromDisc(source: AssetSource, mapPath: string, archive: string): Promise<SoundData> {
  const files = SOUND_BANK_KINDS.map((k) => `${archive}_${k}.bnk`);
  let found: Map<string, Uint8Array>;
  try {
    found = await readZarMembers(source, SOUND_BANKS_PATH, files);
  } catch (e) {
    return silent(archive, [`${SOUND_BANKS_PATH}: ${why(e)}`]);
  }
  // A member of a whole-archive read is a view of the 67 MB buffer: copied, so only its own bytes cross.
  const banks: SoundData['banks'] = files.filter((f) => found.has(f)).map((file) => ({ file, bytes: found.get(file)!.slice() }));
  if (banks.length === 0) return silent(archive, [`${SOUND_BANKS_PATH}: no bank of ${archive}`]);
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
  const zweapon = await one(SOUND_WEAPONS_PATH, 'zweapon.rdr');
  if (zweapon) {
    try {
      const table = parseRdr(zweapon);
      for (const name of SOUND_WEAPONS) { const w = weaponSounds(table, name); if (w) weapons.push(w); }
    } catch (e) { missing.push(`zweapon.rdr: ${why(e)}`); }
  }

  // The map's scene graph: the emitters' nodes, and the materials its floors are made of.
  let models: SceneNode[] | null = null;
  try { models = parseSceneGraph(Zar.parse(await readZdbMember(source, mapPath, `${archive}_GEO.ZED`))); }
  catch (e) { missing.push(`${archive}_GEO.ZED: ${why(e)}`); }

  // The zAnims: the common set and the mission's, a command's bytes out of its animation's Seq_Data.
  let callbacks: [string, string[]][] = [];
  const beds = { outside: [] as string[], inside: [] as string[] };
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
    callbacks = [...callbackSounds(archives, payload)];
    const infos = zanimSounds(archives, payload);
    // The casings' sounds are named in the shell_eject zAnims' name tables, played from inside their particle command.
    for (const a of archives) for (const set of a.sets) for (const anim of set.anims) {
      if (/^shell_eject/.test(anim.name)) for (const n of anim.names) if (/^[.~!][A-Z0-9_]/.test(n)) casingSounds.add(n);
    }
    for (const [bed, anim] of [['outside', 'outside_noise'], ['inside', 'inside_noise']] as const) {
      for (const snd of infos.get(anim)?.sounds ?? []) if (!beds[bed].includes(snd.sound)) beds[bed].push(snd.sound);
    }
    const wanted = zanimEmitters(infos);
    if (wanted.length > 0 && models) {
      const at = new Map<string, [number, number, number]>();
      for (const inst of flattenScene(models)) {
        if (!at.has(inst.node.name)) at.set(inst.node.name, [inst.world[12]!, inst.world[13]!, inst.world[14]!]);
      }
      emitters = wanted.flatMap((e) => {
        const position = at.get(e.node);
        if (!position) { missing.push(`emitter ${e.anim}: no node ${e.node}`); return []; }
        return [{ anim: e.anim, sound: e.sound, node: e.node, position }];
      });
    }
  } catch (e) { missing.push(`${mapPath} zAnims: ${why(e)}`); }

  // The map's DefaultMaterial, a SOILS name on its world root.
  let defaultMaterial = 0;
  try {
    const name = parseWorldRoot(Zar.parse(await readZdbMember(source, mapPath, `${archive}.ZED`))).defaultMaterial;
    const i = materials.findIndex((m) => m.name.toUpperCase() === name.toUpperCase());   // MP64 writes `stone`
    if (i > 0) defaultMaterial = i;
    else missing.push(`${archive}.ZED: DefaultMaterial ${JSON.stringify(name)} is no SOILS entry`);
  } catch (e) { missing.push(`${archive}.ZED: ${why(e)}`); }

  // The reverb: libsd's preset, and the mission's zones.
  const reverb: SoundData['reverb'] = { preset: null, indoor: [], outdoor: [] };
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
        for (const n of sounds) wanted.add(n);
      }
    }
    // Through the effects' name table: the data's `.BUL_CASE_METAL` is the banks' `.BUL_CAS_METAL` (`./soundNames`).
    for (const n of casingSounds) wanted.add(SOUND_NAME_FIXES[n] ?? n);
    if (damageVoice) wanted.add(damageVoice);
    try { await borrowMissing(source, banks, sets, wanted, archive, missing); } catch (e) { missing.push(`borrowing: ${why(e)}`); }
    for (const { bytes } of banks) {
      const bank = parseBankFile(bytes);
      for (const name of bank.names.keys()) {
        const p = soundParams(sets, [bank.name], name);
        if (p) params.push([name, p]);
      }
    }
  }

  return { archive, banks, materials, params, weapons, callbacks, defaultMaterial, beds, emitters, reverb, damageVoice, missing };
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
  for (const b of banks) for (const n of parseBankFile(b.bytes).names.keys()) { have.add(n); have.add(n.trim()); }
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
 * The map's beds and emitters rendered as loops (`renderLoop`), one per sound, in the worker: `seconds` long with a
 * `fade` folded in. A sound the banks lack is left out; so is one whose grains start no voice (the crickets' conductors
 * wait on a global register the game sets and the viewer does not).
 */
export function renderAmbienceLoops(data: SoundData, seconds: number, fade: number): { name: string; sound: RenderedSound }[] {
  const banks = data.banks.map(({ bytes }) => parseBankFile(bytes));
  const caches = banks.map((b) => new SampleCache(b.vag));
  const names = [...new Set([...data.beds.outside, ...data.beds.inside, ...data.emitters.map((e) => e.sound)])];
  const out: { name: string; sound: RenderedSound }[] = [];
  const state = new Map<string, number>();
  for (const name of names) {
    const at = banks.findIndex((b) => b.names.has(name) || b.names.has(`${name} `));
    if (at < 0) continue;
    const bank = banks[at]!;
    const sound = renderLoop(bank, bank.names.get(name) ?? bank.names.get(`${name} `)!, caches[at]!, seconds, fade, { state });
    if (sound.voices > 0) out.push({ name, sound });
  }
  return out;
}

/** The loops' buffers, for the transfer list. */
export function loopTransferables(loops: readonly { sound: RenderedSound }[]): Transferable[] {
  return loops.flatMap(({ sound: s }) => [s.left, s.right, s.sendLeft, s.sendRight]
    .filter((x): x is Float32Array => x !== null).map((x) => x.buffer as ArrayBuffer));
}
