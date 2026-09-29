import { parseRdr, rdrGet, Zar, type RdrNode } from '@s2u/archive';

/**
 * Where the game names the sounds the walk plays, apart from the materials (web/docs/research/81 §5-§6).
 */

/**
 * A weapon's sounds, `RUN/ZWEAPON.ZAR/zweapon.rdr`'s `ZWEAPON` record (keys at `0x3fcb50`-`0x3fcc70` in the ELF's
 * strings): `FireSoundClose`, `FireSoundMed`, `FireSoundFar` -- one round heard near, mid and far, the `MED`/`FAR`
 * variants `sounds.rdr` marks -- and `ReloadSound`. The M4A1 SD's are `.M4A1_SIL` and `.M4A1_SIL_RLD`, with no
 * medium or far variant: a suppressed round is heard near only.
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

/** `ZWEAPON.ZAR`'s one script, decoded. */
export function weaponScriptFromArchive(bytes: Uint8Array): RdrNode {
  const zar = Zar.parse(bytes);
  const key = zar.root.children.find((k) => k.name.toLowerCase() === 'zweapon.rdr');
  if (!key) throw new Error('ZWEAPON.ZAR has no zweapon.rdr');
  return parseRdr(zar.data(key));
}

/** The zAnim command that plays a sound: set 0, command 30 (`_zanim_cmd_hdr`'s type 0x1e). */
export const ZANIM_PLAY_SOUND = 30;
/** The zAnim command that starts another animation by name: set 0, command 45 (0x2d). */
export const ZANIM_START_ANIM = 45;
/** The zAnim command that stops one (46, 0x2e): `check_camera_inside_state1` stops `outside_noise` with it. */
export const ZANIM_STOP_ANIM = 46;
/** A play-sound command's node byte (+16) naming the animation's own root node rather than a node reference. */
export const ZANIM_ROOT_NODE = 0xf9;

/** The shape of `@s2u/scene`'s `parseAnimSets` this reads (kept structural so the package needs no scene). */
export interface ZAnimSetsLike {
  sets: {
    name: string;
    anims: {
      name: string;
      names: string[];
      params?: { flags: number; rootNodeIndex: number };
      nodeRefs?: { name: string }[];
      sequences: { commands: { offset: number; set: number; cmd: number; size?: number }[] }[];
    }[];
  }[];
}

/** A command's bytes out of its animation's `Seq_Data` (set, animation, offset, length), or null when not to hand. */
export type ZAnimPayload = (set: string, anim: string, offset: number, length: number) => Uint8Array | null;

/** One play-sound command: the sound, its flag half-word (+4), and the scene node it sounds at (null: no place). */
export interface ZAnimSoundCommand { sound: string; flags: number; node: string | null }

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

/**
 * Every animation's sound commands (web/docs/research/81 §6, §10): a play-sound command (30) names its sound by the
 * `u16` at +6 (an index into the animation's name table), carries flags at +4 (0x280 the beds, 0x82/0x282 a sound at
 * a node) and its node at +16 (a node reference's index, `0xf9` the animation's root node); a start (45) and a stop
 * (46) name another animation by the byte at +7 / +4 of the same table -- `frag_grenade_stone` starts
 * `frag_grenade`, `check_camera_inside_state1` stops `outside_noise` and starts `inside_noise`. Without `payload` a
 * play-sound command takes the animation's first sigiled name and the calls are not seen.
 */
export function zanimSounds(archives: readonly ZAnimSetsLike[], payload?: ZAnimPayload): Map<string, ZAnimSoundInfo> {
  const out = new Map<string, ZAnimSoundInfo>();
  for (const archive of archives) {
    for (const set of archive.sets) {
      for (const anim of set.anims) {
        if (out.has(anim.name)) continue;
        const info: ZAnimSoundInfo = { set: set.name, anim: anim.name, activation: (anim.params?.flags ?? 0) & 3, sounds: [], calls: [], stops: [] };
        const root = anim.params?.rootNodeIndex ?? -1;
        for (const q of anim.sequences) {
          for (const c of q.commands) {
            if (c.set !== 0) continue;
            if (c.cmd === ZANIM_PLAY_SOUND) {
              const b = payload?.(set.name, anim.name, c.offset, 20) ?? null;
              const name = b && b.length >= 20 ? anim.names[b[6]! | (b[7]! << 8)] : anim.names.find((n) => SIGIL.test(n));
              if (!name || !SIGIL.test(name)) continue;
              const nodeByte = b && b.length >= 20 ? b[16]! : 0;
              const nodeIndex = nodeByte === ZANIM_ROOT_NODE ? root : nodeByte;
              const node = nodeIndex > 0 ? anim.nodeRefs?.[nodeIndex]?.name ?? null : null;
              info.sounds.push({ sound: name, flags: b && b.length >= 20 ? b[4]! | (b[5]! << 8) : 0, node: node === 'NA' ? null : node });
            } else if (c.cmd === ZANIM_START_ANIM || c.cmd === ZANIM_STOP_ANIM) {
              const b = payload?.(set.name, anim.name, c.offset, 8) ?? null;
              if (!b || b.length < 8) continue;
              const target = anim.names[c.cmd === ZANIM_START_ANIM ? b[7]! : b[4]!];
              if (target && target !== 'NA') (c.cmd === ZANIM_START_ANIM ? info.calls : info.stops).push(target);
            }
          }
        }
        out.set(anim.name, info);
      }
    }
  }
  return out;
}

/** How deep a chain of starts is followed (a guard: the retail chains are one or two deep). */
const CALL_DEPTH = 8;

/**
 * The zAnim callbacks' sounds: `motion.rdr`'s `zanim_callback (name (jump_whoosh) time (0.4))` runs the zAnim of that
 * name out of the map's `CZANIM.ZAR` (its `common` set) or `MZANIM.ZAR` (its `mission` set); what it plays is its own
 * play-sound commands' sounds and, through its starts, those of the animations it starts (`frag_grenade_stone` ->
 * `frag_grenade` -> `.GREN_MED`), in command order, each once. An animation that plays nothing is left out.
 */
export function callbackSounds(archives: ZAnimSetsLike | readonly ZAnimSetsLike[], payload?: ZAnimPayload): Map<string, string[]> {
  const infos = zanimSounds(Array.isArray(archives) ? archives : [archives as ZAnimSetsLike], payload);
  const out = new Map<string, string[]>();
  const collect = (name: string, into: string[], seen: Set<string>, depth: number): void => {
    const info = infos.get(name);
    if (!info || seen.has(name) || depth > CALL_DEPTH) return;
    seen.add(name);
    for (const s of info.sounds) if (!into.includes(s.sound)) into.push(s.sound);
    for (const c of info.calls) collect(c, into, seen, depth + 1);
  };
  for (const name of infos.keys()) {
    const sounds: string[] = [];
    collect(name, sounds, new Set(), 0);
    if (sounds.length > 0) out.set(name, sounds);
  }
  return out;
}

/** A looping sound a mission starts at a place: the ambience emitters (`~FAN_ROTATE` at `fan1`, `~RIVER` ...). */
export interface ZAnimEmitter { anim: string; sound: string; node: string; flags: number }

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
      if (!out.some((e) => e.anim === info.anim && e.sound === s.sound)) out.push({ anim: info.anim, sound: s.sound, node: s.node, flags: s.flags });
    }
  }
  return out;
}
