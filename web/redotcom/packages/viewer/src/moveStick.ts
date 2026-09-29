import { circle, deadZone } from './look';

/** The left stick's dead zone on the dump (`+0x288`, 0x3e99999a): the right stick's 0.3 too. */
export const LEFT_DEAD_ZONE = 0.3;

/**
 * The move stick as the console reads it (web research 88 section 3): `FUN_002da930` (decomp 179484-179878) runs the
 * left stick through the same steps as the right (`./look`), with the left block's own settings -- on the spawn dump
 * `logs/parity/spawn_pcsx2.rdram`, the pad object `0x849e90`:
 *
 * ```
 *   v = (127.5 - byte) x 0.007843138                          per axis, pad +0x210 (x) / +0x214 (y)
 *   |v| < +0x288 (0.3) -> 0                                     179566-179592
 *   +0x2a0 = 1: v = sign x (|v| - 0.3) / 0.7, clamped to 1      179594-179617, the rescale
 *   FUN_002da200(.., 0): +0x2a1 = 1, DAT_003df240 = 1           179634: the circle -- both axes x sqrt(1 + |r|), r the
 *                                                                 minor over the major only when their integer parts
 *                                                                 differ, clamped: below a full push each axis x sqrt 2
 *   +0x2a8 / +0x2a9 = 0: no curve; the ramp needs +0x2a8: none   179636, 179771
 * ```
 *
 * So a push along one axis runs `(push - 0.3) / 0.7 x sqrt 2` of the band -- 26.0 at half a stick (research 79's byte
 * 64), 59.0 at three quarters (byte 32) -- and the run is full from **0.795** of the stick's travel
 * (`0.3 + 0.7 / sqrt 2`), not at the rim. The pair is never put back in the unit disc: a full diagonal is (1, 1), and
 * the locomotion takes `min(1, |stick|)` (`FUN_00583350`) or one axis of it (prone, `FUN_00583500`).
 */
export function moveStick(x: number, y: number): [number, number] {
  const [cx, cy] = circle(deadZone(x, LEFT_DEAD_ZONE), deadZone(y, LEFT_DEAD_ZONE));
  return [cx + 0, cy + 0];
}
