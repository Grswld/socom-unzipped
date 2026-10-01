import type { Stance } from './mover';
import { CROUCH_HEIGHT, HEAD_HEIGHT, PRONE_HEIGHT, STANDING_HEIGHT } from './stature';

/**
 * The third-person camera's geometry, headless (moved out of `./playerCamera` for the shared sim, OWNER-3 of the launch
 * review): where `FUN_0029a950` puts the look-at target and the eye in the actor's space, where `FUN_00297410` aims
 * (the far point, `CAM_FAR` along the pitched look), and the scope's eye over the feet. The page's `PlayerCamera`
 * runs these every tick; the match's room (`./net/room`, through `./sim`) reads the same numbers to check that a
 * round's eye and aim are where this camera could have put them (`./net/shotCone`). The derivations are in
 * `./playerCamera`'s header; nothing here reads the hull (the pass, `cameraPass`, stays with the page's camera).
 */

export type Vec3 = [number, number, number];

const unit = (a: readonly number[]): Vec3 => {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!);
  return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 0];
};

/** `FUN_0029a950`: the goal this far behind the target at a level pitch (`fStack_8 + 28.0`). */
export const CAM_BACK = 28;
/** `FUN_0029a950`: the distance a vertical look closes to (`14.0 - *param_4`). */
export const CAM_CLOSE = 14;
/** `FUN_0029bf70`: the probe's reach past the goal, the stand-off from a hit, the side probes' length (0.75). */
export const CAM_MARGIN = 0.75;
/** `FUN_00297410`: the aim point, this far along the pitched look from the target. */
export const CAM_FAR = 1000;
/** `FUN_0029a950`'s ramp (research 17 section 3). */
const RAMP_FROM = 2.169155, RAMP_SCALE = 0.2914734, RAMP_TOP = 5.6;
/** `FUN_0029a950`'s target lead, times `n.y`: `DAT_003de278` -8 looking down, `DAT_003de288` -3 looking up. */
export const LEAD_DOWN = -8, LEAD_UP = -3;
/** `DAT_003de280`: a lead under this probes ahead for a wall (`FUN_0029cbb0`). */
export const LEAD_PROBE = -5;

const DEG = Math.PI / 180;

/** `FUN_0029a950`'s ramp: 10 with no root (0), else 5.5 to 10 as the root rises from 2.169 to 5.6. */
export function ramp(rootY: number): number {
  if (rootY === 0) return 10;
  const f = rootY < RAMP_TOP ? Math.min(1, Math.max(0, (rootY - RAMP_FROM) * RAMP_SCALE)) : 1;
  return f * 4.5 + 5.5;
}

/** The look-at target's height over the feet: `rootY + ramp(rootY)` -- 21.484 standing, 15.378 crouched. */
export function lookHeight(rootY: number): number {
  return rootY + ramp(rootY);
}

/** `FUN_0029a950`'s output in actor space (+z behind): the target, the eye, the distance and the unit back axis. */
export interface LocalCamera {
  target: Vec3;
  eye: Vec3;
  dist: number;
  /** `n`: the unit vector from the target toward the eye. */
  back: Vec3;
  /**
   * The look: `rotate(actor+0x1070, (0, 0, -1))`, the pitched straight ahead `FUN_00297410` aims 1000 along from the
   * target. Not `-back`: the peek's shift is in `v`, and so in `back`, but never in the aim (decomp 140987-140996).
   */
  ahead: Vec3;
  /** Whether the lead is under -5: the target's probe ahead runs (`FUN_0029cbb0`). */
  probe: boolean;
}

/**
 * TRAVERSAL SEAM (web research 86 section 4): `FUN_0029a950`'s peek, the target's shift across the actor for the peek
 * value `DAT_004161c0` (-1 left .. 1 right): `peek x 2.5` to the left, `peek x 2.8` to the right (decomp 142476-142484).
 */
export function peekShift(peek: number): number {
  return peek < 0 ? peek * 2.5 : peek * 2.8;
}

/**
 * TRAVERSAL SEAM: the scope's eye's shift across for the peek value (`FUN_0029ae50`, the game's eye camera, decomp
 * 142613-142617):
 * `peek x 3.3` to the left, `peek x 4.35` to the right.
 */
export function scopePeekShift(peek: number): number {
  return peek < 0 ? peek * 3.3 : peek * 4.35;
}

/**
 * `FUN_0029a950` at a root height and a pitch (degrees, up positive), the root's x, z at 0, and the peek value
 * (`peekShift`; 0, no peek, by default): `v = (shift, 0, 28)`, `dist = |v|`, `n = normalize(pitch(v))`.
 */
export function localCamera(rootY: number, pitchDegrees: number, peek = 0): LocalCamera {
  const p = pitchDegrees * DEG;
  const shift = peekShift(peek);
  // (shift, 0, 28) turned about x by the pitch, normalised: looking down (p < 0) lifts the eye.
  const back: Vec3 = unit([shift, -Math.sin(p) * CAM_BACK, Math.cos(p) * CAM_BACK]);
  const ny = back[1];
  const lead = ny < 0 ? ny * LEAD_UP : ny * LEAD_DOWN;
  const flat = Math.hypot(CAM_BACK, shift);
  const dist = flat + Math.abs(ny) * (CAM_CLOSE - flat);
  const target: Vec3 = [shift, lookHeight(rootY), lead + 0];
  return {
    target, dist, back, probe: ny >= 0 && lead < LEAD_PROBE, ahead: [0, Math.sin(p), -Math.cos(p)],
    eye: [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist],
  };
}

/** Actor space to world: the actor at `feet`, facing `yaw` degrees (`camera.ts`: yaw 0 looks down -z). */
export function toWorld(feet: readonly number[], yawDegrees: number, v: readonly number[]): Vec3 {
  const y = yawDegrees * DEG, c = Math.cos(y), s = Math.sin(y);
  return [feet[0]! + v[0]! * c + v[2]! * s, feet[1]! + v[1]!, feet[2]! - v[0]! * s + v[2]! * c];
}

/**
 * The scope's eye over the feet (the zoom's view from the head; W2.R1): `HEAD_HEIGHT` 18.3 standing (W2.3's
 * estimate), and in the other stances the body's top less the same 1.3 -- 11.1 crouched, 1.7 prone [estimates, as
 * W2.3's heights are].
 */
export function scopeEyeHeight(stance: Stance): number {
  if (stance === 'stand') return HEAD_HEIGHT;
  return (stance === 'crouch' ? CROUCH_HEIGHT : PRONE_HEIGHT) - (STANDING_HEIGHT - HEAD_HEIGHT);
}
