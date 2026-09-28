import { Vector3, type Camera } from 'three';
import { isCameraSurface, segmentHit, segmentHits, SEAL_TUNING, type Grid } from '@s2u/scene';
import { CROUCH_HEIGHT, HEAD_HEIGHT, PRONE_HEIGHT, STANDING_HEIGHT } from './stature';
import type { Stance } from './walk';

/**
 * The game's third-person camera (web sprint 2, W2.1; the spec's W2.R1): the walk is seen from behind and over the
 * SEAL's shoulder, as `FUN_00296f10` (the "CamC" of research 17 section 2's live trace, called every frame) places
 * it. Read from `game/analysis/socom2_game.elf.decomp.c`; the constants are the ELF's data, read at their addresses
 * (and equal on the console dump `logs/parity/spawn_pcsx2.rdram`); reCOM's `zCamera/zcam.h` names the parts
 * (`CAppCamera`, `m_cameraAim`, `m_camGoalPos`), its `camera.cpp` is stubs. Coordinates below are the actor's own
 * (research 17 section 2): +y up, **+z behind** (the eye's local z is +24.166 on the console), -z ahead.
 *
 * ```
 * FUN_00296f10(dt, cam, out)                                     decomp 140630-140830, the caller
 *   FUN_0029a950(&eyeL, cam, &targetL, &dist)                     the target and the goal, actor space
 *   FUN_00297410(dt, cam, &eyeL, &targetL, &far)                  to the world, and the look line
 *   target = eye + normalize(far - eye) * dist                    the look target, re-placed on the eye's line
 *   [+0x45 blend between two cameras; a -5 / +5 nudge in an actor state not read here: neither modelled]
 *   FUN_0029bf70(dt, cam, &target, &eye, &eye)                    the pass
 *   FUN_0029bc90(cam, &eye, &target, out)                         the placement
 *
 * FUN_0029a950 (decomp 142412-142562; research 17 section 3)     -- CONFIRMED against the console, to 0.001
 *   root = skeleton root node's translation (actor+0x2e8, FUN_002869d0), (0, rootY, 0) at rest
 *   ramp = rootY == 0 ? 10 : 5.5 + 4.5 * (rootY < 5.6 ? clamp((rootY - 2.169155) * 0.2914734, 0, 1) : 1)
 *   targetL.x = root.x + peek          peek = DAT_004161c0 * (2.5 left | 2.8 right): 0, no peek here
 *   targetL.y = rootY + ramp
 *   v = (root.x + peek, 0, root.z + 28);  dist = |v|             28: fStack_8 + 28.0
 *   n = normalize(rotate(actor+0x1070, v))                        the look quaternion: the camera's pitch
 *   targetL.z = n.y < 0 ? -3 * n.y                                DAT_003de288 = -3 (looking up: the target back)
 *             : -8 * n.y, and when that is under -5 (n.y > 0.625)  DAT_003de278 = -8, DAT_003de280 = -5
 *               a probe (FUN_0029cbb0) from the target 8 ahead: on a hit, + the part of the 8 past the hit
 *             [a second branch, -5 * n.y, when FUN_002b3580's object answers FUN_0054f6e0 / FUN_0059da60: not
 *              the console's at spawn, whose -1.274 = -8 x 0.1593]
 *   dist = dist + |n.y| * (14 - dist)                             FUN_001b3620 is fabs: steeper, nearer
 *   eyeL = targetL + n * dist
 *
 * FUN_00297410 (decomp 140831-141071)                             -- CONFIRMED (no tether in it)
 *   eyeL, targetL -> world through the actor matrix (FUN_00308640 with w = 1); a yaw spin only in actor state 8
 *   far = world(targetL + rotate(actor+0x1070, (0, 0, -1000)))    the aim: 1000 ahead along the pitched look
 *   [the +0x144 mode (FUN_00297a30), the network-game +0xf4 mode: not the walk's]
 *
 * FUN_0029bf70 (decomp 143197-143660; research 17 section 2's "four segment probes")   -- read; the no-hit case
 *                                                                  CONFIRMED against the console, to 0.001
 *   u = target - eye;  L = |u| + 0.75;  probe = target - û * L     the probe reaches 0.75 past the goal
 *   hits = the segment target -> probe (FUN_0031e0a0)
 *   hit = FUN_0029cd20 (decomp 143706-143770): the nearest to the target, passing over any polygon whose
 *         m_cameratype is exactly 1 (bit 18 set, bit 19 clear) within 2.75 of the target; any = hits not empty
 *         (DAT_00416038 = 1, whether or not the pick survived the filter)
 *   if cam+0x4c > 0: cam+0x4c -= dt                               the hold timer
 *   D = DAT_003de268                                                the camera's distance, kept across frames
 *   if L > D: if cam+0x4c <= 0 or D < 3.3 or any: D += 0.03 * (L - D)   DAT_003de270: out at 3 % a frame
 *   else:     D = L                                                 in at once
 *   no hit:   eye = target - û * D
 *   hit h:    D = min(D, max(0.75, |h - target| - 0.75));  eye = target + normalize(h - target) * D;  cam+0x4c = 1.5
 *   s = normalize_xz(-u.z, 0, u.x) * 0.75;  w = normalize(s x u) * 0.75
 *   four segments from the eye: to eye + s, eye - s, eye + w, eye - w   (records 0x416050, 0x4160b0, 0x416110,
 *                                                                          0x416170; batch FUN_0031de90)
 *   sideways: both hit -> eye = midpoint of the hits; one hit -> eye.xz += hit.xz - end.xz
 *   up/down:  both hit -> eye = midpoint of the hits; one hit -> eye += hit - end
 *   any side hit: cam+0x4c = 1.5
 *   if |eye - target| < 0.75: eye = target + normalize(eye - target) * 0.75    [the scale is lost in the decomp:
 *                                                                                 0.75 is the reading]
 *   The surfaces: DAT_0044d758 = 1 (no peek) -- bit 19 skipped, bit 18 tested (`@s2u/scene`'s `segment.ts`).
 *
 * FUN_0029bc90 (decomp 143081-143144)                            -- CONFIRMED
 *   f = normalize(target - eye);  x = normalize(-f.z, 0, f.x);  y = x cross f;  rows (x, y, -f, eye); cam+0xd8 = eye
 *   no roll (dynamics.rdr's camera_roll 0.0001 is not read here), no field of view: the map's `fov` is (camera.ts)
 * ```
 *
 * **Why the console's eye is 24.2 behind the actor, not 28.** Not the pass and not a tether: the pitch. The
 * console's look quaternion `actor+0x1070` on the dump is (-0.0799, 0, 0, 0.9968), a turn of -0.16 rad about x --
 * `dynamics.rdr`'s `init_aim_pitch` -9.167 degrees (the table's `+0x54`, -0.159994). With it `FUN_0029a950`'s
 * `n.y` = 0.1593, so dist = 28 - 0.1593 x 14 = 25.770, the target 1.274 ahead, and the eye local (0, 19.483,
 * 24.166): the console's `cam+0x2c` exactly (research 17 section 1, section 4.1 row #13). The pass then adds its
 * 0.75: `DAT_003de268` on the dump is 26.51936 = 25.770 + 0.75, and the placed eye (`cam+0xd8`) is 19.603 over the
 * feet and 24.906 behind -- the dump's (939.439, -126.264, 832.160) against the player's (939.4391, -145.8672,
 * 857.0661), to 0.001. (Research 17 section 1's "20.107" is that eye over the collision *hit*, 0.504 under the
 * feet; the spec's "24.2 behind" is the unpassed `cam+0x2c`.)
 *
 * **The tether.** `dynamics.rdr`'s `cam_tether_stiff` 0.95 (`+0x15c`) and `cam_net_pos_smooth` (`+0x164`) have no
 * reader in the decompilation but the static initialiser (decomp 328428-328433) and the loader: the camera's only
 * smoothing is the pass's distance, in at once and out at `DAT_003de270` = 0.03 a frame after a 1.5 s hold (1.0,
 * a snap, for the first 0.1 s after a camera switch: `FUN_00295f20`, `FUN_0029b0c0`). The 0.03 is per call; it
 * runs here once a 60 Hz tick [reading: the console's frame rate is W2.2c's to measure].
 *
 * **The pitch** (`FUN_00594600`, decomp 452781-452958, then `FUN_005af470` writes the quaternion): the stick moves
 * it at `pitch_rate` 0.85 rad/s x axis (`+0xf4`; x 500 / `actor+0x1080`, which is 500 on the dump), between
 * `min_aim_pitch` -70 and `max_aim_pitch` 60 standing and crouched (`+0x5c`, `+0x58`) and the prone pair -20 and 25
 * (`+0x68`, `+0x64`; the prone limits also lean with the ground's slope, not modelled) -- the **aim** limits, not
 * `min/max_look_pitch` -60/80, which this routine does not read. The spawn pitch is `init_aim_pitch`.
 *
 * **The root** is the body's skeleton root as posed (`FUN_002869d0` on `actor+0x2e8`, decomp 142450-142460): the walk
 * hands the animator's over (`WalkMode.setPosedRoot`), so the target rises with the standing jump's root (10.5 to
 * 15.1) and sinks through a crouch's transition clip; a running jump lifts the feet themselves. With no clips the
 * stance's measured root stands in, eased over 0.2 s [estimate].
 *
 * **Not modelled:** the peek (`DAT_004161c0`, `cam_peek_decay_rate`), the skeleton root's own x and z (0 here), the
 * two camera modes above, and the material half of the camera's surface test.
 */

export type Vec3 = [number, number, number];

/** The camera's tick: the mover's (`walk.ts`, `CGame::Tick` at 60 Hz). */
const TICK = 1 / 60;
/** `FUN_0029a950`: the goal this far behind the target at a level pitch (`fStack_8 + 28.0`). */
export const CAM_BACK = 28;
/** `FUN_0029a950`: the distance a vertical look closes to (`14.0 - *param_4`). */
export const CAM_CLOSE = 14;
/** `FUN_0029bf70`: the probe's reach past the goal, the stand-off from a hit, the side probes' length (0.75). */
export const CAM_MARGIN = 0.75;
/** `FUN_0029bf70`: how far the distance lets out a frame after the hold (`DAT_003de270` = 0.03). */
export const CAM_REGROW = 0.03;
/** `FUN_0029bf70`: the hold after a hit, seconds (`cam+0x4c = 0x3fc00000`). */
export const CAM_HOLD = 1.5;
/** `FUN_0029bf70`: under this distance the hold does not hold (`3.3000002`). */
const CAM_HOLD_FLOOR = 3.3;
/** `FUN_0029cd20`: a camera-type-1 polygon this near the target is passed over by the main probe. */
const TYPE_ONE_CLEAR = 2.75;
/** `FUN_00297410`: the aim point, this far along the pitched look from the target. */
export const CAM_FAR = 1000;
/** `FUN_0029a950`'s ramp (research 17 section 3). */
const RAMP_FROM = 2.169155, RAMP_SCALE = 0.2914734, RAMP_TOP = 5.6;
/** `FUN_0029a950`'s target lead, times `n.y`: `DAT_003de278` -8 looking down, `DAT_003de288` -3 looking up. */
const LEAD_DOWN = -8, LEAD_UP = -3;
/** `DAT_003de280`: a lead under this probes ahead for a wall (`FUN_0029cbb0`). */
const LEAD_PROBE = -5;
/** The spawn's pitch, degrees: `dynamics.rdr`'s `init_aim_pitch` (the header). */
export const INIT_AIM_PITCH = SEAL_TUNING.initAimPitch;
/**
 * How fast the root moves to a new stance's, units a second, when no posed root is on hand (no clips): the
 * stand-crouch span in 0.2 s [estimate]. With the body's clips the camera takes the posed root as it is.
 */
const ROOT_RATE = (11.484 - 5.504) / 0.2;

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
  /** Whether the lead is under -5: the target's probe ahead runs (`FUN_0029cbb0`). */
  probe: boolean;
}

/** `FUN_0029a950` at a root height and a pitch (degrees, up positive), with no peek and the root's x, z at 0. */
export function localCamera(rootY: number, pitchDegrees: number): LocalCamera {
  const p = pitchDegrees * DEG;
  // (0, 0, 28) turned about x by the pitch, normalised: looking down (p < 0) lifts the eye.
  const back: Vec3 = [0, -Math.sin(p), Math.cos(p)];
  const ny = back[1];
  const lead = ny < 0 ? ny * LEAD_UP : ny * LEAD_DOWN;
  const dist = CAM_BACK + Math.abs(ny) * (CAM_CLOSE - CAM_BACK);
  const target: Vec3 = [0, lookHeight(rootY), lead + 0];
  return {
    target, dist, back, probe: ny >= 0 && lead < LEAD_PROBE,
    eye: [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist],
  };
}

/** Actor space to world: the actor at `feet`, facing `yaw` degrees (`camera.ts`: yaw 0 looks down -z). */
export function toWorld(feet: readonly number[], yawDegrees: number, v: readonly number[]): Vec3 {
  const y = yawDegrees * DEG, c = Math.cos(y), s = Math.sin(y);
  return [feet[0]! + v[0]! * c + v[2]! * s, feet[1]! + v[1]!, feet[2]! - v[0]! * s + v[2]! * c];
}

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const scale = (a: readonly number[], k: number): Vec3 => [a[0]! * k, a[1]! * k, a[2]! * k];
const length = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
const unit = (a: readonly number[]): Vec3 => { const l = length(a); return l > 0 ? scale(a, 1 / l) : [0, 0, 0]; };
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** What `FUN_0029bf70` keeps between frames: `DAT_003de268` (the distance) and `cam+0x4c` (the hold). */
export interface PassState { dist: number; hold: number }

/** `DAT_003de268`'s start value in the ELF: 10000, so the first frame takes the goal's distance at once. */
export const newPassState = (): PassState => ({ dist: 10000, hold: 0 });

/** `FUN_0029bf70`: the eye after the pass, from the target and the eye `FUN_00296f10` hands it (the header). */
export function cameraPass(grid: Grid | null, target: Vec3, eye: Vec3, state: PassState, dt: number = TICK): Vec3 {
  const hit = (a: Vec3, b: Vec3): Vec3 | null => (grid ? segmentHit(grid, a, b, isCameraSurface)?.point ?? null : null);
  const toTarget = sub(target, eye);
  const dir = unit(toTarget);
  const reach = length(toTarget) + CAM_MARGIN;
  // FUN_0029cd20: the main probe's pick, and DAT_00416038 -- any hit at all, kept or passed over.
  const hits = grid ? segmentHits(grid, target, sub(target, scale(dir, reach)), isCameraSurface) : [];
  const any = hits.length > 0;
  const main = hits.find((h) => h.poly.cameratype !== 1 || length(sub(h.point, target)) > TYPE_ONE_CLEAR)?.point ?? null;
  if (state.hold > 0) state.hold -= dt;
  if (reach > state.dist) {
    if (state.hold <= 0 || state.dist < CAM_HOLD_FLOOR || any) state.dist += CAM_REGROW * (reach - state.dist);
  } else {
    state.dist = reach;
  }
  let out: Vec3;
  let u: Vec3;                                                          // uStack_10: the eye-to-target axis
  if (main === null) {
    out = sub(target, scale(dir, state.dist));
    u = scale(dir, state.dist);
  } else {
    const v = sub(main, target);
    state.dist = Math.min(state.dist, Math.max(CAM_MARGIN, length(v) - CAM_MARGIN));
    out = add(target, scale(unit(v), state.dist));
    u = scale(dir, reach);
    state.hold = CAM_HOLD;
  }
  // The four side probes, all from the eye as it stands now.
  const flat = Math.hypot(u[2], u[0]);
  const side: Vec3 = flat > 0 ? [(-u[2] / flat) * CAM_MARGIN, 0, (u[0] / flat) * CAM_MARGIN] : [0, 0, 0];
  const cross: Vec3 = [side[1] * u[2] - side[2] * u[1], side[2] * u[0] - side[0] * u[2], side[0] * u[1] - side[1] * u[0]];
  const up = scale(unit(cross), CAM_MARGIN);
  const ends = [add(out, side), sub(out, side), add(out, up), sub(out, up)] as const;
  const [a, b, c, d] = ends.map((end) => hit(out, end));
  const start = out;
  out = [...start];
  if (a && b) out = add(a, scale(sub(b, a), 0.5));
  else if (a) { out[0] += a[0] - ends[0][0]; out[2] += a[2] - ends[0][2]; }
  else if (b) { out[0] += b[0] - ends[1][0]; out[2] += b[2] - ends[1][2]; }
  if (c && d) out = add(c, scale(sub(d, c), 0.5));
  else if (c) out = add(out, sub(c, ends[2]));
  else if (d) out = add(out, sub(d, ends[3]));
  if (a || b || c || d) state.hold = CAM_HOLD;
  const off = sub(out, target);
  if (length(off) < CAM_MARGIN) out = add(target, scale(unit(off), CAM_MARGIN));
  return out;
}

/** The placed camera: the eye, the look-at target (`FUN_0029bc90` looks from one to the other) and the aim point. */
export interface CameraView { eye: Vec3; target: Vec3; far: Vec3 }

/**
 * The camera, a tick at a time (`WalkMode` runs `tick` after each of the mover's ticks) and drawn between the last
 * two (`view`), the way `Walker.eye` draws the feet: smooth at any frame rate.
 */
export class PlayerCamera {
  private pass = newPassState();
  private root: number | null = null;
  /** `FUN_0029a950`'s `param_3[2]` before it is written: last frame's target z (the lead probe's start) [reading]. */
  private leadFrom: number | null = null;
  private prev: CameraView | null = null;
  private cur: CameraView | null = null;

  constructor(private readonly grid: Grid | null) {}

  /** Forgets the camera: the next tick places it at the goal with no hold, as a new camera does. */
  reset(): void {
    this.pass = newPassState();
    this.root = null;
    this.leadFrom = null;
    this.prev = null;
    this.cur = null;
  }

  /**
   * One tick: the actor's feet, its yaw and the camera's pitch (degrees), its skeleton root's height over the feet.
   * `posed`: the root is the body's as posed this frame, which `FUN_0029a950` reads as it stands (the clips' own
   * blends move it); otherwise it is a stance's measured root, eased to over `ROOT_RATE` [estimate].
   */
  tick(feet: readonly number[], yawDegrees: number, pitchDegrees: number, rootY: number, dt: number = TICK, posed = false): void {
    const root = this.root === null || posed ? rootY
      : Math.abs(rootY - this.root) <= ROOT_RATE * dt ? rootY : this.root + Math.sign(rootY - this.root) * ROOT_RATE * dt;
    this.root = root;
    const local = localCamera(root, pitchDegrees);
    const world = (v: readonly number[]): Vec3 => toWorld(feet, yawDegrees, v);
    let lead = local.target[2];
    if (local.probe && this.grid) {
      const from = this.leadFrom ?? lead;
      const a = world([local.target[0], local.target[1], from]), b = world([local.target[0], local.target[1], from + LEAD_DOWN]);
      const h = segmentHit(this.grid, a, b, isCameraSurface);
      if (h) lead += Math.hypot(b[0] - h.point[0], b[2] - h.point[2]);
    }
    this.leadFrom = lead;
    const targetL: Vec3 = [local.target[0], local.target[1], lead];
    const eyeL = add(targetL, scale(local.back, local.dist));
    const far = world(add(targetL, scale(local.back, -CAM_FAR)));
    const eye0 = world(eyeL);
    // FUN_00296f10: the target on the line from the eye to the aim, `dist` from the eye.
    const target = add(eye0, scale(unit(sub(far, eye0)), local.dist));
    const eye = cameraPass(this.grid, target, eye0, this.pass, dt);
    this.prev = this.cur ?? { eye, target, far };
    this.cur = { eye, target, far };
  }

  /** Draws the last tick again at `view(0)` and `view(1)` alike: after a run of ticks driven by hand. */
  settle(): void {
    if (this.cur) this.prev = this.cur;
  }

  /** The camera between the last two ticks, `alpha` of the way (the mover's part-tick); null before the first tick. */
  view(alpha: number): CameraView {
    const cur = this.cur, prev = this.prev ?? cur;
    if (!cur || !prev) return { eye: [0, 0, 0], target: [0, 0, -1], far: [0, 0, -CAM_FAR] };
    const t = Math.max(0, Math.min(1, alpha));
    return { eye: lerp(prev.eye, cur.eye, t), target: lerp(prev.target, cur.target, t), far: lerp(prev.far, cur.far, t) };
  }

  /** The pass's distance, `DAT_003de268`. */
  distance(): number {
    return this.pass.dist;
  }

  /** The pass's hold, seconds left (`cam+0x4c`). */
  hold(): number {
    return this.pass.hold;
  }

  /** The root height the camera stands on (the stance's, moving to a new one over 0.2 s). */
  rootY(): number {
    return this.root ?? 0;
  }
}

/**
 * The camera's pitch limits in a stance, degrees: the aim pitch's (`FUN_00594600`; the header) -- `min/max_aim_pitch`
 * standing and crouched, the prone pair lying down.
 */
export function pitchLimits(stance: Stance): [number, number] {
  const [min, max] = stance === 'prone' ? SEAL_TUNING.proneAimPitch : SEAL_TUNING.aimPitch;
  return [min, max];
}

/**
 * The first-person eye over the feet (`V`; W2.R1): `HEAD_HEIGHT` 18.3 standing (W2.3's estimate), and in the other
 * stances the body's top less the same 1.3 -- 11.1 crouched, 1.7 prone [estimates, as W2.3's heights are].
 */
export function firstPersonHeight(stance: Stance): number {
  if (stance === 'stand') return HEAD_HEIGHT;
  return (stance === 'crouch' ? CROUCH_HEIGHT : PRONE_HEIGHT) - (STANDING_HEIGHT - HEAD_HEIGHT);
}

/** A world point's place on the frame, 0..1 across and down (the reticle's `setAimPoint`), through `camera`. */
export function aimPoint(camera: Camera, point: readonly number[]): [number, number] {
  const ndc = new Vector3(point[0], point[1], point[2]).project(camera);
  return [(ndc.x + 1) / 2, (1 - ndc.y) / 2];
}
