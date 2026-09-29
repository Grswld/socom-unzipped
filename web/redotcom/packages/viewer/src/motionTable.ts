import { parseRdr, rdrGet, Zar, type AssetSource, type RdrNode } from '@s2u/archive';
import { parseMotionClip, type MotionClip } from '@s2u/scene';

/**
 * The play mode's disc data (web sprint 2, W2.2b; ruling W2.R6: read at run time, never written into the source):
 *
 * - **`motion.rdr`**, in `RUN/READERC.ZAR`, the playback table (web/docs/research/77 §7): one entry a clip, by the
 *   clip's name, with `looped`, `playback`, `max_velocity`, `BlendTime`, `transition_speed_A/B`, `NoInterrupt`,
 *   `zanim_callback` and the flags beside them. The fields the animator reads are kept (`MotionEntry`), each a number
 *   or absent, and the `zanim_callback`s; the rest (`NoFire`, `Lateral`, ...) are left for the tasks that act on them.
 * - **`RUN/MOTION_P.ZAR`**, the player's pack (research 77 §12): the clips the animator asks for, by name, through
 *   `@s2u/scene`'s reader.
 *
 * Both sit beside the maps in a served tree (the owner's handoff; `extract-maps` copies `READERC.ZAR`) and in the
 * disc image. A source without the pack gives nothing and the body stands in its bind pose; one without the table
 * plays the clips at their own rate with the animator's named placeholders.
 */

/** Where the table's file sits (as `physics.ts`'s `DYNAMICS_PATH`). */
export const MOTION_TABLE_PATH = 'RUN/READERC.ZAR';
/** Where the player's pack sits: a loose file on the disc, not a map member (research 77 §1). */
export const MOTION_PACK_PATH = 'RUN/MOTION_P.ZAR';
const TABLE_READER = 'motion.rdr';

/**
 * One clip's playback, as `motion.rdr` states it; a field the entry does not carry, or carries as no number, is null.
 * Units are the file's: seconds, metres a second (the maps' unit is a tenth of a metre, `physics.ts` `WORLD_SCALE`).
 */
export interface MotionEntry {
  /** `looped`: 1 or 0 -- research 25's loaded-clip bit, `+0x49` bit 6 (77 §7). */
  looped: boolean | null;
  /** `playback`: seconds the clip plays in for a clip that is no locomotion; 1 on the cycles (77 §7, the reading). */
  playback: number | null;
  /** `max_velocity`, metres a second: positive on the locomotion cycles, negative on the rest. */
  maxVelocity: number | null;
  /** `BlendTime`, seconds: the cross-fade into this clip. */
  blendTime: number | null;
  /** `transition_speed_A` and `_B`, metres a second: the speeds this cycle covers. */
  transitionA: number | null;
  transitionB: number | null;
  /**
   * `NoInterrupt`: the phase past which the stick may cut the clip (`FUN_00587c20`); null when absent (the loader's 0:
   * at once), 1 when bare (`NoInterrupt ()`, the loader's 1.0: never).
   */
  noInterrupt: number | null;
  /** The `Lateral` flag (`+0x4a` bit 0): a strafe; `FUN_00577000` blends the lateral clips' rotations together first. */
  lateral?: boolean;
  /** The `NoPitchtwist` flag (`+0x4a` bit 3 clear): the upper body does not take the aim's pitch on this clip. */
  noPitchtwist?: boolean;
  /**
   * `zanim_callback`s, in the file's order: the zAnim animation the motion fires (`name`, e.g. `seal_jump`'s
   * `jump_whoosh`) and when (`time`, as the file has it). The loader `FUN_00287620` (decomp 131191-131653) reads every
   * one and keeps a time over 1 as seconds, dividing it by `playback x (n - 1) / n` into the clip's phase; a time of 1
   * or under is already a phase (`./animator` `callbackPhase`). `FUN_0028c9e0` fires each as the phase crosses it.
   */
  callbacks: { name: string; time: number }[];
}

/** The table, by clip name. */
export type MotionTable = ReadonlyMap<string, MotionEntry>;

/** Whether a record carries a key at all, a bare flag included (`FUN_0032f0d0` finds it). */
function has(record: RdrNode[], key: string): boolean {
  for (let i = 0; i < record.length; i += 1) if (record[i] === key) return true;
  return false;
}

/** A field's one number, or null (absent, an empty flag list, or not a number). */
function numberOf(record: RdrNode, key: string): number | null {
  const v = rdrGet(record, key);
  if (typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every `zanim_callback` of a record (the loader walks them with `FUN_0032f0d0` / `FUN_0032ef20`, the first and the
 * next of a key): each a `name` and a `time`; one without both is skipped.
 */
function callbacksOf(record: RdrNode[]): { name: string; time: number }[] {
  const out: { name: string; time: number }[] = [];
  for (let i = 0; i + 1 < record.length; i++) {
    if (record[i] !== 'zanim_callback') continue;
    const body = record[i + 1]!;
    const name = rdrGet(body, 'name'), time = Number(rdrGet(body, 'time'));
    if (typeof name === 'string' && Number.isFinite(time)) out.push({ name, time });
  }
  return out;
}

/**
 * The table out of a decoded `motion.rdr`: `animations` holds one record a clip, each `anim_name` and its fields
 * (research 77 §7). A record without a name is skipped; so is anything that is not a record.
 */
export function readMotionTable(rdr: RdrNode): Map<string, MotionEntry> {
  const out = new Map<string, MotionEntry>();
  const list = rdrGet(rdr, 'animations');
  if (!Array.isArray(list)) return out;
  for (const record of list) {
    if (!Array.isArray(record)) continue;
    const name = rdrGet(record, 'anim_name');
    if (typeof name !== 'string') continue;
    const looped = numberOf(record, 'looped');
    out.set(name, {
      looped: looped === null ? null : looped !== 0,
      playback: numberOf(record, 'playback'),
      maxVelocity: numberOf(record, 'max_velocity'),
      blendTime: numberOf(record, 'BlendTime'),
      transitionA: numberOf(record, 'transition_speed_A'),
      transitionB: numberOf(record, 'transition_speed_B'),
      noInterrupt: numberOf(record, 'NoInterrupt') ?? (has(record, 'NoInterrupt') ? 1 : null),
      lateral: has(record, 'Lateral'),
      noPitchtwist: has(record, 'NoPitchtwist'),
      callbacks: callbacksOf(record),
    });
  }
  return out;
}

/** The table out of a `READERC.ZAR`'s bytes, or null when they are not an archive holding `motion.rdr`. */
export function motionTableFromArchive(bytes: Uint8Array): Map<string, MotionEntry> | null {
  try {
    const zar = Zar.parse(bytes);
    const key = zar.find(TABLE_READER);
    return key ? readMotionTable(parseRdr(zar.data(key))) : null;
  } catch {
    return null;
  }
}

/** The clips of a `MOTION_*.ZAR` named in `names`, in that order, each once; a name the pack lacks is left out. */
export function clipsFromPack(bytes: Uint8Array, names: readonly string[]): MotionClip[] {
  const zar = Zar.parse(bytes);
  const out: MotionClip[] = [];
  for (const name of new Set(names)) {
    const key = zar.find(name);
    if (key) out.push(parseMotionClip(zar.data(key), name));
  }
  return out;
}

/** What the worker hands the page for the play mode: the clips asked for, and their table entries (null: no table). */
export interface PlayData {
  clips: MotionClip[];
  table: [string, MotionEntry][] | null;
}

/**
 * The play data from `source`: the pack's clips named in `names` and `motion.rdr`'s entries for them. Null, and
 * nothing said, when the source has no `MOTION_P.ZAR` or it will not read (a served tree without the owner's file
 * answers 404): the body then stands in its bind pose.
 */
export async function playFromDisc(source: AssetSource, names: readonly string[]): Promise<PlayData | null> {
  let clips: MotionClip[];
  try {
    clips = clipsFromPack(await source.read(MOTION_PACK_PATH), names);
  } catch {
    return null;
  }
  let table: Map<string, MotionEntry> | null = null;
  try {
    table = motionTableFromArchive(await source.read(MOTION_TABLE_PATH));
  } catch { /* no READERC.ZAR: the clips play on the placeholders */ }
  const wanted = new Set(names);
  return { clips, table: table && [...table].filter(([name]) => wanted.has(name)) };
}

/** The clips' typed arrays, for the worker's transfer list. */
export function playTransferables(data: PlayData): Transferable[] {
  const out = new Set<ArrayBufferLike>();
  for (const c of data.clips) for (const p of c.parts) { out.add(p.translations.buffer); out.add(p.rotations.buffer); }
  return [...out] as Transferable[];
}
