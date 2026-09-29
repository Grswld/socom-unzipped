import { SEAL_TUNING, type WeaponRecord } from '@s2u/scene';
import { Accuracy, TICK, tangentPerPixel, type Cone } from '../accuracy';
import { CAM_BACK, CAM_FAR, CAM_MARGIN, localCamera, lookHeight, scopeEyeHeight, scopePeekShift, toWorld } from '../cameraRig';
import { MAX_PITCH_RATE } from '../look';
import { rootY, SCOPED_STICK, type Stance } from '../mover';
import { Button, type Command } from './protocol';

/**
 * The accuracy cone on the match server (OWNER-3 of the launch review, 2026-09-29: "port the server-side accuracy cone
 * now"; spec W3.R4 "the accuracy cone ... the server owns every result"). The page's rounds leave by `./accuracy`'s
 * cone: the reticle's bloom and knock (`FUN_005c2670`, `FUN_005c3360`), turned into tangents about the eye's look and
 * sampled in a square (`FUN_005bd100`, `FUN_00592260` -- `perturb`). The server cannot know the page's random sample,
 * so it does the other half: it runs the **same** `Accuracy` for each player from the commands it already receives
 * (the command's look, sticks and buttons, the server's own mover for the stance, the velocity and the air) and
 * refuses a round whose eye ray lies outside the cone that state allows.
 *
 * A round on the wire (protocol 5) names the eye its aim ray left from (`eye`, the camera's -- `./walk` `fireAim`), that
 * ray after the cone (`aim`), and the segment the round itself flew (`from`, `dir`: from the muzzle toward the point
 * under the reticle, `./fire`'s two legs). `check` answers three things:
 *
 * 1. **The eye is the camera's.** Third person: the eye lies on `FUN_0029a950`'s line from the look-at target back to
 *    the goal (`./cameraRig` `localCamera`, the server's feet, yaw, pitch, root and peek), anywhere the pass
 *    (`FUN_0029bf70`) could have pulled it in to, pushed at most `CAM_MARGIN` sideways and up by its four side probes.
 *    In the scope's view it is the head (`scopeEyeHeight`, `scopePeekShift`).
 * 2. **The aim is inside the cone.** The look is the line from that eye to `FUN_00297410`'s far point, `CAM_FAR` along
 *    the pitched look from the target (the scope's: straight ahead); the aim's tangents about it (`coneCoords`, the
 *    inverse of `perturb`) must fall inside the cone -- the knock's offset plus or minus the bloom's radius, or, scoped,
 *    the sway's point within its limits.
 * 3. **The round goes where the eye aimed.** The round's segment passes through the eye's ray ahead of both (the page
 *    aims the muzzle at the point the eye's ray meets: `./fire` `tryFire`).
 *
 * The tolerances, each named: the page draws between two ticks and its mouse look runs a frame ahead of the command
 * (so the look may be any blend of the ticks before, at and after the round's command); the page's bloom is ticked by
 * frames and the server's by commands (`CONE_WINDOW_PLACEHOLDER`, `CONE_SLACK_PX_PLACEHOLDER`); the body's posed root,
 * which the camera stands on, is the clips' and the server has only the stance's (`ROOT_POSE_SLACK_PLACEHOLDER`,
 * `STANCE_CHANGE_TICKS_PLACEHOLDER`); the target's lead probe (`FUN_0029cbb0`) shortens the lead by an amount the server
 * does not probe (bounded by the lead itself). Research 91 section 16 lists them.
 */

type V3 = [number, number, number];

/** Ticks of the server's cone before a round's command that the page's may match (100 ms: the page's frame-driven bloom). */
export const CONE_WINDOW_PLACEHOLDER = 6;
/** Pixels of the reticle (`kit+0x84c`'s units) the page's bloom may stand off the server's: frame- vs tick-sampled rates. */
export const CONE_SLACK_PX_PLACEHOLDER = 2;
/**
 * Units the body's posed root (the clips', which the page's camera stands on: `PlayerCamera`'s header) may stand off the
 * stance's measured root the server has (`./mover` `rootY`): the standing jump lifts it 3.6 (10.5 to 15.1).
 */
export const ROOT_POSE_SLACK_PLACEHOLDER = 4;
/** Ticks after a posture change during which the posed root may be anywhere between the two stances' (the change's clip). */
export const STANCE_CHANGE_TICKS_PLACEHOLDER = 60;
/** How near the round's segment must pass the eye's ray: numeric only (both are sent as JSON doubles). */
export const BIND_EPSILON = 0.01;
/** Commands of history kept (a round may arrive after its command has run). */
const RING = 64;
/** `./main` `gunFrame`'s placement rule: a look change past this in a tick is a placement, not a turn (no bloom). */
const LOOK_JUMP = 45;
const DEG = Math.PI / 180;

/** What the server's mover says about the body at a command (after it ran). */
export interface AimMover {
  feet: V3;
  velocity: V3;
  airborne: boolean;
  posture: Stance;
  /** The move's root (`Traversal.rootY`), or null: the stance's measured root stands in. */
  moveRoot: number | null;
  /** The peek value (`Traversal.peek`, -1 left .. 1 right). */
  peek: number;
  /** The firearm in hand (`MoverSim.weapon`: 0 the rifle, 1 the sidearm). */
  weapon: 0 | 1;
}

/** One command as the cone saw it. */
export interface AimFrame {
  seq: number;
  /** The command's place in the player's own clock: commands run (what the fire rate and the reload lock count). */
  count: number;
  yaw: number; pitch: number;
  feet: V3;
  velocity: V3;
  posture: Stance;
  moveRoot: number | null;
  peek: number;
  weapon: 0 | 1;
  /** `Button.Aim`: the scope's view -- the eye is the head. */
  lens: boolean;
  /** `Button.Scope`: view state 4 and up -- the cone is the sway's point (`Accuracy.cone`). */
  scoped: boolean;
  /** The cone at this command, magnification 1 (a zoom only divides the offsets: `Accuracy.cone`). */
  cone: Cone;
  /** The scope's sway limits as tangents, at the most exertion (`Accuracy.swayLimit` x `tangentPerPixel`). */
  sway: [number, number];
  /** The root's uncertainty at this command (units). */
  rootSlack: number;
}

/** What a round claims: where its eye's ray left from and along what, and the round's own segment. */
export interface ShotClaim { eye: readonly number[]; aim: readonly number[]; from: readonly number[]; dir: readonly number[] }

export type ShotVerdict = null | 'stale' | 'eye' | 'cone' | 'bind';

// ---- small vectors ----
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const scale = (a: readonly number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 =>
  [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const len = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
const unit = (a: readonly number[]): V3 => { const l = len(a); return l > 0 ? scale(a, 1 / l) : [0, 0, 0]; };
const lerp = (a: readonly number[], b: readonly number[], t: number): V3 =>
  [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];

/** The distance from `p` to the segment `a`-`b`. */
export function pointSegment(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const ab = sub(b, a), l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return len(sub(p, add(a, scale(ab, t))));
}

/** The pitched straight ahead in the world, for a look in degrees (`localCamera`'s `ahead` turned by the yaw). */
export function aheadOf(yaw: number, pitch: number): V3 {
  const p = pitch * DEG;
  return toWorld([0, 0, 0], yaw, [0, Math.sin(p), -Math.cos(p)]);
}

/**
 * `perturb` inverted: the tangents `(a, b)` a ray stands at about `look` in `FUN_00592260`'s own axes (right =
 * look x (0, 1, 0), up = right x look, both cos(pitch) long), so `perturb(look, {offsetX: a, offsetY: b, radius: 0})`
 * points along `ray`. Null when the ray is not ahead of the look, or the look is vertical (no axes).
 */
export function coneCoords(look: readonly number[], ray: readonly number[]): [number, number] | null {
  const l = unit(look);
  const right: V3 = [-l[2], 0, l[0]];
  const up = cross(right, l);
  const r2 = dot(right, right);
  const d = dot(ray, l);
  if (!(d > 0) || r2 < 1e-12) return null;
  const v = scale(ray, 1 / d);
  return [dot(v, right) / r2, dot(v, up) / r2];
}

/** The part of [0, 1] where `x0 + t (x1 - x0)` lies in [lo, hi]. */
function span(x0: number, x1: number, lo: number, hi: number): [number, number] {
  const d = x1 - x0;
  if (Math.abs(d) < 1e-15) return x0 >= lo && x0 <= hi ? [0, 1] : [1, 0];
  let a = (lo - x0) / d, b = (hi - x0) / d;
  if (a > b) [a, b] = [b, a];
  return [Math.max(0, a), Math.min(1, b)];
}

/**
 * Whether the round's segment (`from` along `dir`) passes through the eye's ray (`eye` along `aim`) at a point ahead of
 * both: the page aims the muzzle at the point the eye's ray meets, or fires from the eye along it.
 */
export function bound(claim: ShotClaim, eps = BIND_EPSILON): boolean {
  const d1 = unit(claim.dir), d2 = unit(claim.aim);
  const w = sub(claim.from, claim.eye);
  const n = cross(d1, d2), nn = dot(n, n);
  if (nn < 1e-18) return len(cross(w, d2)) <= eps;                 // parallel: the same line or none
  // The closest points: from + s d1 and eye + t d2.
  const b = dot(d1, d2), dd = dot(d1, w), e = dot(d2, w);
  const den = 1 - b * b;
  const s = (b * e - dd) / den, t = (e - b * dd) / den;
  if (s < -eps || t < -eps) return false;
  return len(sub(add(claim.from, scale(d1, s)), add(claim.eye, scale(d2, t)))) <= eps;
}

/** One player's cone on the server: the page's `Accuracy`, fed from the commands. */
export class ShotCone {
  private readonly acc: Accuracy;
  private weapon: WeaponRecord;
  private readonly frames: AimFrame[] = [];
  private last: { yaw: number; pitch: number } | null = null;
  private trigger = false;
  private scoped = false;
  private posture: Stance | null = null;
  private changed = { at: -Infinity, span: 0 };

  constructor(weapon: WeaponRecord) {
    this.weapon = weapon;
    this.acc = new Accuracy(weapon);
  }

  /** The firearm changed (a swap on the server's mover): its own record, at rest (`Accuracy.setWeapon`, as the page's `kit`). */
  setWeapon(weapon: WeaponRecord): void {
    if (weapon === this.weapon) return;
    this.weapon = weapon;
    this.acc.setWeapon(weapon);
  }

  /** A new life: at rest, no history. */
  reset(): void {
    this.acc.reset();
    this.frames.length = 0;
    this.last = null;
    this.trigger = false;
    this.scoped = false;
    this.posture = null;
    this.changed = { at: -Infinity, span: 0 };
  }

  /**
   * One command run on the server's mover: the page's `gunFrame` inputs from it (`./main`: the stance, the velocity and
   * the air from the mover; the turn and pitch rates from the look's change; the exertion's throttles from the stick,
   * slowed x 0.2 scoped, and the rates), the trigger's edges (`FUN_005c0ae0`: the pull's count starts again) and the
   * scope's (`FUN_005b9180` on entering, `FUN_005b9020` on leaving), then one 60 Hz tick of `Accuracy`.
   */
  tick(cmd: Command, m: AimMover, count: number): void {
    const b = cmd.buttons;
    const trigger = (b & Button.Trigger) !== 0, scoped = (b & Button.Scope) !== 0, lens = (b & Button.Aim) !== 0;
    if (trigger !== this.trigger) { this.trigger = trigger; this.acc.trigger(); }
    if (scoped !== this.scoped) {
      if (scoped) this.acc.enterView(0, 4); else this.acc.leaveScope();
      this.scoped = scoped;
    }
    let yawRate = 0, pitchRate = 0;
    if (this.last) {
      const dy = ((cmd.yaw - this.last.yaw + 540) % 360) - 180, dp = cmd.pitch - this.last.pitch;
      if (Math.abs(dy) < LOOK_JUMP && Math.abs(dp) < LOOK_JUMP) { yawRate = (dy * DEG) / TICK; pitchRate = (dp * DEG) / TICK; }
    }
    this.last = { yaw: cmd.yaw, pitch: cmd.pitch };
    const slow = scoped ? SCOPED_STICK : 1;
    this.acc.tick(TICK, {
      stance: m.posture, velocity: m.velocity, airborne: m.airborne, yawRate, pitchRate, zoomState: scoped ? 5 : 0,
      sticks: {
        forward: cmd.forward * slow, right: cmd.right * slow,
        turn: yawRate / SEAL_TUNING.turnMaxRate, pitch: Math.min(1, Math.abs(pitchRate) / MAX_PITCH_RATE),
      },
    });
    if (this.posture !== null && m.posture !== this.posture) {
      this.changed = { at: count, span: Math.abs(rootY(m.posture) - rootY(this.posture)) };
    }
    this.posture = m.posture;
    const t = tangentPerPixel();
    const limit = this.weapon.stances[m.posture];
    this.frames.push({
      seq: cmd.seq, count, yaw: cmd.yaw, pitch: cmd.pitch, feet: [...m.feet], velocity: [...m.velocity], posture: m.posture,
      moveRoot: m.moveRoot, peek: m.peek, weapon: m.weapon,
      lens, scoped, cone: this.acc.cone(scoped ? 5 : 0, 1), sway: [limit.swayLimitX * t.x, limit.swayLimitY * t.y],
      rootSlack: ROOT_POSE_SLACK_PLACEHOLDER + (count - this.changed.at <= STANCE_CHANGE_TICKS_PLACEHOLDER ? this.changed.span : 0),
    });
    if (this.frames.length > RING) this.frames.shift();
  }

  /** The frame of a command still in the history. */
  frame(seq: number): AimFrame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.seq === seq) return this.frames[i];
    return undefined;
  }

  /** A round the server took: the bloom, the knock and the pull's count, as the page's (`Accuracy.round`). */
  round(seq: number): void {
    const f = this.frame(seq) ?? this.frames[this.frames.length - 1];
    this.acc.round(f?.scoped ? 5 : 0, f?.posture ?? 'stand');
  }

  /** The state, for the tests. */
  state(): ReturnType<Accuracy['state']> { return this.acc.state(); }

  /** Whether a round at command `seq` is one this player's cone allows (null) or why not. */
  check(seq: number, claim: ShotClaim): ShotVerdict {
    const at = this.frames.findIndex((f) => f.seq === seq);
    if (at < 0) return 'stale';
    const cur = this.frames[at]!;
    // The page draws between the tick before and this one, and its look may run up to the next tick.
    const blend = this.frames.slice(Math.max(0, at - 1), at + 2);
    if (!this.eyeFits(blend, claim.eye)) return 'eye';
    if (!this.aimFits(blend, cur, claim)) return 'cone';
    if (!bound(claim)) return 'bind';
    return null;
  }

  // ---- the eye ----

  /** The camera's line for a frame: the look-at target, the goal eye (before the pass) and the lead, in the world. */
  private rig(f: AimFrame): { target: V3; eye: V3; far: V3; lead: number } {
    const root = f.moveRoot ?? rootY(f.posture);
    const local = localCamera(root, f.pitch, f.peek);
    const target = toWorld(f.feet, f.yaw, local.target);
    const eye = toWorld(f.feet, f.yaw, local.eye);
    const far = toWorld(f.feet, f.yaw, add(local.target, scale(local.ahead, CAM_FAR)));
    return { target, eye, far, lead: Math.abs(local.target[2]) };
  }

  /** The scope's eye for a frame: the head over the feet, shifted across by the peek (`./walk` `follow`). */
  private head(f: AimFrame): V3 {
    const height = f.moveRoot === null ? scopeEyeHeight(f.posture) : scopeEyeHeight('stand') + f.moveRoot - rootY('stand');
    return toWorld(f.feet, f.yaw, [scopePeekShift(f.peek), height, 0]);
  }

  private eyeFits(blend: AimFrame[], eye: readonly number[]): boolean {
    const pairs = blend.length === 1 ? [[blend[0]!, blend[0]!]] : blend.slice(1).map((b, i) => [blend[i]!, b]);
    for (const [a, b] of pairs as [AimFrame, AimFrame][]) {
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        if (a.lens) {
          if (len(sub(eye, lerp(this.head(a), this.head(b), t))) <= Math.max(a.rootSlack, b.rootSlack) + BIND_EPSILON) return true;
          continue;
        }
        const ra = this.rig(a), rb = this.rig(b);
        const target = lerp(ra.target, rb.target, t), goal = lerp(ra.eye, rb.eye, t);
        // The pass reaches CAM_MARGIN past the goal; it pushes the eye at most CAM_MARGIN across and up (its four probes).
        const past = add(goal, scale(unit(sub(goal, target)), CAM_MARGIN));
        const tol = CAM_MARGIN * Math.SQRT2 + Math.max(a.rootSlack, b.rootSlack) + Math.max(ra.lead, rb.lead) + BIND_EPSILON;
        if (pointSegment(eye, target, past) <= tol) return true;
      }
    }
    return false;
  }

  // ---- the aim ----

  private aimFits(blend: AimFrame[], cur: AimFrame, claim: ShotClaim): boolean {
    // The cone the page may have had: every frame of the window, its offset (a zoom divides it toward 0) and radius.
    let loX = 0, hiX = 0, loY = 0, hiY = 0;
    for (const f of this.frames) {
      if (f.seq > cur.seq || f.seq < cur.seq - CONE_WINDOW_PLACEHOLDER) continue;
      if (f.scoped) {
        loX = Math.min(loX, -f.sway[0]); hiX = Math.max(hiX, f.sway[0]);
        loY = Math.min(loY, -f.sway[1]); hiY = Math.max(hiY, f.sway[1]);
      } else {
        const { offsetX: x, offsetY: y, radius: r } = f.cone;
        loX = Math.min(loX, x - r); hiX = Math.max(hiX, x + r);
        loY = Math.min(loY, y - r); hiY = Math.max(hiY, y + r);
      }
    }
    const t = tangentPerPixel();
    const slack = CONE_SLACK_PX_PLACEHOLDER * Math.max(t.x, t.y);
    // The look may be any blend of two neighbouring frames': the tangents move (near enough) straight between theirs.
    const pairs = blend.length === 1 ? [[blend[0]!, blend[0]!]] : blend.slice(1).map((b, i) => [blend[i]!, b]);
    for (const [a, b] of pairs) {
      const ca = this.coords(a!, claim), cb = this.coords(b!, claim);
      if (!ca || !cb) continue;
      const tol = slack + Math.max(ca.slack, cb.slack);
      const sx = span(ca.ab[0], cb.ab[0], loX - tol, hiX + tol), sy = span(ca.ab[1], cb.ab[1], loY - tol, hiY + tol);
      if (Math.max(sx[0], sy[0]) <= Math.min(sx[1], sy[1])) return true;
    }
    return false;
  }

  /** The aim's tangents about a frame's look from the claimed eye, and that look's own slack (tangent). */
  private coords(f: AimFrame, claim: ShotClaim): { ab: [number, number]; slack: number } | null {
    if (f.lens) {
      const ab = coneCoords(aheadOf(f.yaw, f.pitch), claim.aim);
      return ab && { ab, slack: 0 };
    }
    const r = this.rig(f);
    const ab = coneCoords(sub(r.far, claim.eye), claim.aim);
    // The far point stands off the server's by the root's and the lead's uncertainty, seen from ~CAM_FAR away.
    return ab && { ab, slack: (f.rootSlack + r.lead) / (CAM_FAR - CAM_BACK - CAM_MARGIN) };
  }
}

/** A body as the camera reads it: its feet, its look (degrees), its stance and the move's root, its peek. */
export interface CameraBody { feet: readonly number[]; yaw: number; pitch: number; posture: Stance; moveRoot?: number | null; peek?: number }

/**
 * The camera's eye and its look for a body with nothing behind it (no pass) -- the eye `FUN_0029a950` places and the line
 * to `FUN_00297410`'s far point: the centre of the cone a page with the camera in the open aims down (the load bots,
 * the tests).
 */
export function cameraLook(b: CameraBody): { eye: V3; look: V3 } {
  const local = localCamera(b.moveRoot ?? rootY(b.posture), b.pitch, b.peek ?? 0);
  const eye = toWorld(b.feet, b.yaw, local.eye);
  const far = toWorld(b.feet, b.yaw, add(local.target, scale(local.ahead, CAM_FAR)));
  return { eye, look: unit(sub(far, eye)) };
}

/** The yaw and pitch (degrees) whose `cameraLook` passes through `point`: a body turned to look at it. */
export function faceToward(b: Omit<CameraBody, 'yaw' | 'pitch'>, point: readonly number[]): { yaw: number; pitch: number } {
  const dx = point[0]! - b.feet[0]!, dz = point[2]! - b.feet[2]!;
  const yaw = ((Math.atan2(-dx, -dz) / DEG) % 360 + 360) % 360;
  // Looking up lowers the eye and raises the look: the gap between the look and the line to the point falls with the
  // pitch, so halve the range on its sign.
  let lo = -89, hi = 89;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const { eye, look } = cameraLook({ ...b, yaw, pitch: mid });
    const u = unit(sub(point, eye));
    if (u[1] - look[1] > 0) lo = mid; else hi = mid;
  }
  return { yaw, pitch: (lo + hi) / 2 };
}

/**
 * A round down the cone's centre, as a page in the open sends it: the eye's ray from `cameraLook`, the round from
 * `from` (the muzzle) to the point `t` along that ray.
 */
export function centreClaim(b: CameraBody, from: readonly number[], t: number): ShotClaim & { eye: V3; aim: V3; from: V3; dir: V3 } {
  const { eye, look } = cameraLook(b);
  const point = add(eye, scale(look, t));
  return { eye, aim: look, from: [from[0]!, from[1]!, from[2]!], dir: unit(sub(point, from)) };
}

/** The look-at target's height the camera takes for a stance (`lookHeight` of the measured root), for the room's checks. */
export function targetHeight(posture: Stance, moveRoot: number | null = null): number {
  return lookHeight(moveRoot ?? rootY(posture));
}
