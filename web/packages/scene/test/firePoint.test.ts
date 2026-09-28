import { describe, expect, it } from 'vitest';
import {
  FIRE_SLOT_ADDRESS, fireSlot, firePoint, stanceCode,
  type FireOffsets, type FirePointState, type Pnt3D,
} from '../src/index';

/**
 * `GetPutativeFirePointW__10CZSealBodyFbbR6CPnt3D` (0x57fa70) ported (web/docs/research/79 §3). Every expected value
 * below is worked by hand from the body's arithmetic: the branch it takes (decomp line numbers in each case), the
 * offset it indexes, then `FUN_003085c0`'s `(x, y, z, 1) x M` or `FUN_00309240`'s add.
 */

/** A turned node: local x along world -z, y up, local z along world +x, translated to (100, 5, -20). */
const TURNED = Float32Array.from([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 100, 5, -20, 1]);

/** Ten distinct offsets, one per slot, so the slot a case lands on is legible from the answer. */
const OFFSETS: FireOffsets = {
  code0: [1, 2, 3], code1: [4, 5, 6], code2: [7, 8, 9],
  code0Alt: [10, 11, 12], code1Alt: [13, 14, 15], code2Alt: [16, 17, 18],
  state3: [19, 20, 21], state3Unset: [22, 23, 24],
  movingItem1: [25, 26, 27], moving: [28, 29, 30],
};

/** Standing still on the node above, the stance list empty, the table path. */
const state = (over: Partial<FirePointState> = {}): FirePointState => ({
  fromStanceTable: true, alternate: false, position: [100, 5, -20], nodeMatrix: TURNED, velM: [0, 0, 0],
  actorState: 1, byte375: -1, item: 0, stanceCodes: [], cachedPoint: null, ...over,
});

/** `(x, y, z, 1) x TURNED`: x feeds world -z, y world y, z world +x, then the translation row. */
const throughTurned = ([x, y, z]: Pnt3D): Pnt3D => [z + 100, y + 5, -x - 20];

describe('GetPutativeFirePointW: the stance code (decomp :67-153, the list at +0x1c0)', () => {
  it('is 0 for an empty list: *(+0x1c8) < 0 takes the bltz to :145 and zeroes v1', () => {
    expect(stanceCode([])).toBe(0);
  });

  it('skips code 3 from the top down (:105 beq to :126) and returns the first other code', () => {
    expect(stanceCode([1, 3, 3])).toBe(1);
    expect(stanceCode([2, 1, 3])).toBe(1);
    expect(stanceCode([0, 2])).toBe(2);
  });

  it('is 0 when every entry is 3: the loop runs out through :129 and falls into :145', () => {
    expect(stanceCode([3, 3, 3])).toBe(0);
  });

  it('compares the byte as the lbu read it (:102): 0xff is not 3, so it is the code', () => {
    expect(stanceCode([3, 0xff, 3])).toBe(0xff);
  });
});

describe('GetPutativeFirePointW: the slot (decomp :153-628)', () => {
  it('codes 0, 1 and 2 pick one of two rows of three by a2 (:457-617)', () => {
    expect(fireSlot(state())).toBe('code0');
    expect(fireSlot(state({ stanceCodes: [1] }))).toBe('code1');
    expect(fireSlot(state({ stanceCodes: [2] }))).toBe('code2');
    expect(fireSlot(state({ alternate: true }))).toBe('code0Alt');
    expect(fireSlot(state({ stanceCodes: [1], alternate: true }))).toBe('code1Alt');
    expect(fireSlot(state({ stanceCodes: [2], alternate: true }))).toBe('code2Alt');
  });

  it('any other code takes the zero point at 0x3f64c0 (:195-201, :624-628)', () => {
    expect(fireSlot(state({ stanceCodes: [4] }))).toBe('zero');
    expect(fireSlot(state({ stanceCodes: [0xff], alternate: true }))).toBe('zero');
  });

  it('code 0 in actor state 3 splits on the byte at +0x375 alone, a2 aside (:206-276)', () => {
    expect(fireSlot(state({ actorState: 3, byte375: -1 }))).toBe('state3Unset');
    expect(fireSlot(state({ actorState: 3, byte375: 0 }))).toBe('state3');
    expect(fireSlot(state({ actorState: 3, byte375: 5, alternate: true }))).toBe('state3');
  });

  it('code 0 moving faster than 20 mostly along z splits on m_item == 1 (:284-449)', () => {
    expect(fireSlot(state({ velM: [0, 0, 25] }))).toBe('moving');
    expect(fireSlot(state({ velM: [0, 0, 25], item: 1 }))).toBe('movingItem1');
    expect(fireSlot(state({ velM: [5, 0, -25] }))).toBe('moving');         // |5 / -25| = 0.2: backwards counts
    expect(fireSlot(state({ velM: [5, 0, -25], alternate: true }))).toBe('moving');
  });

  it('is not moving at exactly 20 (c.le.s |v|^2 <= 400, :314-323), with no z (:336-345), or at |x/z| = 0.5 (:382-391)', () => {
    expect(fireSlot(state({ velM: [0, 0, 20] }))).toBe('code0');           // 400 <= 400: the static row
    expect(fireSlot(state({ velM: [25, 0, 0] }))).toBe('code0');           // z == 0
    expect(fireSlot(state({ velM: [0, 25, 0] }))).toBe('code0');           // all of it vertical: z == 0
    expect(fireSlot(state({ velM: [12, 0, 24], item: 1 }))).toBe('code0'); // 144 + 576 > 400, but 0.5 is not < 0.5
    expect(fireSlot(state({ velM: [0, 0, 25], alternate: true, stanceCodes: [1] }))).toBe('code1Alt');   // only code 0 asks
  });

  it('tests actor state 3 before the movement (:206-218 precede :284)', () => {
    expect(fireSlot(state({ actorState: 3, byte375: -1, velM: [0, 0, 30], item: 1 }))).toBe('state3Unset');
  });

  it('names the address each slot reads, 0x65d038 to 0x65d0c8 in steps of 16', () => {
    expect(FIRE_SLOT_ADDRESS).toEqual({
      code0: 0x65d038, code1: 0x65d048, code2: 0x65d058, code0Alt: 0x65d068, code1Alt: 0x65d078, code2Alt: 0x65d088,
      state3: 0x65d098, state3Unset: 0x65d0a8, movingItem1: 0x65d0b8, moving: 0x65d0c8, zero: 0x3f64c0,
    });
  });
});

describe('GetPutativeFirePointW: the point', () => {
  it('a1 true: the slot offset as (x, y, z, 1) through the node matrix (FUN_003085c0, :632-644)', () => {
    expect(firePoint(state(), OFFSETS)).toEqual(throughTurned([1, 2, 3]));             // (103, 7, -21)
    expect(firePoint(state(), OFFSETS)).toEqual([103, 7, -21]);
    expect(firePoint(state({ stanceCodes: [1, 3], alternate: true }), OFFSETS)).toEqual(throughTurned([13, 14, 15]));
    expect(firePoint(state({ velM: [0, 0, 25], item: 1 }), OFFSETS)).toEqual(throughTurned([25, 26, 27]));
  });

  it('a1 true with the zero point: the node matrix\'s translation row', () => {
    expect(firePoint(state({ stanceCodes: [7] }), OFFSETS)).toEqual([100, 5, -20]);
  });

  it('a1 false: the cached point at +0x14b0 plus the position (FUN_00309240, :663-752)', () => {
    const cached = state({ fromStanceTable: false, position: [10, 20, 30], cachedPoint: [1, 2, 3] });
    expect(firePoint(cached, OFFSETS)).toEqual([11, 22, 33]);
  });

  it('a1 false with no cached point (+0x14bc == 0): the zero point plus the position (:708-733)', () => {
    const none = state({ fromStanceTable: false, position: [10, 20, 30], cachedPoint: null, stanceCodes: [1], velM: [0, 0, 99] });
    expect(firePoint(none, OFFSETS)).toEqual([10, 20, 30]);
  });

  it('a1 false ignores the node matrix, the stance, the movement and a2 altogether', () => {
    const a = state({ fromStanceTable: false, position: [1, 1, 1], cachedPoint: [2, 0, 0] });
    const b = { ...a, nodeMatrix: Float32Array.from([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 9, 9, 9, 1]), alternate: true, stanceCodes: [2], velM: [0, 0, 50] as Pnt3D };
    expect(firePoint(a, OFFSETS)).toEqual([3, 1, 1]);
    expect(firePoint(b, OFFSETS)).toEqual([3, 1, 1]);
  });
});
