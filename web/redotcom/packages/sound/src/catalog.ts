import { parseRdr, rdrGet, Zar, type RdrNode } from '@s2u/archive';

/**
 * Where the game names the sounds the walk plays, apart from the materials (web/redotcom/docs/research/81 §5-§6).
 */

/**
 * A weapon's sounds, `RUN/ZWEAPON.ZAR/zweapon.rdr`'s `ZWEAPON` record (keys at `0x3fcb50`-`0x3fcc70` in the ELF's
 * strings): `FireSoundClose`, `FireSoundMed`, `FireSoundFar` -- one round heard near, mid and far -- and
 * `ReloadSound`. The ZWEAPON reader stores the three fire names as slots 0/1/2 (`FUN_003d0140`, decomp 322595-322609)
 * and the bank load resolves them to handles at the weapon's +0xe0/+0xe4/+0xe8 (`FUN_003d01c0`, 316290-316300); which
 * one a remote round plays is `fireVariant` (`./rules`) against `weaponGlobals`' distances. The `MED`/`FAR` marks in
 * `sounds.rdr` are not read by the game (`FUN_003435c0` has no such key). The M4A1 SD's are `.M4A1_SIL` and
 * `.M4A1_SIL_RLD`, with no medium or far variant: its slots 1 and 2 are empty, so past the medium distance a
 * suppressed round plays nothing.
 */
export interface WeaponSounds { name: string; fireClose: string | null; fireMed: string | null; fireFar: string | null; reload: string | null }

const sound = (record: RdrNode, key: string): string | null => {
  const v = rdrGet(record, key);
  return typeof v === 'string' && /^[.~!]/.test(v) ? v : null;
};

/** The `ZWEAPON` record whose `InternalName` is `name`, its four sound keys; null when there is none. */
export function weaponSounds(script: RdrNode, name: string): WeaponSounds | null {
  const list = rdrGet(script, 'ZWEAPON');
  if (!Array.isArray(list)) throw new Error('zweapon.rdr has no ZWEAPON');
  const record = list.find((r): r is RdrNode[] => Array.isArray(r) && rdrGet(r, 'InternalName') === name);
  if (!record) return null;
  return {
    name, fireClose: sound(record, 'FireSoundClose'), fireMed: sound(record, 'FireSoundMed'),
    fireFar: sound(record, 'FireSoundFar'), reload: sound(record, 'ReloadSound'),
  };
}

/**
 * `zweapon.rdr`'s `WEAPON_GLOBAL` record, the fire sounds' distances in **metres** (`FUN_003cd810`, decomp
 * 322042-322071, keys `SoundDistanceClose/Med/Far` at 0x3fc5d0/0x3fc5f0/0x3fc610): the game scales each by
 * `DAT_003dfe10` = 1 / `MetersPerUnit` (decomp 217166; 10 units a metre) and stores its square (`FUN_003d0100`, decomp
 * 323282-323288) in `DAT_004b52f0/f4/f8`, which `fireVariant` compares. The retail table: 0, 9 and 50. A key the
 * record lacks is left at 0, as the reader leaves the global unset (its data default).
 */
export interface WeaponGlobals { soundDistanceClose: number; soundDistanceMed: number; soundDistanceFar: number }

export function weaponGlobals(script: RdrNode): WeaponGlobals {
  const record = rdrGet(script, 'WEAPON_GLOBAL');
  if (!Array.isArray(record)) throw new Error('zweapon.rdr has no WEAPON_GLOBAL');
  const metres = (key: string): number => {
    const v = rdrGet(record, key);
    const n = typeof v === 'string' ? Number(v) : Array.isArray(v) && typeof v[0] === 'string' ? Number(v[0]) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  return {
    soundDistanceClose: metres('SoundDistanceClose'), soundDistanceMed: metres('SoundDistanceMed'), soundDistanceFar: metres('SoundDistanceFar'),
  };
}

/** `ZWEAPON.ZAR`'s one script, decoded. */
export function weaponScriptFromArchive(bytes: Uint8Array): RdrNode {
  const zar = Zar.parse(bytes);
  const key = zar.root.children.find((k) => k.name.toLowerCase() === 'zweapon.rdr');
  if (!key) throw new Error('ZWEAPON.ZAR has no zweapon.rdr');
  return parseRdr(zar.data(key));
}

/**
 * The game data's sound names no bank holds, and the name they meant -- **a deliberate departure from the retail game**
 * (the owner's playtest, 2026-09-29; research 81 §7, 89 §11). The casings' `shell_eject` zAnims name the metal bounce
 * `.BUL_CASE_METAL`; no bank of the 115 and no `sounds.rdr` entry carries it, `.BUL_CAS_METAL` is in 16 banks beside
 * `.BUL_CAS_STONE`, `_DIRT`, `_SAND` and `_WOOD`. The console looks the misspelt name up and plays nothing.
 */
export const SOUND_NAME_FIXES: Readonly<Record<string, string>> = {
  '.BUL_CASE_METAL': '.BUL_CAS_METAL',
  // Not a misspelling but a sound the disc does not have: `grenade_hit_asphalt` calls `.GREN_ASPHALT`, which no bank and
  // no zAnim of the 22 maps holds (research 81 §7) -- silent on the console. ASPHALT's own SOILS entry steps, crawls
  // and lands with the stone's sounds, so the viewer bounces it with the stone's.
  '.GREN_ASPHALT': '.GREN_STONE',
};

/** A sound name as the viewer resolves it: the data's slips mended (`SOUND_NAME_FIXES`). */
export function fixSoundName(name: string): string {
  return SOUND_NAME_FIXES[name] ?? SOUND_NAME_FIXES[name.trim()] ?? name;
}

/**
 * The casing sounds a map's banks may lack, and what stands in -- **a departure from the retail game** (the feel-QA
 * playtest, research 90 item 12). The game resolves a sound by its name's CRC among the loaded banks' sounds, a binary
 * search over one sorted table (`FUN_00344f30` -> `FUN_00344bf0`, decomp 243197): no fallback bank, no other name, so a
 * name the map's banks lack plays nothing. The shell table sends grass and dirt (materials 4 and 8) to `.BUL_CAS_DIRT`,
 * which 13 banks hold and Blood Lake's (MP10) does not, beside its own `.BUL_CAS_GRASS`; so on the console its casings
 * land on the ground in silence. The viewer plays the first of these the map holds.
 */
export const SOUND_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  '.BUL_CAS_DIRT': ['.BUL_CAS_GROUND', '.BUL_CAS_GRASS', '.BUL_CAS_SAND'],
  '.BUL_CAS_SAND': ['.BUL_CAS_GROUND', '.BUL_CAS_DIRT'],
  '.BUL_CAS_METAL': ['.BUL_CAS_GR8ING'],
  // The shotgun's shell on tin: two banks hold it (MP8's, MP61's); a map whose borrowing does not reach one plays its
  // shell on metal (research 90 item 18).
  '.SG_SHELL_TIN': ['.SG_SHELL_METAL'],
  // On sand: three banks (MP6's, MP7's, MP73's); elsewhere the casing's sand, else the shell on stone (every `_am` bank).
  '.SG_SHELL_SAND': ['.BUL_CAS_SAND', '.SG_SHELL_STONE'],
};

/**
 * The sound to play for a data sound name, the one path every play takes (the effects' casings and impacts, the
 * audio's callbacks, the list of names a map wants): the data's slips mended (`fixSoundName`), then the first
 * stand-in the banks hold (`SOUND_FALLBACKS`) when they lack it.
 */
export function soundFor(name: string, has: (name: string) => boolean): string {
  const fixed = fixSoundName(name);
  if (has(fixed)) return fixed;
  return SOUND_FALLBACKS[fixed]?.find(has) ?? fixed;
}

/** The zAnim command that plays a sound: set 0, command 30 (`_zanim_cmd_hdr`'s type 0x1e). */
export const ZANIM_PLAY_SOUND = 30;
/** The zAnim command that starts another animation by name: set 0, command 45 (0x2d). */
export const ZANIM_START_ANIM = 45;
/** The zAnim command that stops one (46, 0x2e): `check_camera_inside_state1` stops `outside_noise` with it. */
export const ZANIM_STOP_ANIM = 46;
/** A play-sound command's node byte (+16) naming the animation's own root node rather than a node reference. */
export const ZANIM_ROOT_NODE = 0xf9;
/** A play-sound command's size: 32 bytes, the offset's f32 triple at +0x14..+0x1f. */
export const ZANIM_SOUND_SIZE = 32;
/** A play-sound command's flag 4: its place starts from the offset at +0x14 (`FUN_002659c0`, `FUN_00309240`). */
export const ZANIM_SOUND_OFFSET = 4;
/**
 * A play-sound command's flag 0x10: its volume is the f32 at +8, else 1.0 (`FUN_002659c0`, decomp 112363-112416: the
 * new play's `uVar11` starts at 1.0 and takes `*(float *)(cmd + 8)` under the flag, then goes to the sound's play
 * as its volume, 112460-112461; `FUN_00342670` makes the app volume `volume x RANGE gain x 1024`, 241912-241955).
 */
export const ZANIM_SOUND_VOLUME = 0x10;

/**
 * The set-0 command numbers the ambience walk reads (`ambienceLayers`). A set's command list opens with `Reserved`
 * (`FUN_0026ac20` registers it at index 0 when the set is made, string 0x3ed270), then the base commands in
 * `FUN_0025bc20`'s order (decomp 106862-106925: QUAD_ALIGN 1, IF 2, ELSEIF 3, ELSE 4, ENDIF 5 ... LOOP 14, WAIT 15 ...
 * SOUND 30 ... WHILE 39, END_WHILE 40 ... EXPRESSION 43, BREAK 44, CALL_ANIMATION 45, STOP_ANIMATION 46 ...
 * REMOVE_SATCHELS 58), then the game's own, registered by `FUN_002ad290`'s callees in
 * their call order (152552-152556: `FUN_0059ac60`, `FUN_00354470`, `FUN_00293890`, `FUN_0029bc20`, `FUN_002b3930`; after
 * `FUN_0026b1a0` (152550) runs `FUN_0025bc20` at 115649; the `ai::` ones go to their own set, `FUN_005de320`): `RESET_BODY_PARTS` 59, `BODY_FALL_ON_MATERIAL_SOUND` 60, `VALVE` 61, `VBIT` 62, `VWATCH` 63,
 * `DYNAMICS_RELEASE_CAMERA` 64, `DYNAMICS_ACQUIRE_CAMERA` 65, **`CAMERA_INDOORS` 66**, `SET_CAMERA_REGION_TEST` 67,
 * `GET_CAMERA_REGION_TEST` 68, `CAMERA_PARAMS` 69, `CAMERA_3RD_PERSON` 70, `CAMERA_SHAKE` 71, **`PLAYER_INDOORS` 72**.
 * The anchors hold: the data's play-sound commands are 30 and its starts 45 (research 81 §6, §10).
 */
export const ZANIM_IF = 2;
export const ZANIM_ELSEIF = 3;
export const ZANIM_ELSE = 4;
export const ZANIM_ENDIF = 5;
export const ZANIM_LOOP = 14;
export const ZANIM_WAIT = 15;
export const ZANIM_EXPRESSION = 43;
/**
 * `CAMERA_INDOORS` (66): the tick (0x2936b0, 5 instructions read off the ELF) answers the byte at the camera's
 * `+0x128` object `+0x2b8`, which the camera's floor probe writes from the polygon's `m_inside` (`FUN_002dc180`,
 * decomp 140054-140055) and `FUN_00341a60` reads for the reverb (241521): the viewer's `setEnvironment(inside)`.
 */
export const ZANIM_CAMERA_INDOORS = 66;
/**
 * `PLAYER_INDOORS` (72): the tick (0x2b3880, read off the ELF) answers bit 2 of the player's byte `+0x1060`
 * (`DAT_00440c38`), 0 with no player. The common set's `check_camera_inside_state1` (the beds) tests this one.
 */
export const ZANIM_PLAYER_INDOORS = 72;
/** An `EXPRESSION` (43) operand: 1 is `!` -- the ELSEIF of every camera script is `! <its IF's test>` (reCOM's `IsOperator` order `!`, `&&`, `||`, `(`, `)` from 1; `&&` 2 joins the objectives' `VALVE` tests). */
export const ZANIM_EXPR_NOT = 1;

/** The shape of `@s2u/scene`'s `parseAnimSets` this reads (kept structural so the package needs no scene). */
export interface ZAnimSetsLike {
  sets: {
    name: string;
    anims: {
      name: string;
      names: string[];
      params?: { flags: number; rootNodeIndex: number };
      nodeRefs?: { name: string }[];
      sequences: { offset?: number; commands: { offset: number; set: number; cmd: number; size?: number }[] }[];
    }[];
  }[];
}

/** A command's bytes out of its animation's `Seq_Data` (set, animation, offset, length), or null when not to hand. */
export type ZAnimPayload = (set: string, anim: string, offset: number, length: number) => Uint8Array | null;

/**
 * One play-sound command: the sound, its flag half-word (+4), the scene node it sounds at (null: no place), and, with
 * flag 4, the offset (the f32 triple at +0x14) its place starts from -- in the node's frame, or the world's when the
 * node does not resolve (`FUN_002659c0`: the offset, then `FUN_00310980` through the node only when there is one).
 */
export interface ZAnimSoundCommand {
  sound: string; flags: number; node: string | null; offset?: [number, number, number];
  /** With flag 0x10 (`ZANIM_SOUND_VOLUME`), the command's own volume (the f32 at +8); absent: 1.0. */
  volume?: number;
}

/** A play-sound command's volume: its own with flag 0x10, else the game's 1.0 (`FUN_002659c0`). */
export function commandVolume(cmd: { volume?: number }): number {
  return cmd.volume ?? 1;
}

/** What an animation does with sound: its activation (`params.flags & 3`), the sounds it plays, the animations it starts. */
export interface ZAnimSoundInfo {
  set: string;
  anim: string;
  /** 1 on the mission's self-starting animations (the emitters, `check_camera_inside_state1`), 2 on the called ones. */
  activation: number;
  sounds: ZAnimSoundCommand[];
  calls: string[];
  stops: string[];
}

const SIGIL = /^[.~!][A-Z0-9_]/;

type ZAnimLike = ZAnimSetsLike['sets'][number]['anims'][number];

/**
 * The animations by name as the game resolves a bare name (`FUN_0026a250`, decomp 115001-115072): the registry's
 * **current** set first -- `DAT_00414be4`, written only by the set start `FUN_0026c600` (116314-116330), and both
 * start sites (75858-75866, 149735-149741) start `common` then `mission`, so the current set is the last started, the
 * mission's -- then every other set in load order; within a set the first animation of the name (`FUN_0026c8f0`).
 * `CALL_ANIMATION` reaches it through `FUN_0026e650` (117599) with the name string taken from the caller's own table.
 * So a name both sets carry is the mission's: Desert Glory's mission `inside_noise` (`~OUTDOOR_AMB` at 0.6), not the
 * common set's `~INDOOR_AMB` (research 81 §10). `archives` are in load order: `[CZANIM, MZANIM]`.
 */
export function resolveZAnims(archives: readonly ZAnimSetsLike[]): Map<string, { set: string; anim: ZAnimLike }> {
  const sets = archives.flatMap((a) => a.sets);
  const order = sets.length > 1 ? [sets[sets.length - 1]!, ...sets.slice(0, -1)] : sets;
  const out = new Map<string, { set: string; anim: ZAnimLike }>();
  for (const set of order) for (const anim of set.anims) if (!out.has(anim.name)) out.set(anim.name, { set: set.name, anim });
  return out;
}

/** A play-sound command read off its bytes (or, without them, the animation's first sigiled name); null for none. */
function soundCommand(set: string, anim: ZAnimLike, offset: number, payload?: ZAnimPayload): ZAnimSoundCommand | null {
  const b = payload?.(set, anim.name, offset, ZANIM_SOUND_SIZE) ?? payload?.(set, anim.name, offset, 20) ?? null;
  const name = b && b.length >= 20 ? anim.names[b[6]! | (b[7]! << 8)] : anim.names.find((n) => SIGIL.test(n));
  // A name without a sigil (`SND_OUTDOOR_WIND_GUST_LOOP`, `SND_OUTDOOR_AMBIENCE_LOOP`) is in no bank the maps load:
  // the console's lookup finds nothing and plays nothing, and so does the viewer.
  if (!name || !SIGIL.test(name)) return null;
  const root = anim.params?.rootNodeIndex ?? -1;
  const nodeByte = b && b.length >= 20 ? b[16]! : 0;
  const nodeIndex = nodeByte === ZANIM_ROOT_NODE ? root : nodeByte;
  const node = nodeIndex > 0 ? anim.nodeRefs?.[nodeIndex]?.name ?? null : null;
  const flags = b && b.length >= 20 ? b[4]! | (b[5]! << 8) : 0;
  const cmd: ZAnimSoundCommand = { sound: name, flags, node: node === 'NA' ? null : node };
  const v = b ? new DataView(b.buffer, b.byteOffset, b.byteLength) : null;
  if (v && flags & ZANIM_SOUND_VOLUME && b!.length >= 12) cmd.volume = v.getFloat32(8, true);
  if (v && flags & ZANIM_SOUND_OFFSET && b!.length >= ZANIM_SOUND_SIZE) {
    cmd.offset = [v.getFloat32(0x14, true), v.getFloat32(0x18, true), v.getFloat32(0x1c, true)];
  }
  return cmd;
}

/**
 * Every animation's sound commands (web/redotcom/docs/research/81 §6, §10), one per name as the game resolves it
 * (`resolveZAnims`: the mission set first): a play-sound command (30) names its sound by the `u16` at +6 (an index
 * into the animation's name table), carries flags at +4 (0x280 the beds, 0x82/0x282 a sound at a node, 0x10 a volume
 * at +8) and its node at +16 (a node reference's index, `0xf9` the animation's root node); a start (45) and a stop
 * (46) name another animation by the byte at +7 / +4 of the same table -- `frag_grenade_stone` starts
 * `frag_grenade`, `check_camera_inside_state1` stops `outside_noise` and starts `inside_noise`. Without `payload` a
 * play-sound command takes the animation's first sigiled name and the calls are not seen.
 */
export function zanimSounds(archives: readonly ZAnimSetsLike[], payload?: ZAnimPayload): Map<string, ZAnimSoundInfo> {
  const out = new Map<string, ZAnimSoundInfo>();
  for (const [name, { set, anim }] of resolveZAnims(archives)) {
    const info: ZAnimSoundInfo = { set, anim: name, activation: (anim.params?.flags ?? 0) & 3, sounds: [], calls: [], stops: [] };
    for (const q of anim.sequences) {
      for (const c of q.commands) {
        if (c.set !== 0) continue;
        if (c.cmd === ZANIM_PLAY_SOUND) {
          const cmd = soundCommand(set, anim, c.offset, payload);
          if (cmd) info.sounds.push(cmd);
        } else if (c.cmd === ZANIM_START_ANIM || c.cmd === ZANIM_STOP_ANIM) {
          const b = payload?.(set, name, c.offset, 8) ?? null;
          if (!b || b.length < 8) continue;
          const target = anim.names[c.cmd === ZANIM_START_ANIM ? b[7]! : b[4]!];
          if (!target || target === 'NA') continue;
          // CALL_ANIMATION (45, `FUN_0025d550`: the name at +7) naming a sound rather than an animation --
          // `grenade_hit_asphalt` calls `.GREN_ASPHALT` -- is taken as that sound.
          if (c.cmd === ZANIM_START_ANIM && SIGIL.test(target)) info.sounds.push({ sound: target, flags: 0, node: null });
          else (c.cmd === ZANIM_START_ANIM ? info.calls : info.stops).push(target);
        }
      }
    }
    out.set(name, info);
  }
  return out;
}

/** How deep a chain of starts is followed (a guard: the retail chains are one or two deep). */
const CALL_DEPTH = 8;

/** A sound a zAnim plays and the command's volume (`commandVolume`: 1 unless flag 0x10 gives its own). */
export interface ZAnimPlay { sound: string; volume: number }

/**
 * The zAnim callbacks' sounds with their volumes: `motion.rdr`'s `zanim_callback (name (jump_whoosh) time (0.4))`
 * runs the zAnim of that name (resolved as the game resolves it, `resolveZAnims`: the map's `MZANIM.ZAR` mission set
 * first, then its `CZANIM.ZAR` common set); what it plays is its own play-sound commands' sounds, each at its command's
 * volume (`satchel`'s `.MK138_SAT_CHRG` at 0.5, `flashcrash_grenade`'s `.MARK_141_FLASH` at 2.0), and, through its
 * starts, those of the animations it starts (`frag_grenade_stone` -> `frag_grenade` -> `.GREN_MED`), in command order,
 * each once. An animation that plays nothing is left out.
 */
export function callbackPlays(archives: ZAnimSetsLike | readonly ZAnimSetsLike[], payload?: ZAnimPayload): Map<string, ZAnimPlay[]> {
  const infos = zanimSounds(Array.isArray(archives) ? archives : [archives as ZAnimSetsLike], payload);
  const out = new Map<string, ZAnimPlay[]>();
  const collect = (name: string, into: ZAnimPlay[], seen: Set<string>, depth: number): void => {
    const info = infos.get(name);
    if (!info || seen.has(name) || depth > CALL_DEPTH) return;
    seen.add(name);
    for (const s of info.sounds) if (!into.some((p) => p.sound === s.sound)) into.push({ sound: s.sound, volume: commandVolume(s) });
    for (const c of info.calls) collect(c, into, seen, depth + 1);
  };
  for (const name of infos.keys()) {
    const plays: ZAnimPlay[] = [];
    collect(name, plays, new Set(), 0);
    if (plays.length > 0) out.set(name, plays);
  }
  return out;
}

/** `callbackPlays`' sound names alone. */
export function callbackSounds(archives: ZAnimSetsLike | readonly ZAnimSetsLike[], payload?: ZAnimPayload): Map<string, string[]> {
  return new Map([...callbackPlays(archives, payload)].map(([name, plays]) => [name, plays.map((p) => p.sound)]));
}

/**
 * A looping sound a mission starts at a place: the ambience emitters (`~FAN_ROTATE` at `fan1`, `~RIVER` ...), with the
 * command's offset where it has one (flag 4: Foxhunt's spray, the two water drains).
 */
export interface ZAnimEmitter {
  anim: string; sound: string; node: string; flags: number; offset?: [number, number, number];
  /** The command's volume, with flag 0x10 (Desert Glory's fires: `~FIRE_SM` at 3.0); absent: 1.0. */
  volume?: number;
}

/**
 * The mission's self-starting animations (activation 1) that play a looping (`~`) sound at a node -- 0 to 18 a map:
 * Frostfire's `fanblade1_start` (`~FAN_ROTATE` at `fan1`), Desert Glory's lights' insects and fires, the rivers,
 * crickets, dogs and chimes elsewhere. A zAnim a SoftImage script moves (the helicopters) sounds at its node's rest.
 */
export function zanimEmitters(infos: ReadonlyMap<string, ZAnimSoundInfo>): ZAnimEmitter[] {
  const out: ZAnimEmitter[] = [];
  for (const info of infos.values()) {
    if (info.activation !== 1) continue;
    for (const s of info.sounds) {
      if (!s.sound.startsWith('~') || !s.node) continue;
      if (!out.some((e) => e.anim === info.anim && e.sound === s.sound)) {
        out.push({
          anim: info.anim, sound: s.sound, node: s.node, flags: s.flags, ...(s.offset ? { offset: s.offset } : {}),
          ...(s.volume !== undefined ? { volume: s.volume } : {}),
        });
      }
    }
  }
  return out;
}

/** Which test a camera-state script branches on: `CAMERA_INDOORS` (66) or `PLAYER_INDOORS` (72). */
export type IndoorsTest = 'camera' | 'player';

/**
 * One layer of the mission's ambience: a sound an animation plays without a place, started by a camera-state script
 * on one side (indoors or out) and stopped when the side changes.
 *
 * - `loop`: a `~` sound its sequence starts once -- it loops by itself (the beds, `~OUTDOOR_AMB`);
 * - `once`: a `.` sound its sequence starts once;
 * - `repeat`: a one-shot its sequence replays for ever -- `SOUND`, then `WAIT`, then `LOOP` -1 (`FUN_0025ede0`, the
 *   `LOOP` tick: a count of -1 never ends it) -- every `base + range x U[0,1)` seconds (the `WAIT`'s random form,
 *   `FUN_0025ed50`: flag 0x20 takes the pair at +12/+16, or at +16/+20 with flag 0x10; a plain `WAIT` is the f32 at +8,
 *   `range` 0). Frostfire's wind gusts: `.OUTDR_WND_GST2` every 5-20 s, `.OUTDR_WND_GST3` every 2-16 s.
 */
export interface AmbienceLayer {
  anim: string;
  sound: string;
  volume: number;
  kind: 'loop' | 'once' | 'repeat';
  /** For `repeat`: the wait after each play, seconds. */
  wait?: { base: number; range: number };
  /** The script's test that picks the side (`CAMERA_INDOORS` for the wind, `PLAYER_INDOORS` for the beds). */
  test: IndoorsTest;
  /** Seconds after the mission starts before the script's first test (the `WAIT`s ahead of it: Frostfire's wind 8). */
  delay: number;
}

/** The ambience per side of the camera-state scripts (`ambienceLayers`). */
export interface AmbienceLayers { outside: AmbienceLayer[]; inside: AmbienceLayer[] }

const f32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(at, true);

/** A `WAIT`'s seconds as `{ base, range }` (`FUN_0025ed50`), or null for an untimed one (no flag 8). */
function waitOf(b: Uint8Array | null): { base: number; range: number } | null {
  if (!b || b.length < 12) return null;
  const flags = b[4]! | (b[5]! << 8);
  if (!(flags & 8)) return null;
  if (flags & 0x20) {
    const at = 8 + 4 * (flags & 0x10 ? 2 : 1);
    return b.length >= at + 8 ? { base: f32(b, at), range: f32(b, at + 4) } : null;
  }
  return { base: f32(b, 8), range: 0 };
}

type Branch = { test: IndoorsTest; inside: boolean };

/**
 * An `IF`/`ELSEIF` whose expression is one indoors test, or `!` and one (the `EXPRESSION` 43 with operand 1): the side
 * its branch runs on. The expression follows the command's 8-byte head as 4-byte-aligned commands (the `IF`'s
 * `02 00 32 00 01 00 00 00 | 48 00 12 00`: `PLAYER_INDOORS`; the `ELSEIF`'s `.. | 2b 00 22 00 01 00 00 00 | 48 00 12 00`).
 * Anything else (the objectives' `VALVE` tests, a `RANGE_TEST`) is not the ambience's: null.
 */
function indoorsBranch(b: Uint8Array | null): Branch | null {
  if (!b || b.length < 12) return null;
  let at = 8, not = false;
  if (b[at] === ZANIM_EXPRESSION && b.length >= at + 12 && b[at + 4] === ZANIM_EXPR_NOT) { not = true; at += 8; }
  if (b.length !== at + 4) return null;
  const term = b[at];
  if (term !== ZANIM_CAMERA_INDOORS && term !== ZANIM_PLAYER_INDOORS) return null;
  return { test: term === ZANIM_CAMERA_INDOORS ? 'camera' : 'player', inside: !not };
}

/**
 * The mission's ambience by camera state (research 81 §10), walked out of its scripts rather than two literal names:
 * every self-starting animation (activation 1) is read in command order, and the starts (45) inside an `IF`/`ELSEIF`
 * on `CAMERA_INDOORS` or `PLAYER_INDOORS` (or its `!`; `ELSE` the other side) are that side's; a start outside any
 * branch runs on both. Each started animation's sequences give its layers: its placeless play-sound commands (no node,
 * no offset -- a placed one is an emitter) with their volumes, and a sequence that replays one for ever its wait.
 *
 * The common set's `check_camera_inside_state1` (every map) starts `outside_noise` / `inside_noise` on
 * `PLAYER_INDOORS`; Frostfire's mission `check_camera_inside_state` waits 8 s, then starts `wind_outside` /
 * `wind_inside` on `CAMERA_INDOORS` (the gusts `.OUTDR_WND_GST2`/`_GST3`, at 1.0 out, 0.6 in); MP1's starts
 * `snd_wind_outside` / `snd_wind_inside` (`~OUTDOOR_AMB` at 1.0 out, 0.6 in). A start naming no animation
 * (Frostfire's unconditional `snd_wind_outside`, a name copied from MP1's script) plays nothing, as on the console. One
 * layer per side for a sound at one volume and kind (two scripts starting the same bed are one loop here).
 */
export function ambienceLayers(archives: readonly ZAnimSetsLike[], payload?: ZAnimPayload): AmbienceLayers {
  const anims = resolveZAnims(archives);
  const out: AmbienceLayers = { outside: [], inside: [] };
  const bytes = (set: string, anim: string, c: { offset: number; size?: number }, fallback: number): Uint8Array | null =>
    payload?.(set, anim, c.offset, c.size ?? fallback) ?? null;
  const add = (side: 'outside' | 'inside', target: string, test: IndoorsTest, delay: number): void => {
    const found = anims.get(target);
    if (!found) return;
    const { set, anim } = found;
    for (const q of anim.sequences) {
      const sounds: ZAnimSoundCommand[] = [];
      let wait: { base: number; range: number } | null = null, forever = false;
      for (const c of q.commands) {
        if (c.set !== 0) continue;
        if (c.cmd === ZANIM_PLAY_SOUND) {
          const s = soundCommand(set, anim, c.offset, payload);
          if (s && !s.node && !(s.flags & ZANIM_SOUND_OFFSET)) sounds.push(s);
        } else if (c.cmd === ZANIM_WAIT) wait ??= waitOf(bytes(set, target, c, 12));
        else if (c.cmd === ZANIM_LOOP) {
          const b = bytes(set, target, c, 12);
          if (b && b.length >= 12 && (b[4]! & 1) && new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(8, true) === -1) forever = true;
        }
      }
      for (const s of sounds) {
        const repeat = forever && wait !== null;
        const layer: AmbienceLayer = {
          anim: target, sound: s.sound, volume: commandVolume(s),
          kind: repeat ? 'repeat' : s.sound.startsWith('~') ? 'loop' : 'once', ...(repeat ? { wait: wait! } : {}), test, delay,
        };
        if (!out[side].some((l) => l.sound === layer.sound && l.volume === layer.volume && l.kind === layer.kind)) out[side].push(layer);
      }
    }
  };
  for (const [name, { set, anim }] of anims) {
    if (((anim.params?.flags ?? 0) & 3) !== 1) continue;
    const branches: (Branch | null)[] = [];
    const starts: { target: string; branch: Branch | null }[] = [];
    let delay = 0, first: IndoorsTest | null = null;
    for (const q of anim.sequences) {
      for (const c of q.commands) {
        if (c.set !== 0) continue;
        if (c.cmd === ZANIM_IF || c.cmd === ZANIM_ELSEIF) {
          const branch = indoorsBranch(bytes(set, name, c, c.cmd === ZANIM_IF ? 12 : 20));
          if (c.cmd === ZANIM_IF) branches.push(branch); else branches[branches.length - 1] = branch;
          if (branch) first ??= branch.test;
        } else if (c.cmd === ZANIM_ELSE) {
          const top = branches[branches.length - 1];
          branches[branches.length - 1] = top ? { test: top.test, inside: !top.inside } : null;
        } else if (c.cmd === ZANIM_ENDIF) branches.pop();
        else if (c.cmd === ZANIM_WAIT && first === null && branches.length === 0) {
          const w = waitOf(bytes(set, name, c, 12));
          if (w) delay += w.base;
        } else if (c.cmd === ZANIM_START_ANIM) {
          const b = bytes(set, name, c, 20);
          const target = b && b.length >= 8 ? anim.names[b[7]!] : undefined;
          if (!target || target === 'NA' || SIGIL.test(target)) continue;
          // Inside a branch the innermost test decides; a start under some other test is not the ambience's.
          if (branches.length > 0 && branches[branches.length - 1] === null) continue;
          starts.push({ target, branch: branches.length > 0 ? branches[branches.length - 1]! : null });
        }
      }
    }
    if (!first) continue;                           // no indoors test: not a camera-state script
    for (const { target, branch } of starts) {
      if (branch) add(branch.inside ? 'inside' : 'outside', target, branch.test, delay);
      else { add('outside', target, first, delay); add('inside', target, first, delay); }
    }
  }
  return out;
}
