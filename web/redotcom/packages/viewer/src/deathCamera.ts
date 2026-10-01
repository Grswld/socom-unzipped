import type { Vec3 } from './cameraRig';

/**
 * The death camera (`FUN_00297a30`, decomp 141072-141290, set up by `FUN_002980d0` 141292-141376): the player's own
 * camera once its SEAL is dead. `FUN_00297410` (140900-140913) turns the camera's mode `cam+0x144` to 1 when the viewed
 * actor is the player's (controller `+0x2c`) and in state 8 (dead); `FUN_002980d0` then picks, in a network game
 * (`DAT_0045a0c1`; the page's single-player match is the match server's own room, so it is one too):
 *
 * - **mode 3, the killer's**, when the dead actor's killer (`actor+0xfc4`, 141355-141361: an actor of type 2) is another actor
 *   (141375): the eye swings about the body toward the side away from the killer -- the orbit's yaw
 *   `DAT_00416208 += dt x 1.30875 x (a.z b.x - a.x b.z)` (141213-141214), `a` the flat unit line from the body to the
 *   eye, `b` from the killer to the body -- the eye's height eased to 20 by the blend `DAT_00416218` (141282) and its
 *   reach pushed out (x 2.05 a tick) until 56 from the body across the ground (141284-141286); the look's far point
 *   blends from the aim to the killer's origin as `DAT_00416218` goes 0 -> 1 at 1 a second (`FUN_00297410`
 *   141051-141066).
 * - **mode 6, the lone death's**, with no killer or the SEAL its own (a suicide, a fall; 141372): the orbit turns on
 *   its own at 0.8725 rad a second (141217).
 *
 * Both tilt the orbit by `DAT_00416210`, clamped for a dead actor (`actor+0xf7a` != 1) to [-1, -0.2] (141242-141252):
 * from 0 at the reset (`FUN_00299150` 141657-141662, which the respawn's new camera is), -0.2. The orbit is laid on
 * the camera's local eye, in the actor's space, before the actor's matrix (`FUN_003083c0(m, (pitch, yaw, 0))`, then
 * the eye through it, 141253-141275), and on the look's far point (140987-141028).
 *
 * DEATH_ORBIT_EULER_READING: `FUN_003083c0`'s order is not read; the tilt is taken about x first, then the turn about
 * y (the actor space's own yaw, `./cameraRig` `toWorld`). With the turn so, the game's mode-3 formula brings the eye
 * round to the far side of the body from the killer, as its sign requires.
 */

/** Mode 6: the orbit's own turn, rad a second (141217). */
export const DEATH_ORBIT_RATE = 0.8725;
/** Mode 3: the gain on the killer's side's sine, rad a second (141214). */
export const DEATH_TURN_GAIN = 1.30875;
/** The orbit's tilt for a dead actor, clamped to [-1, -0.2] rad from 0 (141242-141252). */
export const DEATH_TILT_MIN = -1;
export const DEATH_TILT_MAX = -0.2;
/** Mode 3: the eye's height the blend eases to, and its least reach across the ground (141282-141286). */
export const DEATH_EYE_HEIGHT = 20;
export const DEATH_EYE_REACH = 56;
/** Mode 3: the eye's reach grows by this part of itself a tick while under `DEATH_EYE_REACH` (141285-141286). */
export const DEATH_EYE_PUSH = 1.05;

export interface DeathCamera {
  /** `DAT_00416208`: the orbit's turn, rad. */
  yaw: number;
  /** `DAT_00416210`: the orbit's tilt, rad. */
  tilt: number;
  /** `DAT_00416218`: mode 3's blend, 0 -> 1 at 1 a second. */
  blend: number;
  /** Mode 3's killer: its origin now, or null (the body gone from the snapshots: the last one seen stands). */
  killer: (() => Vec3 | null) | null;
  /** The killer's origin as last seen. */
  lastKiller: Vec3 | null;
}

/** The camera at the death (`FUN_00299150`'s reset: every angle and the blend 0): mode 6 until a killer is named. */
export function newDeathCamera(killer: (() => Vec3 | null) | null = null): DeathCamera {
  return { yaw: 0, tilt: 0, blend: 0, killer, lastKiller: null };
}

const turnY = (v: readonly number[], a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0]! * c + v[2]! * s, v[1]!, -v[0]! * s + v[2]! * c];
};
const tiltX = (v: readonly number[], a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0]!, v[1]! * c - v[2]! * s, v[1]! * s + v[2]! * c];
};

/** The orbit on an actor-space vector: the tilt, then the turn (DEATH_ORBIT_EULER_READING). */
export function orbit(cam: DeathCamera, v: readonly number[]): Vec3 {
  return turnY(tiltX(v, cam.tilt), cam.yaw);
}

const wrap = (a: number): number => {
  while (a < -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
};

/** The killer's origin, when mode 3 has one (the last seen when the body is not in the snapshots). */
function killerAt(cam: DeathCamera): Vec3 | null {
  if (!cam.killer) return null;
  const k = cam.killer();
  if (k) cam.lastKiller = [k[0], k[1], k[2]];
  return cam.lastKiller;
}

/**
 * One tick of `FUN_00297a30` on the camera's local eye (actor space: `+z` behind): the orbit turned (mode 3 toward the
 * killer's far side, mode 6 on its own), tilted, and laid on the eye; mode 3's height and reach. `feet` and `yawDegrees`
 * are the dead actor's (its matrix).
 */
export function deathEye(cam: DeathCamera, eyeL: readonly number[], feet: readonly number[], yawDegrees: number, dt: number): Vec3 {
  const killer = killerAt(cam);
  if (killer) {
    // 141149-141214: the eye turned by this frame's yaw, to the world; a = body -> eye, b = killer -> body, flat.
    const e = turnY(eyeL, cam.yaw), y = (yawDegrees * Math.PI) / 180;
    const w = turnY(e, y);
    const al = Math.hypot(w[0], w[2]), bx = feet[0]! - killer[0], bz = feet[2]! - killer[2], bl = Math.hypot(bx, bz);
    if (al > 0 && bl > 0) cam.yaw += dt * DEATH_TURN_GAIN * ((w[2] / al) * (bx / bl) - (w[0] / al) * (bz / bl));
  } else cam.yaw += dt * DEATH_ORBIT_RATE;
  cam.yaw = wrap(cam.yaw);
  cam.tilt = Math.max(DEATH_TILT_MIN, Math.min(DEATH_TILT_MAX, cam.tilt));
  const eye = orbit(cam, eyeL);
  if (killer) {
    eye[1] += (DEATH_EYE_HEIGHT - eye[1]) * cam.blend;
    if (Math.hypot(eye[0], eye[2]) < DEATH_EYE_REACH) { eye[0] += eye[0] * DEATH_EYE_PUSH; eye[2] += eye[2] * DEATH_EYE_PUSH; }
  }
  return eye;
}

/**
 * The look's far point (`FUN_00297410` 141044-141066): `aim` is the orbited aim in the world; in mode 3 the blend
 * steps on (1 a second, to 1) and the point is `aim + blend x (killer - aim)`.
 */
export function deathFar(cam: DeathCamera, aim: Vec3, dt: number): Vec3 {
  const killer = cam.killer ? cam.lastKiller : null;
  if (!killer) return aim;
  cam.blend = Math.min(1, cam.blend + dt);
  const t = cam.blend;
  return [aim[0] + (killer[0] - aim[0]) * t, aim[1] + (killer[1] - aim[1]) * t, aim[2] + (killer[2] - aim[2]) * t];
}
