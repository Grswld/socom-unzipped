/**
 * The yaw's one arithmetic, for the viewer and the server alike (web research 86 section 3.8).
 *
 * SOCOM II keeps a facing as the actor's rotation -- a quaternion (`piVar10[0x14..0x17]` in `FUN_005b2d20`, decomp
 * 468642-468646) and its matrix -- never as an angle, so a facing has no winding and a turn between two facings is found
 * by vectors: `FUN_005b2d20` (468637-468686) brings the facing to reach into the actor's frame, takes `acos` of its dot
 * with the frame's forward (0..pi) and its side from their cross product's y (`FUN_001bfc78`; `fStack_ec < 0` negates
 * it). The viewer carries the facing as degrees (`Pose.yaw`); these two functions are what keeps it equivalent:
 *
 * - `wrapYaw` is the canonical form a yaw is stored in: [0, 360), the range the wire reads a yaw back in (`net/codec`
 *   `qYaw`/`dqYaw`, u16 per turn), so a stored yaw, the command's and the snapshot's are one number;
 * - `shortTurn` is the game's turn between two facings: the short way, signed, whatever either's winding.
 *
 * Nothing else in the viewer or the server may wrap or difference a yaw by hand.
 */

/** A yaw, degrees, in the canonical [0, 360): any winding of the same facing gives the same number. */
export function wrapYaw(degrees: number): number {
  const d = ((degrees % 360) + 360) % 360;
  return d >= 360 ? 0 : d;                                      // a -1e-14 rounds to 360 on the + 360
}

/** `wrapYaw` in radians: [0, 2 pi) (the page camera's own store, `camera.ts`). */
export function wrapYawRad(radians: number): number {
  const full = 2 * Math.PI;
  const r = ((radians % full) + full) % full;
  return r >= full ? 0 : r;
}

/**
 * The signed short turn from yaw `from` to yaw `to`, degrees in [-180, 180), whatever either's winding: `FUN_005b2d20`'s
 * turn (decomp 468637-468686), `acos` of the facings' dot for its size and the cross product's y for its side, so
 * always the short way. The hand-rolled `((to - from + 540) % 360) - 180` it replaces came out at -180 or under for
 * `to - from` under -540 (JavaScript's `%` keeps the dividend's sign): a SEAL whose look had gone twice round spun the
 * long way to a ledge (research 86 section 3.8). The exact half turn, where the game's cross product is zero and its
 * side undecided, is -180 here; a facing test (`FUN_005b3ce0`'s 0.3) keeps a climb from ever starting there.
 */
export function shortTurn(from: number, to: number): number {
  const d = wrapYaw(to - from);
  return d >= 180 ? d - 360 : d;
}
