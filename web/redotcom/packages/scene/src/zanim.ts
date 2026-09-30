import { Reader, type Zar, type ZarKey } from '@s2u/archive';

/**
 * The zAnim command archives -- `RUN/CZANIM.ZAR` (the common set), each map's `MZANIM.ZAR` (its `mission` set) and
 * `RUN/LDZANIM.ZAR` (the loading screen's) -- read the way `CZAnimMain::LoadZAR` 0x267ab0, `CZAnimNameTable::Load`
 * 0x268c00, `CZAnimSet::Load` 0x26bc50 and `CZAnim::Load` 0x26d370 walk them (the names are recomp/socom2_names.csv's;
 * their bodies are not in the tree). The structures are reCOM's (`zAnim/zanim.h`), and web/redotcom/docs/research/77 §9
 * checks every field read here on all 66 archives of the 22 maps: every count equals its list, every animation's
 * name index names its own key, every command stream tiles into sequences and commands to the byte.
 *
 * These are the engine's effect, sound, camera and interface scripts, not the body's motions: no name table of any
 * of the 66 carries a clip of `MOTION_S.ZAR` or `MOTION_P.ZAR`, and the SoftImage scripts some maps carry are the
 * helicopter and F-18 flight paths (77 §9).
 */

/** `_zanim_main_params` (reCOM zAnim/zanim.h:357-364), `Anim_Main_Params`: 72, -98, 0, 0 on all 66 archives. */
export interface ZAnimMainParams {
  version: number;
  /** -98 on every archive: reCOM's `Open` default is -9.8 (anim_main.cpp:24), in metres. */
  gravity: number;
  /** `m_search_external_nodes` in bit 0 (zanim.h:361). */
  flags: number;
  userActionAnimIndex: number;
}

/** A `SoftImage_Script`'s `Script_Params`, 24 bytes (reCOM's `_zanim_si_script`, zanim.h:396-404, plus a frame time). */
export interface ZAnimSiScript {
  /** The `.anm` path and the object it drives, through the set's name table. */
  path: string;
  object: string;
  /** The word at +4: 0x19 or 0x11 on the 30 scripts; reCOM puts `spline_interp` here. Not decoded. */
  word: number;
  /** Seconds per frame, the f32 at +8: 1/30, 1/20, 1/15, 1/40 on the 30. */
  frameTime: number;
  frameCount: number;
  /** The `Script_Data` key's length, which it must equal. */
  dataSize: number;
}

/** `_zanim_anim_params` (zanim.h:366-394), `Anim_Params`: 24 bytes. */
export interface ZAnimParams {
  /** Into the animation's own name table: it names the animation's key on all 9,912 (77 §9). */
  nameIndex: number;
  rootNodeIndex: number;
  paused: number;
  state: number;
  /** reCOM's bitfield: activation (2), network (1), node search scope (2), the copy/instance bits, max copies (6). */
  flags: number;
  timer: number;
  priority: number;
  /** Damage, activation, execution, cleanup: byte offsets into `Seq_Data`, each a sequence's start. */
  seqOffsets: [number, number, number, number];
}

/** A `Node_Ref_List` record, 8 bytes: `_zanim_node_ref`'s bitfield (zanim.h:417-435), then a word. */
export interface ZAnimNodeRef {
  /** Bits 0-7: an index into the same list (below its length on all 11,418). */
  parent: number;
  /** Bits 8-18, resolved through the animation's name table. */
  name: string;
  /** Bits 19-21. */
  search: number;
  word: number;
  /** The second word: 0 on 11,154 of 11,418; not decoded. */
  flags: number;
}

/** One command: `_zanim_cmd_hdr` (zanim.h:342-348), its payload not decoded. */
export interface ZAnimCommand {
  /** Byte offset in `Seq_Data`. */
  offset: number;
  /** The 16-bit data type: `cmd` in the low byte, the registered command `set` in the high (`zanim_cmd_index`). */
  type: number;
  set: number;
  cmd: number;
  quadAlign: boolean;
  timeless: boolean;
  /** Bytes, the header included (bits 18-31). */
  size: number;
  /**
   * The command's own bytes, its header included: a view into the animation's `Seq_Data`, not a copy. The effect
   * commands' payloads are decoded from it (`./effects`, web/redotcom/docs/research/89).
   */
  bytes: Uint8Array;
}

/** A sequence: a 28-byte `_zsequence` head (zanim.h:463-481) and its commands. */
export interface ZAnimSequence {
  offset: number;
  /** Through the animation's name table: `NA` for most, `fire_rotate`, `light_at_muzzle` ... for the named. */
  name: string;
  /** The second word (paused, activation, state, ...): 0x102 or 0x104 on most. */
  word: number;
  /** Bytes, the head included. */
  size: number;
  commands: ZAnimCommand[];
}

/** One animation of a set's `Animation_List`. */
export interface ZAnimAnimation {
  name: string;
  params: ZAnimParams;
  /** Its `Name_Index_Table` resolved through the set's name table: index 0 is `NA`. */
  names: string[];
  nodeRefs: ZAnimNodeRef[];
  /** The `Anim_Health` key's length (24 where present), or 0. Not decoded. */
  health: number;
  sequences: ZAnimSequence[];
}

/** One set of `Anim_Sets`. */
export interface ZAnimSet {
  name: string;
  names: string[];
  rdrPaths: string[];
  siScripts: ZAnimSiScript[];
  anims: ZAnimAnimation[];
}

/** A whole zAnim archive. */
export interface ZAnimArchive {
  main: ZAnimMainParams;
  /** The top-level `Name_Table`: empty on all 66. */
  names: string[];
  sets: ZAnimSet[];
}

const SEQ_HEAD = 28, ANIM_PARAMS = 24, SI_PARAMS = 24, NODE_REF = 8;

/** Reads a zAnim archive (77 §9); throws where a count, a name, a size or a stream disagrees. */
export function parseAnimSets(zar: Zar): ZAnimArchive {
  const need = (parent: ZarKey, name: string, path: string): ZarKey => {
    const k = zar.child(parent, name);
    if (!k) throw new Error(`zAnim ${path}: no ${name} key`);
    return k;
  };
  const u32Of = (parent: ZarKey, name: string, path: string): number => {
    const k = need(parent, name, path);
    if (k.size !== 4) throw new Error(`zAnim ${path}/${name}: ${k.size} bytes, expected 4`);
    return new Reader(zar.data(k)).u32(0);
  };
  /** A `*_Count` key and the list it counts: the list's children are the names (77 §9). */
  const countedNames = (parent: ZarKey, count: string, listName: string, path: string): string[] => {
    const n = u32Of(parent, count, path);
    const listKey = zar.child(parent, listName);
    const names = (listKey?.children ?? []).map((k) => k.name);
    if (names.length !== n) throw new Error(`zAnim ${path}: ${count} ${n} but ${names.length} in ${listName}`);
    return names;
  };

  const mainKey = need(zar.root, 'Anim_Main_Params', '');
  if (mainKey.size !== 16) throw new Error(`zAnim Anim_Main_Params: ${mainKey.size} bytes, expected 16`);
  const m = new Reader(zar.data(mainKey));
  const main: ZAnimMainParams = { version: m.u32(0), gravity: m.f32(4), flags: m.u32(8), userActionAnimIndex: m.i32(12) };
  const names = countedNames(zar.root, 'Name_Table_Count', 'Name_Table', '');
  const setsKey = need(zar.root, 'Anim_Sets', '');
  const setCount = u32Of(zar.root, 'Anim_Set_Count', '');
  if (setsKey.children.length !== setCount) throw new Error(`zAnim: Anim_Set_Count ${setCount} but ${setsKey.children.length} sets`);

  const sets = setsKey.children.map((setKey): ZAnimSet => {
    const path = setKey.name;
    const setNames = countedNames(setKey, 'Name_Table_Count', 'Name_Table', path);
    const nameAt = (i: number, what: string): string => {
      const s = setNames[i];
      if (s === undefined) throw new Error(`zAnim ${path}: ${what} names index ${i} of ${setNames.length}`);
      return s;
    };
    // `RdrPath_*` is absent from the loading screen's empty `Anim_Set`s (77 §9).
    const rdrPaths = zar.child(setKey, 'RdrPath_Count') ? countedNames(setKey, 'RdrPath_Count', 'RdrPath_List', path) : [];

    const siCount = u32Of(setKey, 'SoftImage_Script_Count', path);
    const siKeys = zar.child(setKey, 'SoftImage_Script_List')?.children ?? [];
    if (siKeys.length !== siCount) throw new Error(`zAnim ${path}: SoftImage_Script_Count ${siCount} but ${siKeys.length} scripts`);
    const siScripts = siKeys.map((k, i): ZAnimSiScript => {
      const p = need(k, 'Script_Params', `${path}/script ${i}`);
      if (p.size !== SI_PARAMS) throw new Error(`zAnim ${path}/script ${i}: Script_Params ${p.size} bytes`);
      const r = new Reader(zar.data(p));
      const dataSize = r.i32(16), data = zar.child(k, 'Script_Data');
      if ((data?.size ?? 0) !== dataSize) throw new Error(`zAnim ${path}/script ${i}: size ${dataSize} but Script_Data holds ${data?.size ?? 0}`);
      return { path: nameAt(r.u16(0), 'a script path'), object: nameAt(r.u16(2), 'a script object'), word: r.u32(4), frameTime: r.f32(8), frameCount: r.i32(12), dataSize };
    });

    const animCount = u32Of(setKey, 'Animation_List_Count', path);
    const animKeys = zar.child(setKey, 'Animation_List')?.children ?? [];
    if (animKeys.length !== animCount) throw new Error(`zAnim ${path}: Animation_List_Count ${animCount} but ${animKeys.length} animations`);
    const anims = animKeys.map((a) => readAnimation(zar, a, `${path}/${a.name}`, nameAt, need, u32Of));
    return { name: setKey.name, names: setNames, rdrPaths, siScripts, anims };
  });
  return { main, names, sets };
}

function readAnimation(
  zar: Zar, key: ZarKey, path: string, nameAt: (i: number, what: string) => string,
  need: (parent: ZarKey, name: string, path: string) => ZarKey, u32Of: (parent: ZarKey, name: string, path: string) => number,
): ZAnimAnimation {
  const pk = need(key, 'Anim_Params', path);
  if (pk.size !== ANIM_PARAMS) throw new Error(`zAnim ${path}: Anim_Params ${pk.size} bytes, expected ${ANIM_PARAMS}`);
  const p = new Reader(zar.data(pk));
  const params: ZAnimParams = {
    nameIndex: p.u8(0), rootNodeIndex: p.u8(1), paused: p.u8(2), state: p.u8(3), flags: p.u32(4),
    timer: p.f32(8), priority: p.f32(12), seqOffsets: [p.u16(16), p.u16(18), p.u16(20), p.u16(22)],
  };

  // The animation's own name table: u16 indices into the set's (index 0 `NA`).
  const count = u32Of(key, 'Name_Index_Table_Count', path);
  const tk = need(key, 'Name_Index_Table', path);
  if (tk.size !== 2 * count) throw new Error(`zAnim ${path}: Name_Index_Table_Count ${count} but ${tk.size} bytes`);
  const t = new Reader(zar.data(tk));
  const names = Array.from({ length: count }, (_, i) => nameAt(t.u16(2 * i), `${key.name}'s name table`));
  const local = (i: number, what: string): string => {
    const s = names[i];
    if (s === undefined) throw new Error(`zAnim ${path}: ${what} ${i} outside its ${names.length}-name table`);
    return s;
  };
  if (local(params.nameIndex, 'name index') !== key.name) throw new Error(`zAnim ${path}: Anim_Params names itself ${names[params.nameIndex]}`);

  const refCount = u32Of(key, 'Node_Ref_Count', path);
  const rk = zar.child(key, 'Node_Ref_List');
  if ((rk?.size ?? 0) !== NODE_REF * refCount) throw new Error(`zAnim ${path}: Node_Ref_Count ${refCount} but ${rk?.size ?? 0} bytes of references`);
  const rr = rk ? new Reader(zar.data(rk)) : null;
  const nodeRefs = Array.from({ length: refCount }, (_, i): ZAnimNodeRef => {
    const word = rr!.u32(NODE_REF * i);
    const parent = word & 0xff;
    if (parent >= refCount) throw new Error(`zAnim ${path}: node reference ${i}'s parent ${parent} of ${refCount}`);
    return { parent, name: local((word >>> 8) & 0x7ff, 'node reference name'), search: (word >>> 19) & 7, word, flags: rr!.u32(NODE_REF * i + 4) };
  });

  const size = u32Of(key, 'Seq_Data_Size', path);
  const sk = zar.child(key, 'Seq_Data');
  if ((sk?.size ?? 0) !== size) throw new Error(`zAnim ${path}: Seq_Data_Size ${size} but ${sk?.size ?? 0} bytes`);
  const sequences = sk ? readSequences(new Reader(zar.data(sk)), path, local) : [];
  const starts = new Set(sequences.map((s) => s.offset));
  for (const o of params.seqOffsets) if (size && !starts.has(o)) throw new Error(`zAnim ${path}: a sequence offset ${o} starts no sequence`);
  return { name: key.name, params, names, nodeRefs, health: zar.child(key, 'Anim_Health')?.size ?? 0, sequences };
}

/** `Seq_Data`: sequences back to back, each a 28-byte head whose size covers its commands (77 §9). */
function readSequences(r: Reader, path: string, local: (i: number, what: string) => string): ZAnimSequence[] {
  const out: ZAnimSequence[] = [];
  let o = 0;
  while (o < r.length) {
    if (o + SEQ_HEAD > r.length) throw new Error(`zAnim ${path}: sequence at ${o} has no room for its head`);
    const size = r.i32(o + 12);
    if (size < SEQ_HEAD || o + size > r.length) throw new Error(`zAnim ${path}: sequence at ${o} claims ${size} bytes of ${r.length - o}`);
    const commands: ZAnimCommand[] = [];
    let c = o + SEQ_HEAD;
    while (c < o + size) {
      const h = r.u32(c), bytes = h >>> 18;
      if (bytes < 4 || c + bytes > o + size) throw new Error(`zAnim ${path}: command at ${c} claims ${bytes} bytes`);
      commands.push({
        offset: c, type: h & 0xffff, set: (h >>> 8) & 0xff, cmd: h & 0xff, quadAlign: (h & 1 << 16) !== 0, timeless: (h & 1 << 17) !== 0,
        size: bytes, bytes: r.bytes.subarray(c, c + bytes),
      });
      c += bytes;
    }
    out.push({ offset: o, name: local(r.u16(o), 'sequence name'), word: r.u32(o + 4), size, commands });
    o += size;
  }
  return out;
}
