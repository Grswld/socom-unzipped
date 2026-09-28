/**
 * The fire point: `GetPutativeFirePointW__10CZSealBodyFbbR6CPnt3D` (0x57fa70-0x57fce0, 624 bytes;
 * `recomp/socom2_names.csv`, named by the call graph), ported from the recompiler's body of it, `decomp
 * CZSealBody_GetPutativeFirePointW` 0x57fa70 (the owner's handoff, reference only; the file is `<name>_<address>.cpp`,
 * cited with a space because the joined name reads to the leak check as a key). Line numbers `:n` below are that
 * file's. web/docs/research/79 §3 has the walk-through; the short version:
 *
 * - **a1 true** (`:51` falls through): pick a stance code from the list at `+0x1c0`, and from it, the actor state, the
 *   body's velocity and `m_item`, one of ten constant offsets at 0x65d038..0x65d0c8 (or the zero point at 0x3f64c0);
 *   carry it as `(x, y, z, 1)` through the matrix of the actor's node, `*(+0x28)` (`FUN_003085c0(node, &offset, out,
 *   1)`, `:632-644` -- the row-vector point transform research 21 §7.7 and 24 §1.1 read).
 * - **a1 false** (`:51` branches to `:663`): the point cached at `+0x14b0` when the word at `+0x14bc` is non-zero, else
 *   the zero point; plus the actor's position at `+0x1c` (`FUN_00309240(out, this + 0x1c, out)`, `:740-752`).
 *
 * **What is not in the body: the ten offsets' values.** They are data in the ELF's `.data` (16 bytes apart), not code,
 * and the handoff carries no image of it -- so `firePoint` takes them as a table (`FireOffsets`) and the viewer fills
 * the table with a named placeholder (`viewer/src/shot.ts`). The zero point is taken to be (0, 0, 0): `Tick_0` resets
 * `m_velM` from the same address (decomp `CZSealBody_Tick_0_0x57a330` :7201-7209, :7920-7952), and `:625-628` pass
 * its address where the other branches pass an offset's.
 *
 * The field names are research 50 §4a's where it has one (`+0x1c` the position, `+0x28` `m_node`, `+0x2c` `m_velM`,
 * `+0xf79` `m_item`); `+0x174` is research 21's actor state; the rest are named by their offsets.
 */

/** A point or a direction in game units: `CPnt3D`. */
export type Pnt3D = [number, number, number];

/**
 * Which of the eleven constants the body reads (`FIRE_SLOT_ADDRESS`): the three stance codes in two rows picked by
 * a2, the two of actor state 3, the two of moving along z, and the zero point for any other stance code.
 */
export type FireSlot =
  | 'code0' | 'code1' | 'code2'
  | 'code0Alt' | 'code1Alt' | 'code2Alt'
  | 'state3' | 'state3Unset'
  | 'movingItem1' | 'moving'
  | 'zero';

/** Where each slot's `CPnt3D` sits in the image: `lui 0x66` then `addiu -0x2fc8 ..`, or `0x3f << 16 | 0x64c0`. */
export const FIRE_SLOT_ADDRESS: Readonly<Record<FireSlot, number>> = {
  code0: 0x65d038,        // :500  code 0, a2 false
  code1: 0x65d048,        // :556  code 1, a2 false
  code2: 0x65d058,        // :612  code 2, a2 false
  code0Alt: 0x65d068,     // :480  code 0, a2 true
  code1Alt: 0x65d078,     // :536  code 1, a2 true
  code2Alt: 0x65d088,     // :592  code 2, a2 true
  state3: 0x65d098,       // :271  code 0, actor state 3, +0x375 != -1
  state3Unset: 0x65d0a8,  // :251  code 0, actor state 3, +0x375 == -1
  movingItem1: 0x65d0b8,  // :424  code 0, moving along z, m_item == 1
  moving: 0x65d0c8,       // :444  code 0, moving along z, m_item != 1
  zero: 0x3f64c0,         // :625-628 any other stance code
};

/** The ten offsets, model space of the actor's node; the zero point is not in the table. */
export type FireOffsets = Record<Exclude<FireSlot, 'zero'>, Pnt3D>;

/** What the body reads of the `CZSealBody`, by offset, and its two `bool` arguments. */
export interface FirePointState {
  /** a1 (`:51`, `beqz $a1`): true reads the stance table through the node matrix, false the cached point. */
  fromStanceTable: boolean;
  /** a2, kept in `$s1` (`:48`): picks the second row of the stance table for codes 0-2 (`:457-617`). */
  alternate: boolean;
  /** `+0x1c..+0x24`: the actor's position (research 50 §4a; 738 uses). */
  position: Pnt3D;
  /** `*(+0x28)`, `m_node`'s matrix: 16 floats, row-major, row-vector, the translation in the fourth row. */
  nodeMatrix: ArrayLike<number>;
  /** `+0x2c..+0x34`, `m_velM`: the velocity in the actor's own frame (research 50 §4a). */
  velM: Pnt3D;
  /** `(short) +0x174`: the actor state (research 21; 1 through walking and standing, research 25). */
  actorState: number;
  /** `(signed char) +0x375`, tested against -1 (`:222-228`). */
  byte375: number;
  /** `(unsigned char) +0xf79`, `m_item` (research 50 §4a), tested against 1 (`:395-401`). */
  item: number;
  /** The list at `+0x1c0`, entries 0 to `*(+0x1c8)`: each entry's byte at `+0x2b`, the last the top. */
  stanceCodes: readonly number[];
  /** `+0x14b0..+0x14b8`, or null when the word at `+0x14bc` is zero (`:664-673`). */
  cachedPoint: Pnt3D | null;
}

/** The code the body skips while it walks down the list (`:89`, `:105`). */
const SKIPPED_CODE = 3;
/** `lui 0x43c8`: 400.0, the square of the 20 units a second a body must beat to be moving (`:284`, `:314`). */
const MOVING_SPEED_SQ = 400;
/** `lui 0x3f00`: 0.5, the most `|x / z|` of `m_velM` may be for the motion to count as along z (`:373-391`). */
const ALONG_Z = 0.5;
/** The actor state that takes its own pair of offsets (`:209-212`). */
const STATE_3 = 3;
/** The zero point at 0x3f64c0 (see the file's comment). */
const ZERO: Pnt3D = [0, 0, 0];

/** f32 as the EE's `mul.s`/`madd.s`/`div.s` round, so a speed at the threshold compares as the game compares it. */
const f = Math.fround;

/**
 * The stance code (`:67-153`): from the top of the list at `+0x1c0` down, the first entry whose byte at `+0x2b` is
 * not 3; 0 when the list is empty (`bltz` on `*(+0x1c8)`, `:70-82`) or holds nothing but 3 (`:126-149`).
 */
export function stanceCode(codes: readonly number[]): number {
  for (let i = codes.length - 1; i >= 0; i--) {                 // :93-138, index *(+0x1c8) down to 0
    const code = codes[i]! & 0xff;                              // :102 lbu 0x2b
    if (code !== SKIPPED_CODE) return code;                     // :105 beq v1, 3 -> :126 next; else :115 b :152
  }
  return 0;                                                     // :145 daddu v1, zero, zero
}

/** Which constant the body reads (`:153-628`); `fromStanceTable` is not consulted, the caller does that. */
export function fireSlot(s: FirePointState): FireSlot {
  const code = stanceCode(s.stanceCodes);                       // :153 andi 0xff
  if (code === 2) return s.alternate ? 'code2Alt' : 'code2';    // :159 beq 2 -> :568
  if (code === 1) return s.alternate ? 'code1Alt' : 'code1';    // :175 beq 1 -> :512
  if (code !== 0) return 'zero';                                // :185-201 bnez -> :624
  if ((s.actorState << 16 >> 16) === STATE_3) {                 // :206-218 lh 0x174, bne 3 -> :283
    return (s.byte375 << 24 >> 24) === -1 ? 'state3Unset' : 'state3';   // :222-276 lb 0x375, bne -1
  }
  const [x, y, z] = s.velM;                                     // :287-293 m_velM
  const speedSq = f(f(f(y * y) + f(x * x)) + f(z * z));         // :302-311 mul.s, mul.s, adda.s, madd.s
  if (speedSq > MOVING_SPEED_SQ && z !== 0                      // :314-345 c.le.s 400, c.eq.s z 0
    && Math.abs(f(x / z)) < ALONG_Z) {                          // :355-391 div.s, fabsf, c.lt.s 0.5
    return (s.item & 0xff) === 1 ? 'movingItem1' : 'moving';    // :395-449 lbu 0xf79, bne 1
  }
  return s.alternate ? 'code0Alt' : 'code0';                    // :456-505 beqz s1
}

/** `FUN_003085c0` with a count of 1: `(x, y, z, 1)` through a row-major row-vector matrix (research 21 §7.7). */
function throughMatrix(m: ArrayLike<number>, [x, y, z]: Pnt3D): Pnt3D {
  return [
    x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
    x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
    x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
  ];
}

/**
 * The point `GetPutativeFirePointW` writes to its `CPnt3D&`, world space. `offsets` supplies the ten constants of the
 * stance table the image holds and the handoff does not (see the file's comment).
 */
export function firePoint(s: FirePointState, offsets: FireOffsets): Pnt3D {
  if (!s.fromStanceTable) {                                     // :51 beqz a1 -> :663
    const cached = s.cachedPoint ?? ZERO;                       // :664-733 +0x14bc ? +0x14b0.. : 0x3f64c0
    return [cached[0] + s.position[0], cached[1] + s.position[1], cached[2] + s.position[2]];   // :740-752
  }
  const slot = fireSlot(s);
  return throughMatrix(s.nodeMatrix, slot === 'zero' ? ZERO : offsets[slot]);            // :632-644
}
