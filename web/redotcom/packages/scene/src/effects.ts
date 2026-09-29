import { rdrGet, type RdrNode } from '@s2u/archive';
import { rdrReal } from './tuning';
import type { DecalEntry } from './weapons';
import type { ZAnimAnimation, ZAnimCommand } from './zanim';
import { decodeObjectMotion, type ObjectMotion } from './effectMotion';
import { decodeParticleSource, type ParticleSource } from './effectParticles';

/**
 * The zAnim effect commands, decoded (web/docs/research/89). A zAnim animation of `CZANIM.ZAR` (the `common` set) is
 * sequences of commands (77 §9); this file turns a command's bytes into what it does, for the ones the game's gunplay
 * runs -- the muzzle effects (`FireAnimName`: `muzzle_m4SD` calls `shell_eject` and `shell_smoke_med`), the shell's
 * flight, the smoke, the flash -- and the control flow around them.
 *
 * **The numbering is the registration order.** `FUN_0025bc20` (decomp 106863-106924) registers the base set's commands
 * with `FUN_0026a8e0(0x414bb0, name, parser, begin, tick, end)` one after another, and a command's number in the data
 * is its place in that list, from 1: `QUAD_ALIGN` 1, `IF` 2 ... `OBJECT_MOTION` 21, `PARTICLE_SOURCE` 27, `SOUND` 30
 * (the play-sound command research 81 §6 read as 30), `LIGHT` 32, `CALL_ANIMATION` 45. SOCOM 1's numbers in reCOM's
 * `zanim.h` are not these. Commands other modules register later follow from 61 (`VALVE`, a valve id, an operator
 * and a value, by its use).
 */

/** The base set's command names by number (`FUN_0025bc20`'s order, strings at 0x3eccc0-0x3ed0d0). */
export const ZANIM_COMMAND_NAMES: readonly string[] = [
  '', 'QUAD_ALIGN', 'IF', 'ELSEIF', 'ELSE', 'ENDIF', 'OBJECT_MAKE_WORLDCHILD', 'NODE_ACTIVE', 'NODE_RENDERED',
  'RANGE_TEST', 'RANDOM_WEIGHT', 'FAIL', 'ANIM_HEALTH', 'ANIM_LOD', 'LOOP', 'WAIT', 'OBJECT_BLENDMODE',
  'OBJECT_ACTIVE_STATE', 'OBJECT_TRANSLATE_STATE', 'OBJECT_ROTATE_STATE', 'OBJECT_AIM', 'OBJECT_MOTION',
  'OBJECT_MOTION_FROM_TO', 'WHEEL_MOTION', 'SCROLL_MOTION', 'OBJECT_OPACITY_FROM_TO', 'OBJECT_MOTION_SI_SCRIPT',
  'PARTICLE_SOURCE', 'CAMERA', 'DESTRUCTION_SOURCE', 'SOUND', 'UPDATE_SHADOW_MAP_LIGHTING', 'LIGHT', 'BLUR3D',
  'IRIS_EFFECT', 'SCALE_COLOR', 'TRUE_COLOR_SCALE', 'RIPPLE', 'RIPPLE_NODE_GROUP', 'WHILE', 'END_WHILE',
  'FOR_CHILDREN', 'END_FOR_CHILDREN', 'EXPRESSION', 'BREAK', 'CALL_ANIMATION', 'STOP_ANIMATION', 'PAUSE_ANIMATION',
  'RESUME_ANIMATION', 'INVALIDATE_ANIMATION', 'CALL_SEQUENCE', 'STOP_SEQUENCE', 'DEBUG', 'OBJECT_ADD_CHILD',
  'OBJECT_DELETE_CHILD', 'MESSAGE', 'TIMER', 'FIRE_WEAPON', 'REMOVE_SATCHELS', 'ui::UI_COMMAND', 'ui::UI_APP_COMMAND',
  'VALVE',
];

/** The numbers the effects use (see `ZANIM_COMMAND_NAMES`). */
export const ZCMD = {
  QUAD_ALIGN: 1, IF: 2, ELSEIF: 3, ELSE: 4, ENDIF: 5, RANGE_TEST: 9, RANDOM_WEIGHT: 10, FAIL: 11, LOOP: 14, WAIT: 15,
  OBJECT_ACTIVE_STATE: 17, OBJECT_TRANSLATE_STATE: 18, OBJECT_ROTATE_STATE: 19, OBJECT_MOTION: 21,
  OBJECT_MOTION_FROM_TO: 22, PARTICLE_SOURCE: 27, SOUND: 30, LIGHT: 32, EXPRESSION: 43, CALL_ANIMATION: 45,
  STOP_SEQUENCE: 51, VALVE: 61, WHILE: 39, END_WHILE: 40, CALL_SEQUENCE: 50, STOP_ANIMATION: 46, PAUSE_ANIMATION: 47,
} as const;

export type Vec3 = [number, number, number];
/** A quaternion as the engine stores one: x, y, z, then w. */
export type Quat4 = [number, number, number, number];

/** A little-endian view over one command's bytes; reads past the end answer 0. */
export class CmdBytes {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number { return this.bytes.length; }
  private has(o: number, n: number): boolean { return o >= 0 && o + n <= this.bytes.length; }
  u8(o: number): number { return this.has(o, 1) ? this.bytes[o]! : 0; }
  i8(o: number): number { return this.has(o, 1) ? this.view.getInt8(o) : 0; }
  u16(o: number): number { return this.has(o, 2) ? this.view.getUint16(o, true) : 0; }
  i16(o: number): number { return this.has(o, 2) ? this.view.getInt16(o, true) : 0; }
  u32(o: number): number { return this.has(o, 4) ? this.view.getUint32(o, true) : 0; }
  i32(o: number): number { return this.has(o, 4) ? this.view.getInt32(o, true) : 0; }
  f32(o: number): number { return this.has(o, 4) ? this.view.getFloat32(o, true) : 0; }
  vec3(o: number): Vec3 { return [this.f32(o), this.f32(o + 4), this.f32(o + 8)]; }
  quat(o: number): Quat4 { return [this.f32(o), this.f32(o + 4), this.f32(o + 8), this.f32(o + 12)]; }
}

/**
 * `LIGHT` (32; tick `FUN_00264cb0`, decomp 111906-112214; research 89 §10): a dynamic light the engine draws as a second
 * pass of every lit visual it reaches -- `light_map.tif` projected on the surface, its colour times the falloff.
 */
export interface ZAnimLight {
  flags: number;
  /** +8 with flag 0x2: the node it sits at (`NODE_CALLER`: the muzzle's weapon), or null. */
  node: number | null;
  /** Flag 0x8: at the context's position (an explosion's point). */
  atContext: boolean;
  /** +0x14 with flag 0x4, added. */
  offset: Vec3;
  /** 0..255 (+0x20, flag 0x40). */
  rgb: Vec3;
  /** The pass's vertex alpha, 128 = 1 (+0x2c, flag 0x80; the default 64, `FUN_00315110`). */
  opacity: number;
  /** The GS ALPHA selector (+9 with flag 0x100, else 0x44): 0x44 source alpha, 0x48 additive. */
  blend: number;
  /** The ranges `(t, min, max)` (s16 count +0x34, offset +0x36, flag 0x20), linear, the last held; or the static pair (flag 0x10). */
  ranges: [number, number, number][];
  /** Seconds (+0x3c): the command's length. */
  duration: number;
}

export function decodeLight(c: CmdBytes): ZAnimLight {
  const flags = c.u16(4);
  const ranges: [number, number, number][] = [];
  if (flags & 0x20) {
    const n = c.i16(0x34), o = c.i16(0x36);
    for (let i = 0; i < n && o > 0; i++) ranges.push([c.f32(o + 12 * i), c.f32(o + 12 * i + 4), c.f32(o + 12 * i + 8)]);
  } else if (flags & 0x10) ranges.push([0, c.f32(0x0c), c.f32(0x10)]);
  return {
    flags, node: flags & 0x2 ? c.i8(8) : null, atContext: (flags & 0x8) !== 0,
    offset: flags & 0x4 ? c.vec3(0x14) : [0, 0, 0],
    rgb: flags & 0x40 ? c.vec3(0x20) : [255, 255, 255],
    opacity: flags & 0x80 ? c.f32(0x2c) : 64,
    blend: flags & 0x100 ? c.u8(9) : 0x44,
    ranges, duration: c.f32(0x3c),
  };
}

/** A light's `(min, max)` range at `t` seconds: the keys linear, the last held (decomp 112110-112181). */
export function lightRange(light: Pick<ZAnimLight, 'ranges'>, t: number): [number, number] {
  const k = light.ranges;
  if (k.length === 0) return [0, 0];
  if (t <= k[0]![0]) return [k[0]![1], k[0]![2]];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i]![0]) {
      const a = k[i - 1]!, b = k[i]!, span = b[0] - a[0], f = span > 0 ? (t - a[0]) / span : 1;
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
  }
  const last = k[k.length - 1]!;
  return [last[1], last[2]];
}

/**
 * The light pass at one point (the VU1 handler at 0x23d8, research 89 §10): `L` the light minus the point, `n` the
 * surface normal; `h = max(L.n, 0)`, the falloff `f = 0.5 clamp((max - h) / (max - min))`, the gate `min(h, 1)`. The
 * pass's colour is `rgb f` and its alpha `opacity f gate`, over the spot's texel at `0.5 + (L.t, L.b) / max`.
 */
export function lightAt(L: Vec3, n: Vec3, range: [number, number]): { f: number; gate: number } {
  const h = Math.max(L[0] * n[0] + L[1] * n[1] + L[2] * n[2], 0);
  const [min, max] = range;
  const f = max > min ? 0.5 * Math.min(1, Math.max(0, (max - h) / (max - min))) : 0;
  return { f, gate: Math.min(h, 1) };
}

/** A sub-command of an `IF`/`ELSEIF`'s condition list, as far as the effects need one. */
export type EffectCondition =
  /** `RANDOM_WEIGHT` (tick `FUN_0025dcf0`, decomp 107832): true when `rand() / 2^31 <= p`, the f32 at +4. */
  | { kind: 'random'; p: number }
  /**
   * `RANGE_TEST` (tick `FUN_0025de90`, decomp 107880): the squared distance between two points -- a node's (+8 with flag
   * 1, +9 with flag 8), an offset, the camera's -- against the f32 at +0x24 (`rangeSquared`); flags 0x40-0x800 pick
   * the comparison.
   */
  | { kind: 'range'; flags: number; node: number; other: number; rangeSquared: number }
  /**
   * `VALVE` (61) as a test: the valve against the operand (`operation` 1 !=, 2 ==, 3 >, 4 <, 5 >=, 6 <=); `context`, the
   * animation's own valve (flag bit 0: a door's, research 92) rather than the one named.
   */
  | { kind: 'valve'; valve: string; operation: number; operand: number; context?: true }
  | { kind: 'other'; cmd: number };

/** The node numbers the engine resolves itself (`FUN_0026f4e0`, decomp 118145): the animation's instance, the caller's node. */
export const NODE_ROOT = -7, NODE_CALLER = -6;

/** One decoded command of an effect animation. Node indices are into the animation's `nodeRefs`, or `NODE_ROOT` / `NODE_CALLER`. */
export type EffectOp =
  | { op: 'if' | 'elseif'; conditions: EffectCondition[] }
  | { op: 'else' | 'endif' }
  /** `WAIT` (15; begin `FUN_0025ed50`): `frames` when flag 0x10 (the i32 at +8), else `seconds` (the f32 at +8); flag 0x20 a random range. */
  | { op: 'wait'; seconds: number; range: number; frames: number | null }
  /** `LOOP` (14; tick `FUN_0025ede0`): back to the sequence's start until `count` passes (flag 1; -1 forever) or `seconds` (flag 2). */
  | { op: 'loop'; count: number | null; seconds: number | null }
  /** `OBJECT_ACTIVE_STATE` (17; tick `FUN_00263aa0`): node (u16 +6) shown (the u16 at +4 is 1) or hidden. */
  | { op: 'active'; node: number; on: boolean }
  /**
   * `OBJECT_ROTATE_STATE` (19; tick `FUN_00263730`, decomp 111211) / `OBJECT_TRANSLATE_STATE` (18; `FUN_00263890`,
   * 111263): the node (+6) takes the reference node's (+7) world rotation / position when there is one; then flag 1
   * sets the euler angles / offset at +8, flag 2 adds them, flag 4 keeps the node's own.
   */
  | { op: 'rotate' | 'translate'; node: number; ref: number; flags: number; xyz: Vec3 }
  /**
   * `OBJECT_MOTION_FROM_TO` (22) as the flashes use it: a node's scale from `from` to `to` over `seconds` (research 89
   * §4). DOORS (web/docs/research/92-doors.md): with flag 0x40 the node's rotation, the quaternions (x, y, z, w) at +0x10
   * and +0x20 -- begin `FUN_0025fe70` (decomp 109034) takes the node's own rotation as the start unless flag 0x20 sets
   * +0x10; flag 1 makes +0x20 a turn after the start (`FUN_003070c0`); tick `FUN_0025f9b0` (108850) slerps by the time
   * over +0x34 (`FUN_00306ae0`) and sets the end when it is up.
   */
  | { op: 'fromTo'; node: number; flags: number; seconds: number; from: Vec3; to: Vec3; rotation?: { from: Quat4; to: Quat4 } }
  | { op: 'motion'; motion: ObjectMotion }
  | { op: 'particles'; source: ParticleSource }
  /** `SOUND` (30): the sound name (u16 +6, through the name table) at the node +16 (research 81 §6). */
  | { op: 'sound'; sound: string; node: number }
  /** `LIGHT` (32): a dynamic light (`ZAnimLight`). */
  | { op: 'light'; light: ZAnimLight }
  /** `CALL_ANIMATION` (45; begin `FUN_0025d5c0`): the animation named at +7, run at this one's place. */
  | { op: 'call'; anim: string }
  /** `STOP_SEQUENCE` (51): this animation's sequence named at +4 (a name index). */
  | { op: 'stopSequence'; sequence: string }
  /** `FAIL` (11): the animation stops. */
  | { op: 'fail' }
  /**
   * `WHILE` (39; tick `FUN_0025e630`, decomp 108131): with flag 1 (the byte at +4) it always goes on -- the ripples'
   * endless loop; `END_WHILE` (40; `FUN_0025e600`) jumps back to its `WHILE` and yields the tick.
   */
  | { op: 'while'; forever: boolean }
  /** `CALL_SEQUENCE` (50): starts this animation's sequence named at +4 (a name index) over from its top. */
  | { op: 'callSequence'; sequence: string }
  /** `STOP_ANIMATION` (46): stops the running animation named at +4 (a name index). */
  | { op: 'stopAnimation'; anim: string }
  /**
   * `PAUSE_ANIMATION` (47): pauses the animation named at +4 -- the torches' `loop_torch*` pause themselves, which
   * keeps them (and their particle sources) alive with nothing left to run.
   */
  | { op: 'pauseAnimation'; anim: string }
  | { op: 'endWhile' }
  /** `VALVE` (61; `FUN_00353fd0`, decomp 252128): the valve (a name index when flag 2) and an operation on it: 0x0b set, 0x0c add, 0x0d subtract; 1-6 the tests. */
  | { op: 'valve'; valve: string; operation: number; operand: number; context?: true }
  | { op: 'other'; cmd: number; name: string };

export interface EffectSequence {
  name: string;
  /** The `_zsequence` word: bits 1-7 `activation` (1 at the start; 2 the activation checks), bits 8-15 `state`. */
  activation: number;
  ops: EffectOp[];
}

/** An effect animation of `CZANIM`, decoded: what `play(name)` runs. */
export interface EffectProgram {
  name: string;
  /** `Anim_Params` byte 1: the node the animation is rooted at (index into `nodes`), 0 for none. */
  root: number;
  /** `Anim_Params` flags (`_zanim_anim_params`: activation 2 bits, network, scope, copy/instance bits). */
  flags: number;
  /** The node references' names (`nodeRefs`), 0 `NA`. */
  nodes: string[];
  sequences: EffectSequence[];
}

const NAME = (names: readonly string[], i: number): string => names[i] ?? `#${i}`;

/**
 * A `VALVE` command's fields (61; registered by `FUN_00354470`, decomp 252347; tick 0x353d00 evaluates
 * `FUN_00353fd0`, decomp 252128, on the payload): the valve reference (+4; flag bit 1: a name index -- `shell_eject`'s
 * is `bullet_ejecting`), the operand (+8), the operation (+12) and the flags (+13).
 */
function valveOf(c: CmdBytes, names: readonly string[]): { valve: string; operation: number; operand: number; context?: true } {
  const ref = c.u32(4), flags = c.u8(13);
  // DOORS (web/docs/research/92-doors.md): flag bit 0 takes the valve from the animation's context
  // (`FUN_002721c0(context, ref)`, decomp 252144-252150) -- the door's own, handed in by `FUN_002b44e0`.
  const context = (flags & 1) !== 0 ? { context: true as const } : {};
  return { valve: (flags & 2) !== 0 ? NAME(names, ref) : `#${ref}`, operation: c.u8(12), operand: c.i32(8), ...context };
}

function condition(c: CmdBytes, names: readonly string[]): EffectCondition {
  const cmd = c.u8(0);
  if (cmd === ZCMD.RANDOM_WEIGHT) return { kind: 'random', p: c.f32(4) };
  if (cmd === ZCMD.RANGE_TEST) return { kind: 'range', flags: c.u32(4), node: c.i8(8), other: c.i8(9), rangeSquared: c.f32(0x24) };
  if (cmd === ZCMD.VALVE) return { kind: 'valve', ...valveOf(c, names) };
  return { kind: 'other', cmd };
}

/** An `IF`'s conditions: a u32 count at +4, then that many sub-commands (each with its own header), then operators. */
function conditions(c: CmdBytes, names: readonly string[]): EffectCondition[] {
  const out: EffectCondition[] = [];
  let o = 8;
  while (o + 4 <= c.length) {
    const h = c.u32(o), size = h >>> 18;
    if (size < 4 || o + size > c.length) break;
    out.push(condition(new CmdBytes(c.bytes.subarray(o, o + size)), names));
    o += size;
  }
  return out;
}

/** One command's bytes to what it does; `names` is the animation's name table. */
export function decodeEffectOp(cmd: Pick<ZAnimCommand, 'set' | 'cmd' | 'bytes'>, names: readonly string[]): EffectOp {
  const c = new CmdBytes(cmd.bytes);
  const n = cmd.set === 0 ? cmd.cmd : -1;
  switch (n) {
    case ZCMD.IF: return { op: 'if', conditions: conditions(c, names) };
    case ZCMD.ELSEIF: return { op: 'elseif', conditions: conditions(c, names) };
    case ZCMD.ELSE: return { op: 'else' };
    case ZCMD.ENDIF: return { op: 'endif' };
    case ZCMD.WAIT: {
      const flags = c.u16(4);
      const frames = (flags & 0x10) !== 0 ? c.i32(8) : null;
      return { op: 'wait', seconds: frames === null ? c.f32(8) : 0, range: (flags & 0x20) !== 0 ? c.f32(12) : 0, frames };
    }
    case ZCMD.LOOP: {
      const flags = c.u32(4);
      return { op: 'loop', count: (flags & 1) !== 0 ? c.i32(8) : null, seconds: (flags & 1) === 0 && (flags & 2) !== 0 ? c.f32(8) : null };
    }
    case ZCMD.OBJECT_ACTIVE_STATE: return { op: 'active', node: c.i8(6), on: c.i16(4) === 1 };
    case ZCMD.OBJECT_ROTATE_STATE: return { op: 'rotate', node: c.i8(6), ref: c.i8(7), flags: c.u16(4), xyz: c.vec3(8) };
    case ZCMD.OBJECT_TRANSLATE_STATE: return { op: 'translate', node: c.i8(6), ref: c.i8(7), flags: c.u16(4), xyz: c.vec3(8) };
    case ZCMD.OBJECT_MOTION_FROM_TO:
      // The flashes' form (flags 0x300): +0x34 the time, +0x38 from, +0x44 to, +0x50 the rate -- which is (to - from) /
      // time on every one of them (research 89 §4), the check that the reading is right.
      return {
        op: 'fromTo', node: c.i8(6), flags: c.u16(4), seconds: c.f32(0x34), from: c.vec3(0x38), to: c.vec3(0x44),
        ...((c.u16(4) & 0x40) !== 0 ? { rotation: { from: c.quat(0x10), to: c.quat(0x20) } } : {}),
      };
    case ZCMD.OBJECT_MOTION: return { op: 'motion', motion: decodeObjectMotion(c, names) };
    case ZCMD.PARTICLE_SOURCE: return { op: 'particles', source: decodeParticleSource(c, names) };
    case ZCMD.SOUND: return { op: 'sound', sound: NAME(names, c.u16(6)), node: c.i8(16) };
    case ZCMD.LIGHT: return { op: 'light', light: decodeLight(c) };
    case ZCMD.CALL_ANIMATION: return { op: 'call', anim: NAME(names, c.u8(7)) };
    case ZCMD.STOP_SEQUENCE: return { op: 'stopSequence', sequence: NAME(names, c.u16(4)) };
    case ZCMD.WHILE: return { op: 'while', forever: (c.u8(4) & 1) !== 0 };
    case ZCMD.CALL_SEQUENCE: return { op: 'callSequence', sequence: NAME(names, c.u16(4)) };
    case ZCMD.STOP_ANIMATION: return { op: 'stopAnimation', anim: NAME(names, c.u16(4)) };
    case ZCMD.PAUSE_ANIMATION: return { op: 'pauseAnimation', anim: NAME(names, c.u16(4)) };
    case ZCMD.END_WHILE: return { op: 'endWhile' };
    case ZCMD.FAIL: return { op: 'fail' };
    case ZCMD.VALVE: return { op: 'valve', ...valveOf(c, names) };
    default: return { op: 'other', cmd: cmd.cmd, name: cmd.set === 0 ? ZANIM_COMMAND_NAMES[cmd.cmd] ?? `cmd ${cmd.cmd}` : `set ${cmd.set} cmd ${cmd.cmd}` };
  }
}

/** A zAnim animation to its effect program. */
export function decodeEffectProgram(anim: ZAnimAnimation): EffectProgram {
  return {
    name: anim.name, root: anim.params.rootNodeIndex, flags: anim.params.flags,
    nodes: anim.nodeRefs.map((r) => r.name),
    sequences: anim.sequences.map((s) => ({
      name: s.name, activation: (s.word >>> 1) & 0x7f,
      ops: s.commands.filter((c) => !(c.set === 0 && c.cmd === ZCMD.QUAD_ALIGN)).map((c) => decodeEffectOp(c, anim.names)),
    })),
  };
}

/** The animations a program calls, directly and through what those call (for loading what a muzzle effect needs). */
export function calledPrograms(programs: ReadonlyMap<string, EffectProgram>, name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return seen;
  seen.add(name);
  const p = programs.get(name);
  for (const s of p?.sequences ?? []) for (const o of s.ops) if (o.op === 'call') calledPrograms(programs, o.anim, seen);
  return seen;
}

/**
 * `decals.rdr`'s `DECAL_SETS` set `set`, every row: one material's bitmap and size range each (`BULLET_MARK_SMALL`:
 * 24 rows, `bullet_mark_stone.tif` on STONE, `bullet_mark_metal.tif` on METAL_THICK ...; research 89 §5). A row
 * without a texture or sizes is left out.
 */
export function decalSetRows(decals: RdrNode, set: string): DecalEntry[] {
  const sets = rdrGet(decals, 'DECAL_SETS');
  if (!Array.isArray(sets)) throw new Error('decals.rdr has no DECAL_SETS');
  const rows = sets.find((s): s is RdrNode[] => Array.isArray(s) && s.some((r) => rdrGet(r, 'SETNAME') === set));
  if (!rows) throw new Error(`decals.rdr has no decal set ${set}`);
  const out: DecalEntry[] = [];
  for (const row of rows) {
    const material = rdrGet(row, 'MATERIALNAME'), texture = rdrGet(row, 'TEXTURENAME');
    if (typeof material !== 'string' || typeof texture !== 'string') continue;
    const where = `decals.rdr ${set} ${material}`;
    out.push({ set, material, texture, minSize: rdrReal(row, 'MIN_SIZE', 1, where), maxSize: rdrReal(row, 'MAX_SIZE', 1, where) });
  }
  return out;
}

/**
 * Whether a weapon's round draws a tracer (research 89 §6): the tracer weapons are the SMGs (weapon ids 31-50), the
 * assault rifles (51-80), the machine guns (91-100), the heavy weapons (141-144) and the turrets (205-229)
 * (`FUN_003cb1a0`, decomp 320657), less the suppressed ones -- 16 Mark 23 SD, 33 HK5SD, 62 M4A1 SD, 67 552SD, 105 SR-25
 * SD (`FUN_003c5ac0`, 317147); and of those, every fourth round (`FUN_003cabe0`, 320545: the shooter's count, taken
 * before the round, `% 4 == 0`). `round` counts from 1, the first round fired.
 */
export function tracerRound(weaponId: number, round: number): boolean {
  const eligible = (weaponId >= 31 && weaponId <= 50) || (weaponId >= 51 && weaponId <= 80) || (weaponId >= 91 && weaponId <= 100)
    || (weaponId >= 141 && weaponId <= 144) || (weaponId >= 205 && weaponId <= 229);
  if (!eligible || TRACERLESS.has(weaponId)) return false;
  return round % 4 === 0;
}

/** The suppressed weapons `FUN_003c5ac0` excludes from the tracers. */
export const TRACERLESS: ReadonlySet<number> = new Set([16, 33, 62, 67, 105]);
